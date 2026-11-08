// 插件运行期错误环形缓冲 + 快照热重载。
//
// 这两块都不报错、不抛异常，只会「悄悄没留痕」或「悄悄拿旧子模块」，
// 所以断言盯的是副作用：留了几条、留的是不是最新的、子模块有没有真重载。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { pushRuntimeError, RUNTIME_ERROR_MAX } from '../src/plugin/runtime-errors.js';
import { makeSnapshot, pruneSnapshots } from '../src/plugin/snapshot.js';
import { PluginManager } from '../src/plugin/loader.js';
import { redactText } from '../src/runtime.js';

test('运行期错误：只留最近 8 条，带 message 和短栈', () => {
  let ring = [];
  for (let i = 0; i < 12; i += 1) ring = pushRuntimeError(ring, new Error(`e${i}`), 1000 + i);
  assert.equal(ring.length, RUNTIME_ERROR_MAX);
  assert.equal(ring[0].message, 'e4');
  assert.equal(ring.at(-1).message, 'e11');
  assert.equal(ring[0].at, 1004);
  assert.ok(ring[0].stack.includes('Error: e4'));
});

test('运行期错误：传字符串也能记，不炸', () => {
  const ring = pushRuntimeError([], 'boom', 1);
  assert.equal(ring[0].message, 'boom');
  assert.equal(ring[0].stack, '');
});

test('快照：改子模块后重载生效，不是只重载入口', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roost-snap-'));
  const write = (v) => Promise.all([
    fs.writeFile(path.join(dir, 'index.js'), "import { v } from './sub.js'; export default { v };\n"),
    fs.writeFile(path.join(dir, 'sub.js'), `export const v = ${v};\n`),
  ]);

  await write(1);
  const s1 = await makeSnapshot(dir, path.join(dir, 'index.js'));
  const m1 = await import(pathToFileURL(s1.entry).href);
  assert.equal(m1.default.v, 1);

  await write(2);
  const s2 = await makeSnapshot(dir, path.join(dir, 'index.js'));
  assert.notEqual(s1.entry, s2.entry, '每次快照路径必须不同，否则 ESM 还是拿缓存');
  const m2 = await import(pathToFileURL(s2.entry).href);
  assert.equal(m2.default.v, 2, '子模块也必须重载，不能还是旧值');

  await pruneSnapshots(s1.snapRoot, s2.stamp);
  assert.deepEqual(await fs.readdir(s1.snapRoot), [s2.stamp], '旧快照要清掉');
  // 快照里不能混进上一次的快照或依赖目录
  assert.equal(await fs.readdir(path.join(s2.snapDir, '.roost-cache')).then(() => true).catch(() => false), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('快照：插件自己目录名里带 data/config 之类的词也不受影响', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'data-config-plugin-'));
  const dir = path.join(root, 'my-plugin');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), 'export default { ok: true };\n');
  const s = await makeSnapshot(dir, path.join(dir, 'index.js'));
  const m = await import(pathToFileURL(s.entry).href);
  assert.equal(m.default.ok, true);
  await fs.rm(root, { recursive: true, force: true });
});

test('快照：排除只在顶层生效，嵌套 src/data、lib/config 必须留下', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roost-snap-top-'));
  await fs.writeFile(path.join(dir, 'index.js'), 'export default { ok: true };\n');
  for (const p of ['src/data/keep.js', 'lib/config/keep.js', 'data/drop.js', 'config/drop.js', 'node_modules/drop.js']) {
    await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await fs.writeFile(path.join(dir, p), 'export const v = 1;\n');
  }
  const s = await makeSnapshot(dir, path.join(dir, 'index.js'));
  const has = (p) => existsSync(path.join(s.snapDir, p));
  assert.equal(has('src/data/keep.js'), true, '嵌套 data 是插件代码，不该被排除');
  assert.equal(has('lib/config/keep.js'), true, '嵌套 config 同理');
  assert.equal(has('data/drop.js'), false);
  assert.equal(has('config/drop.js'), false);
  assert.equal(has('node_modules/drop.js'), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('运行期错误文本：下发面板前抹掉 token / Authorization', () => {
  const raw = 'GET https://x?token=SECRETVALUE123 Authorization: Bearer abcdef1234567890 auth_token=XYZ';
  const out = redactText(raw);
  assert.ok(!out.includes('SECRETVALUE123'), out);
  assert.ok(!out.includes('abcdef1234567890'), out);
  assert.match(out, /auth_token=\*\*\*/);
});

test('reload：新实例不该留着旧 handler 的运行期错误', async () => {
  const mgr = Object.create(PluginManager.prototype);
  mgr.runtimeErrors = new Map([['p1', [{ at: 1, message: 'old', stack: '' }]]]);
  let unloaded = 0;
  let loaded = 0;
  mgr.unload = async () => { unloaded += 1; return true; };
  mgr.load = async () => { loaded += 1; return true; };
  assert.equal(await mgr.reload('p1'), true);
  assert.equal(unloaded, 1);
  assert.equal(loaded, 1);
  assert.equal(mgr.runtimeErrors.has('p1'), false);
});
