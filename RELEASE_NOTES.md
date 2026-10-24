## v0.6.7：加凭据泄露检查

### 起因

`test/e2e.mjs` 里硬编码过**真实的 AppSecret**（webhook 测试要用它算签名），而仓库是公开的——等于把机器人凭证摆在明面上。那种行看起来和「随便一个测试字符串」没区别，人肉 review 抓不住。

代码里那三处已经换成 `e2e-fake-secret-not-a-real-key`。但**已经推到远端的旧提交里仍有该值，必须在 QQ 开放平台重置 AppSecret 才真正有效**。

### 新增：`scripts/check-secrets.mjs`

扫 `src/ web/ test/ scripts/ sdk/` 下所有 js/mjs/json/html/yml，找「键名像凭据 + 值够长 + 不像占位符」的赋值。

```bash
npm run check:secrets
```

判据故意做得**窄**：

- 键名只认 `appSecret` / `secret` / `access_token` / `apiKey` / `password` 这类
- 值的长度门槛 16 位（真实密钥都在 30 位以上）
- 纯数字不算（AppID、时间戳、端口）
- 含 `fake` / `test-` / `example` / `placeholder` 等词的放行

宁可漏报也不误报——**一个动不动就报错的检查，两天后就会被人加 `|| true` 绕过去，那还不如没有**。

输出只露密钥的头尾 4 位，不把完整值打进 CI 日志（那等于二次泄露）。

CI 里单独一个 job，而且跑得最早：真泄露了就别等测试跑完。

### 顺带清理

- 群档案里删掉了 `g-e2e` / `g-people` / `g-test` 三个假群（早期 e2e 写进真实配置的残留）
- 删掉 8 个 `groups.json.tmp-*` 残留文件（原子写中断留下的垃圾）

### 测试

单测 282 / e2e 148 / 真机驱动 18 / 凭据扫描，全绿。

### 许可

永久免费、禁止任何收费、禁止商业使用，见 [LICENSE](LICENSE)。不提供商业授权。
