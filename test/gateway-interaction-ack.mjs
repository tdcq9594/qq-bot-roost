/**
 * WS 分支的交互回执（gateway.js DISPATCH）
 * =======================================
 *
 * 以前 `putInteraction` 只有 webhook.js 会调，WS 模式下回调型按钮点下去
 * 平台收不到 PUT，客户端一直转圈。这里驱动一个假的 WebSocket 走完整条
 * DISPATCH 路径，钉住「哪些事件该回执、哪些不该」。
 *
 * 刻意不连真网关：替换 globalThis.WebSocket 即可，零依赖、跑得快。
 *
 * 跑法：node --test test/gateway-interaction-ack.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Gateway } from '../src/gateway.js';

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
  send() {}
  close() {}
}

/**
 * 造一个已连上的 Gateway，把 message handler 交出去。
 * 会先 emit('open') 清掉 #connect 的 20 秒连接超时定时器，避免测试挂住。
 */
async function withGateway(run, { onAck } = {}) {
  const acks = [];
  const dispatched = [];
  const api = {
    getGateway: async () => ({ url: 'wss://example.test' }),
    putInteraction: (id, code) => {
      if (onAck) return onAck(id, code);
      acks.push({ id, code });
      return Promise.resolve({ ok: true });
    },
  };
  const tokens = { get: async () => 'test-token' };
  const gateway = new Gateway({
    api,
    tokens,
    intents: 0,
    onDispatch: (t) => dispatched.push(t),
  });

  const OriginalWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  let ws;
  try {
    void gateway.start();
    await tick();
    ws = FakeWS.instances.at(-1);
    assert.ok(ws, '应当建出一条 WebSocket');
    ws.emit('open');
    await run({ ws, acks, dispatched });
  } finally {
    gateway.stop();
    globalThis.WebSocket = OriginalWS;
    FakeWS.instances.length = 0;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function dispatch(ws, d, s = 1, t = 'INTERACTION_CREATE') {
  ws.emit('message', { data: JSON.stringify({ op: 0, t, s, d }) });
}

test('type 11 / 12 的交互事件会 PUT /interactions/{id}，且只有一次', async () => {
  await withGateway(async ({ ws, acks, dispatched }) => {
    dispatch(ws, { id: 'i-11', type: 11 }, 1);
    await tick();
    dispatch(ws, { id: 'i-12', type: 12 }, 2);
    await tick();
    assert.deepEqual(acks, [
      { id: 'i-11', code: 0 },
      { id: 'i-12', code: 0 },
    ]);
    assert.equal(dispatched.length, 2, '回执不能挡住正常分发');
  });
});

test('type 落在 d.data.type 时也能识别（口径与 webhook.js 对齐）', async () => {
  await withGateway(async ({ ws, acks }) => {
    dispatch(ws, { id: 'i-nested', data: { type: 11 } }, 1);
    await tick();
    assert.deepEqual(acks, [{ id: 'i-nested', code: 0 }]);
  });
});

test('13/14/16/18/19 等官方明确不用回执的类型不回', async () => {
  await withGateway(async ({ ws, acks }) => {
    for (const [i, tt] of [13, 14, 16, 18, 19].entries()) {
      dispatch(ws, { id: `i-${tt}`, type: tt }, i + 1);
    }
    await tick();
    assert.deepEqual(acks, []);
  });
});

test('缺 id 不回执，避免 PUT /interactions/undefined', async () => {
  await withGateway(async ({ ws, acks }) => {
    dispatch(ws, { type: 11 }, 1);
    dispatch(ws, { id: '', type: 11 }, 2);
    await tick();
    assert.deepEqual(acks, []);
  });
});

test('resume 重放的重复 seq 不会重复回执（去重之后才 PUT）', async () => {
  await withGateway(async ({ ws, acks }) => {
    dispatch(ws, { id: 'i-dup', type: 11 }, 5);
    await tick();
    dispatch(ws, { id: 'i-dup', type: 11 }, 5);
    await tick();
    assert.deepEqual(acks, [{ id: 'i-dup', code: 0 }]);
  });
});

test('普通事件不触发回执，READY/RESUMED 也不受影响', async () => {
  await withGateway(async ({ ws, acks, dispatched }) => {
    dispatch(ws, { content: 'hi' }, 1, 'GROUP_AT_MESSAGE_CREATE');
    await tick();
    dispatch(ws, { session_id: 'sess-1', user: { username: 'bot', id: '1' } }, 2, 'READY');
    await tick();
    dispatch(ws, {}, 3, 'RESUMED');
    await tick();
    assert.deepEqual(acks, []);
    assert.equal(dispatched.length, 1, 'READY/RESUMED 走生命周期分支，不进 onDispatch');
  });
});

test('回执返回 rejected 不影响分发（catch 挂在 Promise 上）', async () => {
  await withGateway(async ({ ws, dispatched }) => {
    dispatch(ws, { id: 'i-reject', type: 11 }, 1);
    await tick();
    assert.equal(dispatched.length, 1, 'PUT 失败也不能吞掉分发');
  }, { onAck: () => Promise.reject(new Error('boom')) });
});

test('回执同步抛错不影响分发（try/catch 兜住）', async () => {
  await withGateway(async ({ ws, dispatched }) => {
    dispatch(ws, { id: 'i-throw', type: 11 }, 1);
    await tick();
    assert.equal(dispatched.length, 1, 'PUT 失败也不能吞掉分发');
  }, { onAck: () => { throw new Error('sync boom'); } });
});
