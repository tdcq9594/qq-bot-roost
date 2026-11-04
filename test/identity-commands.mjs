// 群内绑定指令：绑定群号 / 绑定成员。
//
// 这是**群里发一句话就能改绑定表**的入口，所以重点不在「能不能绑」，
// 而在「不该绑的绑不了」：非群聊、非管理员、只 @ 了机器人、
// 想借参数把别的群的 openid 塞进来——每一条都要挡住。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTargetUin, pickMember, runBindGroup, runBindUser } from '../src/identity-commands.js';

const GROUP_OPENID = 'AAAA1111BBBB2222CCCC3333DDDD4444';
const OTHER_GROUP = 'BBBB2222CCCC3333DDDD4444EEEE5555';
const MEMBER_OPENID = 'EEEE5555FFFF6666AAAA7777BBBB8888';
const ADMIN_OPENID = 'CCCC3333DDDD4444EEEE5555FFFF6666';

function makeMsg(patch = {}) {
  return {
    kind: 'group',
    chatId: GROUP_OPENID,
    userId: ADMIN_OPENID,
    args: [],
    mentions: [],
    ...patch,
  };
}

function fakeIdentity({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async bind(args) {
      calls.push(args);
      if (fail) throw fail;
      return { uin: args.uin };
    },
  };
}

/* ---------------- 解析 ---------------- */

test('解析号码：从参数里取最后一个合法号码，跳过 <@openid> 这种 token', () => {
  assert.equal(parseTargetUin(['10001']), '10001');
  assert.equal(parseTargetUin([`<@${MEMBER_OPENID}>`, '10001']), '10001');
  assert.equal(parseTargetUin(['10001', '20002']), '20002', '取最后一个');
  assert.equal(parseTargetUin(['abc', '']), '');
  assert.equal(parseTargetUin([]), '');
  assert.equal(parseTargetUin(['012345']), '', '首位是 0 不算号码');
  assert.equal(parseTargetUin(['1234']), '', '不足 5 位不算');
});

test('选成员：跳过机器人，取第一个真人', () => {
  assert.equal(pickMember([{ id: 'bot1', isBot: true }, { id: MEMBER_OPENID, name: '小明' }]).id, MEMBER_OPENID);
  assert.equal(pickMember([{ id: 'bot1', isBot: true }]), null, '只 @ 了机器人 = 没选人');
  assert.equal(pickMember([]), null);
  assert.equal(pickMember([{ id: '' }]), null);
  assert.equal(pickMember(null), null, 'mentions 不是数组也不能炸');
});

/* ---------------- 绑定群号 ---------------- */

test('绑定群号：成功时用当前群的 chatId，botId 也带上', async () => {
  const identity = fakeIdentity();
  const r = await runBindGroup({
    msg: makeMsg({ args: ['763366431'] }),
    identity,
    botId: 'main',
    allowed: true,
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /763366431/);
  assert.deepEqual(identity.calls, [{ kind: 'group', uin: '763366431', openid: GROUP_OPENID, botId: 'main' }]);
});

test('绑定群号：不能借参数把别的群的 openid 绑进来', async () => {
  const identity = fakeIdentity();
  await runBindGroup({
    msg: makeMsg({ args: ['763366431', OTHER_GROUP] }),
    identity,
    botId: 'main',
    allowed: true,
  });
  assert.equal(identity.calls[0].openid, GROUP_OPENID, 'openid 只能来自当前群');
});

test('绑定群号：私聊里发、非管理员、缺号码都拒绝，且一次都不写表', async () => {
  const identity = fakeIdentity();
  const cases = [
    { msg: makeMsg({ kind: 'c2c' }), allowed: true, why: '私聊不能用' },
    { msg: makeMsg({ args: ['763366431'] }), allowed: false, why: '不是管理员' },
    { msg: makeMsg({ args: [] }), allowed: true, why: '没给号码' },
  ];
  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runBindGroup({ msg: c.msg, identity, botId: 'main', allowed: c.allowed });
    assert.equal(r.ok, false, c.why);
    assert.ok(r.text, `${c.why} 也要给一句话说明`);
  }
  assert.equal(identity.calls.length, 0);
});

test('绑定群号：冲突时提示去面板，不做强制改绑', async () => {
  const err = new Error('这个 openid 已经绑到 群号 111111 了');
  err.code = 'CONFLICT';
  err.owner = '111111';
  const identity = fakeIdentity({ fail: err });
  const r = await runBindGroup({ msg: makeMsg({ args: ['763366431'] }), identity, botId: 'main', allowed: true });
  assert.equal(r.ok, false);
  assert.match(r.text, /面板/);
});

/* ---------------- 绑定成员 ---------------- */

test('绑定成员：把被 @ 的那个人绑到号码', async () => {
  const identity = fakeIdentity();
  const r = await runBindUser({
    msg: makeMsg({
      args: [`<@${MEMBER_OPENID}>`, '10001'],
      mentions: [{ id: MEMBER_OPENID, name: '小明', isBot: false }],
    }),
    identity,
    botId: 'main',
    allowed: true,
  });
  assert.equal(r.ok, true);
  assert.match(r.text, /小明/);
  assert.match(r.text, /10001/);
  assert.deepEqual(identity.calls, [{ kind: 'user', uin: '10001', openid: MEMBER_OPENID, botId: 'main' }]);
});

test('绑定成员：没 @ 人 / 只 @ 了机器人 / 缺号码 都拒绝', async () => {
  const identity = fakeIdentity();
  const cases = [
    { msg: makeMsg({ args: ['10001'] }), why: '没 @ 人' },
    { msg: makeMsg({ args: ['10001'], mentions: [{ id: 'bot1', isBot: true }] }), why: '只 @ 了机器人' },
    { msg: makeMsg({ mentions: [{ id: MEMBER_OPENID, isBot: false }] }), why: '缺号码' },
    { msg: makeMsg({ kind: 'c2c', mentions: [{ id: MEMBER_OPENID }], args: ['10001'] }), why: '私聊' },
  ];
  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runBindUser({ msg: c.msg, identity, botId: 'main', allowed: true });
    assert.equal(r.ok, false, c.why);
  }
  assert.equal(identity.calls.length, 0);
});

test('绑定成员：非管理员拒绝，即使 @ 对了人', async () => {
  const identity = fakeIdentity();
  const r = await runBindUser({
    msg: makeMsg({ args: ['10001'], mentions: [{ id: MEMBER_OPENID, isBot: false }] }),
    identity,
    botId: 'main',
    allowed: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /主人|管理员/);
  assert.equal(identity.calls.length, 0);
});

test('绑定成员：表里抛非预期错误也变成一句话，不把异常扔给聊天层', async () => {
  const identity = fakeIdentity({ fail: new Error('磁盘满了') });
  const r = await runBindUser({
    msg: makeMsg({ args: ['10001'], mentions: [{ id: MEMBER_OPENID, isBot: false }] }),
    identity,
    botId: 'main',
    allowed: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /磁盘满了/);
});

test('绑定：成功时记一条审计日志（谁在哪个群绑了什么）', async () => {
  const logs = [];
  const identity = fakeIdentity();
  await runBindGroup({
    msg: makeMsg({ args: ['763366431'] }),
    identity,
    botId: 'main',
    allowed: true,
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(ADMIN_OPENID));
  assert.match(logs[0], /763366431/);
});
