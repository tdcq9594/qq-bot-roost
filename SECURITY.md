# 安全策略

## 支持范围

安全修复只针对最新版本。本项目还在 0.x 阶段，接口可能变动，请尽量跟最新代码。

---

## 上报漏洞

**不要公开提 Issue。**

请通过 GitHub 的 [私密漏洞报告](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) 功能提交，或在 Issue 页面联系维护者索取私密渠道。

报告请包含：

- 影响范围（哪些配置下可被利用）
- 复现步骤
- 可能的后果
- 你希望的修复方式（可选）

我们会在确认后回复，并在修复发布时致谢（除非你希望匿名）。

---

## 部署时你必须自己守住的三件事

这三条不是代码 bug，是使用方式的问题，但后果比 bug 严重。

### 1. `config/bot.json` 里的 AppSecret

它等同于机器人账号的密码。一旦泄露，别人可以冒充你的机器人。

- 这个文件已在 `.gitignore` 里，**提交前仍然要 `git status` 确认**
- 不要贴到 Issue、群聊、截图里
- 怀疑泄露时，立刻去 <https://q.qq.com> 重置 AppSecret

### 2. 面板的对外暴露

面板默认只监听 `127.0.0.1`，**这是安全的默认值**。

如果你把它改成 `0.0.0.0` 对外提供访问，**必须同时设置 `webui.accessKey`**：

```json
{
  "webui": {
    "host": "0.0.0.0",
    "accessKey": "一串足够长的随机字符串"
  }
}
```

面板没有登录态、没有会话管理，只有访问密钥校验。**没有密钥就对外暴露，等于把机器人配置交给整个网络**——包括改 AppID、启停插件、发消息的能力。

更稳妥的做法是用 Nginx/Caddy 加一层 HTTPS 和 Basic Auth。

### 3. 外部插件的信任边界

外部插件是**独立子进程，用任意语言写的**，能力等同于在你这台机器上运行程序。

- 只安装你信任来源的插件
- 插件的 `requirements.txt` / `package.json` 会触发自动安装，等于执行第三方包的安装脚本
- 不放心就设 `plugins.autoInstallDeps = false`，自己审一遍再装

内建插件（`index.js`）跑在主进程里，**能读到全部内存和配置**，风险更高。来源不明的一律不要放进 `plugins/`。

---

## 已知的安全设计

| 项 | 现状 |
|----|------|
| 面板 CSRF | 写操作强制 `Content-Type: application/json`，跨站表单过不了预检 |
| 面板路径穿越 | 静态文件用 `path.relative` 校验，跑出 `web/` 目录直接 403 |
| 凭证存储 | 明文存在 `config/bot.json`，靠文件系统权限保护。**没有加密** |
| 日志脱敏 | `runtime.sanitizePayload()` 会脱敏事件报文，但插件自己打的日志不保证 |
| 权限校验 | 服务端按作用域×等级判定，不信任客户端 |

---

## 不在范围内的

- 官方 QQ 接口本身的安全问题（请报给腾讯）
- 用户自己改坏配置导致的故障
- 用户安装了恶意插件导致的后果
