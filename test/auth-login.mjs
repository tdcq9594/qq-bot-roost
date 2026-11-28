/**
 * 面板密码登录（2026-11-28）：真 HTTP 探针 + 兼容回归。
 *
 * 守的是两件事：
 *   1. 用户能输入密钥换会话，不必把密钥贴进网址（URL 会进历史 / Referer /
 *      反代 access_log，每条都是明文泄露面）；
 *   2. 老的 `?key=` 路径一行没动——dsh-roost 全仓没有 X-Access-Key 头，
 *      它的 api() / webuiUrl() 全靠 query，砍了就全挂。
 *
 * 这里起真实 server（临时端口 + mock），不用结构断言糊弄过去：登录这条链路
 * 涉及 Cookie、同源、限流三道闸门，只有真打 HTTP 才能验证顺序对不对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/** 注释里会提到 `?key=`（说明兼容性），断言只看真正会执行的代码 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** /api/login 必须在 authorized() 之前：没会话时才能换会话 */
test('接线：登录/登出路由在统一鉴权之前，且共享 authFails 限流', () => {
  const src = read('src/web/server.js');
  const atLogin = src.indexOf("pathname === '/api/login'");
  const atAuth = src.indexOf('if (!authorized(req, url, ptPage))');
  assert.ok(atLogin > 0 && atAuth > 0, '两条路由都要存在');
  assert.ok(atLogin < atAuth, '登录必须在鉴权之前，否则没会话时调不通');
  const block = src.slice(atLogin, atAuth);
  assert.match(block, /isJsonRequest\(req\)/, '写操作必须 application/json');
  assert.match(block, /isSameOrigin\(req\)/, '必须同源');
  assert.match(block, /authFails\.get\(ip\)/, '复用同一份 per-IP 失败计数');
  assert.match(block, /crypto\.randomBytes\(32\)/, '新 sid 防 fixation');
  assert.match(block, /Max-Age=0/, '登出要清 Cookie');
});

test('兼容：?key= 首跳、X-Access-Key 头、?pt= 页面令牌一条都没砍', () => {
  const src = read('src/web/server.js');
  assert.match(src, /url\.searchParams\.get\('key'\)/, 'authorized() 的 ?key= 分支');
  assert.match(src, /req\.headers\['x-access-key'\]/, 'X-Access-Key 头分支');
  assert.match(src, /pickPageToken\(url\)/, '插件页令牌');
  assert.match(src, /rest\.delete\('key'\)/, '首跳成功后清掉 URL 里的 key');
});

test('配置页有登录密码输入框，保存时两把钥匙分开提交', () => {
  const html = read('web/index.html');
  assert.match(html, /name="webuiLoginPassword"/, '配置页要能改登录密码，不只靠首次向导');
  assert.match(html, /name="webuiAccessKey"/, '机器密钥仍在配置页');
  const app = read('web/app.js');
  assert.match(app, /f\.webuiLoginPassword\.placeholder/, '占位要显示 已设置/未设置');
  const submits = [...app.matchAll(/webuiLoginPassword\?\.value\.trim\(\)/g)].length;
  assert.ok(submits >= 2, '两处保存路径都要带上 loginPassword');
});

test('401 页是密码表单，不再展示带密钥的网址', () => {
  const src = read('src/web/server.js');
  const at = src.indexOf("'<form id=\"loginForm\">'");
  assert.ok(at > 0, '必须有登录表单');
  const block = src.slice(at, at + 1400);
  assert.match(block, /type="password"/);
  assert.match(block, /autocomplete="current-password"/);
  assert.match(block, /<script src="\/login.js"/, 'CSP script-src self，不能内联脚本');
  assert.doesNotMatch(block, /\?key=你的密钥/, '不能再教用户把密钥贴进地址栏');
  assert.match(block, /X-Access-Key/, '说明里要写明旧脚本仍可用');
  const js = stripComments(read('web/login.js'));
  assert.match(js, /fetch\('\/api\/login'/, '表单要打登录接口');
  assert.doesNotMatch(js, /\?key=/, '登录脚本不能自己把密钥写进 URL');
});

/** 起一个临时端口的真实服务，跑完整登录链路 */
test('端到端：错误 key 401、正确 key 200+Cookie、Cookie 可用、logout 失效、跨站被拒', async (t) => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const picked = probe.address().port;
      probe.close((e) => (e ? reject(e) : resolve(picked)));
    });
  });
  const { startWebServer } = await import('../src/web/server.js');
  const KEY = 'test-panel-secret-abc123';
  const svc = await startWebServer({
    globalCfg: { webui: { host: '127.0.0.1', port, accessKey: KEY, portTries: 1, openBrowser: false } },
    runtimes: [],
    saveBotConfig: async () => {},
    saveGlobalConfig: async () => {},
    onBotAdd: async () => {},
    onBotRemove: async () => {},
    onShutdown: async () => {},
    mock: true,
  });
  t.after(() => svc.close());
  const base = `http://127.0.0.1:${port}`;
  const jsonPost = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  // 1. 首页无会话 → 401 HTML，是登录表单
  const page = await fetch(base + '/');
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.match(html, /id="loginForm"/);

  // 2. /login.js 未登录也能取到（静态文件在鉴权之外）
  const js = await fetch(base + '/login.js');
  assert.equal(js.status, 200);
  assert.match(await js.text(), /\/api\/login/);

  // 3. 错误 key → 401，且没有 Cookie
  const bad = await jsonPost('/api/login', { key: 'wrong-key' });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  // 4. 非 JSON body → 415
  const notJson = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'key=x',
  });
  assert.equal(notJson.status, 415);

  // 5. 跨站 Origin → 403（含 opaque origin 的插件页令牌也不能借道登录）
  const cross = await jsonPost('/api/login', { key: KEY }, { Origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  const opaque = await jsonPost('/api/login', { key: KEY }, { Origin: 'null' });
  assert.equal(opaque.status, 403);

  // 5b. 密钥只认 POST body：塞 header / URL 都不算登录
  const keyInHeader = await jsonPost('/api/login', {}, { 'X-Access-Key': KEY });
  assert.equal(keyInHeader.status, 401);
  const keyInUrl = await jsonPost('/api/login?key=' + encodeURIComponent(KEY), {});
  assert.equal(keyInUrl.status, 401);

  // 6. 正确 key → 200 + HttpOnly Cookie
  const ok = await jsonPost('/api/login', { key: KEY });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie') || '';
  assert.match(cookie, /^roost_sid=[a-f0-9]{64};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const sid = cookie.match(/^roost_sid=([a-f0-9]{64})/)[1];

  // 7. 带 Cookie 访问受保护接口 → 200（不再 401）
  const authed = await fetch(base + '/api/config', {
    headers: { Cookie: `roost_sid=${sid}` },
  });
  assert.notEqual(authed.status, 401, 'Cookie 要真的换来会话');

  // 8. ?key= 首跳照样工作（兼容没被砍）
  const legacy = await fetch(base + `/?key=${encodeURIComponent(KEY)}`, { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.match(legacy.headers.get('location') || '', /^\/$/, '首跳要把 key 从 URL 上清掉');
  assert.match(legacy.headers.get('set-cookie') || '', /roost_sid=[a-f0-9]{64}/);

  // 9. logout → 服务端 session 删除 + 清 Cookie；再用旧 sid 访问回 401
  const out = await jsonPost('/api/logout', {}, { Cookie: `roost_sid=${sid}` });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', /Max-Age=0/);
  const afterOut = await fetch(base + '/api/config', {
    headers: { Cookie: `roost_sid=${sid}` },
  });
  assert.equal(afterOut.status, 401, '登出必须删服务端 session，不是只清浏览器 Cookie');
});

/** 两把钥匙：人用 loginPassword（8+），机器用 accessKey（16+），互不串用 */
test('人/机凭证分流：登录只认 loginPassword，API 只认 accessKey，换凭证吊销旧会话', async (t) => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const picked = probe.address().port;
      probe.close((e) => (e ? reject(e) : resolve(picked)));
    });
  });
  const { startWebServer } = await import('../src/web/server.js');
  const KEY = 'machine-key-abcdefghijklmnop';
  const PASS = 'human-pass-123';
  const rt = { id: 'b', cfg: {}, plugins: {}, groups: {}, roles: {}, api: {}, metrics: { bump() {} } };
  const svc = await startWebServer({
    globalCfg: {
      webui: { host: '127.0.0.1', port, accessKey: KEY, loginPassword: PASS, portTries: 1, openBrowser: false },
      plugins: {},
    },
    runtimes: [rt],
    saveBotConfig: async () => {},
    saveGlobalConfig: async () => {},
    onBotAdd: async () => {},
    onBotRemove: async () => {},
    onShutdown: async () => {},
    mock: true,
  });
  t.after(async () => {
    const closed = new Promise((resolve) => svc.server.once('close', resolve));
    svc.close();
    await closed;
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  // 人密码能登录；机器 key 不能当登录密码用（防止把长令牌贴进表单）
  assert.equal((await post('/api/login', { key: PASS })).status, 200);
  assert.equal((await post('/api/login', { key: KEY })).status, 401);

  // GET config 不回显两把钥匙，只给「设过没」
  const cfgRes = await fetch(base + '/api/config', { headers: { 'X-Access-Key': KEY } });
  const cfg = await cfgRes.json();
  assert.equal(cfg.webui.accessKey, '');
  assert.equal(cfg.webui.loginPassword, '');
  assert.equal(cfg.webui.loginPasswordSet, true);

  // 改登录密码：弱密码 400；强密码 200 且 credentialsChanged
  const put = (body) =>
    fetch(base + '/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Access-Key': KEY },
      body: JSON.stringify(body),
    });
  const bad = await put({ webui: { loginPassword: '123456' } });
  assert.equal(bad.status, 400);
  const changed = await put({ webui: { loginPassword: 'test-human-pass-456' } });
  assert.equal(changed.status, 200);
  const body = await changed.json();
  assert.equal(body.credentialsChanged, true);

  // 旧密码立即失效，新密码可用；机器 key 不受影响（API 仍能调）
  assert.equal((await post('/api/login', { key: PASS })).status, 401);
  assert.equal((await post('/api/login', { key: 'test-human-pass-456' })).status, 200);
  assert.notEqual((await fetch(base + '/api/config', { headers: { 'X-Access-Key': KEY } })).status, 401);
});

/** 本机无密钥模式：不该凭空多一道登录门，也不该让「空密码也能登」 */
test('无 accessKey 时不弹登录页，/api/login 也不开空门', async (t) => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const picked = probe.address().port;
      probe.close((e) => (e ? reject(e) : resolve(picked)));
    });
  });
  const { startWebServer } = await import('../src/web/server.js');
  const svc = await startWebServer({
    globalCfg: { webui: { host: '127.0.0.1', port, portTries: 1, openBrowser: false } },
    runtimes: [],
    saveBotConfig: async () => {},
    saveGlobalConfig: async () => {},
    onBotAdd: async () => {},
    onBotRemove: async () => {},
    onShutdown: async () => {},
    mock: true,
  });
  t.after(() => svc.close());
  const base = `http://127.0.0.1:${port}`;
  const page = await fetch(base + '/');
  assert.equal(page.status, 200, '没设密钥时首页照常进，不该弹登录页');
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'anything' }),
  });
  assert.equal(login.status, 401, '没有 accessKey 时不能开「空密码也能登」的门');
});
