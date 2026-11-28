/**
 * 面板密钥强度（2026-11-28）：纯函数 + 接线断言 + 真启动拒绝。
 *
 * 守的是：弱 key（如 123456）不再能当面板访问密钥——它等价于 RCE 权限，
 * 而 20 次/分钟的限流一天能吃 2.8 万次尝试，短口令挡不住。
 *
 * 依据 NIST SP 800-63B（长度优先、反对字符组合规则、黑名单查完整值）
 * 与 Gitea（MIN_PASSWORD_LENGTH 默认 8、PASSWORD_COMPLEXITY 默认 off）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const { MIN_KEY_LENGTH, WEAK_KEYS, checkKeyStrength, warnWeakKey } = await import(
  '../src/web/key-strength.js'
);

test('长度门槛：15 位失败、16 位通过，空串失败', () => {
  assert.equal(MIN_KEY_LENGTH, 16);
  assert.equal(checkKeyStrength('a'.repeat(15)).reason, 'length');
  assert.equal(checkKeyStrength('a'.repeat(16)).ok, true);
  assert.equal(checkKeyStrength('').reason, 'length');
  assert.equal(checkKeyStrength(undefined).reason, 'length');
  assert.match(checkKeyStrength('short').message, /16/);
});

test('弱口令黑名单：大小写不敏感、查完整值不查子串', () => {
  for (const k of ['123456', '12345678', 'password', 'admin123', 'qwertyuiop', 'changeme']) {
    assert.equal(WEAK_KEYS.has(k), true, `${k} 应在黑名单里`);
    assert.equal(checkKeyStrength(k).reason, 'weak');
  }
  assert.equal(checkKeyStrength('password'.toUpperCase()).reason, 'weak');
  assert.equal(checkKeyStrength('12345678'.toUpperCase()).reason, 'weak');
  assert.equal(checkKeyStrength('PASSWORD'.padEnd(20, 'x')).ok, true, '加长后不在名单');
  // NIST Q-B19：查完整值不查子串——加长后不在名单就该通过
  assert.equal(checkKeyStrength('password-2026-abcdef').ok, true);
  assert.equal(checkKeyStrength('a'.repeat(16)).ok, true, '16 个小写字母就够，不要求组合规则');
});

test('warnWeakKey：弱 key 给提示，强 key 空串', () => {
  assert.match(warnWeakKey('123456'), /太常见/);
  assert.match(warnWeakKey('short'), /至少需要/);
  assert.equal(warnWeakKey('a'.repeat(20)), '');
});

test('接线：启动阻断与 /api/config 改 key 都调用强度校验', () => {
  const src = read('src/web/server.js');
  assert.match(src, /checkKeyStrength\(accessKey\)/);
  assert.match(src, /exposed && !keyStrength\.ok/);
  assert.match(src, /checkKeyStrength\(newAccessKey\)/);
  assert.match(src, /checkLoginPasswordStrength\(newLoginPassword\)/);
  assert.match(src, /sessions\.clear\(\)/, '换凭证必须清会话');
  assert.match(src, /warnWeakKey\(accessKey\)/);
  // 登录接口不该校验强度（历史弱 key 用户仍能登录，只是被提醒改）
  const atLogin = src.indexOf("pathname === '/api/login'");
  const atAuth = src.indexOf('if (!authorized(req, url, ptPage))');
  assert.doesNotMatch(src.slice(atLogin, atAuth), /checkKeyStrength/);
});

/** 起一个临时端口的真实服务，验证 /api/config PUT 的 key 校验 */
test('真 HTTP：面板改 key 弱则 400 且配置未变，强则 200', async (t) => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const picked = probe.address().port;
      probe.close((e) => (e ? reject(e) : resolve(picked)));
    });
  });
  const { startWebServer } = await import('../src/web/server.js');
  let saved = null;
  /** /api/config 需要一只鸟（rt），mock 最小够用集合 */
  const rt = {
    id: 'test-bot', cfg: {}, plugins: {}, groups: {}, roles: {},
    api: {}, metrics: { bump() {} }, gate: null,
  };
  const svc = await startWebServer({
    globalCfg: {
      webui: { host: '127.0.0.1', port, accessKey: 'test-strong-key-1234567890', portTries: 1, openBrowser: false },
      plugins: {},
    },
    runtimes: [rt],
    saveBotConfig: async () => {},
    saveGlobalConfig: async (cfg) => { saved = cfg; },
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
  const put = (key) =>
    fetch(base + '/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Access-Key': 'test-strong-key-1234567890' },
      body: JSON.stringify({ webui: { accessKey: key } }),
    });

  const weak = await put('123456');
  assert.equal(weak.status, 400);
  assert.match((await weak.json()).error, /太常见/);
  const short = await put('abc123');
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /16/);
  assert.equal(saved, null, '弱 key 不能被保存');

  const strong = await put('b'.repeat(32));
  assert.equal(strong.status, 200);
  assert.equal(saved.webui.accessKey, 'b'.repeat(32));

  // 换凭证后旧 key 立即失效（P1 回归）：旧 header 再请求必须 401
  const stale = await fetch(base + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': 'test-strong-key-1234567890' },
    body: JSON.stringify({ webui: {} }),
  });
  assert.equal(stale.status, 401, '旧凭证必须立即失效');

  // 新 key 可用；空值 = 不修改（面板不回显密钥），不该被强度校验误伤
  const blank = await fetch(base + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Access-Key': 'b'.repeat(32) },
    body: JSON.stringify({ webui: { accessKey: '' } }),
  });
  assert.equal(blank.status, 200);
});

test('启动闸门：外网两把钥匙都要强，loopback 只 warn 不拦', async () => {
  const { startWebServer } = await import('../src/web/server.js');
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const picked = probe.address().port;
      probe.close((e) => (e ? reject(e) : resolve(picked)));
    });
  });
  const opts = (host, key, pass) => ({
    globalCfg: { webui: { host, port, accessKey: key, loginPassword: pass, portTries: 1, openBrowser: false } },
    runtimes: [],
    saveBotConfig: async () => {},
    saveGlobalConfig: async () => {},
    onBotAdd: async () => {},
    onBotRemove: async () => {},
    onShutdown: async () => {},
    mock: true,
  });
  const strongKey = 'a'.repeat(24);
  const strongPass = 'human-pass-ok';
  const cases = [
    ['外网+强key+无登录密码', '0.0.0.0', strongKey, '', /未设置 webui\.loginPassword/],
    ['外网+强key+弱登录密码', '0.0.0.0', strongKey, '123456', /loginPassword 强度不足/],
    ['外网+弱key+强登录密码', '0.0.0.0', '123456', strongPass, /accessKey 强度不足/],
    ['外网+无key', '0.0.0.0', '', strongPass, /未设置 webui\.accessKey/],
    ['局域网地址也算外网', '192.168.1.9', strongKey, '', /未设置 webui\.loginPassword/],
  ];
  for (const [name, host, key, pass, expected] of cases) {
    await assert.rejects(() => startWebServer(opts(host, key, pass)), expected, name);
  }
  // 外网 + 两把强钥匙：正常启动
  const ok = await startWebServer(opts('0.0.0.0', strongKey, strongPass));
  const closed = new Promise((resolve) => ok.server.once('close', resolve));
  ok.close();
  await closed;
  // loopback 两把弱钥匙：只 warn 不拒绝
  const local = await startWebServer(opts('127.0.0.1', '123456', '123456'));
  const closed2 = new Promise((resolve) => local.server.once('close', resolve));
  local.close();
  await closed2;
});
