/**
 * 代理支持自测
 * ============
 *
 *   node --test test/proxy.mjs
 *
 * 覆盖四件事：
 *   1. 地址解析 / 校验（auto、off、裸 host:port、带认证、拒绝 SOCKS）
 *   2. `no_proxy` 例外匹配（含 Windows 那种 `*zhihu.com` 写法）
 *   3. HTTP 目标：走代理时是 absolute-form（把整条 URL 发给代理）
 *   4. HTTPS 目标：CONNECT 隧道 + 隧道内 TLS（用本地自签证书，openssl 生成）
 *   5. 代理挂着 / 关掉了：自动降级直连，不能把下载卡死
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.ROOST_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-proxy-'));

const {
  netFetch,
  configureProxy,
  normalizeProxySetting,
  parseProxyUrl,
  parseWindowsProxyReg,
  shouldBypass,
  splitBypass,
  proxyInfo,
  resetProxyState,
} = await import('../src/proxy.js');

const HOME = process.env.ROOST_HOME;

test.after(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
});

/** 起一个本地服务并返回端口 */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  // 隧道/keep-alive 会把连接留着，不强制断掉 close() 永远不回调，
  // 于是用例失败时表现为「挂住」而不是报错——排查起来最费时间。
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

/**
 * 假代理：普通请求回 JSON，CONNECT 直接打隧道到目标（不解析内容）。
 *
 * CONNECT 这一支必须真的转发——否则测不出「隧道通了」。
 */
async function fakeProxy() {
  const seen = { requests: [], connects: [] };
  /**
   * CONNECT 拿到的 socket 是**脱离** server 连接跟踪的（Node 在 'connect' 事件里
   * 就把它交出去了），所以 `closeAllConnections()` 管不到它，`server.close()`
   * 会一直等下去。用例失败时表现为「挂住 60 秒被 kill」，看不到真正的报错。
   */
  const sockets = new Set();
  const track = (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
  };

  const server = http.createServer((req, res) => {
    seen.requests.push({ url: req.url, host: req.headers.host, auth: req.headers['proxy-authorization'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ via: 'proxy', path: req.url }));
  });
  server.on('connection', track);
  server.on('connect', (req, socket, head) => {
    seen.connects.push(req.url);
    track(socket);
    const i = req.url.lastIndexOf(':');
    const host = req.url.slice(0, i);
    const port = Number(req.url.slice(i + 1));
    const up = net.connect(port, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    track(up);
  });
  const port = await listen(server);

  return {
    server,
    port,
    seen,
    async destroy() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/* ---------------- 1. 地址校验 ---------------- */

test('代理设置校验：auto / off / 裸地址 / 拒绝 SOCKS', () => {
  assert.deepEqual(normalizeProxySetting('auto'), { ok: true, value: 'auto' });
  assert.deepEqual(normalizeProxySetting('off'), { ok: true, value: 'off' });
  assert.deepEqual(normalizeProxySetting(' 127.0.0.1:7890 '), {
    ok: true,
    value: 'http://127.0.0.1:7890',
  });
  // 路径要去掉，只留 scheme://host:port
  assert.deepEqual(normalizeProxySetting('http://127.0.0.1:7890/'), {
    ok: true,
    value: 'http://127.0.0.1:7890',
  });

  const socks = normalizeProxySetting('socks5://127.0.0.1:1080');
  assert.equal(socks.ok, false);
  assert.match(socks.error, /只支持 http \/ https/);

  const empty = normalizeProxySetting('   ');
  assert.equal(empty.ok, false);
});

test('代理地址解析：认证、默认端口、https 代理', () => {
  const p = parseProxyUrl('http://user:p%40ss@127.0.0.1:7890');
  assert.equal(p.host, '127.0.0.1');
  assert.equal(p.port, 7890);
  assert.equal(p.secure, false);
  assert.equal(p.auth, Buffer.from('user:p@ss').toString('base64'), '密码里的 %40 要还原成 @');

  assert.equal(parseProxyUrl('http://proxy.local').port, 80);
  assert.equal(parseProxyUrl('https://proxy.local').port, 443);
  assert.equal(parseProxyUrl('https://proxy.local').secure, true);

  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl('ftp://x'), null);
});

test('读 Windows 系统代理：reg 输出解析', () => {
  const on = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7892
    ProxyOverride    REG_SZ    *zhihu.com;localhost;<local>
`;
  const r = parseWindowsProxyReg(on);
  assert.equal(r.proxy.raw, 'http://127.0.0.1:7892');
  assert.match(r.bypass, /zhihu/, '「例外」列表要跟着带出来');

  assert.equal(parseWindowsProxyReg(on.replace('0x1', '0x0')), null, 'ProxyEnable=0 就是没代理');

  const split = parseWindowsProxyReg(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8443
`);
  assert.equal(split.proxy.port, 8443, '按协议分开写时 https 优先');

  assert.equal(parseWindowsProxyReg('    ProxyEnable    REG_DWORD    0x1\n'), null, '没有 ProxyServer');
  assert.equal(
    parseWindowsProxyReg(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    socks=127.0.0.1:1080
`),
    null,
    'SOCKS 不认，当没代理',
  );
});

/* ---------------- 2. no_proxy ---------------- */
test('no_proxy 例外匹配', () => {
  const list = ['*zhihu.com', 'api.example.com', 'intra.test:8080', 'localhost', '<local>'];
  assert.equal(shouldBypass('www.zhihu.com', 443, list), true, 'Windows 风格的 *zhihu.com');
  assert.equal(shouldBypass('api.example.com', 443, list), true);
  assert.equal(shouldBypass('a.api.example.com', 443, list), true, '子域也算');
  assert.equal(shouldBypass('example.com', 443, list), false, '不能把父域误判进来');
  assert.equal(shouldBypass('intra.test', 8080, list), true);
  assert.equal(shouldBypass('intra.test', 80, list), false, '端口不符不走例外');
  assert.equal(shouldBypass('nas', 80, list), true, '<local> 指不带点的主机名');
  assert.equal(shouldBypass('raw.githubusercontent.com', 443, []), false);
  assert.equal(shouldBypass('raw.githubusercontent.com', 443, ['*']), true);

  // 尾部通配：Windows 例外列表里 `127.*` / `10.*` 那种写法
  assert.equal(shouldBypass('127.0.0.1', 15210, ['127.*']), true);
  assert.equal(shouldBypass('10.1.2.3', 80, ['10.*']), true);
  assert.equal(shouldBypass('172.20.5.5', 80, ['172.2*']), true);
  assert.equal(shouldBypass('172.30.5.5', 80, ['172.2*']), false, '前缀不对就不算');
  assert.equal(shouldBypass('114.114.114.114', 53, ['127.*', '10.*']), false);
});

/**
 * 回归：2026-11-09「配了代理还是连不上 GitHub」。
 *
 * `bypass.push(...sys.bypass)` 把一个字符串摊成了一百多个单字符，其中 `*`
 * 让所有域名都算「例外」，代理等于没接上。这里钉住两点：
 *   1. 字符串 / 数组两种输入都要切成完整条目
 *   2. 被摊成字符数组时能拼回去（别让同一个坑再埋一次）
 */
test('例外列表摊平：字符串不会被拆成单字符', () => {
  const raw = '*zhihu.com;localhost;<local>;127.*';
  assert.deepEqual(splitBypass(raw), ['*zhihu.com', 'localhost', '<local>', '127.*']);
  assert.deepEqual(splitBypass(['a.com;b.com', 'c.com']), ['a.com', 'b.com', 'c.com']);
  assert.deepEqual(splitBypass(['', ' , ']), [], '空条目全部丢掉');

  // 被展开过（每个元素都是单字符）→ 先拼回去
  const exploded = [...raw];
  assert.ok(exploded.length > 20);
  assert.deepEqual(splitBypass(exploded), ['*zhihu.com', 'localhost', '<local>', '127.*']);

  // 摊平后的列表里那个 `*` 不能单独成条，否则一切域名都算例外
  assert.equal(splitBypass(exploded).includes('*'), false);
  const list = splitBypass(raw);
  assert.equal(shouldBypass('raw.githubusercontent.com', 443, list), false, 'GitHub 该走代理');
  assert.equal(shouldBypass('www.zhihu.com', 443, list), true, '例外里写了 zhihu');
});

/* ---------------- 3/4. 真发请求 ---------------- */

test('HTTP 目标走代理：absolute-form + 代理头', async () => {
  const proxy = await fakeProxy();
  try {
    configureProxy({ network: { proxy: `http://u:p@127.0.0.1:${proxy.port}` } });
    const res = await netFetch('http://example.test/a/index.json?x=1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.via, 'proxy');

    const hit = proxy.seen.requests[0];
    assert.equal(hit.url, 'http://example.test/a/index.json?x=1', '明文目标要发完整 URL 给代理');
    assert.equal(hit.host, 'example.test', 'Host 必须是目标站，不是代理');
    assert.equal(hit.auth, `Basic ${Buffer.from('u:p').toString('base64')}`, '代理认证头');
  } finally {
    configureProxy({ network: { proxy: 'off' } });
    resetProxyState();
    await proxy.destroy();
  }
});

test('redirect: manual 时 3xx 原样返回', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: 'https://example.test/next' });
    res.end();
  });
  const port = await listen(server);
  const proxy = await fakeProxy();
  try {
    configureProxy({ network: { proxy: `http://127.0.0.1:${proxy.port}` } });
    // 目标指到本地 302 服务：代理那条分支会把请求转给代理，所以这里直连测的是
    // 「就算走 fetch 也要能拿 3xx」——用 off 更直接
    configureProxy({ network: { proxy: 'off' } });
    const res = await netFetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /example\.test/);
  } finally {
    await close(server);
    await proxy.destroy();
  }
});

test('HTTPS 目标：CONNECT 隧道 + 隧道内 TLS', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-tls-'));
  let key;
  let cert;
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(dir, 'key.pem'),
        '-out', path.join(dir, 'cert.pem'),
        '-days', '1',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    key = await fs.readFile(path.join(dir, 'key.pem'));
    cert = await fs.readFile(path.join(dir, 'cert.pem'));
  } catch {
    await fs.rm(dir, { recursive: true, force: true });
    t.skip('本机没有 openssl，跳过 TLS 隧道用例');
    return;
  }

  const target = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const targetPort = await listen(target);
  const proxy = await fakeProxy();

  const oldReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  // 自签证书：只在这个用例里关掉校验
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    configureProxy({ network: { proxy: `http://127.0.0.1:${proxy.port}` } });
    const res = await netFetch(`https://127.0.0.1:${targetPort}/x?y=1`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, path: '/x?y=1' });
    assert.deepEqual(proxy.seen.connects, [`127.0.0.1:${targetPort}`], 'https 必须走 CONNECT');
    assert.equal(proxy.seen.requests.length, 0, '隧道内的请求不该被代理当普通请求解析');
  } finally {
    if (oldReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = oldReject;
    configureProxy({ network: { proxy: 'off' } });
    resetProxyState();
    await proxy.destroy();
    await close(target);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('代理没开：降级直连，下载不会被卡死', async () => {
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('direct-ok');
  });
  const targetPort = await listen(target);

  // 找一个肯定没人监听的端口当「已经关掉的代理」
  const probe = http.createServer();
  const deadPort = await listen(probe);
  await close(probe);

  try {
    configureProxy({ network: { proxy: `http://127.0.0.1:${deadPort}` } });
    const res = await netFetch(`http://127.0.0.1:${targetPort}/`);
    assert.equal(await res.text(), 'direct-ok', '代理连不上应该退回直连');

    // 判死之后 60 秒内不再试它：再请求一次也应该直接成功，且不报错
    const again = await netFetch(`http://127.0.0.1:${targetPort}/`);
    assert.equal(again.status, 200);
  } finally {
    configureProxy({ network: { proxy: 'off' } });
    resetProxyState();
    await close(target);
  }
});

test('proxyInfo 说明当前生效的是哪个代理', async () => {
  configureProxy({ network: { proxy: 'http://127.0.0.1:7890' } });
  try {
    const info = proxyInfo();
    assert.equal(info.mode, 'http://127.0.0.1:7890');
    assert.equal(info.active, 'http://127.0.0.1:7890');
    assert.equal(info.source, 'config');
  } finally {
    configureProxy({ network: { proxy: 'off' } });
    resetProxyState();
  }
});
