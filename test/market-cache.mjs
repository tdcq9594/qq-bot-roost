/**
 * 市场索引的内存缓存自测
 * ========================
 *
 *   node --test test/market-cache.mjs
 *
 * 背景：面板上「插件列表」「检查更新」「市场页」是三个独立请求，各自都要索引。
 * 缓存加之前，每次都是真打网络——国内直连 raw.githubusercontent.com 常常 8~11 秒
 * 才失败切镜像，于是进一次插件页整块空白十几秒。
 *
 * 覆盖五件事：
 *   1. 新鲜期内命中缓存，不再联网
 *   2. `maxAge: 0` 强制重新拉（**写路径必须这样传**，否则装到旧版本）
 *   3. 过了新鲜期会重新拉
 *   4. 并发调用只发一个请求（原有的去重不能被缓存改坏）
 *   5. **stale（磁盘兜底）不写进内存缓存**，否则一次网络抖动会让离线数据
 *      在 60 秒内被当新鲜索引
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * `paths.js` 在模块加载时就算好了 DIRS，所以 ROOST_HOME 必须在 import 之前设，
 * 否则会往开发者自己的 data/ 里写缓存文件。e2e 也是这么干的。
 */
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-market-cache-'));
process.env.ROOST_HOME = HOME;

const { fetchIndex } = await import('../src/plugin/market.js');

/**
 * 代理关掉：本文件把 `globalThis.fetch` 换成桩来数请求次数，而配了代理时
 * 请求会走 src/proxy.js 的隧道，不经过桩——用例会变成「0 次请求」。
 * 机器上真开着代理的人跑测试才不会莫名失败。
 */
const { configureProxy } = await import('../src/proxy.js');
configureProxy({ network: { proxy: 'off' } });

test.after(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
});

/** 一份最小可用的索引 */
function makeIndex(id, version = '1.0.0') {
  return {
    schema: 1,
    repo: 'example/repo',
    branch: 'main',
    updated: '2026-11-08',
    plugins: [{ id, name: id, version, path: `plugins/${id}/` }],
  };
}

/**
 * 把 globalThis.fetch 换成桩，返回 `{ state, restore }`。
 *
 * `state.calls` 只数**索引本身**的请求：框架内置了索引公钥，`fetchIndexOnce`
 * 还会顺带拉一次 `index.json.sig`，那个不能算进来（它每次都会发）。
 *
 * `state.mode = 'fail'` 用 404 模拟网络失败是有意的：`fetchIndexOnce` 对 4xx
 * 直接抛、不重试，测试不用真等那 1.5 秒的重试间隔（超时类失败要等两次 20 秒）。
 */
function stubFetch() {
  const state = { calls: 0, id: 'demo', mode: 'ok' };
  const real = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    // 签名文件：一律「没有」，别计入索引请求数（它会带 _t 参数，别用 endsWith）
    if (url.includes('.sig')) return new Response('', { status: 404 });

    state.calls += 1;
    if (state.mode === 'fail') {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(makeIndex(state.id)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    state,
    restore() {
      globalThis.fetch = real;
    },
  };
}

/**
 * 每个用例用**不同地址**：内存缓存是模块级的，跨用例存活。共用地址会让
 * 后面的用例悄悄命中前面留下的缓存，断言还能过，但测的已经不是它自己。
 */
const URL_A = 'https://index.test/a/index.json';
const URL_B = 'https://index.test/b/index.json';
const URL_C = 'https://index.test/c/index.json';
const URL_D = 'https://index.test/d/index.json';

test('新鲜期内命中缓存，不再联网', async () => {
  const stub = stubFetch();
  try {
    const first = await fetchIndex(URL_A);
    assert.equal(first.plugins.length, 1);
    assert.equal(stub.state.calls, 1);

    const second = await fetchIndex(URL_A);
    assert.equal(second.plugins[0].id, 'demo');
    assert.equal(stub.state.calls, 1, '第二次应该走内存缓存，不该再发请求');
  } finally {
    stub.restore();
  }
});

test('maxAge: 0 强制重新拉（写路径用）', async () => {
  const stub = stubFetch();
  try {
    await fetchIndex(URL_D); // 第一次本来就联网
    const before = stub.state.calls;

    await fetchIndex(URL_D, { maxAge: 0 });
    assert.equal(stub.state.calls, before + 1, 'maxAge:0 必须绕过缓存');
  } finally {
    stub.restore();
  }
});

test('过了新鲜期会重新拉', async () => {
  const stub = stubFetch();
  try {
    await fetchIndex(URL_B);
    const before = stub.state.calls;

    // 用 maxAge: 1 模拟「缓存已经过期」，不用真等 60 秒
    await new Promise((r) => setTimeout(r, 5));
    await fetchIndex(URL_B, { maxAge: 1 });
    assert.equal(stub.state.calls, before + 1);
  } finally {
    stub.restore();
  }
});

test('并发调用只发一个请求', async () => {
  const stub = stubFetch();
  try {
    await Promise.all([fetchIndex(URL_C), fetchIndex(URL_C), fetchIndex(URL_C)]);
    assert.equal(stub.state.calls, 1, '同一时刻的多个调用应该共用一个请求');
  } finally {
    stub.restore();
  }
});

test('磁盘兜底的 stale 结果不写进内存缓存', async () => {
  const stub = stubFetch();
  try {
    const url = 'https://index.test/e/index.json';

    /**
     * 预置一份磁盘缓存，模拟「上一次成功拉取留下的」。
     * 这里刻意不先成功调用一次——那会把数据同时写进内存缓存，
     * 第二次请求直接命中，就测不出 stale 有没有污染内存了。
     */
    await fs.mkdir(path.join(HOME, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(HOME, 'data', 'market-cache.json'),
      JSON.stringify({ url, at: Date.now(), data: makeIndex('demo') }),
    );

    // 网络挂了 → 走磁盘缓存，标记 stale
    stub.state.mode = 'fail';
    const stale = await fetchIndex(url);
    assert.equal(stale.stale, true, '网络失败时应该回退到磁盘缓存并标记 stale');
    assert.equal(stale.plugins[0].id, 'demo');
    const afterFail = stub.state.calls;

    /**
     * 恢复网络后立刻再请求：如果刚才那份 stale 被写进了内存缓存，
     * 这里会直接命中它（calls 不变）——那就错了，等于把离线数据当新鲜索引，
     * 面板还会据此说「已是最新」。
     */
    stub.state.mode = 'ok';
    const fresh = await fetchIndex(url);
    assert.equal(fresh.stale, undefined, '恢复网络后不该还是 stale');
    assert.equal(stub.state.calls, afterFail + 1, 'stale 结果不该留在内存缓存里');
  } finally {
    stub.restore();
  }
});
