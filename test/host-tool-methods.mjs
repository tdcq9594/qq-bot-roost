/**
 * 方案 A：插件工具 → 一等协议方法
 * ==============================
 *
 * 插件只要照旧 `ctx.registerTool()`，协议里就多一个 `tool.<name>` 方法，
 * `system.capabilities` 能列出来、scope 校验照样生效、插件卸载后立刻 404。
 * 这份测试钉住的是「接线 + 语义」，不是只验方法名出现了一下。
 *
 * 跑法：node --test test/host-tool-methods.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMethods, HostError } from '../src/host/methods.js';
import { HostBridge } from '../src/host/index.js';

const TOKEN = 'tool-methods-token-0123456789';

/** 最小注册表：只实现 createToolCaller / listTools 真正会读的那几个方法 */
function makeRegistry() {
  const tools = new Map();
  return {
    tools,
    addTool(pluginId, meta, handler) {
      if (tools.has(meta.name)) throw new Error(`工具重名：${meta.name}`);
      tools.set(meta.name, {
        ...meta,
        pluginId,
        pluginName: meta.pluginName ?? pluginId,
        handler,
      });
    },
    removeTool(pluginId, name) {
      const e = tools.get(name);
      if (e && e.pluginId === pluginId) tools.delete(name);
    },
    getTool(name) { return tools.get(String(name)) ?? null; },
    listTools({ includeHidden = false } = {}) {
      return [...tools.values()]
        .filter((e) => includeHidden || !e.hidden)
        .map(({ name, description, parameters, pluginId, pluginName, ownerOnly, admin }) => ({
          name, description, parameters, pluginId, pluginName, ownerOnly, admin,
        }));
    },
  };
}

function makeRuntime(reg) {
  return {
    id: 'tool-methods-bot',
    name: '测试鸟',
    state: 'online',
    online: true,
    cfg: { appId: '1024' },
    status: { id: 'tool-methods-bot' },
    registry: reg,
    api: null,
    plugins: null,
    ledger: null,
    gate: null,
  };
}

function makeMethods(reg) {
  return createMethods({
    runtime: makeRuntime(reg),
    getState: () => ({ version: '0.0.0-test', seq: 1, connections: 1, counters: { ok: 0, fail: 0 } }),
  });
}

function seed(reg) {
  reg.addTool('dice', {
    name: 'roll_dice',
    description: '掷一个骰子',
    parameters: { type: 'object', properties: { sides: { type: 'integer' } }, required: ['sides'] },
  }, async ({ sides }) => `掷出了 ${Math.floor(Math.random() * sides) + 1}`);
  reg.addTool('dice', {
    name: 'owner_reset',
    description: '只有主人能重置',
    ownerOnly: true,
    parameters: { type: 'object', properties: {} },
  }, async () => 'reset ok');
  reg.addTool('dice', {
    name: 'secret_helper',
    description: '隐藏工具',
    hidden: true,
  }, async () => 'hidden');
}

const READ = new Set(['read']);
const MSG = new Set(['read', 'message']);
const MANAGE = new Set(['read', 'message', 'manage']);

/* ---------------- 能力表 ---------------- */

test('动态方法：工具进 names / describe，hidden 不进，带 JSON Schema', () => {
  const reg = makeRegistry();
  seed(reg);
  const m = makeMethods(reg);
  assert.ok(m.names().includes('tool.roll_dice'));
  assert.ok(!m.names().includes('tool.secret_helper'), 'hidden 工具不能出现在能力表');
  const d = m.describe().find((x) => x.name === 'tool.roll_dice');
  assert.equal(d.scope, 'message');
  assert.equal(d.parameters.required[0], 'sides');
  assert.match(d.desc, /插件工具/);
  assert.equal(m.describe().find((x) => x.name === 'tool.owner_reset').scope, 'manage');
});

test('动态方法：system.hello 声明 dynamicTools 并列出一等方法', async () => {
  const reg = makeRegistry();
  seed(reg);
  const hi = await makeMethods(reg).call('system.hello', {}, { scopes: READ });
  assert.equal(hi.dynamicTools, true);
  assert.ok(hi.features.includes('tool.roll_dice'));
});

/* ---------------- 调用与权限 ---------------- */

test('动态方法：message 令牌能调普通工具，读令牌不行', async () => {
  const reg = makeRegistry();
  seed(reg);
  const m = makeMethods(reg);
  const r = await m.call('tool.roll_dice', { sides: 6 }, { scopes: MSG });
  assert.equal(r.tool, 'roll_dice');
  assert.match(r.result, /掷出了/);
  await assert.rejects(
    m.call('tool.roll_dice', { sides: 6 }, { scopes: READ }),
    (e) => e instanceof HostError && e.code === 'NO_SCOPE',
  );
});

test('动态方法：ownerOnly / admin 工具提到 manage，不能靠 message 令牌绕过', async () => {
  const reg = makeRegistry();
  seed(reg);
  const m = makeMethods(reg);
  await assert.rejects(
    m.call('tool.owner_reset', {}, { scopes: MSG }),
    (e) => e instanceof HostError && e.code === 'NO_SCOPE',
  );
  const r = await m.call('tool.owner_reset', {}, { scopes: MANAGE });
  assert.equal(r.result, 'reset ok');
});

test('动态方法：required 与类型按 JSON Schema 挡住，参数直接传或放进 args 都行', async () => {
  const reg = makeRegistry();
  seed(reg);
  const m = makeMethods(reg);
  await assert.rejects(
    m.call('tool.roll_dice', {}, { scopes: MSG }),
    (e) => e instanceof HostError && e.code === 'BAD_PARAMS',
  );
  await assert.rejects(
    m.call('tool.roll_dice', { sides: '六' }, { scopes: MSG }),
    (e) => e instanceof HostError && e.code === 'BAD_PARAMS',
  );
  const r = await m.call('tool.roll_dice', { args: { sides: 20 } }, { scopes: MSG });
  assert.equal(r.tool, 'roll_dice');
});

test('动态方法：插件卸载后立刻 404，能力表与签名同步变化', async () => {
  const reg = makeRegistry();
  seed(reg);
  const m = makeMethods(reg);
  const before = m.toolSignature();
  assert.match(before, /tool\.roll_dice/);
  reg.removeTool('dice', 'roll_dice');
  await assert.rejects(
    m.call('tool.roll_dice', { sides: 6 }, { scopes: MSG }),
    (e) => e instanceof HostError && e.code === 'NOT_FOUND',
  );
  assert.ok(!m.names().includes('tool.roll_dice'));
  assert.notEqual(m.toolSignature(), before);
});

test('原有 plugin.tool.call 重构后语义不变（manage 可调、返回工具结果）', async () => {
  const reg = makeRegistry();
  seed(reg);
  const r = await makeMethods(reg).call('plugin.tool.call', { name: 'roll_dice', args: { sides: 6 } }, { scopes: MANAGE });
  assert.match(r, /掷出了/);
});

test('工具执行抛错变成 INTERNAL，不把原始异常漏给客户端', async () => {
  const reg = makeRegistry();
  reg.addTool('bad', { name: 'boom', description: '会炸' }, async () => { throw new Error('内部细节'); });
  await assert.rejects(
    makeMethods(reg).call('tool.boom', {}, { scopes: MSG }),
    (e) => e instanceof HostError && e.code === 'INTERNAL',
  );
});

/* ---------------- 事件流 ---------------- */

test('端到端：插件热重载导致工具集变化时推 capabilities.changed', async (t) => {
  const reg = makeRegistry();
  const runtime = makeRuntime(reg);
  const bridge = new HostBridge({
    runtime,
    cfg: {
      enabled: true, token: TOKEN, host: '127.0.0.1', port: 0,
      scopes: ['read', 'message'], allowManage: false, forwardAll: true,
    },
    botId: 'tool-methods-bot',
  });
  t.after(() => bridge.stop());
  await bridge.start();
  assert.equal(bridge.state, 'running', `没能起来：${bridge.error}`);

  const rpc = async (method, params = {}) => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 'c1', method, params }),
    });
    return { status: res.status, body: await res.json() };
  };

  const hi = await rpc('system.hello');
  assert.equal(hi.status, 200);
  assert.equal(hi.body.data.dynamicTools, true);
  assert.ok(!hi.body.data.features.includes('tool.roll_dice'));

  seed(reg);
  const after = await rpc('system.ping');
  assert.equal(after.status, 200);
  const changed = bridge.buffer.filter((e) => e.event === 'capabilities.changed');
  assert.equal(changed.length, 1, '签名变化后应该推一条，不多不少');
  assert.ok(changed[0].data.features.includes('tool.roll_dice'));
  assert.ok(changed[0].data.tools.some((x) => x.name === 'tool.roll_dice'));

  /** 再打一次不该重复推 */
  await rpc('system.ping');
  assert.equal(bridge.buffer.filter((e) => e.event === 'capabilities.changed').length, 1);
});
