## 栖 Roost v0.5.1

> 倦飞之鸟，终有一栖。

第一个正式版本。**零依赖的 QQ 官方机器人框架**——装个 Node 22 就能跑，不需要 `npm install`。

```bash
git clone https://github.com/tdcq9594/qq-bot-roost.git
cd qq-bot-roost
node src/main.js
```

首次运行会提示输入 AppID / AppSecret，之后自动建目录、开面板。

---

### 这个版本有什么

**零依赖**
从零实现 QQ 开放平台 v2 协议，不引任何第三方包。部署就是「复制文件夹 + 跑起来」。

**两种收事件方式**
- WebSocket 长连接：本地默认，开箱即用
- Webhook 回调：公网 / Serverless / 容器部署，带 Ed25519 签名校验（`op=13`）

**插件可写任意语言**
内建插件跑主进程（JS），外部插件跑独立子进程（Python / Go / 任意），
通过 NDJSON 协议通信。崩溃只影响自己，自动重启。

**插件市场**
面板「插件 → 市场」一键安装，**有新版自动提示、一键更新**。
先拉一次中央仓库再逐个检出，不用为每个插件单独 clone。

**群管接口全套（23 个方法）**
- 禁言（单个 / 批量，自动预检机器人是不是管理员）
- 群成员列表、批量踢人、群黑名单（官方内邀，默认关闭，面板一键开启）
- 入群申请审批 + 自动审批策略 + 白名单

**官方限制全兜底**
5 分钟被动回复窗口、每秒 5 条限速、主动消息每日额度、断线拒发、审核中识别——
插件只管调 `msg.reply()`，不用算时间、不用管额度。

**多机器人**
一个进程跑多个机器人，面板顶栏切换。数据严格隔离——openid 是每个机器人独立的，
共享存档等于全部对不上。

**可视化面板**
7 个页签：概览 / 配置 / 插件 / 事件 / 群组 / 权限 / 日志。
实时日志流（SSE）、43 个官方事件的订阅状态、插件自己上报的运行数据。

**流式回复**
`msg.replyStream()` 做 AI 打字机效果，自动维护分片序号；群聊自动降级成普通消息。

---

### 快速上手

```bash
# 1. 装 Node.js 22+
node -v

# 2. 启动
node src/main.js          # Windows 也可以双击 start.bat

# 3. 认领主人
#    把机器人拉进群，看日志里的「认领码」，@它 发送 /claim XXXXXX
```

没有凭证也想看界面：

```bash
node src/main.js --mock --serve
```

Docker 部署：

```bash
cp config/bot.example.json config/bot.json   # 填 AppID / AppSecret
docker compose up -d
```

---

### 测试

```bash
npm test          # 框架自检 135 项
npm run test:e2e  # 端到端 95 项（起真实服务打全部接口）
npm run test:all  # 两个都跑
```

覆盖出站调度、会话粘性、中间件管道、插件生命周期、插件市场、群管闸门、
Webhook 全部路径、配置归属、markdown 渲染。

---

### 已知限制

- **只做 QQ 官方接口**，不支持微信 / 飞书 / Telegram。多平台看 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 或 [Koishi](https://github.com/koishijs/koishi)
- **群列表靠事件被动发现**，官方没有查询接口
- **群成员 / 踢人 / 群黑名单是官方内邀接口**，需要申请白名单
- **单进程**：插件与框架同进程，插件里写死循环会拖垮整个机器人
- **存储是 JSON**：适合中小规模，大型存档建议插件里接 SQLite
- **面板无登录态**：只有访问密钥校验，别直接暴露到公网

细节见 [docs/官方接口限制.md](https://github.com/tdcq9594/qq-bot-roost/blob/master/docs/官方接口限制.md)。

---

### 许可

**永久免费，禁止任何收费，禁止商业使用。**
不提供商业授权——不存在「付钱就能商用」的途径。

准确说法是「源码公开、免费使用」（source-available），不属于 OSI 定义的开源。
完整条款见 [LICENSE](https://github.com/tdcq9594/qq-bot-roost/blob/master/LICENSE)。
