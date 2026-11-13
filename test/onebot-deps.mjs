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

test('白名单：只认 ws / silk-wasm，别的一律拒', () => {
  assert.deepEqual(deps.pickPackages(['ws']), ['ws']);
  assert.deepEqual(deps.pickPackages(['silk-wasm', 'ws', 'ws']), ['silk-wasm', 'ws']);
  assert.deepEqual(deps.pickPackages(['']), []);
  // 这条是安全边界：面板传任意包名 = 远程代码执行
  assert.throws(() => deps.pickPackages(['lodash']), /不认识的依赖/);
  assert.throws(() => deps.pickPackages(['ws', 'left-pad']), /left-pad/);
});

test('status：空目录就是「都没装」', async () => {
  const s = await deps.status();
  assert.equal(s.dir, path.join(home, 'data', 'deps', 'ext'));
  assert.deepEqual(s.required, ['ws']);
  assert.deepEqual([...s.missing].sort(), ['silk-wasm', 'ws']);
  assert.equal(s.packages.ws.resolvable, false);
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
  assert.deepEqual(s.missing, ['silk-wasm']);
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
