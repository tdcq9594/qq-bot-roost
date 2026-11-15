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
