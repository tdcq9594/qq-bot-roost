/**
 * 5.13 单聊「正在输入」：msg_type=6 的报文与不占额度的边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { buildSendPayload } = await import(pathToFileURL('src/api.js').href);

test('报文：msg_type=6 + 空 content，不带 msg_id', () => {
  const p = buildSendPayload({ msgType: 6, content: '' });
  assert.equal(p.msg_type, 6);
  assert.equal(p.content, '');
  assert.equal(p.msg_id, undefined);
  assert.equal(p.msg_seq, undefined);
});

test('宿主方法：msg.typing 存在、群聊拒绝、直连 api 不走 outbound', () => {
  const src = readFileSync('src/host/methods.js', 'utf8');
  assert.ok(src.includes("def('msg.typing'"), '要注册 msg.typing');
  assert.ok(src.includes("if (p.kind === 'group') throw bad('群聊没有「正在输入」')"), '群聊要拒');
  assert.ok(src.includes("R.api.sendC2C(chatId, { msgType: 6, content: '' })"), '直连 api');
  /** 不能走 sendOut：它不是消息，不该占额度/进账本 */
  const block = src.slice(src.indexOf("def('msg.typing'"), src.indexOf("def('msg.send'"));
  assert.equal(block.includes('sendOut('), false, 'msg.typing 不能走 sendOut');
});
