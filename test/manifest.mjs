/**
 * 插件清单（provides / engines）的单测
 * ====================================
 *
 *   node --test test/manifest.mjs
 *
 * 这一层的错法都很安静：冲突没查出来 = 后加载的插件「装上了但不生效」；
 * 版本范围判错 = 本来能用的插件被拦。两种都不会在别处冒出来，所以逐格钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProvides,
  normalizeManifest,
  checkEngines,
  Declarations,
} from '../src/plugin/manifest.js';

/** 极简 satisfies：只支持 >=x.y.z 与 *，够测逻辑分支 */
const satisfies = (v, r) => {
  if (r === '*') return true;
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (!m) throw new Error('bad range');
  const a = v.split('.').map(Number);
  const b = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
};

test('normalizeProvides：去重、去空、忽略非数组', () => {
  assert.deepEqual(normalizeProvides({ commands: ['a', 'a', ' ', null], tools: 'x' }), {
    commands: ['a'],
    tools: [],
    hooks: [],
  });
  assert.deepEqual(normalizeProvides(null), { commands: [], tools: [], hooks: [] });
});

test('normalizeManifest：认 requires.provides 与 engines', () => {
  const m = normalizeManifest({
    requires: { provides: { tools: ['t1'] } },
    engines: { roost: '>=0.9.0', node: '>=22', dsh: '  ' },
  });
  assert.deepEqual(m.provides.tools, ['t1']);
  assert.deepEqual(m.engines, { roost: '>=0.9.0', node: '>=22' });
});

test('checkEngines：满足 / 不满足 / 查不到就跳过', () => {
  assert.equal(checkEngines({ roost: '>=0.9.0' }, { roost: '0.9.7' }, satisfies).ok, true);
  const bad = checkEngines({ roost: '>=0.10.0' }, { roost: '0.9.7' }, satisfies);
  assert.equal(bad.ok, false);
  assert.match(bad.why, /要求 roost/);
  assert.equal(checkEngines({ dsh: '>=0.2.0' }, { roost: '0.9.7' }, satisfies).ok, true, '不知道 dsh 版本就不能拒');
});

test('checkEngines：非法范围给出可读原因，而不是抛出去', () => {
  const r = checkEngines({ roost: 'abc' }, { roost: '0.9.7' }, satisfies);
  assert.equal(r.ok, false);
  assert.match(r.why, /不是合法的版本范围/);
});

test('声明：同名冲突会报出占用者，且冲突项一条都不落表', () => {
  const d = new Declarations();
  assert.deepEqual(d.claim('a', { commands: ['dice'], tools: ['t'] }), []);
  const c = d.claim('b', { commands: ['dice', 'roll'] });
  assert.equal(c.length, 1);
  assert.deepEqual(c[0], { kind: 'commands', name: 'dice', owner: 'a' });
  // 冲突时整批不落：roll 也不该被 b 占住
  assert.deepEqual(d.claim('c', { commands: ['roll'] }), []);
  assert.deepEqual(d.byPlugin().get('c').commands, ['roll']);
});

test('声明：同一个插件重复认领自己的名字不算冲突', () => {
  const d = new Declarations();
  d.claim('a', { commands: ['x'] });
  assert.deepEqual(d.claim('a', { commands: ['x'] }), []);
});

test('声明：释放后名字可以再被认领', () => {
  const d = new Declarations();
  d.claim('a', { commands: ['x'] });
  assert.equal(d.release('a'), 1);
  assert.deepEqual(d.claim('b', { commands: ['x'] }), []);
});

test('声明：byPlugin 按插件分组', () => {
  const d = new Declarations();
  d.claim('a', { commands: ['c1'], tools: ['t1'], hooks: ['message'] });
  const g = d.byPlugin().get('a');
  assert.deepEqual(g, { commands: ['c1'], tools: ['t1'], hooks: ['message'] });
});
