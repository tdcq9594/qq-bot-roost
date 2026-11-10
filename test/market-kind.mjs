/**
 * 市场索引里的 DSH 扩展条目必须被框架侧跳过
 * ==========================================
 *
 *   node --test test/market-kind.mjs
 *
 * 背景：扩展与框架插件共用 `index.json` / `plugin.json`（方案 §8「不新建仓库」）。
 * 扩展是 MCP server，由 DSH 按受管块 spawn，装在 `~/.dsh/dsh-roost/extensions/`；
 * 框架这边**不能**装它——旧逻辑会把 `raw.runtime` 缺省成 `python`，拉一个不存在的
 * 子进程，表现是「装上了但一点反应都没有」。
 *
 * 覆盖四件事：
 *   1. `isExtensionEntry` 只认 `kind: 'dsh-extension'`，不误判普通插件
 *   2. `installPlugin` 对扩展条目直接抛明确错误（在下载之前）
 *   3. `detectUpdates` 不把扩展当可更新插件
 *   4. `updatePlugins` 把扩展记成 skipped，且不去 resolve 目录
 * 外加一条源码级守卫：`loader.js` 的两处外部插件入口都要认 kind。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const { isExtensionEntry, installPlugin, detectUpdates, updatePlugins } = await import('../src/plugin/market.js');

test('isExtensionEntry：只认 kind === dsh-extension', () => {
  assert.equal(isExtensionEntry({ id: 'a', kind: 'dsh-extension' }), true);
  assert.equal(isExtensionEntry({ id: 'b', version: '1.0.0', runtime: 'python' }), false);
  assert.equal(isExtensionEntry({ id: 'c', kind: 'other' }), false);
  assert.equal(isExtensionEntry(null), false);
});

test('installPlugin：扩展条目在下载前就被明确拒绝', async () => {
  await assert.rejects(
    () => installPlugin({ entry: { id: 'bili', kind: 'dsh-extension', path: 'plugins/bili' }, pluginsDir: '/tmp/nope', repo: 'o/r' }),
    /不归框架插件市场/,
  );
});

test('detectUpdates：扩展不进更新列表', () => {
  const rows = detectUpdates([
    { id: 'bili', kind: 'dsh-extension' },
    { id: 'dice', version: '2.0.0' },
  ], { bili: '0.0.0', dice: '1.0.0' });
  assert.deepEqual(rows.map((r) => r.id), ['dice']);
});

test('updatePlugins：扩展记 skipped，不去碰目录', async () => {
  const out = await updatePlugins({
    tmp: '/tmp/does-not-exist',
    index: { plugins: [{ id: 'bili', kind: 'dsh-extension' }] },
    pluginsDir: '/tmp/does-not-exist-plugins',
    ids: null,
    localVersions: {},
  });
  assert.deepEqual(out.updated, []);
  assert.equal(out.failed.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.match(out.skipped[0].reason, /DSH 扩展/);
});

test('loader 源码守卫：两处外部插件入口都认 kind', async () => {
  const src = await fs.readFile(new URL('../src/plugin/loader.js', import.meta.url), 'utf8');
  const hits = src.match(/raw\?\.kind === 'dsh-extension'/g) ?? [];
  assert.ok(hits.length >= 2, `loader 里应有 2 处 kind 守卫（#loadExternal / #peekMeta），实际 ${hits.length}`);
});

test('build-market-index 与 build-index 的 kind 规则一致（防两份漂移）', async () => {
  const botScript = await fs.readFile(new URL('../scripts/build-market-index.mjs', import.meta.url), 'utf8');
  assert.match(botScript, /kind: 'dsh-extension', runtime: 'mcp'/);
  assert.match(botScript, /'kind'\]/, 'STRUCT_FIELDS 必须含 kind');
  const pluginsScript = path.resolve(import.meta.dirname, '../../qq-bot-roost-plugins/scripts/build-index.mjs');
  const exists = await fs.access(pluginsScript).then(() => true, () => false);
  if (!exists) return; // 单独 checkout 框架仓时没有兄弟仓，跳过；CI 里两边都在
  const p = await fs.readFile(pluginsScript, 'utf8');
  assert.match(p, /kind: 'dsh-extension', runtime: 'mcp'/);
  assert.match(p, /'kind'\]/, '插件仓 STRUCT_FIELDS 也要含 kind');
});
