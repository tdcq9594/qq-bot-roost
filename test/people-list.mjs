// `people.list`：把「最近说过话的人」交给宿主，给 AI 认人用。
//
// 为什么需要这条协议方法：官方 `getUserInfo` 要求**好友关系**（非好友回
// 40184001），而群里绝大多数人不是好友。只靠官方接口的话，「刚才那位是谁」
// 永远查不到——群成员的昵称、头像、群名片，只有他们自己说过话时才拿得到。
//
// 断言盯两件事：
//   1. 只出白名单字段（这是跨进程协议，`recentPeople` 里的内部字段不能漏出去）；
//   2. `limit` 要收口（宿主传 9999 不能让框架把整个索引都吐出来）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMethods } from '../src/host/methods.js';

const READ = new Set(['read']);

function makeMethods(people = []) {
  const calls = [];
  const m = createMethods({
    runtime: {
      id: 'people-bot',
      name: '测试鸟',
      state: 'online',
      online: true,
      cfg: { appId: '1024' },
      api: null,
      ledger: null,
      listRecentPeople: (n) => {
        calls.push(n);
        return people.slice(0, n);
      },
    },
    getState: () => ({ version: '0.0.0-test', seq: 1, connections: 1, counters: { ok: 0, fail: 0 } }),
  });
  return { m, calls };
}

test('people.list：给昵称、群名片、头像、QQ号，内部字段不出门', async () => {
  const { m } = makeMethods([
    {
      openid: 'O1',
      name: '群名片',
      card: '群名片',
      nickname: 'QQ名',
      avatar: 'https://qlogo/a.jpg',
      uin: '10001',
      unionOpenid: 'U1',
      scope: 'group',
      chatId: 'G1',
      at: 1700000000000,
      /** 内部索引里的东西，不该过协议 */
      secret: '别漏出去',
    },
  ]);

  const r = await m.call('people.list', {}, { scopes: READ });
  assert.equal(r.people.length, 1);
  assert.deepEqual(r.people[0], {
    openid: 'O1',
    name: '群名片',
    card: '群名片',
    nickname: 'QQ名',
    avatar: 'https://qlogo/a.jpg',
    uin: '10001',
    unionOpenid: 'U1',
    scope: 'group',
    at: 1700000000000,
  });
});

test('people.list：limit 收口在 1–200', async () => {
  const { m, calls } = makeMethods([]);
  await m.call('people.list', { limit: 9999 }, { scopes: READ });
  await m.call('people.list', { limit: -5 }, { scopes: READ });
  await m.call('people.list', {}, { scopes: READ });
  assert.deepEqual(calls, [200, 1, 200], '宿主写多少都不能越界');
});

test('people.list：空索引给空数组，不报错', async () => {
  const { m } = makeMethods([]);
  const r = await m.call('people.list', {}, { scopes: READ });
  assert.deepEqual(r.people, []);
});

test('people.list：缺字段的旧记录补成空串，不返回 undefined', async () => {
  const { m } = makeMethods([{ openid: 'O2' }]);
  const r = await m.call('people.list', {}, { scopes: READ });
  assert.equal(r.people[0].name, '');
  assert.equal(r.people[0].avatar, '');
  assert.equal(r.people[0].uin, '');
  assert.equal(r.people[0].at, 0);
});

test('people.list：没有 read scope 要拒', async () => {
  const { m } = makeMethods([]);
  await assert.rejects(() => m.call('people.list', {}, { scopes: new Set(['message']) }), /read/);
});
