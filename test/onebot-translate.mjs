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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { segmentsOf, toMessageEvent, rawMessageOf } from '../src/onebot/translate.js';
import { createActions } from '../src/onebot/actions.js';
import { OneBotIds } from '../src/onebot/ids.js';

const SELF_UIN = 2854204853;

/** 够用的 ids 桩：openid ↔ QQ 号、msgIdx ↔ message_id 都只是查表 */
function stubIds({ users = {}, groups = {}, idx = {} } = {}) {
  const forwards = new Map();
  let nextForward = 900001;
  return {
    messageIdOfIdx: (k) => idx[String(k)] ?? '',
    user: (openid) => users[String(openid)] ?? 0,
    group: (openid) => groups[String(openid)] ?? 0,
    bindMessage: () => 'msg-1',
    bindForward: (nodes) => {
      const id = nextForward++;
      forwards.set(id, nodes);
      return id;
    },
    getForward: (id) => forwards.get(Number(id)) ?? null,
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

/* ---------- 2026-11-24：官方载荷里的 ARK / 聊天记录 / 表情不再变成空段 ---------- */

test('ARK 卡片 → json 段，客户端能读出标题和链接', () => {
  const segs = segmentsOf(
    baseMsg({
      content: '',
      ark: {
        type: 'ark',
        name: 'B站分享',
        prompt: '分享了一个视频',
        title: '测试视频',
        desc: '来自 B 站',
        url: 'https://www.bilibili.com/video/1',
        fields: { title: '测试视频', desc: '来自 B 站', jump_url: 'https://www.bilibili.com/video/1' },
      },
    }),
    stubIds(),
    SELF_UIN,
  );
  const seg = segs.find((s) => s.type === 'json');
  assert.ok(seg, 'ARK 必须产出 json 段，不能让客户端只看到空消息');
  const card = JSON.parse(seg.data.data);
  assert.equal(card.meta.detail_1.title, '测试视频');
  assert.equal(card.meta.detail_1.jumpUrl, 'https://www.bilibili.com/video/1');
  assert.equal(card.prompt, '分享了一个视频');
  assert.match(rawMessageOf(segs), /^\[CQ:json,data=/);
});

test('表情与未知附件：face 段 + file 段，正文里的人话标记不重复显示', () => {
  const segs = segmentsOf(
    baseMsg({
      content: '看这个 【表情: 幽灵】',
      raw: {
        content: '看这个 <faceType=1,faceId="187",ext="eyJ0ZXh0Ijoi5bm954G1In0=">',
      },
      attachments: [{ type: 'other', filename: 'sticker.gif', url: 'https://x/sticker.gif', contentType: 'image/gif' }],
    }),
    stubIds(),
    SELF_UIN,
  );
  assert.deepEqual(segs.find((s) => s.type === 'face')?.data, { id: '187' });
  assert.equal(segs.find((s) => s.type === 'text')?.data.text, '看这个 ');
  assert.deepEqual(segs.find((s) => s.type === 'file')?.data, {
    file: 'https://x/sticker.gif',
    url: 'https://x/sticker.gif',
    name: 'sticker.gif',
  });
  assert.match(rawMessageOf(segs), /\[CQ:face,id=187\]/);
});

test('102 聊天记录 → forward 段；get_forward_msg 能按 id 拉回节点', async () => {
  const ids = stubIds({ users: { A: 2014433751, B: 2014433752 } });
  const segs = segmentsOf(
    baseMsg({
      content: '',
      elements: [
        {
          type: 'chatRecord',
          content: '聊天记录',
          children: [
            { type: 'text', content: '张三：你好', author: { id: 'A', nickname: '张三', card: '三' } },
            { type: 'text', content: '李四：收到', author: { id: 'B', nickname: '李四' } },
          ],
        },
      ],
    }),
    ids,
    SELF_UIN,
  );
  const fwd = segs.find((s) => s.type === 'forward');
  assert.ok(fwd, '聊天记录要发 forward 段');
  const nodes = ids.getForward(fwd.data.id);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].sender.nickname, '张三');
  assert.equal(nodes[0].sender.user_id, 2014433751);
  assert.equal(nodes[0].message[0].data.text, '张三：你好');
  assert.equal(nodes[1].message[0].data.text, '李四：收到');

  const actions = createActions({
    runtime: { api: {}, outbound: {}, gate: {}, groups: {}, log: {} },
    ids,
    selfUin: SELF_UIN,
    botName: '测试鸟',
    getPassive: () => null,
    emit: () => {},
  });
  assert.deepEqual((await actions('get_forward_msg', { id: fwd.data.id })).messages, nodes);
  await assert.rejects(() => actions('get_forward_msg', { id: 123456 }), /找不到这条合并转发/);
  assert.ok(actions.names.includes('get_forward_msg'), '能力表要能看到这个 action');
});

test('引用元素：有 refMsgIdx 发 reply，没有时退成 [引用: …] 文字', () => {
  const ids = stubIds({ idx: { REFIDX_1: 'msg-9' } });
  const withIdx = segmentsOf(
    baseMsg({ content: '', refMsgIdx: 'REFIDX_1', elements: [{ type: 'quote', content: '原话', msgIdx: 'REFIDX_1' }] }),
    ids,
    SELF_UIN,
  );
  assert.deepEqual(withIdx.filter((s) => s.type === 'reply'), [{ type: 'reply', data: { id: 'msg-9' } }]);
  assert.equal(withIdx.find((s) => s.type === 'text')?.data.text, '[引用: 原话]');

  const noIdx = segmentsOf(
    baseMsg({ content: '', elements: [{ type: 'quote', content: '另一句原话' }] }),
    stubIds(),
    SELF_UIN,
  );
  assert.equal(noIdx.filter((s) => s.type === 'reply').length, 0, '没有 id 不许发 id=0 的空 reply');
  assert.equal(noIdx.find((s) => s.type === 'text')?.data.text, '[引用: 另一句原话]');
});

test('真实 OneBotIds：转发 id 单调、不复用，且不会把节点内容写进 ids.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-fwd-ids-'));
  const file = path.join(dir, 'onebot-ids.json');
  try {
    const ids = await new OneBotIds({ file, botId: 't' }).load();
    const a = ids.bindForward([{ message: [] }]);
    const b = ids.bindForward([{ message: [{ type: 'text', data: { text: 'x' } }] }]);
    assert.ok(b > a, '两组转发的 id 不能撞');
    assert.equal(ids.getForward(b)[0].message[0].data.text, 'x');
    assert.equal(ids.getForward(a + b), null, '不存在的 id 要明确 null');
    await ids.flush();
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.forwards, undefined, '节点内容不该落盘');
    assert.ok(saved.nextId > b, '计数器要落盘，重启后不复用旧号');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
