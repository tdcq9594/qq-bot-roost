/**
 * E3：dry 出站截获。
 *
 * 锁四件事：开着时**一条都不真发**、截获内容够排查、关掉恢复真发、
 * 环形上限不会无限涨。默认关（`cfg.outbound.dryRun=false`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Outbound } from '../src/outbound.js';

function rig({ dryRun = true } = {}) {
  const sent = [];
  const api = {
    async sendGroup(target, body) { sent.push({ kind: 'group', target, body }); return { id: 'm1' }; },
    async sendC2C(target, body) { sent.push({ kind: 'c2c', target, body }); return { id: 'm2' }; },
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'roost-dry-'));
  const ob = new Outbound({
    api,
    cfg: { outbound: { dryRun, perSec: 100, dailyActive: 1000, activePerMinute: 100 } },
    isOnline: () => true,
    quotaFile: path.join(dir, 'quota.json'),
  });
  return { ob, sent, dir, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

test('dry 开着：不调 api、返回 dry:true、记下本来会发什么', async (t) => {
  const r = rig();
  t.after(r.done);
  const out = await r.ob.send({
    kind: 'group', target: 'g1', payload: { content: '你好' }, receivedAt: Date.now(),
  });
  assert.equal(out.ok, true);
  assert.equal(out.dry, true);
  assert.equal(r.sent.length, 0, '一条都不该真发');
  assert.equal(r.ob.dryLog.length, 1);
  assert.equal(r.ob.dryLog[0].target, 'g1');
  assert.equal(r.ob.dryLog[0].text, '你好');
  assert.equal(r.ob.dryLog[0].passive, true, '带 receivedAt 算被动回复');
});

test('dry 关掉：恢复真发，且清空截获记录', async (t) => {
  const r = rig({ dryRun: false });
  t.after(r.done);
  const out = await r.ob.send({ kind: 'c2c', target: 'u1', payload: { content: 'hi' } });
  assert.equal(out.dry, undefined);
  assert.equal(r.sent.length, 1, '关掉后必须真发');

  r.ob.setDry(true);
  await r.ob.send({ kind: 'c2c', target: 'u1', payload: { content: 'x' } });
  assert.equal(r.sent.length, 1, '再开 dry 后不再发');
  assert.equal(r.ob.dryLog.length, 1);
  r.ob.setDry(false);
  assert.equal(r.ob.dryLog.length, 0, '关掉时清空截获');
});

test('dry 截获：markdown 正文、文件数、按钮都记下来', async (t) => {
  const r = rig();
  t.after(r.done);
  await r.ob.send({
    kind: 'group',
    target: 'g2',
    payload: { markdown: { content: '**粗体**' }, files: ['/a.png'], keyboard: { rows: [] } },
  });
  const row = r.ob.dryLog[0];
  assert.equal(row.text, '**粗体**');
  assert.equal(row.files, 1);
  assert.equal(row.keyboard, true);
  assert.equal(row.passive, false, '没有 msgId/receivedAt 算主动');
});

test('dry 截获：最多留 50 条', async (t) => {
  const r = rig();
  t.after(r.done);
  for (let i = 0; i < 60; i += 1) {
    await r.ob.send({ kind: 'c2c', target: 'u1', payload: { content: `第 ${i} 条` } });
  }
  assert.equal(r.ob.dryLog.length, 50);
  assert.equal(r.ob.dryLog.at(-1).text, '第 59 条', '留最新的一批');
});
