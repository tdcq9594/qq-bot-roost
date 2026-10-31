# AstrBot 对照与优化清单（dsh 分支）

> 本文分三部分：**差距总表**（判断）、**核对结果**（哪些判断经过代码验证）、
> **文件级改动点**（照着改就行）。
>
> 定位：我们 = Roost（QQ 官方传输）+ ai-chat（Roost 侧桥）+ dsh-roost（DSH 侧驱动）。
> 模型、工具、记忆主体都在 DSH 里。AstrBot = 一体化 IM Agent 平台。
>
> **⚠️ 时效（2026-10-31）**：本文写于 2026-10-27，部分结论已被后续改动推翻。带「已过期 / 仍成立」标注的行已复核；**未标注的行按写作时的代码为准，照做前先回代码确认**。最新对照见 `deliverables/同类项目检索与自查-2026-10-31.md`。

---

## 一、差距总表

| 维度 | 我们现状 | AstrBot 做法 | 差距结论 |
|---|---|---|---|
| 模型接入 | 单宿主 DSH，模型在 DSH 里配 | `ProviderType` 5 类 + 多实例 + 默认/按会话路由 + 多家适配器 + 失败重试 | 无「按群切模型/失败切换」机制（属 DSH 侧，非插件） |
| 人格 | `personas/*.md` + `profile.facts` | 命名人格库（`system_prompt` + `begin_dialogs` + 工具/技能白名单）+ 按会话绑定 + 人格文件夹 | 缺 **begin_dialogs（few-shot 开场）**、缺按会话切人格、缺人格级工具白名单 |
| 记忆 | ~~facts ≤20 条~~（现 40 条，在 dsh-roost）；对话历史仅内存、无压缩 | 会话↔对话分离（DB）+ 轮数上限 + **`llm_compress` 摘要** + 平台消息历史 + KB/向量 | dsh 侧已有摘要压缩（`compact.js`）与长期检索；**ai-chat 自己的 `ChatStore` 仍无压缩**，且无 `/new` `/switch` 多对话、历史不落盘 |
| QQ 接入/配置 | 手填 `appId/appSecret`（框架层） | **扫码一键创建** + 自动填 secret + 通用平台注册框架 | 缺扫码建 bot（框架层，P0） |
| 大文件发送 | **已接线**（2026-10-30）：≤5MB 直传，>5MB 走 `uploadLocalFileSharded` 四步分片；超软限仍降级为文件 | >10MB 自动分片（4 并发/重试/日配额 40093002） | 已对齐（分片 3 并发上限、40093001 重试 / 40093002 直抛） |
| 工具/技能 | DSH 工具 + `LOCAL_TOOLS` 权限摘除 | tool manager + skills + subagents | 工具生态更丰富；但 DSH agent 本身强，未必照抄 |
| 多平台 | 仅 QQ 官方 | QQ/微信/钉钉/Telegram 等 | 多平台（看需求，非刚需） |
| 易用性 | `start.bat` + 手改 JSON | WebUI 向导 + 插件市场 + 一键 | 缺首启引导/一键体检 |
| 情绪/主动/睡眠 | 私聊主动（`speakup.js`）；群聊无、无情绪、无睡眠整合 | 据调研用「情感亲密度」当主动性闸门 | 缺情绪状态层、群聊主动、睡眠整合 |

---

## 二、核对结果（2026-10-27 逐条查代码）

三条核心判断都成立，可以直接照做：

| 判断 | 结论 | 证据 |
|---|---|---|
| facts 上限 20 条 | ⚠️ **已过期**（2026-10-31 复核） | `plugins/ai-chat/profile.js` 已删除；facts 迁到 `dsh-roost/src/memory.js`：`FACTS_MAX = 40`、`FACT_MAX = 200` |
| 对话历史只在内存、10 轮 | ✅ **仍成立**（2026-10-31 复核） | `plugins/ai-chat/session.js:9` 默认 `historyLimit = 10`，`index.js:432` 可配；dsh 适配器下 ai-chat 仍维护这份内存历史，摘要压缩由 dsh-roost 的 `compact.js` 另做 |
| 私聊主动、群聊无 | ✅ 属实 | `dsh-roost/src/speakup.js:126` — `send({ scene: 'c2c', ... })` 写死 |
| 人格无 beginDialogs | ✅ 属实 | `dsh-roost/personas/*.md` 只有 `---` 头里的 `name` / `tags` |

**一条重要前提（4.0.0 之后新增的约束）**：

> ai-chat 已经**不直连模型**了（删掉了 openai 适配器、apiKey、baseUrl）。
> 所以**记忆压缩不能靠插件自己调模型**——必须走 DSH 跑一轮摘要，
> 或者让模型在回复里带标记、插件解析执行。别照抄 AstrBot 的
> 「插件内调 LLM 做 compress」，我们没有那条路。

---

## 三、文件级改动点

### P0-1 记忆中期压缩

| 文件 | 改什么 |
|---|---|
| `plugins/ai-chat/session.js` | `ChatStore` 每条记录加 `summary: string`；新增 `needsCompact(chatId, n)` |
| `plugins/ai-chat/index.js` | 发 DSH 前判断：`rounds > N` 就先插一句「把之前的对话压缩成一段摘要」交给 DSH，拿回摘要写进 `summary`，再把 `messages` 换成 `[摘要 + 最近 15% 原文]` |
| `plugins/ai-chat/session.js` | 落盘：`data/bots/<bot>/plugins/ai-chat/history/<chatId>.json`（插件 `ctx.dataDir`），启动时读回 |

**关键点**：压缩用**同一轮 DSH 调用**顺带完成（在 system 里加指令），不额外多一次往返；
摘要长度限制 300 字，避免摘要本身膨胀。

### P0-2 人格增强

| 文件 | 改什么 |
|---|---|
| `dsh-roost/src/personas.js` | frontmatter 增加 `beginDialogs`（字符串数组，每项一句开场白） |
| `dsh-roost/src/host.js`（`mount()` 的 `roost-persona` context） | 把 `beginDialogs` 拼进提示词：「你们之前聊过，你的开场方式类似：……」 |
| `dsh-roost/src/config.js` | `persona.byChat`：`{ "<chatId>": "<人格名>" }`，`personas.resolve(chatId)` 已经按群覆盖，只需补这个键 |
| `dsh-roost/src/permissions.js` | `modeFor` 增加人格级白名单：`persona.tools` 覆盖全局 `permissions` |

### P1-3 会话↔对话分离

| 文件 | 改什么 |
|---|---|
| `dsh-roost/src/sessions.js` | `chatId → sessionId` 改成 `chatId → { current, list: [{id, title, at}] }` |
| `plugins/ai-chat/index.js` | 新增指令 `/new`（开新对话）、`/switch <序号>`（切回旧的） |
| `dsh-roost/src/sessions.js` | 历史落 JSON 文件（零依赖）；**不要一上来就上 SQLite**，需要检索时再换 |

### P1-4 情绪状态层

| 文件 | 改什么 |
|---|---|
| `dsh-roost/src/mood.js`（新，≈200 行） | 三维 `valence / energy / sociability`，每轮按时间差指数衰减回中性 |
| `dsh-roost/data/mood.json` | 持久化，重启不丢 |
| `dsh-roost/src/host.js` | 注册 `roost-mood` context（order 907），把当前情绪写进提示词 |
| `plugins/ai-chat/decide.js` | 情绪低时提高接话门槛（`sociability` 当阈值系数） |

### P1-5 群聊主动

| 文件 | 改什么 |
|---|---|
| `dsh-roost/src/speakup.js` | `scene` 从写死 `c2c` 改成可配 `c2c` / `group`；群聊要带 `target: groupId` |
| `dsh-roost/src/speakup.js` | 限频：20 条/分、1000 条/天（官方硬限制），超了静默跳过 |
| `dsh-roost/src/config.js` | `speakUp.group` 默认 **false**，明确写「默认关」 |

### P2（框架层，另开）

6. ~~大文件分片上传接线（`uploadPrepare/uploadPartFinish` 已有但没接）~~
   —— **2026-10-30 已完成**：`uploadLocalFileSharded` 走官方四步，见 `src/api.js`；
   直传上限 5MB（官方口径），超过自动分片；`replyMedia` 按大小路由。
7. 扫码一键建 bot
8. 多平台抽象

---

## 四、我们领先、别丢的

- **官方表达层**：按钮 / Markdown / 引用 / 合并转发 / 官方 ASR / 语音条
- **传输健壮**：`op6 Resume` 补发、关闭码人话提示、出站限流/去重/白名单/会话粘滞、doctor 体检
- **插件任意语言 + 插件市场**；**多 bot**；**端口租约 / 真机联调**
- **DSH agent 本身**（工具 / 审批 / 会话）很强，不必为「像 AstrBot」而重造

---

## 五、一句话

AstrBot 强在「开箱即用 + 记忆/人格的工程化」；
我们强在「官方接口表达层 + 传输健壮 + DSH 的 agent 能力」。

**优先补记忆压缩与人格 few-shot，其余按需，不要为了对齐而牺牲现有优势。**
