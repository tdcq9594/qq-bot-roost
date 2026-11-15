/**
 * 体验白名单（测试用户 / 白名单群）
 * ================================
 *
 * 这两样在平台侧是**两个不同的 CGI**，而且请求体格式完全不同：
 *   · 测试用户 → `white_list/modify`，`set_friend_whitelist` + `friend_whitelist.white_ids`
 *   · 白名单群 → `dev_capability/modify`，`group_admin_action.add_group_ids/remove_group_ids`
 * 写错一个字段名，平台不会报「字段错」，只会回一句「系统繁忙」——所以这里
 * 把请求体逐字段钉死。
 *
 * 另外钉住三件「不能让用户白等」的事：
 *   1. 读的时候两种 `nick_name` 形态都要认；
 *   2. 号码格式在本机就拦，不发必然失败的请求；
 *   3. 白名单群上限 20（官方前端写死的数）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDevPlatform } from '../src/dev/platform.js';

const jsonRes = (data) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

/** 记录每次请求，按 path 决定回什么 */
function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({
      url: u,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null,
    });
    for (const [frag, payload] of Object.entries(routes)) {
      if (u.includes(frag)) return jsonRes(payload);
    }
    return jsonRes({ retcode: 0, data: {} });
  };
  impl.calls = calls;
  // 过滤掉登录校准用的 list_bots，只留被测请求
  impl.only = (frag) => calls.filter((c) => c.url.includes(frag));
  return impl;
}

test('读白名单：摊平群管规则、补群名、两种 nick_name 都认', async () => {
  const fetchImpl = fakeFetch({
    'scope_cfg/query': {
      retcode: 0,
      data: {
        friend_infos: [
          { uin: 10001, nick_name: '小明' },
          // 早期接口回的是对象，不能因为形态变了就整块读空
          { uin: '10002', nick_name: { nick: '小红' } },
          { uin: '' }, // 脏数据，丢掉
        ],
        group_admin_config: {
          // 同一个群出现在两条规则里：面板只该显示一次
          whitelist_groups: [
            { group_ids: [123456, 223456] },
            { group_ids: ['123456'] },
          ],
        },
        whitelist_groups_info: {
          123456: { group_name: '测试群一', in_group: true },
          223456: { group_name: '', in_group: false },
        },
      },
    },
  });

  const P = createDevPlatform({ fetchImpl });
  await P.loginImport('b-token=bt');
  const out = await P.getScope('102030');

  assert.deepEqual(out.users.map((u) => [u.uin, u.name]), [['10001', '小明'], ['10002', '小红']]);
  assert.deepEqual(out.groups.map((g) => g.groupId), ['123456', '223456'], '应当去重且保序');
  assert.equal(out.groups[0].name, '测试群一');
  assert.equal(out.groups[0].inGroup, true);
  // 不在群里时平台不给群名：不能编，也不能当失败
  assert.equal(out.groups[1].name, '');
  assert.equal(out.groups[1].inGroup, false);
  assert.equal(out.limits.groups, 20);

  // 只查白名单与群管配置：别把 scope_config / search_config 也拉回来
  const q = fetchImpl.only('scope_cfg/query')[0].body;
  assert.equal(q.bot_appid, 102030);
  assert.deepEqual(q.query_filter, {
    scope_config: 0, white_list: 1, search_config: 0, group_admin_config: 1,
  });
});

test('加测试用户：走 white_list/modify，字段名和动作值不能错', async () => {
  const fetchImpl = fakeFetch({});
  const P = createDevPlatform({ fetchImpl });
  await P.loginImport('b-token=bt');

  await P.setScope('102030', { kind: 'users', action: 1, ids: ['10001'] });
  let req = fetchImpl.only('white_list/modify')[0];
  assert.deepEqual(req.body, {
    bot_appid: 102030,
    whitelist_filter: { set_friend_whitelist: 1 },
    friend_whitelist: { white_ids: ['10001'] },
  });

  await P.setScope('102030', { kind: 'users', action: 2, ids: ['10001'] });
  req = fetchImpl.only('white_list/modify')[1];
  assert.equal(req.body.whitelist_filter.set_friend_whitelist, 2, '2 = 删除');
});

test('加白名单群：走 dev_capability/modify，加和删是两个字段', async () => {
  const fetchImpl = fakeFetch({});
  const P = createDevPlatform({ fetchImpl });
  await P.loginImport('b-token=bt');

  await P.setScope('102030', { kind: 'groups', action: 1, ids: ['123456'] });
  let req = fetchImpl.only('dev_capability/modify')[0];
  assert.deepEqual(req.body, {
    // 这个接口官方发的是字符串，别的接口是数字，别顺手「统一」
    bot_appid: '102030',
    set_dev_filter: { set_group_admin_config: 1 },
    group_admin_action: { add_group_ids: ['123456'], remove_group_ids: [] },
  });

  await P.setScope('102030', { kind: 'groups', action: 2, ids: ['123456'] });
  req = fetchImpl.only('dev_capability/modify')[1];
  assert.deepEqual(req.body.group_admin_action, { add_group_ids: [], remove_group_ids: ['123456'] });
});

test('号码格式在本机就拦，不发注定失败的请求', async () => {
  const fetchImpl = fakeFetch({});
  const P = createDevPlatform({ fetchImpl });
  await P.loginImport('b-token=bt');
  const before = fetchImpl.calls.length;

  await assert.rejects(
    () => P.setScope('102030', { kind: 'users', action: 1, ids: ['abc'] }),
    (e) => e.code === 'BAD_SCOPE' && /5~11/.test(e.message),
  );
  await assert.rejects(
    () => P.setScope('102030', { kind: 'users', action: 1, ids: ['123'] }),
    (e) => e.code === 'BAD_SCOPE',
  );
  await assert.rejects(
    () => P.setScope('102030', { kind: 'groups', action: 1, ids: ['12345678901'] }),
    (e) => e.code === 'BAD_SCOPE' && /5~10/.test(e.message),
  );
  await assert.rejects(
    () => P.setScope('102030', { kind: 'members', action: 1, ids: ['10001'] }),
    (e) => e.code === 'BAD_SCOPE' && /kind/.test(e.message),
  );
  await assert.rejects(
    () => P.setScope('102030', { kind: 'users', action: 9, ids: ['10001'] }),
    (e) => e.code === 'BAD_SCOPE',
  );
  await assert.rejects(
    () => P.setScope('102030', { kind: 'users', action: 1, ids: [] }),
    (e) => e.code === 'BAD_SCOPE',
  );

  assert.equal(fetchImpl.calls.length, before, '全被本机拦下，一次网络请求都不该发');
});

test('白名单群超过 20 个：本机拒掉，别等平台回「系统繁忙」', async () => {
  const P = createDevPlatform({ fetchImpl: fakeFetch({}) });
  await P.loginImport('b-token=bt');
  const many = Array.from({ length: 21 }, (_, i) => String(100000 + i));
  await assert.rejects(
    () => P.setScope('102030', { kind: 'groups', action: 1, ids: many }),
    (e) => e.code === 'BAD_SCOPE' && /20/.test(e.message),
  );
  // 删的时候不拦：平台自己不会因为「删到 0 个」而拒绝
  await P.setScope('102030', { kind: 'groups', action: 2, ids: many });
});

test('协议：白名单读对只读插件开放，写必须 message 档', async () => {
  const { createDevPlatform: make } = await import('../src/dev/platform.js');
  const P = make({ fetchImpl: fakeFetch({}) });
  const map = new Map(P.methods().map((m) => [m.name, m.scope]));
  assert.equal(map.get('scope.get'), 'read');
  assert.equal(map.get('scope.set'), 'message');
});
