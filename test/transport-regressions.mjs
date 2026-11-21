/**
 * 传输层回归（2026-11-21）
 * ======================
 *
 * 三条都是「静默做错」型：不报错、日志看起来正常，但行为是错的。
 *
 *   1. **multipart 重试丢语义**：`#request` 递归重试时只透传 `retried/headers`，
 *      把 `multipart` 丢了 → 带 `fileImage` 的频道消息在 ECONNREFUSED 重试时
 *      变成 `application/json` + `{"file_image":{"type":"Buffer",…}}`。
 *   2. **分片上传无差别重试**：除 `40093002` 外一律重试，presigned URL 过期
 *      （403）这类重试无意义的错误会把默认 `retry_timeout=300s` 耗完，
 *      一片一片地白等。
 *   3. **网关停机竞态**：`#connect()` 在 `await api.getGateway()` 期间被
 *      `stop()` 打断后仍会建连接，留下僵尸 ws（会重新 Identify，把线上那条
 *      踢成 4902），`connecting` 还会永久为 true。
 *
 * 跑法：node --test test/transport-regressions.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { QQApi } from '../src/api.js';
import { Gateway } from '../src/gateway.js';

const realFetch = globalThis.fetch;

/** 用完必须还原：同一进程里别的用例还在用真 fetch */
function stubFetch(t, fn) {
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = realFetch; });
}

function makeApi() {
  return new QQApi({
    tokenManager: { get: async () => 'tok', appId: 'app' },
    baseUrl: 'http://api.test',
  });
}

test('multipart：连接没建起来的重试仍走 FormData，不降级成 JSON', async (t) => {
  const calls = [];
  stubFetch(t, async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      const e = new Error('fetch failed');
      e.cause = { code: 'ECONNREFUSED' };
      throw e;
    }
    return new Response(JSON.stringify({ id: 'm-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const r = await makeApi().sendChannelMessage('c1', { content: 'hi', fileImage: Buffer.from('PNG') });
  assert.equal(r.id, 'm-1');
  assert.equal(calls.length, 2, '连接失败应该重试一次');

  const [first, second] = calls.map((c) => c.init);
  assert.ok(first.body instanceof FormData, '首次是 FormData');
  assert.ok(second.body instanceof FormData, '重试也必须是 FormData（JSON 化会带出一个 Buffer 对象，平台必 400）');
  /**
   * **大小写不敏感**地断言没有手写 Content-Type。
   * 只查 `headers['Content-Type']` 的话，实现哪天改成小写键，这条会继续「通过」——
   * 而多手写一个 Content-Type 会让 fetch 的 boundary 失效，平台直接 400。
   */
  assert.ok(
    !Object.keys(second.headers ?? {}).some((k) => k.toLowerCase() === 'content-type'),
    'multipart 不能手写 Content-Type（boundary 由 fetch 生成）',
  );
  assert.equal(second.body.get('content'), 'hi');
  assert.ok(second.body.get('file_image') instanceof Blob, '文件字段还在');
});

test('分片上传：presigned URL 403 立即失败，不空转 retry_timeout', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-shard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const file = path.join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.from('1234'));

  let puts = 0;
  stubFetch(t, async (url, init) => {
    if (init.method === 'PUT') {
      puts += 1;
      return new Response('expired', { status: 403 });
    }
    /** upload_prepare：给一片，retry_timeout 仍是官方默认 300s */
    return new Response(
      JSON.stringify({
        upload_id: 'u1',
        parts: [{ index: 0, presigned_url: 'https://cos.test/p0', block_size: 4 }],
        upload_config: { concurrency: 1, retry_timeout: 300, retry_delay: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });

  const t0 = Date.now();
  await assert.rejects(
    () => makeApi().uploadLocalFileSharded('group', 'g1', file, 4),
    /分片 PUT 失败 HTTP 403/,
  );
  const cost = Date.now() - t0;
  assert.equal(puts, 1, '403 是确定失败，不该重试');
  assert.ok(cost < 2000, `不该等 retry_timeout，实际耗时 ${cost}ms`);
});

test('网关：getGateway 期间 stop() 之后不再建连接，connecting 也要复位', async (t) => {
  class FakeWS {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      FakeWS.instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, ev = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    }
    send() {}
    close() {}
  }
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  t.after(() => { globalThis.WebSocket = realWS; });

  const api = {
    /** 慢一点，让 stop() 落在 await 中间 */
    getGateway: () => new Promise((r) => setTimeout(() => r({ url: 'wss://example.test' }), 60)),
    putInteraction: () => Promise.resolve({}),
  };
  const gw = new Gateway({ api, tokens: { get: async () => 't' }, intents: 0, onDispatch: () => {} });
  t.after(() => {
    for (const ws of FakeWS.instances) ws.emit('open');
    gw.stop();
  });

  gw.start().catch(() => {});
  setTimeout(() => gw.stop(), 10);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(FakeWS.instances.length, 0, 'stop 之后不能再建 WebSocket（会变僵尸连接）');
  assert.equal(gw.connecting, false, 'connecting 必须复位，否则 restart() 会被卡死');

  /** 复位之后 restart() 要能真的连上（否则「下线再上线」会静默失效） */
  await gw.restart();
  assert.equal(FakeWS.instances.length, 1, 'restart 应该只建一条连接');
});
