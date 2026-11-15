/**
 * 限频冷却 —— `retcode:10000` 之后必须停手
 * =========================================
 *
 * 平台对 `list_bots` 的限频是按「时间段」封的，不是「每秒几次」：一旦被打进
 * `10000`，之后几秒内连发十几次仍然全是 `10000`。所以命中后必须真的停下，
 * 而不是立刻重试——重试只会把恢复时间往后推。
 *
 * 这几条用例锁的就是这个行为：第一次失败要标出 `429 + retryAfterMs`，
 * 冷却期内的后续调用**一个请求都不许发出去**，换票（重新登录）要解开冷却。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevSession } from '../src/dev/session.js';

/** 造一个只会回同一个 retcode 的假 fetch，并记录被调了几次 */
function fakeFetch(retcode, { msg = '系统繁忙，请稍后再试' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const body = JSON.stringify({ retcode, msg, data: retcode === 0 ? { bots: [] } : undefined });
    return {
      status: 200,
      ok: true,
      headers: { getSetCookie: () => [] },
      async text() { return body; },
      async json() { return JSON.parse(body); },
    };
  };
  impl.calls = calls;
  return impl;
}

const login = (session) => session.adopt({ 'b-token': 't0ken', developer_id_lite: '123456' });

test('限频：第一次抛 PLATFORM_BUSY，冷却期内的后续调用不再发请求', async () => {
  const fetchImpl = fakeFetch(10000);
  const session = createDevSession({ fetchImpl });
  login(session);

  await assert.rejects(session.post('/cgi-bin/v2/info/list_bots', {}), (e) => {
    assert.equal(e.code, 'PLATFORM_BUSY');
    assert.equal(e.retcode, 10000);
    // 429 不是 400：调用方据此知道「等一会儿」而不是「参数错了」
    assert.equal(e.http, 429);
    assert.ok(e.retryAfterMs > 0);
    return true;
  });
  assert.equal(fetchImpl.calls.length, 1);

  // 冷却期内连打三次，全都不该出网
  for (let i = 0; i < 3; i++) {
    await assert.rejects(session.post('/cgi-bin/v2/info/list_bots', {}), (e) => {
      assert.equal(e.code, 'PLATFORM_BUSY');
      assert.ok(e.retryAfterMs > 0);
      return true;
    });
  }
  assert.equal(fetchImpl.calls.length, 1, '冷却期内不该再发请求');

  // 状态里要能看到还要等多久，面板据此倒计时
  assert.ok(session.describe().cooldownMs > 0);
  /**
   * 第一次只锁 10 秒，不是 60 秒。
   *
   * 平台恢复常常只要几秒；一律锁一分钟会变成「平台早好了、面板还挂着 60 秒」，
   * 用户点一次失败一次。真正持续限频靠递进（见下一条用例）压下去。
   */
  assert.ok(session.describe().cooldownMs <= 12_000, '首次冷却该在 10 秒档');
});

test('限频：重新登录（换票）会解开冷却', async () => {
  const fetchImpl = fakeFetch(10000);
  const session = createDevSession({ fetchImpl });
  login(session);

  await assert.rejects(session.post('/cgi-bin/v2/info/list_bots', {}));
  assert.ok(session.describe().cooldownMs > 0);

  login(session); // 用户重新扫了一次码
  assert.equal(session.describe().cooldownMs, 0, '换了票就该重新放行');

  // 放行后确实会再发一次请求（哪怕它又失败）
  await assert.rejects(session.post('/cgi-bin/v2/info/list_bots', {}));
  assert.equal(fetchImpl.calls.length, 2);
});

test('普通业务错误不触发冷却：参数错不该演成「等一分钟」', async () => {
  const fetchImpl = fakeFetch(11002, { msg: '没有权限操作这个机器人' });
  const session = createDevSession({ fetchImpl });
  login(session);

  await assert.rejects(session.post('/cgi-bin/v2/bot_dev_setting/modify', {}), (e) => {
    assert.equal(e.code, 'PLATFORM_ERROR');
    assert.equal(e.retcode, 11002);
    assert.equal(e.http, 400);
    return true;
  });
  assert.equal(session.describe().cooldownMs, 0);

  // 接着再来一次应该真的出网
  await assert.rejects(session.post('/cgi-bin/v2/bot_dev_setting/modify', {}));
  assert.equal(fetchImpl.calls.length, 2);
});

test('成功响应不进入冷却', async () => {
  const fetchImpl = fakeFetch(0);
  const session = createDevSession({ fetchImpl });
  login(session);

  const data = await session.post('/cgi-bin/v2/info/list_bots', {});
  assert.deepEqual(data, { bots: [] });
  assert.equal(session.describe().cooldownMs, 0);
});

test('换票后重新计数：不会把上一份票的 60 秒继承过来', async () => {
  const fetchImpl = fakeFetch(10000);
  const session = createDevSession({ fetchImpl });
  login(session);

  await assert.rejects(session.post('/cgi-bin/v2/info/list_bots', {}));
  const first = session.describe().cooldownMs;
  assert.ok(first > 0 && first <= 12_000, `第一次该是 10 秒档，实际 ${first}`);

  /**
   * 重新登录 = 新会话。这时哪怕平台还在忙，也该从 10 秒重新起步，而不是接着
   * 上一份票的档位往下加——否则「换了号还一直被罚」会变成查不出来的怪事。
   * 递进只在**同一次续期里的连续重试**中生效（见 dev-renew 的用例）。
   */
  login(session);
  await assert.rejects(session.post('/cgi-bin/v2/info/list_bots', {}));
  const again = session.describe().cooldownMs;
  // 比的是「档位」不是精确毫秒：剩余时间会随执行耗时自然跳动
  assert.ok(again > 0 && again <= 12_000, `换票后应回到 10 秒档，实际 ${again}`);
});
