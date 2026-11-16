// 2026-11-16 官方补齐的三件事：昵称、头像、群资料。
//
// 以前「说话人叫什么」只有 `author.username` 一个来源，群聊里经常是空串，
// 于是插件只能退回 openid。现在群聊多了 `member_nickname`（群内昵称），
// 两种场景都带 `avatar` —— 取错顺序会让群会话显示 QQ 昵称而不是群名片。
//
// `union_group_openid` 只做透传断言：跨机器人的关联走 identity 绑定，
// 这里要保证它**没被存进群档案**（存了会让人以为能当群 id 用）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** BotRuntime 构造时会建档案文件，数据目录必须先指到临时目录 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-mf-'));
process.env.ROOST_HOME = HOME;

const { buildMessage } = await import('../src/message.js');
const { serializeMessage } = await import('../src/host/serialize.js');
const { BotRuntime } = await import('../src/bot.js');

const cfg = { commandPrefix: '/' };
const api = {};
const ts = '1700000000000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const groupEvent = (author, extra = {}) => ({
  id: 'm1',
  content: '你好',
  group_openid: 'g1',
  author,
  timestamp: ts,
  ...extra,
});

test('群消息：群内昵称优先，QQ 昵称与群名片分开给', () => {
  const msg = buildMessage('GROUP_AT_MESSAGE_CREATE', groupEvent({
    member_openid: 'u1',
    username: 'QQ昵称',
    member_nickname: '群名片',
    avatar: 'https://qlogo/1.png',
  }, { union_group_openid: 'UG1' }), { api, cfg });

  assert.equal(msg.userName, '群名片', '群聊要显示群内昵称');
  assert.equal(msg.userCard, '群名片');
  assert.equal(msg.userNickname, 'QQ昵称', 'OneBot 的 nickname 要用这个');
  assert.equal(msg.userAvatar, 'https://qlogo/1.png');
  assert.equal(msg.unionGroupId, 'UG1');
  assert.equal(msg.unionUserId, '');
});

test('群消息：没有群内昵称时退回 QQ 昵称', () => {
  const msg = buildMessage('GROUP_AT_MESSAGE_CREATE', groupEvent({
    member_openid: 'u1',
    username: '只有昵称',
  }), { api, cfg });

  assert.equal(msg.userName, '只有昵称');
  assert.equal(msg.userCard, '', '没给群名片就是空串，不能拿昵称冒充');
});

test('单聊：昵称 + 头像都挂上，群名片保持空', () => {
  const msg = buildMessage('C2C_MESSAGE_CREATE', {
    id: 'm2',
    content: '你好',
    author: { user_openid: 'u2', username: '小明', avatar: 'https://qlogo/2.png', union_openid: 'UU2' },
    timestamp: ts,
  }, { api, cfg });

  assert.equal(msg.userName, '小明');
  assert.equal(msg.userCard, '');
  assert.equal(msg.userAvatar, 'https://qlogo/2.png');
  assert.equal(msg.unionUserId, 'UU2');
});

test('官方没给就留空串，不编一个默认头像', () => {
  const msg = buildMessage('GROUP_AT_MESSAGE_CREATE', groupEvent({ member_openid: 'u3' }), { api, cfg });

  assert.equal(msg.userName, '');
  assert.equal(msg.userAvatar, '');
  assert.equal(msg.userCard, '');
});

test('mentions 里的名字也按群内昵称取', () => {
  const msg = buildMessage('GROUP_MESSAGE_CREATE', groupEvent({ member_openid: 'u1' }, {
    content: '看看 <@u9>',
    mentions: [
      { member_openid: 'u9', username: '被@的人', member_nickname: '他群名片' },
      { member_openid: 'bot1', username: '机器人', is_you: true },
    ],
  }), { api, cfg });

  assert.equal(msg.mentions.length, 1, '机器人自己要被排除');
  assert.equal(msg.mentions[0].name, '他群名片');
});

test('宿主协议：sender 带昵称/头像/群名片，chat 带跨应用群标识', () => {
  const msg = buildMessage('GROUP_AT_MESSAGE_CREATE', groupEvent({
    member_openid: 'u1',
    username: 'QQ昵称',
    member_nickname: '群名片',
    avatar: 'https://qlogo/1.png',
  }, { union_group_openid: 'UG1' }), { api, cfg });

  const evt = serializeMessage(msg, { groupName: '摸鱼群' });
  assert.equal(evt.sender.name, '群名片');
  assert.equal(evt.sender.card, '群名片');
  assert.equal(evt.sender.nickname, 'QQ昵称');
  assert.equal(evt.sender.avatar, 'https://qlogo/1.png');
  assert.equal(evt.chat.unionGroupId, 'UG1');
  assert.equal(evt.chat.name, '摸鱼群');
});

test('群档案：群信息接口新字段落盘，union 字段不存', async () => {
  const rt = new BotRuntime({
    cfg: { id: 'mft1', name: 't', appId: 'a', appSecret: 's' },
    globalCfg: {},
  });
  rt.api = {
    getGroupInfo: async () => ({
      group_openid: 'G9',
      group_name: '读书会',
      group_member_num: 256,
      group_finger_memo: '每周共读一本',
      group_class_text: '文化',
      group_tags: ['阅读', '文学'],
      union_group_openid: 'UG9',
    }),
  };

  await rt.fetchGroupNames(['G9']);

  const info = rt.groupInfo('G9');
  assert.equal(info.name, '读书会');
  assert.equal(info.memberNum, 256);
  assert.equal(info.fingerMemo, '每周共读一本');
  assert.deepEqual(info.tags, ['阅读', '文学']);

  await rt.groups.flush();
  const saved = await rt.groups.get('G9');
  assert.equal(saved.name, '读书会');
  assert.equal(saved.memberNum, 256);
  assert.equal(saved.classText, '文化');
  assert.equal(saved.unionGroupOpenid, undefined, '跨机器人关联走 identity，别存这个字段');
});

test('群档案：重启后从档案预载，不用等第一条消息', async () => {
  const mk = () => new BotRuntime({
    cfg: { id: 'mft2', name: 't', appId: 'a', appSecret: 's' },
    globalCfg: {},
  });
  const first = mk();
  first.api = { getGroupInfo: async () => ({ group_name: '预载群', group_member_num: 42 }) };
  await first.fetchGroupNames(['G2']);
  await first.groups.flush();

  const second = mk();
  await sleep(50); // 预载是 fire-and-forget，等它读完档案
  assert.equal(second.groupName('G2'), '预载群');
  assert.equal(second.groupInfo('G2').memberNum, 42);
});
