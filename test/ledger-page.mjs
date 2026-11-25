/**
 * 账本分页：`countOf()` + `recent({ offset })`。
 *
 * 面板以前只有「下一页」= 把列表再加长 50 条，看不出在第几页。改成整页翻页后
 * 要三样东西：这个会话到底多少条、第 N 页取哪一段、页内还是正序（老的在前）。
 * 这三条错了，界面上的「第 3 / 7 页」就是假的。
 *
 * 跑法：node --test test/ledger-page.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLedger } from '../src/ledger.js';

function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-page-'));
  const ledger = createLedger({ file: path.join(dir, 'events.db'), botId: 'main', retentionDays: 0 });
  ledger.open();
  t.after(() => {
    try { ledger.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  return { ledger };
}

function add(ledger, n, chatId = 'G1') {
  return ledger.append({
    id: `e${n}`,
    kind: 'group',
    chatId,
    userId: 'U1',
    userName: '甲',
    content: `第${n}条`,
    raw: { timestamp: Date.now() + n },
  });
}

test('countOf：只数这个会话，别的会话不算进来', (t) => {
  const { ledger } = rig(t);
  for (let i = 1; i <= 5; i += 1) add(ledger, i, 'G1');
  for (let i = 6; i <= 8; i += 1) add(ledger, i, 'G2');
  assert.equal(ledger.countOf({ chatId: 'G1' }), 5);
  assert.equal(ledger.countOf({ chatId: 'G2' }), 3);
  assert.equal(ledger.countOf({ chatId: '没有这个会话' }), 0);
  assert.equal(ledger.countOf({}), 0, '缺 chatId 不能退化成全库计数');
});

test('offset 分页：第 1 页是最新的，往后翻更早，页内正序', (t) => {
  const { ledger } = rig(t);
  for (let i = 1; i <= 12; i += 1) add(ledger, i);

  const p1 = ledger.recent({ chatId: 'G1', limit: 5, offset: 0 });
  assert.deepEqual(p1.map((r) => r.content), ['第8条', '第9条', '第10条', '第11条', '第12条'],
    '第 1 页 = 最新 5 条，且页内从老到新');

  const p2 = ledger.recent({ chatId: 'G1', limit: 5, offset: 5 });
  assert.deepEqual(p2.map((r) => r.content), ['第3条', '第4条', '第5条', '第6条', '第7条']);

  const p3 = ledger.recent({ chatId: 'G1', limit: 5, offset: 10 });
  assert.deepEqual(p3.map((r) => r.content), ['第1条', '第2条'], '最后一页可以不满');

  assert.deepEqual(ledger.recent({ chatId: 'G1', limit: 5, offset: 500 }), [], '越界给空数组，不能抛');
});

test('offset 与 beforeSeq 互斥：同时给时以 beforeSeq 限界、offset 在其内跳', (t) => {
  const { ledger } = rig(t);
  for (let i = 1; i <= 10; i += 1) add(ledger, i);
  /**
   * 面板只用 offset；`beforeSeq` 是给「追加式加载」调用方留的。两者同时给时
   * SQL 先按 seq 限界再 offset，语义清楚但**别在面板里混用**——容易算错页。
   */
  const rows = ledger.recent({ chatId: 'G1', limit: 3, beforeSeq: 9, offset: 1 });
  /** seq < 9 = 第 1..8 条；倒序跳过最新一条（第 8 条）取 3 条 = 7/6/5，再 reverse */
  assert.deepEqual(rows.map((r) => r.content), ['第5条', '第6条', '第7条']);
});

test('offset 负数 / 非数字一律当 0（不能拼进 SQL 变成全表）', (t) => {
  const { ledger } = rig(t);
  for (let i = 1; i <= 4; i += 1) add(ledger, i);
  const base = ledger.recent({ chatId: 'G1', limit: 2, offset: 0 }).map((r) => r.content);
  assert.deepEqual(ledger.recent({ chatId: 'G1', limit: 2, offset: -5 }).map((r) => r.content), base);
  assert.deepEqual(ledger.recent({ chatId: 'G1', limit: 2, offset: 'abc' }).map((r) => r.content), base);
});

test('分页条 UI 接的是 page，不是旧的追加式 more（源码级，挡住回退）', () => {
  const src = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(src, /page: String\(ledgerView\.page\)/, '请求必须带 page');
  assert.doesNotMatch(src, /ledgerMore/, '旧「下一页」按钮已删，别留着两套翻页');
  assert.doesNotMatch(src, /ledgerView\.cursor/, '旧的 seq 游标已不用');
});
