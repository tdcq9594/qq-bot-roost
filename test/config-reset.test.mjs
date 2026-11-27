// 恢复默认设置：纯函数 + 可注入 IO 的单测。
// 重点是「保留项真的保留、默认值真的重置、旧键真的清掉、坏一只不挡另一只」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESET_CONFIRM,
  resetGlobalKeeping,
  resetBotKeeping,
  resetFrameworkConfigs,
} from '../src/config-reset.js';
import { GLOBAL_DEFAULTS, BOT_DEFAULTS } from '../src/config.js';

test('全局恢复：保留面板密钥与监听地址/端口，其余回默认，旧键清掉', () => {
  const cur = {
    logLevel: 'debug',
    cooldownHint: false,
    webui: { accessKey: 'secret-key-123', host: '127.0.0.1', port: 15208, token: '' },
    someLegacyKey: 'should-be-gone',
  };
  const next = resetGlobalKeeping(cur);
  assert.equal(next.logLevel, GLOBAL_DEFAULTS.logLevel);
  assert.equal(next.cooldownHint, GLOBAL_DEFAULTS.cooldownHint);
  assert.equal(next.webui.accessKey, 'secret-key-123');
  assert.equal(next.webui.host, '127.0.0.1');
  assert.equal(next.webui.port, 15208);
  assert.equal(next.someLegacyKey, undefined, '遗留键必须删掉，合并语义清不掉它');
  assert.notEqual(next, cur, '不能就地改原配置');
});

test('全局恢复：老 webui.token 兼容搬成 accessKey', () => {
  const next = resetGlobalKeeping({ webui: { token: 'old-key-456' } });
  assert.equal(next.webui.accessKey, 'old-key-456');
});

test('单只鸟恢复：保留 appId/appSecret/owners，intents 与旧键回默认', () => {
  const cur = {
    id: 'wrong-id', name: '大肥鱼', enabled: false,
    appId: '123456', appSecret: 'app-secret-789', owners: ['openid-a'],
    intents: 0x7fffffff,
    legacyThing: 'gone',
  };
  const next = resetBotKeeping(cur, 'main');
  assert.equal(next.id, 'main');
  assert.equal(next.name, 'main', '名字是设置项，恢复默认后回落到 id');
  assert.equal(next.enabled, BOT_DEFAULTS.enabled);
  assert.equal(next.appId, '123456');
  assert.equal(next.appSecret, 'app-secret-789');
  assert.deepEqual(next.owners, ['openid-a']);
  assert.equal(next.intents, BOT_DEFAULTS.intents);
  assert.equal(next.legacyThing, undefined);
});

test('恢复默认值对象不被共享引用污染（BOT_DEFAULTS 里多处引用同一对象）', () => {
  const a = resetBotKeeping({}, 'a');
  a.owners.push('mutated');
  const b = resetBotKeeping({}, 'b');
  assert.deepEqual(b.owners, BOT_DEFAULTS.owners, '改 a 不能改到默认值或 b');
  assert.deepEqual(BOT_DEFAULTS.owners, []);
});

test('执行恢复：没有确认词直接拒绝，一次写都不发生', async () => {
  const calls = [];
  const io = {
    listBots: async () => ['main'],
    readGlobal: async () => ({}),
    readBot: async () => ({}),
    saveGlobal: async (c) => calls.push(['global', c]),
    saveBot: async (id, c) => calls.push([id, c]),
  };
  const r = await resetFrameworkConfigs({ confirm: 'yes', io });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'confirm');
  assert.equal(calls.length, 0);
});

test('执行恢复：逐只鸟 + 全局都写；坏一只不挡另一只，错误如实回', async () => {
  const saved = [];
  const io = {
    listBots: async () => ['main', 'broken', 'other'],
    readGlobal: async () => ({ logLevel: 'debug' }),
    readBot: async (id) => ({ appId: id, appSecret: `s-${id}`, owners: [`o-${id}`] }),
    saveGlobal: async (c) => saved.push(['global', c]),
    saveBot: async (id, c) => {
      if (id === 'broken') throw new Error('磁盘只读');
      saved.push([id, c]);
    },
  };
  const r = await resetFrameworkConfigs({ confirm: RESET_CONFIRM, io });
  assert.equal(r.ok, false, '有一只失败就不能报全绿');
  assert.deepEqual(r.bots, ['main', 'other']);
  assert.match(r.errors.join(' '), /broken.*磁盘只读/);
  assert.equal(saved.find(([k]) => k === 'global')[1].logLevel, GLOBAL_DEFAULTS.logLevel);
  assert.equal(saved.find(([k]) => k === 'main')[1].appSecret, 's-main', '凭证要保住');
  assert.equal(saved.find(([k]) => k === 'other')[1].appId, 'other');
});

test('执行恢复：全成功时 ok:true 且消息说清保留了什么', async () => {
  const io = {
    listBots: async () => ['main'],
    readGlobal: async () => ({}),
    readBot: async () => ({}),
    saveGlobal: async () => {},
    saveBot: async () => {},
  };
  const r = await resetFrameworkConfigs({ confirm: RESET_CONFIRM, io });
  assert.equal(r.ok, true);
  assert.match(r.message, /凭证与主人保留/);
});
