/**
 * 昵称同步
 * ========
 *
 * 本机的 `cfg.name` 只是「显示名」，人在开放平台改了名，本机不会自动知道。
 * 这个服务在启动后问一次 `/users/@me`，对不上就改本地并落盘。
 *
 * 这里钉住四条容易被改坏的行为：
 *   1. 平台名和本地不一样 → 内存和磁盘都要更新；
 *   2. 一样 → 不写盘（否则每 6 小时给配置文件做一次无意义的 mtime 抖动，
 *      还会连带触发「配置已热加载」的日志）；
 *   3. 查不到（没网 / secret 错）→ 只 warn，绝不能把名字清空或写坏；
 *   4. mock 模式不碰真实配置（mock 的 getMe 会返回 `mock-bot`，写进去就完了）。
 *
 * `DIRS` 在 import 时算好，所以必须先设 `ROOST_HOME` 再动态 import。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-nick-'));
process.env.ROOST_HOME = HOME;

const { NicknameService } = await import('../src/services/nickname.js');
const { botPaths } = await import('../src/paths.js');

const writeCfg = async (id, patch = {}) => {
  const p = botPaths(id);
  await fs.mkdir(path.dirname(p.config), { recursive: true });
  const cfg = {
    id,
    name: '旧名字',
    enabled: true,
    appId: '102030',
    appSecret: 'secret',
    ...patch,
  };
  await fs.writeFile(p.config, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
};

const readCfg = async (id) => JSON.parse(await fs.readFile(botPaths(id).config, 'utf8'));
const mtimeOf = async (id) => (await fs.stat(botPaths(id).config)).mtimeMs;

/** 造一个够用的 runtime：服务只碰 cfg / name / api / mock */
const mkRt = (cfg, { username = '新名字', mock = false, fail = null } = {}) => ({
  id: cfg.id,
  mock,
  cfg,
  name: cfg.name,
  api: {
    getMe: async () => {
      if (fail) throw new Error(fail);
      return { username, id: '1' };
    },
  },
});

test('平台名和本地不一样：内存和磁盘都更新', async () => {
  const cfg = await writeCfg('alpha');
  const rt = mkRt(cfg);
  await new NicknameService({ getRuntimes: () => [rt] }).tick();

  assert.equal(rt.name, '新名字');
  assert.equal(rt.cfg.name, '新名字');
  assert.equal((await readCfg('alpha')).name, '新名字', '磁盘上也要改，否则下次启动还是旧的');
});

test('名字一样就不写盘（别制造无意义的配置变更）', async () => {
  const cfg = await writeCfg('beta', { name: '一样的' });
  const before = await mtimeOf('beta');
  const rt = mkRt(cfg, { username: '一样的' });

  // 等 10ms 再跑，确保「没写」不会被 mtime 精度掩盖
  await new Promise((r) => setTimeout(r, 10));
  await new NicknameService({ getRuntimes: () => [rt] }).tick();

  assert.equal(await mtimeOf('beta'), before, '一样就不该触发写盘');
  assert.equal(rt.cfg.name, '一样的');
});

test('查不到昵称：只跳过，不能把名字清空', async () => {
  const cfg = await writeCfg('gamma');
  const rt = mkRt(cfg, { fail: '网络不通' });
  await new NicknameService({ getRuntimes: () => [rt] }).tick();

  assert.equal(rt.cfg.name, '旧名字', '失败时保持原值');
  assert.equal((await readCfg('gamma')).name, '旧名字');
});

test('平台回空昵称：同样不覆盖', async () => {
  const cfg = await writeCfg('delta');
  const rt = mkRt(cfg, { username: '   ' });
  await new NicknameService({ getRuntimes: () => [rt] }).tick();
  assert.equal(rt.cfg.name, '旧名字');
});

test('mock 模式与缺凭证的机器人直接跳过', async () => {
  const a = await writeCfg('mockbot', { name: 'A' });
  const b = await writeCfg('nocred', { name: 'B', appSecret: '' });
  const rtA = mkRt(a, { username: 'mock-bot', mock: true });
  const rtB = mkRt(b, { username: '不该用' });

  await new NicknameService({ getRuntimes: () => [rtA, rtB] }).tick();

  // mock 会回 mock-bot，写进去等于把真名糟蹋了
  assert.equal(rtA.cfg.name, 'A');
  assert.equal(rtB.cfg.name, 'B');
  assert.equal((await readCfg('mockbot')).name, 'A');
  assert.equal((await readCfg('nocred')).name, 'B');
});

test('一个机器人失败不影响后面的（循环里不能整个抛出去）', async () => {
  const bad = await writeCfg('bad', { name: '坏的' });
  const good = await writeCfg('good', { name: '好的' });
  const rtBad = mkRt(bad, { fail: '401' });
  const rtGood = mkRt(good, { username: '好的新名' });

  await new NicknameService({ getRuntimes: () => [rtBad, rtGood] }).tick();

  assert.equal(rtBad.cfg.name, '坏的');
  assert.equal(rtGood.cfg.name, '好的新名', '前一个失败不该拦住后一个');
});

test('syncNickname 直接调用：返回 changed / reason，不靠抛异常表达「跳过」', async () => {
  const { syncNickname } = await import('../src/services/nickname.js');

  const cfg = await writeCfg('direct', { name: '老名' });
  const ok = await syncNickname(mkRt(cfg, { username: '新名' }));
  assert.deepEqual(ok, { changed: true, name: '新名' });

  // 名字一样：changed=false，但仍报出平台名，调用方可以放心回显
  const same = await syncNickname(mkRt(cfg, { username: '新名' }));
  assert.equal(same.changed, false);
  assert.equal(same.name, '新名');

  const mockRt = mkRt(cfg, { mock: true });
  assert.equal((await syncNickname(mockRt)).reason, 'mock');

  const noCred = mkRt({ ...cfg, appSecret: '' });
  assert.equal((await syncNickname(noCred)).reason, 'no-credential');

  const bad = await syncNickname(mkRt(cfg, { fail: '超时' }));
  assert.equal(bad.changed, false);
  assert.match(bad.reason, /^query-failed/);

  assert.equal((await syncNickname(null)).reason, 'no-runtime');
});

test('协议 bot.nickname.sync：manage 档，能手动触发一次', async () => {
  const { createMethods } = await import('../src/host/methods.js');
  const cfg = await writeCfg('proto', { name: '改名前' });
  const rt = mkRt(cfg, { username: '改名后' });
  // createMethods 在构造时只读这些字段，给够即可
  rt.state = 'online';
  rt.metrics = { botName: '改名前' };
  rt.plugins = { loaded: new Map() };

  const m = createMethods({ runtime: rt, getState: () => ({}) });
  const desc = m.describe().find((x) => x.name === 'bot.nickname.sync');
  assert.ok(desc, '应当注册了 bot.nickname.sync');
  // 写本地配置，跟 config.set 同档；不能是 message（那是「对外做事」）
  assert.equal(desc.scope, 'manage');

  const out = await m.call('bot.nickname.sync', {}, { scopes: new Set(['manage']) });
  assert.equal(out.changed, true);
  assert.equal(out.name, '改名后');
  assert.equal((await readCfg('proto')).name, '改名后');
});

test.after(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
});
