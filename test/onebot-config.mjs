/**
 * 配置深合并：默认值不能共享引用
 * ================================
 *
 * 这条守的是一个很隐蔽的 bug：`deepMerge` 以前 `{...base}`，`extra` 里没有的键
 * 直接沿用默认值对象的**同一份引用**。于是所有机器人共享一个 `onebot` 对象：
 * 在 A 鸟的兼容页填 token，B 鸟保存任何设置时会把 A 的 token 写进 B 的配置。
 *
 * 用户看到的是「另一只鸟莫名开始监听、还用着别人的 token」，谁也不会往
 * 「配置串号」上想。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-config-'));
process.env.ROOST_HOME = home;

const { loadBotConfig, saveBotConfig } = await import('../src/config.js');

/** 造一个最小机器人配置（只有 id，其余全走默认值） */
async function writeBot(id, extra = {}) {
  const dir = path.join(home, 'config', 'bots');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify({ name: id, appId: `app-${id}`, appSecret: 's', ...extra }, null, 2),
  );
}

test('两只鸟的 onebot 默认值互不影响', async () => {
  await writeBot('a');
  await writeBot('b');

  const a = await loadBotConfig('a');
  const b = await loadBotConfig('b');

  assert.equal(a.onebot.token, '');
  assert.equal(b.onebot.token, '');

  // 模拟面板在 A 鸟上填 token（原地改写 cfg.onebot）
  a.onebot.token = 'aaaa1111bbbb2222';
  a.onebot.enabled = true;

  assert.equal(b.onebot.token, '', 'B 鸟不该看到 A 的 token');
  assert.equal(b.onebot.enabled, false, 'B 鸟不该跟着被打开');

  // 再读一次也不能被污染（默认值对象本身不能被改）
  const c = await loadBotConfig('a');
  assert.equal(c.onebot.token, '', '重新加载应该是干净的默认值');
});

test('保存 A 不会把 A 的设置写进 B 的文件', async () => {
  await writeBot('a');
  await writeBot('b');

  const a = await loadBotConfig('a');
  a.onebot.token = 'aaaa1111bbbb2222';
  a.onebot.selfUin = '2854204853';
  await saveBotConfig('a', a);

  const b = await loadBotConfig('b');
  assert.equal(b.onebot.token, '', 'B 的配置里不该出现 A 的 token');
  assert.equal(b.onebot.selfUin, '');

  const rawB = JSON.parse(await fs.readFile(path.join(home, 'config', 'bots', 'b.json'), 'utf8'));
  assert.equal(rawB.onebot?.token ?? '', '', 'B 的磁盘文件里也不该有 token');
});

test('onebot 会被写盘（重启不丢）', async () => {
  await writeBot('a');
  const a = await loadBotConfig('a');
  a.onebot = { ...a.onebot, enabled: true, token: 'tok-1234567890abcd', selfUin: '10001', port: 6700 };
  await saveBotConfig('a', a);

  const raw = JSON.parse(await fs.readFile(path.join(home, 'config', 'bots', 'a.json'), 'utf8'));
  assert.equal(raw.onebot.enabled, true);
  assert.equal(raw.onebot.token, 'tok-1234567890abcd');
  assert.equal(raw.onebot.port, 6700);
});
