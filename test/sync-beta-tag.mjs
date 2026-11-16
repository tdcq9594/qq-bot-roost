// `beta` 标签对齐的版本比较。
//
// 这条规则只在一种情况下动手：**latest 比 beta 新**。判错的方向有两个，都很糟：
//   · 该动没动 → `npm i xxx@beta` 一直装着半年前的预发布版；
//   · 不该动动了 → 把正在测试的 `1.1.3-beta.1` 藏掉，用户拿不到测试版。
// 所以每个方向都要有反例。

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions } from '../scripts/sync-beta-tag.mjs';

const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

test('正式版比旧预发布高：要动（1.0.16-beta.1 → 1.1.2）', () => {
  assert.equal(sign(compareVersions('1.1.2', '1.0.16-beta.1')), 1);
});

test('预发布比正式版新：不动（1.1.3-beta.1 vs 1.1.2）', () => {
  assert.equal(sign(compareVersions('1.1.2', '1.1.3-beta.1')), -1);
});

test('同版本：不动', () => {
  assert.equal(compareVersions('1.1.2', '1.1.2'), 0);
});

test('同一 core 下，正式版比它的 rc 新', () => {
  assert.equal(sign(compareVersions('1.1.2', '1.1.2-rc.1')), 1);
  assert.equal(sign(compareVersions('1.1.2-rc.1', '1.1.2')), -1);
});

test('按数字比较，不是字典序（1.10.0 > 1.9.9）', () => {
  assert.equal(sign(compareVersions('1.10.0', '1.9.9')), 1);
  assert.equal(sign(compareVersions('1.1.10', '1.1.9')), 1);
});

test('0.x 也走同一套规则', () => {
  assert.equal(sign(compareVersions('0.13.0', '0.12.1')), 1);
  assert.equal(sign(compareVersions('0.9.11', '0.9.9')), 1);
});

test('认不出的版本按相等处理（宁可不改）', () => {
  assert.equal(compareVersions('latest', '1.1.2'), 0);
  assert.equal(compareVersions('', '1.1.2'), 0);
  assert.equal(compareVersions('1.1', '1.1.0'), 0);
  assert.equal(compareVersions('v1.1.2', '1.1.2'), 0, '带 v 前缀也认不出');
});
