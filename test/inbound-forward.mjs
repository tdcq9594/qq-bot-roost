/**
 * 官方重推不该重复触发协议层（2026-11-26）
 * ========================================
 *
 * 用户反馈：群里只发一句「你是谁」，模型一次执行请求里收到三条。
 *
 * QQ 官方明说「相同 msg_id 可能重复推送」；账本用 dedupe 唯一约束接住，
 * `ledger.append()` 返回 `duplicate: true`。但转发处以前不看这个标记，
 * 每次重推都 `host.onMessage()` 一次，dsh-roost 的合并窗口把它们拼成一批。
 *
 * 这里钉住三条边界：
 *   · 重推 → 不交协议层（本次修复）
 *   · 静默消息 → 仍按 `forwardSilentToProtocol` 走（issue #38，别回归）
 *   · 空消息 → 本来就不交（`hasMessageContent` 的既有口径）
 *
 * 跑法：node --test test/inbound-forward.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { isOfficialDuplicate, shouldForwardInbound } from '../src/host/inbound-forward.js';

/** 一条最普通的群消息：有内容、不静默、不是重推 */
const normal = { hasContent: true, silent: false, forwardSilent: true, duplicate: false };

test('正常消息：交给协议层', () => {
  assert.equal(shouldForwardInbound(normal), true);
});

test('官方重推（duplicate）：只留观测，不再交协议层', () => {
  assert.equal(shouldForwardInbound({ ...normal, duplicate: true }), false);
});

test('空消息：不交（纯空、无附件）', () => {
  assert.equal(shouldForwardInbound({ ...normal, hasContent: false }), false);
});

test('静默消息：默认仍交（forwardSilentToProtocol 默认 true）', () => {
  assert.equal(shouldForwardInbound({ ...normal, silent: true, forwardSilent: true }), true);
});

test('静默消息：用户关掉开关后不交（issue #38）', () => {
  assert.equal(shouldForwardInbound({ ...normal, silent: true, forwardSilent: false }), false);
});

test('缺省参数按「不交」处理，不抛错', () => {
  assert.equal(shouldForwardInbound(), false);
  assert.equal(shouldForwardInbound({}), false);
});

/* ---------- 只有官方 msg_id 才认重推（防指纹误杀） ---------- */

test('官方重推：有 msg_id 才认', () => {
  assert.equal(isOfficialDuplicate({ duplicate: true }, 'ROBOT1.0_abc'), true);
});

test('指纹型 duplicate（没有 msg_id）不算官方重推', () => {
  /**
   * 账本的 dedupe 在没有 msg_id 时退化成「会话+时间+正文」指纹，
   * 同一秒连发两句「在吗」会撞。那只是账本合并了一行，协议层不能吞——
   * 用户真的问了两遍，等的是两次回答。
   */
  assert.equal(isOfficialDuplicate({ duplicate: true }, ''), false);
  assert.equal(isOfficialDuplicate({ duplicate: true }, '   '), false);
  assert.equal(isOfficialDuplicate({ duplicate: true }, undefined), false);
});

test('非重推 / 账本没返回值：都不算', () => {
  assert.equal(isOfficialDuplicate({ duplicate: false }, 'ROBOT1.0_abc'), false);
  assert.equal(isOfficialDuplicate(null, 'ROBOT1.0_abc'), false);
  assert.equal(isOfficialDuplicate(undefined, 'ROBOT1.0_abc'), false);
});

/* ---------- 接线：纯函数写得再对，bot.js 没调也白搭 ---------- */

test('接线：bot.js 用 msg.id 判重推，并把结果交给 shouldForwardInbound', () => {
  const src = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  assert.ok(src.includes('isOfficialDuplicate(rec, msg.id)'), '重推判定必须带官方 msg.id');
  const at = src.indexOf('shouldForwardInbound({');
  assert.ok(at > 0, '广播处必须调用 shouldForwardInbound');
  assert.ok(src.slice(at, at + 400).includes('duplicate'), '调用时必须把 duplicate 传进去');
});

test('命中命令表的命令不交给协议层（否则模型会把它当聊天）', () => {
  /**
   * 2026-11-28 用户反馈：群里发 `/help 插件`，命令正常回了菜单，
   * 但同一句也被当成聊天喂给了 dsh-roost，还写进了记忆召回。
   * 判定在框架侧做——只有**命令表里真的有**这个名字才拦。
   */
  assert.equal(shouldForwardInbound({ hasContent: true, isCommand: true }), false);
  assert.equal(shouldForwardInbound({ hasContent: true, isCommand: false }), true);
});

test('接线：bot.js 只把「前缀开头且命令表命中」判成命令', () => {
  const src = readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  const at = src.indexOf('shouldForwardInbound({');
  assert.ok(at > 0);
  const block = src.slice(at, at + 700);
  assert.ok(block.includes('registry.commands.has(msg.command)'), '不能只按前缀判：`/xyz` 这类未知命令仍该当普通消息');
});
