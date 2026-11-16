// 查询页：词法拆分 + 账本检索。
//
// 词法参考 dsh-roost 的 `src/tokenize.js`：中文没有空格，整串匹配等于搜不到
// （「魂骨怎么获得」原文里不会这么连着出现），所以查询侧要把疑问/语气词换成
// 空格断成几个关键词。**只动查询侧，不改库里原文。**
//
// 检索部分盯三件事：
//   1. 多词默认 AND（全中），显式 or 才放宽；
//   2. 发言人三种输入（openid / QQ 号已由上层解析成 openid / 昵称模糊）都对；
//   3. LIKE 的 `%` `_` 要转义，否则用户搜「100%」等于搜全库。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { splitQuery } from '../src/search-query.js';
import { createLedger } from '../src/ledger.js';

/* ---------------- 词法 ---------------- */

test('splitQuery：剥掉疑问词，长句断成关键词', () => {
  assert.deepEqual(splitQuery('魂骨怎么获得'), ['魂骨', '获得']);
  assert.deepEqual(splitQuery('他什么时候说的那句话'), ['他', '说的那句话'].filter((x) => x.length >= 2));
});

test('splitQuery：空格 / 中英文标点都当断点', () => {
  assert.deepEqual(splitQuery('杭州 天气'), ['杭州', '天气']);
  assert.deepEqual(splitQuery('杭州，天气。'), ['杭州', '天气']);
  assert.deepEqual(splitQuery('杭州,天气;雾'), ['杭州', '天气', '雾'].filter((x) => x.length >= 2));
});

test('splitQuery：去重、保序、限个数', () => {
  assert.deepEqual(splitQuery('杭州 杭州 天气'), ['杭州', '天气']);
  const many = splitQuery('一甲 一乙 一丙 一丁 一戊 一己 一庚 一辛');
  assert.equal(many.length, 6, '最多 6 个词，SQL 参数别无限膨胀');
});

test('splitQuery：单字丢掉（搜「我」等于搜全库）', () => {
  assert.deepEqual(splitQuery('我 爱 编程'), ['编程']);
});

test('splitQuery：英文与数字保留', () => {
  assert.deepEqual(splitQuery('gpt 4o'), ['gpt', '4o']);
});

test('splitQuery：空输入给空数组', () => {
  assert.deepEqual(splitQuery(''), []);
  assert.deepEqual(splitQuery('   '), []);
  assert.deepEqual(splitQuery(null), []);
});

/* ---------------- 检索 ---------------- */

function makeLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-ls-'));
  const l = createLedger({ file: path.join(dir, 'events.db'), botId: 'main', retentionDays: 0 });
  l.open();
  return l;
}

/**
 * 入账时间由 `resolveTime(msg.raw, ...)` 从**原始报文的 timestamp** 解析，
 * 不是 `msg.at`——`raw` 里没有 timestamp 时一律按「本地收到时间」记，
 * 那几条测试数据的时间就全成了「现在」，`since` 过滤也就测不出来了。
 */
const row = (over) => {
  const at = over.at ?? 1700000000000;
  return {
    kind: 'group',
    chatId: 'G1',
    userId: 'U1',
    userName: '倦飞之鸟',
    content: '',
    at,
    raw: { timestamp: String(at) },
    ...over,
  };
};

async function seed(l) {
  await l.append(row({ id: 'a1', content: '魂骨怎么获得啊', at: 1700000000001 }));
  await l.append(row({ id: 'a2', content: '今天杭州的天气不错', at: 1700000000002, userId: 'U2', userName: '小明' }));
  await l.append(row({ id: 'a3', content: '杭州下雨了，魂骨的事明天说', at: 1700000000003, userId: 'U3', userName: '小红' }));
  await l.append(row({ id: 'a4', content: '私聊一句话', kind: 'c2c', chatId: 'C9', userId: 'U9', userName: '小刚', at: 1700000000004 }));
  await l.append(row({ id: 'a5', content: '折扣 100% 全免', at: 1700000000005 }));
}

test('search：多词默认 AND（全中）', async () => {
  const l = makeLedger();
  await seed(l);
  const rows = l.search({ terms: ['杭州', '魂骨'] });
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /杭州下雨了/);
  l.close?.();
});

test('search：mode=or 放宽到任一命中', async () => {
  const l = makeLedger();
  await seed(l);
  const rows = l.search({ terms: ['杭州', '魂骨'], mode: 'or' });
  assert.equal(rows.length, 3, '两条各含一个词，还有一条两个都含');
  l.close?.();
});

test('search：按 openid 精确筛发言人', async () => {
  const l = makeLedger();
  await seed(l);
  const rows = l.search({ openids: ['U2'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userName, '小明');
  l.close?.();
});

test('search：按昵称模糊筛发言人', async () => {
  const l = makeLedger();
  await seed(l);
  const rows = l.search({ name: '小' });
  assert.equal(rows.length, 3, '小明 + 小红 + 小刚');
  l.close?.();
});

test('search：kind / since / chatId 三个维度能叠', async () => {
  const l = makeLedger();
  await seed(l);

  assert.equal(l.search({ kind: 'c2c' }).length, 1);
  assert.equal(l.search({ chatId: 'G1', since: 1700000000002 }).length, 3);
  assert.equal(l.search({ kind: 'group', name: '小' }).length, 2);
  l.close?.();
});

test('search：LIKE 的 % 要转义，不能变成通配', async () => {
  const l = makeLedger();
  await seed(l);
  const rows = l.search({ terms: ['100%'] });
  assert.equal(rows.length, 1);
  assert.match(rows[0].content, /100%/);
  l.close?.();
});

test('search：结果按时间倒序，beforeSeq 往后翻页', async () => {
  const l = makeLedger();
  await seed(l);
  const all = l.search({});
  assert.equal(all.length, 5);
  assert.ok(all[0].at >= all[1].at, '最新在前');

  const older = l.search({ beforeSeq: all[0].seq });
  assert.equal(older.length, 4, '游标之前的记录');
  l.close?.();
});

test('search：带 withPeople 时返回昵称/群名片/头像', async () => {
  const l = makeLedger();
  await l.append(row({
    id: 'p1',
    content: '带头像的一条',
    raw: { author: { username: 'QQ名', member_nickname: '群名片', avatar: 'https://x/a.jpg' } },
  }));
  const [r] = l.search({ terms: ['带头像'] });
  assert.equal(r.card, '群名片');
  assert.equal(r.nickname, 'QQ名');
  assert.equal(r.avatar, 'https://x/a.jpg');
  l.close?.();
});

/**
 * 整句都是疑问词 → 拆完是空数组。
 *
 * 调用方（面板接口 / 宿主 `ledger.search`）必须把「q 非空但 terms 空」当成
 * **没给关键词**处理并直接返回空，否则 SQL 里只剩 `bot_id = ?`，搜「什么」
 * 会返回最新 50 条——用户看到的就是「搜什么出来一堆无关内容」。
 */
test('splitQuery：纯疑问词返回空数组', () => {
  assert.deepEqual(splitQuery('什么'), []);
  assert.deepEqual(splitQuery('为什么'), []);
  assert.deepEqual(splitQuery('吗'), []);
  assert.deepEqual(splitQuery('什么 怎么 为什么'), []);
});
