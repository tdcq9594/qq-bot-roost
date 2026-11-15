/**
 * 票据过期 → 自动续期 → 重试一次
 * ================================
 *
 * 这段逻辑在会话层（`session.post` / `postForm`），不碰浏览器：浏览器那头的
 * 「开窗换票」由 `platform` 提供的钩子负责。这里钉四件事：
 *
 *   1. **只有平台明确回 401** 才触发续期。本机没票（`NOT_LOGGED_IN`）、
 *      限频（10000）、业务错都不该去开浏览器——开了也解决不了，只是多个窗口。
 *   2. 续期成功后重试**有上限**：只对「平台还在忙」按固定节奏退避重试，
 *      票据错 / 权限错第一次就停，不会变成无限重试。
 *   3. 重试前必须清掉上次失败留下的冷却，否则会在本地被拒（一次都没出网）。
 *   4. 续期失败就把原来的错误抛出去，不吞、不改写（用户看到的还得是
 *      「登录已过期」而不是「未知错误」）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 等待时间固定成 65 秒（默认值）：现在的实现**不在请求链里等**，只是把
 * 「多久之后再来」写进错误里和冷却里，所以测试不会真的等 65 秒。
 */
process.env.ROOST_DEV_RENEW_WAIT_MS = '65000';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDevSession } from '../src/dev/session.js';

const jsonRes = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

/** 第 1 次 401、之后成功的 fetch */
function flakyFetch(responses) {
  let i = 0;
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), cookie: init.headers?.Cookie ?? '' });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return jsonRes(r.status, r.body);
  };
  impl.calls = calls;
  return impl;
}

const EXPIRED = { status: 401, body: { retcode: 401, msg: 'miss ticket' } };
const OK = { status: 200, body: { retcode: 0, data: { bots: [] } } };

test('401 → 续期成功 → 自动重试一次并拿到结果', async () => {
  const fetchImpl = flakyFetch([EXPIRED, OK]);
  let renews = 0;
  const s = createDevSession({
    fetchImpl,
    log: () => {},
    onExpired: async () => {
      renews += 1;
      // 模拟换到新票：整份替换
      s.adopt('b-token=fresh; developer_id_lite=dev');
      return true;
    },
  });
  s.adopt('b-token=old');

  const data = await s.post('/cgi-bin/v2/info/list_bots', {});
  assert.deepEqual(data, { bots: [] });
  assert.equal(renews, 1);
  assert.equal(fetchImpl.calls.length, 2, '应当只重试一次');
  // 重试必须用**新票**：还用旧票等于白续期
  assert.match(fetchImpl.calls[1].cookie, /b-token=fresh/);
});

test('续期没成功：原错误照抛，不重试', async () => {
  const fetchImpl = flakyFetch([EXPIRED, OK]);
  const s = createDevSession({
    fetchImpl,
    onExpired: async () => false,
  });
  s.adopt('b-token=old');

  await assert.rejects(
    () => s.post('/cgi-bin/v2/info/list_bots', {}),
    (e) => e.code === 'TICKET_EXPIRED' && e.http === 401,
  );
  assert.equal(fetchImpl.calls.length, 1, '续期失败就不该再打第二次');
});

test('续期成功但新票也是废的：只重试一次，然后把 401 抛出来', async () => {
  const fetchImpl = flakyFetch([EXPIRED, EXPIRED]);
  const s = createDevSession({
    fetchImpl,
    onExpired: async () => {
      s.adopt('b-token=also-old');
      return true;
    },
  });
  s.adopt('b-token=old');

  await assert.rejects(
    () => s.post('/cgi-bin/v2/info/list_bots', {}),
    (e) => e.code === 'TICKET_EXPIRED',
  );
  assert.equal(fetchImpl.calls.length, 2, '不能无限续期-重试');
});

test('本机根本没票：不发请求也不开浏览器', async () => {
  const fetchImpl = flakyFetch([OK]);
  let touched = false;
  const s = createDevSession({ fetchImpl, onExpired: async () => { touched = true; return true; } });

  await assert.rejects(
    () => s.post('/cgi-bin/v2/info/list_bots', {}),
    (e) => e.code === 'NOT_LOGGED_IN',
  );
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(touched, false, '「没登录」不该触发自动开窗');
});

test('平台限频（10000）不触发续期：换票也治不了限频', async () => {
  const fetchImpl = flakyFetch([{ status: 200, body: { retcode: 10000, msg: '系统繁忙' } }, OK]);
  let touched = false;
  const s = createDevSession({ fetchImpl, onExpired: async () => { touched = true; return true; } });
  s.adopt('b-token=old');

  await assert.rejects(
    () => s.post('/cgi-bin/v2/info/list_bots', {}),
    (e) => e.code === 'PLATFORM_BUSY' && e.retryAfterMs > 0,
  );
  assert.equal(touched, false);
});

test('续期钩子抛异常：不能让整个请求变成另一个错', async () => {
  const fetchImpl = flakyFetch([EXPIRED, OK]);
  const s = createDevSession({
    fetchImpl,
    log: () => {},
    onExpired: async () => { throw new Error('浏览器起不来'); },
  });
  s.adopt('b-token=old');

  await assert.rejects(
    () => s.post('/cgi-bin/v2/info/list_bots', {}),
    (e) => e.code === 'TICKET_EXPIRED' && /登录已过期/.test(e.message),
  );
});



test('续期后平台还忙：只试一次，然后告诉调用方「65 秒后再来」', async () => {
  // 401（票过期）→ 续期 → 10000（新票还没生效）
  const fetchImpl = flakyFetch([
    EXPIRED,
    { status: 200, body: { retcode: 10000, msg: '系统繁忙' } },
    OK,
  ]);
  const s = createDevSession({
    fetchImpl,
    log: () => {},
    onExpired: async () => {
      s.adopt('b-token=fresh; developer_id_lite=dev');
      return true;
    },
  });
  s.adopt('b-token=old');

  await assert.rejects(
    () => s.post('/cgi-bin/v2/info/list_bots', {}),
    (e) => {
      /**
       * 这里必须报 `RENEWED_WAIT` 而不是 `PLATFORM_BUSY`：
       * 前者表示「登录已经恢复，等着就行」（用户什么都不用做），
       * 后者表示「你被限频了」——两者的下一步完全不同。
       */
      assert.equal(e.code, 'RENEWED_WAIT');
      assert.equal(e.http, 429);
      assert.equal(e.retryAfterMs, 65_000);
      assert.match(e.message, /票据已换新/);
      assert.match(e.hint, /不用重新扫码/);
      return true;
    },
  );

  // 1 次原请求 + 1 次即时重试。**不再连打**：连打只会把平台恢复往后推
  assert.equal(fetchImpl.calls.length, 2, '换票后只该再试一次');
  // 冷却按同一个 65 秒设上：面板据此倒计时，也避免调用方硬打
  assert.ok(s.describe().cooldownMs > 60_000);
});

test('续期后平台已经放开：立刻拿到数据，不排等待', async () => {
  const fetchImpl = flakyFetch([EXPIRED, OK]);
  const s = createDevSession({
    fetchImpl,
    log: () => {},
    onExpired: async () => {
      s.adopt('b-token=fresh; developer_id_lite=dev');
      return true;
    },
  });
  s.adopt('b-token=old');

  const data = await s.post('/cgi-bin/v2/info/list_bots', {});
  assert.deepEqual(data, { bots: [] });
  assert.equal(s.describe().cooldownMs, 0, '成功了就不该留冷却');
});

/* ------------------------------------------------------------------ */
/* 平台层：续期自己出错，不能把「防重入闸」锁死                          */
/* ------------------------------------------------------------------ */

test('自动续期自身抛错：闸要放回去，且要退避', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-renew-'));
  process.env.ROOST_HOME = home;
  const { createDevPlatform } = await import('../src/dev/platform.js');

  const P = createDevPlatform({ fetchImpl: async () => jsonRes(200, { retcode: 0, data: {} }) });
  // 扫码器直接炸：模拟「起浏览器就失败」
  P._scanner.refresh = async () => { throw new Error('boom'); };

  const first = await P._autoRelogin();
  assert.equal(first, false, '续期失败要如实返回 false');

  const st = await P.status();
  const a = st.autoRelogin;
  assert.equal(a.running, false, '闸必须放回去，否则之后所有续期都静默失效');
  assert.equal(a.last.ok, false);
  assert.match(String(a.last.message), /boom/);
  assert.ok(a.retryInMs > 0, '失败后要退避，别每 20 秒重开一次浏览器');

  await fs.rm(home, { recursive: true, force: true });
});

test('换票成功后排一次补拉：时间一到自己拉回数据，不用人再点', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-warm-'));
  process.env.ROOST_HOME = home;
  // 真实是 65 秒，测试里压到 60ms
  const bak = process.env.ROOST_DEV_RENEW_WAIT_MS;
  process.env.ROOST_DEV_RENEW_WAIT_MS = '60';

  const { createDevPlatform } = await import('../src/dev/platform.js');
  const calls = [];
  const P = createDevPlatform({
    fetchImpl: async (url, init = {}) => {
      calls.push(String(url));
      return jsonRes(200, { retcode: 0, data: { bots: [{ bot_appid: 123, bot_name: '小鸟' }] } });
    },
  });
  P._scanner.refresh = async () => ({
    ok: true,
    jar: new Map([['b-token', 'fresh'], ['developer_id_lite', 'dev']]),
  });

  try {
    assert.equal(await P._autoRelogin(), true);

    const queued = await P.status();
    assert.equal(queued.autoRelogin.warmupPending, true, '换票后应当排上补拉');
    assert.equal(queued.autoRelogin.warmup.ok, null, '还没跑，结论应为未知');

    await new Promise((r) => { setTimeout(r, 400); });

    const done = await P.status();
    assert.equal(done.autoRelogin.warmup.ok, true, '补拉应当成功');
    assert.equal(done.autoRelogin.warmup.botCount, 1);
    assert.equal(done.autoRelogin.warmupPending, false);
    assert.ok(calls.some((u) => u.includes('list_bots')), '补拉要真的打一次接口');
  } finally {
    process.env.ROOST_DEV_RENEW_WAIT_MS = bak;
    await fs.rm(home, { recursive: true, force: true });
  }
});
