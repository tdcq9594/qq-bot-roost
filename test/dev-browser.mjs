/**
 * 扫码登录状态机 + cookie 挑选的契约测试
 * =========================================
 *
 * 全程不启浏览器、不联网：
 *   · `finder` 注入假的浏览器清单
 *   · `spawnFn` 注入假进程（顺手写一份 `DevToolsActivePort`）
 *   · `connect` 注入假 CDP 客户端
 *
 * 这样钉住的是**我们自己的状态机**：什么时候算成功、超时怎么收尾、用户关窗
 * 之后不能还在转圈。CDP 的真实握手不在这里测——那属于 Chromium 的行为。
 *
 * 跑法：node --test test/dev-browser.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  findBrowsers, pickTickets, hasTickets, ticketSig, createScanLogin,
} from '../src/dev/browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(15);
  }
  return false;
}

const fakeProc = () => ({ exitCode: 0, once() {}, kill() {} });

function fakeCdp(cookies) {
  const sent = [];
  return {
    sent,
    send(method) {
      sent.push(method);
      if (method === 'Storage.getCookies') return Promise.resolve({ cookies });
      return Promise.resolve({});
    },
    close() {},
  };
}

async function tmpProfile() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'roost-dev-scan-'));
}

/** 造一个能立刻「就绪」的扫码器 */
function makeScan({ dir, cookies, verify, ttlMs = 10_000, pollMs = 10, list = null }) {
  return createScanLogin({
    profileDir: dir,
    finder: () => list ?? [{ id: 'fake', name: 'Fake Browser', path: path.join(dir, 'fake.exe') }],
    spawnFn: () => {
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '12345\n/devtools/browser/fake\n');
      return fakeProc();
    },
    connect: async () => fakeCdp(cookies),
    verify,
    ttlMs,
    pollMs,
    readyTimeoutMs: 2_000,
  });
}

test('findBrowsers：按 Edge → Chrome 排，缺的不返回', () => {
  const fakeRoots = {
    'PROGRAMFILES(X86)': 'C:\\PF86',
    PROGRAMFILES: 'C:\\PF',
    LOCALAPPDATA: 'C:\\LA',
  };
  const edge = path.join('C:\\PF86', 'Microsoft\\Edge\\Application\\msedge.exe');
  const chrome = path.join('C:\\LA', 'Google\\Chrome\\Application\\chrome.exe');

  const list = findBrowsers({
    platform: 'win32',
    env: fakeRoots,
    exists: (p) => p === edge || p === chrome,
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'Microsoft Edge');
  assert.equal(list[1].name, 'Google Chrome');

  const none = findBrowsers({ platform: 'win32', env: fakeRoots, exists: () => false });
  assert.deepEqual(none, []);
});

test('findBrowsers：Linux 认 chromium / brave / snap / flatpak', () => {
  const want = ['/usr/bin/chromium', '/snap/bin/chromium', '/var/lib/flatpak/exports/bin/com.google.Chrome'];
  const list = findBrowsers({
    platform: 'linux',
    env: {},
    exists: (p) => want.includes(p),
  });
  assert.deepEqual(list.map((b) => b.path), want);
});

test('findBrowsers：macOS 也看 ~/Applications', () => {
  const home = path.join('/Users', 'someone', 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
  const list = findBrowsers({
    platform: 'darwin',
    env: { HOME: path.join('/Users', 'someone') },
    exists: (p) => p === home,
  });
  assert.equal(list.length, 1);
  assert.match(list[0].name, /Chromium/);
});

test('findBrowsers：手填路径优先，且路径不存在就当没填', () => {
  const custom = path.join('D:\\绿色版', 'chrome.exe');
  const list = findBrowsers({
    platform: 'win32',
    env: { PROGRAMFILES: 'C:\\PF' },
    exists: (p) => p === custom,
    browserPath: custom,
  });
  assert.equal(list[0].path, custom);
  assert.equal(list[0].id, 'custom');

  const ignored = findBrowsers({
    platform: 'win32',
    env: { PROGRAMFILES: 'C:\\PF' },
    exists: () => false,
    browserPath: custom,
  });
  assert.deepEqual(ignored, []);
});

test('findBrowsers：同一路径被多个根目录命中时只留一份', () => {
  const list = findBrowsers({
    platform: 'win32',
    env: { PROGRAMFILES: 'C:\\PF' },
    exists: () => true,
  });
  const paths = list.map((x) => x.path);
  assert.equal(new Set(paths).size, paths.length);
});

test('pickTickets：只收票据键、只收 qq.com、同名优先更具体的域', () => {
  const jar = pickTickets([
    { name: 'p_skey', value: 'wide', domain: '.qq.com' },
    { name: 'p_skey', value: 'narrow', domain: '.q.qq.com' },
    { name: 'qticket_lite', value: 't', domain: 'q.qq.com' },
    { name: 'uin', value: 'o123', domain: '.qq.com' },
    { name: 'p_skey', value: 'evil', domain: '.evil.com' },
    { name: 'p_skey', value: '', domain: '.q.qq.com' },
    null,
    'x',
  ]);
  assert.equal(jar.get('p_skey'), 'narrow', '应该用 q.qq.com 那份');
  assert.equal(jar.get('qticket_lite'), 't');
  assert.equal(jar.has('uin'), false, '非票据键不该带进请求');
});

test('hasTickets：认登录态标记，访客票不算登录', () => {
  assert.equal(hasTickets(new Map([['p_skey', 'a']])), true);
  assert.equal(hasTickets(new Map([['p_skey', 'a'], ['qticket_lite', 'b']])), true);
  // 2026-11 实测：新版扫码登录只下发 b-token，p_skey 可以完全没有
  assert.equal(hasTickets(new Map([['b-token', 'bt'], ['qticket', 't']])), true);
  assert.equal(hasTickets(new Map([['developer_id_lite', 'd']])), true);
  /**
   * 未登录访客也会被种 qticket_lite：按「有票」放行会在用户还盯着二维码时
   * 就报「已取到登录态」，所以这里必须是 false。
   */
  assert.equal(hasTickets(new Map([['qticket_lite', 'b']])), false);
  assert.equal(hasTickets(new Map([['quid', 'q']])), false);
  assert.equal(hasTickets(new Map()), false);
  assert.equal(hasTickets(null), false);
});

test('ticketSig：同长度不同值必须算出不同指纹', () => {
  const a = ticketSig(new Map([['qticket', 'a'.repeat(32)]]));
  const b = ticketSig(new Map([['qticket', 'b'.repeat(32)]]));
  assert.notEqual(a, b, '长度相同、值不同 → 指纹必须不同，否则重登后永不重验');

  // 同一份票据要稳定，否则每轮都会去打一次接口
  assert.equal(a, ticketSig(new Map([['qticket', 'a'.repeat(32)]])));

  // 指纹里不能出现票据原文
  const sig = ticketSig(new Map([['b-token', 'SECRETVALUE']]));
  assert.equal(sig.includes('SECRET'), false);
});

test('扫码：拿到票据 + 校验通过 → ok，窗口留着当请求通道', async () => {
  const dir = await tmpProfile();
  const cookies = [
    { name: 'p_skey', value: 'abc', domain: '.q.qq.com' },
    { name: 'qticket_lite', value: 'tl', domain: '.q.qq.com' },
    { name: 'noise', value: 'x', domain: '.qq.com' },
  ];
  let verified = 0;

  const scan = makeScan({
    dir,
    cookies,
    verify: async (jar) => {
      verified += 1;
      assert.equal(jar.get('p_skey'), 'abc');
      assert.equal(jar.has('noise'), false);
      return 2;
    },
  });

  const started = await scan.start();
  assert.equal(started.state, 'waiting', 'start() 返回时窗口应已就绪');

  assert.ok(await waitFor(() => scan.status().state === 'ok'), '没进 ok');
  const st = scan.status();
  assert.equal(st.botCount, 2);
  assert.match(st.message, /2 个机器人/);
  assert.equal(verified, 1, '票据没变就不该重复打接口');
  /**
   * 登录成功后窗口**不能关**：它是后续 dev.* 请求的传输层。
   * 关掉就只剩 cookie 交给 Node 重放，实测会被平台风控回 10000。
   */
  assert.equal(st.alive, true, '登录成功后窗口要留着');

  await scan.cancel(); // 已经是终态，应该是空操作
  assert.equal(scan.status().state, 'ok');

  // 退出登录才真的关窗
  await scan.close();
  assert.equal(scan.status().alive, false);
  assert.equal(scan.status().state, 'idle');
});

test('扫码：一直不扫码 → 超时收尾，不常驻调试端口', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({ dir, cookies: [], verify: async () => 0, ttlMs: 60, pollMs: 10 });

  await scan.start();
  assert.ok(await waitFor(() => scan.status().state === 'expired', 2_000));
  assert.match(scan.status().message, /超时/);
});

test('扫码：本机没有浏览器 → error，且不抛异常出去', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({ dir, cookies: [], verify: async () => 0, list: [] });
  const st = await scan.start();
  assert.equal(st.state, 'error');
  assert.match(st.message, /没找到 Chromium 系浏览器/);
});

test('扫码：手动取消 → canceled', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({ dir, cookies: [], verify: async () => 0, ttlMs: 60_000 });
  await scan.start();
  await scan.cancel();
  assert.equal(scan.status().state, 'canceled');
});

test('扫码：校验一直不过也不判死，继续等', async () => {
  const dir = await tmpProfile();
  const cookies = [{ name: 'p_skey', value: 'half', domain: '.q.qq.com' }];
  let tries = 0;
  const scan = makeScan({
    dir,
    cookies,
    verify: async () => {
      tries += 1;
      const e = new Error('登录已过期');
      e.code = 'NO_SESSION';
      throw e;
    },
    ttlMs: 400,
    pollMs: 10,
  });

  await scan.start();
  assert.ok(await waitFor(() => scan.status().state === 'expired', 2_000));
  assert.equal(tries, 1, '同样的票据只验一次，不刷屏');
  assert.match(scan.status().error, /登录已过期/);
});

/* ------------------------------------------------------------------ */
/* 自动续期：票据过期时开窗换票，拿到就关                                */
/* ------------------------------------------------------------------ */

const ticketCookies = [
  { name: 'b-token', value: 'bt-new', domain: '.qq.com' },
  { name: 'developer_id_lite', value: 'dev', domain: '.qq.com' },
];

test('续期：窗口关着 → 起窗取票，成功后自动关窗', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({ dir, cookies: ticketCookies, verify: async () => 3, ttlMs: 5_000 });

  const r = await scan.refresh({ timeoutMs: 2_000 });
  assert.equal(r.ok, true);
  assert.equal(r.reused, false);
  assert.equal(r.jar.get('b-token'), 'bt-new');
  // 关键：后台自动跑的路径不能留一个窗口在桌面上
  assert.equal(scan.status().state, 'idle', '拿完票必须把窗口收掉');
});

test('续期：窗口本来就开着 → 直接读，不重开也不关', async () => {
  const dir = await tmpProfile();
  let spawned = 0;
  const scan = createScanLogin({
    profileDir: dir,
    finder: () => [{ id: 'fake', name: 'Fake', path: path.join(dir, 'fake.exe') }],
    spawnFn: () => {
      spawned += 1;
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '12345\n/devtools/browser/fake\n');
      return fakeProc();
    },
    connect: async () => fakeCdp(ticketCookies),
    verify: async () => 1,
    ttlMs: 5_000,
    pollMs: 10,
    readyTimeoutMs: 2_000,
  });

  await scan.start();
  assert.ok(await waitFor(() => scan.status().state === 'ok', 2_000));
  const before = spawned;

  const r = await scan.refresh({ timeoutMs: 1_000 });
  assert.equal(r.ok, true);
  assert.equal(r.reused, true);
  assert.equal(r.closed, false);
  assert.equal(spawned, before, '已开着的窗口不该再起一个（同 profile 也起不来）');
  assert.equal(scan.status().state, 'ok', '复用路径不能把用户的窗口关掉');
});

test('续期：profile 里没有登录态 → 超时收窗并报清楚', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({
    dir,
    cookies: [{ name: 'other', value: 'x', domain: '.qq.com' }],
    verify: async () => 0,
    ttlMs: 5_000,
    pollMs: 10,
  });

  const r = await scan.refresh({ timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /timeout|expired/);
  assert.equal(scan.status().state, 'idle', '失败也要收窗，不能留个没人管的浏览器');
});

test('续期：正在扫码时不抢窗口', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({ dir, cookies: [], verify: async () => 0, ttlMs: 60_000 });
  await scan.start();
  const r = await scan.refresh({ timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'busy');
  await scan.cancel();
});

test('续期默认无头（不弹窗），扫码仍然是有窗口的', async () => {
  const dir = await tmpProfile();
  const batches = [];
  const scan = createScanLogin({
    profileDir: dir,
    finder: () => [{ id: 'fake', name: 'Fake', path: path.join(dir, 'fake.exe') }],
    spawnFn: (_exe, args) => {
      batches.push(args);
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '12345\n/devtools/browser/fake\n');
      return fakeProc();
    },
    connect: async () => fakeCdp(ticketCookies),
    verify: async () => 1,
    ttlMs: 5_000,
    pollMs: 10,
    readyTimeoutMs: 2_000,
  });

  const r = await scan.refresh({ timeoutMs: 1_000 });
  assert.equal(r.ok, true);
  assert.ok(batches[0].includes('--headless=new'), '自动续期必须无头，否则会突然弹窗');

  // 用户主动扫码：必须是可见窗口，不然没法扫
  await scan.start();
  assert.ok(await waitFor(() => scan.status().state === 'ok', 2_000));
  assert.equal(batches[1].includes('--headless=new'), false, '扫码窗口不能无头');
  await scan.close();
});

test('续期可显式要求可见窗口（排障用）', async () => {
  const dir = await tmpProfile();
  const batches = [];
  const scan = createScanLogin({
    profileDir: dir,
    finder: () => [{ id: 'fake', name: 'Fake', path: path.join(dir, 'fake.exe') }],
    spawnFn: (_exe, args) => {
      batches.push(args);
      fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '12345\n/devtools/browser/fake\n');
      return fakeProc();
    },
    connect: async () => fakeCdp(ticketCookies),
    verify: async () => 0,
    ttlMs: 5_000,
    pollMs: 10,
    readyTimeoutMs: 2_000,
  });
  const r = await scan.refresh({ timeoutMs: 1_000, headless: false });
  assert.equal(r.ok, true);
  assert.equal(batches[0].includes('--headless=new'), false);
});

test('续期只读到半份票（只有 b-token）时不认，报 incomplete 而不是假装成功', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({
    dir,
    // 实测：换票页面刚起来时 b-token 先种、developer_id_lite 后种
    cookies: [{ name: 'b-token', value: 'half', domain: '.qq.com' }],
    verify: async () => 0,
    ttlMs: 5_000,
    pollMs: 10,
  });

  const r = await scan.refresh({ timeoutMs: 500 });
  assert.equal(r.ok, false, '半份票不能算换票成功');
  assert.equal(r.reason, 'incomplete');
  // 半份票让下一次请求又 401，等于白换一次，所以窗口必须收掉
  assert.equal(scan.status().state, 'idle');
});

test('续期读到完整票（b-token + developer_id_lite）才算成功', async () => {
  const dir = await tmpProfile();
  const scan = makeScan({
    dir,
    cookies: [
      { name: 'b-token', value: 'bt', domain: '.qq.com' },
      { name: 'developer_id_lite', value: 'dev', domain: '.qq.com' },
    ],
    verify: async () => 0,
    ttlMs: 5_000,
    pollMs: 10,
  });
  const r = await scan.refresh({ timeoutMs: 500 });
  assert.equal(r.ok, true);
  assert.equal(r.jar.get('developer_id_lite'), 'dev');
});
