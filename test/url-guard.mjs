/**
 * 出站图片地址校验（`src/dev/url-guard.js`）。
 *
 * 这一组守的是「模型能不能借改头像让宿主访问任意地址」：
 *   · `::ffff:` 映射地址必须还原成 IPv4 再判（`new URL` 会把它规范成十六进制组）
 *   · 域名解析出多个地址时，任一私有就拒（防 DNS rebinding）
 *   · 重定向要逐跳校验，不能只查第一跳
 *   · 无 content-length 的流也要按上限截断，不能先全读进内存
 *
 * 跑法：node --test test/url-guard.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateIp, assertSafeHttpUrl, fetchImageLimited } from '../src/dev/url-guard.js';

const pubLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privLookup = async () => [{ address: '10.1.2.3', family: 4 }];
const mixedLookup = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '169.254.169.254', family: 4 },
];

test('S1 IPv4 私有 / 回环 / 保留 / 组播', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '100.64.0.1', '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateIp(ip), true, `该判私有：${ip}`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(isPrivateIp(ip), false, `该放行：${ip}`);
  }
});

test('S2 IPv4-mapped IPv6：点分与十六进制组都要认', () => {
  /** 这三个是 2026-11-14 对抗测试实测能绕过旧版的形态 */
  for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:1']) {
    assert.equal(isPrivateIp(ip), true, `该判私有：${ip}`);
  }
  assert.equal(isPrivateIp('::ffff:808:808'), false, '8.8.8.8 的映射形态是公网');
  /** 合法 IPv6 但映射段认不出来（三段）→ fail-closed，不能当公网放行 */
  assert.equal(isPrivateIp('::ffff:0:0:1'), true, '认不出的映射一律 fail-closed');
});

test('S2b IPv6 里编进 IPv4 的另外三种形态（兼容 / NAT64 / 6to4）', () => {
  /**
   * 这四条是 2026-11-16 发版前复核发现的绕过：只认 `::ffff:` 时，一条
   * `http://[::7f00:1]/` 就能打到 127.0.0.1，NAT64 / 6to4 同理。
   */
  for (const ip of ['::7f00:1', '::127.0.0.1', '::a00:1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2002:a9fe:a9fe::1']) {
    assert.equal(isPrivateIp(ip), true, `该判私有：${ip}`);
  }
  assert.equal(isPrivateIp('::808:808'), false, '0.0.0.0 之外——8.8.8.8 的兼容形态是公网');
  assert.equal(isPrivateIp('64:ff9b::808:808'), false, 'NAT64 里的 8.8.8.8 是公网');
  assert.equal(isPrivateIp('2002:808:808::1'), false, '6to4 里的 8.8.8.8 是公网');
});

test('S3 IPv6 唯一本地 / 链路本地 / 回环', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe90::1', 'febf::1']) {
    assert.equal(isPrivateIp(ip), true, `该判私有：${ip}`);
  }
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false);
});

test('S4 字面 IP 直接拒，公网 IP 放行', async () => {
  for (const u of ['http://127.0.0.1/x.png', 'http://[::ffff:127.0.0.1]/x.png',
    'http://[::ffff:a9fe:a9fe]/x.png', 'http://169.254.169.254/latest/meta-data/']) {
    await assert.rejects(() => assertSafeHttpUrl(u), /内网|本机/, `该拒：${u}`);
  }
  await assert.doesNotReject(() => assertSafeHttpUrl('https://8.8.8.8/x.png'));
});

test('S5 协议与凭据', async () => {
  await assert.rejects(() => assertSafeHttpUrl('file:///etc/passwd'), /http/);
  await assert.rejects(() => assertSafeHttpUrl('gopher://x/'), /http/);
  await assert.rejects(() => assertSafeHttpUrl('https://user:pass@example.com/x.png'), /账号密码/);
  await assert.rejects(() => assertSafeHttpUrl('not a url'), /合法/);
});

test('S6 域名解析：任一私有就拒（防 DNS rebinding）', async () => {
  await assert.rejects(
    () => assertSafeHttpUrl('https://evil.example/x.png', { lookup: privLookup }),
    /内网/,
  );
  await assert.rejects(
    () => assertSafeHttpUrl('https://rebind.example/x.png', { lookup: mixedLookup }),
    /内网/,
    '有公网地址也不能放行',
  );
  await assert.doesNotReject(
    () => assertSafeHttpUrl('https://example.com/x.png', { lookup: pubLookup }),
  );
});

function fakeRes({ status = 200, headers = {}, body = null } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => h.get(String(k).toLowerCase()) ?? null },
    arrayBuffer: async () => {
      if (!body) return new ArrayBuffer(0);
      const b = Buffer.from(body);
      /** Buffer 可能来自池化分配，`.buffer` 会比内容大——必须按 byteOffset 切片 */
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    body: null,
  };
}

test('S7 重定向逐跳校验：跳到内网要拒', async () => {
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    if (calls.length === 1) {
      return fakeRes({ status: 302, headers: { location: 'http://127.0.0.1/evil.png' } });
    }
    return fakeRes({ status: 200, headers: { 'content-type': 'image/png' }, body: 'x' });
  };
  await assert.rejects(
    () => fetchImageLimited('https://example.com/a.png', {
      maxBytes: 1024, fetchImpl, lookup: pubLookup,
    }),
    /内网|本机/,
  );
  assert.equal(calls.length, 1, '第二跳不该被请求');
});

test('S8 正常取图：返回 type 与内容', async () => {
  const fetchImpl = async () => fakeRes({
    headers: { 'content-type': 'image/png; charset=binary', 'content-length': '3' },
    body: 'abc',
  });
  const got = await fetchImageLimited('https://example.com/a.png', {
    maxBytes: 1024, fetchImpl, lookup: pubLookup,
  });
  assert.equal(got.type, 'image/png');
  assert.equal(got.buf.toString(), 'abc');
});

test('S9 超限：content-length 预判与流式截断都生效', async () => {
  const tooBig = async () => fakeRes({
    headers: { 'content-type': 'image/png', 'content-length': '999999' },
    body: 'x',
  });
  await assert.rejects(
    () => fetchImageLimited('https://example.com/a.png', { maxBytes: 10, fetchImpl: tooBig, lookup: pubLookup }),
    /上限/,
  );

  /** 没有 content-length 时靠流式累计 */
  let sent = 0;
  const streamRes = {
    status: 200,
    ok: true,
    headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= 100) return { done: true };
          sent += 1;
          return { done: false, value: Buffer.alloc(8) };
        },
        cancel: async () => {},
      }),
    },
  };
  await assert.rejects(
    () => fetchImageLimited('https://example.com/a.png', {
      maxBytes: 32, fetchImpl: async () => streamRes, lookup: pubLookup,
    }),
    /上限/,
  );
});

test('S10 重定向次数有上限', async () => {
  let n = 0;
  const fetchImpl = async (u) => {
    n += 1;
    return fakeRes({ status: 302, headers: { location: `https://example.com/${n}.png` } });
  };
  await assert.rejects(
    () => fetchImageLimited('https://example.com/0.png', {
      maxBytes: 1024, fetchImpl, lookup: pubLookup, maxRedirects: 2,
    }),
    /重定向/,
  );
});
