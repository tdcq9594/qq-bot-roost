# QQ 机器人内核（插件式）

填 **AppID + AppSecret** 就能连上 QQ 官方机器人，功能全部通过插件扩展。
**零依赖**——只用 Node.js 内置能力（`fetch` + 原生 `WebSocket`），不需要 `npm install`。

```
node src/main.js
```

---

## 一、5 分钟跑起来

### 1. 装 Node.js 22+

```bash
node -v      # 需要 >= 22
```

> 为什么必须 22+：用到了内置的全局 `WebSocket`，不用装 `ws` 这类第三方包。

### 2. 去开放平台拿凭证

1. 打开 <https://q.qq.com> → 创建机器人
2. 在「开发设置」里拿到 **AppID** 和 **AppSecret**
3. **关键**：到「功能配置」里开通 **群聊** 能力，否则连接会被拒绝（关闭码 4014）

### 3. 启动

```bash
cd bot
node src/main.js
```

首次运行会提示输入 AppID / AppSecret，自动存进 `config.json`。
Windows 下也可以直接双击 `start.bat`。

看到这行就成功了：

```
INFO [gateway] 已就绪，机器人: 你的机器人名
```

### 4. 认领主人

把机器人拉进群，@它 发送：

```
/claim
```

第一个认领的人成为主人（仅当 `owners` 为空时可用），之后就能用插件管理命令。

> 想换人：直接改 `config.json` 的 `owners` 数组，填对方的 openid（发 `/whoami` 可查）。

---

## 二、常用命令

| 命令 | 说明 |
|------|------|
| `/help` | 列出所有命令（自动按插件分组） |
| `/plugins` | 插件列表与运行状态 |
| `/enable <id>` | 启用插件（仅主人） |
| `/disable <id>` | 禁用插件（仅主人） |
| `/reload [id]` | 热重载插件，改完代码不用重启进程（仅主人） |
| `/whoami` | 查看自己的 openid / 群 openid |
| `/claim` | 认领主人身份 |
| `/ping` | 连通性测试 |

---

## 三、写一个插件

在 `plugins/` 下建个文件夹，放一个 `index.js`：

```js
// plugins/hello/index.js
export default {
  id: 'hello',
  name: '打招呼',
  version: '1.0.0',
  description: '最小插件示例',

  setup(ctx) {
    // 注册命令：/hello 张三
    ctx.command('hello [名字]', { desc: '打个招呼' }, async (msg, { args }) => {
      await msg.reply(`你好，${args[0] ?? '陌生人'}！`);
    });

    // 监听所有消息（非命令也会进来）
    ctx.on('message', async (msg) => {
      if (msg.content === '在吗') await msg.reply('在的');
    });
  },
};
```

放进去后发 `/reload` 即可生效，不用重启。

### ctx 提供的能力

| 成员 | 说明 |
|------|------|
| `ctx.command(模式, 选项, 处理函数)` | 注册命令。模式里第一个词是命令名，后面是用法提示 |
| `ctx.on(事件名, 处理函数)` | 监听 `message` 或原始事件（`GROUP_AT_MESSAGE_CREATE` 等） |
| `ctx.storage.get/set/all` | 插件私有键值存储，落盘到 `data/plugins/<id>.json` |
| `ctx.api` | 原始 HTTP API（发图、富媒体等） |
| `ctx.logger` | 带插件前缀的日志 |
| `ctx.isOwner(uid)` | 判断是否主人 |
| `ctx.prefix` | 命令前缀 |

### msg 对象

| 字段 | 说明 |
|------|------|
| `msg.content` | 去掉 @机器人 和前缀后的正文 |
| `msg.args` | 按空格切好的参数数组 |
| `msg.userId` | 发送者 openid |
| `msg.groupId` | 群 openid（私聊为空） |
| `msg.kind` | `group` / `c2c` / `guild` |
| `msg.reply(text)` | 被动回复（带 msg_id，5 分钟内有效，`msg_seq` 自动递增） |
| `msg.push(text)` | 主动推送（不带 msg_id，有频次限制） |
| `msg.replyImage(url)` | 先上传再发图 |

### 事件分发规则

1. 是命令且已注册 → 只跑该命令的处理函数
2. 是命令但没注册 → 回复「没有这个命令」
3. 不是命令 → 依次触发 `message` 监听和原始事件监听

---

## 四、目录结构

```
bot/
├── config.json            运行时生成（AppID/AppSecret/owners）
├── start.bat              Windows 一键启动
├── src/
│   ├── main.js            入口：装配 + 核心命令 + 事件分发
│   ├── config.js          配置加载、首启向导
│   ├── token.js           AccessToken 获取与自动刷新
│   ├── api.js             HTTP API（发群消息/私聊/富媒体）
│   ├── gateway.js         WebSocket 网关（心跳/重连/Resume）
│   ├── message.js         事件 → 统一 Message 对象
│   ├── logger.js          日志
│   └── plugin/
│       ├── loader.js      扫描/加载/卸载/热重载
│       └── context.js     注册表 + 插件上下文 + 存储
├── plugins/
│   ├── echo/              示例：命令 + 消息监听
│   └── dice/              示例：参数 + 玩家数据持久化
└── data/                  运行时数据（插件存储、启用状态）
```

---

## 五、实现要点（对照官方文档）

| 环节 | 实现 |
|------|------|
| 获取凭证 | `POST /app/getAppAccessToken`，`{appId, clientSecret}` → `access_token` |
| 鉴权头 | `Authorization: QQBot {access_token}` |
| 提前刷新 | 有效期 7200s，提前 120s 刷新；401 时强制刷新并重试一次 |
| 网关 | `GET /gateway/bot` → `wss://...` |
| 握手 | 收到 `op10 Hello` → 发 `op2 Identify`（`token: "QQBot xxx"`） |
| 心跳 | 按 `heartbeat_interval` 发 `op1`，带最新 `s` |
| 断线 | 指数退避重连，有 session 时走 `op6 Resume` 补事件 |
| 发群消息 | `POST /v2/groups/{group_openid}/messages` |
| 发私聊 | `POST /v2/users/{openid}/messages` |
| 被动回复 | 带 `msg_id`；同一 `msg_id` 的 `msg_seq` 必须递增，已自动处理 |
| 默认 intents | `1 << 25` = 群聊 @ + 私聊（`GROUP_AND_C2C_EVENT`） |

### 常见报错

| 现象 | 原因 |
|------|------|
| `4014 intents 无权限` | 没开通群聊能力，或 intents 填错 |
| `10004 机器人不存在` | AppID 错了 |
| 回复发不出去 | 超过 5 分钟被动回复窗口，或 `msg_seq` 重复 |
| 收不到群消息 | 机器人没被 @，或群未授权 |

---

## 六、已知限制

- **单进程**：插件与内核同进程，插件里写死循环会拖垮整个机器人。后续可换 `worker_threads` 隔离。
- **频道消息只收不发**：`guild` 场景没接 v2 发送接口，主要面向群聊/私聊。
- **未做分片**：单连接够用；机器人进几千个群再考虑 `shard`。
- **存储是 JSON**：适合中小规模。斗罗那种有玩家存档的，插件里直接接 SQLite 更合适。

---

## 七、下一步

- 把 `douluo/` 里的游戏逻辑包成插件，数据层换成 SQLite
- 插件市场：约定 `plugin.json` 清单 + 版本号，支持在线安装
- 把 `data/plugins/*.json` 换成 SQLite，支持事务
