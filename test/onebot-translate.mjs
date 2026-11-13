/**
 * 官方事件 → OneBot 事件：**@ 机器人自己**要在 `message` 里留一个 at 段。
 *
 * 为什么值得单测：OneBot 客户端判断「有没有人叫我」只看 at 段里的 qq 是不是
 * 自己（aurabot 的 `parseMessageEvent` 就是 `d.qq === self`）。早先这里按
 * 「被动回复本身已经指向它，多一个 @ 是噪音」把这一段省了，结果 @ 她的群消息
 * 被当成普通群消息，掉进「话题相关度」闸门里 → `相关度 0.00 → 不回`
 * （2026-11-13 真机实测）。这个断言就是钉住那次的回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { segmentsOf, toMessageEvent, rawMessageOf } from '../src/onebot/translate.js';

const SELF_UIN = 2854204853;

/** 够用的 ids 桩：openid ↔ QQ 号、msgIdx ↔ message_id 都只是查表 */
function stubIds({ users = {}, groups = {}, idx = {} } = {}) {
  return {
    messageIdOfIdx: (k) => idx[String(k)] ?? '',
    user: (openid) => users[String(openid)] ?? '',
    group: (openid) => groups[String(openid)] ?? '',
    bindMessage: () => 'msg-1',
  };
}

const baseMsg = (over = {}) => ({
  kind: 'group',
  groupId: 'G1',
  userId: 'U1',
  userName: '倦飞之鸟',
  content: '说话',
  mentions: [],
  mentioned: false,
  attachments: [],
  receivedAt: Date.now(),
  raw: { author: { member_role: 'member' } },
  ...over,
});

test('被 @：第一个段就是 at 自己（客户端靠它判断「在叫我」）', () => {
  const segs = segmentsOf(baseMsg({ mentioned: true }), stubIds(), SELF_UIN);
  assert.deepEqual(segs[0], { type: 'at', data: { qq: String(SELF_UIN), name: '' } });
  /** 正文还在，没被 at 段顶掉 */
  assert.deepEqual(segs.at(-1), { type: 'text', data: { text: '说话' } });

  /** raw_message 也要能看出 @ 了谁（不解析段的老客户端看这个） */
  assert.match(rawMessageOf(segs), new RegExp(`^\\[CQ:at,qq=${SELF_UIN}\\]`));
});

test('没被 @：一个 at 段都不发（否则每条群消息都会被当成在叫她）', () => {
  const segs = segmentsOf(baseMsg(), stubIds(), SELF_UIN);
  assert.equal(segs.filter((s) => s.type === 'at').length, 0);
});

test('机器人 QQ 号没绑（selfUin=0）：不发 qq=0 的假 at', () => {
  const segs = segmentsOf(baseMsg({ mentioned: true }), stubIds(), 0);
  assert.equal(segs.filter((s) => s.type === 'at').length, 0);
});

test('同时 @ 她和别人：两个 at 段都在，自己在前', () => {
  const ids = stubIds({ users: { OTHER: 2014433751 } });
  const segs = segmentsOf(
    baseMsg({ mentioned: true, mentions: [{ id: 'OTHER', isBot: false, name: '鱼头' }] }),
    ids,
    SELF_UIN,
  );
  const ats = segs.filter((s) => s.type === 'at').map((s) => s.data.qq);
  assert.deepEqual(ats, [String(SELF_UIN), '2014433751']);
});

test('引用 + @：reply 段仍在，at 段在最前（顺序不影响客户端，但别互相顶掉）', () => {
  const ids = stubIds({ idx: { REFIDX_1: 'msg-9' } });
  const segs = segmentsOf(baseMsg({ mentioned: true, refMsgIdx: 'REFIDX_1' }), ids, SELF_UIN);
  assert.equal(segs[0].type, 'at');
  assert.deepEqual(segs[1], { type: 'reply', data: { id: 'msg-9' } });
});

test('toMessageEvent：self_id 是自己的 QQ 号，message 里带着那个 at', () => {
  const evt = toMessageEvent({
    msg: baseMsg({ mentioned: true }),
    ids: stubIds({ groups: { G1: 1130901545 }, users: { U1: 2014433751 } }),
    selfUin: SELF_UIN,
  });
  assert.equal(evt.self_id, SELF_UIN);
  assert.equal(evt.message_type, 'group');
  assert.equal(evt.group_id, 1130901545);
  assert.equal(evt.message[0].type, 'at');
  assert.equal(evt.message[0].data.qq, String(SELF_UIN));
});
