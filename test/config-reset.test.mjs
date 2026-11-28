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

test('全局恢复：Gitee 令牌与整套 SMTP 配置保留，只有开关回默认（P1 回归）', () => {
  const cur = {
    network: { giteeToken: 'gitee-secret', mirror: 'gitee' },
    notifications: {
      smtp: {
        pass: 'smtp-app-pass', user: 'me@example.com', host: 'smtp.example.com',
        port: 465, security: 'tls', from: 'me@example.com', fromName: '我',
        enabled: true, dailyLimit: 99,
      },
    },
  };
  const next = resetGlobalKeeping(cur);
  assert.equal(next.network.giteeToken, 'gitee-secret', 'Gitee 令牌丢了没法自己补');
  const s = next.notifications.smtp;
  // checkConfig() 要 host / port / from 齐全；认证要 user + pass——缺一邮件就发不出去
  assert.equal(s.pass, 'smtp-app-pass');
  assert.equal(s.user, 'me@example.com');
  assert.equal(s.host, 'smtp.example.com');
  assert.equal(s.port, 465);
  assert.equal(s.from, 'me@example.com');
  assert.equal(s.enabled, GLOBAL_DEFAULTS.notifications.smtp.enabled, '开关本身仍该回默认');
  assert.equal(s.dailyLimit, GLOBAL_DEFAULTS.notifications.smtp.dailyLimit, '高级项回默认');
  assert.equal(s.smtpPass, undefined, '旧版遗留键不能跟着整段搬回来');
  assert.equal(s.password, undefined);
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

test('单只鸟恢复：OneBot / 宿主协议令牌保留，端口与开关回默认（P1 回归）', () => {
  const cur = {
    id: 'main',
    appId: '1', appSecret: 's', owners: ['o'],
    onebot: { token: 'onebot-secret', port: 6700, enabled: true },
    host: { token: 'host-secret', port: 6807, enabled: true },
  };
  const next = resetBotKeeping(cur, 'main');
  assert.equal(next.onebot.token, 'onebot-secret');
  assert.equal(next.host.token, 'host-secret');
  assert.equal(next.onebot.port, BOT_DEFAULTS.onebot.port, '端口是设置项，回默认');
  assert.equal(next.host.enabled, BOT_DEFAULTS.host.enabled, '协议开关是设置项，回默认');
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
  assert.match(r.message, /QQ 凭证、主人、面板密钥与 Gitee \/ SMTP \/ 外接协议令牌均已保留/);
});

test('执行恢复：端到端把五类凭证都保住，文案与行为一致（P1 回归）', async () => {
  const saved = { bot: null, global: null };
  const io = {
    listBots: async () => ['main'],
    readBot: async () => ({
      id: 'main', appId: 'app', appSecret: 'secret', owners: ['o'],
      onebot: { token: 'onebot-t', port: 6700 }, host: { token: 'host-t', port: 6807 },
    }),
    readGlobal: async () => ({
      webui: { accessKey: 'panel-key' },
      network: { giteeToken: 'gitee-t' },
      notifications: { smtp: { pass: 'smtp-t', user: 'u@x.com', host: 'smtp.x.com', from: 'u@x.com', port: 465 } },
    }),
    saveBot: async (_, cfg) => { saved.bot = cfg; },
    saveGlobal: async (cfg) => { saved.global = cfg; },
  };
  const r = await resetFrameworkConfigs({ confirm: RESET_CONFIRM, io });
  assert.equal(r.ok, true);
  assert.equal(saved.bot.onebot.token, 'onebot-t');
  assert.equal(saved.bot.host.token, 'host-t');
  assert.equal(saved.global.network.giteeToken, 'gitee-t');
  assert.equal(saved.global.notifications.smtp.pass, 'smtp-t');
  assert.equal(saved.global.notifications.smtp.user, 'u@x.com');
  assert.equal(saved.global.notifications.smtp.host, 'smtp.x.com');
  assert.equal(saved.global.webui.accessKey, 'panel-key');
  assert.match(r.message, /令牌均已保留/);
});
