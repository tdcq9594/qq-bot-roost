#!/usr/bin/env node
/**
 * 素材时间的量级归一。
 *
 * 官方 `GET /v2/media-images` 的 `created_at` / `expires_at` 是 Unix **秒**，
 * 而框架内其余 `expiresAt`（凭证）是毫秒，下游面板一律按毫秒渲染。
 * 没归一的时候，`1.83e9` 被当毫秒 → 面板显示 **1970-01-22 04:52**。
 *
 * 这类错是「静默错」：不抛异常、日志干净，只是数字不对，所以必须有测试钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { QQApi, toMillis } from '../src/api.js';

/** 2028-01-19T00:00:00Z，就是当初面板上那个 1970 的来源值 */
const SEC_2028 = 1831920000;
const MS_2028 = SEC_2028 * 1000;

test('toMillis：秒级时间戳乘 1000', () => {
  assert.equal(toMillis(SEC_2028), MS_2028);
  assert.equal(new Date(toMillis(SEC_2028)).getUTCFullYear(), 2028);
});

test('toMillis：已经是毫秒的原样返回（官方哪天改了单位也不会反着错）', () => {
  assert.equal(toMillis(MS_2028), MS_2028);
});

test('toMillis：0 / 空 / 非数字都归 0，不产生 1970', () => {
  for (const v of [0, null, undefined, '', 'abc', NaN]) {
    assert.equal(toMillis(v), 0, `${String(v)} 应该归 0`);
  }
  // 0 就是「没有这个信息」，交给上层显示「未知」，别渲染成一个时间点
  assert.equal(new Date(0).toISOString(), '1970-01-01T00:00:00.000Z');
});

test('toMillis：字符串数字也认（官方偶尔给字符串）', () => {
  assert.equal(toMillis(String(SEC_2028)), MS_2028);
});

/** 起一个假 fetch，返回指定的 media-images 响应体 */
function serve(body) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    seen,
    restore() {
      globalThis.fetch = real;
    },
  };
}

function newApi() {
  return new QQApi({
    tokenManager: { get: async () => 'tok', appId: 'app123' },
    baseUrl: 'https://api.test',
  });
}

test('listMediaImages：把官方的秒转成毫秒再交出去', async () => {
  const f = serve({
    images: [
      {
        image_id: 'img_1',
        url: 'qqbot-media://image/v1/x',
        file_name: 'a.png',
        preview_url: '',
        created_at: SEC_2028 - 86400,
        expires_at: SEC_2028,
      },
    ],
    next_cursor: '',
    total: 1,
  });
  try {
    const r = await newApi().listMediaImages();
    const it = r.images[0];
    assert.equal(it.createdAt, (SEC_2028 - 86400) * 1000);
    assert.equal(it.expiresAt, MS_2028);
    // 回归点：这两个值都不可能落在 1970
    assert.ok(it.expiresAt > Date.UTC(2001, 0, 1), '毫秒值必须大于 2001 年，否则就是秒被当毫秒');
  } finally {
    f.restore();
  }
});

test('listMediaImages：字段缺失时给 0 而不是 NaN', async () => {
  const f = serve({ images: [{ image_id: 'img_2' }], total: 1 });
  try {
    const it = (await newApi().listMediaImages()).images[0];
    assert.equal(it.createdAt, 0);
    assert.equal(it.expiresAt, 0);
    assert.equal(it.fileName, '');
  } finally {
    f.restore();
  }
});

test('listMediaImages：cursor 透传为查询参数', async () => {
  const f = serve({ images: [], total: 0 });
  try {
    await newApi().listMediaImages({ cursor: 'abc def' });
    assert.equal(f.seen.length, 1);
    assert.match(f.seen[0], /^https:\/\/api\.test\/v2\/media-images\?cursor=abc\+def$/);
  } finally {
    f.restore();
  }
});
