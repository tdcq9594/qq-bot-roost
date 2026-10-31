# 栖 Roost / qq-bot-roost 独立安全审计报告

- **审计对象**：零依赖 QQ 官方机器人框架「栖 Roost」(`src/` 全量静态审计)
- **审计视角**：CSO 独立安全审计，方法论 = OWASP Top 10 + STRIDE 威胁建模
- **日期**：2025-10-25
- **范围**：8 条清单 —— 凭证存储与内存 / Webhook 验签 / 面板认证 / SSRF / 插件隔离 / NDJSON 协议 / 实例互斥与权限 / 供应链
- **方法边界**：纯静态代码审计 + git 历史核验。**未做动态渗透、未运行实例、未触发真实网络请求**。结论基于代码逻辑证据，置信度高的事项标注「已验证」。

---

## 一、执行摘要

框架整体安全工程水平**高于同类开源机器人项目**。敏感凭证的 Ed25519 验签、面板 `timingSafeEqual` + 同源 + Content-Type 精确匹配、子进程环境变量白名单、供应链 sha256 + 解压炸弹防护、权限模型无自提权路径、4902 实例互斥——这些都是**已实现且经代码核实**的强控制。

**真实风险集中在「配置安全」与「信任边界一致性」两类**：
1. 面板绑定非 loopback 但**未强制** accessKey 时，远程可完全控制（含插件安装 → RCE）。默认安全 + doctor 软告警，但**无硬阻断**。
2. 插件依赖安装（`deps.js`）**未复用**子进程的 env 白名单，把完整环境（含 AppSecret/accessKey）泄漏给 `pip install`/`npm install` 进程，与文档宣称的「彻底隔离」矛盾。

其余均为低危残留（回放窗口、loopback SSRF、密钥走 query string、CSRF 仅挡浏览器跨站、密钥无爆破限速），不构成默认可用风险。

---

## 二、STRIDE 威胁建模总览

| 维度 | 结论 | 关键证据 | 对应发现 |
|------|------|----------|----------|
| **Spoofing 仿冒** | 强 | Webhook 事件全量 Ed25519 验签(`sign.js:99-130`)；面板 accessKey 常量比较(`server.js:187-196`) | F-01（无 key+暴露时仿冒成立） |
| **Tampering 篡改** | 强 | 验签覆盖原始 body 字节(`webhook.js:194-206`)；配置原子写 tmp+rename(`config.js`) | — |
| **Repudiation 抵赖** | 中 | 日志环形缓冲+脱敏(`runtime.js:1-40`)，但非防篡改、无签名 | 信息项 |
| **Info Disclosure 信息泄露** | 中 | 明文落盘 by design(`config.js`)；`deps.js:35` 泄漏 env | F-02、F-03、F-04 |
| **DoS 拒绝服务** | 强 | body 上限(webhook 1MB `webhook.js:23`/面板 256KB `server.js:70`)、SSE ≤32(`server.js:248`)、gzip 炸弹 64MB 上限(`tarball.js:173-179`) | — |
| **Elevation 提权** | 强 | 权限无自提权路径(`main.js:525-552`)、4902 互斥(`instance.js:83-114`)、env 白名单(`subprocess.js:14-45`) | F-01（无 key+暴露直接最高权限） |

## 三、OWASP Top 10 映射

| # | 类别 | 结论 | 关联发现 |
|---|------|------|----------|
| A01 | 失效的访问控制 | 默认安全，配置错误时严重 | F-01、F-05 |
| A02 | 密码学失效 | 无（Ed25519/常量比较/timingSafeEqual 正确） | — |
| A03 | 注入 | 无（无 SQL、路径穿越全防护、NDJSON 安全解析） | — |
| A04 | 不安全设计 | 回放窗口可收紧 | F-06 |
| A05 | 安全配置错误 | 暴露未强制 key、密钥走 query | F-01、F-04 |
| A06 | 易受攻击组件 | 零依赖，自身风险极低（插件依赖除外） | F-02 |
| A07 | 身份鉴别失败 | 无 key 爆破限速 | F-09 |
| A08 | 软件数据完整性 | 强（sha256 多层校验） | — |
| A09 | 安全日志监控 | 强（脱敏、不落密钥） | — |
| A10 | SSRF | 基本封堵，残留 loopback | F-03 |

---

## 四、八条清单逐条核验

### 清单 #1 凭证存储与内存 —— ✅ 基本安全，1 处泄漏
- 落盘：`config/bot.json` 明文存 AppSecret，但 `git check-ignore` 已确认被忽略，`git ls-files` 无凭证入库，`git log` 无泄露历史。**已验证**。
- 日志：调度层 `runtime.js` `SENSITIVE_KEY` 正则 + `ext` 隐藏 + 400 字符截断脱敏。**已验证**。
- 内存：`token.js:13` 在内存持有 appSecret，无 swap 锁（信息项，可接受）。
- **泄漏点 → F-02**（`deps.js:35` 依赖安装继承全量 env）。

### 清单 #2 Webhook 验签 —— ✅ 全部正确
- 种子：`seedFromSecret` 32 字节循环填充/截断(`sign.js:25-32`)，与官方定制 Ed25519 一致。**已验证**。
- 全事件验签：`verifyEventSignature` 对**每个**事件验签（非仅 op=13），覆盖原始 body 字节(`webhook.js:194-206`)。**已验证**。
- 防重放：300s 窗口 + 有限数字校验(`sign.js:103-106`)。
- 畸形 body：`readBody` 错误返回 `''`，`JSON.parse` 失败 → 400，不崩溃(`webhook.js:166-172`)。**已验证不崩**。
- X-Bot-Appid 绕过：**不成立**。`this.bots.get(appId)` 需先 `register` 且带 `secret`(`webhook.js:53-59`)；分流后仍需有效签名(`webhook.js:194-206`)。**已验证无绕过**。

### 清单 #3 面板认证 —— ⚠️ 实现强，但有配置缺口
- accessKey 强度：用户自设（`config.js:27` 默认空，无自动生成）。常量比较 `crypto.timingSafeEqual`(`server.js:187-196`)。**已验证**。
- CSRF/同源：写操作**精确** `application/json`（修复 `text/plain;application/json` 绕过）(`server.js:406-409,548-550`)；同源校验在**路由前**(`server.js:543-553`)。**已验证**。
- Content-Type 精确匹配、?source= 经 `assertSafeIndexUrl` —— **已验证**。
- 是否强制 127.0.0.1：**否**。默认 `127.0.0.1`(`server.js:241`)，但用户可设 `0.0.0.0`；此时若 `accessKey` 为空，`authorized()` 直接 `return true`(`server.js:389`)。 doctor 仅软告警(`doctor.js:172-178`)，**无硬阻断** → **F-01**。

### 清单 #4 SSRF —— ⚠️ 基本封堵，残留 loopback
- 市场 `?source=` → `fetchIndex` → `assertSafeIndexUrl` 仅放行 https / loopback-http(`market.js:44-60,1213`)。**已验证**。
- **残留**：loopback http 被放行 → 若面板可达，攻击者可探测本机服务、读取返回的 JSON → **F-03**（低危，受 accessKey 门控）。

### 清单 #5 插件隔离 —— ⚠️ 子进程好，依赖安装破
- `isSafeId` 防穿越(`server.js:176-181`)、子进程路径穿越双重校验(`server.js:1146-1154`)。**已验证**。
- 子进程 env 白名单 `ENV_ALLOW` **不含** AppSecret/accessKey/webhook 配置(`subprocess.js:14-45,127-129`)。**已验证机密不泄漏给插件运行时**。
- **破口**：`deps.js:35` 依赖安装用 `{...process.env, ...env}` 继承**全部**环境变量（含 `QQ_BOT_SECRET`/`ROOST_WEBUI_KEY`）。恶意依赖的 install hook 可窃取 → **F-02**。

### 清单 #6 NDJSON 协议 —— ✅ 安全
- 子进程**只能 reply/push**，不能自调 API；`handle()` 按 chatId 串行；level 由宿主下发且子进程无法越权调 api；每插件独立宿主，无法读其他机器人数据或全局 config。**已验证无越权/伪造路径**。

### 清单 #7 实例互斥与权限 —— ✅ 安全
- 4902 互斥：`claimInstance` 默认 `force=false`(`bot.js:252` 调用无 force)，`inProcessClaims` + `prune` 防同进程/跨进程双连(`instance.js:83-114`)。**已验证**。
- 权限提权：`/admin set` 拒绝授予 owner(`lv===LEVEL.owner`)、`actor>manager` 需群管、双重防越权(`lv<=actor`、`cur<=actor`)(`main.js:525-552`)。`parseLevel` 用 `Object.hasOwn` 防原型链注入。**已验证无提权路径**。

### 清单 #8 供应链 —— ✅ 强
- tarball sha256 校验（`index.sha256` 或 `expectSha256`）(`tarball.js:152-166`)。
- 解压炸弹：`gunzipSync({maxOutputLength:64MB})`(`tarball.js:173-179`)。
- 路径穿越：跳过 tar 符号链接类型、越界 entry `continue`(`tarball.js:58-59,94`)。
- npm `--ignore-scripts`、pip `requirements.txt` 拒绝 `-e/--index-url/git+/URL`(`deps.js`)。**已验证**。

---

## 五、发现清单（结构化）

### [F-01] 🟠 面板暴露非 loopback 时未强制 accessKey（远程接管/RCE）

> **状态：已修复（2026-10-31 复核）。** `src/web/server.js:381` 现在是**启动期硬阻断**：`webui.host` 非 loopback 且未设 `accessKey` 时直接拒绝启动并打印修复指引，不再是 doctor 软告警。下面保留审计当时（2025-10-25）的原始记录，作为背景。

- **类别**：OWASP A01 / A05；STRIDE Spoofing+Elevation
- **位置**：`src/web/server.js:241`（默认 127.0.0.1）、`src/web/server.js:389`（`if (!accessKey) return true`）、`src/config.js:27`（accessKey 默认空）
- **问题描述**：`authorized()` 在 accessKey 为空时**无条件放行**。若运维把 `webui.host` 设为 `0.0.0.0` 却忘记设 key，面板在全部网卡开放且**零认证**。此时远程攻击者可：新建/删除机器人、改配置、调 `/api/market/install` 安装任意插件（插件代码在子进程执行 = RCE）、`/api/shutdown` 关停。doctor 仅软告警(`doctor.js:172-178`)，**无启动期硬阻断**。
- **CWE 参考**：CWE-306（缺失认证）、CWE-862（缺失授权）
- **置信度**：9/10（代码逻辑确定；默认配置安全，风险依赖误配）
- **修复建议**：
  1. 启动时若 `host` 非 loopback 且 `accessKey` 为空，**拒绝监听**并打出醒目错误，或
  2. 首次运行**自动生成强随机 accessKey**（如 `crypto.randomBytes(24)`）写入 `config/bot.json` 并打印到控制台；
  3. 在 `/api/*` 之外也保留 doctor 告警。

### [F-02] 🟠 插件依赖安装泄漏全量环境变量（含 AppSecret）
- **类别**：OWASP A06 / A02；STRIDE Info Disclosure
- **位置**：`src/plugin/deps.js:35`（`env: { ...process.env, ...env }`）
- **问题描述**：子进程运行时已用 `ENV_ALLOW` 白名单隔离机密(`subprocess.js:14-45`)，但**依赖安装阶段**把整个 `process.env`（含 `QQ_BOT_SECRET`、`ROOST_WEBUI_KEY`、`ROOST_WEBHOOK_*`）传给 `pip`/`npm` 进程。恶意插件可在 `requirements.txt`/`package.json` 中放置安装期执行代码（setup.py、install hook、恶意 wheel），借完整 env 外泄 AppSecret，与文档「彻底隔离」承诺矛盾。
- **CWE 参考**：CWE-732（错误权限赋值）、CWE-200（信息暴露）
- **置信度**：9/10（代码确定；触发需恶意依赖，属信任边界内风险）
- **修复建议**：依赖安装构建与子进程同源的**净化 env**：复用 `inheritedEnv()` 白名单，仅额外追加 pip/npm 必需的 `HTTP_PROXY`/`HTTPS_PROXY`/`PIP_INDEX_URL` 等显式变量，绝不透传 `QQ_*`/`ROOST_*`。

### [F-03] 🟡 SSRF 残留：loopback http 市场地址被放行
- **类别**：OWASP A10；STRIDE Info Disclosure
- **位置**：`src/plugin/market.js:42-55`（`LOOPBACK_HOSTS` 放行 http）、`src/web/server.js:1213`（`?source=` 透传）
- **问题描述**：`assertSafeIndexUrl` 允许 `http://localhost|127.0.0.1|::1`。若面板可达，攻击者可令服务端对内网本机服务发起请求并读取 JSON 响应（端口探测 / 读本地元数据类服务）。受 accessKey 门控，实际利用需先过认证。
- **CWE 参考**：CWE-918
- **置信度**：8/10
- **修复建议**：默认仅放行 https；loopback http 改为**显式开发开关**（如 `config.network.allowLocalIndex`），生产默认关闭；或把 loopback 限定为 `127.0.0.1` 单地址。

### [F-04] 🟡 accessKey 接受 query string 传递（落日志/代理/历史）
- **类别**：OWASP A05；STRIDE Info Disclosure
- **位置**：`src/web/server.js:394-395`（`?key=`/`?token=`）、`src/web/server.js:1726`
- **问题描述**：密钥除 `X-Access-Key` 头外，也接受 URL query 参数。query 会出现在访问日志、反向代理日志、浏览器历史，扩大泄露面。
- **CWE 参考**：CWE-598（敏感数据置于 query string）
- **置信度**：9/10
- **修复建议**：移除 query 密钥支持，仅保留 `X-Access-Key` 头；前端 URL 拼接(`server.js:1726`)同步去除。

### [F-05] 🟡 同源校验对「无 Origin/Referer」请求放行（仅挡浏览器跨站）
- **类别**：OWASP A01；STRIDE Elevation
- **位置**：`src/web/server.js:416-429`（`isSameOrigin` 无头即 `return true`）
- **问题描述**：`isSameOrigin` 仅在 Origin/Referer 存在且 host 不符时拒绝。非浏览器客户端（curl）不带这两个头 → 直接通过。CSRF 防护因此**只对浏览器跨站请求有效**；配合 `application/json` 可绕过同源的仍可被 curl 类工具绕过。与 F-01 叠加即远程无 key 可控。
- **CWE 参考**：CWE-352（CSRF 残留）
- **置信度**：8/10
- **修复建议**：同源校验与 accessKey 解耦——只要 `accessKey` 已设置，所有写操作**必须**带 `X-Access-Key`；彻底移除 query 密钥后，无 key 暴露场景被 F-01 硬阻断兜底。

### [F-06] 🟡 Webhook 重放窗口内可重放（无事件级 nonce）
- **类别**：OWASP A04；STRIDE Repudiation
- **位置**：`src/sign.js:99-106`（300s 窗口，仅时间戳）
- **问题描述**：签名载荷为 `${timestamp}${rawBody}`，QQ 事件体本身不含唯一 nonce 进入签名域。在 300s 窗口内截获的合法事件可被**原样重放**（同事件二次触发）。影响有限（重复处理、非跨事件伪造）。
- **CWE 参考**：CWE-294（认证消息重放）
- **置信度**：7/10（取决于平台是否在 body 内置 nonce）
- **修复建议**：若平台事件含 `id`/`d.id`，将其纳入签名验证比较；或对高敏机器人缩短 `toleranceSec`（如 60s）。

### [F-07] 🟡 插件页面 HTML 在面板同源 iframe 渲染（信任边界 XSS）
- **类别**：OWASP A03/信任边界；STRIDE Tampering
- **位置**：`src/web/server.js:950-975`（`/api/pages/:key/html` 返回插件 HTML）
- **问题描述**：插件作者 HTML 直接在面板源内 iframe 渲染，可访问面板同源能力。属「外部插件=可信代码」的设计信任边界，但低质量/被入侵插件可 XSS 面板、窃取面板内展示的 masked 配置或借已认证会话调 API。
- **CWE 参考**：CWE-79（同源 XSS 面）
- **置信度**：7/10
- **修复建议**：插件页面以 `sandbox` 属性（无 `allow-same-origin`）或独立子域/端口渲染；文档明示「第三方插件等同本地代码」警告。

### [F-08] 🟡 插件可自控 `manifest.env` 注入子进程环境
- **类别**：OWASP A05；STRIDE Elevation（信息项）
- **位置**：`src/plugin/subprocess.js:129`（`...(this.manifest.env ?? {})`）
- **问题描述**：`manifest.env` 由插件作者控制并合并进子进程 env。插件无法读到宿主机密（白名单隔离），但可自设任意环境变量（如 `HTTP_PROXY` 重定向流量）。预期行为，仅作信任边界记录。
- **CWE 参考**：CWE-269
- **置信度**：8/10
- **修复建议**：文档化；对 `manifest.env` 做键名白名单（禁止 `ROOST_*`/`QQ_*` 前缀）以防误配覆盖。

### [F-09] 🟡 accessKey 无暴力破解限速
- **类别**：OWASP A07；STRIDE Elevation
- **位置**：`src/web/server.js:388-397`（`authorized` 每请求校验，无失败计数）
- **问题描述**：`timingSafeEqual` 防时序攻击，但**无**失败次数/IP 限速。若用户设置弱 key，攻击者可顺序猜测。默认无 key 时此点不适用（F-01 兜底）。
- **CWE 参考**：CWE-307（认证尝试次数缺失）
- **置信度**：7/10
- **修复建议**：对 `/api/*` 鉴权失败加 per-IP 滑动窗口限速（如 5 次/分钟封禁）；建议 accessKey 最小长度 16。

---

## 六、已验证安全项（无发现，记录以证审计覆盖）

- Ed25519 种子 32 字节推导正确（`sign.js:25-32`）
- 全事件（含普通事件）Ed25519 验签、300s 防重放（`sign.js:99-130`,`webhook.js:194-206`）
- 畸形 webhook body 不崩溃（`webhook.js:166-172`）
- 面板 `timingSafeEqual` 常量比较（`server.js:187-196`）
- 写操作 Content-Type 精确匹配 + CSRF 在路由前（`server.js:406-409,543-553`）
- accessKey/appSecret 不回显（`server.js:670-675`）
- 静态文件 path traversal 防护（`server.js:1660-1691`）
- 插件 id `isSafeId` + 路径穿越双重校验（`server.js:1146-1154`）
- 子进程 env 白名单不含机密（`subprocess.js:14-45`）
- NDJSON 子进程仅 reply/push，无越权调 api / 跨机器人访问（协议层核验）
- 权限模型无自提权路径（`main.js:525-552`）
- 4902 实例互斥默认生效（`instance.js:83-114`，`bot.js:252` 调用无 force）
- 供应链 sha256 + 64MB 炸弹上限 + tar 符号链接跳过 + 路径穿越 continue（`tarball.js:58-59,94,152-179`）
- 凭证 gitignore + 无历史泄露（`git check-ignore` / `git ls-files` / `git log` 核验）

---

## 七、局限说明

1. **静态审计**：本报告基于源码逐行审查与 git 历史核验，未运行二进制、未发起真实网络请求、未做动态模糊测试。
2. **未做渗透**：未对运行实例做端口探测、未尝试真实构造签名/伪造请求验证运行时行为；F-01/F-03/F-05 的「可达性」依赖部署配置，默认配置下不可达。
3. **信任边界假设**：外源插件市场、第三方插件、被设为 `webhook.verifySignature=false` 均视为用户自担风险边界（与 `SECURITY.md` 一致），审计仅评估框架自身的默认防护是否到位。
4. **加密实现未做侧信道实测**：Ed25519 验签依赖 Node 内置 `crypto.verify`（常量时间），未独立侧信道测量。
5. **置信度说明**：每条发现标注 0-10 置信度；≥8 为「逻辑确定、依赖部署」，7 为「高可能、部分需运行时确认」。
