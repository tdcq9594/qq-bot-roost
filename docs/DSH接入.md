# DSH 接入指南

把 **栖 Roost** 接进 [DeepSeek Harness](https://deepseek-harness.github.io/)，之后可以直接
对 AI 说话管理机器人，不用切面板：

> 机器人现在在线吗？收了多少消息？
> 看看最近的报错日志
> 把 dice 插件禁用了
> 重连一下网关

---

## 它是怎么工作的

**不是**把 Roost 塞进 DSH 进程，而是让两边通过 HTTP 对话：

```
┌─────────────────┐         ┌──────────────────┐        ┌──────────┐
│ DeepSeek Harness│  HTTP   │  Roost 面板      │        │  QQ 网关 │
│  AI 调工具      │ ──────> │  127.0.0.1:15207 │ ─────> │          │
└─────────────────┘         └──────────────────┘        └──────────┘
```

**为什么不做成「装进 DSH」**：

| | 栖 Roost | DSH 插件 |
|---|---|---|
| 形态 | 常驻服务（连网关、跑子进程插件） | 跑在 DSH 进程内的扩展 |
| 生命周期 | 一直跑，断线自己重连 | 跟着 DSH 启停 |

把常驻服务塞进编辑器进程，DSH 一关机器人就掉线。所以选进程间通信，
各自独立，互不拖累。

---

## 前提

1. **DSH 已装好**（桌面版或 web 版都行）
2. **栖 Roost 正在运行** —— 插件调的是它的面板 API
3. 知道 Roost 的**面板端口**（默认 15207，但被占用时会自动换）

确认 Roost 在跑：

```bash
curl http://127.0.0.1:15207/api/status
```

返回一段 JSON 就对了。返回「连接被拒绝」说明 Roost 没启动，或端口不是这个。

**端口在哪看**：Roost 启动日志里有这一行——

```
INFO  [webui] 可视化面板: http://127.0.0.1:15207/
```

如果显示的是 15208、15209，就以日志为准。

---

## 安装

插件在仓库的 `integrations/dsh-roost/` 目录。

### 方式一：本地目录（推荐，确定可用）

```bash
npx @deepseek-ai/dsh plugin --profile desktop add "/绝对路径/qq-bot-roost/integrations/dsh-roost"
```

Windows 路径要加引号：

```bash
npx @deepseek-ai/dsh plugin --profile desktop add "C:\Users\你的用户名\qq-bot-roost\integrations\dsh-roost"
```

> `--profile` 后面填你的 profile 名。桌面版通常是 `desktop`，
> 不确定就看 `~/.dsh/profiles/` 下有哪些目录。

### 方式二：从 npm（尚未发布）

```bash
npx @deepseek-ai/dsh plugin --profile desktop add dsh-roost
```

> 包已经准备好了（`integrations/dsh-roost/`），但还没发到 npm。
> 发布之后这条命令才可用。

### 方式三：从 GitHub

```bash
npx @deepseek-ai/dsh plugin --profile desktop add github:tdcq9594/qq-bot-roost
```

**这条目前装不了。** 原因：`dsh plugin add github:...` 会把整个仓库当插件包，
但插件的 `package.json` 在 `integrations/dsh-roost/` 子目录里，
而 pnpm 的 git 依赖没有可靠的「指定子目录」语法。

要支持这种方式，得把插件拆成独立仓库（`tdcq9594/dsh-roost`）。
**在拆之前，用方式一。**

---

## 配置

默认配置就在插件里，一般不用改：

```yaml
# integrations/dsh-roost/cordis.patch.yml
- insert:
    - id: dsh-roost
      name: dsh-roost
      config:
        baseUrl: http://127.0.0.1:15207
        accessKey: ''
```

| 字段 | 什么时候要改 |
|---|---|
| `baseUrl` | Roost 面板端口不是 15207 时。**看启动日志里那行真实端口** |
| `accessKey` | Roost 配了 `webui.accessKey` 时。默认不校验，留空即可 |

### 改配置的两种方式

**A. 改插件自己的 patch 文件**（重新 `add` 一次生效）

直接编辑 `integrations/dsh-roost/cordis.patch.yml`，然后重新执行一次 `add`。

**B. 改你的 profile**（不碰插件代码，推荐）

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，加一行覆盖：

```yaml
- insert:
    - id: dsh-roost
      name: dsh-roost
      config:
        baseUrl: http://127.0.0.1:15208   # 你的真实端口
        accessKey: ''
```

> 注意：配置是**整行替换**，不是深合并。所以两个字段都要写全。

---

## 六个工具

### 只读（可并发调用）

| 工具 | 参数 | 返回什么 |
|---|---|---|
| `roost_status` | 无 | 在线状态、收发消息数、重连次数、插件数、凭证剩余时间、版本 |
| `roost_plugins` | 无 | 每个插件的 id/版本/启用状态/加载状态/错误 |
| `roost_logs` | `level`、`limit` | 最近日志，`level` 填 `error` 只看问题 |

### 写操作（会改真实状态）

| 工具 | 参数 | 后果 |
|---|---|---|
| `roost_plugin_toggle` | `id`、`action` | 立即启用/禁用并写回配置 |
| `roost_send` | `scene`、`target`、`content` | **群里的人会看到**，有频次限制 |
| `roost_reconnect` | 无 | 重连期间几秒收不到消息 |

---

## 验证装好了没

### 第 1 步：插件加载了吗

```bash
npx @deepseek-ai/dsh plugin --profile desktop list
```

列表里应该有 `dsh-roost`。

DSH 启动日志里也应该有一行：

```
[dsh-roost] 已注册 6 个工具，面板地址 http://127.0.0.1:15207
```

**没有这行** → 插件没加载成功，跳到下面排查。

### 第 2 步：工具在不在

在 DSH 里问：

> 你有哪些 roost 相关的工具？

应该能列出 `roost_status`、`roost_plugins` 等 6 个。

### 第 3 步：能不能真用

> 调 roost_status 看看机器人状态

正常会返回类似：

```
测试机器人 · online（已连接网关）
收 12 条 / 发 7 条 · 重连 2 次
插件 4 个 · 已运行 1 小时 2 分
凭证剩余 3600 秒 · 版本 v0.5.5
```

---

## 排查

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `list` 里没有 dsh-roost | 安装没成功 / profile 名不对 | 确认 `--profile` 和 `~/.dsh/profiles/` 下的目录名一致 |
| 有插件但没那行 `[dsh-roost]` 日志 | `cordis.patch.yml` 的 `name` 和 `package.json` 的 `name` 不一致 | 两个都得是 `dsh-roost` |
| 工具调了返回「连不上…」 | Roost 没跑，或端口不对 | `curl http://127.0.0.1:15207/api/status` 试一下 |
| 返回「访问密钥不对」 | Roost 配了 accessKey | 填进配置的 `accessKey` |
| 返回「响应超时」 | Roost 进程卡住 | 去面板看日志，或重启 Roost |
| 工具报 schema 校验错 | 插件版本和 DSH 版本不匹配 | 提 issue 带 DSH 版本号 |

---

## 设计说明（给想看代码的人）

几个刻意的选择：

**错误翻译成人话。** 连不上时返回的是
「连不上 http://…，栖 Roost 可能没在运行」，而不是 `ECONNREFUSED`——
AI 看到后者只会瞎猜，看到前者才知道该建议你启动 Roost。

**失败不抛异常。** 所有工具返回 `{ ok: false, error: "…" }` 这种结构化结果。
抛异常会让工具调用直接中断，AI 拿不到原因。

**只读工具标了 `isConcurrencySafe`。** 查状态、查日志可以并发跑；
启停插件、发消息不行，它们是顺序的。

**零依赖。** 只用 Node 内置的 `fetch`，跟 Roost 本体一个原则。

---

## 后续

- [ ] 发到 npm，让 `dsh plugin add dsh-roost` 可用
- [ ] 拆独立仓库，支持 `github:tdcq9594/dsh-roost`
- [ ] 提交到 DSH 插件市场收录

---

## 本文档验证到哪一步

说清楚免得你照着做踩坑：

| 环节 | 验证情况 |
|---|---|
| 插件代码逻辑 | ✅ 实测：19 项测试全过（工具注册、结构、每个工具执行、错误翻译） |
| 包结构 | ✅ 实测：`npm pack` 通过，4 文件 8.1 kB |
| 版本约束 | ✅ 实测：`@deepseek-ai/dsh` 当前 latest 是 `0.2.1-rc.2`，落在 `>=0.2.0` 范围内 |
| 工具定义格式 | ⚠️ 照 `@perrylink/dsh-github`（同版本框架下能跑的插件）抄的，**未在真机校验** |
| `dsh plugin add` 安装 | ❌ **未实测**。开发机上 DSH 是纯 Electron GUI，`dsh` 不在 PATH；`npx @deepseek-ai/dsh` 首次要下载整个 CLI，180 秒没跑完 |

所以：**装的时候如果报错，把 DSH 的日志贴出来**，大概率是工具 schema 的细节要调。

`defineTool` 的真实校验只有 DSH 运行时才有，本地测不了——这也是为什么工具
都写得很保守（字段少、schema 简单、失败返回结构化结果而不是抛异常）。

---

## 许可

跟 栖 Roost 一致：**永久免费，禁止任何收费，禁止商业使用**。
见仓库根目录的 [LICENSE](../LICENSE)。
