/**
 * 账本 v6：入账清洗 + 图片留档。
 *
 * 这里锁四件事：
 *   1. **老库能升上来**（v5 → v6 加两列，重复迁移不炸）；
 *   2. 清洗结果进 `content`、原文进 `content_raw`，且只有真有差异才写；
 *   3. 图片落盘、回填 `media`、删账本时文件跟着删；
 *   4. **路径穿越必须挡住**——面板图片接口的唯一入口就是 `resolve()`。
 *
 * 跑法：node --test test/ledger-media.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLedger } from '../src/ledger.js';
import { createMediaStore } from '../src/media-store.js';
import { openDatabase } from '../src/storage/db.js';
import { EVENTS_SCHEMA_VERSION, migrateEvents } from '../src/storage/events-schema.js';

/** 1×1 的 PNG：字节头能过 `extOf`，`dimsOf` 也能读出 1×1 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function rig(t, { maxBytes = 1024 * 1024, fetchImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-media-'));
  const mediaDir = path.join(dir, 'ledger-media');
  const store = createMediaStore({ dir: mediaDir, maxBytes, ...(fetchImpl ? { fetchImpl } : {}) });
  const ledger = createLedger({
    file: path.join(dir, 'events.db'),
    botId: 'main',
    retentionDays: 0,
    mediaStore: store,
  });
  ledger.open();
  t.after(() => {
    try { ledger.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  return { dir, mediaDir, store, ledger };
}

function add(ledger, id, content, extra = {}) {
  return ledger.append({
    id,
    kind: 'group',
    chatId: 'G1',
    userId: 'U1',
    userName: '甲',
    content,
    raw: { timestamp: Date.now() },
    ...extra,
  });
}

test('迁移：新库到 v6，两列都在；重复迁移不炸', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-mig-'));
  const db = openDatabase(path.join(dir, 'events.db'));
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  migrateEvents(db);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), EVENTS_SCHEMA_VERSION);
  const cols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  assert.ok(cols.includes('content_raw'), '要有 content_raw');
  assert.ok(cols.includes('media'), '要有 media');
  /** 幂等：再跑一遍不该抛 duplicate column（这是 open() 把异常吞成「账本静默不可用」的根源） */
  assert.doesNotThrow(() => migrateEvents(db));
});

test('清洗：内容变成人话，原文进 content_raw', (t) => {
  const { ledger } = rig(t);
  const ext = Buffer.from(JSON.stringify({ text: '憨笑' }), 'utf8').toString('base64');
  const raw = `<faceType=1,faceId="187",ext="${ext}">晚上好`;
  add(ledger, 'm1', raw);
  const row = ledger.recent({ chatId: 'G1', limit: 5 })[0];
  assert.equal(row.content, '[表情:憨笑]晚上好');
  assert.equal(row.contentRaw, raw, '原文要留得回来');
});

test('清洗：没有标记时 content_raw 是空串（不为每行多背一份正文）', (t) => {
  const { ledger } = rig(t);
  add(ledger, 'm1', '就是一句话，没有任何标记');
  const row = ledger.recent({ chatId: 'G1', limit: 5 })[0];
  assert.equal(row.content, '就是一句话，没有任何标记');
  assert.equal(row.contentRaw, '');
});

test('纯图消息：正文给占位，账本里不留空白行', (t) => {
  const { ledger } = rig(t);
  add(ledger, 'm1', '', { attachments: [{ type: 'image', url: 'https://example.com/a.png' }] });
  const row = ledger.recent({ chatId: 'G1', limit: 5 })[0];
  assert.equal(row.content, '[图片]');
});

test('存图：本地文件 → 落盘 → media 回填 → mediaStats 计数', async (t) => {
  const { dir, ledger, mediaDir } = rig(t);
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, PNG);
  const rec = add(ledger, 'm1', '[图片]', { attachments: [{ type: 'image', url: 'https://example.com/a.png' }] });

  const saved = await ledger.saveMedia(rec, [{ path: src }]);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].t, 'image');
  assert.equal(saved[0].w, 1);
  assert.equal(saved[0].h, 1);
  assert.ok(fs.existsSync(path.join(mediaDir, saved[0].file)), '文件要真的在磁盘上');

  const row = ledger.recent({ chatId: 'G1', limit: 5 })[0];
  assert.equal(row.media.length, 1, 'media 列要回填');
  assert.equal(row.media[0].file, saved[0].file);
  assert.equal(ledger.mediaStats().rows, 1);
});

test('存图：URL 走 fetch，下载失败静默跳过', async (t) => {
  let hit = 0;
  const fakeFetch = async (url) => {
    hit += 1;
    if (String(url).includes('boom')) return { ok: false, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    return {
      ok: true,
      headers: new Map([['content-type', 'image/png']]),
      arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength),
    };
  };
  const { ledger } = rig(t, { fetchImpl: fakeFetch });
  const ok = add(ledger, 'm1', '[图片]');
  const bad = add(ledger, 'm2', '[图片]');

  assert.equal((await ledger.saveMedia(ok, [{ url: 'https://example.com/a.png' }])).length, 1);
  assert.equal((await ledger.saveMedia(bad, [{ url: 'https://example.com/boom.png' }])).length, 0, '失败的跳过、不抛');
  assert.equal(hit, 2);
  assert.equal(ledger.mediaStats().rows, 1);
});

test('存图：超过上限的不存（不是截断）', async (t) => {
  const { store } = rig(t, { maxBytes: 10 });
  assert.equal(await store.saveBuffer(PNG), null, '10 字节上限装不下 PNG');
});

test('存图：认不出的格式不存', async (t) => {
  const { store } = rig(t);
  const junk = Buffer.from('这不是图片，只是一段文字而已', 'utf8');
  assert.equal(await store.saveBuffer(junk), null);
});

test('路径穿越：resolve 必须挡住 ../ 与绝对路径', (t) => {
  const { store } = rig(t);
  assert.equal(store.resolve('../../config/bots/main.json'), null);
  assert.equal(store.resolve('/etc/passwd'), null);
  assert.equal(store.resolve(''), null);
  assert.equal(store.resolve('a/../../x'), null);
  /** 正常相对路径要放行 */
  assert.ok(store.resolve('20261125/ab12.png'));
});

test('删账本：行删掉时图片文件跟着删', async (t) => {
  const { dir, ledger, mediaDir } = rig(t);
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, PNG);
  const rec = add(ledger, 'm1', '[图片]');
  const [saved] = await ledger.saveMedia(rec, [{ path: src }]);
  const abs = path.join(mediaDir, saved.file);
  assert.ok(fs.existsSync(abs));

  ledger.remove({ ids: [rec.id] });
  /** 删文件是异步的、故意不 await；给一拍让它落地 */
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fs.existsSync(abs), false, '行删了，图不该留在磁盘上');
  assert.equal(ledger.mediaStats().rows, 0);
});

test('导出再导入：content_raw 与 media 原样带回', async (t) => {
  const { dir, ledger } = rig(t);
  const src = path.join(dir, 'src.png');
  fs.writeFileSync(src, PNG);
  const raw = '<faceType=1,faceId="187",ext="">在吗';
  const rec = add(ledger, 'm1', raw);
  await ledger.saveMedia(rec, [{ path: src }]);
  const row = ledger.recent({ chatId: 'G1', limit: 5 })[0];

  /** 换个库导入，模拟「备份搬到另一台机器」 */
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-media2-'));
  const ledger2 = createLedger({ file: path.join(dir2, 'events.db'), botId: 'main', retentionDays: 0 });
  ledger2.open();
  t.after(() => {
    try { ledger2.close(); } catch {}
    fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  ledger2.importRows([{
    at: row.at,
    kind: row.kind,
    chatId: row.chatId,
    msgId: 'm1',
    userId: row.userId,
    userName: row.userName,
    content: row.content,
    contentRaw: row.contentRaw,
    media: JSON.stringify(row.media),
  }]);
  const back = ledger2.recent({ chatId: 'G1', limit: 5 })[0];
  assert.equal(back.content, '[表情]在吗');
  assert.equal(back.contentRaw, raw);
  assert.equal(back.media.length, 1);
});
