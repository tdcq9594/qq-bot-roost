# AI 宿主接入

Roost 可以被**外部 AI 宿主**驱动：它收消息、发消息、调官方接口，
宿主（DeepSeek Harness 等）只管想和说。

这条通道最初是为 [dsh-roost](https://github.com/tdcq9594/dsh-roost) 做的，
但它是通用的——任何能发 HTTP 的程序都能接。

---

## 两个方向

```
QQ 官方 ⇄ Roost
             │ ① 事件下行：SSE  /api/stream   （event: message）
             │ ② 能力上行：REST /api/qq/call  （任意官方接口）
             ▼
         你的 AI 宿主
```

---

## ① 事件下行：`GET /api/stream`

复用面板已有的 SSE 通道，新增一路 `event: message`。连上就能收，不用轮询。

```
GET /api/stream?key=<accessKey>
```

```text
event: message
data: {"botId":"main","kind":"group","chatId":"group:B2C3...","groupId":"B2C3...","userId":"A1B2...","userName":"小明","content":"看图","mentioned":true,"addressed":true,"isCommand":false,"msgId":"ROBOT1.0_xxx","msgIdx":"REFIDX_xxx==","refMsgIdx":"","quoted":"","attachments":[{"type":"voice","url":"...","asrText":"你好","wavUrl":"https://...wav"}],"ark":null,"elements":[],"at":1761456000000}
```

**字段说明**

| 字段 | 用途 |
|---|---|
| `botId` | 多机器人时分流 |
| `chatId` | 会话键，`groupId` 或 `userId` |
| `msgId` | **被动回复**用。群聊 5 分钟窗口 / 同一条最多 5 次；单聊 **60 分钟 / 最多 4 次** |
| `msgIdx` | **引用回复**用（`message_reference.message_id`） |
| `quoted` | 这条消息如果是引用，这里是被引用的原文 |
| `attachments[].asrText` | **语音的官方 ASR 结果**，不用自己跑识别 |
| `attachments[].wavUrl` | 官方转好的 WAV，不用自己转码 |
| `elements[]` | `type: 'chatRecord'` 就是合并转发（官方已展开成文本） |
| `ark` | 卡片消息结构化（B 站 / 小程序 / 位置卡） |

**三条约定**

1. **推的是规范化后的字段，不含 `raw`**。原始事件体里有 `auth_token`，不外泄。
2. 机器人自己发的消息不会推（否则宿主会自己跟自己聊）。
3. 推送发生在**业务处理之前**——被去重 / 白名单 / 限流拦下的消息**也会推**。
   拦不拦是框架的策略，不该影响宿主看到「群里说了什么」这个事实。

---

## ② 能力上行：`POST /api/qq/call`

一个端点覆盖官方全部 47 个接口。

```jsonc
POST /api/qq/call?key=<accessKey>
{
  "bot": "main",              // 可选，多机器人时指定
  "method": "sendGroup",      // QQApi 方法名
  "args": {
    "__target": "B2C3...",    // 第一个位置参数（群 openid / 用户 openid）
    "content": "你好"          // 其余键合成一个对象，追加在最后
  },
  "confirm": true             // 危险操作必须带
}
```

```jsonc
{ "ok": true,  "result": { "id": "...", "timestamp": 1761456000000 } }
{ "ok": false, "error": "被动回复超限（群聊 5 分钟 / 5 次，单聊 60 分钟 / 4 次）……", "code": 40034128 }
```

**位置参数怎么传**

官方接口签名不统一，用两个约定键还原：

| 写法 | 还原成 |
|---|---|
| `{__target:'g1', content:'hi'}` | `sendGroup('g1', {content:'hi'})` |
| `{__target:'g1', __rest:['m1']}` | `retractGroupMessage('g1', 'm1')` |
| `{scope:'group', panel:{...}}` | `createPanel({scope,panel})` |
| `{}` | `getMe()` |

**三层安全边界**

1. 路由在 `authorized()` / CSRF / 同源校验**之后**，和面板其他写接口一个待遇
2. `method` 必须在白名单里（`src/endpoints.js` 的方法名集合），内部方法名进不来
3. 风险等级 `danger` 的必须显式 `confirm: true`

**风险分级**（见 `riskOf()`）

| 等级 | 判据 | 例子 |
|---|---|---|
| `read` | GET | `getMe`、`getGroupInfo` |
| `write` | POST/PUT/PATCH，可恢复 | `sendGroup`、`createPanel`、`muteMembers` |
| `danger` | DELETE，或不可逆/影响他人 | `removeMembers`、`operateGroupBlacklist`、`executeJoinStrategy`、`deletePanel` |

错误会翻成人话（`40034128` → 「被动回复超限……」），原始码放在 `code` 里。

---

## ③ 能力清单：`GET /api/qq/capabilities`

给 AI 看的说明书：有哪些方法能调、风险等级、限制。

```jsonc
[
  { "api": "sendGroup", "http": ["POST /v2/groups/{group_openid}/messages"],
    "group": "消息·群", "risk": "write", "note": "" },
  { "api": "uploadMedia", "http": ["POST /v2/groups/{group_openid}/files", "POST /v2/users/{user_openid}/files"],
    "group": "消息·富媒体", "risk": "write", "note": "" }
]
```

一个方法对应多条官方接口时合并成一条。**官方新增接口时，只要在
`src/endpoints.js` 加一行，宿主侧零改动就能调。**

---

## 调试

`--mock --serve` 模式下有个注入接口，用来手工喂一条群消息：

```bash
curl -X POST 'http://127.0.0.1:8080/api/mock/message?key=xxx' \
  -H 'content-type: application/json' \
  -d '{"text":"你好","groupId":"mock-group"}'
```

**只在 `rt.mock` 时存在**，真实机器人上返回 404——不会变成伪造消息的后门。
