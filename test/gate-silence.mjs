/**
 * 静默闸的上限与解除
 * ==================
 *
 * 起因：`gate.silence`（`host/ops.js`）一直夹 30 天，而 `gate.set` 的
 * `silence` 分支直接调 `setSilence`、不夹——同一个字段两条写入口径不同，
 * 面板传 400 天就真写 400 天。现在上限收口在 `setSilence` 本身。
 *
 * 这份测试盯的就是「**不管从哪条路进来，30 天就是 30 天**」，外加解除与落盘。
 *
 * 跑法：node --test test/gate-silence.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGate, MAX_SILENCE_MS } from '../src/gate.js';
import { createMethods, effectiveScopes } from '../src/host/methods.js';

const DAY = 86_400_000;

/** 每个用例一个干净目录，互不干扰 */
async function withGate(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-silence-'));
  try {
    const gate = createGate({ dir, botId: 'bot1' });
    await gate.open();
    const methods = createMethods({ runtime: { gate }, getState: () => ({ state: 'running' }) });
    const call = (method, params) => methods.call(method, params, { scopes: effectiveScopes({}) });
    return await fn({ dir, gate, methods, call });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('上限常量就是 30 天', () => {
  assert.equal(MAX_SILENCE_MS, 30 * DAY);
});

test('setSilence：超限被夹到 30 天，不是照写', async () => {
  await withGate(async ({ gate }) => {
    const now = Date.now();
    const r = await gate.setSilence('g1', 400 * DAY, { by: 'test' });
    const days = (r.until - now) / DAY;
    assert.ok(days > 29.9 && days <= 30.001, `应该是 30 天，实际 ${days.toFixed(2)} 天`);
  });
});

test('gate.set 的 silence 分支：超限同样被夹（这条以前是漏的）', async () => {
  await withGate(async ({ call }) => {
    const now = Date.now();
    const r = await call('gate.set', { scope: 'silence', chatId: 'g2', ms: 400 * DAY });
    const days = (r.until - now) / DAY;
    assert.ok(days > 29.9 && days <= 30.001, `gate.set 走的也是 setSilence，必须同样夹住，实际 ${days.toFixed(2)} 天`);
  });
});

test('gate.silence：上限行为不变', async () => {
  await withGate(async ({ call }) => {
    const now = Date.now();
    const r = await call('gate.silence', { chatId: 'g3', ms: 400 * DAY });
    const days = (r.until - now) / DAY;
    assert.ok(days > 29.9 && days <= 30.001, `实际 ${days.toFixed(2)} 天`);
  });
});

test('正常时长不被改动', async () => {
  await withGate(async ({ call }) => {
    const now = Date.now();
    const r = await call('gate.set', { scope: 'silence', chatId: 'g4', ms: 120 * 60_000 });
    const mins = (r.until - now) / 60_000;
    assert.ok(mins > 119.9 && mins <= 120.01, `应该是 120 分钟，实际 ${mins.toFixed(2)}`);
  });
});

test('ms=0 解除：不写表、until 归零', async () => {
  await withGate(async ({ call, gate }) => {
    await call('gate.set', { scope: 'silence', chatId: 'g5', ms: 60 * 60_000 });
    assert.equal(gate.check('g5').ok, false);

    const r = await call('gate.set', { scope: 'silence', chatId: 'g5', ms: 0 });
    assert.equal(r.until, 0);
    assert.equal(gate.check('g5').ok, true, '解除后必须放行');
  });
});

test('负数 / NaN 一律当解除，不会写一个过去的 until', async () => {
  await withGate(async ({ gate }) => {
    for (const bad of [-1, Number.NaN, -DAY]) {
      const r = await gate.setSilence('g6', bad, {});
      assert.equal(r.until, 0, `ms=${bad} 应该是解除`);
    }
  });
});

test('静默落盘：新实例读同一个目录还在', async () => {
  await withGate(async ({ dir, call }) => {
    const r = await call('gate.set', { scope: 'silence', chatId: 'g7', ms: 30 * 60_000 });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'bot1.json'), 'utf8'));
    assert.equal(Number(raw.silence.g7), Number(r.until), '文件里的 until 要和返回值一致');

    const again = createGate({ dir, botId: 'bot1' });
    await again.open();
    const snap = await again.snapshot();
    assert.ok(snap.silence.some((x) => x.chatId === 'g7'), '重启后 gate.get 还能看到这条');
    assert.equal(again.check('g7').ok, false, '重启后仍然拦得住');
  });
});

test('夹取后仍然只有这一条，不会顺手影响别的群', async () => {
  await withGate(async ({ call }) => {
    await call('gate.set', { scope: 'silence', chatId: 'a', ms: 10 * 60_000 });
    await call('gate.set', { scope: 'silence', chatId: 'b', ms: 400 * DAY });
    const snap = await call('gate.get', {});
    const ids = snap.silence.map((x) => x.chatId).sort();
    assert.deepEqual(ids, ['a', 'b']);
  });
});
