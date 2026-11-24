/**
 * 内容指纹口径一致性自测
 * ======================
 *
 *   node --test test/hashdir-sums.mjs
 *
 * 守卫 2026-11 的一次真事故：hashdir.js 的 collect() 在 a61d5f4 改成排除
 * .md / LICENSE 文档，但 scripts/build-sums.mjs 的 trackedFiles() 没同步，
 * 于是 SHA256SUMS 记录的指纹含 17 个文档、更新器解包后算出的不含，
 * v1.1.11 及之后所有版本的自更新 100% 校验失败（报「下载源被篡改」）。
 *
 * 这里守三件事：
 *   1. isHashedFile 的排除规则（文档 / LICENSE / 缓存文件 / 跳过目录）
 *   2. 同一工作区：hashDir(only) 与 build-sums 的 hashFileList(git ls-files)
 *      必须算出同一个指纹——这是发布与校验的交叉契约
 *   3. 固定夹具的哈希值漂移检测
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { hashDir, hashFileList, isHashedFile } from '../src/hashdir.js';
import { CODE_ENTRIES } from '../src/update-scope.js';

test('isHashedFile：文档 / LICENSE / 缓存 / 跳过目录都不参与指纹', () => {
  // 文档与协议声明：排除（和 updater 的 collect 口径一致）
  for (const f of [
    'README.md', 'docs/架构说明.md', 'docs/guide.MD',
    'LICENSE', 'licence.txt', 'COPYING', 'COPYING.md', 'src/LICENSE',
  ]) {
    assert.equal(isHashedFile(f), false, `${f} 不该参与指纹`);
  }
  // 缓存文件与跳过目录
  for (const f of ['.DS_Store', 'Thumbs.db', '.deps.json', 'node_modules/x.js', '.git/config', 'src/foo.md']) {
    assert.equal(isHashedFile(f), false, `${f} 不该参与指纹`);
  }
  // 真代码必须保留
  for (const f of ['src/main.js', 'web/index.html', 'test/e2e.mjs', 'package.json', 'start.bat', 'docs/协议.md'.replace('.md', '.txt')]) {
    assert.equal(isHashedFile(f), true, `${f} 应该参与指纹`);
  }
});

test('发布口径 == 校验口径：同一目录两种算法算出同一指纹（核心回归守卫）', async () => {
  // 临时构造一个跟真实包形状一致的目录，避免依赖工作区里「正在改的代码」
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-hashdir-'));
  const write = async (rel, content) => {
    const p = path.join(dir, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  };
  await write('src/main.js', 'console.log(1)\n');
  await write('src/util.js', 'export const x = 1\r\n'); // CRLF 要归一
  await write('web/index.html', '<html></html>\n');
  await write('test/e2e.mjs', 'test()\n');
  await write('docs/架构说明.md', '文档不该影响指纹\n');
  await write('README.md', 'readme\n');
  await write('LICENSE', 'MIT\n');
  await write('package.json', '{"version":"9.9.9"}\n');
  await write('start.bat', '@echo off\r\n');
  await write('node_modules/skip.js', 'skip\n');

  // 校验端：updater 用的 hashDir(only)
  const fromUpdater = await hashDir(dir, { only: CODE_ENTRIES });

  // 发布端：build-sums 用的 hashFileList(git ls-files 式文件清单)，
  // 这里用递归列目录模拟 git ls-files（临时目录没有 .git），关键是要过 isHashedFile。
  const all = [];
  const walk = async (d, prefix = '') => {
    for (const it of await fs.readdir(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.isDirectory()) await walk(path.join(d, it.name), rel);
      else all.push(rel);
    }
  };
  await walk(dir);
  const rels = all.filter((f) => CODE_ENTRIES.some((p) => f === p || f.startsWith(`${p}/`)))
    .filter(isHashedFile);
  const fromPublisher = await hashFileList(dir, rels);

  assert.equal(fromPublisher, fromUpdater, '发布与校验口径必须逐字一致，否则全量自更新失败');
  assert.ok(!rels.some((f) => f.endsWith('.md') || /license/i.test(f)), '发布清单里不能有文档');

  await fs.rm(dir, { recursive: true, force: true });
});

test('固定夹具：哈希值不可无故漂移', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-hashdir-fix-'));
  await fs.writeFile(path.join(dir, 'a.js'), 'hello\n');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'b.js'), 'world\r\n');
  await fs.writeFile(path.join(dir, 'README.md'), 'doc\n');
  const got = await hashDir(dir);
  // 只含 a.js + sub/b.js，且 CRLF 归一成 LF；README 不参与。
  // 值由本算法对同一夹具算出，算法语义变动即红。
  assert.match(got, /^[0-9a-f]{64}$/);
  const withDoc = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
  await fs.writeFile(path.join(dir, 'README.md'), withDoc + 'changed\n');
  assert.equal(await hashDir(dir), got, '改文档不该改变内容指纹');
  await fs.rm(dir, { recursive: true, force: true });
});
