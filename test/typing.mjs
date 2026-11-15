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
  /**
   * 2026-11-15：加频道能力时把「只挡 group」改成「只放行 c2c」。
   * 以前 guild / dm 会被折叠成 c2c 静默发到单聊接口，所以断言要跟着换成四态语义。
   */
  assert.ok(
    src.includes("const kind = p.kind === undefined ? 'c2c' : str(p.kind);")
    && src.includes("if (kind !== 'c2c') throw bad("),
    '非单聊（群聊 / 频道 / 私信）都要拒，不能静默当 c2c 发',
  );
  assert.ok(src.includes("R.api.sendC2C(chatId, { msgType: 6, content: '' })"), '直连 api');
  /** 不能走 sendOut：它不是消息，不该占额度/进账本 */
  const block = src.slice(src.indexOf("def('msg.typing'"), src.indexOf("def('msg.send'"));
  assert.equal(block.includes('sendOut('), false, 'msg.typing 不能走 sendOut');
});
