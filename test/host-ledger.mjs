// 宿主协议：`ledger.search` / `ledger.around`。
//
// 这是模型唯一能碰历史消息的入口，所以三件事必须钉死：
//   1. **参数白名单化**（terms ≤ 8、openids ≤ 20、limit ≤ 200）——不封顶就是
//      一条指令把整个库拉过去；
//   2. **纯疑问词不能退化成「无条件」**——面板上踩过：搜「什么」返回最新 50 条；
//   3. **around 要先按 seq 定位会话**，否则 timeline 根本不知道去哪儿取邻文。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMethods } from '../src/host/methods.js';

const READ = new Set(['read']);

function make() {
  const calls = [];
  const ledger = {
    search(args) {
      calls.push({ type: 'search', args });
      /** AND 没结果、OR 才给一条：模拟「多个词没有同时命中」 */
      return args.mode === 'or'
        ? [{ seq: 9, userId: 'U1', chatId: 'G1', kind: 'group', content: '杭州下雨了', at: 1, userName: '小明' }]
        : [];
    },
    bySeq(seq) {
      return Number(seq) === 5
        ? { seq: 5, chatId: 'G1', kind: 'group', userId: 'U1', at: 1700000000000 }
        : null;
    },
    timeline({ chatId, anchorSeq, before, after }) {
      calls.push({ type: 'timeline', chatId, anchorSeq, before, after });
      return [{ seq: 4 }, { seq: 5, hit: true }, { seq: 6 }];
    },
  };
  const m = createMethods({
    runtime: {
      id: 'b1',
      name: '测试鸟',
      state: 'online',
      cfg: { appId: '1024' },
      api: null,
      ledger,
      groupName: () => '测试群',
      /** QQ 号反查只认 10001 */
      identity: { openidOf: (_botId, uin) => (String(uin) === '10001' ? 'OP1' : '') },
    },
    getState: () => ({ version: '0.0.0-test', seq: 1, connections: 1, counters: { ok: 0, fail: 0 } }),
  });
  return { m, calls };
}

test('ledger.search：一整句会被拆成关键词，AND 没结果时自动放宽为 OR', async () => {
  const { m, calls } = make();
  const r = await m.call('ledger.search', { q: '杭州 怎么 天气' }, { scopes: READ });

  const first = calls.find((c) => c.type === 'search');
  assert.deepEqual(first.args.terms, ['杭州', '天气'], '疑问词「怎么」要剥掉');
  assert.equal(first.args.mode, 'and');
  assert.equal(calls.filter((c) => c.type === 'search').length, 2, '空结果后要再跑一次 OR');
  assert.equal(r.relaxed, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].openid, 'U1');
  assert.equal(r.items[0].chatName, '测试群', '群聊要带群名');
});

test('ledger.search：纯疑问词给空列表 + 说明，不去扫全库', async () => {
  const { m, calls } = make();
  const r = await m.call('ledger.search', { q: '什么' }, { scopes: READ });
  assert.deepEqual(r.items, []);
  assert.match(r.note, /没有可检索/);
  assert.equal(calls.length, 0, '一条 SQL 都不该发');
});

test('ledger.search：person 给 QQ 号时反查成 openid', async () => {
  const { m, calls } = make();
  await m.call('ledger.search', { person: '10001' }, { scopes: READ });
  const a = calls.find((c) => c.type === 'search').args;
  assert.deepEqual(a.openids, ['OP1']);
  assert.equal(a.name, '', '反查到了就别再按昵称撞');
});

test('ledger.search：person 给没绑过的号码时退回昵称', async () => {
  const { m, calls } = make();
  await m.call('ledger.search', { person: '99999' }, { scopes: READ });
  const a = calls.find((c) => c.type === 'search').args;
  assert.deepEqual(a.openids, []);
  assert.equal(a.name, '99999');
});

test('ledger.search：参数封顶（terms 8 / openids 20 / limit 200）', async () => {
  const { m, calls } = make();
  await m.call('ledger.search', {
    terms: Array.from({ length: 12 }, (_, i) => `t${i}`),
    openids: Array.from({ length: 30 }, (_, i) => `O${i}`),
    limit: 9999,
  }, { scopes: READ });
  const a = calls.find((c) => c.type === 'search').args;
  assert.equal(a.terms.length, 8);
  assert.equal(a.openids.length, 20);
  assert.equal(a.limit, 200);
});

test('ledger.around：按 seq 定位会话后取前后文，并把 anchor 带回去', async () => {
  const { m, calls } = make();
  const r = await m.call('ledger.around', { seq: 5, before: 2, after: 4 }, { scopes: READ });

  const tl = calls.find((c) => c.type === 'timeline');
  assert.equal(tl.chatId, 'G1', '必须先按 seq 找到 chatId');
  assert.equal(tl.anchorSeq, 5);
  assert.equal(tl.before, 2);
  assert.equal(tl.after, 4);
  assert.equal(r.anchor.userId, 'U1', '宿主靠它判「非特权是不是在翻别人的对话」');
  assert.equal(r.items.length, 3);
});

test('ledger.around：seq 不存在要明说，不要给一个空上下文', async () => {
  const { m } = make();
  await assert.rejects(() => m.call('ledger.around', { seq: 404 }, { scopes: READ }), /没有 seq/);
});

test('ledger.around：before/after 有上限（20）', async () => {
  const { m, calls } = make();
  await m.call('ledger.around', { seq: 5, before: 99, after: -3 }, { scopes: READ });
  const tl = calls.find((c) => c.type === 'timeline');
  assert.equal(tl.before, 20);
  assert.equal(tl.after, 3, '负数退回默认 3');
});

test('两个方法都要 read scope', async () => {
  const { m } = make();
  await assert.rejects(() => m.call('ledger.search', { q: 'x' }, { scopes: new Set(['message']) }), /read/);
  await assert.rejects(() => m.call('ledger.around', { seq: 5 }, { scopes: new Set(['message']) }), /read/);
});
