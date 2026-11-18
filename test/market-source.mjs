/**
 * 市场地址规范化 + 404 换源自测
 * ==============================
 *
 *   node --test test/market-source.mjs
 *
 * 背景：插件市场地址是**落盘**的（`plugins.marketUrl` 写进 config/bot.json）。
 * 一旦仓库从个人仓迁到组织仓，老用户配置里存的还是旧 owner 的 raw 地址。
 *
 * 这层旧路径**目前还能用**——2026-11-19 实测 GitHub 对转移过的仓库保留了历史
 * 重定向（`zeit/next.js`、`sindresorhus/chalk` 的旧 owner 路径仍 200），
 * 但没有任何文档承诺它会一直有效，而 Gitee 镜像只建在老 owner 下。
 * 所以不赌：旧地址在加载配置时就换成当前地址，取索引时 404 也换源。
 *
 * 这里锁住两层防护：
 *   1. `normalizeMarketUrl` / `isOfficialSource` 认历史官方地址
 *   2. `fetchViaMirror(..., { retry4xx: true })` 在 404 时继续试镜像，
 *      全 404 时把 4xx 原样返回（不抛错，调用方原有判断不变）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** paths.js 在模块加载时就算好 DIRS，ROOST_HOME 必须在 import 之前设 */
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-market-source-'));
process.env.ROOST_HOME = HOME;

const { configureProxy } = await import('../src/proxy.js');
/** 关代理：用例把 globalThis.fetch 换成桩，走代理隧道就绕过去了 */
configureProxy({ network: { proxy: 'off' } });

const { configureMirror, fetchViaMirror } = await import('../src/mirror.js');
const { DEFAULT_INDEX_URL, normalizeMarketUrl, isOfficialSource, fetchIndex } = await import(
  '../src/plugin/market.js'
);
const { loadGlobalConfig, PATHS } = await import('../src/config.js');

/** 老版本的官方索引地址（迁移后应被识别并换掉） */
const LEGACY = 'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost-plugins/main/index.json';
const GITEE = 'https://gitee.com/tdcq9594/qq-bot-roost-plugins/raw/main/index.json';

test.after(async () => {
  await fs.rm(HOME, { recursive: true, force: true });
});

/**
 * 把 globalThis.fetch 换成桩。`handler(url)` 返回 `{ status, body? }`。
 * @returns {{calls: string[], restore: () => void}}
 */
function stubFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    const out = (await handler(url)) ?? { status: 500 };
    return new Response(out.body ?? null, { status: out.status });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

/* ---------------- 地址规范化 ---------------- */

test('normalizeMarketUrl：空值 → 官方默认地址', () => {
  assert.equal(normalizeMarketUrl(undefined), DEFAULT_INDEX_URL);
  assert.equal(normalizeMarketUrl(null), DEFAULT_INDEX_URL);
  assert.equal(normalizeMarketUrl(''), DEFAULT_INDEX_URL);
  assert.equal(normalizeMarketUrl('   '), DEFAULT_INDEX_URL);
});

test('normalizeMarketUrl：历史官方地址 → 当前官方地址（幂等），自建源原样保留', () => {
  assert.equal(normalizeMarketUrl(LEGACY), DEFAULT_INDEX_URL);
  assert.equal(normalizeMarketUrl(`  ${LEGACY}  `), DEFAULT_INDEX_URL);
  // 幂等：已经是当前地址，结果不变
  assert.equal(normalizeMarketUrl(normalizeMarketUrl(LEGACY)), DEFAULT_INDEX_URL);
  // 用户自己的源不能被动
  const mine = 'https://example.com/my/index.json';
  assert.equal(normalizeMarketUrl(mine), mine);
});

/**
 * 迁移前 `LEGACY` 和 `DEFAULT` 是同一个字符串，上面那条断言其实没跑替换逻辑。
 * 这里用一对假地址把「旧 → 新」真正跑一遍——否则第一次执行要等到迁移当天。
 */
test('normalizeMarketUrl：替换逻辑本身（注入假地址，不依赖当前常量）', () => {
  const opts = {
    fallback: 'https://new.example/index.json',
    legacy: ['https://old.example/index.json'],
  };
  assert.equal(normalizeMarketUrl('https://old.example/index.json', opts), opts.fallback);
  assert.equal(normalizeMarketUrl('  https://old.example/index.json ', opts), opts.fallback);
  assert.equal(normalizeMarketUrl('', opts), opts.fallback);
  assert.equal(normalizeMarketUrl(undefined, opts), opts.fallback);
  assert.equal(normalizeMarketUrl('https://mine.example/index.json', opts), 'https://mine.example/index.json');
  // 不传 opts 走真实常量
  assert.equal(normalizeMarketUrl(LEGACY), DEFAULT_INDEX_URL);
});

test('isOfficialSource：过渡期仍把历史官方地址当官方源', () => {
  assert.equal(isOfficialSource(DEFAULT_INDEX_URL), true);
  assert.equal(isOfficialSource(LEGACY), true);
  assert.equal(isOfficialSource(undefined), true);
  assert.equal(isOfficialSource('https://example.com/index.json'), false);
});

/* ---------------- 404 换源 ---------------- */

test('默认（不开 retry4xx）：4xx 直接交回调用方，不再多打一次镜像', async () => {
  configureMirror({ network: { mirror: 'auto' } });
  const s = stubFetch(() => ({ status: 404 }));
  try {
    const res = await fetchViaMirror(LEGACY);
    assert.equal(res.status, 404);
    assert.equal(s.calls.length, 1, '不该去试镜像');
  } finally {
    s.restore();
  }
});

test('开 retry4xx：官方 raw 404 → 换 Gitee 镜像拿到内容', async () => {
  configureMirror({ network: { mirror: 'auto' } });
  const s = stubFetch((url) =>
    url.startsWith('https://gitee.com/') ? { status: 200, body: '{"plugins":[]}' } : { status: 404 },
  );
  try {
    const res = await fetchViaMirror(LEGACY, {}, { retry4xx: true });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"plugins":[]}');
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1], GITEE);
  } finally {
    s.restore();
  }
});

test('开 retry4xx：所有源都 404 时原样返回 404，不抛错', async () => {
  configureMirror({ network: { mirror: 'auto' } });
  const s = stubFetch(() => ({ status: 404 }));
  try {
    const res = await fetchViaMirror(LEGACY, {}, { retry4xx: true });
    assert.equal(res.status, 404);
    assert.equal(s.calls.length, 2, '两个候选都试过');
  } finally {
    s.restore();
  }
});

test('开 retry4xx：5xx 仍然换源，全挂了才抛错（老行为不变）', async () => {
  configureMirror({ network: { mirror: 'auto' } });
  const s = stubFetch(() => ({ status: 502 }));
  try {
    await assert.rejects(() => fetchViaMirror(LEGACY, {}, { retry4xx: true }), /HTTP 502|所有下载源/);
    assert.equal(s.calls.length, 2);
  } finally {
    s.restore();
  }
});

/* ---------------- 接线：fetchIndex 真的用上了 ---------------- */

test('fetchIndex：直连 404 时靠镜像拿到索引', async () => {
  configureMirror({ network: { mirror: 'auto' } });
  const index = {
    schema: 1,
    repo: 'tdcq9594/qq-bot-roost-plugins',
    branch: 'main',
    updated: '2026-11-19',
    plugins: [{ id: 'demo', name: 'demo', version: '1.0.0', path: 'plugins/demo/' }],
  };
  const s = stubFetch((url) => {
    if (!url.startsWith('https://gitee.com/')) return { status: 404 };
    // .sig 没有就算了（本版不阻断），关键是索引本身
    return url.includes('.sig') ? { status: 404 } : { status: 200, body: JSON.stringify(index) };
  });
  try {
    const data = await fetchIndex(LEGACY, { maxAge: 0 });
    assert.equal(data.plugins.length, 1);
    assert.equal(data.plugins[0].id, 'demo');
    // 索引请求确实先打直连、再打镜像
    const indexCalls = s.calls.filter((u) => !u.includes('.sig'));
    assert.equal(indexCalls.length, 2);
    assert.match(indexCalls[0], /raw\.githubusercontent\.com/);
    assert.match(indexCalls[1], /gitee\.com/);
  } finally {
    s.restore();
  }
});

/* ---------------- 读配置时真的重写了 ---------------- */

test('loadGlobalConfig：落盘的历史官方地址在加载时换成当前地址', async () => {
  await fs.mkdir(path.dirname(PATHS.globalConfig), { recursive: true });
  await fs.writeFile(PATHS.globalConfig, JSON.stringify({ plugins: { marketUrl: LEGACY } }), 'utf8');

  const cfg = await loadGlobalConfig();
  assert.equal(cfg.plugins.marketUrl, DEFAULT_INDEX_URL, '老用户不该继续拿到 404 的旧地址');
});

/**
 * 上面那条在迁移前是空转（`LEGACY === DEFAULT`）。这里写一个**不等于默认值**的
 * 脏值进去，证明 `loadGlobalConfig` 真的调了规范化（而不是靠 deepMerge 的默认值蒙对）。
 */
test('loadGlobalConfig：脏值/空值会被规范化，证明这条链路没断', async () => {
  await fs.writeFile(PATHS.globalConfig, JSON.stringify({ plugins: { marketUrl: '   ' } }), 'utf8');
  assert.equal((await loadGlobalConfig()).plugins.marketUrl, DEFAULT_INDEX_URL);
});

/**
 * 配置文件里压根没有 marketUrl 时也必须拿到官方地址。
 *
 * 这条锁的是「默认值只有一处」：以前 `config.js` 的 `GLOBAL_DEFAULTS` 里
 * 也硬写了一遍官方地址，仓库迁移时改一边忘另一边，老用户就照旧拿到旧地址。
 * 现在默认值只活在 `market.js` 的 `DEFAULT_INDEX_URL`，这里空了就由它填。
 */
test('loadGlobalConfig：没有 marketUrl 字段时用官方默认地址', async () => {
  await fs.writeFile(PATHS.globalConfig, JSON.stringify({ plugins: { hotReload: false } }), 'utf8');
  assert.equal((await loadGlobalConfig()).plugins.marketUrl, DEFAULT_INDEX_URL);
});

test('loadGlobalConfig：用户自建的第三方市场地址不被改动', async () => {
  const mine = 'https://example.com/my/index.json';
  await fs.writeFile(PATHS.globalConfig, JSON.stringify({ plugins: { marketUrl: mine } }), 'utf8');

  const cfg = await loadGlobalConfig();
  assert.equal(cfg.plugins.marketUrl, mine);
});
