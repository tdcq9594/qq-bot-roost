/**
 * 4.6 互动召回 is_wakeup：跨仓透传与额度隔离。
 *
 * 官方口径：用户主动对话后 30 天内，当天 / 1–3 天 / 3–7 天 / 7–30 天
 * 四个窗口各 1 条；用 is_wakeup 字段声明。它不是普通主动推送，
 * 不该被本地「每日主动条数」拦住（上游 dsh-roost 按窗口记账）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildSendPayload } from '../src/api.js';
import { Outbound } from '../src/outbound.js';

function rig(dailyActive = 0) {
  const sent = [];
  const api = {
    async sendGroup(target, body) { sent.push({ kind: 'group', target, body }); return { id: 'm1' }; },
    async sendC2C(target, body) { sent.push({ kind: 'c2c', target, body }); return { id: 'm2' }; },
  };
  const dir = mkdtempSync(path.join(tmpdir(), 'roost-wake-'));
  const ob = new Outbound({
    api,
    cfg: { outbound: { dryRun: false, perSec: 100, dailyActive, activePerMinute: 100 } },
    isOnline: () => true,
    quotaFile: path.join(dir, 'quota.json'),
  });
  return {
    ob, sent,
    done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

test('buildSendPayload：isWakeup 才写 is_wakeup，不带就不写', () => {
  const plain = buildSendPayload({ content: '你好' });
  assert.equal(plain.is_wakeup, undefined, '普通消息不能带这个声明');
  const wake = buildSendPayload({ content: '好久不见', isWakeup: true });
  assert.equal(wake.is_wakeup, true);
  assert.equal(wake.content, '好久不见');
  /** 和 msgId 一起给也不冲突（官方说带它就不校验 msg_id 有效期） */
  const both = buildSendPayload({ content: '嗯', msgId: 'm1', msgSeq: 1, isWakeup: true }, () => 1);
  assert.equal(both.is_wakeup, true);
  assert.equal(both.msg_id, 'm1');
});

test('出站：本地日额度用完时，普通主动被拦，互动召回仍能发', async (t) => {
  const r = rig(0);
  t.after(r.done);
  await assert.rejects(
    r.ob.send({ kind: 'c2c', target: 'u1', chatKey: 'c2c:u1', payload: { content: '普通主动' } }),
    /额度已用完/,
    '普通主动消息必须被日额度拦住',
  );
  const out = await r.ob.send({ kind: 'c2c', target: 'u1', chatKey: 'c2c:u1', payload: { content: '好久不见', isWakeup: true } });
  assert.ok(out.raw, '正常出站返回 raw，不是 dry 的 ok');
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].body.isWakeup, true, '字段要一路带到 api');
});

test('出站：互动召回不占本地主动额度，也不在失败时误退额度', async (t) => {
  const r = rig(2);
  t.after(r.done);
  const before = await r.ob.quota.used('c2c:u1');
  const out = await r.ob.send({ kind: 'c2c', target: 'u1', chatKey: 'c2c:u1', payload: { content: '召回一句', isWakeup: true } });
  assert.ok(out.raw);
  assert.equal(await r.ob.quota.used('c2c:u1'), before, '不该扣普通主动额度');
  /** 普通主动仍会扣，证明不是「额度整体坏了」 */
  await r.ob.send({ kind: 'c2c', target: 'u1', chatKey: 'c2c:u1', payload: { content: '普通一句' } });
  assert.equal(await r.ob.quota.used('c2c:u1'), before + 1);
});
