// 账本里的发言人资料（`recent({ withPeople: true })`）。
//
// 面板账本要在「谁」这一列显示头像缩略图 + 群名片 + QQ 昵称，但账本表本身
// 只有 `user_name` 一列。头像和两个名字都在 `payload` 里（存的是
// `cleanPayload(raw)`），所以用 SQLite 的 `json_extract` 从库里直接取三列，
// 不把整包 payload 拉到 JS —— 一页 50 条，每条 payload 可能几十 KB。
//
// 断言盯三件事：
//   1. 三个字段取得出来（群名片 ≠ QQ 昵称）；
//   2. **不传 withPeople 时一个都不多**（别的调用方不该平白多收字段）；
//   3. 老账本 / 出站行没有 author，得给空串而不是 undefined 或崩掉。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLedger } from '../src/ledger.js';

function makeLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-lgp-'));
  const ledger = createLedger({ file: path.join(dir, 'events.db'), botId: 'main', retentionDays: 0 });
  ledger.open();
  return ledger;
}

const INBOUND = {
  id: 'm-people-1',
  kind: 'group',
  chatId: 'G1',
  userId: 'U1',
  userName: '群名片',
  content: '你好',
  at: 1700000000000,
  raw: {
    author: {
      member_openid: 'U1',
      username: 'QQ名',
      member_nickname: '群名片',
      avatar: 'https://thirdqq.qlogo.cn/x?s=640',
    },
  },
};

test('withPeople：群名片、QQ 昵称、头像都取得到', async () => {
  const l = makeLedger();
  await l.append(INBOUND);
  const [row] = l.recent({ chatId: 'G1', withPeople: true });

  assert.equal(row.card, '群名片');
  assert.equal(row.nickname, 'QQ名');
  assert.equal(row.avatar, 'https://thirdqq.qlogo.cn/x?s=640');
  /** 原来那列不能被动：其它调用方还在读 user_name */
  assert.equal(row.userName, '群名片');
  l.close?.();
});

test('withPeople：不传时三个字段一个都不多（不给别的调用方加负担）', async () => {
  const l = makeLedger();
  await l.append(INBOUND);
  const [row] = l.recent({ chatId: 'G1' });

  assert.equal('card' in row, false);
  assert.equal('nickname' in row, false);
  assert.equal('avatar' in row, false);
  l.close?.();
});

test('withPeople：老账本没有 author → 空串，不是 undefined', async () => {
  const l = makeLedger();
  await l.append({ ...INBOUND, id: 'm-old', raw: { content: '老数据' } });
  const [row] = l.recent({ chatId: 'G1', withPeople: true });

  assert.equal(row.card, '');
  assert.equal(row.nickname, '');
  assert.equal(row.avatar, '');
  l.close?.();
});

test('withPeople：出站行（没有 userId / author）也不炸', async () => {
  const l = makeLedger();
  await l.append({
    id: 'm-out',
    kind: 'group',
    chatId: 'G1',
    userId: '',
    userName: '',
    content: '机器人说的话',
    at: 1700000000001,
    plugin: 'ai-chat',
    raw: {},
  });
  const rows = l.recent({ chatId: 'G1', withPeople: true });
  /** 账本行 id 是入账时生成的 uuid，不是 msg.id（msg.id 只用于 dedupe），按正文找 */
  const out = rows.find((r) => r.content === '机器人说的话');
  assert.ok(out, '出站行也要在账本里');
  assert.equal(out.card, '');
  assert.equal(out.avatar, '');
  assert.equal(out.plugin, 'ai-chat');
  l.close?.();
});

test('withPeople：分页（beforeSeq）也带得上三个字段', async () => {
  const l = makeLedger();
  for (let i = 0; i < 3; i += 1) {
    await l.append({ ...INBOUND, id: `m-page-${i}`, content: `第 ${i} 条`, at: 1700000000000 + i });
  }
  const all = l.recent({ chatId: 'G1', withPeople: true });
  assert.equal(all.length, 3);

  /** 游标是「更早一页」的边界：取第二条的 seq 之前，只剩最早那条 */
  const older = l.recent({ chatId: 'G1', beforeSeq: all[1].seq, withPeople: true });
  assert.equal(older.length, 1);
  assert.equal(older[0].content, '第 0 条');
  assert.equal(older[0].card, '群名片');
  l.close?.();
});

/* ---------------- 会话列表的人名 ---------------- */

/**
 * 面板会话列表要显示人名。私聊的 `chat_id` 就是对方 openid，
 * 而「最近一条」往往不是人说的（机器人自己的回复没有 `user_name`）。
 */
test('lastNameOf：跳过出站行，取最近一个有名字的发言人', async () => {
  const l = makeLedger();
  await l.append({ ...INBOUND, id: 'm-in', userName: '倦飞之鸟', content: '在吗', at: 1700000000000 });
  await l.append({
    id: 'm-out',
    kind: 'group',
    chatId: 'G1',
    userId: '',
    userName: '',
    content: '在的',
    at: 1700000000001,
    plugin: 'ai-chat',
    raw: {},
  });

  assert.equal(l.lastNameOf('G1'), '倦飞之鸟', '最后一条是出站，不能返回空串');
  l.close?.();
});

test('lastNameOf：没有说过话的会话给空串', async () => {
  const l = makeLedger();
  await l.append({
    id: 'm-only-out',
    kind: 'c2c',
    chatId: 'U9',
    userId: '',
    userName: '',
    content: '主动打招呼',
    at: 1700000000002,
    plugin: 'ai-chat',
    raw: {},
  });
  assert.equal(l.lastNameOf('U9'), '');
  assert.equal(l.lastNameOf(''), '', '空 chatId 不能扫全表');
  l.close?.();
});
