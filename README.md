# QQ 机器人内核（插件式 + 可视化面板）

填 **AppID + AppSecret** 就能连上 QQ 官方机器人，功能全部通过插件扩展，带一个网页控制台。
**零依赖**——只用 Node.js 内置能力（`fetch` + 原生 `WebSocket` + `http`），不需要 `npm install`。

```bash
node src/main.js
```

打开 <http://127.0.0.1:8080> 就能在网页上配置和看状态。

---

## 特性

**连接层**
- 填凭证即连，首启向导自动写入 `config.json`
- AccessToken 自动获取、提前 120 秒刷新、401 自动重试
- WebSocket 心跳、指数退避重连、`Resume` 补发断线期间的事件
- 关闭码翻译成人话（`4014` → 提示去开通群聊能力）

**消息层**
- 群聊 / 私聊统一抽象成 `Message`，插件不用关心底层差异
- 被动回复自动维护 `msg_seq`（同一 msg_id 递增，官方硬要求）
- 支持文本、Markdown + 按钮、图片、视频、语音、文件
- 去重、限流、群/用户白名单，三层前置拦截

**群与权限**
- 机器人被拉进群时自动登记群档案，记录邀请人
- 邀请人默认成为该群的管理者；主人列表为空时还会自动设为主人
- 群管理者能在本群使用管理命令，管不到别的群

**插件层**
- 目录即插件，扔进 `plugins/` 即可
- 热重载，改完代码不用重启进程
- 独立 JSON 存储，卸载自动清理定时器
- 一个插件崩了不影响其他插件和主程序

**可视化面板**
- 实时状态、活跃会话、收发统计
- 在线改配置，改完即时生效（改 AppID 会自动重连）
- 插件启停 / 重载
- 实时日志流（SSE），可调级别、过滤
- 调试用的主动发消息入口

---

## 一、5 分钟跑起来

### 1. 装 Node.js 22+

```bash
node -v      # 需要 >= 22
```

> 必须 22+：用到了内置的全局 `WebSocket`，不用装 `ws`。

### 2. 去开放平台拿凭证

1. <https://q.qq.com> → 创建机器人
2. 「开发设置」里拿到 **AppID** 和 **AppSecret**
3. **关键**：「功能配置」里开通 **群聊** 能力，否则连接会被拒（关闭码 4014）

### 3. 启动

```bash
cd bot
node src/main.js
```

首次运行提示输入 AppID / AppSecret。Windows 下也可以双击 `start.bat`。

看到这两行就成功了：

```
INFO [gateway] 已就绪，机器人: 你的机器人名
INFO [webui]   可视化面板: http://127.0.0.1:8080
```

### 4. 认领主人

把机器人拉进群，@它 发送 `/claim`。第一个认领的人成为主人（仅当 `owners` 为空时可用）。
也可以直接在面板的「配置」页填 `owners`。

---

## 二、可视化面板

默认 <http://127.0.0.1:8080>，**只监听 127.0.0.1，不对外暴露**。

| 页签 | 能做什么 |
|------|----------|
| 概览 | 连接状态、运行时长、Token 剩余、内存、收发统计、活跃会话 Top20、重连/刷新 Token、调试发消息 |
| 配置 | 凭证、intents、命令前缀、主人、白名单、限流、去重窗口、日志级别、面板端口/token |
| 插件 | 列表、启用/禁用/重载、加载错误提示 |
| 群组 | 主人增删、入群自动认主开关、群列表与每群管理者编辑 |
| 日志 | SSE 实时流，按级别过滤，自动滚动 |

**要对外开放**：改 `config.json` 的 `webui.host` 为 `0.0.0.0`，**务必同时设置 `webui.token`**，
否则任何人都能改你的机器人配置。改 host/port 需要重启进程。

**没有凭证也想看界面**：

```bash
node src/main.js --mock --serve
```

### 关于「默认主人是群主」

QQ 官方 v2 接口**没有**查询群主或群成员的能力。能拿到的唯一信号是
`GROUP_ADD_ROBOT` 事件里的 `op_member_openid`，也就是把机器人拉进群的那个人，
实践中通常就是群主或管理员。

所以这里的实现是：

1. 机器人入群 → 记录该群档案，把邀请人设为「本群管理者」
2. 若全局主人列表为空且 `autoOwnerOnInvite` 为真 → 同时把邀请人设为机器人主人
3. 之后可以在面板的「群组」页随时改：换主人、换某个群的管理者、关掉自动认主

---

## 三、命令

| 命令 | 说明 |
|------|------|
| `/help` | 列出所有命令（按插件分组） |
| `/status` | 运行状态 |
| `/plugins` | 插件列表与状态 |
| `/enable <id>` | 启用插件（主人） |
| `/disable <id>` | 禁用插件（主人） |
| `/reload [id]` | 热重载（主人） |
| `/whoami` | 查自己的 openid / 群 openid |
| `/claim` | 认领主人身份（主人列表为空时可用） |
| `/ping` | 连通性测试 |

---

## 四、写插件

在 `plugins/` 下建文件夹，放 `index.js`：

```js
export default {
  id: 'hello',
  name: '打招呼',
  version: '1.0.0',
  description: '最小示例',

  setup(ctx) {
    ctx.command('hello <名字>', { desc: '打个招呼' }, async (msg, { args }) => {
      await msg.reply(`你好，${args[0]}！`);
    });

    ctx.on('message', async (msg) => {
      if (msg.content === '在吗') await msg.reply('在的');
    });
  },
};
```

发 `/reload` 生效。完整约定见 **[docs/插件开发规范.md](docs/插件开发规范.md)**。

### 能力速查

| 成员 | 说明 |
|------|------|
| `ctx.command(模式, 选项, 函数)` | 注册命令，`<必填>` 会自动校验 |
| `ctx.on(事件, 函数)` | 监听 `message` 或原始事件 |
| `ctx.schedule(名称, 毫秒, 函数)` | 定时任务，卸载时自动清理 |
| `ctx.storage.get/set/all` | 插件私有存储 |
| `ctx.api` | 原始 HTTP API |
| `msg.reply/push/replyMarkdown/replyImage/replyVideo/replyVoice/replyFile` | 各种发送方式 |

---

## 五、配置项

`config.json`（面板改完自动写回）：

```jsonc
{
  "appId": "",                    // 机器人 AppID
  "appSecret": "",                // 机器人 AppSecret
  "baseUrl": "https://api.bot.qq.com",
  "intents": 33554432,            // 1<<25 = 群聊@ + 私聊
  "owners": [],                   // 主人 openid 列表
  "commandPrefix": "/",
  "logLevel": "info",

  "webui": {
    "enabled": true,
    "host": "127.0.0.1",          // 对外暴露时改 0.0.0.0 并设 token
    "port": 8080,
    "token": ""                   // 非空则 /api/* 需要鉴权
  },

  "whitelist": {                  // 开启后只响应名单内来源
    "enabled": false,
    "groups": [],
    "users": []
  },

  "rateLimit": {
    "enabled": true,
    "perChatPerMinute": 30        // 每会话每分钟上限
  },

  "dedupWindowSec": 120,          // 同一条消息的去重窗口

  "autoOwnerOnInvite": true       // 入群时自动把邀请人设为主人（主人列表为空时）
}
```

环境变量优先级最高：`QQ_BOT_APPID` / `QQ_BOT_SECRET` / `QQ_BOT_BASE_URL` / `QQ_BOT_OWNERS`。

---

## 六、目录结构

```
bot/
├── config.json            运行时生成
├── start.bat              Windows 一键启动
├── src/
│   ├── main.js            入口：装配、核心命令、事件分发、前置拦截
│   ├── config.js          配置加载与首启向导
│   ├── runtime.js         运行时状态（面板的数据源）
│   ├── groups.js          群档案（邀请人、管理者、启用状态）
│   ├── token.js           AccessToken 管理
│   ├── api.js             HTTP API（消息/富媒体）
│   ├── gateway.js         WebSocket 网关
│   ├── message.js         事件 → 统一 Message
│   ├── logger.js          日志 + 环形缓冲 + 订阅
│   ├── web/server.js      面板服务端（REST + SSE）
│   └── plugin/
│       ├── loader.js      扫描/加载/卸载/热重载
│       └── context.js     注册表 + 插件上下文 + 存储
├── web/                   面板前端（原生 JS/CSS，无构建）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── plugins/
│   ├── echo/              示例：命令 + 消息监听
│   └── dice/              示例：参数 + 玩家数据持久化
├── docs/
│   └── 插件开发规范.md
└── data/                  运行时数据（插件存储、启用状态）
```

---

## 七、实现要点（对照官方文档）

| 环节 | 实现 |
|------|------|
| 获取凭证 | `POST /app/getAppAccessToken`，`{appId, clientSecret}` |
| 鉴权头 | `Authorization: QQBot {access_token}` |
| 提前刷新 | 有效期 7200s，提前 120s 刷新；401 强制刷新重试一次 |
| 网关 | `GET /gateway/bot` → `wss://...` |
| 握手 | `op10 Hello` → `op2 Identify`（`token: "QQBot xxx"`） |
| 心跳 | 按 `heartbeat_interval` 发 `op1`，带最新 `s` |
| 断线 | 指数退避，有 session 走 `op6 Resume` 补事件 |
| 发群消息 | `POST /v2/groups/{group_openid}/messages` |
| 发私聊 | `POST /v2/users/{openid}/messages` |
| 富媒体 | `POST /v2/{groups,users}/.../files`，`file_type` 1图 2视频 3语音 4文件 |
| 被动回复 | 带 `msg_id`，`msg_seq` 同一 msg_id 递增 |
| 默认 intents | `1 << 25` = `GROUP_AND_C2C_EVENT` |

### 常见报错

| 现象 | 原因 |
|------|------|
| `4014 intents 无权限` | 没开通群聊能力，或 intents 填错 |
| `10004 机器人不存在` | AppID 错了 |
| 回复发不出去 | 超过 5 分钟被动回复窗口，或 `msg_seq` 重复 |
| 收不到群消息 | 机器人没被 @，或群未授权 |
| 面板打不开 | 端口被占用，看日志里的 `EADDRINUSE` |

---

## 八、已知限制

- **查不到群主**：官方接口没有群成员/群主查询，只能用「邀请人」近似，见上文。
- **单进程**：插件与内核同进程，插件里写死循环会拖垮整个机器人。后续可换 `worker_threads`。
- **频道消息只收不发**：`guild` 场景没接 v2 发送接口，主要面向群聊/私聊。
- **未做分片**：单连接够用；进几千个群再考虑 `shard`。
- **存储是 JSON**：适合中小规模。斗罗那种玩家存档建议插件里直接接 SQLite。
- **面板无登录态**：只有 token 校验，没有会话。别直接暴露到公网。

---

## 九、下一步

- 把游戏逻辑包成插件，数据层换 SQLite
- 群级配置（每群独立开关插件、独立数值）
- 插件清单 `plugin.json` + 版本号，支持在线安装
- 面板增加「模拟消息」入口，不连 QQ 也能测插件
- 多机器人实例（一个进程跑多个 AppID）
