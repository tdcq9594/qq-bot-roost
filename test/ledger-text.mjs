/**
 * 入账清洗（`src/ledger-text.js`）。
 *
 * 这一层改的是**写进库里的正文**，错了就把原始记录改掉了，所以每条规则
 * 都要钉死；同时要锁住「不认识的东西一个字符都不动」——用户聊代码、
 * 聊 HTML 打出来的尖括号，被清掉就是数据损坏。
 *
 * 跑法：node --test test/ledger-text.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ledgerTextOf, placeholderOf } from '../src/ledger-text.js';

/** 造一个真实形状的表情标记：ext 是 base64 的 `{"text":"憨笑"}` */
function face(text, type = 1, id = '187') {
  const ext = Buffer.from(JSON.stringify({ text }), 'utf8').toString('base64');
  return `<faceType=${type},faceId="${id}",ext="${ext}">`;
}

test('表情：能解出 ext 的名字就用名字', () => {
  assert.equal(ledgerTextOf(`你好${face('憨笑')}`), '你好[表情:憨笑]');
});

test('表情：ext 解不出来退成 [表情]，不能把整条判空', () => {
  assert.equal(ledgerTextOf('<faceType=4,faceId="",ext="">'), '[表情]');
  assert.equal(ledgerTextOf('<faceType=1,faceId="187">'), '[表情]');
});

test('菜单按钮：show 优先、百分号解码', () => {
  assert.equal(
    ledgerTextOf('<qqbot-cmd-input text="%2Fping" show="%2Fping" />'),
    '/ping',
  );
  /** 只有 text 时用 text，同样要解码（`%20` 是空格） */
  assert.equal(ledgerTextOf('<qqbot-cmd-input text="%2Fhelp%20dice" />'), '/help dice');
  assert.equal(ledgerTextOf('<qqbot-cmd-enter text="%2Fping" />'), '/ping');
});

test('at 某人：报文里只有 openid，标个 @ 就够', () => {
  assert.equal(
    ledgerTextOf('<qqbot-at-user id="CBF1E6B3B90D3ACD7DEBC5A9F2FC7BB5" /> 在吗'),
    '@ 在吗',
  );
});

test('markdown 图片：换成 [图片:说明]，尺寸位剥掉', () => {
  assert.equal(
    ledgerTextOf('抽到了！\n![卡面 #480px #240px](qqbot-media://image/v1/abc)\n再来一次？'),
    '抽到了！\n[图片:卡面]\n再来一次？',
  );
  assert.equal(ledgerTextOf('![](/abs/path/x.png)'), '[图片]');
});

test('用户自己打的尖括号一律不动', () => {
  const raw = '这段代码里 <ID> 和 <case> 是占位符，<div> 也是';
  assert.equal(ledgerTextOf(raw), raw);
});

test('没有已知标记时**一个字符都不变**（含首尾空白的取舍）', () => {
  /** 只 trim 两端：中间换行是正文结构，不能动 */
  assert.equal(ledgerTextOf('  第一行\n第二行  '), '第一行\n第二行');
  assert.equal(ledgerTextOf(''), '');
  assert.equal(ledgerTextOf(null), '');
});

test('一条消息里多种标记混排', () => {
  const raw = `${face('惊讶')}<qqbot-cmd-input text="%2Fping" show="%2Fping" /> 试试`;
  assert.equal(ledgerTextOf(raw), '[表情:惊讶]/ping 试试');
});

test('placeholderOf：纯媒体消息给占位，别在账本里留空白行', () => {
  assert.equal(placeholderOf({ attachments: [{ type: 'image', url: 'x' }] }), '[图片]');
  assert.equal(placeholderOf({ attachments: [{ type: 'voice' }] }), '[语音]');
  assert.equal(placeholderOf({ attachments: [{ type: 'voice', asrText: '今天下雨' }] }), '[语音:今天下雨]');
  assert.equal(placeholderOf({ attachments: [{ type: 'file', filename: '合同.pdf' }] }), '[文件:合同.pdf]');
  assert.equal(placeholderOf({ attachments: [{ type: 'other' }] }), '[表情]');
  assert.equal(placeholderOf({ ark: { title: '哔哩哔哩' } }), '[卡片:哔哩哔哩]');
  assert.equal(placeholderOf({ elements: [{}, {}] }), '[合并转发]');
  /** 什么都没有就是空串——调用方据此判断「真的没内容」 */
  assert.equal(placeholderOf({}), '');
});
