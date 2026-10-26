# 把 Aurabot 的 SnowLuma 换成 Roost —— 适配方案

> 参考对象：[accomplish07zrh-eng/dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq) 0.2.0
> （约 9000 行 JS + 1893 行面板，12 个功能模块）
>
> 本文只做**理解与方案**，不含代码改动。

---

## 一、先说结论

这不是「换个地址」，是**换协议族**：

```
现在：QQ个人号 ← SnowLuma(OneBot v11) ← Aurabot 插件 ← DSH
目标：QQ官方机器人 ← Roost(开放平台 v2) ← 适配层 ← Aurabot 插件 ← DSH
```

SnowLuma 走的是**个人号 + OneBot v11**（hook 本机 QQ 客户端），能力面宽、几乎无限制，
代价是违反 QQ 协议、有封号风险、必须挂着 QQ 客户端。

Roost 走的是**QQ 开放平台官方接口 v2**（AppID/AppSecret → WebSocket 网关），
合规、稳定、能群管，代价是**场景和能力被平台硬限制**。

所以差距分三层，只有前两层能抹平：

| 层 | 能不能抹平 | 说明 |
|---|---|---|
| ① 传输与寻址 | ✅ 完全能 | 事件推送、HTTP 接口、鉴权、ID 类型 |
| ② 消息模型 | ⚠️ 大部分能 | 段数组 → content + attachments，有损耗 |
| ③ 能力 | ❌ 抹不平 | 空间、表情包、戳一戳、全量群消息…官方根本没这些 |

**一句话：文字/图片/语音/引用/禁言的对话能做；QQ 空间、表情包、戳一戳、群里免@插话做不了。**

---

## 二、第一层：传输与寻址（可完全抹平）

| | SnowLuma / OneBot v11 | Roost / 官方 v2 |
|---|---|---|
| 收事件 | WS 推 `{post_type:'message',...}` | WS `op=0` 推 `{t:'GROUP_AT_MESSAGE_CREATE', d:{...}}` |
| 发群消息 | `POST /send_group_msg` | `POST /v2/groups/{group_openid}/messages` |
| 发私聊 | `POST /send_private_msg` | `POST /v2/users/{openid}/messages` |
| 鉴权 | `Authorization: Bearer <token>` | `Authorization: QQBot <access_token>`，2 小时刷新 |
| 用户 ID | QQ 号（数字，可读） | `openid`（字符串，**每个机器人下都不一样，且不可读**） |
| 群 ID | 群号（数字） | `group_openid`（字符串） |
| 消息 ID | `message_id`（数字） | `msg_id`（字符串） |
| 富媒体 | 段里直接塞 `base64://` 或 URL | 必须先 `uploadMedia` 拿 `file_info`，再 `msg_type=7` 发 |

### 这里有个必须解决的分水岭

插件里 **21 处**把 ID 当数字用：

```js
// src/chat/hub.js:323
const params = tgt.kind === 'group'
  ? { group_id: Number(tgt.id), message }
  : { user_id: Number(tgt.id), message }

// src/chat/hub.js:369
await onebot.call('send_poke', { user_id: Number(target), ... })

// src/chat/group-roles.js:11
{ group_id: Number(gid), user_id: Number(getConfig().botQQ) }
```

openid 是 `"EC58A3F0..."` 这种字符串，`Number()` 一转就是 `NaN`。
**只要不做映射，插件就是全盘崩，不是降级。**

所以适配层必须维护一张持久化的 **`openid` ↔ 自增数字 ID** 映射表
（`data/bridge/idmap.json`），对外一律用数字，对内翻译回 openid。
这是「插件零改动」能不能成立的关键。

---

## 三、第二层：消息模型（可翻译，有损耗）

OneBot 是**段数组**，官方是 **content 纯文本 + attachments 数组 + msg_type**。

### 收消息（官方 → OneBot 段）

| 官方 | 翻译成 OneBot |
|---|---|
| `content` 纯文本 | `{type:'text'}` |
| `content` 里的 `<@openid>` | `{type:'at', data:{qq:映射后的数字}}` |
| `attachments[]`（`content_type: image/*`） | `{type:'image', data:{url}}` |
| `attachments[]`（voice） | `{type:'record'}` |
| `d.id` | `message_id` |

### 发消息（OneBot 段 → 官方）

| OneBot 段 | 官方做法 | 损耗 |
|---|---|---|
| `text` | `content` | 无 |
| `at` | 写进 `content` 的 `<@openid>` | 无 |
| `reply` | `msg_id` + `msg_seq` 递增 | ⚠️ **只认 5 分钟被动窗口内的 msg_id** |
| `image` | 先 `uploadMedia(file_type=1)` → `msg_type=7` | 多一次上传，富媒体独立限频 |
| `record`（base64） | `uploadMedia(file_type=3)` → `msg_type=7` | ⚠️ 编码格式待实测 |
| `mface` / 自定义表情 | **官方没有** | ❌ 丢弃 |
| `forward`（合并转发） | **官方没有** | ❌ 丢弃 |

> **引用回复那个坑最要命**：插件在群里是「攒一段再回」，回的往往是几分钟前那条。
> 超过 5 分钟官方不认 `msg_id`，适配层必须自动降级成主动消息——
> 而主动消息有 20 条/天的硬额度（见下）。

---

## 四、第三层：能力差距（抹不平的部分）

按插件实际的 12 个模块逐个体检：

| 插件功能 | 依赖的 OneBot action | Roost 现状 | 结论 |
|---|---|---|---|
| 收发文字 | `send_group_msg` / `send_private_msg` | ✅ 已封装 | **能用** |
| 收发图片 | `image` 段 | ✅ `uploadMedia` | **能用** |
| 引用回复 | `reply` 段 | ✅ `msgId`+`msgSeq` | ⚠️ 仅 5 分钟内 |
| 语音条 | `record` 段 | ✅ `file_type=3` | ⚠️ 需权限，格式待验 |
| 群禁言 | `set_group_ban` | ✅ `restrict_chat_setting` | **能用**（需管理员） |
| 收语音转文字 | `fetch_ptt_text` / `get_record` | ❌ 官方无 | 改本地 ASR |
| 表情包（收/发/偷） | `mface` / `add_custom_face` / `modify_custom_face` | ❌ 官方无自定义表情库 | **砍** |
| 戳一戳 | `send_poke` | ❌ 官方无 | **砍** |
| 群成员信息 | `get_group_member_info` | ⚠️ 内邀接口（`11253`） | 默认不可用 |
| 群踢人 | `set_group_kick` | ⚠️ 内邀接口 | 默认不可用 |
| **QQ 空间全套**（写日记/看评论/点赞/回评） | `send_qzone_msg` / `get_qzone_*` / `like_qzone` / `comment_qzone` | ❌ 官方完全没有 | **整块砍** |
| 合并转发展开 | `get_forward_msg` | ❌ 官方无 | **砍** |
| 历史消息 | `get_group_msg_history` / `get_friend_msg_history` | ❌ 官方无 | **砍**（影响"她记得上一段"） |
| **主动搭话** | 无限制 | ⚠️ **每会话每天 20 条** + 需审核 | **大幅降级** |
| **群里免@插话** | 全量群消息 | ⚠️ 默认只推 @ 消息 | **基本失效** |
| 改头像 / 群头衔 / "正在输入" | `set_qq_avatar` / `set_group_special_title` / `set_input_status` | ❌ 官方无 | **砍** |
| 好友/陌生人信息 | `get_stranger_info` | ❌ 只有 openid | **砍** |
| 主人身份识别 | 填「你的 QQ 号」 | ❌ 只有 openid，且每机器人不同 | 改成 openid 白名单 |

**最伤的三刀**：QQ 空间、表情包、主动搭话额度。
插件 README 里当卖点写的「逛空间回评论」「发表情包」「主动找你聊天」，在官方通道上基本立不住。

---

## 五、三个方案

### 方案 A：Roost 做 OneBot v11 门面（推荐）

```
QQ官方 → Roost（网关/凭证/重连/限频/被动窗口/msg_seq 全都它管）
           ↓ 内部事件
        OneBot 门面（新增）
           ↓ WS 推 OneBot 事件   ↑ HTTP 收 OneBot action
        Aurabot 插件（0 行改动，只改配置）
```

门面干三件事：

1. **事件翻译**：官方 `{t, d}` → OneBot `{post_type:'message', message_type, user_id, group_id, message:[...]}`
2. **接口翻译**：`/send_group_msg` 的段数组 → `content` + `uploadMedia` + `msgId`
3. **ID 映射**：openid ↔ 数字，落盘持久化

**插件侧只改配置**（`cfg.snowluma` 本来就支持手填，跳过自动发现）：

```yaml
snowluma:
  httpUrl: http://127.0.0.1:5700
  wsUrl: ws://127.0.0.1:5701
  httpToken: <门面生成的 token>
  autoStart: false     # 不再拉起 SnowLuma
  autoAttach: false    # 不再注入 QQ 进程
```

不支持的 action 返回标准失败体，插件的 `OneBotError` 会接住并降级，不会崩：

```json
{ "status": "failed", "retcode": 1404, "wording": "官方接口不支持：send_poke" }
```

| | |
|---|---|
| Roost 侧工作量 | 新增 ~800–1200 行（`src/bridge/`） |
| 插件侧工作量 | **0 行代码** + 面板「连接」页文案 |
| 额外收益 | **任何 OneBot v11 客户端都能接 Roost**——NoneBot / Koishi / AstrBot 全部通吃，对框架是硬卖点 |
| 代价 | 门面要长期维护协议翻译；官方限制照样在，功能照样降级 |

### 方案 B：插件内换客户端（原生对接）

Roost 加 SSE 推消息事件 + 扩 `/api/send` 支持 media/msgId，插件写 `src/roost/client.js` 替掉 `onebot/client.js`。

| | |
|---|---|
| Roost 侧 | ~200 行（扩 `/api/stream`、`/api/send`） |
| 插件侧 | ~600–900 行（改 client、inbound、hub 发送、21 处 `Number`） |
| 优点 | 没有映射表，语义干净 |
| 缺点 | **动插件核心**。这插件还在 0.2.0 快速迭代，改核心等于以后每次升级都要重新合；且只服务这一个插件，别人用不上 |

### 方案 C：双轨并行

Roost 管群/私聊对话（合规），SnowLuma 留着跑空间/表情/戳一戳，插件按能力路由。

| | |
|---|---|
| 优点 | 功能全保 |
| 缺点 | 复杂度翻倍；**个人号还在挂着，封号风险一点没解决**——等于没回答"为什么要换" |

---

## 六、推荐路线：A 打底，C 兜底

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **0. 能力体检** | 逐条真机验证第三节的 ⚠️ 项（语音编码、msg_id 窗口、@ 消息推送范围） | 产出一份「确定能做 / 确定不能做」清单 |
| **1. 门面 MVP** | 只做 `send_group_msg` / `send_private_msg` / `get_login_info` + 事件推送 + ID 映射 | 文字对话闭环跑通 |
| **2. 补齐** | 图片、语音、引用回复、禁言 | 12 个模块里能用的都用上 |
| **3. 降级** | 不支持的 action 返回明确错误；插件里 stickers / qzone / poke / group-admin 默认关 | 不崩、不刷错误日志 |
| **4. 面板** | 「连接」页从 SnowLuma 换成 Roost | 用户不用碰配置文件 |
| **5. 可选** | 保留 SnowLuma 作为"扩展能力后端"，只跑空间/表情 | 双轨兜底 |

---

## 七、必须先拍板的三件事

### 1. 群里免@消息到底推不推？

Roost 自己的 `docs/官方接口限制.md` 有实测记录：

> 默认配置下网关只下发 `GROUP_AT_MESSAGE_CREATE`，不带 @ 的消息**平台根本不推**，
> 日志里连事件都没有。

如果拿不到全量群消息：
- 插件的「按话题相关度插话」「群里攒一段再回」**直接失效**
- 只能退化成「@ 一次回一次」，那这个插件最大的卖点（像个人住在群里）就没了

**这条决定方案值不值得做。** 建议阶段 0 第一件事就是验它。

### 2. 语音编码

官方 `file_type=3` 要求的编码格式，跟插件 TTS 产出的 mp3/wav 是否兼容，要实测。
不兼容就得在门面里加 silk 转码——而 Roost 的「零依赖」原则会被打破。

### 3. 主动消息 20 条/天

插件的「主动搭话」「空间日记」全靠主动推送。官方每会话每天 20 条，且需审核。

Roost 文档里提到一个官方口子：流式接口的 `is_wakeup=true` **不校验 msg_id 有效期**，
可以拿来做主动召回——但**仅限单聊**。群里的主动消息没这个口子。

---

## 八、几个容易漏的点

- **抢消息**：Roost 有自己的插件系统，消息是「有插件回应就算消费」。门面必须有**独占模式**开关，否则 Roost 里的对话插件会和 DSH 抢同一条消息。
- **一个机器人一个身份**：不能像 SnowLuma 那样多开小号。要在 QQ 开放平台重新注册一个机器人当「大肥鱼」，群聊能力还得申请开通。
- **openid 不稳定**：同一个用户在不同机器人下的 openid 不同；换机器人 = 所有记忆里的人都要重新对号。插件的记忆库按 userId 索引，迁移时要重建映射。
- **面板 28 处 `snowluma` 引用**：`client/client.js` 1893 行里有 28 处，都是「检测/启动/注入/协议同意」那套。「连接」页要整块换，不能只改配置。
- **不要动 `snowluma/manager.js` 就以为完事**：`host.js` 的启动流程（296–310 行）会调 `snowluma.start()` / `attachBot()`，得一起摘掉。

---

## 九、许可与合规提醒

Aurabot 是 MIT。但要注意：它本身**不下载、不代同意 SnowLuma 协议**（SnowLuma EULA 5.4 禁止自动化部署），
这套设计在换成 Roost 之后正好可以整体删掉——Roost 走的是官方接口，不存在这个合规问题，
**这是换 Roost 最实在的收益**。

---

## 附：验证到哪一步

| 环节 | 状态 |
|---|---|
| 插件调用面（全部 OneBot action） | ✅ 已全量抓取（31 个） |
| 插件 ID 数字假设 | ✅ 已定位 21 处 |
| Roost 事件/接口清单 | ✅ 已核对（43 事件 / 72 接口，实现 9+20 个） |
| Roost 面板 `/api/send` 能力 | ✅ 已读源码：**只支持纯文本** `{scene,target,content}` |
| Roost 面板 `/api/stream` | ✅ 已读源码：**只推 log 和 status，没有消息事件** |
| 门面协议翻译细节 | ❌ 未写代码，未实测 |
| 语音编码 / 免@推送 / 主动额度 | ❌ **待真机验证**（阶段 0 的内容） |
