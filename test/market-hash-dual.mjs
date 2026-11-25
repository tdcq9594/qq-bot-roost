/**
 * 市场插件哈希：双算法兼容 + 校验开关
 * ==================================
 *
 *   node --test test/market-hash-dual.mjs
 *
 * 背景：插件仓 2026-11-23 起把索引改成双写——`sha256` 是 algo1（含文档），
 * `sha256_v2` 是 algo2（排除文档）。框架只算 algo2 却拿它比 `sha256`，
 * 于是所有带 README / LICENSE 的插件都装不上。这里把三种索引形态都钉住：
 * 双写、只有 algo1、只有 algo2（早期索引），以及开关关闭时的行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { hashDir, HASH_ALGO } = await import('../src/hashdir.js');
const { entryHashes, verifyPluginDir, mergeWithInstalled } = await import('../src/plugin/market.js');

/** 插件仓兄弟检出存在时才跑跨仓逐字节断言（CI 里两边都会 checkout） */
const pluginHashPath = path.resolve(
  import.meta.dirname,
  '../../qq-bot-roost-plugins/scripts/hashdir.mjs',
);
const pluginHashAvailable = await fs.access(pluginHashPath).then(() => true, () => false);
const pluginHash = pluginHashAvailable
  ? (await import(pathToFileURL(pluginHashPath).href)).hashDir
  : null;

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-hash-dual-'));
  await fs.writeFile(path.join(dir, 'index.js'), "export const version = '1.0.0';\n");
  await fs.writeFile(path.join(dir, 'README.md'), '# demo\n');
  await fs.mkdir(path.join(dir, 'shots'));
  await fs.writeFile(path.join(dir, 'shots', '1.png'), 'frame');
  await fs.writeFile(path.join(dir, 'seen.json'), '{}');
  return dir;
}

test('HASH_ALGO 与插件仓一致，两种算法逐字节相同', async (t) => {
  assert.equal(HASH_ALGO, 2);
  if (!pluginHash) return t.skip('没有兄弟仓 qq-bot-roost-plugins');
  const dir = await fixture();
  try {
    for (const algo of [1, 2]) {
      assert.equal(await hashDir(dir, { algo }), await pluginHash(dir, { algo }), `algo${algo} 不一致`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('algo1 / algo2 对文档与运行时状态的取舍不同', async () => {
  const dir = await fixture();
  try {
    const old = await hashDir(dir, { algo: 1 });
    const cur = await hashDir(dir, { algo: 2 });
    assert.notEqual(old, cur, 'algo1 计入文档与运行时状态，algo2 不计入');

    const before = cur;
    await fs.writeFile(path.join(dir, 'README.md'), '# changed\n');
    assert.equal(await hashDir(dir, { algo: 2 }), before, '改文档不该改变 algo2');
    assert.notEqual(await hashDir(dir, { algo: 1 }), old, '改文档应该改变 algo1');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('entryHashes 只接受 64 位十六进制，大小写归一', () => {
  const hex = 'a'.repeat(64);
  assert.deepEqual(entryHashes({ sha256: hex.toUpperCase(), sha256_v2: hex }), {
    legacy: hex,
    current: hex,
  });
  assert.deepEqual(entryHashes({ sha256: 'not-a-hash' }), { legacy: '', current: '' });
  assert.deepEqual(entryHashes({}), { legacy: '', current: '' });
});

test('双写索引：sha256_v2（algo2）匹配即通过', async () => {
  const dir = await fixture();
  try {
    const entry = {
      id: 'demo', version: '1.0.0',
      sha256: '0'.repeat(64),
      sha256_v2: await hashDir(dir),
    };
    await assert.doesNotReject(() => verifyPluginDir(entry, dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('双写索引：sha256（algo1）匹配也通过（本次 bug 的回归）', async () => {
  const dir = await fixture();
  try {
    const entry = {
      id: 'demo', version: '1.0.0',
      sha256: await hashDir(dir, { algo: 1 }),
      sha256_v2: '0'.repeat(64),
    };
    await assert.doesNotReject(() => verifyPluginDir(entry, dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('旧索引只有 sha256：algo1 值与 algo2 值都能装', async () => {
  const dir = await fixture();
  try {
    for (const sha256 of [await hashDir(dir, { algo: 1 }), await hashDir(dir, { algo: 2 })]) {
      await assert.doesNotReject(() => verifyPluginDir({ id: 'demo', version: '1.0.0', sha256 }, dir));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('两个算法都不匹配时拒绝，且不误报成「索引过期」', async () => {
  const dir = await fixture();
  try {
    await assert.rejects(
      () => verifyPluginDir({
        id: 'demo', version: '1.0.0',
        sha256: '1'.repeat(64), sha256_v2: '2'.repeat(64),
      }, dir),
      /sha256 不匹配/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('verifyHash:false 时跳过校验（面板开关默认开，这里显式关）', async () => {
  const dir = await fixture();
  try {
    await assert.doesNotReject(() => verifyPluginDir(
      { id: 'demo', version: '1.0.0', sha256: '1'.repeat(64) },
      dir,
      { verifyHash: false },
    ));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('安装 / 更新入口都把开关传进校验，老配置不会意外关闭', async () => {
  for (const rel of ['src/web/server.js', 'src/host/ops.js']) {
    const src = await fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
    const calls = [...src.matchAll(/(?:installPlugin|updatePlugins)\(\{/g)];
    assert.ok(calls.length >= 2, `${rel} 应该有 install / update 调用`);
    for (const m of calls) {
      // 只看这次调用的参数块，别把 GET /api/market 的 verifyHash 响应字段算进来
      const chunk = src.slice(m.index, src.indexOf('});', m.index));
      assert.match(chunk, /verifyHash: (?:globalCfg|R\.globalCfg)\?\.plugins\?\.verifyHash !== false/,
        `${rel} 的 ${m[0]} 没传 verifyHash`);
    }
  }
});

test('面板市场列表不列 DSH 扩展（共用索引，但装不了就不该显示）', () => {
  const entries = [
    { id: 'echo', version: '1.0.0', kind: undefined },
    { id: 'bili', version: '0.11.11', kind: 'dsh-extension', runtime: 'mcp' },
    { id: 'imagegen', version: '0.2.0', kind: 'dsh-extension', runtime: 'mcp' },
  ];
  const merged = mergeWithInstalled(entries, new Set(['echo', 'bili']));
  assert.deepEqual(merged.map((p) => p.id), ['echo']);
  assert.equal(merged[0].installed, true);
});
