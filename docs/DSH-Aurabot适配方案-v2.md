# 把 AI 接进 QQ：Aurabot × Roost 方案 v2

> 依据：**Roost v0.7.2**（2026-10-26）的真实代码能力，逐条核对过 `src/`。
> 取代 [v1 方案](./DSH-Aurabot适配方案.md)（那份写在核对官方文档之前，
> 「哪些做不了」的清单是错的）。
>
> **插件已独立成仓**：[tdcq9594/dsh-roost](https://github.com/tdcq9594/dsh-roost)
> （DSH 插件不放在本仓库——主仓库只放框架）。本文第四节的「两个通道」
> 是那个仓库的前置依赖。
>
> 参考对象：[accomplish07zrh-eng/dsh-aurabot-qq](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq) 0.2.0

---

## 零、v2 和 v1 的三个根本区别

| | v1 的假设 | v0.7.2 的事实 |
|---|---|---|
| 官方能力面 | 比 OneBot 窄，得做门面兜住 | **比 OneBot 宽**：markdown、按钮、指令面板、菜单、流式、引用、ARK 卡片、官方 ASR，OneBot 全没有 |
| 语音 | 官方无 ASR，得自己跑识别/转码 | 官方直接给 `asr_refer_text` + `voice_wav_url` |
| 主动消息 | 20 条/天，主动搭话基本废 | **20 条/分钟 + 1000 条/天/群**，够用 |

所以 v1 推荐的「Roost 做 OneBot v11 门面、插件零改动」**现在是最差的一条路**：
它把官方独有的表达能力全扔掉，只为了让 9000 行别人的代码不改。

---

## 一、Aurabot 要的能力，Roost 现在给什么

逐项核对过（左列是 Aurabot 的实际调用，右列是 v0.7.2 的真实实现）：

| Aurabot 需要 | 它原来靠 OneBot | Roost v0.7.2 | 结论 |
|---|---|---|---|
| 收群/私聊消息 | WS 推事件 | `ctx.on('GROUP_AT_MESSAGE_CREATE' / 'C2C_MESSAGE_CREATE')` | ✅ |
| **群里不 @ 的消息** | 个人号默认全收 | `GROUP_MESSAGE_CREATE`（全量模式，需开「接收所有消息」） | ✅ 官方支持，是个开关 |
| 发文字 | `send_group_msg` | `msg.reply()` / `ctx.push()` | ✅ |
| 发图片 | `image` 段 | `msg.replyImage()` / `replyImageBuffer()` | ✅ |
| 发语音 | `record` 段（base64） | `msg.replyVoice()`（`file_type=3`） | ⚠️ 编码要实测 |
| **收语音转文字** | `fetch_ptt_text`（SnowLuma 私有） | **`msg.voices[0].asrText`** | ✅ 官方 ASR，不用自己跑 |
| **语音文件** | `get_record` | **`msg.voices[0].wavUrl`**（官方转好的 WAV） | ✅ 不用转码 |
| **引用回复** | `reply` 段 | **`msg.replyQuote()`**（`message_reference`） | ✅ v0.7.0 新增 |
| **被引用的原文** | 自己去拉 | **`msg.quoted`** | ✅ |
| **合并转发展开** | `get_forward_msg` | **`msg.elements` 里 `type:'chatRecord'`（102）** | ✅ 官方直接给展开后的文本 |
| 卡片消息（B 站/小程序） | `json` 段自己解析 | **`msg.ark`**（`type`/`title`/`desc`/`url`/`fields`） | ✅ 结构化好了 |
| 群成员信息 | `get_group_member_info` | `ctx.api.getGroupMember()` | ⚠️ 内邀（`11253`） |
| 禁言 | `set_group_ban` | `ctx.api.muteMember()` | ✅ 需管理员 |
| 踢人 | `set_group_kick` | `ctx.api.removeMembers()` | ⚠️ 内邀 |
| 群列表 | `get_group_list` | 无此接口，靠 `GROUP_ADD_ROBOT` 被动登记 | ⚠️ 官方就没有 |
| **主动搭话** | 无限制 | `20 条/分钟 + 1000 条/天/群` | ✅ 够用 |
| 戳一戳 | `send_poke` | — | ❌ 官方没有 |
| 表情包库 | `add_custom_face` | — | ❌ 官方没有 |
| QQ 空间 | `qzone_*` 系列 | — | ❌ 官方没有 |

### OneBot 没有、Roost 白给的（这是净增益）

| 能力 | 入口 | 用途 |
|---|---|---|
| Markdown 消息 | `msg.replyMarkdown()` | AI 输出结构化内容 |
| 按钮键盘 | `msg.replyMenu()` / `replyCard()` | AI 给选项，用户点一下就发 |
| **指令面板** | `ctx.api.createPanel()` 等 6 个 | 给用户一个「这机器人会什么」的入口，最多 20 项 |
| 全局菜单 | `ctx.api.setGlobalMenu()` | 单聊底部常驻菜单 |
| 流式消息 | `msg.replyStream()` | 仅单聊，AI 长回答边生成边出 |
| 多轮对话 | `ctx.prompt(msg, text)` | 比 Aurabot 自己维护状态简单 |
| 面板管理页 | `ctx.registerPage()` + **`ctx.registerRoute()`** | AI 的配置/记忆可以有自己的页面和接口 |
| 持久化 | `ctx.storage` / `ctx.state` / `node:sqlite` | 记忆库有地方放 |

---

## 二、三条路线重估

### ❌ A. Roost 做 OneBot v11 门面（v1 推荐，现在否掉）

为了让 Aurabot 零改动，把 Roost 伪装成 SnowLuma。

**否决理由**：OneBot v11 的词汇表里没有 markdown / 按钮 / 指令面板 / 菜单 / 流式 /
引用（REFIDX）/ ARK / 官方 ASR。做门面等于**主动阉割**上面那张「净增益」表。
换来的只是「不用改别人代码」——而那份代码本来就要改（ID 是数字、语音走 base64、
群成员假设可查，全是 OneBot 特有假设）。

### ⚠️ B. 在 Aurabot 里换掉 `onebot/client.js`

保留 9000 行，只换传输层。

**问题**：要改 `client.js`(390) + `inbound.js`(183) + `hub.js` 发送段 + 21 处
`Number(id)`，而且这插件还在 0.2.0 快速迭代，以后每次升级都要重新合。
投入不比 C 小，产出只服务一个插件。

### ✅ C. 新写 Roost 侧实现，只借 Aurabot 的业务设计（推荐）

**借什么**：人格注入、记忆检索（BM25 + 遗忘曲线）、群聊分段回复策略、心情模型、
主动搭话节奏 —— 这些是**纯业务逻辑，跟传输层无关**，可以照搬设计甚至搬代码。

**不借什么**：传输层、ID 模型、模块内核（Roost 自己有插件系统）。

---

## 三、推荐架构

```
QQ 官方
   │  WebSocket / Webhook
   ▼
┌──────────────────────────────────────────────┐
│ Roost（常驻进程，v0.7.2）                      │
│  · 网关 / 凭证刷新 / 断线 Resume               │
│  · 消息规范化（attachments / ark / elements）   │
│  · 出站调度（5 分钟窗口 / 5 次上限 / 20+1000）   │
│  · 47 个官方接口全封装                          │
│  · 插件系统（JS 内建 / 任意语言子进程）           │
└──────────────────────────────────────────────┘
   │  ① 事件下行（SSE）      ② 能力上行（REST）
   ▼                          ▲
┌──────────────────────────────────────────────┐
│ DSH 插件（跑在 DSH 进程里）                     │
│  · 人格 / 记忆 / 群聊策略 / 心情（借 Aurabot 设计）│
│  · 把 Roost 能力注册成 AI 工具                   │
└──────────────────────────────────────────────┘
   ▼
DSH AI（DeepSeek）
```

**为什么还是「DSH 插件 + Roost 常驻」两段**：DSH 一关机器人就掉线，常驻服务不能塞进
编辑器进程。这点 v1 判断是对的，沿用。

---

## 四、要补的两个通道（Roost 侧工作量）

现在 Roost 面板 API 的能力缺口：

| 缺口 | 现状 | 要补什么 |
|---|---|---|
| **消息事件不出进程** | `/api/stream` 只推 `log` 和 `status` | 加 `event: message`，把规范化后的 Message 序列化推给订阅者 |
| **发送只支持纯文本** | `/api/send` 只吃 `{scene,target,content}` | 换成能力通道（见下） |

### 通道 ①：事件下行

在 `src/web/server.js` 的 SSE 广播里加一路：

```js
// 每个 bot 的消息都推给订阅者（只推规范化后的字段，不含 raw 全量）
sseEmit('message', {
  botId, kind, groupId, userId, userName, chatId,
  content, mentioned, addressed, isCommand,
  msgId: msg.id, msgIdx: msg.msgIdx, refMsgIdx: msg.refMsgIdx,
  quoted: msg.quoted,
  attachments: msg.attachments,     // 含 asrText / wavUrl
  ark: msg.ark,
  elements: msg.elements,           // 含 chatRecord
  at: msg.at,
})
```

DSH 侧用 `EventSource` 订阅，按 `chatId` 分派给不同会话。

### 通道 ②：能力上行（这是「让 AI 调全部官方功能」的关键）

不要为 47 个接口各写一个 REST 路由（维护不动）。做**一个通用调用 + 一份能力清单**：

```
POST /api/qq/call
{ "bot": "main", "method": "sendGroup", "args": { ... } }
```

- `method` 必须在**白名单**里（就是 `src/endpoints.js` 的 47 条对应的 api 方法名）
- 参数原样透传给 `QQApi`，不在这里做字段裁剪（官方以后加字段不用改）
- 返回原始 JSON
- 风险分级：`read` / `write` / `danger`，`danger` 要求带 `confirm: true`

配套一个只读接口：

```
GET /api/qq/capabilities   →  src/endpoints.js 的 OFFICIAL_ENDPOINTS + 风险等级
```

DSH 侧把这份清单做成工具说明书，AI 就知道「官方还有什么能调」。

**这一条做完，「AI 能调用官方接口的全部功能」就是字面意义上的成立**，
而且以后官方加接口，只要在 `endpoints.js` 加一行，AI 立刻能用。

---

## 五、DSH 侧的工具分层

| 层 | 内容 | 数量 | 说明 |
|---|---|---|---|
| **L1 专用工具** | 发消息（自动选 text/markdown/按钮/富媒体/引用）、撤回、禁言、审批、面板、菜单、群信息 | ~10 | AI 天天用，参数组合复杂，不该让它自己拼 |
| **L2 通用工具** | `qq_api(method, args)` | 1 | 覆盖剩下全部，兜底 |
| **L3 说明书** | `qq_api_help(keyword?)` | 1 | AI 按需查，不占上下文 |

**不要把 47 个都做成独立工具**——AI 选不过来，我们也维护不动。

---

## 六、Aurabot 12 个模块的去留

| 模块 | 处理 | 说明 |
|---|---|---|
| 人格 / 提示词 | **留** | 纯文本，跟传输无关 |
| 记忆（BM25 + 遗忘曲线） | **留** | 算法可搬，存储换 `ctx.storage` |
| 心情 | **留** | 纯业务 |
| 群聊策略（分段回复、插话） | **留** | 但要确认全量群消息开关 |
| 主动搭话 | **留** | 额度够用（20/分钟 + 1000/天） |
| 语音 | **重写** | 用官方 `asrText` / `wavUrl`，去掉 edge-tts 的 ASR 部分 |
| 生图 | **留** | 跟传输无关 |
| 翻唱 | **留** | 产出音频走 `replyVoice` |
| 群管 | **重写** | 禁言可用，踢人内邀，成员列表内邀 |
| 表情包 | **砍** | 官方无自定义表情库 |
| QQ 空间（日记 + 互动） | **砍** | 官方完全没有 |
| 模块内核 `core/modules.js` | **砍** | Roost 有自己的插件系统 |
| SnowLuma 管理（394 行） | **砍** | 换 Roost 后整块不需要，顺带甩掉 EULA 合规包袱 |

---

## 七、分期

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **P0 探针** | 真机验三件事：语音编码、全量群消息开关、`msg_seq` 5 次上限的真实表现 | 三条都有明确结论 |
| **P1 通道** | Roost 加 SSE `message` 事件 + `/api/qq/call` + `/api/qq/capabilities` | DSH 侧能收到消息、能发文字 |
| **P2 骨架** | DSH 插件：会话映射（chatId → DSH 会话）、人格注入、L1 工具 | 群里 @ 一下能回，能发图 |
| **P3 记忆** | 搬 Aurabot 的 BM25 + 遗忘曲线，落 `ctx.storage` | 能记住上次聊的事 |
| **P4 群聊体验** | 分段回复、引用回复（`replyQuote`）、全量群消息插话 | 群里像个人 |
| **P5 增量能力** | 指令面板（让 AI 自己维护「我会什么」）、按钮、流式 | 用上 OneBot 给不了的东西 |

---

## 八、必须先验的三件事

1. **语音编码**：官方 `file_type=3` 收不收 TTS 产出的 mp3/wav。不兼容就得在 Roost 里加
   silk 转码，会破坏「零依赖」原则。
2. **全量群消息开关**：开放平台「接收所有消息」开了之后，`GROUP_MESSAGE_CREATE` 是否
   真能覆盖群内全部消息、有没有频率/条数限制。
3. **群成员内邀**：`getGroupMembers` 默认 `11253`。不申请白名单的话，
   「群管」和「按人设区分关系」都要降级。

---

## 九、和 v1 的差异汇总

| 项 | v1 | v2 |
|---|---|---|
| 主推方案 | OneBot 门面 | 原生能力通道 |
| 插件改动 | 0 行 | 重写传输层（但只借业务设计） |
| 语音 ASR | 自己跑 | 官方给 |
| 合并转发 | 判定为「官方没有」 | 官方有（`elements` 102） |
| 主动消息 | 20 条/天，主动搭话废 | 20/分钟 + 1000/天，够用 |
| ID 映射表 | 必需（openid ↔ 数字） | **不需要**（不迁就 OneBot 的数字假设） |
| 额外收益 | 无 | markdown / 按钮 / 指令面板 / 流式 / 引用 |
