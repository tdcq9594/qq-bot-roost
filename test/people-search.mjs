// 人物反查：查询词分类 + 筛选 + 排序。
//
// 这块最容易出错的是「三种输入怎么区分」：`10001` 是 QQ 号、`8C7419D4…` 是
// openid、「倦飞」是昵称。判错的后果不是报错，是**静默查不到**——所以每种
// 口径都要有正例和反例。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isUinQuery, isOpenidQuery, filterPeople, sortPeople } from '../src/people-search.js';

const PEOPLE = [
  { openid: '8C7419D4B8500528C2248E85360A719D', uin: '2014433751', name: '倦飞之鸟', card: '倦飞之鸟', nickname: '鸟', bound: true },
  { openid: '600E919B105C1BF86224B78CC17CEEE4', uin: '', name: 'f(t)*δ(t)', card: 'f(t)*δ(t)', nickname: '数学怪', bound: false },
  { openid: 'A1B2C3D4E5F60718293A4B5C6D7E8F90', uin: '10001', name: '小明', card: '群里的阿明', nickname: 'ming', note: '运营', bound: true },
];

test('isUinQuery：3~12 位纯数字才算号码', () => {
  assert.equal(isUinQuery('10001'), true);
  assert.equal(isUinQuery('2014433751'), true);
  assert.equal(isUinQuery('1234567890123'), false, '13 位不像 QQ 号');
  assert.equal(isUinQuery('8C7419D4'), false, '带字母不是');
  assert.equal(isUinQuery(''), false);
});

test('isOpenidQuery：16 位以上且含字母才算 openid', () => {
  assert.equal(isOpenidQuery('8C7419D4B8500528C2248E85360A719D'), true);
  assert.equal(isOpenidQuery('12345678901234567890'), false, '20 位纯数字更像时间戳，不是 openid');
  assert.equal(isOpenidQuery('10001'), false);
  assert.equal(isOpenidQuery(''), false);
});

test('按 openid 前缀查（粘一半也能找到）', () => {
  const hit = filterPeople(PEOPLE, '8C7419D4');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, '倦飞之鸟');
});

test('按 QQ 号前缀查', () => {
  const hit = filterPeople(PEOPLE, '2014');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].name, '倦飞之鸟');
});

test('按昵称模糊查：备注名 / 群名片 / QQ 昵称 / 备注都算', () => {
  assert.equal(filterPeople(PEOPLE, '倦飞').length, 1);
  assert.equal(filterPeople(PEOPLE, '阿明').length, 1, '群名片命中');
  assert.equal(filterPeople(PEOPLE, 'ming').length, 1, 'QQ 昵称命中');
  assert.equal(filterPeople(PEOPLE, '运营').length, 1, '备注命中');
  assert.equal(filterPeople(PEOPLE, '不存在的人').length, 0);
});

test('数字查询只按号码匹配，不会去撞昵称', () => {
  const fake = [...PEOPLE, { openid: 'F'.repeat(32), uin: '99999', name: '10001号选手', bound: false }];
  const hit = filterPeople(fake, '10001');
  assert.deepEqual(hit.map((p) => p.name), ['小明'], '昵称里带 10001 的那条不该混进来');
});

test('空查询返回全部（面板还没输字时不该是空的）', () => {
  assert.equal(filterPeople(PEOPLE, '').length, PEOPLE.length);
  assert.equal(filterPeople(PEOPLE, '   ').length, PEOPLE.length);
  assert.equal(filterPeople(null, 'x').length, 0, '拿不到数据也不炸');
});

test('排序：绑定过的排前面，其余按名字', () => {
  const sorted = sortPeople(PEOPLE);
  assert.equal(sorted[0].bound, true);
  assert.equal(sorted[1].bound, true);
  assert.equal(sorted[2].bound, false);
  /** 前两个都是绑定过的，按名字排：倦飞之鸟 vs 小明（zh 排序） */
  assert.ok(sorted.slice(0, 2).every((p) => p.bound));
});

test('排序不改原数组', () => {
  const before = PEOPLE.map((p) => p.name);
  sortPeople(PEOPLE);
  assert.deepEqual(PEOPLE.map((p) => p.name), before);
});
