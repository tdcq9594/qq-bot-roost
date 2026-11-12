/**
 * 消息段解析（出站）
 * ==================
 *
 * 只测纯函数：`parseOutgoing` 不碰网络、不碰官方接口，正好适合单测。
 * 重点是几条「会静默出错」的规则：@ 自己、未绑定、引用、语音、拆条。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOutgoing, MAX_PARTS } from '../src/onebot/segments.js';

/** 最小 ids 桩：真号映射表 */
function fakeIds({ users = {}, msgs = {} } = {}) {
  return {
    openidOfUser: (qq) => users[String(qq)] ?? '',
    getMessage: (id) => msgs[String(id)] ?? null,
  };
}

const ids = fakeIds({
  users: { 2014433751: 'U1', 10001: 'U2' },
  msgs: { 42: { m: 'official-1', i: 'REFIDX_1', c: 'G1', k: 'group' } },
});

test('文本 + @ + 引用 + 图片：拆成 text/reference/images', () => {
  const r = parseOutgoing(
    [
      { type: 'reply', data: { id: '42' } },
      { type: 'at', data: { qq: '2014433751' } },
      { type: 'text', data: { text: ' 看这个' } },
      { type: 'image', data: { file: 'https://x/1.png' } },
    ],
    { ids, selfUin: 1427835822 },
  );
  assert.equal(r.reference, 'REFIDX_1');
  assert.equal(r.text, '<@U1> 看这个');
  assert.deepEqual(r.images, [{ file: 'https://x/1.png' }]);
  assert.deepEqual(r.records, []);
});

test('@ 机器人自己：直接丢掉，不当文字发', () => {
  const r = parseOutgoing(
    [{ type: 'at', data: { qq: '1427835822' } }, { type: 'text', data: { text: '在吗' } }],
    { ids, selfUin: 1427835822 },
  );
  assert.equal(r.text, '在吗');
  assert.equal(r.warnings.length, 0);
});

test('@ 没绑定的人：降级成文字并给 warning，不整条失败', () => {
  const r = parseOutgoing(
    [{ type: 'at', data: { qq: '99999', name: '路人' } }, { type: 'text', data: { text: '你好' } }],
    { ids, selfUin: 1427835822 },
  );
  assert.equal(r.text, '@路人 你好');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /99999/);
});

test('引用找不到映射：给 warning，但不带 reference', () => {
  const r = parseOutgoing([{ type: 'reply', data: { id: '777' } }, { type: 'text', data: { text: 'x' } }], {
    ids,
    selfUin: 1,
  });
  assert.equal(r.reference, '');
  assert.match(r.warnings.join(), /引用失败/);
});

test('语音：收进 records（转码在 actions 里做）', () => {
  const r = parseOutgoing([{ type: 'record', data: { file: 'base64://AAA' } }], { ids, selfUin: 1 });
  assert.deepEqual(r.records, [{ file: 'base64://AAA' }]);
  assert.equal(r.text, '');
});

test('合并转发：官方只能收不能发 → 1404', () => {
  assert.throws(
    () => parseOutgoing([{ type: 'forward', data: { id: 'x' } }], { ids, selfUin: 1 }),
    (e) => e.retcode === 1404,
  );
});

test('文本里的 <@ 被中和，防止伪造 @', () => {
  const r = parseOutgoing([{ type: 'text', data: { text: '看 <@ABCDEF> 这个人' } }], { ids, selfUin: 1 });
  assert.equal(r.text, '看 ＜@ABCDEF> 这个人');
});

test('字符串消息按纯文本处理，CQ 码被剥掉', () => {
  const r = parseOutgoing('你好[CQ:at,qq=123]', { ids, selfUin: 1 });
  assert.equal(r.text, '你好');
});

test('face 段退化成文字（官方没有表情码）', () => {
  const r = parseOutgoing([{ type: 'face', data: { id: '178' } }], { ids, selfUin: 1 });
  assert.equal(r.text, '[表情]');
});

test('拆条上限常量是 5（群聊被动回复次数）', () => {
  assert.equal(MAX_PARTS, 5);
});
