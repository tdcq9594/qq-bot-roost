# QQ号 / 群号 与 openid 对应方案（v7）

> 记忆可能来自任何旧框架（AstrBot / QQ-Agent / 别的），**键长什么样不可预知**。
> 所以不针对具体工具做迁移，只做一件事：从键里认出号码，把同号码的键一起读。
> v6：两个标识都给 AI，号码优先。v7：DSH 侧边栏新增「账号迁移」页。
> 状态：**S0–S6 已落码**（2026-11-04）。账号迁移页除「绑定 / 追加」外，
> 还加了批量追加、群成员入口、昵称候选（只提示不自动绑）、一键改写（合并后删旧键，带备份与回退）。

---

## 前提：绑定完全自愿、非必需

QQ 官方事件只给 `openid`，**不提供 QQ号 / 群号**。本方案不是「把号码弄到手」的办法：框架不会从任何接口、事件、客户端或第三方渠道获取、推算或抓取号码，也不按昵称 / 群名自动匹配。

`identity.json` 里的号码只有两个来源：**用户本人主动提供**（`/绑定QQ` 自助绑定，或本人把号码告知管理员），以及**管理员依据本人提供的号码代为登记**（代绑前应取得本人同意）。

- **不绑定不影响任何功能**：未绑定时消息字段留空、提示词与场景块逐字不变，行为与绑定能力上线前完全一致；本方案所有读取逻辑都按「没绑就退回 openid」设计。
- **不得作为使用条件**：请勿把提供号码设为加群、发言、使用机器人或享受某项功能的前提，也不要替他人报号、代他人确认验证码。
- **仅本地、可撤回、用途限定**：绑定信息只存在本机 `data/identity.json`，可在面板「身份」页随时解绑或停用，不写入事件账本 / 统计库，不上传、不共享、不进日志明文，也只用于「认人认群、找回旧记忆」，不作身份核验、画像、营销等其它用途。
- 日志与面板的显示策略（是否脱敏）另见 §12，不改变上述前提。

---

## 0. 只剩四件事

| # | 做什么 | 在哪 |
|---|---|---|
| 1 | 面板上把「一个 openid」和「一个 QQ号/群号」对上。管理员**只填号码** | roost 面板「身份」 |
| 2 | 绑定后消息带 `uin` / `groupUin`，插件能 `ctx.identity.openidOf('10001')` | roost 框架 |
| 3 | AI 同时看到号码和 openid，**认人认群以号码为准**；读记忆时把同号码的键一起读 | ai-chat + dsh-roost |
| 4 | 从**记忆数据反查**没对上的 openid，一键绑号码；换机器人时给号码追加新 openid | DSH 侧边栏「账号迁移」 |

**不做**：迁移/导入工具、自动匹配、置信度、候选、脱敏、roles/stats 改动。

> 2026-11-04 补充：普通成员的**邮箱验证码自助绑定**已落地（`/绑定QQ <QQ号>` → 验证码发到
> `<QQ号>@qq.com` → `/QQ验证码 <6位数字>`），实现见 `src/mail/bind-commands.js`，SMTP 配置在面板「通知」页。
> 管理员的 `/绑定成员` 保持原样；自助绑定遇到任何已有绑定记录都直接拒绝，不做改绑。

---

## 1. 旧记忆的键长什么样（只影响识别方式，不影响方案）

| 可能来源 | 键的可能形态 | 例子 |
|---|---|---|
| AstrBot 一类 | 会话 id，`平台:消息类型:号码` | `aiocqhttp:GroupMessage:763366431` |
| QQ-Agent 一类 | 群号/QQ号，可能带前缀 | `763366431`、`group_763366431` |
| 本框架原生 | openid | `5559767753895AA8456F848BCC489133` |

这些只是**举例**，不是契约。所以匹配**不能比字符串**，要先从键里把号码抠出来：

```js
function uinFromKey(key) {
  const s = String(key || '').trim();
  if (!s || s.length > 64) return '';
  if (/^[0-9a-f]{32}$/i.test(s)) return '';        // 整串是 openid，不是号码
  const parts = s.split(/[^0-9a-zA-Z]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d{5,12}$/.test(parts[i])) return parts[i];
    if (/^[0-9a-f]{32}$/i.test(parts[i])) return '';  // 段里已是 openid，别往后猜
  }
  return '';
}
```

```
aiocqhttp:GroupMessage:763366431 → 763366431   ✓
group_763366431                  → 763366431   ✓
763366431                        → 763366431   ✓
5559767753895AA8456F848BCC489133 → ''（openid，跳过）✓
```

最后一行是必须的：openid 里那串 `5559767753895` 有 13 位数字，不排除会被误当成群号。

---

## 2. 为什么这样就能「对上」

读一个群会话时，把所有「号码相同」的键一起读：

```
当前 chatId = 5559…（新机器人的群 openid）
  号码 = 763366431（来自绑定表）
  候选键 = 所有 uinFromKey(k) === '763366431' 的键
         = ['763366431', 'aiocqhttp:GroupMessage:763366431', '旧 bot 的 openid']
  合并去重 → 注入给 AI
```

索引在加载时建一次（`号码 → [键…]`），读的时候 O(1)。

**换机器人不用重迁**：新 bot 的 openid 绑到同一个群号 → 号码不变 → 旧键照样被扫到。

---

## 3. 两个必须分开的东西

群别名和人别名**不能混**，否则群会话会读到私聊记忆：

```
群会话 chatId = group_openid → 别名只取「群号 + 同群号的其他 group_openid」
私聊 chatId  = user_openid  → 别名只取「QQ号 + 同 QQ号的其他 user_openid」
```

所以消息上给两个字段，不是一个：

```
msg.groupAliases = ['763366431', 'aiocqhttp:GroupMessage:763366431', '旧 group_openid']
msg.userAliases  = ['10001', 'aiocqhttp:FriendMessage:10001', '旧 user_openid']
```

ai-chat 按 `kind` 二选一传给 dsh-roost。

---

## 4. 数据模型

`data/identity.json`，HOME 级，跨机器人一份：

```jsonc
{
  "version": 7,
  "updatedAt": 1793500000000,
  "users": {
    "10001": {
      "uin": "10001",
      "status": "active",              // active | disabled
      "name": "倦飞之鸟",
      "note": "",
      "claims": [
        { "botId": "main", "openid": "CBF1E6B3B90D3ACD7DEBC5A9F2FC7BB5",
          "state": "active", "firstSeenAt": 1793400000000, "lastSeenAt": 1793500000000 }
      ]
    }
  },
  "groups": {
    "763366431": {
      "groupUin": "763366431",
      "status": "active",
      "name": "栖·开发群",
      "note": "",
      "claims": [
        { "botId": "main", "openid": "5559767753895AA8456F848BCC489133", "state": "active" }
      ]
    }
  }
}
```

- claims 是数组：一个号码在 N 个机器人下有 N 个 openid。
- **botId 允许空串**：旧机器人已从配置删掉时，账号迁移页绑出来的 claim 记 `botId: ''`。
  别名计算**不看 botId**，所以照样能读到旧记忆；只有 `uinOf(openid)` 反查会退化成全表扫描。
- 未绑定不落盘，查询返回 `bound:false`。

---

## 5. roost 面板「身份」

**导航位置：`概览 / 数据 / 设置 / 插件 / 身份 / 关于`** —— 独立 tab，放在「关于」左边，不进「设置」组。

```
身份  [机器人: main ▾]
├─ 已绑定 (12)   QQ号 | 备注名 | main 的 openid | 其他机器人 | 解绑
└─ 未识别 (5)    昵称 | openid | 最后活跃 | 消息数 | 所在群 | 最近 3 条发言 | [绑定]
```

点「绑定」只弹一个输入框：**QQ号/群号**。openid 不用填——它就是这一行。数字完整显示，不脱敏。

数据源：昵称/最近发言来自 `events.db`，活跃/消息数/所在群来自 `stats.db`，群列表来自 `groups.json`。
取不到就留空，不报错（`node:sqlite` 不可用时整列留空）。

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/identity?bot=main` | 列表（已绑定 + 未识别） |
| GET | `/api/identity/resolve?openid=…&bot=main` | **openid → 号码** |
| GET | `/api/identity/resolve?uin=10001&kind=user&bot=main` | **号码 → openid** |
| POST | `/api/identity/resolve` | 批量，见 §8.2 |
| POST | `/api/identity/bind` | 绑定 |
| POST | `/api/identity/unbind` | 解绑 |

同一 openid 绑到第二个号码 → 409 +「已绑给 10002，是否改绑」，`force` 才动。

---

## 6. 给 AI 的标识：两个都给，号码优先

### 6.1 每条群消息的说话人标签（`dsh-roost/src/inbound.js` 的 `speakerTag`）

```
绑定后：  [倦飞之鸟 (QQ 10001 / CBF1E6B3B90D3ACD7DEBC5A9F2FC7BB5)] 今晚开团吗
未绑定：  [倦飞之鸟 (CBF1E6B3B90D3ACD7DEBC5A9F2FC7BB5)] 今晚开团吗
```

- **号码在前**：模型先看到稳定的那个。
- **openid 必须完整保留**：群聊 @ 人只认 `<qqbot-at-user id="member_openid" />`。
- 未绑定时与现在完全一致，不多一个字符。

### 6.2 场景块（`dsh-roost/src/host.js` 的 `sceneText`）

```
群聊：你现在在 QQ 群「栖·开发群」里说话（群号 763366431，openid 5559…）。
      刚说话的是「倦飞之鸟」（QQ 10001）。
私聊：你现在在和「倦飞之鸟」私聊（QQ 10001，openid CBF1…）。
```

群名、号码、openid 各自独立，缺哪个省哪项，不写「未知」。

### 6.3 提示词里的硬规则（`memoryStatic` 的 `rules`，每轮注入）

```
认人认群以号码为准（QQ 10001 / 群 763366431）；openid 是发消息用的临时凭据，换机器人就变。
记人记群、写记忆、判断"是不是同一个人"都用号码；只有 @ 人时才用 openid。
```

**这条是效果的关键。** 不给这句，模型会随便挑一个，甚至把 openid 写进记忆。

### 6.4 为什么两个都留

| 用途 | 只能用 |
|---|---|
| @ 人、发消息、禁言、踢人 | **openid** |
| 认人、认群、写记忆、判断同一个人 | **号码** |

openid 不是"该淘汰的旧东西"，它是运行时凭据。

### 6.5 未绑定时不降级

没有号码就退回 openid，行为和现在完全一样。不报错、不留空、不写「未绑定」。

---

## 7. DSH 侧边栏「账号迁移」页

### 7.1 为什么还要这一页

roost 面板的「未识别」列表只能看到**最近发过言**的人。旧记忆里那些早就没动静的 openid
（换了机器人、群解散了、人退了）永远不会出现在那里——但它们的记忆还在库里躺着。

这一页反过来做：**从记忆数据出发**，把所有没对上的键列出来。

### 7.2 位置

DSH 侧边栏 → Roost 面板 → 新增 tab **「账号迁移」**，放在「会话」之后、「设置」之前。

### 7.3 上半：未对上的会话（一键绑号码）

```
账号迁移   [机器人: main ▾]

未对上 (3)                          记忆   日记   关系   类型        号码
CBF1E6B3…  倦飞之鸟                 2 条   37 条   0   私聊        [10001    ] [绑定]
55597677…  QQ · 机器人测试           9 条  421 条  12   群          [         ] [绑定]
9A31C7D0…  （无会话记录）            0 条    3 条   0   未知 ▾      [         ] [绑定]

                                          [全部绑定]（填了号码的才提交）
```

扫描源：

| 来源 | 取什么 |
|---|---|
| `memory.json` | `chats` / `meta.chats` / `personas` / `authz` 的键 → facts 条数 |
| `journal.sqlite` | `SELECT chat_id, COUNT(*) FROM journal GROUP BY chat_id` |
| `graph.sqlite` | `entity` / `episode` / `edge` / `suppress` 按 `chat_id` 计数 |
| `sessions.json` | 键 → `{kind, title}`，用来区分群/人、显示标题 |

规则：

- **只列 `uinFromKey(key) === ''` 的键**（也就是认不出号码的）。键里已有号码的，说明本来就对上了。
- **类型判定**：`sessions.json` 有记录就用它的 `kind`；没有就让用户选（群 / 私聊），**不猜**。
- 已经在 identity 里绑过的，不出现（挪到下半区）。
- 填号码 → 点「绑定」→ 写 `identity.json`。**不碰 memory / journal / graph 一个字节。**
- 「全部绑定」= 把填了号码的行一次提交，逐条调，失败的单独报，不影响成功的。

### 7.4 下半：已绑定的号码（换机器人时追加 openid）

```
已绑定 (12)                          机器人         openid
10001  倦飞之鸟                       main          CBF1E6B3…
                                      jfzn          [从上面选 ▾] [追加]
763366431  栖·开发群                  main          55597677…
```

「追加」的语义是**加一条 claim，不删旧的**。

**这一点必须写死**：v6 的别名机制靠「同一号码的所有 openid」。删掉旧 openid，旧记忆的键就没人引用了，
AI 立刻读不到——看起来像"迁移完记忆没了"。

换机器人时的完整动作：

```
旧：10001 → [{bot: main,  openid: CBF1…}]
新 bot jfzn 上线，同一个人 openid = 9A31…
追加后：10001 → [{bot: main, openid: CBF1…}, {bot: jfzn, openid: 9A31…}]
读取时别名 = ['10001', 'CBF1…', '9A31…'] → 旧记忆全在
```

### 7.5 接口

dsh-roost 新增（走 `setup.js` 已有的 `api()` 封装，自带 baseUrl + accessKey）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/account/scan` | 扫描本机数据，返回键清单 + 是否已绑定 + 条数 |
| GET | `/account/bots` | 代理 roost `/api/bots`，拿机器人列表 |
| POST | `/account/bind` | `{kind, uin, openid, botId}` → 代理 roost `/api/identity/bind` |
| POST | `/account/attach` | 同 bind，语义是「给已有号码追加」；内部同一个调用 |

**「是否已绑定」怎么判断**：扫描出来的键一次打包丢给 roost 的
`POST /api/identity/resolve`（批量，最多 500 条），拿回每个 openid 对应的号码。
不要拉全表再在本地比对——键可能上千个，一次批量查更省事，也不会把别的机器人的人全拉进浏览器。

`/account/scan` 返回：

```json
[{
  "key": "CBF1E6B3B90D3ACD7DEBC5A9F2FC7BB5",
  "short": "CBF1E6B3",
  "kind": "c2c",
  "title": "倦飞之鸟",
  "facts": 2, "journal": 37, "edges": 0,
  "isOpenid": true,
  "uin": "",
  "bound": null
}]
```

### 7.6 依赖与降级

- 依赖 roost 的 `/api/identity/*`。roost 版本旧时这页显示「需要 Roost ≥ x.y.z」，不白屏。
- roost 连不上时，上半区仍能扫（本地数据），只是绑定按钮禁用并说明原因。
- `journal.sqlite` / `graph.sqlite` 打不开时对应列显示「—」，不影响绑定。

---

## 8. 取号码 ↔ openid 的三个入口

### 8.1 插件（`ctx.identity`）

```js
await ctx.identity.openidOf('10001')            // 当前 bot 的 openid，未绑定抛
await ctx.identity.groupOpenidOf('763366431')
ctx.identity.uinOf(openid)                      // '10001' | ''
ctx.identity.groupUinOf(groupOpenid)            // '763366431' | ''
ctx.identity.has('u:10001')                     // boolean，不抛
ctx.identity.resolve('u:10001')                 // 统一入口，接受 u:/g:/原样 openid
ctx.identity.aliasesOf('g:763366431', current)  // 读取旧记忆用的备用键
```

未绑定：

```js
err.code = 'IDENTITY_UNBOUND'
err.message = 'QQ号 10001 还没绑定到机器人「main」，请管理员在面板「身份」页绑定'
```

消息字段（只加不改）：

```
msg.uin / msg.groupUin / msg.identityId / msg.groupIdentityId
msg.groupAliases / msg.userAliases
```

### 8.2 HTTP API（面板 API，走同一个 accessKey）

单条：

```
GET /api/identity/resolve?openid=CBF1E6B3…&bot=main
GET /api/identity/resolve?uin=10001&kind=user&bot=main
```

```json
{ "ok": true, "bound": true, "kind": "user", "uin": "10001",
  "openid": "CBF1E6B3…", "identityId": "u:10001", "name": "倦飞之鸟", "status": "active" }
```

未绑定（查询方向的那一侧留空）：

```json
{ "ok": true, "bound": false, "kind": "user", "uin": "10001", "openid": "" }
{ "ok": true, "bound": false, "kind": "",     "uin": "",      "openid": "CBF1E6B3…" }
```

批量（迁移脚本、账号迁移页用）：

```
POST /api/identity/resolve
{ "bot": "main", "items": [ {"openid":"CBF1…"}, {"kind":"group","uin":"763366431"} ] }
```

```json
{ "ok": true, "items": [ {...}, {...} ] }   // 顺序与入参一致，最多 500 条
```

规则：

- **反查（openid → 号码）**：`kind` 可省，先查 users 再查 groups——openid 是 32 位 hex，人和群不会撞。
- **正查（号码 → openid）**：`kind` **必须带**。同一个数字完全可能既是某个人的 QQ号、又是某个群号，
  省了就只能猜。`?uin=763366431&kind=group` 和 `?uin=763366431&kind=user` 是两次不同的查询。
- `bot` 缺省用第一个机器人；号码查不到当前 bot 的 claim 时，返回其他 bot 的并标 `botId`。
- 查不到就是 `bound:false`，**不 404、不报错**——调用方按布尔处理最省事。
- 只读接口，不需要 `force`，也不写盘。

**群和人在这一层完全对称**，只是 `kind` 不同：

| | 人 | 群 |
|---|---|---|
| 稳定号 | `uin` | `groupUin` |
| 运行时凭据 | `user_openid`（私聊）/ `member_openid`（群内发言，同值） | `group_openid` |
| 内部 id | `u:10001` | `g:763366431` |
| 插件正查 | `openidOf('10001')` | `groupOpenidOf('763366431')` |
| 插件反查 | `uinOf(openid)` | `groupUinOf(groupOpenid)` |
| 消息字段 | `msg.uin` / `msg.userAliases` | `msg.groupUin` / `msg.groupAliases` |
| 未识别列表来源 | `stats.db` + `events.db`（按消息活动） | `groups.json`（持久，不依赖消息） |

一处不对称：**群号可以被解散后重新使用**（新群、旧号），人不会。所以群绑定要能一键解绑重绑，
面板上群那一栏要显示 `addedAt`，让人判断这条绑定是不是上一任群的。

### 8.3 外部插件（NDJSON 子进程协议）

`serializeMessage` 里加三个字段，任何语言的插件都能直接拿到：

```
uin / groupUin / identityId
```

反查（QQ号 → openid）目前协议里没有请求-响应类型，**本次不做**。外部插件要反查就带 `ctx` 里已有的 openid，
或者调 8.2 的 HTTP 接口（需要 accessKey）。

---

## 9. 改动清单

### 9.1 roost 框架

`src/paths.js`（`PATHS.identity`）、`src/identity.js`（新增）、`src/message.js`（补字段）、
`src/bot.js`（加载 + 补字段）、`src/plugin/context.js`（注入 `ctx.identity`）、
`src/plugin/protocol.js`（`serializeMessage` 加 `uin` / `groupUin` / `identityId`）、
`src/web/server.js`（列表 / resolve / 批量 resolve / bind / unbind）、
`web/index.html` + `web/app.js`（身份页）、`test/identity.mjs`。

另需两个**只读**方法（面板「未识别」列表用，现在没有现成的）：

| 文件 | 新增 | 用途 |
|---|---|---|
| `src/storage/index.js` | `StatsStore.userDetail({ userId, limit })` | 最后活跃、消息数、在哪些群 |
| `src/ledger.js` | `Ledger.byUser({ userId, limit })` | 最近 3 条发言原文 |

两者都只读、都失败可降级（`available=false` 时返回空数组）。

### 9.2 ai-chat

`inbound.js` 的 `hostPayload`：

```js
chat:   { kind, chatId, name, groupId, uin, groupUin,
          aliases: msg.kind === 'c2c' ? msg.userAliases : msg.groupAliases },
sender: { id, name, uin },
```

**还有一处容易漏：多人批次的正文。** `merge.js` 现在拼的是
`${name}(${id})：${text}`，而 `batch.multi` 时宿主**不再**贴标签——
所以合并过的那批消息里只有 openid、没有号码。必须一起改：

```js
`${it.name}(QQ ${it.uin} / ${it.id})：${it.text}`   // 有 uin 时
`${it.name}(${it.id})：${it.text}`                 // 没有时保持原样
```

`index.js` 调 `merger.add({...})` 时把 `uin: msg.uin` 带上。

### 9.3 dsh-roost

| 文件 | 改动 |
|---|---|
| `src/inbound.js` | `chatOf` 带 `aliases` / `uin` / `groupUin`；`speakerTag` 输出「号码 / openid」 |
| `src/host.js` | `lastScene` 带别名；`sceneText` 带号码；`memoryStatic` 的 rules 加优先级；`readAgreements` 传别名 |
| `src/memory.js` | `list` / `listRanked` / `listFull` 合并多键 facts，去重 |
| `src/journal.js` | `listChat` / `recent` 的 `chat_id` 改 `IN (...)`（SQLite 与 JSON 两个后端） |
| `src/journal.js` | `search` / `withVec` 也要改：这是 AI **主动检索**的路径，漏了会「问之前聊过啥」搜不到旧记忆。FTS 那条要保住 `OR j.chat_id='' OR j.level='critical'` 的原语义 |
| `src/graph.js` | `nowEdges` / `edgesAsOf` 同上，保留 `OR e.chat_id=''` 的全局边 |
| `src/account.js` | **新增**：scan / bots / bind 三个 handler |
| `src/host.js` | 注册 `/account/*` 三个路由 |
| `client/client.js` | `TABS` 加 `['account','账号迁移']` + 页面组件 |

**写入路径不动**，仍写当前 `chatId`。

### 9.4 一个容易漏的坑：别名键的 facts 会被时间衰减挤掉

`memoryStatic` 平时只取 `chat.slice(0, 3)`，排序是 `w × 0.5^(天数/30)`。
迁移来的旧事实如果 `meta.at` 是当年的时间，衰减后分数极低 → **排不进前 3 → 等于没读到**。

修正：**别名键的 facts 不参与时间衰减**，只按 `w` 排（缺 `w` 按 1）。本键的照旧衰减。

---

## 10. 验收

```
1. roost 面板「身份」：未识别列表出现 CBF1…，填 10001 绑定成功
2. 群消息标签变成 [昵称 (QQ 10001 / CBF1…)]，@ 人仍可用
3. 场景块显示「群号 763366431，openid 5559…」
4. await ctx.identity.openidOf('10001') → 'CBF1…'；'99999' → 抛 IDENTITY_UNBOUND
5. memory.json 里 chats["aiocqhttp:GroupMessage:763366431"] 的旧 facts 被注入（没被 slice 挤掉）
6. 群里读不到该群的私聊记忆（别名不串场）
7. DSH「账号迁移」页列出 3 个未对上键，其中 1 个在 sessions.json 里没有记录 → 类型显示「未知」
8. 给 CBF1… 填 10001 点绑定 → 移到已绑定区，roost「身份」页同步出现
9. 换 jfzn 后给 10001 追加新 openid → claims 里两条都在
10. 追加后旧记忆照样读到（别名含旧 openid）
11. memory.json / journal.sqlite 的键一个字节没变
12. 未绑定时标签/场景与现在一字不差，现有测试全绿
13. `GET /api/identity/resolve?openid=CBF1…` 返回 `{bound:true, uin:"10001"}`
14. `GET /api/identity/resolve?openid=5559…`（群 openid）返回 `{bound:true, kind:"group", uin:"763366431"}`
15. `GET /api/identity/resolve?uin=763366431&kind=group` 返回 group_openid；
    同一号码 `kind=user` 查的是另一个人，两者互不干扰
16. `GET /api/identity/resolve?uin=99999&kind=user` 返回 `{bound:false, openid:""}`，HTTP 200
17. 批量 resolve 500 条 1 秒内返回，顺序与入参一致
18. 外部插件（NDJSON）收到的 msg 里有 `uin` / `groupUin` / `identityId`
```

---

## 11. 检查结论：两轮核对发现的问题（已修）

| # | 问题 | 后果 | 修正 |
|---|---|---|---|
| 1 | 假设记忆键是纯号码 | 带前缀/带会话前缀的键匹配不上，等于没做 | 号码提取 `uinFromKey` |
| 2 | 群别名和人别名混用一个字段 | 群会话读到私聊记忆，串场 | 拆 `groupAliases` / `userAliases` |
| 3 | 别名 facts 参与时间衰减 | 旧记忆排不进 `slice(0,3)`，读到了但看不见 | 别名键不衰减 |
| 4 | 以为要改 `host.js` 很多处 | 实际只需改 `inbound.js` 的 `chatOf` 一处构造 | 落点收敛 |
| 5 | **多人批次只拼 openid** | `batch.multi` 时宿主不贴标签，那批消息里没有号码 | `merge.js` 一起改 |
| 6 | **只改注入、漏了检索** | AI 主动「想起来」时搜不到旧记忆 | `search` / `withVec` 一起改 |
| 7 | **面板要的数据没有现成接口** | 未识别列表只能显示一串 openid，认不出人 | 新增 `StatsStore.userDetail` + `Ledger.byUser` |
| 8 | **旧 bot 删掉后 claim 没有归属** | 旧 openid 绑不上 | `botId` 允许空串，别名计算不看 botId |

**核对过、确认没问题的**：`buildMessage` 只有一个调用点；巩固（`consolidate`）走 `journal.byDay()` 跨会话读写，
不受别名影响；`memory.add` 的写入路径可以完全不动；dsh-roost 与 roost 的连接用 `setup.js` 现成的 `api()`
（自带 baseUrl + accessKey），不用新配。

---

## 12. 仍然存在的边界

| 情况 | 结果 |
|---|---|
| 没绑定 | 一切照旧按 openid 运行，基础功能不受影响；仅「跨机器人找回旧记忆」这类**可选增强**不生效，不是功能缺失（见开头「前提」） |
| 换机器人前没在旧 bot 上绑过 | 旧 openid 的键没有别名，读不到。**账号迁移页可以补这一步** |
| 旧 bot 已从配置里删掉 | 机器人下拉里没有它 → 绑不了。但可以用「未知」类型 + 任意 botId 兜着绑 |
| 人格 / 权限 | **已覆盖**：`getPersonaOverride` / `hasAuthz` 都认别名，旧键下的人设覆盖和 `group_push` 授权换 bot 后照样生效（2026-11-04 修） |
| 数据分两处 | 读取合并，不清理。真要清理用「账号迁移 → 一键改写」（合并到号码键，旧键删除，带备份与回退） |
| 号码敏感 | 面板不脱敏（按你的要求）；日志脱敏；不进 events/stats |
| 群成员 QQ号 | **不在「账号迁移」页的会话键里**。会话键是 chatId（群会话 / 私聊对象），群发言人要用「群里的人」分区，数据来自 Roost 的 `unresolved.users` |
| 换机器人全自动 | **做不到**。QQ 官方事件只给 openid、不给 QQ号，`uin` 是从绑定表反查的。只能按昵称/群名给候选，人工确认 |

---

## 13. 实现顺序

七步。每步都能单独跑测试、单独回滚，不留半截状态。

```
S0 ──► S1 ──► S2
        │
        └──► S3 ──► S4 ──► S5
                             
S2 ──────────────────────► S6
S0 ──────────────────────► S6
```

### S0　identity 内核（roost，纯新增，零风险）

**改**：`src/identity.js`、`test/identity.mjs`

内容：`uinFromKey` / `load` / `resolve` / `openidOf` / `groupOpenidOf` / `uinOf` / `aliasesOf` /
`bind` / `unbind` / `list` / `unclaimed` / 写前重读 + claims 并集。

**验收**
```bash
node --test test/identity.mjs        # 全绿
```
覆盖：`uinFromKey` 五种形态、跨 bot 解析、未绑定抛 `IDENTITY_UNBOUND`、
同 openid 绑两个号码 → 抛冲突、两个进程交替写不丢 claim。

**为什么先做**：纯函数 + 纯新文件，不和任何现有代码耦合，错了也只影响自己。

### S1　消息挂字段（roost，接线）

**改**：`src/paths.js`、`src/message.js`、`src/bot.js`、`src/plugin/context.js`、`src/plugin/protocol.js`

`buildMessage` 只有一个调用点（`bot.js:773`），把 `identity` 传进去，末尾补 6 个字段。
`protocol.js` 的 `serializeMessage` 补 `uin` / `groupUin` / `identityId`——外部插件走这条路，不加就等于「任意语言插件」拿不到稳定 id。

**验收**
```bash
npm test                             # selftest + e2e 全绿
```
- 不建 identity.json 时：所有新字段是 `''` / `[]`，测试数字一条不变。
- 手工写一条 identity，重启：`msg.uin` 有值。

### S2　roost 面板「身份」页

**改**：`src/storage/index.js`（`userDetail`）、`src/ledger.js`（`byUser`）、
`src/web/server.js`（列表 / resolve / 批量 resolve / bind / unbind）、
`web/index.html`（tab）、`web/app.js`（页面）

**验收**
```bash
curl 'http://127.0.0.1:<port>/api/identity?bot=main&key=…'
curl 'http://127.0.0.1:<port>/api/identity/resolve?openid=CBF1…&key=…'
curl -X POST 'http://127.0.0.1:<port>/api/identity/resolve?key=…' \
     -H 'content-type: application/json' \
     -d '{"bot":"main","items":[{"openid":"CBF1…"},{"kind":"group","uin":"763366431"}]}'
```
- 未识别列表带昵称 / 活跃 / 消息数 / 所在群 / 最近 3 条。
- 绑定后列表即时移动；重复绑同一个 openid → 409。
- resolve 查不到返回 200 + `bound:false`，不是 404。
- `stats.db` 不存在时整列留空，页面不白屏。

**可与 S3 并行**（都只依赖 S1）。

### S3　ai-chat 透传

**改**：`inbound.js`（`chat`/`sender` 加字段）、`merge.js`（批量正文加号码）、
`index.js`（`merger.add` 带 `uin`）

**验收**
- 插件测试全绿。
- 抓一次 payload：`chat.uin` / `chat.groupUin` / `chat.aliases` / `sender.uin` 都在。
- 连发三条触发 `batch.multi`，正文每行是 `昵称(QQ 10001 / openid)：…`。

### S4　dsh-roost 注入（AI 看到的）

**改**：`src/inbound.js`（`chatOf` 带别名、`speakerTag` 输出「号码 / openid」）、
`src/host.js`（`lastScene` 带别名、`sceneText` 带号码、`memoryStatic` 的 rules）

**验收**
- 真机发一句，看拼出来的 prompt：
  `[昵称 (QQ 10001 / CBF1…)]` + 场景块「群号 763366431，openid 5559…」。
- 不绑定时 prompt 与改动前**逐字相同**（diff 一下最稳）。
- @ 人仍然可用（openid 没被截断）。

### S5　dsh-roost 读取合并（最关键的一步）

按 **memory → journal → graph** 的顺序改，每改一个跑一次全量。

**改**：`memory.js`（`list`/`listRanked`/`listFull`）、`journal.js`（`listChat`/`recent`/`search`/`withVec`）、
`graph.js`（`nowEdges`/`edgesAsOf`）

**验收**
```bash
npm test                             # 990 条必须全绿
```
- 造数据：`chats["763366431"]` 放 3 条、`chats["5559…"]` 放 1 条，读出来是 4 条。
- 只取前 3 条时，旧的那 3 条**不会被时间衰减挤掉**。
- 群会话读不到私聊记忆（别名不串场）。
- 没有别名时行为与改动前完全一致。

**风险最高**：动的是 990 条测试护着的读取路径。改完必须用子智能体做对抗性验证（造别名交叉、空别名、别名等于主键、journal 两个后端）。

### S6　DSH「账号迁移」页

**改**：`src/account.js`（新增）、`src/host.js`（注册 3 路由）、`client/client.js`（TABS + 页面）

**验收**
- 扫描出未对上的键，条数和 `journal.sqlite` 的 `COUNT(*)` 对得上。
- 绑定后 roost 面板「身份」页同步出现。
- 给号码追加 openid 后，claims 里两条都在（旧的没被删）。
- roost 没启动时：上半区仍能扫，按钮禁用并说明原因。

### S7　回归与收尾

1. 三仓测试：`bot`（selftest + e2e）、`dsh-roost`（990）、`qq-bot-roost-plugins`
2. `node scripts/build-index.mjs --check`（插件目录没动，应无变化）
3. 真机走一遍完整链路：绑定 → 说话 → 看标签 → 换 bot → 追加 → 旧记忆还在
4. 版本号：按规矩末位 +0.01，**先问再 bump**

### 顺序上的三个判断

| 判断 | 理由 |
|---|---|
| S0 先做，且先写测试 | 纯逻辑、零耦合；后面所有步骤都依赖它 |
| S5 放在 S4 之后，不提前 | S4 只改「给 AI 看什么」，可肉眼验收；S5 改的是读取行为，必须有 S4 的别名先跑通才能造数据 |
| S6 最后 | 它只是两个已有能力的组合（本地扫描 + roost API），不引入新语义 |
