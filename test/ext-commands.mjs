/**
 * 外接命令：权限判定与命令表
 * ==========================
 *
 * 这一版给「外接客户端 / 扩展在框架侧注册聊天命令」打底，盯三件事：
 *   1. 三档权限（ownerOnly / admin / globalAdmin）判定顺序与文案；
 *   2. 命令表能装下伪插件（`__dsh-roost` / `__ext:<id>`），卸载时整组清掉；
 *   3. 别名是隐藏命令——能直呼，但不在 `/help` 里占一行。
 *
 * 跑法：node --test test/ext-commands.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVEL } from '../src/roles.js';
import { commandDenyReason, needsPermissionCheck } from '../src/command-perm.js';
import { Registry } from '../src/plugin/context.js';
import { pluginAllowedIn } from '../src/bot.js';

// ---------------------------------------------------------------- 权限判定

test('普通命令不查权限', () => {
  assert.equal(needsPermissionCheck({}), false);
  assert.equal(needsPermissionCheck({ desc: 'x' }), false);
  assert.equal(commandDenyReason({}, { lv: 9999 }), '');
});

test('ownerOnly：主人放行，管理员也不行', () => {
  const e = { ownerOnly: true };
  assert.equal(commandDenyReason(e, { lv: LEVEL.owner }), '');
  assert.match(commandDenyReason(e, { lv: LEVEL.admin }), /只有机器人主人能用/);
  assert.match(commandDenyReason(e, { lv: LEVEL.manager }), /只有机器人主人能用/);
  assert.match(commandDenyReason(e, { lv: 9999 }), /只有机器人主人能用/);
});

test('admin：管理员与主人都放行，群管不行', () => {
  const e = { admin: true };
  assert.equal(commandDenyReason(e, { lv: LEVEL.owner }), '');
  assert.equal(commandDenyReason(e, { lv: LEVEL.admin }), '');
  assert.match(commandDenyReason(e, { lv: LEVEL.manager, prefix: '!' }), /需要管理员权限/);
  assert.match(commandDenyReason(e, { lv: LEVEL.manager, prefix: '!' }), /!admin me/);
});

test('ownerOnly 与 admin 同时声明时按更严的那档（不能放宽成管理员也行）', () => {
  const e = { ownerOnly: true, admin: true };
  assert.equal(commandDenyReason(e, { lv: LEVEL.owner }), '');
  assert.match(commandDenyReason(e, { lv: LEVEL.admin }), /只有机器人主人能用/);
});

test('globalAdmin：群管理员不够，全局管理员才放行', () => {
  const e = { globalAdmin: true, admin: true };
  assert.equal(commandDenyReason(e, { lv: LEVEL.admin, globalLv: LEVEL.admin }), '');
  assert.equal(commandDenyReason(e, { lv: LEVEL.admin, globalLv: LEVEL.owner }), '');
  assert.match(commandDenyReason(e, { lv: LEVEL.admin, globalLv: LEVEL.manager }), /全局管理员/);
});

test('globalAdmin 没查全局等级时（globalLv=null）不误伤', () => {
  assert.equal(commandDenyReason({ globalAdmin: true }, { lv: LEVEL.admin, globalLv: null }), '');
});

// ---------------------------------------------------------------- 命令表

test('伪插件命令能装进命令表，菜单按归属分组', () => {
  const r = new Registry();
  r.addCommand('__dsh-roost', 'model', { desc: '换模型', pattern: 'model', section: '指令', plugin: 'dsh-roost', admin: true }, () => {});
  r.addCommand('__ext:bili', 'bili', { desc: '投稿', pattern: 'bili', section: '扩展', plugin: 'B 站' }, () => {});

  assert.equal(r.commands.get('model').pluginId, '__dsh-roost');
  assert.equal(r.menus.get('__dsh-roost').title, 'dsh-roost');
  assert.equal(r.menus.get('__dsh-roost').sections[0].title, '指令');
  assert.equal(r.menus.get('__ext:bili').sections[0].title, '扩展');
});

test('别名注册成隐藏命令：能直呼，但不在菜单里多一行', () => {
  const r = new Registry();
  r.addCommand('__dsh-roost', 'model', { pattern: 'model', plugin: 'dsh-roost' }, () => {});
  r.addCommand('__dsh-roost', '模型', { pattern: '模型', plugin: 'dsh-roost', hidden: true }, () => {});

  assert.ok(r.commands.has('模型'), '别名必须能命中');
  const texts = r.menus.get('__dsh-roost').sections.flatMap((s) => s.items.map((i) => i.text));
  assert.deepEqual(texts, ['model']);
});

test('重名不覆盖：后注册的抛错，原来那条还在', () => {
  const r = new Registry();
  const first = () => 'first';
  r.addCommand('__dsh-roost', 'model', { pattern: 'model' }, first);
  assert.throws(() => r.addCommand('__ext:x', 'model', { pattern: 'model' }, () => 'x'), /已被插件/);
  assert.equal(r.commands.get('model').pluginId, '__dsh-roost');
  assert.equal(r.commands.get('model').handler, first);
});

test('clearPlugin 按伪插件整组摘命令（断线 / 扩展卸载）', () => {
  const r = new Registry();
  r.addCommand('__dsh-roost', 'model', { pattern: 'model' }, () => {});
  r.addCommand('__ext:bili', 'bili', { pattern: 'bili' }, () => {});
  r.clearPlugin('__ext:bili');
  assert.equal(r.commands.has('bili'), false);
  assert.equal(r.commands.has('model'), true, '别的伪插件不能被连坐');
  assert.equal(r.menus.has('__ext:bili'), false);
  r.clearPlugin('__dsh-roost');
  assert.equal(r.commands.size, 0);
});

test('菜单项带 ownerOnly 标记，/help 才知道要藏', () => {
  const r = new Registry();
  r.addCommand('__dsh-roost', 'reset', { pattern: 'reset', plugin: 'dsh-roost', ownerOnly: true }, () => {});
  const item = r.menus.get('__dsh-roost').sections[0].items[0];
  assert.equal(item.ownerOnly, true);
  assert.equal(item.admin, false);
});

// ---------------------------------------------------------------- 分群开关

test('伪插件命令不受分群「只启用列表里这些」影响', () => {
  const spec = { groups: { g1: { mode: 'include', list: ['ai-chat'] } } };
  assert.equal(pluginAllowedIn(spec, 'g1', '__dsh-roost'), true);
  assert.equal(pluginAllowedIn(spec, 'g1', '__ext:bili'), true);
  assert.equal(pluginAllowedIn(spec, 'g1', 'ai-chat'), true);
  assert.equal(pluginAllowedIn(spec, 'g1', 'other'), false, '普通插件仍按列表判');
});
