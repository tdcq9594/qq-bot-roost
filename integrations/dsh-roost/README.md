# dsh-roost

在 [DeepSeek Harness](https://deepseek-harness.github.io/) 里管理 **栖 Roost** QQ 机器人。

装好之后，你可以直接对 DSH 说：

> 机器人现在在线吗？收了多少消息？
> 看看最近的报错日志
> 把 dice 插件禁用了
> 重连一下网关

DSH 会调对应的工具，通过 Roost 面板的 REST API 操作。

---

## 前提

**栖 Roost 必须正在运行。** 这个插件不把 Roost 塞进 DSH 进程——Roost 是个
独立的长驻进程（连 QQ 网关、跑插件），插件只是通过它的面板 API 对话：

```
DSH（AI 调工具）── HTTP ──> Roost 面板 :15207 ──> 机器人
```

没运行时，工具会返回一句人话（「连不上…可能没在运行」），而不是一堆报错。

---

## 安装

### 方式一：从本地目录（开发/试用）

```bash
dsh plugin --profile desktop add /path/to/qq-bot-roost/integrations/dsh-roost
```

### 方式二：从 GitHub

**目前装不了。**

`dsh plugin add github:...` 会把整个仓库当成一个插件包，但插件的
`package.json` 在 `integrations/dsh-roost/` 子目录里，而 pnpm 的 git
依赖没有可靠的「指定子目录」语法。

要支持这种方式，得把插件拆成独立仓库（`tdcq9594/dsh-roost`）。
在那之前用方式一。

### 方式三：从 npm（发布后可用）

```bash
dsh plugin --profile desktop add dsh-roost
```

装完**重启 DSH**（或刷新 web 界面）。

---

## 配置

默认配置在 `cordis.patch.yml` 里，一般不用改：

```yaml
- insert:
    - id: dsh-roost
      name: dsh-roost
      config:
        baseUrl: http://127.0.0.1:15207
        accessKey: ''
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | Roost 面板地址。**端口可能不是 15207**——被占用时 Roost 会自动换端口，看启动日志里那行「可视化面板: http://…」 |
| `accessKey` | 面板设了 `webui.accessKey` 才需要填。默认不校验 |

要改的话，在你自己 profile 的 `cordis.patch.yml` 里覆盖这一行
（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`）。

---

## 六个工具

### 只读（可以并发调）

| 工具 | 干什么 |
|---|---|
| `roost_status` | 在线状态、收发消息数、重连次数、插件数、凭证剩余时间 |
| `roost_plugins` | 插件列表，含「启用/未加载/已禁用」和加载错误 |
| `roost_logs` | 最近日志，可按级别过滤（`error` 只看问题） |

### 写操作（会改真实状态）

| 工具 | 干什么 | 风险 |
|---|---|---|
| `roost_plugin_toggle` | 启用/禁用插件 | 立即生效并写回配置 |
| `roost_send` | 用机器人发消息 | **群里的人会看到**，有频次限制 |
| `roost_reconnect` | 重连 QQ 网关 | 重连期间几秒收不到消息 |

---

## 调试

装完没反应，按这个顺序查：

**1. 插件加载了吗**

DSH 里 `dsh plugin --profile desktop list`，应该能看到 `dsh-roost`。
启动日志里应该有一行：

```
[dsh-roost] 已注册 6 个工具，面板地址 http://127.0.0.1:15207
```

没有这行 → 插件没加载，检查 `cordis.patch.yml` 的 `name` 是否和 `package.json` 的 `name` 一致。

**2. 工具能用吗**

让 DSH 调 `roost_status`。如果返回「连不上…」：

```bash
# 确认 Roost 在跑，端口对不对
curl http://127.0.0.1:15207/api/status
```

**3. 端口不对**

Roost 启动日志里找这一行：

```
INFO [webui] 可视化面板: http://127.0.0.1:15207/
```

把实际端口填进 `baseUrl`。

---

## 为什么不做成「把 Roost 装进 DSH」

技术上不行，也不该做：

- Roost 要连 QQ 网关、维持长连接、跑子进程插件，是个**常驻服务**
- DSH 插件是**跑在 DSH 进程内**的扩展，生命周期跟着 DSH 走
- 把常驻服务塞进编辑器进程，DSH 一关机器人就掉线

所以这里选的是**进程间通信**：各自独立，互不拖累。

---

## 许可

跟 栖 Roost 一致：**永久免费，禁止任何收费，禁止商业使用**。
见仓库根目录的 [LICENSE](../../LICENSE)。
