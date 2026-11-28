/**
 * 已认领收口：中间件抛错时若已 reply 过就不再往下走（防双发）
 *
 * 背景：pipeline.js 的 catch 原本无条件 dispatch(idx+1)，即使该中间件
 * 已经 reply 过（消息被认领），出错后还会让下游/模型再产出一个回复。
 * 对照 V2 的 `if (hasSent(session)) return` 收口机制。
 *
 * 本测试覆盖方案里的 6 条用例，含变异验证所需的断言（删掉实现后必须变红）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.js';

/** 造一条"已回复过"的上下文 */
const repliedCtx = (extra = {}) => ({ msg: { id: 'm1', replied: true, ...extra } });
const freshCtx = (extra = {}) => ({ msg: { id: 'm2', replied: false, ...extra } });

test('① 中间件 reply 后抛错：下一中间件与命令 handler 均未被调用', async () => {
  const p = new Pipeline();
  let reached = false;
  p.use('first', async (ctx) => {
    ctx.msg.replied = true; // 模拟这条消息已经 reply 过
    throw new Error('boom');
  });
  p.use('second', async (_ctx, next) => {
    reached = true;
    await next();
  });
  const passed = await p.run(repliedCtx());
  assert.equal(reached, false, '下游中间件不应被调用');
  assert.equal(passed, false, '已认领的消息应返回 halted');
});

test('② 收口时 pipeline.run 返回 false（拦下）', async () => {
  const p = new Pipeline();
  p.use('first', async () => {
    throw new Error('boom');
  });
  const passed = await p.run(repliedCtx());
  assert.equal(passed, false);
});

test('③ 中间件抛错但未 reply：仍继续往下走（回归保护）', async () => {
  const p = new Pipeline();
  let reached = false;
  p.use('first', async () => {
    throw new Error('boom');
  });
  p.use('second', async (_ctx, next) => {
    reached = true;
    await next();
  });
  const passed = await p.run(freshCtx());
  assert.equal(reached, true, '未认领的消息应继续');
  assert.equal(passed, true);
});

test('④ HALT 主动拦截：不打 error、不算错误、不再继续', async () => {
  const p = new Pipeline({ metrics: { bump: () => { throw new Error('不该计数'); } } });
  let reached = false;
  p.use('block', async (ctx) => {
    ctx.halt('dedup');
  });
  p.use('after', async () => {
    reached = true;
  });
  const passed = await p.run(repliedCtx());
  assert.equal(reached, false);
  assert.equal(passed, false);
});

test('⑤ stopIfReplied:false 回退到旧行为（兼容开关）', async () => {
  const p = new Pipeline({ stopIfReplied: false });
  let reached = false;
  p.use('first', async () => {
    throw new Error('boom');
  });
  p.use('second', async (_ctx, next) => {
    reached = true;
    await next();
  });
  const passed = await p.run(repliedCtx());
  assert.equal(reached, true, '关闭收口后应恢复旧行为');
  assert.equal(passed, true);
});

test('⑥ 正常路径不受影响：无抛错时 replied 消息照常放行', async () => {
  const p = new Pipeline();
  let reached = false;
  p.use('ok', async (_ctx, next) => {
    await next();
  });
  p.use('tail', async (_ctx, next) => {
    reached = true;
    await next();
  });
  const passed = await p.run(repliedCtx());
  assert.equal(reached, true);
  assert.equal(passed, true);
});
