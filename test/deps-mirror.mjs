/**
 * 市场内置依赖包（`deps/` 镜像）的护栏测试。
 *
 * 这条路的定位是「npm 彻底不行时的最后一根绳」，所以测的重点不是
 * 「能不能装上」（那是功能），而是：
 *   · 版本不对**不许硬装**（装了旧版会让面板显示已安装、API 却不兼容）；
 *   · sha256 不对**一个字节都不许落地**；
 *   · 包名不符不许装（否则等于把 A 包的内容当成 B 包）；
 *   · 地址只能由市场索引推导，不能变成任意下载入口。
 *
 * 下载用注入的 `fetcher` 喂一段现打的 tar.gz，不碰网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  satisfiesRange, depUrlOf, installOneFromMirror, installFromMirror,
} from '../src/deps-mirror.js';

/* ---------------------------- 造一个 npm 包 ---------------------------- */

/** 512 字节 tar 头 + 内容（补到 512 的倍数） */
function tarEntry(name, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii'); // 校验和先占位成空格
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([h, padded]);
}

/**
 * npm 包的结构：所有文件都在 `package/` 下。
 *
 * `extractEntries` 会剥掉唯一的顶层目录，所以解出来文件是平铺的——
 * 这正是 `installOneFromMirror` 要处理的那种包。
 */
function npmTgz(pkg, files = { 'index.js': 'module.exports = 1;\n' }) {
  const entries = [
    tarEntry('package/package.json', JSON.stringify(pkg)),
    ...Object.entries(files).map(([n, c]) => tarEntry(`package/${n}`, c)),
  ];
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** 假下载器：不管 URL 是什么都返回同一段字节 */
const staticFetcher = (buf) => async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
});

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'roost-dep-test-'));

const INDEX_URL = 'https://raw.githubusercontent.com/roost-qq/qq-bot-roost-plugins/main/index.json';

/* ---------------------------- 版本判定 ---------------------------- */

test('版本：^X.Y.Z 锁主版本，但不许低于下界', () => {
  assert.equal(satisfiesRange('8.23.0', '^8.18.0'), true);
  assert.equal(satisfiesRange('8.18.0', '^8.18.0'), true, '正好等于下界要放行');
  assert.equal(satisfiesRange('8.17.9', '^8.18.0'), false, '比下界老的不许装');
  assert.equal(satisfiesRange('9.0.0', '^8.18.0'), false, '跨主版本不许装');
  assert.equal(satisfiesRange('7.99.99', '^8.18.0'), false);
});

test('版本：^0.x.y 连次版本一起锁（semver 语义）', () => {
  assert.equal(satisfiesRange('0.2.3', '^0.2.0'), true);
  assert.equal(satisfiesRange('0.3.0', '^0.2.0'), false, '0.x 跨次版本是大版本变更');
});

test('版本：精确写法只认同一个版本；认不出的写法一律 false', () => {
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.4', '1.2.3'), false);
  for (const bad of [['x', '^1.0.0'], ['1.0.0', '~1.0.0'], ['1.0.0', '>=1.0.0'], ['', ''], ['1.0.0', '*']]) {
    assert.equal(satisfiesRange(...bad), false, `${bad.join(' / ')} 不该判为满足`);
  }
});

/* ---------------------------- 地址推导 ---------------------------- */

test('地址：由索引地址推导，只认 https', () => {
  assert.equal(
    depUrlOf(INDEX_URL, 'deps/ws-8.23.0.tgz'),
    'https://raw.githubusercontent.com/roost-qq/qq-bot-roost-plugins/main/deps/ws-8.23.0.tgz',
  );
  /** 索引地址变体（带尾斜杠目录）也要拼得对 */
  assert.equal(
    depUrlOf('https://x.test/a/b/index.json', '/deps/a.tgz'),
    'https://x.test/a/b/deps/a.tgz',
    'path 前面多余的斜杠不能拼成双斜杠',
  );
  assert.equal(depUrlOf('http://x.test/index.json', 'deps/a.tgz'), '', 'http 不许用');
  assert.equal(depUrlOf('not a url', 'deps/a.tgz'), '');
});

test('地址：路径里的 . / .. 段一律不认（不能靠索引跳出仓目录）', () => {
  for (const bad of ['../x.tgz', 'deps/../../x.tgz', './x.tgz', '', '/']) {
    assert.equal(depUrlOf(INDEX_URL, bad), '', `${JSON.stringify(bad)} 不该拼出地址`);
  }
});

/* ---------------------------- 单个包 ---------------------------- */

test('安装：校验通过后解到 node_modules/<名字>，文件齐全', async () => {
  const tgz = npmTgz({ name: 'ws', version: '8.23.0' });
  const dest = await tmpDir();
  const r = await installOneFromMirror(INDEX_URL, {
    name: 'ws', version: '8.23.0', path: 'deps/ws-8.23.0.tgz', sha256: sha256(tgz),
  }, dest, { fetcher: staticFetcher(tgz) });
  assert.equal(r.ok, true, r.error);
  assert.equal(await fs.readFile(path.join(dest, 'node_modules/ws/index.js'), 'utf8'), 'module.exports = 1;\n');
  const pkg = JSON.parse(await fs.readFile(path.join(dest, 'node_modules/ws/package.json'), 'utf8'));
  assert.equal(pkg.name, 'ws');
  await fs.rm(dest, { recursive: true, force: true });
});

test('安装：sha256 不符时一个字节都不落地', async () => {
  const tgz = npmTgz({ name: 'ws', version: '8.23.0' });
  const dest = await tmpDir();
  const r = await installOneFromMirror(INDEX_URL, {
    name: 'ws', version: '8.23.0', path: 'deps/ws-8.23.0.tgz', sha256: 'f'.repeat(64),
  }, dest, { fetcher: staticFetcher(tgz) });
  assert.equal(r.ok, false);
  assert.match(r.error, /校验/);
  assert.equal(await fs.access(path.join(dest, 'node_modules')).then(() => true, () => false), false);
  await fs.rm(dest, { recursive: true, force: true });
});

test('安装：包名不符拒装（不能把 A 包内容当 B 包）', async () => {
  const tgz = npmTgz({ name: 'evil', version: '8.23.0' });
  const dest = await tmpDir();
  const r = await installOneFromMirror(INDEX_URL, {
    name: 'ws', version: '8.23.0', path: 'deps/ws-8.23.0.tgz', sha256: sha256(tgz),
  }, dest, { fetcher: staticFetcher(tgz) });
  assert.equal(r.ok, false);
  assert.match(r.error, /包名不符/);
  await fs.rm(dest, { recursive: true, force: true });
});

test('安装：包里没有 package.json 也算失败（不是 npm 包）', async () => {
  const tar = zlib.gzipSync(Buffer.concat([tarEntry('README.md', 'hi'), Buffer.alloc(1024)]));
  const dest = await tmpDir();
  const r = await installOneFromMirror(INDEX_URL, {
    name: 'ws', version: '8.23.0', path: 'deps/ws-8.23.0.tgz', sha256: sha256(tar),
  }, dest, { fetcher: staticFetcher(tar) });
  assert.equal(r.ok, false);
  assert.match(r.error, /package\.json/);
  await fs.rm(dest, { recursive: true, force: true });
});

/* ---------------------------- 批量 ---------------------------- */

test('批量：版本不在范围里的跳过并说明原因，不装', async () => {
  const tgz = npmTgz({ name: 'ws', version: '8.0.0' });
  const dest = await tmpDir();
  const out = await installFromMirror({
    names: ['ws'],
    whitelist: { ws: { range: '^8.18.0' } },
    dir: dest,
    indexUrl: INDEX_URL,
    entries: [{ name: 'ws', version: '8.0.0', path: 'deps/ws-8.0.0.tgz', sha256: sha256(tgz) }],
    fetcher: staticFetcher(tgz),
  });
  assert.deepEqual(out.installed, []);
  assert.match(out.errors.join(' '), /不满足 \^8\.18\.0/);
  await fs.rm(dest, { recursive: true, force: true });
});

test('批量：镜像里没有的包进 absent，和「装失败」分开', async () => {
  const dest = await tmpDir();
  const out = await installFromMirror({
    names: ['ws', 'silk-wasm'],
    whitelist: { ws: { range: '^8.18.0' }, 'silk-wasm': { range: '^3.7.1' } },
    dir: dest,
    indexUrl: INDEX_URL,
    entries: [],
    fetcher: staticFetcher(Buffer.alloc(0)),
  });
  assert.deepEqual(out.absent, ['ws', 'silk-wasm']);
  assert.deepEqual(out.errors, [], '「镜像里没有」不是错误，别混成安装失败');
  await fs.rm(dest, { recursive: true, force: true });
});

test('批量：多个包都装成功时逐个记版本', async () => {
  const ws = npmTgz({ name: 'ws', version: '8.23.0' });
  const silk = npmTgz({ name: 'silk-wasm', version: '3.7.1' }, { 'lib/index.mjs': 'export const encode = 1;\n' });
  const dest = await tmpDir();
  /** 两个包的内容不同，用一个按 URL 分派的假下载器（签名同 fetch：url → Response） */
  const byUrl = async (url) => {
    const buf = url.includes('silk') ? silk : ws;
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  const out = await installFromMirror({
    names: ['ws', 'silk-wasm'],
    whitelist: { ws: { range: '^8.18.0' }, 'silk-wasm': { range: '^3.7.1' } },
    dir: dest,
    indexUrl: INDEX_URL,
    entries: [
      { name: 'ws', version: '8.23.0', path: 'deps/ws.tgz', sha256: sha256(ws) },
      { name: 'silk-wasm', version: '3.7.1', path: 'deps/silk.tgz', sha256: sha256(silk) },
    ],
    fetcher: byUrl,
  });
  assert.deepEqual(out.installed, [{ name: 'ws', version: '8.23.0' }, { name: 'silk-wasm', version: '3.7.1' }]);
  assert.deepEqual(out.errors, []);
  assert.equal(await fs.access(path.join(dest, 'node_modules/silk-wasm/lib/index.mjs')).then(() => true, () => false), true);
  await fs.rm(dest, { recursive: true, force: true });
});
