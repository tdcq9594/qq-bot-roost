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
  gw.metrics.sessionId = 'stale-session'; // 模拟面板上残留的旧会话
  await gw.restart();
  assert.equal(FakeWS.instances.length, 1, 'restart 应该只建一条连接');
  assert.equal(gw.metrics.sessionId, '', 'restart 也应清掉面板上的旧会话 id');
});

/**
 * 会话失效关闭码（2026-11-22）
 * ============================
 * 4006/4007/4902 表示 session 已废，必须清掉本地 session 走全新 IDENTIFY。
 * 以前只在 4902 清，4006/4007 会带着旧 session_id 反复 RESUME 被拒——
 * 日志看起来一直在重连，实际永远上不了线。这里钉住四类码的行为：
 * 三个失效码必须清，普通断线码（4000）必须保留 session 供 RESUME。
 */
test('网关：会话失效码清 session，普通断线码保留 session', async (t) => {
  class FakeWS {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 1;
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
    send(s) { (this.sent ??= []).push(JSON.parse(s)); }
    close() { this.readyState = 3; }
  }
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  const gateways = [];
  t.after(() => {
    globalThis.WebSocket = realWS;
    for (const gw of gateways) gw.stop();
    FakeWS.instances.length = 0;
  });
  const tick = () => new Promise((r) => setImmediate(r));

  /** 建一条走到 READY 的连接，再用 code 关掉，返回关掉后的会话状态 */
  async function sessionAfterClose(code) {
    const api = { getGateway: async () => ({ url: 'wss://example.test' }) };
    const gw = new Gateway({ api, tokens: { get: async () => 't' }, intents: 0, onDispatch: () => {} });
    gateways.push(gw);
    void gw.start();
    await tick();
    const ws = FakeWS.instances.at(-1);
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 999999 } }) });
    await tick();
    ws.emit('message', {
      data: JSON.stringify({ op: 0, t: 'READY', s: 7, d: { session_id: 'sess-A', user: { username: 'u' } } }),
    });
    await tick();
    assert.equal(gw.sessionId, 'sess-A', `${code}: 前置条件 READY 应写入 session`);
    assert.equal(gw.lastSeq, 7, `${code}: 前置条件 READY 应写入 seq`);
    assert.equal(gw.metrics.sessionId, 'sess-A', `${code}: 前置条件 READY 应写入面板 session`);
    ws.emit('close', { code, reason: 'test' });
    /** 等重连定时器（指数退避首轮 500~1000ms），看新连接第一帧发的是什么 */
    await new Promise((r) => setTimeout(r, 1600));
    await tick();
    const ws2 = FakeWS.instances.at(-1);
    assert.ok(ws2 && ws2 !== ws, `${code}: 应当建出新连接`);
    ws2.emit('open');
    ws2.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 999999 } }) });
    await tick();
    return {
      sessionId: gw.sessionId,
      lastSeq: gw.lastSeq,
      metricsSessionId: gw.metrics.sessionId,
      firstOp: ws2.sent?.[0]?.op,
    };
  }

  for (const code of [4006, 4007, 4902]) {
    const r = await sessionAfterClose(code);
    assert.equal(r.sessionId, '', `close ${code} 应清掉 sessionId，否则会反复 RESUME 被拒`);
    assert.equal(r.lastSeq, null, `close ${code} 应清掉 lastSeq`);
    assert.equal(r.metricsSessionId, '', `close ${code} 也要清面板 metrics.sessionId，别残留已废会话`);
    assert.equal(r.firstOp, 2, `close ${code} 重连首帧应是 op2 IDENTIFY（全新鉴权），不是 op6 RESUME`);
  }

  const kept = await sessionAfterClose(4000);
  assert.equal(kept.sessionId, 'sess-A', '普通断线码应保留 session，下次走 RESUME');
  assert.equal(kept.lastSeq, 7, '普通断线码应保留 seq');
  assert.equal(kept.metricsSessionId, 'sess-A', '普通断线码不应清面板 session');
  assert.equal(kept.firstOp, 6, '普通断线码重连首帧应是 op6 RESUME，不能过度清除');
});

/**
 * 会话创建配额预检（2026-11-22）
 * ==============================
 * GET /gateway/bot 返回 session_start_limit.remaining，0 表示 24h 内不能再建 Session。
 * IDENTIFY 会消耗配额、RESUME 不会。所以：
 *   - 全新连接遇到 remaining=0：不建 ws、不盲发 IDENTIFY，按 reset_after 等配额重置；
 *   - 已有 session（要走 RESUME）：即使 remaining=0 也必须照常连接，不能被误挡；
 *   - 字段缺失（旧接口/沙箱）：放行，不让预检变成新的启动阻塞点。
 */
test('网关：会话创建配额耗尽时等重置，RESUME 与字段缺失不受影响', async (t) => {
  class FakeWS {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.listeners = new Map();
      this.sent = [];
      FakeWS.instances.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, ev = {}) {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
  }
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  const gateways = [];
  t.after(() => {
    globalThis.WebSocket = realWS;
    for (const gw of gateways) gw.stop();
    FakeWS.instances.length = 0;
  });
  const tick = () => new Promise((r) => setImmediate(r));

  function makeGateway(gwResponse) {
    const gw = new Gateway({
      api: { getGateway: async () => gwResponse },
      tokens: { get: async () => 't' },
      intents: 0,
      onDispatch: () => {},
    });
    gateways.push(gw);
    return gw;
  }

  /** 配额耗尽但 reset_after 非法时，也不能推高 attempt（否则恢复后首次断线退避被拉长） */
  for (const badReset of [0, undefined, -1]) {
    FakeWS.instances.length = 0;
    const gw = new Gateway({
      api: {
        getGateway: async () => ({
          url: 'wss://example.test',
          session_start_limit: { total: 1000, remaining: 0, reset_after: badReset },
        }),
      },
      tokens: { get: async () => 't' },
      intents: 0,
      onDispatch: () => {},
    });
    gateways.push(gw);
    void gw.start();
    await tick();
    assert.equal(FakeWS.instances.length, 0, `reset_after=${badReset}: 配额耗尽不该建 ws`);
    assert.ok(gw.reconnectTimer, `reset_after=${badReset}: 应仍安排重连`);
    assert.equal(gw.attempt, 0, `reset_after=${badReset}: 配额等待不能推高 attempt`);
  }

  // 1) 全新连接 + remaining=0：不建 ws，但安排了重连定时器
  {
    FakeWS.instances.length = 0;
    const exhausted = makeGateway({
      url: 'wss://example.test',
      shards: 1,
      session_start_limit: { total: 1000, remaining: 0, reset_after: 3600000, max_concurrency: 1 },
    });
    void exhausted.start();
    await tick();
    assert.equal(FakeWS.instances.length, 0, '配额耗尽时不该建 WebSocket');
    assert.equal(exhausted.connecting, false, '配额耗尽后 connecting 必须复位，否则重连被卡死');
    assert.ok(exhausted.reconnectTimer, '配额耗尽应安排等待配额重置的重连');
    assert.equal(exhausted.attempt, 0, '配额等待不该推高退避次数');
  }

  // 2) 已有 session（要走 RESUME）+ remaining=0：照常建连、发 RESUME，不被误挡
  {
    FakeWS.instances.length = 0;
    const resuming = makeGateway({
      url: 'wss://example.test',
      session_start_limit: { total: 1000, remaining: 0, reset_after: 3600000, max_concurrency: 1 },
    });
    // 预置会话：模拟断线重连场景，HELLO 会走 RESUME 分支
    resuming.sessionId = 'sess-resume';
    resuming.lastSeq = 42;
    void resuming.start();
    await tick();
    const ws = FakeWS.instances.at(-1);
    assert.ok(ws, 'RESUME 不该被配额预检挡住');
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 999999 } }) });
    await tick();
    assert.equal(ws.sent[0]?.op, 6, '有 session 时首帧应是 op6 RESUME');
    assert.equal(ws.sent[0]?.d?.session_id, 'sess-resume');
  }

  // 3) 字段缺失（旧接口/沙箱）：放行，正常 IDENTIFY
  {
    FakeWS.instances.length = 0;
    const noField = makeGateway({ url: 'wss://example.test' });
    void noField.start();
    await tick();
    const ws = FakeWS.instances.at(-1);
    assert.ok(ws, 'session_start_limit 字段缺失时应照常连接');
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 999999 } }) });
    await tick();
    assert.equal(ws.sent[0]?.op, 2, '字段缺失时首帧应是 op2 IDENTIFY');
  }
});
