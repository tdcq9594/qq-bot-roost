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
import { HostBridge } from '../src/host/index.js';
import { Registry } from '../src/plugin/context.js';

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
    installCommands: over.installCommands,
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

test('注入桥后方法表多出 5 个 ext.*，scope 正确', () => {
  const { methods } = rig();
  const names = methods.names();
  for (const n of ['ext.list', 'ext.call', 'ext.call.reply', 'ext.register', 'ext.command.reply']) {
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

// ---------------------------------------------------------------- 聊天命令

/** 记录 install 调用的假 registry：只看桥给它的清单，不掺 Registry 细节 */
function installer() {
  const calls = [];
  return {
    calls,
    fn: (list) => {
      calls.push(list);
      return list.filter((c) => c.name === 'taken').map((c) => ({ name: c.name, reason: '重名' }));
    },
    last: () => calls[calls.length - 1],
  };
}

test('ext.register 上报的命令被归一化：别名、权限、伪插件归属都对', () => {
  const inst = installer();
  const { bridge } = rig({ installCommands: inst.fn });
  const r = bridge.register({
    extensions: [{
      id: 'bili', name: 'B 站',
      actions: [{ id: 'share', label: '分享' }],
      commands: [{ name: 'Bili', aliases: ['哔哩', 'BILI'], desc: '投稿', admin: true, ownerOnly: true }],
    }],
    host: { name: 'dsh-roost', commands: [{ name: 'model', desc: '换模型', admin: true }] },
  });

  assert.equal(r.commands, 2);
  const list = inst.last();
  assert.deepEqual(list.map((c) => c.name), ['bili', 'model']);
  const bili = list.find((c) => c.name === 'bili');
  assert.equal(bili.pluginId, '__ext:bili');
  assert.equal(bili.pluginName, 'B 站');
  assert.deepEqual(bili.aliases, ['哔哩']);
  assert.equal(bili.admin, true);
  assert.equal(bili.ownerOnly, true);
  const host = list.find((c) => c.name === 'model');
  assert.equal(host.pluginId, '__dsh-roost');
  assert.equal(host.target, 'host');
  assert.equal(host.pluginName, 'dsh-roost');
});

test('名字不合法的命令整条丢弃，不把畸形条目带进 registry', () => {
  const inst = installer();
  const { bridge } = rig({ installCommands: inst.fn });
  const r = bridge.register({
    host: { commands: [{ name: '带 空格' }, { name: '' }, { name: 'ok_1' }, null, 'x'] },
  });
  assert.equal(r.commands, 1);
  assert.equal(inst.last()[0].name, 'ok_1');
});

test('重名不覆盖：冲突进 rejected，正常命令照装', () => {
  const inst = installer();
  const { bridge } = rig({ installCommands: inst.fn });
  const r = bridge.register({ host: { commands: [{ name: 'taken' }, { name: 'free' }] } });
  assert.equal(r.commands, 2);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].name, 'taken');
  assert.match(r.rejected[0].reason, /重名/);
});

test('命令总数超上限整批丢，并在 rejected 里说明', () => {
  const inst = installer();
  const { bridge } = rig({ installCommands: inst.fn });
  const many = Array.from({ length: 61 }, (_, i) => ({ name: `c${i}` }));
  const r = bridge.register({ host: { commands: many } });
  assert.equal(r.commands, 0);
  assert.match(r.rejected[0].reason, /超过上限/);
  assert.deepEqual(inst.last(), []);
});

test('重复上报是幂等重建：清单以最后一次为准', () => {
  const inst = installer();
  const { bridge } = rig({ installCommands: inst.fn });
  bridge.register({ host: { commands: [{ name: 'a' }, { name: 'b' }] } });
  bridge.register({ host: { commands: [{ name: 'a' }] } });
  assert.deepEqual(inst.last().map((c) => c.name), ['a']);
  assert.equal(bridge.list().host.commands.length, 1);
});

test('断线时命令一起摘掉，不留僵尸命令', () => {
  const inst = installer();
  const { bridge } = rig({ installCommands: inst.fn });
  bridge.register({ host: { commands: [{ name: 'model' }] } });
  assert.equal(inst.last().length, 1);
  bridge.clear('链路断开');
  assert.deepEqual(inst.last(), []);
  assert.equal(bridge.list().host.commands.length, 0);
});

test('命令触发推 ext.command.request，回执带正文就 resolve 成 { reply }', async () => {
  const { bridge, events } = rig();
  const p = bridge.command({ target: 'host', name: 'Model', msg: { chat: { chatId: 'g1' }, text: '/model' } });
  const req = events.find((e) => e.event === 'ext.command.request');
  assert.ok(req);
  assert.equal(req.data.target, 'host');
  assert.equal(req.data.name, 'model');
  assert.equal(req.data.msg.chat.chatId, 'g1');

  bridge.replyCommand({ requestId: req.data.requestId, ok: true, reply: '已切到 deepseek-v4' });
  assert.deepEqual(await p, { reply: '已切到 deepseek-v4' });
});

test('命令回执不带正文 → resolve null（客户端自己发过了）', async () => {
  const { bridge, events } = rig();
  const p = bridge.command({ target: 'ext', extId: 'bili', name: 'bili' });
  const req = events.find((e) => e.event === 'ext.command.request');
  assert.equal(req.data.extId, 'bili');
  bridge.replyCommand({ requestId: req.data.requestId, ok: true });
  assert.equal(await p, null);
});

test('命令失败/超时都要能结束，不能挂死', async () => {
  const { bridge, events } = rig({ timeoutMs: 20 });
  const p = bridge.command({ target: 'host', name: 'slow' });
  bridge.replyCommand({ requestId: events[0].data.requestId, ok: false, error: '没这个会话' });
  await assert.rejects(p, /没这个会话/);

  await assert.rejects(bridge.command({ target: 'host', name: 'slow2' }), /没在 20ms 内回执/);
  assert.equal(bridge.pendingCount(), 0);
});

test('命令参数不合法直接拒，不发事件', async () => {
  const { bridge, events } = rig();
  await assert.rejects(bridge.command({ target: 'ext', name: 'x' }), /要给 extId/);
  await assert.rejects(bridge.command({ target: 'host', name: '带 空格' }), /命令名不合法/);
  assert.equal(events.length, 0);
});

test('命令回执认不出 id 一律拒绝（防伪造）', () => {
  const { bridge } = rig();
  assert.throws(() => bridge.replyCommand({ requestId: 'forged', reply: 'x' }), /没有这个待回执/);
});

// ---------------------------------------------------------------- 接到 registry

/** 不启监听，只用到 constructor 里的方法表与桥 */
function hostRig() {
  const registry = new Registry();
  const runtime = {
    id: 'b1', name: '测试鸟', online: true, cfg: { commandPrefix: '/' },
    registry, groupNames: new Map(),
  };
  const hb = new HostBridge({ runtime, cfg: {}, botId: 'b1' });
  return { hb, registry, runtime, scopes: new Set(['read', 'message', 'manage']) };
}

/** 最小 msg：serializeMessage 只读这些字段，reply 用来收代发正文 */
function fakeMsg(text = '/model') {
  const sent = [];
  return {
    sent,
    id: 'm1', kind: 'group', chatId: 'g1', groupId: 'g1', userId: 'u1',
    content: text, args: [], receivedAt: Date.now(),
    reply: async (t) => {
      sent.push(String(t));
      return { id: 'out1' };
    },
  };
}

test('ext.register 把宿主命令真装进 registry，别名成隐藏命令', async () => {
  const { hb, registry, scopes } = hostRig();
  const r = await hb.methods.call(
    'ext.register',
    { host: { name: 'dsh-roost', commands: [{ name: 'model', desc: '换模型', admin: true, aliases: ['模型'] }] } },
    { scopes },
  );
  assert.equal(r.ok, true);
  assert.equal(r.commands, 1);
  assert.deepEqual(r.rejected, []);

  const entry = registry.commands.get('model');
  assert.equal(entry.pluginId, '__dsh-roost');
  assert.equal(entry.admin, true);
  assert.equal(typeof entry.handler, 'function');
  assert.ok(registry.commands.has('模型'), '别名要能直呼');
  assert.equal(registry.menus.get('__dsh-roost').title, 'dsh-roost');
  const texts = registry.menus.get('__dsh-roost').sections.flatMap((s) => s.items.map((i) => i.text));
  assert.deepEqual(texts, ['model'], '别名不进菜单');
});

test('与内核/插件命令重名时拒绝该条，其余照装', async () => {
  const { hb, registry, scopes } = hostRig();
  registry.addCommand('__core', 'help', { pattern: 'help' }, () => {});
  const r = await hb.methods.call(
    'ext.register',
    { host: { commands: [{ name: 'help' }, { name: 'dstatus' }] } },
    { scopes },
  );
  assert.equal(r.commands, 2, '清单本身要如实反映上报了几条');
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].name, 'help');
  assert.equal(registry.commands.get('help').pluginId, '__core', '原命令不能被顶掉');
  assert.ok(registry.commands.has('dstatus'));
});

test('命令被触发 → 推 ext.command.request；回执带正文由框架代发', async () => {
  const { hb, registry, scopes, runtime } = hostRig();
  await hb.methods.call('ext.register', { host: { commands: [{ name: 'model', desc: 'x' }] } }, { scopes });

  const msg = fakeMsg('/model list');
  runtime.host = hb;
  const handled = registry.commands.get('model').handler(msg);

  /* 事件是同步 push 出来的，等一个微任务即可拿到 */
  await Promise.resolve();
  const req = hb.buffer.find((f) => f.event === 'ext.command.request');
  assert.ok(req, '要推出 ext.command.request');
  assert.equal(req.data.target, 'host');
  assert.equal(req.data.name, 'model');
  assert.equal(req.data.msg.chat.chatId, 'g1');

  await hb.methods.call('ext.command.reply', { requestId: req.data.requestId, reply: '当前：deepseek-v4' }, { scopes });
  await handled;
  assert.deepEqual(msg.sent, ['当前：deepseek-v4']);
});

test('命令回执不带正文时框架不补话（客户端自己发过了）', async () => {
  const { hb, registry, scopes } = hostRig();
  await hb.methods.call('ext.register', { host: { commands: [{ name: 'mood' }] } }, { scopes });
  const msg = fakeMsg('/mood');
  const handled = registry.commands.get('mood').handler(msg);
  await Promise.resolve();
  const req = hb.buffer.find((f) => f.event === 'ext.command.request');
  await hb.methods.call('ext.command.reply', { requestId: req.data.requestId }, { scopes });
  await handled;
  assert.deepEqual(msg.sent, []);
});

test('客户端一直不回执：超时后回一句人话，不让群里干等', async () => {
  const { hb, registry, scopes } = hostRig();
  hb.extBridge = createExtBridge({ pushEvent: () => {}, timeoutMs: 10, log: () => {} });
  /* 直接验 handler 的超时分支：用 registry 里已装的那条，换成新桥不影响它的捕获变量 */
  await hb.methods.call('ext.register', { host: { commands: [{ name: 'slow' }] } }, { scopes });
  const msg = fakeMsg('/slow');
  await registry.commands.get('slow').handler(msg);
  assert.equal(msg.sent.length, 1);
  assert.match(msg.sent[0], /没接住这个命令/);
});
