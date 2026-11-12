/**
 * 宿主协议配置：写盘白名单与规范化
 * ================================
 *
 * `saveBotConfig` 是白名单式写盘，漏一个键的后果不是「少存一项」，
 * 而是「面板点了保存、重启全丢」——token 尤其致命（空 token 直接拒绝监听）。
 * 这份测试把 host 段的每个键都钉住，顺带复用 onebot-config.mjs 那条
 * 「两只鸟不能共享默认对象引用」的教训。
 *
 * 跑法：node --test test/host-config.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-host-config-'));
process.env.ROOST_HOME = home;

const { loadBotConfig, saveBotConfig } = await import('../src/config.js');

async function writeBot(id, extra = {}) {
  const dir = path.join(home, 'config', 'bots');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ name: id, appId: `app-${id}`, appSecret: 's', ...extra }, null, 2),
  );
}

test('旧配置没有 host 段时读成「默认关」，不报错也不共享引用', async () => {
  await writeBot('a');
  await writeBot('b');
  const a = await loadBotConfig('a');
  const b = await loadBotConfig('b');

  assert.equal(a.host.enabled, false);
  assert.equal(a.host.token, '');
  assert.equal(a.host.allowManage, false);
  assert.deepEqual(a.host.scopes, ['read', 'message']);
  assert.equal(a.host.port, 0);

  a.host.token = 'aaaa1111bbbb2222';
  a.host.scopes.push('manage');
  assert.equal(b.host.token, '', 'A 鸟填 token 不能跑到 B 鸟配置里');
  assert.deepEqual(b.host.scopes, ['read', 'message']);
});

test('保存后重读，host 段 11 个键一个都不能丢', async () => {
  await writeBot('c');
  const cfg = await loadBotConfig('c');
  Object.assign(cfg.host, {
    enabled: true,
    host: '127.0.0.1',
    port: 6801,
    token: 'cccc3333dddd4444',
    scopes: ['read', 'message', 'manage'],
    allowManage: true,
    forwardAll: false,
    allowRemote: false,
    maxConnections: 8,
    historyLimit: 150,
    historyTtlMs: 600_000,
  });
  await saveBotConfig('c', cfg);

  const raw = JSON.parse(await fs.readFile(path.join(home, 'config', 'bots', 'c.json'), 'utf8'));
  assert.equal(raw.host.token, 'cccc3333dddd4444', 'token 漏写 = 重启后外接功能自己关掉');
  assert.equal(raw.host.port, 6801);
  assert.deepEqual(raw.host.scopes, ['read', 'message', 'manage']);
  assert.equal(raw.host.allowManage, true);
  assert.equal(raw.host.forwardAll, false);
  assert.equal(raw.host.maxConnections, 8);
  assert.equal(raw.host.historyLimit, 150);
  assert.equal(raw.host.historyTtlMs, 600_000);

  const back = await loadBotConfig('c');
  assert.equal(back.host.enabled, true);
  assert.equal(back.host.token, 'cccc3333dddd4444');
});

test('脏值规范化：安全开关只认真布尔 true，越界数字被夹住', async () => {
  await writeBot('d');
  const cfg = await loadBotConfig('d');
  Object.assign(cfg.host, {
    enabled: 'yes',
    allowManage: 'false',   // 字符串 "false" 按真值判断会变成「开」
    allowRemote: 'false',
    scopes: ['manage', 'evil', 'read'],
    port: 99999,
    maxConnections: -3,
    historyLimit: 5000,
    historyTtlMs: 'oops',
  });
  await saveBotConfig('d', cfg);

  const raw = JSON.parse(await fs.readFile(path.join(home, 'config', 'bots', 'd.json'), 'utf8'));
  assert.equal(raw.host.allowManage, false, '管理总闸不能被字符串悄悄打开');
  assert.equal(raw.host.allowRemote, false);
  assert.equal(raw.host.enabled, false);
  assert.deepEqual(raw.host.scopes, ['manage', 'read'], '非法 scope 要滤掉');
  assert.equal(raw.host.port, 65535);
  assert.equal(raw.host.maxConnections, 1);
  assert.equal(raw.host.historyLimit, 1000);
  assert.equal(raw.host.historyTtlMs, 3_600_000);
});
