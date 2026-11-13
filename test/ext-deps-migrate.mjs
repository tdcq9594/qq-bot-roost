/**
 * 依赖目录迁移：`data/deps/onebot` → `data/deps/ext`
 * ==================================================
 *
 * 2026-11-13 之前这份依赖只有 OneBot 用，装在 `data/deps/onebot/`；
 * 现在宿主协议的 `/ws` 也吃同一份 `ws`，目录改成中性的 `deps/ext`。
 *
 * **老用户不能为此重下一遍**：`ws` 1MB、`silk-wasm` 1.5MB，很多人的网络
 * 还挂着代理。所以第一次访问时整目录搬过去，这个测试钉的就是这条升级路径。
 *
 * 必须是**独立进程**：`ext-deps` 的「已迁移」判断是模块级缓存，
 * 在同一个进程里造旧目录再断言，会拿到别的用例留下的状态。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** `paths.js` 在模块加载时就定下 HOME，必须先设环境变量再 import */
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-ext-migrate-'));
process.env.ROOST_HOME = home;

/** 先造出 1.0.14 用户的现场：旧目录里有一份能 require 的 ws */
const legacy = path.join(home, 'data', 'deps', 'onebot');
const wsDir = path.join(legacy, 'node_modules', 'ws');
await fs.mkdir(wsDir, { recursive: true });
await fs.writeFile(
  path.join(wsDir, 'package.json'),
  JSON.stringify({ name: 'ws', version: '8.18.0', main: 'index.js' }),
);
await fs.writeFile(
  path.join(wsDir, 'index.js'),
  'class WebSocketServer { constructor() { this.clients = new Set(); } close() {} }\nmodule.exports = { WebSocketServer };\n',
);
await fs.writeFile(
  path.join(legacy, 'package.json'),
  JSON.stringify({ name: 'roost-onebot-deps', private: true, dependencies: { ws: '^8.18.0' } }),
);

const deps = await import('../src/ext-deps.js');

test('迁移：老目录整体搬到 deps/ext，已装的包不用重下', async () => {
  const s = await deps.status();
  assert.equal(s.dir, path.join(home, 'data', 'deps', 'ext'), '新目录才是权威路径');
  assert.equal(
    await fs.stat(legacy).then(() => true).catch(() => false),
    false,
    '旧目录应当已经搬走（而不是复制一份，留下两个真相）',
  );
  assert.equal(s.packages.ws.version, '8.18.0', '版本要跟着文件一起过来');
  assert.equal(s.packages.ws.resolvable, true, '搬完必须还能 require');
  assert.equal(await deps.ready(), true);
  assert.deepEqual(s.missing, ['silk-wasm'], '只有真正没装的那个才算缺');

  const mod = await deps.load('ws');
  assert.equal(typeof mod.WebSocketServer, 'function');
});

test('迁移：旧目录不存在时什么都不做，直接在新目录工作', async () => {
  const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-ext-fresh-'));
  /** 换个 HOME 不影响本进程里已算好的 DIRS，这里只验「旧目录不在」的判定不抛错 */
  assert.equal(
    await fs.stat(path.join(fresh, 'data', 'deps', 'onebot')).then(() => true).catch(() => false),
    false,
  );
  const s2 = await deps.status();
  assert.equal(s2.error, '');
  assert.match(s2.dir, /data[\\/]deps[\\/]ext$/);
});
