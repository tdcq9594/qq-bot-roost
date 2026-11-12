# OneBot v11 兼容层设计

> 目标：在 roost 里加一层 OneBot v11 服务端 + 一个面板页。开启「兼容模式」后，  
> aurobot / NoneBot / 其它 v11 程序可以直接连上来，不再需要 SnowLuma、NapCat 这类  
> 客户端注入型网关。
>
> 状态：**设计稿，未实现**。所有行号对应 2026-11-12 的 `main` 工作区。  
> 相关：[官方接口限制](./官方接口限制.md) · [架构说明](./架构说明.md) · [配置参考](./配置参考.md)

---

## 0. 目标与非目标

### 要做

1. roost 作为 **OneBot v11 服务端**：正向 WebSocket（首选）+ HTTP API，反向 WS / HTTP POST 后补
2. 把官方事件翻译成 OneBot 事件，把 OneBot action 翻译成官方接口调用
3. 每个机器人独立开关、独立端口、独立 token
4. 面板新增「外接」页：开关、连接信息、运行状态、能力矩阵、身份检查、调试
5. **依赖按需安装**：`ws`（必需）、`silk-wasm`（可选，发语音用）都不进 `package.json`，  
   由用户在外接页点「一键安装」才装到 `data/deps/onebot/`
6. 明确「做不到」的部分，并在协议层如实返回，不静默失败

### 不做

1. **不做 QQ 号登录**。roost 的后端永远是官方 AppID/AppSecret，OneBot 只是**对外**协议
2. **不模拟官方没有的能力**（空间、改资料、拍一拍、历史消息、好友列表…）
3. **不替代 OneBot v11 生态**，只实现被真实程序用到的子集，其余按能力表拒绝
4. **不在启动时自动装依赖**。装依赖是一次显式动作，没装就是「兼容模式未就绪」，  
   不是「悄悄 npm install」。框架本体保持零依赖（`package.json` 的 `dependencies` 始终为空）

### 为什么放内核而不是插件

| 需求                           | 插件能不能                                                        | 内核能不能             |
| ---------------------------- | ------------------------------------------------------------ | ----------------- |
| 监听 WS 端口                     | 只能自己 `node:http` 起服务，且没有 WS 升级通道（`plugin/routes.js` 只有 REST） | 可以                |
| 复用被动窗口 / `msg_seq` / 额度 / 降级 | 不能，`outbound.js:379` 的 `send()` 是内核对象                        | 可以                |
| 拿到「全量群消息」且不被 pipeline 吞掉     | 能（`seeClaimed`），但拿不到非消息事件                                    | 可以（`dispatch` 内部） |
| 尊重暂停闸                        | 要自己调 `gate.check`                                            | 同左                |
| 热重载/卸载时清端口                   | 要自己写清理                                                       | 生命周期清晰            |

结论：放 `src/onebot/`，作为 `BotRuntime` 的一个可选组件。

---

## 1. 总体结构

```
QQ 官方网关 ──WS/Webhook──> gateway.js ──> bot.js dispatch()
                                            │
                                   buildMessage()  ← message.js
                                            │
                            ┌───────────────┼────────────────┐
                            │               │                │
                     ledger 入账       onMessage 广播      onebot.onMessage()  ← 新增
                            │               │                │
                            │          面板 SSE/DSH      translate.js
                            │                                │
                            └──> pipeline（插件）      ws-server.js / http-api.js
                                                             │
                                                       OneBot 客户端
                                                             │
                                                    actions.js（action 分发）
                                                             │
                                              ids.js / segments.js / capability.js
                                                             │
                                                    outbound.send() → api.js
```

### 插入点（三处，都在 `src/bot.js`）

| 位置                                      | 现状                                                     | 改动                                                 |
| --------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `bot.js:889` `this.onMessage?.(msg)` 之后 | 只广播给外部订阅者，payload 被 `message-bus.js` 脱敏（无 `uin`/`raw`） | 加 `this.onebot?.onMessage(msg)`，**传完整 msg**，不走脱敏总线 |
| `bot.js:776` 非消息事件分支                    | 只分发给插件监听器                                              | 加 `this.onebot?.onEvent(eventName, d)`             |
| `bot.js:918` `pipeline.run` 之前          | 无条件跑插件管线                                               | `exclusive` 模式下 `return`，跳过管线（详见 §9）               |

**为什么不复用 `message-bus.js`**：它的 `serializeMessage()` 是对外契约（面板 SSE、dsh-roost  
共用），里面**故意不带 `uin`、`raw`、`auth_token`**。OneBot 需要真 QQ 号和 `msgIdx`，  
硬塞进去等于改外部契约；而兼容层是进程内的，直接拿 `msg` 对象最省事。

### 新增文件

```
src/onebot/
  index.js        OneBotBridge：装配、生命周期、热应用、状态快照
  deps.js         依赖白名单 / 状态 / 一键安装 / 加载（复用 plugin/deps.js）
  ws-server.js    基于 ws 的连接管理（鉴权 / 心跳 / 优雅关闭）
  http-api.js     POST /<action>，Bearer 鉴权，与 WS 共用 dispatchAction
  actions.js      action 实现表 + 统一响应/错误码
  translate.js    官方事件 → OneBot 事件（message / notice / meta_event）
  segments.js     OneBot 消息段 ↔ 官方 payload（文本 / @ / 图片 / 引用）
  voice.js        SILK 检测与编码、ffmpeg 兜底
  ids.js          双向 ID 表（uin ↔ openid、message_id ↔ msgId/msgIdx）
  capability.js   能力表（支持 / 降级 / 不支持 + 原因），面板与 get_status 共用
```

---

## 2. 配置契约

### 默认值（加进 `src/config.js:200` 的每机器人默认对象）

```js
onebot: {
  enabled: false,
  host: '127.0.0.1',
  port: 0,            // 0 = 自动（6700 + sha1(botId)%100，占用顺延）
  token: '',          // 空 = 拒绝启用
  selfUin: '',        // 机器人 QQ 号，启用时必填
  mode: 'exclusive',  // exclusive | parallel | mirror
  forwardAll: true,   // 全量群消息也推给客户端
  http: true,         // 同一端口上是否也接受 HTTP API（false = 只收 WS）
  unboundPolicy: 'warn', // warn（合成号+告警）| block（丢事件）
  voice: 'auto',      // auto（有 silk-wasm 就转）| reject（一律拒）
  historyCache: 100,  // 用账本模拟 get_*_msg_history 的条数，0 = 关
  allowRemote: false, // host 非回环时必须显式打开
  maxConnections: 4,
}
```

`deepMerge`（`config.js:374`）会把未知键原样保留，老配置文件不需要迁移。

### 校验（启用时逐条拦，报错要能直接照做）

| 字段             | 规则                          | 不合法时                                         |
| -------------- | --------------------------- | -------------------------------------------- |
| `token`        | 非空，≥16 字符                   | 「OneBot 兼容模式需要 access token，点『生成』即可」         |
| `selfUin`      | `/^[1-9]\d{4,11}$/`         | 「填机器人 QQ 号（SnowLuma 里登录的那个号）」                |
| `port`         | 1–65535，且不与面板/webhook 冲突    | 「端口 X 已被面板占用」                                |
| `host`         | 非回环时 `allowRemote` 必须为 true | 「监听 0.0.0.0 等于把机器人暴露到局域网，确认后再打开 allowRemote」 |
| `mode`         | 枚举                          | 回落 `exclusive`                               |
| `voice`        | 枚举                          | 回落 `auto`                                    |
| `historyCache` | 0–1000 整数                   | 夹到边界，不报错                                     |
| `enabled`      | 必须已装 `ws`                   | 「先在上面点『一键安装 ws』」（这是状态检查，不是配置错误）              |

### 热应用

`PUT /api/onebot` → 写 `config/bots/<id>.json` → `runtime.onebot.reconfigure(newCfg)`：  
端口/开关变化 → 停旧监听再起新的；只改 token → 不断连，新连接用新 token。  
**任何一步失败都不影响机器人本体**，错误回给面板。

---

## 2·补 依赖管理（按需安装）

### 依赖清单

| 包           | 用途       | 必需    | 体积     | 备注                                                         |
| ----------- | -------- | ----- | ------ | ---------------------------------------------------------- |
| `ws`        | WS 服务端   | **是** | ~120KB | 8.x。它自己的 `bufferutil` / `utf-8-validate` 都是 optional，不装也能跑 |
| `silk-wasm` | 语音转 SILK | 否     | ~1.5MB | 3.7.x，纯 WASM、零依赖；`encode(wav, 0)` 直接吃 WAV                  |

两者都**不进** `package.json`。框架本体保持零依赖，这条不变。

### 装在哪

```
data/deps/onebot/
  package.json      ← 我们写，只含白名单里的包
  node_modules/
  .deps.json        ← 哈希标记，内容没变就不重装（deps.js 已有）
```

**顺序很重要**：`ensurePluginDeps` 是读 `dir/package.json` 来决定装什么的，  
文件不存在它会认为「没有依赖」直接跳过。所以 `deps.js` 必须先写 `package.json`  
（内容固定、键排序，保证哈希稳定），再调安装器：

```js
await fs.writeFile(pkgFile, JSON.stringify({ name: 'roost-onebot-deps', private: true,
  dependencies: picked }, null, 2));
await ensurePluginDeps({ dir: DIR, manifest: {}, enabled: true, log });
```

为什么不用项目根 `node_modules`：那会让「零依赖」变成假话；`npm ci` 会把它们清掉；  
用户 `git pull` 之后行为还会变。放 `data/` 下则随数据走，升级不丢。

### 安装器复用 `src/plugin/deps.js`

`ensurePluginDeps({ dir, manifest, enabled: true })` 已经解决了最难的部分：npm / pnpm 探测、  
DSH 自带的运行时（`bundledRuntimeRoots`）、`--ignore-scripts`、超时、失败原因。  
我们只补三件事：

1. **白名单校验**：只接受 `ws` / `silk-wasm`。**绝不接受面板传来的任意包名**——  
   那等于把「面板弱口令」升级成「远程代码执行」
2. **装完冒烟**：`require` 一次并做最小实例化（`new WebSocketServer({ noServer: true })`、  
   `typeof encode === 'function'`），失败就当没装
3. **状态与版本**：`GET /api/onebot` 里带 `{installed, versions, missing, error}`

### 加载

```js
const requireFrom = createRequire(path.join(DIR, 'package.json'));
const ws = requireFrom('ws');   // ws 与 silk-wasm 都是 CJS（silk-wasm main = lib/index.cjs）
```

兜底一条：`require` 抛 `ERR_REQUIRE_ESM` / `ERR_REQUIRE_ASYNC_MODULE` 时改走  
`import(pathToFileURL(requireFrom.resolve(name)))`。当前两个包走不到，留着防大版本升级。

### 没装时是什么样

| 状态                   | 表现                                                                  |
| -------------------- | ------------------------------------------------------------------- |
| 缺 `ws`               | 兼容模式**不可启用**：开关置灰 + 黄条「先装 ws」；强行 `PUT enabled=true` 返回 400 并说明原因    |
| 有 `ws`、缺 `silk-wasm` | 正常启用；`can_send_record` 返回 `{yes:false}`，`record` 段回 1400 并提示「装可选依赖」 |
| 装了但加载失败（版本/权限/文件损坏）  | 按「缺」处理，状态里带具体错误，面板给「重装」按钮                                           |

### 手动兜底

面板永远显示一行可复制命令，装不上时用户能自己来：

```bash
npm i ws --prefix data/deps/onebot --omit=dev --no-audit --no-fund
npm i silk-wasm --prefix data/deps/onebot --omit=dev --no-audit --no-fund
```

镜像走 `config.network.mirror`（`plugin/env.js:48` 已经放行 `npm_config_registry`），  
不用为兼容层单独做一套。

---

## 3. ID 映射（最容易翻车的地方）

### 为什么必须做

OneBot 的 `user_id` / `group_id` 是 int64 的 QQ 号；官方给的是 openid（每 AppID 一套、32 位十六进制）。  
aurobot `src/chat/access.js:43` 用 `String(userId) === String(cfg.ownerQQ)` 判主人——  
**映射错了不会报错，只会让主人权限静默失效**。

### 正向：openid → 号码

```
uinOf(openid)  →  identity.uinOf(openid)        // identity.js:377，全局、不限机器人
groupUinOf(openid) → identity.groupUinOf(...)   // identity.js:382
```

有绑定就用真号。没有绑定按 `unboundPolicy`：

| 策略         | 行为                                  | 适用     |
| ---------- | ----------------------------------- | ------ |
| `warn`（默认） | 生成**稳定合成号** + 记进「未绑定」清单 + 每小时最多告警一次 | 迁移期、路人 |
| `block`    | 丢弃该事件，不推给客户端                        | 强一致场景  |

合成号规则（必须稳定、可逆、不撞真号）：

```
合成号 = 9_000_000_000_000 + (sha1(openid) 前 6 字节 mod 1_000_000_000_000)   // 13 位，9 开头
```

- **为什么是 13 位**：QQ 号 / 群号最长 12 位，13 位在数学上不可能撞真号；9 开头只是好认
- 仍要落表前查重（哈希截断理论上可能撞合成号），撞了就顺延 +1
- OneBot 的 `user_id` 是 int64，13 位在 JS `Number` 安全整数范围内（< 2^53），客户端用 `Number()` 也不会失真
- 映射落 `data/bots/<id>/onebot-ids.json`，重启后保持稳定（否则客户端会话会「换人」）
- 面板「身份检查」列出所有合成号 ↔ openid，点一下就能跳到身份页绑真号

### 反向：号码 → openid

```
openidOf(botId, uin)      → identity.openidOf(botId, uin)       // identity.js:393
groupOpenidOf(botId, uin) → identity.groupOpenidOf(botId, uin)  // identity.js:398
合成号 → 查 onebot-ids.json
查不到 → 报错 1404「这个 QQ 号在本机器人下没有 openid，去面板『身份』页绑一下」
```

### 消息 ID

官方 `msg.id` 是字符串（可能非数字），OneBot 要整数。做法：

- 每个机器人一个**单调递增**计数器，映射 `onebot_id → {msgId, msgIdx, chatId, at}`
- 只保留最近 500 条（内存 + 落盘节流 3 秒），够 `get_msg` / 引用 / 撤回用
- **计数器本身要落盘**（`onebot-ids.json` 里的 `nextId`）。不落盘的后果很具体：
  重启后计数器回到 1，客户端拿着重启前的 `message_id=42` 调 `delete_msg`，
  会撤掉**另一条**新消息——这种错没法解释，也没法撤回
- **不反推**：客户端传来的 `message_id` 只认表里的，认不出就 1404，别猜

### 历史消息（`get_*_msg_history`）

官方没有历史接口，只能用账本 `ledger.recent({ chatId, limit })`（`ledger.js:452`）回放。
但要如实说明两个限制：

- `recent()` 只 SELECT 了 `content / quoted / msg_idx`，**没有 attachments**。
  直接用它模拟，历史里只有文字，图片会丢
- 想要完整历史得给 `ledger.js` 加一个 `history({chatId, limit})`，把 `payload` 列一起取出来
  再解析（约 20 行，M3 里做）

所以 `historyCache` 默认 100，且在能力表里标成「降级：只有文字与引用」。

### 被动回复窗口怎么挂

`outbound.send()` 要 `payload.msgId` 才算被动回复（`outbound.js:525` `#sendOnce`）。  
action 分发时按 `chatId` 取**最近一条入站消息**：

```
age = now - lastInbound[chatId].receivedAt
若 age <= 安全窗口（群 285s / 单聊 3585s，已扣 15s）且该 msgId 回复次数 < 5(群)/4(单聊)
  → payload.msgId = msgId，msgSeq 由 api.js 自增
否则 → 主动消息，走额度；额度不足回 1501 并说明「等用户再说一句」
```

这条逻辑完全复用 `outbound.js` 的现成判定，兼容层只负责「把 msgId 递进去」。

---

## 4. 事件翻译

### 先过滤自己发的消息（防自激循环）

全量模式下如果平台把机器人自己发的消息也推回来，原样转发会让客户端「看见自己在说话」，
再触发一次回复 → 循环。判定很简单：

```
selfOpenid = identity.openidOf(botId, selfUin)     // 这也是 selfUin 必填的原因之一
若 author.member_openid / author.user_openid === selfOpenid → 不推 message
```

- **别的机器人**（`author.bot === true` 但不是自己）**照常转发**——群里多个机器人互相对话是正常场景
- 认不出自己（`selfUin` 没绑 openid）时，退化成 `author.bot === true` 全过滤，并在面板提示
  「机器人自己的 openid 没绑，已按『过滤所有机器人消息』处理」

### 映射表

| 官方事件                      | OneBot 事件                                | 说明                                |
| ------------------------- | ---------------------------------------- | --------------------------------- |
| `GROUP_AT_MESSAGE_CREATE` | `message` / `group` / `normal`           | `mentioned=true`                  |
| `GROUP_MESSAGE_CREATE`    | `message` / `group` / `normal`           | 全量模式；`forwardAll=false` 时丢弃未 @ 的  |
| `C2C_MESSAGE_CREATE`      | `message` / `private` / `friend`         |                                   |
| `GROUP_MEMBER_ADD`        | `notice` / `group_increase`              | 官方不区分主动进群/被拉                      |
| `GROUP_MEMBER_REMOVE`     | `notice` / `group_decrease` / `leave`    | 官方不区分主动退/被踢 → 统一 `leave`          |
| `GROUP_ADD_ROBOT`         | `notice` / `notify` / `bot_group_add`    | 扩展子类型，不冒充 `group_increase`        |
| `GROUP_DEL_ROBOT`         | `notice` / `notify` / `bot_group_remove` | 同上                                |
| `FRIEND_ADD`              | `notice` / `friend_add`                  |                                   |
| `FRIEND_DEL`              | `notice` / `friend_remove`               | 扩展                                |
| `GROUP_JOIN_REQUEST`      | `request` / `group` / `add`              | `flag` = `event_id`，`approve` 时回填 |
| `INTERACTION_CREATE`      | `notice` / `notify` / `interaction`      | 扩展，带 `interaction_id`             |
| —                         | `meta_event` / `lifecycle`               | 启用/连接时推一次                         |
| —                         | `meta_event` / `heartbeat`               | 25s 一次，`status.online`            |

### 撤回：动作有，事件只做一半

这里最容易读错，先分清两件事：

| 事项 | 官方有没有 | 兼容层怎么做 |
|---|---|---|
| **撤回动作**（让某条消息消失） | **有**：`DELETE /v2/groups/{group_openid}/messages/{id}`、`DELETE /v2/users/{openid}/messages/{id}`（`api.js:870` / `878`，内核已封装） | `delete_msg` 走**支持**档；2 分钟内，撤他人需群管理员 |
| **撤回事件**（别人撤回时通知机器人） | **群聊 / 单聊没有**（只有频道的 `MESSAGE_DELETE` / `DIRECT_MESSAGE_DELETE` / `PUBLIC_MESSAGE_DELETE`） | 别人撤回 → 不产生 `group_recall`；**自己撤的** → 主动补一条 |

所以 `notice/group_recall` 是**部分产生**：

- 客户端调 `delete_msg` 成功后，我们立刻推 `notice/group_recall`（`user_id = self_id`，
  `message_id` = 映射后的 id），客户端能据此清掉自己那份上下文
- 别人撤回（群友、管理员、腾讯风控删消息）**不会有任何事件**，客户端只能自己发现「引用的消息没了」
- 影响：引用一条已被别人撤回的消息会失败（官方会报 `msg_id` / 引用索引过期类的错误，如 `40034005`），
  兼容层把这类错误翻译成「原消息已被撤回或过期」，别让客户端以为是网关挂了

### 明确**不产生**的事件（写进能力表，面板可见）

- `notice/notify/poke` —— 官方没有拍一拍
- `notice/group_upload` —— 官方没有群文件事件
- `notice/bot_offline` —— 这是 SnowLuma 的私有事件，我们用 `meta_event/lifecycle` 表达断连

### 事件字段

```json
{
  "time": 1762900000,
  "self_id": 1427835822,
  "post_type": "message",
  "message_type": "group",
  "sub_type": "normal",
  "message_id": 10231,
  "group_id": 763366431,
  "user_id": 2014433751,
  "message": [ { "type": "text", "data": { "text": "在吗" } } ],
  "raw_message": "在吗",
  "font": 0,
  "sender": { "user_id": 2014433751, "nickname": "倦飞之鸟", "card": "倦飞之鸟", "role": "owner" },
  "anonymous": null
}
```

- `sender.role` 取官方 `author.member_role`（`owner`/`admin`/`member`）；c2c 固定 `member`
- `sender.card` 官方没有群名片，回落昵称（能力表标注「无群名片」）
- `time` 用秒；`message_id` 是映射后的整数

---

## 5. 消息段

### 入站（官方 → OneBot）

| 官方载荷                                 | OneBot 段                            | 备注                                          |             |                |
| ------------------------------------ | ----------------------------------- | ------------------------------------------- | ----------- | -------------- |
| `content` 纯文本                        | `text`                              | `stripMention` 之后                           |             |                |
| `content` 里 `<@openid>`              | `at` `{qq: 映射号, name}`              | 映射不出号码时给 `qq: '0'` + `name` 兜底              |             |                |
| `attachments[].content_type=image/*` | `image` `{file: url, url, summary}` |                                             |             |                |
| `voice`                              | `record` \`{file: wavUrl            |                                             | url, url}\` | 官方直接给 WAV，不用转码 |
| `video`                              | `video` `{file: url, url}`          |                                             |             |                |
| `file`                               | `file` `{file: url, name}`          |                                             |             |                |
| `ark_data`                           | `json` `{data: 原样}`                 |                                             |             |                |
| `msg_elements` type=102（聊天记录）        | `forward` `{id: 缓存键}`               | 同时把内容存进 ids 的 forward 表，供 `get_forward_msg` |             |                |
| 引用（`ref_msg_idx`）                    | `reply` `{id: 映射号}`                 | 映射不出来就不带                                    |             |                |

### 出站（OneBot → 官方）

| 段                              | 处理                                     | 限制                                                |
| ------------------------------ | -------------------------------------- | ------------------------------------------------- |
| `text`                         | 拼进 `content`；转义裸 `<`（避免被当 mention 语法）  |                                                   |
| `at`                           | 拼 `<@openid>`；`qq == self_id` 直接丢弃（被动回复本身已指向机器人） | 其他人未绑定时**降级为文本 `@昵称`** 并在 `data.warning` 里说明，不整条失败 |
| `reply`                        | `messageReference.message_id = msgIdx` | 挂在**拆条后的第一条**上（第一条是图片也行）；单独一条 `reply` 无效，忽略 |
| `image`                        | `uploadMedia()` → 单独一条 `msgType=7`     | **与文本拆条**；>5MB 走分片                                |
| `record`                       | 转 SILK 后单独发（见下）                        | 官方只收 SILK；没装 `silk-wasm` 就 1400                   |
| `face` / `mface`               | 降级为文本 `[表情]`（可配 `faceText: true`）      | 官方没有 QQ 表情码                                       |
| `forward` / `node`             | 拒绝 1404                                | 官方只能收不能发                                          |
| `share` / `music` / `location` | 降级为文本（标题 + 链接）                         |                                                   |

**语音**：官方只收 SILK（`file_type=3`）。`silk-wasm` 是**可选依赖**，装了才转，  
不装就退化成「发不了语音」——框架本体不因为这条功能破零依赖。

转换链路（`voice: 'auto'`）：

```
record.file（base64:// / http url / file://）
  ├─ isSilk(buf)        → 直接 uploadMedia(fileType=3)
  ├─ isWav(buf)         → silk-wasm.encode(buf, 0)  → uploadMedia    ← 零转码，最优路径
  ├─ mp3 / ogg / 其它    → 有 ffmpeg？→ 转 24kHz 单声道 WAV → encode → upload
  │                        没 ffmpeg？→ 1400「让 TTS 直接出 WAV，或装 ffmpeg」
  └─ 超过 20MB          → 1400（官方语音上限）
```

三个要说清的点：

- `silk-wasm` 的 `encode()` **直接吃 WAV**（`sampleRate` 传 0 时自己读头），所以 WAV → SILK 不需要 ffmpeg；  
  只有 mp3 这类才要外部解码。aurobot 的 edge-tts 出 mp3、CosyVoice / GPT-SoVITS 出 wav，覆盖一半
- ffmpeg 只做 PATH 探测，**不打包**（80MB 起步，且是原生二进制）。面板依赖卡里显示「ffmpeg：未找到」  
  |  |  |  
  | --- | --- |
- aurobot 对语音失败有兜底（`isDefiniteFailure` 里认 `highway|upload`），会改发文字，所以拒掉不会让整轮对话消失

### 拆条规则（一条官方消息只能一种富文本）

`msg_type` 是单值：`0` 纯文本、`2` markdown、`7` 单个媒体文件、`8` 图文卡片。  
所以「一段文字 + 两张图」在 OneBot 里是一条，在官方接口里必然是三条。

一条 OneBot message 数组 → N 条官方消息，**顺序不变**：

```
[reply][at][text][image][image]
  → 第 1 条：content = "<@openid> 正文"，message_reference = msgIdx
  → 第 2、3 条：msgType=7 图片
```

代价：每条都吃一次被动回复次数（群 5 次、单聊 4 次），而且官方没有「多图一条」  
（`msg_type=7` 一次只带一个文件）。所以第 6 段起直接拒绝，返回 1501 并说明  
「一条消息最多拆 5 条」。面板能力表里把这条写成「多段消息按条计费」。

---

## 6. Action 表

分三档。`支持` 直接实现；`降级` 有损但可用；`不支持` 返回 1404 并给替代方案。  
读类不支持时返回**空集 + `wording` 说明**（多数客户端不处理错误码，报错会让整段逻辑崩），  
写类不支持一律报错（静默失败比报错危险）。

| Action                                                                                                  | 档   | 实现                                                        | 备注                                                      |
| ------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------- | ------------------------------------------------------- |
| `send_private_msg`                                                                                      | 支持  | `outbound.send({kind:'c2c'})`                             |                                                         |
| `send_group_msg`                                                                                        | 支持  | `outbound.send({kind:'group'})`                           | 多段拆条                                                    |
| `send_msg`                                                                                              | 支持  | 按 `message_type` 分流                                       | 和上面两条走**同一条** outbound 路径，闸/额度/账本一样生效，不是后门              |
| `delete_msg`                                                                                            | 支持  | `api.retractGroupMessage` / `retractC2CMessage`           | 群聊、单聊都能撤；2 分钟内；撤他人需群管理员；**成功后补发 `notice/group_recall`** |
| `get_msg`                                                                                               | 降级  | ids 缓存                                                    | 只有最近 500 条                                              |
| `get_forward_msg`                                                                                       | 降级  | forward 缓存                                                | 只覆盖本次进程收到的                                              |
| `send_group_forward_msg`                                                                                | 不支持 | —                                                         | 官方只能收不能发                                                |
| `get_login_info`                                                                                        | 支持  | `{user_id: selfUin, nickname: cfg.name}`                  | 昵称用配置名                                                  |
| `get_group_info`                                                                                        | 支持  | `api.getGroupInfo`                                        | 30 QPM，带缓存                                              |
| `get_group_list`                                                                                        | 降级  | 群档案（`groups.js`）+ 事件发现                                    | 官方无查询接口                                                 |
| `get_group_member_info`                                                                                 | 降级  | 内邀开了走 `api.getGroupMember`，否则查「见过的人」                      |                                                         |
| `get_group_member_list`                                                                                 | 降级  | 同上；没有就返回见过的成员                                             | 明确标注不完整                                                 |
| `get_stranger_info`                                                                                     | 不支持 | —                                                         | 官方没有用户资料接口                                              |
| `get_friend_list`                                                                                       | 不支持 | 空数组 + `wording`                                           | 官方没有好友列表                                                |
| `set_group_ban`                                                                                         | 支持  | `api.muteMember`                                          | 需管理员；最长 30 天                                            |
| `set_group_whole_ban`                                                                                   | 不支持 | —                                                         | 官方只有单成员禁言                                               |
| `set_group_kick`                                                                                        | 不支持 | —                                                         | 内邀接口，普通机器人 11253                                        |
| `set_group_add_request`                                                                                 | 支持  | `api.handleJoinRequest`                                   | 需管理员                                                    |
| `set_friend_add_request`                                                                                | 不支持 | —                                                         | 官方没有加好友审批接口                                             |
| `set_group_card` / `set_group_name` / `set_group_admin` / `set_group_leave` / `set_group_special_title` | 不支持 | —                                                         | 官方无对应接口                                                 |
| `set_input_status`                                                                                      | 降级  | 单聊 `msgType=6`                                            | 群聊无此能力                                                  |
| `send_poke`                                                                                             | 不支持 | —                                                         | 官方没有拍一拍                                                 |
| `can_send_image`                                                                                        | 支持  | `{yes: true}`                                             |                                                         |
| `can_send_record`                                                                                       | 支持  | 按 `silk-wasm` 是否可用返回                                      | 装了才是 true；面板标注「因缺依赖降级」                                  |
| `get_status`                                                                                            | 支持  | 连接态 + 计数器                                                 |                                                         |
| `get_version_info`                                                                                      | 支持  | `{app_name:'roost', app_version, protocol_version:'v11'}` |                                                         |
| `get_image` / `get_record`                                                                              | 降级  | 从附件缓存返回 url                                               |                                                         |
| `fetch_ptt_text`                                                                                        | 降级  | 取官方 `asr_refer_text`                                      | 只覆盖入站语音；官方已经给了 ASR 参考文本，不用自己跑识别                         |
| `mark_msg_as_read`                                                                                      | 空实现 | `{}`                                                      | 官方无已读                                                   |
| `set_restart` / `get_cookies` / `get_csrf_token` / `.handle_quick_operation`                            | 不支持 | —                                                         | 安全面，一律拒                                                 |

**给 aurobot 的实测覆盖**：它调 43 个 action，按本表逐条归类是  
**5 个直接支持**（`send_group_msg` / `send_private_msg` / `get_login_info` / `get_group_info` / `set_group_add_request`）、  
**9 个降级**（群列表、成员信息/列表、`get_image` / `get_record` / `fetch_ptt_text`、`set_input_status`、`get_msg` / `get_forward_msg`）、  
**29 个不支持**（空间 7、表情商城 4、改资料 3、历史 2、好友/陌生人 2、拍一拍 1、  
tts/图/视频/点歌 4、群文件 URL 2、可疑好友 2、加好友审批 1、`asr` 1）。

> 早先口头汇报时按「粗分」给的是 7/5/31——那是把 `get_group_list`、`get_image` 算成「可用」了。  
> 按「无损才算支持」的口径，就是这里的 5/9/29；两者不矛盾，以本表为准。

结论不变：聊天主链路（收发、图片、语音、引用、@、撤回、禁言）完整——语音那项要装了  
`silk-wasm` 才有；空间、表情商城、改资料、历史补看、拍一拍、好友列表会失效。

---

## 7. 响应与错误码

```json
{ "status": "ok", "retcode": 0, "data": {...}, "echo": "..." }
{ "status": "failed", "retcode": 1404, "data": null,
  "wording": "官方接口没有『拍一拍』，这条 action 在 roost 里不可用" }
```

| retcode | 含义        | 典型场景                |
| ------- | --------- | ------------------- |
| 0       | 成功        |                     |
| 100     | 已受理（异步）   | 预留                  |
| 1400    | 参数错误      | 缺 `group_id`、消息段非法  |
| 1401    | 鉴权失败      | token 不对            |
| 1404    | 不支持 / 找不到 | 未实现 action、号码没绑定    |
| 1500    | 内部错误      | 官方接口 5xx            |
| 1501    | 额度或窗口不足   | 主动额度用完、被动次数用满、拆条超 5 |

`wording` 必须是**中文、可执行**的句子（照 `docs/官方接口限制.md` 的风格），  
不要 `Internal error` 这种。日志同时记一条 `[onebot] action 失败`，面板计数。

---

## 8. WS 服务端（用 `ws`，按需安装）

### 为什么不再手写 RFC6455

上一版设计打算手写（约 250 行），理由是零依赖。既然依赖可以按需装，就没必要了：  
掩码、`payload len` 的 126/127 两种扩展长度、分片累积、半关闭、`ping` 超时——  
这些边界自己写一遍，测一遍，收益是负数。`ws` 8.x 自己零运行时依赖，只 optional 依赖  
`bufferutil` / `utf-8-validate`（不装就走纯 JS 路径），正是我们要的形状。

### 一个端口，两种协议

WS 与 HTTP **共用同一个端口**（用户只填一个地址，少一个「端口填错」的坑）：

```js
const server = http.createServer(handleHttp);            // POST /<action>
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1 << 20,          // 1MB，OneBot 报文很小，超过就是异常
  perMessageDeflate: false,     // 不压缩，省 CPU 也少一类 bug
});

server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) return reject401(socket);        // 握手前就拦掉，不进 WS 状态机
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
```

- `http: false` 时只挂 `upgrade`，普通 `POST` 直接 404
- **鉴权**：`?access_token=` 或 `Authorization: Bearer`；token 用 `timingSafeEqual` 比，
  长度不等先直接拒（`timingSafeEqual` 长度不同会抛）
- **连接数上限**：`connection` 里看 `wss.clients.size`，超了 `ws.close(1013, 'too many')`
- **心跳**：`isAlive` + 每 30s `ws.ping()`，一个周期没 `pong` 就 `terminate()`（`ws` 自带）
- **收消息**：`JSON.parse` 后取 `{action, params, echo}`；非法 JSON 回 1400，**不断连接**
- **发消息**：只发 `{status, retcode, data, echo}`，`echo` 原样带回（客户端靠它配对）
- **关闭顺序**：`wss.close()` → 每个 `client.close(1001)` → 2s 后 `terminate()`

预计 120–150 行（含连接管理、鉴权、心跳、广播、优雅关闭）。

### 未装 `ws` 时

`src/onebot/index.js` 在 `start()` 里先查依赖状态：

```
缺 ws → 不监听端口，state 置 'missing-deps'，面板显示黄条 + [一键安装]
        日志只打一行：「OneBot 兼容模式未就绪：缺依赖 ws（在面板『兼容』页一键安装）」
```

**不抛异常、不阻塞启动**——一只鸟的兼容层没装依赖，不该影响其它鸟和插件。

---

## 9. 接管模式（和插件管线的关系）

| 模式              | 消息去向                           | 发送方    | 适用                |
| --------------- | ------------------------------ | ------ | ----------------- |
| `exclusive`（默认） | 只推给 OneBot 客户端，**不进 pipeline** | 只有客户端  | 替代 SnowLuma 的正常用法 |
| `parallel`      | 既推客户端，也进 pipeline              | 两边都可能发 | 迁移期对比，**会双回**     |
| `mirror`        | 只推客户端，客户端发的 action 一律 1404     | 只有插件   | 观测/调试             |

`exclusive` 的边界必须写清楚：

- **仍然执行**：账本入账（`bot.js:867`）、去重、`reach` 可达性、群档案、`logIncoming`
- **跳过**：命令路由、插件监听器、`msg.reply()` 合并回复
- **仍然生效**：暂停闸。`gate.check(chatId)`（`gate.js:124`）要在 action 的发送路径上**显式调**——  
  闸是 pipeline 中间件，跳过 pipeline 就绕过了它。不补这一步，用户点了「暂停」aurobot 还在说话，  
  这是最不能接受的一种 bug
- **闸的语义要定清楚**：暂停时**事件照推**（客户端状态不至于失真），**发送一律拒**，
  返回 1501「本会话已暂停（原因）」。既不停消息流，也不让它开口——比「什么都不推」好排查得多
- **白名单**：`cfg.whitelist` 只在 pipeline 里生效，`exclusive` 下不拦。要不要拦是产品决策，  
  建议**拦在事件推送层**（不在白名单的群不推给客户端），并在面板写明

### 与 dsh-roost 的冲突

dsh-roost 是 DSH 插件（`integrations/dsh-roost`），aurobot 也是 DSH 插件。两个都接同一个机器人号  
就会双回。文档要在显眼处写：**同一只鸟，dsh-roost 与 OneBot 客户端二选一**。  
（不做自动互斥，跨进程管不了。）

---

## 10. 面板「外接」页

### 信息架构（新 tab `onebot`，挂在「配置」组）

```
兼容（OneBot v11）                          后端：QQ 官方接口（AppID 102055275）
──────────────────────────────────────────────────────────────────────
[ ] 兼容模式        （缺 ws 时置灰，下面黄条给出原因）

依赖    ws         8.18.0 已安装          [重装]
        silk-wasm  — 未安装（可选，发语音）  [一键安装]   1.5MB
        ffmpeg     — 未找到（可选，mp3 转语音）          装法见说明
        ┌ 黄条：兼容模式需要 ws。装到 data/deps/onebot/，不动系统环境 ┐
        └ 手动：npm i ws --prefix data/deps/onebot --omit=dev      ┘

连接    监听 [127.0.0.1] : [6700]    Token [••••••] [生成]
        机器人 QQ 号 [1427835822]（从身份页选）
        接管方式 (•)独占  ( )并行  ( )只观测
        连接串 ws://127.0.0.1:6700/?access_token=…   [复制]
        （HTTP API 同一端口：http://127.0.0.1:6700/<action>）
        [保存并应用]   [自检]

状态    监听中 · 1 个连接 · 最近事件 3s 前 · 动作 128 / 失败 2
        ⚠ 2 个人、0 个群还没绑 QQ 号 → [去绑定]

能力    共 43 项：支持 5 · 降级 9 · 不支持 29   [展开]
        ▸ get_qzone_msg_list：官方没有空间接口

调试    [最近 50 条事件]  [发测试消息]  [清空]
```

### 前端改动

| 文件               | 改动                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `web/index.html` | 导航加 `data-tab="onebot"`；加一块 `#tab-onebot` 容器（结构照 `tab-reach`）                                  |
| `web/app.js`     | `switchTab` 分支加 `onebot`；`loadOnebot()` / `renderOnebot()` / 保存与自检的事件绑定；沿用现有 `api()` 封装与 `$()` |
| `web/style.css`  | 复用现有卡片/表格类，尽量不新增样式；只有「能力矩阵」需要一列等宽                                                              |

### 后端接口

| 方法   | 路径                         | 返回                                                                                                                                                                                        |
| ---- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/onebot`              | `{cfg, state:{listening, port, connections, lastEventAt, actions:{ok,fail}, unsupported:[]}, deps:{installed, versions, missing, error}, capability:[...], unbound:{users:[],groups:[]}}` |
| PUT  | `/api/onebot`              | 校验 → 落盘 → `reconfigure()` → 新状态；失败回 400 + 人话原因                                                                                                                                            |
| POST | `/api/onebot/test`         | 自检：端口可绑？token 长度？selfUin 在身份表里？身份覆盖率？依赖可加载？                                                                                                                                               |
| GET  | `/api/onebot/events`       | 最近 50 条（脱敏：不含 token、openid 只留前 6 位）                                                                                                                                                       |
| POST | `/api/onebot/deps/install` | body `{packages:['ws']}`（**只接受白名单**）→ 同步等安装完成，返回新状态；耗时 10–60s                                                                                                                             |
| POST | `/api/onebot/deps/remove`  | 可选：删 `data/deps/onebot/node_modules` 下对应包，用于「装坏了重装」                                                                                                                                       |


**鉴权复用面板那套**（`authorized()` / CSRF / 同源），不新开口子。
`/api/onebot/events` 里 `raw` 一律不返回——里面可能有 `auth_token`（同 `message-bus.js` 的教训）。

### 交互细节

- 「生成」按钮：`crypto.randomBytes(24).toString('base64url')`
- 保存后**不刷新页面**，只更新状态卡；端口冲突时红色提示「6700 被占用，换成 6701」
- 未绑定告警点进去 = 跳到「身份」页并带上筛选参数（`#identity?unbound=1`）
- 关闭开关时：先停监听，再写配置；页面显示「已停止，配置保留」
- **一键安装**：按钮点击后立刻禁用 + 转圈（文案「正在安装 ws…首次可能要半分钟」），
  完成后按返回的状态重绘；失败时把 `error` 原文显示出来，并保留「手动命令」那一行
- 安装**不需要重启**：装完直接 `reloadDeps()` 再 `start()`，面板当场变「已就绪」
- 开关在缺 `ws` 时置灰，鼠标悬停给原因（不要只给个点不动的框）

---

## 11. 文件清单

### 新增

| 文件 | 行数估 | 内容 |
|---|---|---|
| `src/onebot/index.js` | 220 | Bridge 生命周期、reconfigure、状态快照 |
| `src/onebot/deps.js` | 150 | 依赖状态 / 白名单安装 / 加载（复用 `plugin/deps.js`） |
| `src/onebot/ws-server.js` | 150 | 基于 `ws`：鉴权、连接管理、心跳、优雅关闭 |
| `src/onebot/http-api.js` | 150 | HTTP + 鉴权 + 路由 |
| `src/onebot/actions.js` | 400 | action 表与实现 |
| `src/onebot/translate.js` | 250 | 事件翻译 |
| `src/onebot/segments.js` | 200 | 消息段双向 |
| `src/onebot/voice.js` | 150 | SILK 检测/编码、ffmpeg 兜底 |
| `src/onebot/ids.js` | 200 | ID 表与持久化 |
| `src/onebot/capability.js` | 120 | 能力表 |
| `test/onebot-ids.mjs` | 120 | 合成号稳定性/碰撞/持久化 |
| `test/onebot-segments.mjs` | 150 | 拆条/转义/@/语音分支 |
| `test/onebot-translate.mjs` | 150 | 字段映射/不产生的事件 |
| `test/onebot-deps.mjs` | 120 | 白名单拒绝/安装目录/加载失败降级 |
| `test/onebot-loopback.mjs` | 250 | 起真 WS 服务端 + 真客户端跑 12 场景 |
| `docs/OneBot兼容.md` | — | 用户向：怎么开、怎么装依赖、怎么连 aurobot、哪些做不到 |

### 修改

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/config.js:200` | 加 `onebot` 默认块 + 校验 | 低（deepMerge 兼容老配置） |
| `src/bot.js` | 构造 `onebot`；`dispatch` 三处挂钩；`stop()` 里关端口 | 中（碰主链路，必须回归） |
| `src/main.js` | 多机器人端口分配、启动日志、shutdown 顺序 | 低 |
| `src/web/server.js` | 6 个 `/api/onebot*` 路由 | 低 |
| `web/index.html` / `web/app.js` / `web/style.css` | 新 tab（含依赖卡） | 中（前端 180KB 单文件，注意别破坏既有 tab） |
| `package.json` | `test` 脚本追加 5 个测试文件；**`dependencies` 仍然为空** | 低 |
| `README.md` / `docs/配置参考.md` / `docs/官方接口限制.md` | 各加一节 | 低 |

---

## 12. 里程碑与验收

### M0 依赖管理（≈350 行）

- `src/onebot/deps.js`：白名单、状态查询、安装（复用 `ensurePluginDeps`）、加载、冒烟
- `POST /api/onebot/deps/install` + 面板依赖卡（先只有按钮和状态，不做整页）
- **验收**：全新机器点「一键安装」→ `data/deps/onebot/node_modules/ws` 出现 →
  面板显示版本 → 重启 roost 后仍认得（不用重装）；断网点安装 → 给出可读失败原因 + 手动命令
- **不通过就停**：安装污染了项目根 `node_modules`，或面板能装白名单以外的包

### M1 协议骨架（≈900 行）

- 配置 + 校验 + 开关；WS 服务端（`ws`）；`message` 事件；`send_group_msg` / `send_private_msg` / `get_login_info`
- **验收**：aurobot 填 `ws://127.0.0.1:6700?access_token=…` 能连上，私聊与群 @ 都能回话，
  引用与 @ 生效，重启 roost 后客户端自动重连
- **不通过就停**：ID 映射错、被动窗口没挂上（消息都变主动 → 额度烧光）

### M2 面板页（≈450 行）

- 开关 / 端口 / token / 连接串 / 状态卡 / 未绑定告警 / 依赖卡补齐（重装、ffmpeg 状态）
- **验收**：面板上改端口 → 保存 → 客户端重连成功；关开关 → 端口释放（`netstat` 验证）；
  卸掉 `ws` 后开关自动置灰并给出原因

### M3 能力补全（≈850 行）

- 图片、**语音（silk-wasm 可选依赖）**、撤回、禁言、群信息、群列表、成员（降级）、
  通知事件、历史缓存模拟、HTTP API
- **验收**：aurobot 发图、发语音、引用、撤回、禁言全部走通；`get_group_msg_history` 返回账本里最近 N 条；
  卸掉 `silk-wasm` 后 `record` 段返回可读的 1400 而不是崩

### M4 打磨（≈500 行）

- 能力矩阵页、调试面板、反向 WS、`docs/OneBot兼容.md`、安全章节
- **验收**：`npm test` 全绿；能力矩阵与实际行为逐条对齐（写一个测试遍历 capability 表，
  对「支持」的项各跑一次最小调用）

---

## 13. 测试方案

1. **单元**：ids（合成号稳定、重启不变、不撞真号）、segments（5 段拆条、`<` 转义、
   语音三条分支、at 未绑定）、translate（每个官方事件一条断言 + 「不产生」的 3 条负断言 +
   「自己撤回补发 `group_recall`」一条正断言）、
   capability（表里每个 action 都能被 `dispatchAction` 认领，不漏不重）、
   deps（白名单拒绝任意包名、安装目录是 `data/deps/onebot`、加载失败降级为「未安装」）
2. **回环**：`test/onebot-loopback.mjs` 起真 WS 服务端 + 真客户端（复用 `scripts/live-test.mjs`
   的 `call()` 思路），配一个假 `api`（`makeMockApi`），跑 12 个场景
3. **真机**：aurobot 连真机器人，跑 7 个场景（私聊、群 @、群全量接话、发图、发语音、引用、撤回）
4. **回归**：`npm test` 全绿；重点看 `outbound` 相关（新增调用路径会不会把 `msgSeq` 用乱）
   与 `npm ci` 之后框架仍能启动（证明依赖没混进根目录）

---

## 14. 安全

- token 必填，空则**拒绝启用**（不是警告）；日志与 API 响应一律脱敏
- 默认只监听 `127.0.0.1`；`0.0.0.0` 需显式 `allowRemote: true`，面板红字
- 连接数上限、单连接 action 速率（默认 10/s）、报文大小上限 1MB
- 危险 action 硬拒：`get_cookies`、`get_csrf_token`、`set_restart`、`get_credentials`
- `mirror` 模式下所有写 action 一律 1404（只观测）；`send_msg` 不设后门，和 `send_group_msg` 同一条路径
- **依赖安装是最高危的一环**，三条硬规则：
  1. **包名白名单**（`ws` / `silk-wasm`），面板传别的名字直接 400。不做白名单 = 面板弱口令直接变 RCE
  2. 走 `deps.js` 的 `--ignore-scripts`，**不执行包的安装脚本**（`ws`、`silk-wasm` 都不需要）
  3. 装完只做加载冒烟，不自动升级、不自动重装；版本锁在 `^8` / `^3`
- 安装目录不进 `PATH`、不进项目根，加载只用绝对路径的 `createRequire`
- 更新 `SECURITY.md`：多开一个端口就多一个入口，公网部署必须走反代 + 额外认证；
  兼容层与依赖安装都只在回环可用（`allowRemote` 打开后另说）

---

## 15. 风险与回滚

| 风险 | 影响 | 处置 |
|---|---|---|
| 官方接口/额度变更 | 兼容层行为漂移 | 能力表集中在一处，改一处即可；`docs/官方接口限制.md` 同步 |
| OneBot v11 已冻结（2023） | 长期会被 Milky/Satori 取代 | 事件/动作走中间层，v11 只当一个 codec；预留 `protocol: 'v11'` 字段 |
| 双回（插件 + 客户端） | 群里刷两条 | `exclusive` 默认；面板写明；`parallel` 加确认弹窗 |
| 端口冲突 | 启用失败 | 启动失败不阻塞机器人，面板报错并建议下一个端口 |
| 合成号被当成真号 | 主人权限错乱 | 合成号固定 13 位 9 开头（真号最长 12 位，撞不上），落表前查重；面板显式标注「未绑定」 |
| 拆条吃满被动次数 | 后半段变主动消息 | 超过 5 段直接拒绝并说明，不静默降级 |
| 依赖装不上（无网 / 无 npm / 镜像坏） | 兼容模式用不了 | 复用 `deps.js` 的 npm/pnpm/DSH 运行时探测；失败给原文 + 可复制命令；不阻塞机器人启动 |
| 依赖被用户手动删/改坏 | 启动时状态异常 | 每次 `start()` 重新冒烟；失败按「未安装」处理并提示重装，不抛异常 |

**回滚**：关开关即停监听，代码路径全部在 `if (cfg.onebot.enabled)` 之内；
删掉 `src/onebot/` 与三处挂钩即可完全回到现状（不影响既有配置）。

---

## 16. 文档与发版

- `README.md`「已知限制」加一条：OneBot 兼容层只覆盖聊天主链路
- `README.md` 致谢段那句「OneBot 2023 冻结所以直连官方」要补一句：
  **后端仍是官方接口，OneBot 只是对外协议**，别让后来人误读成回退
- `docs/配置参考.md` 加 `onebot.*` 全字段
- `docs/官方接口限制.md` 交叉引用（哪些限制在兼容层里表现为「不支持」）
- `docs/OneBot兼容.md` 必须写清「首次开启要装 `ws`」——这是用户最容易卡住的一步
- 发版：`+0.0.1`；`package.json` 的 `files` 已含 `src`，无需改；
  **`dependencies` 保持为空**（发版检查里要能看出来没被误加）；`SHA256SUMS` 照常重建

---

## 17. 已定（2026-11-12 主人拍板）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 默认接管模式 | **`exclusive`**：跳过插件管线，客户端独占收发；`parallel` / `mirror` 留作选项 |
| 2 | 未绑定用户 | **`warn`**：13 位合成号 + 面板告警，不丢事件 |
| 3 | 语音 | **可选依赖**：`silk-wasm` 一键安装，装了就能发；不装则 `record` 段返回 1400 并提示 |
| 4 | 端口 | **每鸟一端口**，6700 起自增 |
| 5 | 面板位置 | **「配置」组**，状态卡与依赖卡都放在这一页 |

### 由这些决策带出来的两个约定

- **依赖不是启动前置**：没装 `ws` 只是「兼容模式未就绪」，其它功能照常跑
- **语音能力是「装了就多一项」**：`capability` 里 `can_send_record` 按实际依赖状态返回，
  面板能力矩阵要显示「因缺 silk-wasm 降级」，不能只写「不支持」

### 端口自动分配怎么算（`port: 0`）

不能按「数组下标」算——加一只鸟、删一只鸟，后面的端口全平移，客户端全部连不上。
用 **botId 的稳定哈希**：

```
port = 6700 + (sha1(botId) 前 2 字节 % 100)      // 6700–6799
```

- 绑定失败（被占）就 +1 顺延，最多试 20 次，全失败就在面板报「换一个端口」
- 面板里**端口输入框留空 = 自动**，占位符显示「自动（当前 6707）」——不显示一个光秃秃的 `0`
- 状态行写「端口 6707（自动分配）」，旁边有「固定为当前端口」按钮，点一下把实际端口写回配置
  （反代、防火墙放行这类场景需要写死的端口）
- 同一进程里两个 botId 撞到同一端口时，后启动的那个顺延，日志写明原因

---

## 18. 复核记录（2026-11-12 开工前）

动手前把方案对着代码逐条核了一遍，改掉 7 处会真出问题的设计：

| # | 原设计 | 问题 | 改成 |
|---|---|---|---|
| 1 | WS 与 HTTP 各占一个端口 | 用户要填两个地址，填错就「连上了但不回话」，极难排查 | **同一端口**：`http.createServer` + `WebSocketServer({noServer})` + `upgrade` 分流 |
| 2 | `message_id` 内存自增 | 重启后从 1 开始，客户端拿旧 id 调 `delete_msg` 会撤掉**另一条**新消息 | 计数器落盘（`nextId`），旧 id 一律 1404 |
| 3 | 全量消息原样转发 | 平台若回推机器人自己的消息，客户端会「看见自己在说话」→ 自激循环 | 用 `openidOf(botId, selfUin)` 判自己并丢弃；认不出时退化成过滤所有 bot |
| 4 | 暂停闸只在 pipeline 里 | `exclusive` 跳过 pipeline → 闸被绕过，点了暂停还在说话 | action 发送路径显式 `gate.check(chatId)`；**事件照推、发送拒** |
| 5 | 引用段「必须与文本同一条」 | 第一条是图片时引用就丢了 | 挂在拆条后的**第一条**上，不限类型 |
| 6 | `at` 段 `qq=self_id` 也照拼 | 被动回复本身已指向机器人，多一个 `@` 是噪音，且要查一次 openid | 直接丢弃 |
| 7 | 历史用 `ledger.recent()` | 它只 SELECT 了 `content/quoted/msg_idx`，**没有 attachments**，历史里的图片会静默消失 | 如实标注「只有文字与引用」；完整历史要 M3 给 ledger 加 `history()` 取 `payload` |

另外补了一条端口分配规则（见 §17 末尾）：按 botId 哈希而不是数组下标。

### M0 实施记录（已完成）

- `src/onebot/deps.js`：白名单（`ws` / `silk-wasm`）、状态、串行安装、双层缓存清理
  （自己的 Map **和** Node 的 `require.cache`，只清前者会出现「卸载了还能加载」）、冒烟
- `src/config.js`：`onebot.*` 默认块（14 个字段）
- `src/web/server.js`：`GET/PUT /api/onebot`、`POST /api/onebot/deps/{install,remove}`
- `web/index.html` + `web/app.js`：新 tab「外接」+ 依赖卡（安装/卸载/刷新/手动命令）
- `test/onebot-deps.mjs`：8 项，**不联网**（伪造本地 `ws` 包验证 status/load/verify）

真机验证（临时 `ROOST_HOME`，不碰真实数据）：安装 `ws@8.22.2` 成功、
`PUT enabled=true` 成功、卸载后 `PUT enabled=true` 返回 400 且只报 `ws`、
非法包名 `lodash` 被白名单拒。

### M1 实施记录（已完成，面板开关提前做了）

协议层：

- `src/onebot/ids.js`：真号优先 + 13 位合成号（持久化）+ 消息 id 计数器落盘 + 双向索引
  （`byOfficial` / `byIdx`）。自己发出去的消息也登记（`bindSent`），否则撤回永远失败
- `src/onebot/translate.js`：消息事件 / notice / lifecycle / heartbeat，含「自己撤回补 `group_recall`」
- `src/onebot/segments.js`：入站拆段（text/at/reply/image/record/video/file）、出站解析
  （文本转义 `<@`、`@自己`丢弃、图片、引用挂第一条、语音报 1400）
- `src/onebot/ws-server.js`：**同一端口**的 WS + HTTP（`noServer` + `upgrade`）、
  `timingSafeEqual` 鉴权、30s ping、优雅关闭
- `src/onebot/actions.js`：`send_group_msg` / `send_private_msg` / `send_msg` / `delete_msg` /
  `get_msg` / `get_login_info` / `get_group_info` / `get_group_list` / `get_status` /
  `get_version_info` / `can_send_image` / `can_send_record` / `mark_msg_as_read`，
  其余一律 1404 + 中文原因
- `src/onebot/index.js`：生命周期、端口自动分配（`6700 + sha1(botId)%100`，占用顺延）、
  被动窗口缓存、自己消息过滤、`exclusive` 判定

内核接线（`src/bot.js`）：

- 构造 `onebot`，`start()` 里 `onebot.start()`（失败只 warn，不拦启动）
- `dispatch`：消息走 `onebot.onMessage(msg)`，非消息走 `onebot.onEvent(name, d)`
- `exclusive` 时在 `pipeline.run` 之前 `return`（账本 / 去重 / 可达性 / 群档案已经做完）
- `stop()` 先关兼容层再关插件，端口尽快释放

面板：开关 / 监听地址 / 端口 / 机器人 QQ 号 / token（生成）/ 接管方式 / 保存并应用 /
状态卡（端口、连接数、合成号数量、动作成功失败）/ 连接串提示。

验证（临时 `ROOST_HOME`，不碰真实数据）：

- `test/onebot-loopback.mjs`：真 WS 客户端 + 真服务端，覆盖
  事件字段（真号映射）、`send_group_msg` 带 `msgId`（被动回复）、`send_poke` 回 1404、
  HTTP 同端口、无 token 回 401 —— **全过**
- 面板接口：开 → `running`、端口自动分配；关 → 端口立刻释放（`curl` 验证）
- `npm test` 全绿（回环测试在没装 `ws` 的环境里自动跳过）

### M3 实施记录（语音 / 群管 / 历史 / 能力表）

- `src/onebot/voice.js`：`silk-wasm` 可选依赖；SILK 直发、WAV 直接编码、
  mp3 走 ffmpeg 转 24k 单声道再编码；>5MB 走临时文件 + 分片上传；20MB 上限前置拦
- `segments.js`：`record` 段不再直接报错，收进 `records[]` 交给 actions 决定能不能发
- `actions.js` 新增：`set_group_ban`（RFC3339 到期时间）、`set_group_add_request`
  （`flag` 透传 `join_request_id`）、`get_group_member_info` / `get_group_member_list`
  （内邀没开时降级：号码 + 已知昵称 / 只列说过话的人）、
  `get_group_msg_history` / `get_friend_msg_history`（账本回放，含图片语音）
- `src/ledger.js` 新增 `history({chatId, limit})`：把 `payload` 一起取出来，
  只给兼容层用；面板仍走 `recent()`（不需要那份大字段）
- `src/onebot/capability.js` + 面板「能力」折叠表：支持/降级/不支持 + 原因，
  和 `actions.js` 注册表交叉校验（说支持但没实现 → 按不支持算）

### 面板开关改成滑块

`.switch-slider` 保留原生 checkbox（`.checked` 语义、键盘可访问），只换外观。
**踩坑**：全局 `label { flex-direction: column }` 会把滑块和文字竖排，
截图上就是「开关在上、文字在下」。必须显式 `flex-direction: row`，
并给文字 `flex:1; min-width:0` 才能正常换行。

### 端口与 token 的交互修正（2026-11-12）

**端口 `0` 的显示**：`0` 是「自动分配」的内部表示，但输入框里显示一个 `0` 会让人以为配错了。
改成输入框**留空 = 自动**，占位符显示「自动（当前 6707）」；状态行写「端口 6707（自动分配）」，
旁边给「固定为当前端口」按钮（反代/防火墙要写死端口时点一下）。

**token 只有「生成」不够用**，补齐三个动作：

| 动作 | 行为 |
|---|---|
| 生成 | 48 位十六进制，生成后立刻切成明文显示（否则用户没法确认生成成功） |
| 复制 | 优先用输入框里的值；非本机访问拿不到明文时提示「重新生成一次」 |
| 显示 / 隐藏 | 掩码切换，纯前端 |
| 清除 | 二次确认 → `PUT {token:null}`；**后端同时把 `enabled` 置 false**（清 token 等于拆门） |

`GET /api/onebot` 的 token 策略：**回环请求给明文，其余只给 `tokenSet`**。
面板一旦被反代暴露，每次打开页面都回一次明文不合适；而本机访问不给明文就没法复制到客户端。

**两条门禁**（都不是形式主义）：

- 没有 token 不许开启：`ws-server` 里空 token 是「不校验」，等于本机任何进程都能接管机器人
- `PUT` 清 token 时自动关监听；`bridge.start()` 再独立检查一次 token，防手改配置绕过面板

**一个差点漏掉的持久化 bug**：`saveBotConfig` 是白名单式写盘（只写它列出来的键），
没加 `onebot` 就变成「面板显示保存成功、重启全丢」——token 和 selfUin 都会没，
现象很像「兼容模式自己坏了」。已把 `onebot` 加进写盘字段，并验证「保存 → 重启 → 自动监听 6700」。

**连接串一键复制**：运行状态下把两条**干净地址**摆出来，各带一个「复制」——
`ws://host:port/` 与 `http://host:port`。

**地址里不放 token**（2026-11-12 主人指正）。理由不是洁癖：
地址会被截屏、被粘到群里、被反代日志记下来；而客户端（aurobot / NoneBot）
本来就有独立的「令牌」输入框。令牌放在输入框里点「复制」，泄漏面小得多。

为什么还是要给完整地址：客户端 `new WebSocket(url)` **不会自动补 `ws://`**，
用户填 `127.0.0.1:6707` 会直接抛 URL 解析错误，报错是「没连上 QQ 网关」——
和「token 不对」的 401 长得完全不一样，但用户看到的都是「连不上」。
给一条带 scheme 的地址，这一类错就不用猜了。

### 发版前独立审查（2026-11-12）与修正

用子智能体只读审了一遍新代码，报出 5 个 P1 + 5 个 P2。已全部修：

| 级别 | 问题 | 修法 |
|---|---|---|
| P1 | `deepMerge` 共享默认值对象 → **A 鸟填的 token 被写进 B 鸟** | `cloneDeep` 复制默认值；新增 `test/onebot-config.mjs` 守这条 |
| P1 | 装 `silk-wasm` 会把已装的 `ws` 删掉（npm 7+ 按清单 prune） | 安装前读旧 `dependencies` 合并，只保留白名单键 |
| P1 | 连点「保存」两次 → 两个监听叠加、端口漂移、心跳泄漏 | `start/stop/reconfigure` 全部串行化（promise 链） |
| P1 | 独占模式跳过 pipeline → **白名单被绕过** | 改成不跳过管线（见下条），白名单/限流/闸照常 |
| P1 | 有客户端在线时 `wss.close()` 要等 30s，面板保存/停机卡住 | 600ms 宽限后 `terminate()` |
| P2 | `get_*_msg_history` 返回裸数组，v11 要 `{messages}` | 包成 `{messages}`；`historyCache=0` 时返回空 |
| P2 | 历史回放把账本 UUID 当官方 msg_id 登记 | `bindMessage(..., {noIndex:true})`：只借号不登记 |
| P2 | `nextId` 只 1s 节流落盘，被 kill 后可能重号 → 误撤别的消息 | 加载时 `nextId = max(落盘值, 当前秒)` |
| P2 | `file:///C:/x` 切前缀后变成 `/C:/x` | 用 `fileURLToPath()` |
| P2 | 反代未开 `trustProxy` 时 `clientIp()` 恒为回环 → 公网也能拿明文 token | 改成只看 `req.socket.remoteAddress` |
| P2 | `voice` / `historyCache` / `unboundPolicy` / `maxConnections` 面板能改但代码不读 | 四个都接上（`voice:'reject'` 强制不发语音、`block` 丢未绑定事件） |

### 独占模式保留内核命令（主人 2026-11-12 要求）

第一版独占是「管线之前直接 return」，结果 **`绑定qq` / `绑定群号` / `绑定成员` 全部失效**——
而这些是内核命令（`pluginId === '__core'`），OneBot 的 ID 映射正要靠绑定表才能给真 QQ 号。
一刀切会死锁：绑不了号 → 客户端里永远是一串 13 位合成号 → 主人权限、群号全对不上。

现在的规则：

- **管线照跑**（去重 / 白名单 / 限流 / 暂停闸都在，顺手补上 P1 的白名单漏洞）
- **命令只放 `__core`**，插件命令静默忽略（不提示「没有这个命令」，客户端已接管）
- **插件监听器整段跳过**；`/help` 里也不列插件（列了点了没反应更困惑）
- 消息上打 `msg.coreOnly` 标记，内核命令可以据此调整行为

实测（mock 注入）：`/绑定qq` → 有回复；`/echo 你好` → 无回复；`/help` → 有回复。
