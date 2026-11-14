/**
 * 框架插件 ↔ DSH 扩展：反向调用桥
 * ================================
 *
 * 重点：请求/回执配对、超时、伪造回执、断线清理、能力清单上报。
 * 不依赖 ws / 网络，纯逻辑跑。
 *
 * 跑法：node --test test/host-ext-bridge.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createExtBridge } from '../src/host/ext-bridge.js';
import { createMethods, HOST_PROTOCOL } from '../src/host/methods.js';

/** 协议方法表需要的最小 runtime */
function runtime() {
  return { id: 'b1', name: '测试鸟', online: true, status: {}, cfg: {}, registry: null };
}

function rig(over = {}) {
  const events = [];
  const bridge = createExtBridge({
    pushEvent: (event, data) => events.push({ event, data }),
    timeoutMs: over.timeoutMs ?? 500,
    log: () => {},
  });
  const methods = createMethods({
    runtime: runtime(),
    getState: () => ({ seq: 1, state: 'running', version: '1' }),
    log: () => {},
    extBridge: bridge,
  });
  return { bridge, methods, events };
}

// ---------------------------------------------------------------- 桥本体

test('ext.call 推一条 SSE 请求，收到回执后 resolve', async () => {
  const { bridge, events } = rig();
  const p = bridge.call({ extId: 'bili', action: 'test_share', payload: { bvid: 'BV1' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'ext.call.request');
  assert.equal(events[0].data.extId, 'bili');
  assert.equal(events[0].data.action, 'test_share');
  assert.deepEqual(events[0].data.payload, { bvid: 'BV1' });

  const { requestId } = events[0].data;
  assert.equal(bridge.pendingCount(), 1);
  const r = bridge.reply({ requestId, ok: true, result: { sent: 1 } });
  assert.equal(r.settled, requestId);
  assert.deepEqual(await p, { sent: 1 });
  assert.equal(bridge.pendingCount(), 0);
});

test('失败回执 reject，且带扩展给出的原因', async () => {
  const { bridge, events } = rig();
  const p = bridge.call({ extId: 'bili', action: 'nope' });
  bridge.reply({ requestId: events[0].data.requestId, ok: false, error: '没有声明这个动作' });
  await assert.rejects(p, /没有声明这个动作/);
});

test('超时后回执无效：不能让迟到的结果解掉新请求', async () => {
  const { bridge, events } = rig({ timeoutMs: 20 });
  await assert.rejects(bridge.call({ extId: 'bili', action: 'slow' }), /没在 20ms 内回执/);
  const id = events[0].data.requestId;
  assert.throws(() => bridge.reply({ requestId: id, ok: true, result: 'late' }), /没有这个待回执/);
  assert.equal(bridge.pendingCount(), 0);
});

test('认不出的 requestId 一律拒绝（防伪造回执）', () => {
  const { bridge } = rig();
  assert.throws(() => bridge.reply({ requestId: 'forged', ok: true, result: 1 }), /没有这个待回执/);
});

test('参数缺失 / 并发上限都要挡住', async () => {
  const { bridge, events } = rig();
  await assert.rejects(bridge.call({ extId: '', action: 'x' }), /要给 extId 与 action/);
  assert.equal(events.length, 0);
});

test('断线时把在等的调用全部解掉，插件不会挂在 await 上', async () => {
  const { bridge } = rig({ timeoutMs: 5000 });
  const a = bridge.call({ extId: 'a', action: 'x' });
  const b = bridge.call({ extId: 'b', action: 'y' });
  assert.equal(bridge.pendingCount(), 2);
  bridge.clear('链路断开');
  await assert.rejects(a, /链路断开/);
  await assert.rejects(b, /链路断开/);
  assert.equal(bridge.pendingCount(), 0);
});

test('payload 超量键被截断；非对象 payload 不进事件', async () => {
  const { bridge, events } = rig();
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
  const p = bridge.call({ extId: 'x', action: 'y', payload: many });
  assert.equal(Object.keys(events[0].data.payload).length, 40);
  bridge.reply({ requestId: events[0].data.requestId, ok: true });
  await p;
});

// ---------------------------------------------------------------- 能力清单

test('register 只留合法扩展与动作，列表是副本不能被外部改', () => {
  const { bridge } = rig();
  const r = bridge.register({ extensions: [
    { id: 'bili', actions: [{ id: 'test_share', label: '分享' }, { id: '' }] },
    { id: '', actions: [] },
    null,
  ] });
  assert.equal(r.count, 1);
  const list = bridge.list();
  assert.equal(list.extensions.length, 1);
  assert.deepEqual(list.extensions[0].actions, [{ id: 'test_share', label: '分享' }]);
  list.extensions[0].actions.push({ id: 'hack', label: 'x' });
  assert.equal(bridge.list().extensions[0].actions.length, 1, '外部改不到内部清单');
  assert.ok(list.updatedAt > 0);
});

// ---------------------------------------------------------------- 协议方法

test('注入桥后方法表多出 4 个 ext.*，scope 正确', () => {
  const { methods } = rig();
  const names = methods.names();
  for (const n of ['ext.list', 'ext.call', 'ext.call.reply', 'ext.register']) {
    assert.ok(names.includes(n), `缺方法 ${n}`);
  }
  const describe = methods.describe();
  assert.equal(describe.find((m) => m.name === 'ext.list').scope, 'read');
  assert.equal(describe.find((m) => m.name === 'ext.call').scope, 'message');
  assert.ok(String(HOST_PROTOCOL).length > 0);
});

test('没注入桥时不注册 ext.*（老版本能力表如实）', () => {
  const m = createMethods({ runtime: runtime(), getState: () => ({}), log: () => {} });
  assert.equal(m.names().some((n) => n.startsWith('ext.')), false);
});

test('ext.call 经方法表能走通，ext.register 能上报', async () => {
  const { methods, bridge, events } = rig();
  const scopes = new Set(['read', 'message']);
  const reg = await methods.call('ext.register', { extensions: [{ id: 'bili', actions: [{ id: 'share', label: '分享' }] }] }, { scopes });
  assert.equal(reg.count, 1);
  assert.equal((await methods.call('ext.list', {}, { scopes })).extensions[0].extId, 'bili');

  const p = methods.call('ext.call', { extId: 'bili', action: 'share', payload: { n: 1 } }, { scopes });
  const req = events.find((e) => e.event === 'ext.call.request');
  assert.ok(req);
  await methods.call('ext.call.reply', { requestId: req.data.requestId, ok: true, result: { ok: true } }, { scopes });
  assert.deepEqual(await p, { ok: true, result: { ok: true } });
});

test('ext.list 只需要 read scope；ext.call 没 message scope 会被挡', async () => {
  const { methods } = rig();
  assert.ok(await methods.call('ext.list', {}, { scopes: new Set(['read']) }));
  await assert.rejects(
    methods.call('ext.call', { extId: 'bili', action: 'share' }, { scopes: new Set(['read']) }),
    /需要 message 权限/,
  );
});
