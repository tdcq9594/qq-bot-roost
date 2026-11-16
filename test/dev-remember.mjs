/**
 * 「记住登录」的落盘行为
 * ======================
 *
 * 钉两件事：
 *   1. 默认就记住（不传 remember 也写盘）——否则每次重启都要重扫；
 *   2. 登录之后还能改（勾上写盘、取消删盘），且**不用重新登录**。
 *
 * 为什么要单独一个文件：`DIRS` 在 import 时就算好了，必须在 import 之前
 * 把 `ROOST_HOME` 指到临时目录，否则会把票据写进开发机的真实 data 目录。
 * 这也是 `await import()` 而不是顶部静态 import 的原因。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-remember-'));
process.env.ROOST_HOME = HOME;

const { createDevPlatform } = await import('../src/dev/platform.js');
const { DIRS } = await import('../src/paths.js');

const sessionFile = path.join(DIRS.data, 'dev-session.json');

const jsonRes = (data) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

/** 只应答 `list_bots`，其余一律空成功 */
const fakeFetch = () => async (url) => (String(url).includes('list_bots')
  ? jsonRes({ retcode: 0, data: { bots: [] } })
  : jsonRes({ retcode: 0, data: {} }));

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

test('默认记住：导入时不传 remember 也会写盘', async () => {
  const P = createDevPlatform({ fetchImpl: fakeFetch() });
  await P.loginImport('b-token=bt');
  assert.equal(await exists(sessionFile), true, '默认应当落盘');
  assert.equal((await P.status()).remembered, true);
});

test('登录后取消记住：删盘但登录态还在；再勾回来又写盘', async () => {
  const P = createDevPlatform({ fetchImpl: fakeFetch() });
  await P.loginImport('b-token=bt');

  const off = await P.setRemember(false);
  assert.equal(off.remembered, false);
  assert.equal(await exists(sessionFile), false, '取消后文件应当删掉');
  // 关键：内存里的票不能跟着没，用户不该为了「不记住」而重扫一次
  const st = await P.status();
  assert.equal(st.loggedIn, true);
  assert.equal(st.remembered, false);

  const on = await P.setRemember(true);
  assert.equal(on.remembered, true);
  assert.equal(await exists(sessionFile), true);
});

test('显式 remember:false 的导入不落盘', async () => {
  await fs.rm(sessionFile, { force: true });
  const P = createDevPlatform({ fetchImpl: fakeFetch() });
  await P.loginImport('b-token=bt', { remember: false });
  assert.equal(await exists(sessionFile), false);
  assert.equal((await P.status()).remembered, false);
});

test('没登录就想「记住」要报 NOT_LOGGED_IN，而不是写一个空文件', async () => {
  const P = createDevPlatform({ fetchImpl: fakeFetch() });
  await assert.rejects(
    () => P.setRemember(true),
    (e) => e.code === 'NOT_LOGGED_IN' && e.http === 401,
  );
  // 取消记住是允许的（本来就没有），幂等
  assert.equal((await P.setRemember(false)).remembered, false);
  assert.equal(await exists(sessionFile), false);
});

test('重启后能从盘里恢复登录态', async () => {
  const a = createDevPlatform({ fetchImpl: fakeFetch() });
  await a.loginImport('b-token=bt');
  assert.equal(await exists(sessionFile), true);

  // 新实例模拟「框架重启」
  const b = createDevPlatform({ fetchImpl: fakeFetch() });
  await b.load();
  assert.equal((await b.status()).loggedIn, true, '重启后应当自动恢复');
  assert.equal((await b.status()).remembered, true);
});

test('文件权限是 0600（能设的平台才检查）', { skip: process.platform === 'win32' }, async () => {
  const st = await fs.stat(sessionFile).catch(() => null);
  if (!st) return;
  assert.equal(st.mode & 0o777, 0o600);
});

test.after(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
});

/* ---------------- 「不记住」要能跨重启生效 ---------------- */

/**
 * 主人报过：明明取消了「记住登录」，重启后日志里还是「用扫码 profile 换一张新票」。
 *
 * 根因是偏好只存在浏览器 localStorage 里，后端不知道——它只看磁盘上有没有票。
 * 现在偏好落盘（`data/dev-remember.json`），启动时按它决定：
 *   · 不记住 → 连旧版残留的票和 profile 一起清掉，不自动续期；
 *   · 没存过 → 按记住（升级不能把大家的登录踢掉）。
 */
test('偏好「不记住」时，重启会把旧版残留（票 + profile）一起清掉', async () => {
  const P1 = createDevPlatform({ fetchImpl: fakeFetch() });
  await P1.loginImport('b-token=bt');
  await P1.setRemember(false);

  /** 模拟旧版本留下的现场：票文件 + 扫码 profile 都在 */
  await fs.writeFile(sessionFile, JSON.stringify({ cookies: { 'b-token': 'old' }, savedAt: Date.now() }));
  const prof = path.join(DIRS.data, 'dev-browser');
  await fs.mkdir(prof, { recursive: true });

  const P2 = createDevPlatform({ fetchImpl: fakeFetch() });
  const st = await P2.status();
  assert.equal(st.remembered, false);
  assert.equal(st.profile, false);
  assert.equal(await exists(sessionFile), false, '重启后票要被清掉');
  assert.equal(await exists(prof), false, 'profile 也要清掉，否则后台照样能自动登录');
});

test('没存过偏好时按「记住」处理（升级不能踢掉已有登录）', async () => {
  await fs.rm(path.join(DIRS.data, 'dev-remember.json'), { force: true });
  await fs.writeFile(sessionFile, JSON.stringify({ cookies: { 'b-token': 'keep' }, savedAt: Date.now() }));

  const P = createDevPlatform({ fetchImpl: fakeFetch() });
  const st = await P.status();
  assert.equal(st.remembered, true, '老用户升级后票据应保留');
  assert.equal(await exists(sessionFile), true);
});

test('导入时选「不记住」：票不落盘，但偏好要记下来', async () => {
  const P = createDevPlatform({ fetchImpl: fakeFetch() });
  await P.loginImport('b-token=bt', { remember: false });
  assert.equal(await exists(sessionFile), false);
  const pref = JSON.parse(await fs.readFile(path.join(DIRS.data, 'dev-remember.json'), 'utf8'));
  assert.equal(pref.remember, false);
});
