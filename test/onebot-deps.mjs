/**
 * OneBot 兼容层的依赖管理（M0）
 * ============================
 *
 * 这里**不联网**：真跑 `npm i` 会让测试依赖网络和镜像，慢且不稳。
 * 装好之后的行为用「伪造一个本地 ws 包」来验证——status / load / verify
 * 走的都是真文件、真 require，只把 npm 那一步换掉。
 *
 * 真安装由面板「一键安装」和 `npm run test:all` 之外的人工验收覆盖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 必须在 import 之前设：`paths.js` 在模块加载时就把 HOME 算死了 */
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-onebot-'));
process.env.ROOST_HOME = home;

const deps = await import('../src/ext-deps.js');

const WS_DIR = () => path.join(deps.depsDir(), 'node_modules', 'ws');

/** 造一个能通过冒烟的 ws：只要导出 `WebSocketServer` 且能 new */
async function fakeWs(version = '8.18.0') {
  const dir = WS_DIR();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'ws', version, main: 'index.js' }),
  );
  await fs.writeFile(
    path.join(dir, 'index.js'),
    'class WebSocketServer{constructor(){this.clients=new Set()}close(){}}\nmodule.exports={WebSocketServer};\n',
  );
  deps.resetCache();
}

/**
 * 伪造 `@ffmpeg-installer/ffmpeg`：主包只有胶水代码，`.path` 指向平台子包里的
 * 可执行文件。`binary: false` 模拟「主包在、62MB 的 exe 没了」这种半坏状态。
 *
 * 那个 fake exe 是纯文本，**只给 status / 路径断言用**：真跑 `verify()`
 * 会去执行它，那是另一条用例的事。
 */
const FF_DIR = () => path.join(deps.depsDir(), 'node_modules', '@ffmpeg-installer');
const FF_BIN = () => path.join(FF_DIR(), 'win32-x64', 'ffmpeg.exe');

async function fakeFfmpeg({ binary = true } = {}) {
  const dir = path.join(FF_DIR(), 'ffmpeg');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@ffmpeg-installer/ffmpeg', version: '1.1.0', main: 'index.js' }),
  );
  await fs.writeFile(path.join(dir, 'index.js'), `module.exports={path:${JSON.stringify(FF_BIN())}};\n`);
  if (binary) {
    await fs.mkdir(path.dirname(FF_BIN()), { recursive: true });
    await fs.writeFile(FF_BIN(), 'not-a-real-exe');
  } else {
    await fs.rm(FF_BIN(), { force: true });
  }
  deps.resetCache();
}

test('白名单：只认 ws / silk-wasm / ffmpeg，别的一律拒', () => {
  assert.deepEqual(deps.pickPackages(['ws']), ['ws']);
  assert.deepEqual(deps.pickPackages(['silk-wasm', 'ws', 'ws']), ['silk-wasm', 'ws']);
  assert.deepEqual(deps.pickPackages(['@ffmpeg-installer/ffmpeg']), ['@ffmpeg-installer/ffmpeg']);
  assert.deepEqual(deps.pickPackages(['']), []);
  // 这条是安全边界：面板传任意包名 = 远程代码执行
  assert.throws(() => deps.pickPackages(['lodash']), /不认识的依赖/);
  assert.throws(() => deps.pickPackages(['ws', 'left-pad']), /left-pad/);
  // 只认这个 scope 下的**主包**：平台子包是它的 optional 依赖，不该被单独点名
  assert.throws(() => deps.pickPackages(['@ffmpeg-installer/win32-x64']), /不认识的依赖/);
});

test('status：空目录就是「都没装」', async () => {
  const s = await deps.status();
  assert.equal(s.dir, path.join(home, 'data', 'deps', 'ext'));
  assert.deepEqual(s.required, ['ws']);
  assert.deepEqual([...s.missing].sort(), ['@ffmpeg-installer/ffmpeg', 'silk-wasm', 'ws']);
  assert.equal(s.packages.ws.resolvable, false);
  assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].resolvable, false);
  assert.equal(await deps.ready(), false);
});

test('load：没装返回 null，不抛', async () => {
  assert.equal(await deps.load('ws'), null);
  // 不在白名单里的名字也不该去 require
  assert.equal(await deps.load('lodash'), null);
});

test('装好之后：status 认得出、load 拿得到、verify 通过', async () => {
  await fakeWs();
  const s = await deps.status();
  assert.equal(s.packages.ws.version, '8.18.0');
  assert.equal(s.packages.ws.resolvable, true);
  assert.deepEqual([...s.missing].sort(), ['@ffmpeg-installer/ffmpeg', 'silk-wasm']);
  assert.equal(await deps.ready(), true);

  const mod = await deps.load('ws');
  assert.equal(typeof mod.WebSocketServer, 'function');

  assert.deepEqual(await deps.verify(['ws']), []);
});

test('版本号在、文件坏了：resolvable=false，verify 报原因', async () => {
  await fakeWs('8.18.1');
  // 把入口删掉：package.json 还在，resolve 还能过，但 require 会失败
  await fs.rm(path.join(WS_DIR(), 'index.js'));
  deps.resetCache();

  const s = await deps.status();
  assert.equal(s.packages.ws.version, '8.18.1');
  assert.equal(s.packages.ws.resolvable, true, 'resolve 只证明入口文件路径存在');

  const errs = await deps.verify(['ws']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /加载失败/);
});

test('remove：删掉包之后回到「没装」', async () => {
  await fakeWs();
  assert.equal(await deps.ready(), true);

  const s = await deps.remove(['ws']);
  assert.equal(s.packages.ws.version, '');
  assert.equal(await deps.ready(), false);
  assert.equal(await deps.load('ws'), null);
});

test('manualCommand：给的是能直接粘贴的命令', () => {
  const cmd = deps.manualCommand(['ws']);
  assert.match(cmd, /^npm i ws --prefix data\/deps\/ext /);
  // 非白名单名字不该出现在命令里
  assert.throws(() => deps.manualCommand(['lodash']), /不认识的依赖/);
});

test('install：空名单直接拒，不碰 npm', async () => {
  await assert.rejects(() => deps.install([]), /没有要安装的依赖/);
});

test('ffmpeg：主包在、二进制没了，就不算装好', async () => {
  await fakeFfmpeg({ binary: false });
  const s = await deps.status();
  const p = s.packages['@ffmpeg-installer/ffmpeg'];
  assert.equal(p.version, '1.1.0', '胶水包的 version 还在');
  assert.equal(p.resolvable, false, 'resolve 只证明胶水代码在，62MB 的 exe 不在就不算装好');
  assert.equal(p.binary, '');
  assert.ok(s.missing.includes('@ffmpeg-installer/ffmpeg'));
  assert.equal(await deps.ffmpegBinary(), '');

  // 二进制补回来就恢复：面板上「重装」要能修好这种半坏状态
  await fakeFfmpeg({ binary: true });
  const s2 = await deps.status();
  const p2 = s2.packages['@ffmpeg-installer/ffmpeg'];
  assert.equal(p2.resolvable, true);
  assert.equal(p2.binary, FF_BIN());
});

test('remove：ffmpeg 连平台子包一起删，不留 62MB 垃圾', async () => {
  await fakeFfmpeg({ binary: true });
  const s = await deps.remove(['@ffmpeg-installer/ffmpeg']);
  assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].version, '');
  assert.equal(
    await fs.stat(FF_DIR()).then(() => true).catch(() => false),
    false,
    '主包和平台子包在同一个 scope 下，卸载要整个删掉',
  );
});
