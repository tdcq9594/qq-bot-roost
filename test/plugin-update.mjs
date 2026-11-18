/**
 * 插件更新：目录被占用时也要能更新完
 * ==================================
 *
 *   node --test test/plugin-update.mjs
 *
 * 背景：更新走的是 `rename(插件目录 → .bak-<id>)`，原子且干净。但 Windows 上
 * 只要**任何**进程按住了这个目录（资源管理器停在里面、杀软在扫、IDE 建索引，
 * 或插件自己的子进程把 cwd 设成了它），rename 就 EBUSY/EPERM，而目录里的文件
 * 照样能读写。旧实现直接抛错，用户只能看到「插件更新失败: EPERM」。
 *
 * 现在：rename 失败就退化成「复制备份 + 逐文件覆盖」。这里覆盖三件事：
 *   1. `syncCodeTree` 的就地语义：覆盖同名、新增新文件、删掉新版没有的旧文件
 *   2. 运行态目录（data/ 等）在就地覆盖时不被碰
 *   3. `updatePlugins` 正常路径（rename）也把 data/ 带回来、并清掉 .bak-
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { syncCodeTree, updatePlugins } = await import('../src/plugin/market.js');

const KEEP = new Set(['node_modules', '.roost-cache', 'data', 'logs', 'config', 'env', '.cache']);

async function tmpdir(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), `roost-${tag}-`));
}

async function write(p, text) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
}

const read = (p) => fs.readFile(p, 'utf8').catch(() => null);

test('syncCodeTree：覆盖同名、补新文件、删旧文件', async () => {
  const root = await tmpdir('sync');
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');

  await write(path.join(src, 'index.js'), '// v2');
  await write(path.join(src, 'lib', 'new.js'), '// 新增');
  await write(path.join(dest, 'index.js'), '// v1');
  await write(path.join(dest, 'lib', 'gone.js'), '// 新版已删除');

  await syncCodeTree(src, dest, KEEP);

  assert.equal(await read(path.join(dest, 'index.js')), '// v2');
  assert.equal(await read(path.join(dest, 'lib', 'new.js')), '// 新增');
  assert.equal(await read(path.join(dest, 'lib', 'gone.js')), null, '新版没有的文件要删掉');
  await fs.rm(root, { recursive: true, force: true });
});

test('syncCodeTree：运行态目录原样保留', async () => {
  const root = await tmpdir('keep');
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');

  await write(path.join(src, 'index.js'), '// v2');
  await write(path.join(dest, 'index.js'), '// v1');
  await write(path.join(dest, 'data', 'store.json'), '{"n":1}');
  await write(path.join(dest, '.roost-cache', 'x', 'snap.js'), '// snap');
  await write(path.join(dest, 'node_modules', 'dep', 'index.js'), '// dep');

  await syncCodeTree(src, dest, KEEP);

  assert.equal(await read(path.join(dest, 'data', 'store.json')), '{"n":1}');
  assert.equal(await read(path.join(dest, '.roost-cache', 'x', 'snap.js')), '// snap');
  assert.equal(await read(path.join(dest, 'node_modules', 'dep', 'index.js')), '// dep');
  await fs.rm(root, { recursive: true, force: true });
});

test('updatePlugins：正常路径也保留 data/，并清掉 .bak-', async () => {
  const root = await tmpdir('upd');
  const pluginsDir = path.join(root, 'plugins');
  const tmp = path.join(root, 'tmp');

  await write(path.join(pluginsDir, 'p1', 'index.js'), '// v1');
  await write(path.join(pluginsDir, 'p1', 'data', 'store.json'), '{"n":1}');
  await write(path.join(tmp, 'plugins', 'p1', 'index.js'), '// v2');

  const out = await updatePlugins({
    tmp,
    index: { plugins: [{ id: 'p1', path: 'plugins/p1', version: '1.1.0' }] },
    pluginsDir,
    localVersions: { p1: '1.0.0' },
  });

  assert.deepEqual(out.failed, []);
  assert.equal(out.updated.length, 1);
  assert.equal(await read(path.join(pluginsDir, 'p1', 'index.js')), '// v2');
  assert.equal(await read(path.join(pluginsDir, 'p1', 'data', 'store.json')), '{"n":1}');
  const left = await fs.readdir(pluginsDir);
  assert.deepEqual(left, ['p1'], '.bak-* 必须清理干净');
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * 就地路径的还原。
 *
 * 真 EPERM 在测试里造不出来（Windows 上 `opendir` 会带 FILE_SHARE_DELETE，
 * 指望它锁住目录是白费），所以这里按降级路径的**实际调用顺序**走一遍：
 * 备份 → 覆盖到一半失败 → 从备份还原。这段是最不能出错的一段——
 * 它失败就意味着用户手上没插件了。
 */
test('就地路径：覆盖中途失败时能从备份还原回旧版', async () => {
  const root = await tmpdir('restore');
  const src = path.join(root, 'src');
  const dest = path.join(root, 'dest');
  const backup = path.join(root, '.bak-p1');

  await write(path.join(dest, 'index.js'), '// v1');
  await write(path.join(dest, 'lib', 'gone.js'), '// 新版已删除');
  await write(path.join(dest, 'data', 'store.json'), '{"n":1}');

  // 1. 备份（copyCodeTree 的同款行为：只备代码，运行态不备）
  await syncCodeTree(dest, backup, KEEP);
  assert.equal(await read(path.join(backup, 'data', 'store.json')), null, '运行态不进备份');

  // 2. 新版：先写进一个能成功的文件，再撞一个必然失败的（同名文件 vs 目录）
  await write(path.join(src, 'index.js'), '// v2');
  await write(path.join(src, 'added.js'), '// v2 新增');
  await write(path.join(dest, 'zzclash'), '旧的是一个文件');
  await write(path.join(src, 'zzclash', 'inner.js'), '新版的是一个目录');

  await assert.rejects(() => syncCodeTree(src, dest, KEEP), undefined, '覆盖应当失败');

  // 3. 还原
  await syncCodeTree(backup, dest, KEEP);
  assert.equal(await read(path.join(dest, 'index.js')), '// v1', '代码要回到旧版');
  assert.equal(await read(path.join(dest, 'lib', 'gone.js')), '// 新版已删除', '被删的旧文件要回来');
  assert.equal(await read(path.join(dest, 'added.js')), null, '新版新增的文件要清掉');
  assert.equal(await read(path.join(dest, 'data', 'store.json')), '{"n":1}', '运行态自始至终没被动');
  await fs.rm(root, { recursive: true, force: true });
});
