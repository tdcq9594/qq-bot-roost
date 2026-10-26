## v0.7.0：对齐官方文档（接口补全 + 三处数值纠错）+ 插件 REST 路由

这一版做两件事：**把框架重新对了一遍官方文档**，以及**补上插件缺的那块数据通道**。

### 一、对照官方文档纠错

上一版 `docs/官方接口限制.md` 里有三处数值/结论是错的，来源是照着过时的官方 SDK 仓库
（`botgo` / `botpy`）推断，而这三个仓库更新滞后。这次逐页读官方文档
`bot.q.qq.com/wiki/develop/api-v2/autogen/` 重新核了一遍：

| 以前 | 官方实际 |
|---|---|
| 主动消息 **20 条/天** | **20 条/分钟** + **每群 1000 条/天**（Bot 维度：认证 60/qpm、未认证 30/qpm） |
| 群里不 @ 的消息「平台根本不推」 | 有 `GROUP_MESSAGE_CREATE`「群消息·全量模式」，开启「接收所有消息」就会推 |
| 语音转文字官方无、得本地 ASR | 事件附件里有 `asr_refer_text`（ASR 结果）+ `voice_wav_url`（转好的 WAV） |

**影响**：主动消息额度原来少算了 50 倍，主动推送被白白拦掉。升级后
`outbound.dailyActive` 默认 1000、新增 `outbound.activePerMinute` 默认 20。

> ⚠️ 如果你在 `config/bots/*.json` 里手写过 `"dailyActive": 20`，它会覆盖新默认值，记得改成 1000。

### 二、官方接口全部补齐（47/47）

新增 **18 个方法**，官方文档 `autogen/api/` 索引里的 47 个 HTTP 接口现在**一个不缺**：

- **指令面板** `/v2/panels`（6 个）：`listPanels` / `createPanel` / `getPanel` / `updatePanel` / `deletePanel` / `updatePanelTarget`
- **分片上传**（4 个接口 → 2 个方法）：`uploadPrepare` / `uploadPartFinish`
- **生成分享链接**：`generateUrlLink`
- **频道管理**（6 个）：`getMyGuilds` / `getGuild` / `getGuildChannels` / `createGuildChannel` / `getChannel` / `updateChannel` / `deleteChannel`

新增 `src/endpoints.js` 作为**官方接口清单**（唯一事实来源），`npm test` 会校验覆盖率——
以后官方加接口而我们漏了，测试直接红，不再靠人工记。

### 三、事件与消息载荷

- 补 **`GROUP_MEMBER_EVENT`（1<<24）** 订阅位。官方 2026-08 新增的独立位，
  之前整位缺失，`GROUP_MEMBER_ADD` / `GROUP_MEMBER_REMOVE` / `GROUP_JOIN_REQUEST`
  根本订阅不到。面板的事件订阅区也补上了这一项。
- 补 `SUBSCRIBE_MESSAGE_STATUS` 事件；`GROUP_MESSAGE_CREATE` 不再标成「文档未列出」。
- **解析以前整个丢掉的载荷**：`attachments`（图片/语音/视频/文件）、
  `message_scene.ext`（引用索引）、`ark_data`（卡片）、`msg_elements`
  （**102 = 聊天记录，即合并转发；103 = 引用**）。
- Message 新增 `attachments` / `images` / `voices` / `files` / `msgIdx` / `refMsgIdx` /
  `quoted` / `ark` / `elements`，以及 `msg.replyQuote()`（引用回复）。
- 被动回复加**同一条消息最多 5 次**的上限（官方硬限制），用满自动降级为主动消息。

### 四、插件 REST 路由 `ctx.registerRoute`

`ctx.registerPage()` 只解决「页面能画出来」，服务端不会在每个请求回调插件，
所以插件自带的管理页拿不到自己的数据——KV 存档既没事务也没查询能力。

现在插件可以注册 REST 接口：

```js
ctx.registerRoute('GET', '/players', async ({ query }) => {
  return { items: await repo.list({ q: query.q }) };  // 直接返回对象 = 200 JSON
});
```

- 地址是 `/api/plugins/<插件id>/r<你写的路径>`，鉴权/CSRF/同源校验**全部复用面板那套**
- 插件拿不到裸 req/res，绕不开鉴权
- 路径参数只支持 `:name`，每插件上限 200 条
- 插件卸载/重载时自动清空，不留死接口

详见 `docs/插件开发规范.md` §5.12.1。

### 升级提示

- 版本号 0.6.18 → **0.7.0**：新增插件 API 与 18 个官方接口方法，属于功能级更新。
- 现有插件不用改：`registerRoute` 是新增能力，不注册就是没有。
- 行为变化只有一处：主动消息额度从 20/天 变成 1000/天 + 20/分钟（更宽松）。

## v0.6.18：修「已有实例在运行（PID xxx）」的误判（PID 复用）

有用户遇到：明明没开第二个机器人，启动却提示「AppID xxx 已有实例在运行（PID yyy）」，
而且按那个 PID 根本找不到机器人进程，锁还删不掉。

**根因**：PID 复用。实例互斥文件 `data/instances.json` 记着一个被强杀进程的 PID；
该进程退出后没来得及释放锁，Windows 又把回收的 PID 分配给了别的程序
（实测被 `SearchProtocolHost.exe` 占用）。而 `isAlive` 只判断「PID 存不存在」，
不判断它还是不是机器人，于是僵尸记录被当成「还在跑」。

**修复**：`isAlive` 在 PID 存在后，再确认它确实是 node 进程（Windows `tasklist`、
POSIX `ps`）；不是 node 就当残留自动清理。查不出来时保守当活着，避免误删真实实例。

**已经卡住的用户**：把 `data/instances.json` 里对应那条删掉（或整个文件置为 `{}`）即可启动。

## v0.6.17：新增「关于」页，检查更新挪进去

- 控制台导航末尾新增「关于」页：品牌 + 当前版本、版本更新、联系方式、许可。
- 「检查更新 / 立即更新」从「概览」整体移到「关于」页（逻辑不变，更新行为一致）。
- 联系方式：QQ 2014433751 · 邮箱 jfzn9594@outlook.com；附 GitHub / Gitee 项目链接。

## v0.6.16：修 Windows 双击 start.bat 打不开（更新把 CRLF 写成了 LF）

有用户反馈：从面板更新到 0.6.15 后，双击 `start.bat` 打不开——窗口一闪就退，
或冒出 `'it' 不是内部或外部命令`、`[错误] Node.js 版本太低` 之类的乱码。

**根因**：不是程序坏了，是 `start.bat` 的换行符被写成了 LF。app 内更新下载的是
GitHub 的 archive tarball，它直接给 git blob 内容——`.gitattributes` 里的
`eol=crlf` 只在 git checkout 时生效，对 tarball 无效。于是原本 CRLF 的
`start.bat` 被覆盖成 LF，cmd.exe 解析带括号的多行块时会把行拆碎当命令执行，
表现就是双击没反应 / 乱报错。

**修复**：

- `.gitattributes` 把 `*.bat` / `*.cmd` 改成 `-text`，让 CRLF 真正存进 blob，
  GitHub tarball 里也就是 CRLF 了。
- `src/tarball.js` 解包时对 `.bat` / `.cmd` 在 Windows 上兜底转 CRLF（幂等）。

**已经装坏的用户**：本版 tarball 里的 `start.bat` 已是 CRLF，更新一次即可恢复；
急用也可用 `node src/main.js` 启动，或手动把 `start.bat` 另存为 CRLF。

## v0.6.15：多机器人面板不再串台 + 安全加固 + 发布链路守卫

这一版主要修「多机器人隔离」在可观测性上的漏洞，并补了几处安全与发布链路的硬约束。

### 多机器人指标 per-bot 化（重点）

以前连接态和活跃指标挂在进程级全局单例 `runtime` 上，多个机器人并存时
N 个网关的 READY 互相覆盖、N 个 dispatch 把计数汇进同一本账——面板上
「哪个 bot 在线」「哪个群在沸腾」全是最后写入者的值。现在每个 `BotRuntime`
各持一份 `BotMetrics`，总览、事件页、在线灯、重连次数各看各的。

### 安全加固

- 面板监听非 loopback 却没设 `webui.accessKey` 时**启动期直接拒绝**：
  以前只在 doctor 里软告警，误配会让远程无认证接管（含装插件 = RCE）。
- 依赖安装进程的环境变量改为白名单净化（新增 `src/plugin/env.js`），
  不再把 `QQ_BOT_SECRET` / `ROOST_WEBUI_KEY` 漏给 `pip` / `npm`。
- 面板鉴权失败加 per-IP 限速（60 秒 20 次），防弱 key 被顺序猜。
- 插件市场允许本机 http 地址改为显式开关 `ROOST_ALLOW_LOCAL_INDEX=1`。

### 健壮性

- `shutdown` 加 10 秒硬超时；关停中再收到退出信号直接强退，不再永久卡死。
- `uncaughtException` 不再一律吞掉：60 秒内超过 5 次判定状态不可信，退出交由重启自愈。
- 网关重连退避加随机抖动，避免多实例锁步重连。

### 发布链路

- 插件 CI 固定到已发布的框架 tag（不再跟 master HEAD），消除假绿/假红。
- 新增跨仓哈希一致性测试：插件仓 `scripts/hashdir.mjs` 与框架 `src/hashdir.js`
  在同一固定样例上必须逐字节一致。
- 新增两仓 `gitee-sync` 工作流：推镜像并校验分支 sha 已跟上。
- 新增 `docs/回滚预案.md`（框架 / 插件 / 索引 / 双仓四类回滚）。

### 已知

- 灰度 / canary 与「市场降级」需要索引 schema 支持历史版本，本版未做。
- 面板插件页的 `?key=` 与 iframe `allow-same-origin` 保持现状（插件页认证依赖），
  信任边界已在代码注释说明。

## v0.6.14：下载源只剩两个——GitHub 官方和作者维护的 Gitee 镜像

国内直连 GitHub 经常超时，所以框架一直带「下载源切换」。但回头看，之前那批
公共代理（ghfast / ghproxy / gh-proxy / kkgithub）和 MirrorChyan 实际用下来
要么限速、要么挂掉、要么悄悄改内容——用户装了反而更难排查。这版把它们全部
移除，换成**作者自己维护的 Gitee 镜像**，可控、可验证、国内直连快。

镜像仓库（与 GitHub 内容逐字节相同，已实测对账）：

- 框架：https://gitee.com/tdcq9594/qq-bot-roost
- 插件：https://gitee.com/tdcq9594/qq-bot-roost-plugins

### Gitee 是怎么接的

调研结论（同类项目做法 + 实测）：

- **`repository/archive/{ref}.zip|tar.gz` 不能用**。这个地址现在返回的是
  「下载仓库」网页，真实文件要浏览器里 JS 调 `check_archive` 拿签名令牌
  （`{"code":401,"msg":"验证信息过期"}`）。Paddle、Wegent 等项目和大量教程
  还在用这个老地址，实际已拿不到文件。
- **Gitee Releases 资产**能用，但要人工往 Gitee 上传发行附件，不适合自动同步
  的镜像仓库（OpenHUTB、nonebot_plugin_sky 是这么做的，它们自己发版）。
- 最后走 **git trees API 列清单 + raw 逐个拉文件**（`src/gitee.js`）：一次
  API 调用拿全量清单，文件内容走 raw。公开端点不需要 key，纯 fetch 不依赖 git。
  框架整包 86 个文件约 10 秒，单个插件目录 2~8 个文件。

三处入口都接上了：框架自更新（版本检查读 Gitee 上的 package.json，下载走
trees）、插件市场安装（只拉索引里那个插件目录，少拉一半文件）、市场批量同步。
`auto` 模式 GitHub 失败会自动切 Gitee，检查和下载都一样。

### 私人令牌（选填）

Gitee API 匿名配额约 60 次/小时且全局共享。面板下载源选 Gitee 后可填私人
令牌（`network.giteeToken`），只加在 API 调用上，raw 下载不需要；不填就走
匿名，公开仓库两种都能用。

### 实测中发现并修掉的问题

- gitee 的 raw CDN 在突发流量下会返 **HTTP 451**（连拉 86 个文件时稳定复现，
  单独请求同一个文件又是 200）。下载器加了退避重试（451/429/5xx/网络错重试
  3 次，404 不重试），并发从 6 降到 4。
- 真机对账：从 Gitee 拉的框架 86 个文件与本地 git 对象**逐字节一致**（含中文
  路径）；插件目录 hashDir 结果与市场索引里的 sha256 **一致**——供应链校验
  在 Gitee 源上成立。

### 破坏性变更

- `network.mirror` 的 `ghfast` / `ghproxy` / `gh-proxy` / `kkgithub` 取值
  不再存在，旧配置会退回 `auto`（有兜底，不会启动失败）。
- `mirrorChyanResId` / `mirrorChyanCdk` 配置项移除（MirrorChyan 一起移除）。

### 测试

单测 380 / e2e 153 / 真机驱动 18 → 合计 **551**。
（e2e 另有 1 项按环境跳过：本机没填 AppSecret 时跳过掩码断言。）

---

## v0.6.13：富媒体消息能带文本了（replyImage 的 text 选项）

一个小功能，解一个真痛点：图片和说明文字以前只能分两条消息发——
先发图、再补一句出处，群里看着是两截，还多占一条发送额度。

QQ 官方的富媒体消息（msg_type=7）本来就自带 `content` 文本字段，
框架以前把它硬编码成一个空格。这版把它开放出来：

    await msg.replyImage(file, { local: true, text: '横图 2290×1200' });

文字和图走同一条消息。不传 `text` 行为和以前完全一样（占位空格），
现有插件不受影响。

同批更新：

- 测试夹具（testkit）的假 `replyImage` 会记录 `text`，插件测试终于能
  断言「图文没有分两条发」
- 插件 anime-img v2.0.0 用上了这个能力：出处（横/竖图 + 尺寸）和图
  同条发出，图源从 Lolicon 换成夜轻 ACG API（api.yppp.net）。
  **发布顺序注意**：必须先发这版框架再推插件，否则插件仓库 CI 红

### 测试

单测 365 / e2e 152 / 真机驱动 18 → 合计 **535**。
（e2e 另有 1 项按环境跳过：本机没填 AppSecret 时跳过掩码断言。）

---

## v0.6.12：全仓库自查，把「叫法」和「文档」跟实现对齐

这版没有新功能。两个仓库各做了一遍全量自查，把发现的不一致修掉。

### 修：`--help` 和 `/help` 里还叫「QQ 机器人内核」

项目早定名「栖 Roost」，定位也明确是**框架**不是内核，但面向用户的文本没跟上：

- `node src/main.js --help` 的标题还是「QQ 机器人内核」
- 群里发 `/help 基础`，回来的标题是「内核 · 基础」
- `/admin levels` 里 4–9 级写着「内核预留」
- 面板「权限」页的等级说明、日志来源筛选的下拉，也是「内核」

一共 8 处，统一成「框架」。代码注释和 `docs/` 里的「内核」没动——那些指的是
「框架核心层 vs 插件层」这个技术区分（`ctx.CORE_LEVELS` 这类 API 名字本身就叫 CORE），
不是项目定位，改了反而看不懂。`docs/GitHub同类项目调研.md` 里「cordis 内核」
说的是 Koishi，更不能动。

### 修：README 里没有「按群开关插件」

0.6.11 的主打功能，README 里一个字都没提——特性列表没有，「命令速查」里也没有
`/群插件`。装了新版的人不知道有这个开关，等于白做。已补进两处。

### 修：自查记录停在 v0.6.5，测试数字还是 448

`docs/代码自查记录.md` 是累积文档，但 v0.6.6 之后六个版本一节都没记，
末尾的测试统计还写着「282 / 148 / 18 = 448」，实际早就是 363 / 152 / 18 = 533。

补了第二十三节，按版本记了这六次迭代（面板昵称与群名、凭据扫描、多插件回复合并、
配置表单与更新校验、按群开关），末尾接本次全量自查的结论。

### 同批：插件仓库（kun 4.1.3）

- kun README 标题还停在 `v4.0`，实际 4.1.2；指令表里也没有 OP
- 插件仓库 README 的 `runtime` 写的是「`node`（内建）/ `python` / `exec`」——
  漏了 `go`；而且 `runtime: "node"` 指的是**外部** node 子进程，
  内建插件是 `index.js`，根本没有 `plugin.json`，也就没有这个字段
- `index.json` 里 `frameworkVersion` 三种形态混着（空串 / 字段缺失 / 有值），
  统一成「声明了才写」，以后新插件也不会再冒出空串

### 自查确认没问题的

| 项 | 结论 |
|---|---|
| 哈希算法 | `src/hashdir.js` 与插件仓库 `scripts/build-index.mjs` 逐字节一致，**都做了 CRLF→LF 归一化**，Windows 检出后哈希不会误判 |
| 仓库边界 | 框架不跟踪 `plugins/`，插件全部在插件仓库 |
| 面板接口 | 前端调用的 37 个接口全部能对上后端路由（含 `/api/plugins/:id/groups` 等动态路由） |
| 菜单 | `/help` 由 registry 自动生成，不存在手写菜单过期；13 条 core 命令全有 `desc` |
| 凭据 | 65 个文件扫描无硬编码密钥 |
| 许可 | 两仓库同一份 v2.0 协议，无商业授权入口 |

### 测试

单测 363 / e2e 152 / 真机驱动 18 → 合计 **533**。
（e2e 另有 1 项按环境跳过：本机没填 AppSecret 时跳过掩码断言。）
