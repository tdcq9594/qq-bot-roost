// 启动期未定义变量：`path is not defined` 曾让整个 bot 起不来。
//
// 来源（1.1.17 / 1.1.18 线上故障）：`src/bot.js` 用 `path.join(...)` 建账本图片
// 目录，却忘了 `import path`。这行藏在 `cfg.ledger.saveImages === true` 的分支里、
// 默认关，于是**只有开了图片留档的用户**每次启动都 ReferenceError 崩在 init 中途：
// 日志只写到「宿主协议已监听 127.0.0.1:xxxx」就断，退出前又没 flush，堆栈一个字都
// 没落盘，最后只能靠手工启动才看见。
//
// 这里锁四件事：
//   1. `saveImages: true` 时真能建出 store，且落在 `data/bots/<id>/ledger-media`；
//   2. 关着时不建（保住「关着就零成本」的承诺）；
//   3. 入站取图**只看 `ledger.mediaStore` 当前值**——面板开关要立刻生效，
//      不能读构造期快照（否则「面板打开了、群里发图却没缩略图」，要重启）；
//   4. `src/` 下**没有**「用了 path API 却没 import node:path」的文件 ——
//      这类未定义变量 Node 只有运行时才报，不静态扫一遍就永远漏。
//
// 跑法：node --test test/bot-runtime-init.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 导入 `bot.js` 会连带算 `paths.js` 的 DIRS，先把它指到临时目录，别碰真实数据 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-init-'));
process.env.ROOST_HOME = HOME;

const { createBotMediaStore, BotRuntime } = await import('../src/bot.js');

const DATA = path.join(HOME, 'data', 'bots', 't1');

test('图片留档：saveImages 开着就建 store，落在 data/bots/<id>/ledger-media', (t) => {
  t.after(() => fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));

  const store = createBotMediaStore({ ledger: { saveImages: true } }, DATA);

  assert.ok(store, 'saveImages 开着就该建出 store');
  assert.equal(store.dirOf(), path.join(DATA, 'ledger-media'));
  assert.equal(store.maxBytes, 2048 * 1024, '默认单张上限 2MB');
});

test('图片留档：上限夹在 64KB–50MB，写歪了也不照着歪跑', () => {
  const kb = (imageMaxKb) => createBotMediaStore({ ledger: { saveImages: true, imageMaxKb } }, DATA).maxBytes / 1024;

  assert.equal(kb(1), 64, '小于 64KB 抬到 64KB');
  assert.equal(kb(0), 2048, '0 当没写，回默认 2048');
  assert.equal(kb(100000), 51200, '大于 50MB 压到 50MB');
  assert.equal(kb(undefined), 2048);
});

test('图片留档：关着或没写，一律不建 store', () => {
  assert.equal(createBotMediaStore({ ledger: { saveImages: false } }, DATA), null);
  assert.equal(createBotMediaStore({ ledger: {} }, DATA), null);
  assert.equal(createBotMediaStore({}, DATA), null, '整个 ledger 段都没有时也要照常返回');
  assert.equal(createBotMediaStore(undefined, DATA), null);
});

/* ---------------- 入站取图：开关的唯一真相是 ledger.mediaStore ---------------- */

test('入站取图：交给 ledger.saveMedia 判定，不看构造期快照', async () => {
  const calls = [];
  const fake = {
    /** 面板关档后就是这个状态：store 是空的 */
    ledger: {
      mediaStore: null,
      saveMedia: (rec, src) => {
        calls.push([rec, src]);
        return Promise.resolve([]);
      },
    },
  };
  const msg = {
    attachments: [
      { type: 'image', url: 'https://example.com/a.png', contentType: 'image/png', width: 2, height: 3 },
      { type: 'image', url: '' },
      { type: 'file', url: 'https://example.com/x.txt' },
    ],
  };

  await BotRuntime.prototype.saveInboundMedia.call(fake, { id: 'm1' }, msg);
  assert.equal(calls.length, 1, 'store 为空也要交给 saveMedia 自己判断，不能在这里短路');
  assert.deepEqual(calls[0][1], [{ url: 'https://example.com/a.png', ct: 'image/png', w: 2, h: 3 }],
    '只挑真带 url 的图片附件');

  calls.length = 0;
  await BotRuntime.prototype.saveInboundMedia.call(fake, { id: 'm2' }, { attachments: [] });
  await BotRuntime.prototype.saveInboundMedia.call(fake, null, msg);
  assert.equal(calls.length, 0, '没图 / 没入账都别调');
});

/* ---------------- 静态扫描：path API 用了却没导入 ---------------- */

/**
 * 只认真正属于 `node:path` 的方法名。
 *
 * 不能简单匹配 `path.`：`dev/session.js` 里有个局部变量也叫 `path`（存 URL 的
 * pathname，用的是 `path.startsWith`），那是合法写法，误报会逼人加豁免注释。
 */
const PATH_API = /(^|[^\w.$])path\.(join|resolve|dirname|basename|extname|relative|isAbsolute|normalize|parse|sep|delimiter|toNamespacedPath)\b/;
const PATH_IMPORT = /from\s+['"]node:path['"]|require\(\s*['"]node:path['"]\s*\)/;

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

test('src/ 下没有「用了 path API 却没 import node:path」的文件', () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const bad = walk(root)
    .filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return PATH_API.test(text) && !PATH_IMPORT.test(text);
    })
    .map((f) => path.relative(root, f));

  assert.deepEqual(bad, [], `这些文件用了 path 但没导入：${bad.join(', ')}`);
});
