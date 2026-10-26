# 官方接口核查报告 & 让 AI 调用全部能力

> 核查对象：QQ 机器人官方文档 `bot.q.qq.com/wiki/develop/api-v2/`
> 核查方式：逐页读 `autogen/api/`（官方自动生成的逐接口参考）+ `autogen/event/` + `changelog.html`
> **不使用三个官方 SDK 仓库**（botgo / botpy / bot-node-sdk）——它们更新滞后，不能作为依据。
>
> 核查日期：2026-10-26

---

## 零、先说三处必须推翻的旧结论

上一版《DSH-Aurabot适配方案》里有三个判断是**错的**，来源是 Roost 自己的 `docs/官方接口限制.md`（那份文档写于 2026-10-23，已经落后于官方）。

| 旧结论 | 官方文档实际写的 | 影响 |
|---|---|---|
| 「主动消息每会话每天 **20 条**」 | 单关系维度 **20/qpm**（每分钟 20 条），每个群 **1 天最多接收 1000 条**；Bot 维度认证 60/qpm、未认证 30/qpm | Roost 的 `quota.json` 按「每天 20 条」记账会**误伤**，主动能力其实宽松得多 |
| 「群里不 @ 的消息平台**根本不推**」 | 有 **`GROUP_MESSAGE_CREATE`（群消息·全量模式）**：*「当机器人开启了"接收所有消息"功能后，群里的每一条消息（不限于@机器人）都会推送此事件」* | **是配置问题，不是接口没给**。群聊插话、攒一段再回，全都能做 |
| 「语音转文字官方无，得改本地 ASR」 | 事件附件里有 **`asr_refer_text`**（语音 ASR 参考结果）+ **`voice_wav_url`**（SILK 转好的 WAV URL） | **官方直接给了 ASR 和转码**，不用自己搞 |

> 结论先行：**我们不是「官方没给」，是「我们没跟上」。** 官方能力面比 Roost 现在封装的大得多。

---

## 一、官方到底给了什么（HTTP 接口全集）

`autogen/api/` 索引页是官方按接口逐个生成的参考，**共 47 个 HTTP 接口**，分 12 组：

| 分组 | 数量 | 接口 |
|---|---|---|
| 消息·单聊 | 3 | 发消息 / **流式发消息** / 撤回 |
| 消息·群 | 2 | 发消息 / 撤回 |
| 消息·富媒体 | 6 | 群上传 / 单聊上传 / **预上传** / **分片上传完成**（各群、单聊一套） |
| 互动·自定义菜单 | 2 | 查询 / 修改全局菜单 |
| 互动·**指令面板** | 6 | 列表 / 创建 / 详情 / 修改 / 删除 / **改关联对象** |
| 互动·互动回调 | 1 | 按钮点击回执 |
| 频道管理 | 6 | 子频道查改删 / 频道详情 / 子频道列表 / 建子频道 |
| 用户·机器人 | 2 | 机器人详情 / 频道列表 |
| 用户·网关 | 1 | 取 WSS 接入点 |
| 用户·**分享链接** | 1 | `POST /v2/generate_url_link` |
| 群信息 | 2 | 群基本信息 / 机器人群内状态 |
| 群成员 | 3 | 列表 / 单个 / 批量移除 |
| 入群申请 | 8 | 列表 / 审批 / **自动审批策略**（增删改查 / 执行 / 白名单） |
| 群黑名单 | 2 | 查询 / 操作 |
| 群禁言 | 2 | 查询状态 / 设置禁言 |

### 其中 Roost 完全没封装的（6 组 15 个）

| 能力 | 接口数 | 说明 |
|---|---|---|
| **指令面板 `/v2/panels`** | 6 | 给用户一个「指令面板」，最多 20 个元素，`command` 或 `link` 类型，可设「仅管理员可点」。**2026-08-12 新增** |
| **分片上传** | 4 | `upload_prepare` + `upload_part_finish`，大文件分片 |
| **生成分享链接** | 1 | `/v2/generate_url_link` |
| 素材管理 | — | **2026-10-21 新增**：图片上传后拿 `qqbot-media://` 引用，可在 Markdown 里用 |
| **`message_reference` 引用回复** | — | 发送体里的独立字段，不是 `msg_id` 被动回复 |
| **`event_id` 被动回复** | — | 支持 `INTERACTION_CREATE` / `GROUP_ADD_ROBOT` / `GROUP_MSG_RECEIVE` 三种事件回复 |

---

## 二、官方到底没给什么（这才是「真没给」）

47 个接口 + 22 个事件，按场景只有三类：**群聊 / 单聊 / 频道**，加它们的**管理**能力。

以下在官方文档里**找不到任何接口或事件**：

| 能力 | 状态 | 依据 |
|---|---|---|
| QQ 空间（说说、日记、评论、点赞、逛动态） | ❌ 真没有 | 47 接口里无 qzone 类；这是另一个产品线，不在机器人开放范围 |
| 戳一戳（拍一拍） | ❌ 真没有 | 无 `send_poke` 类接口；事件表里也没有 poke |
| 自定义表情库（收藏/偷表情/`mface`） | ❌ 真没有 | 无 `add_custom_face` 类接口；消息元素里无 `mface` 类型 |
| 改机器人头像 / 群头衔 / "正在输入" | ❌ 真没有 | 无对应接口 |
| 好友列表 / 主动加好友 | ❌ 真没有 | 只有 `FRIEND_ADD` / `FRIEND_DEL` 两个被动事件 |
| 陌生人资料查询 | ❌ 真没有 | 只有 openid + username，拿不到 QQ 号 |
| 历史消息拉取 | ❌ 真没有 | 无 history 接口，只能自己攒事件流 |
| 群成员列表 / 踢人 / 黑名单 | ⚠️ 有接口，**内邀白名单** | 文档原文：「该能力正在内邀接入中，敬请期待」，错误码 `11253` |

**所以边界很清楚**：官方开放的是「会话场景 + 会话管理」，社交关系链（空间、戳、好友）从一开始就不在范围里。
这不是「漏了」，是产品边界——不要再去找了。

---

## 三、官方给了但我们解析不了的（这块最亏）

比「没封装」更亏的是：**官方明明推了，我们当没有**。

### 事件载荷里被丢掉的东西

`GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` 的完整载荷有 10 个字段，Roost 的 `message.js` 只用了 `content` / `author` / `group_openid` / `id` / `mentions`：

| 字段 | 官方给的 | Roost 现状 | 丢了什么 |
|---|---|---|---|
| `attachments[]` | `url` `filename` `width` `height` `size` `content_type` `voice_wav_url` `asr_refer_text` | ❌ 完全没解析 | **图片、语音、视频、文件全部拿不到**；ASR 文本和转码 WAV 也白给了 |
| `message_scene.ext` | `msg_idx`（本条索引，用于引用）、`ref_msg_idx`（被引用索引）、`auth_token` | ❌ 没解析 | **引用回复做不了**；被引用上下文丢失 |
| `msg_elements[]` | 递归结构，`message_type` 0文本/3卡片/**101并行**/**102聊天记录**/**103引用** | ❌ 没解析 | **合并转发（102 聊天记录）官方是给的**，我们却说没有 |
| `ark_data` | `ark_type`（tuwen/feed/miniapp/map/contact_card/video_share/music_together/picture）+ `fields`（title/desc/jump_url/preview/source…） | ❌ 没解析 | B 站分享卡、小程序卡、位置卡全部只能看到 `[卡片消息]` |

### 发送侧被丢掉的东西

| 官方字段 | 作用 | Roost 现状 |
|---|---|---|
| `msg_type=2` + `markdown.content` | Markdown 消息（模板字段已标【已废弃】） | 有 `replyMarkdown`，需核对是否走模板 |
| `keyboard.content.rows` | 自定义按钮；`action.type` 0跳转/1回调/2指令；`enter`(单聊直接发) / `reply`(带引用) / `anchor`(唤起选图) / `modal`(二次确认) | 有 `renderMenuMd`，**不支持 modal / anchor / reply** |
| `message_reference.message_id` | 引用回复，用 `REFIDX_xxx` | ❌ 无 |
| `event_id` | 用事件 ID 被动回复 | ❌ 无 |
| `msg_seq` 上限 | **每条消息最多回复 5 次** | ❌ 无上限校验 |

### 事件表缺 4 个

Roost 的 `events.js` 登记了 43 个，但缺官方后来新增的：

- `GROUP_JOIN_REQUEST`（用户申请加群）
- `GROUP_MEMBER_ADD` / `GROUP_MEMBER_REMOVE`（群成员增减）
- `SUBSCRIBE_MESSAGE_STATUS`（订阅消息授权状态）

---

## 四、我们的优势到底在哪

把上面的事实摆完，优势其实很清楚了——**但不是「像 SnowLuma」，恰恰相反**：

### 优势 1：官方能力面比 OneBot 大，而且大在「AI 用得上」的地方

OneBot v11 的词汇表里**没有**：Markdown、按钮键盘、指令面板、自定义菜单、流式消息、互动回执、入群审批、分片上传、`message_reference` 引用、`qqbot-media://` 素材。

这些恰恰是**让 AI 表达丰富**的关键：
- AI 想给用户看结构化内容 → Markdown
- AI 想给用户几个选项点一下 → 按钮（`action.type=2` 指令按钮，点了自动填输入框）
- AI 想告诉用户"你能干什么" → 指令面板（20 个元素，可设仅管理员）
- AI 回答长内容 → 流式（单聊，50 QPS）
- AI 想引用某条消息 → `message_reference`

**做 OneBot 门面 = 主动把这些全扔掉，只为了让插件不改代码。这是反向优化。**

### 优势 2：Roost 天生适合当「AI 的手脚」

| Roost 有的 | 对 AI 的价值 |
|---|---|
| 多机器人、per-bot 运行时、面板 | 一个 AI 管多个号，状态互不串 |
| 插件系统（内建 + 子进程任意语言） | 能力可以按需挂载 |
| `node:sqlite` + per-bot `dataDir` | 记忆、配额、映射表有地方放 |
| `ctx.api` 20+ 封装 + 底层 `#request` | **兜底任意官方接口**，这是"调用全部功能"的地基 |
| 事件登记表 `events.js` 改一处全联动 | 加事件成本极低 |
| 已实现的限频/被动窗口/去重/Resume | AI 不用操心协议细节 |

### 优势 3：合规

SnowLuma 是 hook 本机 QQ 客户端，违反协议、有封号风险、EULA 还禁止自动化部署。
官方接口没有这个问题，而且能群管、能审批、能拿群成员（白名单后）。

---

## 五、怎么让 AI 调用官方接口的全部功能

核心思路：**不要预封装 47 个工具**（AI 选不过来，我们也维护不动），而是**三层结构**。

```
L1 专用工具（高频、语义化，AI 天天用）
L2 通用调用（一条通路覆盖全部 47 个接口）
L3 能力清单（AI 的说明书，告诉它官方还有什么）
```

### L1 专用工具（约 10 个）

| 工具 | 覆盖的官方接口 | 为什么单独做 |
|---|---|---|
| `qq_send` | 发群/单聊消息（文本/Markdown+按钮/富媒体/引用，自动选 `msg_type`） | 最高频，参数组合复杂，AI 不该自己拼 |
| `qq_recall` | 撤回群/单聊消息 | 高频，且有 2 分钟时限要处理 |
| `qq_group_info` | 群基本信息 + 机器人群内状态 | 判断有没有管理权限 |
| `qq_group_members` | 群成员列表/单个（内邀时优雅降级） | 权限判定 |
| `qq_mute` | 查询/设置禁言 | 高频管理动作 |
| `qq_join_request` | 入群申请列表/审批 | 高频管理动作 |
| `qq_panel` | 指令面板 6 个接口 | AI 维护"我能干什么"的门面 |
| `qq_menu` | 全局菜单查改 | 同上 |
| `qq_stream` | 流式发单聊（含 `is_wakeup` 召回） | AI 长回答体验 |
| `qq_upload` | 富媒体上传（含分片） | 发图/语音/文件的前置 |

### L2 通用调用 `qq_api`

```
qq_api(method, path, body?)
```

- 走 `ctx.api` 的底层 `#request`
- **path 白名单**：只允许 47 个官方接口的路径模板，防 AI 乱调
- 自动处理：access_token 刷新、限频排队、错误码翻译成中文
- 返回原始 JSON 给 AI

这样即使某个接口我们没做专用工具，AI 也能调。**这是"全部功能"的保证。**

### L3 能力清单（关键，也是最容易被忽略的一步）

AI 不知道官方有什么。必须给它一份说明书：

```json
{
  "name": "创建指令面板",
  "method": "POST",
  "path": "/v2/panels",
  "risk": "write",
  "params": { "scope": "c2c|group|channel|dm", "panel": {...} },
  "limit": "30 QPM",
  "errors": { "40030011": "生效场景不合法" },
  "when": "想给用户一个可点击的指令列表时"
}
```

两条落地方式（建议都做）：
1. **`qq_api_help(keyword?)` 工具** —— AI 按需查，不占上下文
2. **系统提示里放精简版** —— 只放 47 条的「一句话 + 风险等级」，约 2KB

### L3 危险操作要拦

| 风险等级 | 接口 | 处理 |
|---|---|---|
| `read` | 查询类 | 直接放行 |
| `write` | 发消息、改面板、改菜单 | 放行，但记审计日志 |
| `danger` | 踢人、黑名单、执行审批策略、删面板 | **必须二次确认**（AI 先问，或框架弹确认） |

---

## 六、Roost 侧要补的（按优先级）

这些不是"给 AI 加功能"，是**框架本身落后于官方文档**，不补则"调用全部功能"是空话。

### P0 — 不补就没法用

1. **解析 `attachments`**：图片/语音/视频/文件，接 `asr_refer_text` + `voice_wav_url`
2. **解析 `message_scene.ext`**：拿 `msg_idx` / `ref_msg_idx`，打通引用
3. **实现 `message_reference`**：发送侧引用回复
4. **修正主动消息记账**：`20/qpm` + `1000/天/群`，不是「20 条/天」
5. **被动回复加 5 次上限**（`msg_seq` 1–5），超了降级主动

### P1 — 优势所在

6. **解析 `msg_elements`**：102 聊天记录（合并转发）、103 引用、101 并行
7. **解析 `ark_data`**：B 站/小程序/位置卡结构化
8. **指令面板 6 个接口**
9. **`event_id` 被动回复**
10. **补 4 个事件**：`GROUP_JOIN_REQUEST` / `GROUP_MEMBER_ADD` / `GROUP_MEMBER_REMOVE` / `SUBSCRIBE_MESSAGE_STATUS`

### P2 — 锦上添花

11. 分片上传（4 个接口）
12. `generate_url_link`
13. 素材 `qqbot-media://`
14. 键盘 `modal` / `anchor` / `reply` 三个高级 action

---

## 七、和 Aurabot 插件的关系（回答"还要不要换"）

摆完事实，路线要改：

| | 上一版方案 | 现在建议 |
|---|---|---|
| 架构 | Roost 做 OneBot 门面，插件零改动 | **Roost 直接暴露官方能力给 AI，不做 OneBot 门面** |
| 插件 | 保留 Aurabot 全部 12 个模块 | **只留它的"人格 + 记忆"思路，传输层换成官方能力** |
| 为什么变 | 当时以为官方能力弱，门面损失可接受 | 官方能力其实更强，门面是纯损失 |

具体讲：

- **能留的**：人格注入、记忆检索（BM25+遗忘曲线）、群聊分段回复策略、主动搭话策略、心情模型 —— 这些是**纯业务逻辑**，跟传输层无关
- **必须砍的**：QQ 空间（2 个模块）、表情包、戳一戳、群成员信息依赖
- **必须重写的**：`onebot/client.js`（390 行）、`chat/inbound.js`（183 行）、`hub.js` 的发送段
- **可以直接用官方替代的**：语音（`asr_refer_text` + `voice_wav_url`）、合并转发（`msg_elements` 102）

**如果目标只是"让 AI 住进 QQ 并能调用官方全部能力"，Aurabot 这个插件反而可以不做**——
直接做一个 Roost 插件（或 DSH 插件 + Roost 工具集），把 L1/L2/L3 接上就行。
Aurabot 那 9000 行的价值在人格/记忆/群聊策略，不在传输层。

---

## 附：核查记录

| 页面 | 核查到的内容 |
|---|---|
| `autogen/`（接口索引） | 47 个 HTTP 接口，12 组，含指令面板 6 个 |
| `autogen/api/v2_groups_group_openid_messages.post.html` | msg_type 0/2/7、markdown、keyboard（modal/anchor/reply）、message_reference、event_id、msg_seq；被动 5 分钟 + **最多回复 5 次**；主动 **20/qpm + 1000/天/群** |
| `autogen/api/v2_users_user_openid_stream_messages.post.html` | 流式仅单聊，50 QPS，`is_wakeup=true` 不校验有效期 |
| `autogen/api/v2_panels.get.html` | 指令面板：scope 四场景、20 元素、command/link、only_admin |
| `autogen/api/v2_groups_group_openid_members.get.html` | **内邀**，`11253`，每次最多 30 条 |
| `autogen/event/group_message_create.html` | **全量群消息，开启"接收所有消息"后推送**；载荷含 attachments/asr_refer_text/voice_wav_url/ark_data/msg_elements/message_scene |
| `autogen/event/group_at_message_create.html` | 同上载荷；`msg_idx` / `ref_msg_idx` 在 `message_scene.ext` |
| `changelog.html` | 2026-10-21 素材管理；09-16 分享链接；09-03 群成员管理；08-12 菜单+指令面板；08-10 禁言+入群审批+入群申请事件 |
