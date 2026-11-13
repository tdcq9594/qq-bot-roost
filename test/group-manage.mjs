/**
 * 群管协议方法（group.info / group.mute / group.kick / group.join）
 * =================================================================
 *
 * 这组方法为什么单独存在、不放开 `qq.call`，见 `src/host/methods.js` 里的注释。
 * 这份测试盯四件事：
 *   1. 官方错误码 → 可判断的 reason（面板和模型都不该去猜中文）
 *   2. 本地硬限（超 30 天 / 超 20 人）**不花请求**
 *   3. 参数形态转换（调用方传秒，官方要的是到期时间）
 *   4. scope：写操作必须 manage，只读令牌调不动
 *
 * 跑法：node --test test/group-manage.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMethods } from '../src/host/methods.js';

const ALL = new Set(['read', 'message', 'manage']);

function make(over = {}) {
  const calls = [];
  const api = {
    groupInvited: over.invited ?? true,
    async getGroupInfo(id) {
      calls.push(['getGroupInfo', id]);
      if (over.infoThrows) throw new Error(over.infoThrows);
      return { group_name: '斗罗内测', member_count: 9 };
    },
    async canManageGroup(id) {
      calls.push(['canManageGroup', id]);
      return over.manage ?? { ok: true, role: 'admin', reason: '机器人是群管理员' };
    },
    async muteMembers(gid, members) {
      calls.push(['muteMembers', gid, members]);
      if (over.muteThrows) throw new Error(over.muteThrows);
      return { ok: true };
    },
    async removeMembers(gid, list, opts) {
      calls.push(['removeMembers', gid, list, opts]);
      if (over.kickThrows) throw new Error(over.kickThrows);
      return { ok: true };
    },
    async getJoinRequests(gid, opts) {
      calls.push(['getJoinRequests', gid, opts]);
      if (over.listThrows) throw new Error(over.listThrows);
      return { requests: [{ member_openid: 'u1', join_request_id: 'r1' }], next: '' };
    },
    async approveJoinRequest(...a) {
      calls.push(['approveJoinRequest', ...a]);
      return { ok: true };
    },
    async declineJoinRequest(...a) {
      calls.push(['declineJoinRequest', ...a]);
      return { ok: true };
    },
  };
  const methods = createMethods({ runtime: { id: 'b', api }, getState: () => ({ version: 'test' }) });
  return { methods, calls };
}

/* ------------------------------------------------------------------ */

test('group.info：公开信息 + 角色 + 能不能管', async () => {
  const { methods } = make();
  const r = await methods.call('group.info', { groupOpenid: 'g1' }, { scopes: ALL });
  assert.equal(r.name, '斗罗内测');
  assert.equal(r.memberCount, 9);
  assert.equal(r.role, 'admin');
  assert.equal(r.canManage, true);
  assert.equal(r.invited, true);
});

test('group.info：内邀没开不报错，只说明管不了', async () => {
  const { methods } = make({ invited: false, manage: { ok: false, role: null, reason: '群管内邀没开' } });
  const r = await methods.call('group.info', { groupOpenid: 'g1' }, { scopes: ALL });
  assert.equal(r.canManage, false);
  assert.equal(r.invited, false);
  assert.match(r.manageReason, /内邀/);
});

test('group.info：群信息拿不到也照样返回，不整条失败', async () => {
  const { methods } = make({ infoThrows: '429 太频繁' });
  const r = await methods.call('group.info', { groupOpenid: 'g1' }, { scopes: ALL });
  assert.equal(r.name, '');
  assert.match(r.infoError, /429/);
});

test('group.mute：调用方传秒，转成官方的到期时间 + op=add', async () => {
  const { methods, calls } = make();
  const before = Date.now();
  const r = await methods.call(
    'group.mute',
    { groupOpenid: 'g1', memberOpenids: ['u1', 'u2'], seconds: 600 },
    { scopes: ALL },
  );
  assert.equal(r.ok, true);
  const hit = calls.find((c) => c[0] === 'muteMembers');
  assert.equal(hit[1], 'g1');
  assert.equal(hit[2].length, 2);
  assert.equal(hit[2][0].op, 'add');
  assert.equal(hit[2][0].member_openid, 'u1');
  const exp = Date.parse(hit[2][0].mute_expire_at);
  assert.ok(exp >= before + 600_000 - 2000, '到期时间应该在 now+600s 附近');
  assert.ok(exp <= Date.now() + 600_000 + 2000);
});

test('group.mute：seconds=0 是解禁，op=del 且到期时间为空', async () => {
  const { methods, calls } = make();
  await methods.call('group.mute', { groupOpenid: 'g1', memberOpenids: ['u1'], seconds: 0 }, { scopes: ALL });
  const members = calls.find((c) => c[0] === 'muteMembers')[2];
  assert.equal(members[0].op, 'del');
  assert.equal(members[0].mute_expire_at, '');
});

test('group.mute：超 30 天 / 超 20 人 本地拦住，一次请求都不发', async () => {
  const { methods, calls } = make();
  const long = await methods.call(
    'group.mute',
    { groupOpenid: 'g1', memberOpenids: ['u1'], seconds: 30 * 24 * 3600 + 1 },
    { scopes: ALL },
  );
  assert.equal(long.reason, 'too_long');
  const many = await methods.call(
    'group.mute',
    { groupOpenid: 'g1', memberOpenids: Array.from({ length: 21 }, (_, i) => `u${i}`), seconds: 60 },
    { scopes: ALL },
  );
  assert.equal(many.reason, 'too_many');
  assert.equal(calls.filter((c) => c[0] === 'muteMembers').length, 0);
});

test('group.mute：重复 openid 只发一次', async () => {
  const { methods, calls } = make();
  await methods.call(
    'group.mute',
    { groupOpenid: 'g1', memberOpenids: ['u1', 'u1', ' u2 ', ''], seconds: 60 },
    { scopes: ALL },
  );
  const members = calls.find((c) => c[0] === 'muteMembers')[2];
  assert.deepEqual(members.map((m) => m.member_openid), ['u1', 'u2']);
});

test('group.mute：官方 40062003 → not_admin', async () => {
  const { methods } = make({ muteThrows: '40062003 机器人不是管理员' });
  const r = await methods.call('group.mute', { groupOpenid: 'g1', memberOpenids: ['u1'], seconds: 60 }, { scopes: ALL });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_admin');
});

test('group.mute：动到群主/管理员 → protected', async () => {
  const { methods } = make({ muteThrows: '40054 不能操作群主' });
  const r = await methods.call('group.mute', { groupOpenid: 'g1', memberOpenids: ['u1'], seconds: 60 }, { scopes: ALL });
  assert.equal(r.reason, 'protected');
});

test('group.kick：内邀没开 → need_invite，并把目标带回来', async () => {
  const { methods } = make({ kickThrows: '群管内邀功能未开启（11253）' });
  const r = await methods.call('group.kick', { groupOpenid: 'g1', memberOpenids: ['u1'] }, { scopes: ALL });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'need_invite');
  assert.deepEqual(r.targets, ['u1']);
});

test('group.kick：正常路径带 addToBlacklist', async () => {
  const { methods, calls } = make();
  const r = await methods.call(
    'group.kick',
    { groupOpenid: 'g1', memberOpenids: ['u1'], addToBlacklist: true },
    { scopes: ALL },
  );
  assert.equal(r.ok, true);
  const hit = calls.find((c) => c[0] === 'removeMembers');
  assert.deepEqual(hit[2], ['u1']);
  assert.equal(hit[3].addToBlacklist, true);
});

test('group.join：list 透传游标，limit 夹到 100', async () => {
  const { methods, calls } = make();
  const r = await methods.call('group.join', { groupOpenid: 'g1', action: 'list', limit: 500 }, { scopes: ALL });
  assert.equal(r.ok, true);
  assert.equal(r.requests.length, 1);
  const hit = calls.find((c) => c[0] === 'getJoinRequests');
  assert.equal(hit[2].limit, 100);
});

test('group.join：approve 缺 joinRequestId 报参数错', async () => {
  const { methods } = make();
  await assert.rejects(
    () => methods.call('group.join', { groupOpenid: 'g1', action: 'approve', memberOpenid: 'u1' }, { scopes: ALL }),
    (e) => e.code === 'BAD_PARAMS',
  );
});

test('group.join：decline 带上拒绝原因与拉黑开关', async () => {
  const { methods, calls } = make();
  await methods.call(
    'group.join',
    { groupOpenid: 'g1', action: 'decline', memberOpenid: 'u1', joinRequestId: 'r1', reason: '广告', addToBlacklist: true },
    { scopes: ALL },
  );
  const hit = calls.find((c) => c[0] === 'declineJoinRequest');
  // 形参顺序：groupOpenid, memberOpenid, { joinRequestId, rejectReason, addToBlacklist }
  assert.equal(hit[1], 'g1');
  assert.equal(hit[2], 'u1');
  assert.equal(hit[3].joinRequestId, 'r1');
  assert.equal(hit[3].rejectReason, '广告');
  assert.equal(hit[3].addToBlacklist, true);
});

test('scope：群管归 message（装了就能用），只读令牌调不动', async () => {
  const { methods } = make();
  const list = methods.describe();
  // 群管是"对外部群动手"，不改框架状态 → 和 msg.send 一样归 message，
  // 不要求用户去开 host.allowManage 总闸。
  for (const n of ['group.mute', 'group.kick', 'group.join']) {
    assert.equal(list.find((m) => m.name === n).scope, 'message', `${n} 应该是 message`);
  }
  assert.equal(list.find((m) => m.name === 'group.info').scope, 'read');

  // 只有 read 的令牌仍然调不动写操作
  await assert.rejects(
    () => methods.call('group.mute', { groupOpenid: 'g1', memberOpenids: ['u1'], seconds: 60 }, { scopes: new Set(['read']) }),
    (e) => e.code === 'NO_SCOPE' && e.http === 403,
  );
});

test('scope：只有 message、没有 manage 也能管群（不需要开 allowManage）', async () => {
  const { methods, calls } = make();
  const r = await methods.call(
    'group.mute',
    { groupOpenid: 'g1', memberOpenids: ['u1'], seconds: 60 },
    { scopes: new Set(['read', 'message']) },
  );
  assert.equal(r.ok, true);
  assert.equal(calls.filter((c) => c[0] === 'muteMembers').length, 1);
});

test('scope：改框架设置仍然要 manage（这条别一起放松）', async () => {
  const { methods } = make();
  const list = methods.describe();
  // 能改权限、能以宿主身份执行代码的，只有这五条
  for (const n of ['config.set', 'identity.bind', 'identity.unbind', 'plugin.config.set', 'plugin.tool.call']) {
    const hit = list.find((m) => m.name === n);
    assert.ok(hit, `${n} 应该在方法表里`);
    assert.equal(hit.scope, 'manage', `${n} 必须仍然是 manage`);
  }
  // 只有 message 的令牌改不了框架设置
  await assert.rejects(
    () => methods.call('config.set', { logLevel: 'debug' }, { scopes: new Set(['read', 'message']) }),
    (e) => e.code === 'NO_SCOPE' && e.http === 403,
  );
  // qq.call 本身是 read 入口，内部按目标方法的风险档再校验（不在这次改动范围）
  assert.equal(list.find((m) => m.name === 'qq.call').scope, 'read');
});

test('scope：运维动作不需要 manage（暂停闸、插件启停与重载）', async () => {
  const { methods } = make();
  const list = methods.describe();
  for (const n of ['gate.set', 'plugin.enable', 'plugin.disable', 'plugin.reload']) {
    const hit = list.find((m) => m.name === n);
    assert.ok(hit, `${n} 应该在方法表里`);
    assert.equal(hit.scope, 'message', `${n} 是运维动作，应该是 message`);
  }
});
