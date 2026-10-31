/**
 * 链路 id 的单测
 * ==============
 *
 * 这一层错了不会报错，只会「日志里查不到」——所以只能靠断言钉住格式与透传。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { newTraceId, traceTag } from '../src/trace.js';
import { serializeMessage } from '../src/plugin/protocol.js';

test('traceId：短、可 grep、同毫秒不重', () => {
  const a = newTraceId();
  const b = newTraceId();
  assert.match(a, /^[0-9a-z]+$/);
  assert.ok(a.length >= 10 && a.length <= 20, `长度不对：${a.length}`);
  assert.notEqual(a, b);
});

test('traceTag：有 id 才有前缀，空值不留一串空括号', () => {
  assert.equal(traceTag('abc'), '[trace:abc]');
  assert.equal(traceTag(''), '');
  assert.equal(traceTag(null), '');
});

test('serializeMessage：外部插件也能拿到 trace', () => {
  const s = serializeMessage({ id: 'm1', traceId: 't-1', content: 'hi' });
  assert.equal(s.trace, 't-1');
  // 老消息没有 traceId 时给空串，不能是 undefined（外部插件会拼进 JSON）
  assert.equal(serializeMessage({ id: 'm2' }).trace, '');
});
