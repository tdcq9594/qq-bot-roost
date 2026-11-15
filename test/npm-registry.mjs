/**
 * npm 源解析的离线测试。
 *
 * 盯的是两个真实痛点：
 *   1. 国内直连 registry.npmjs.org 超时，但**用户自己配过源**（环境变量 /
 *      `.npmrc`）时不该被我们覆盖；
 *   2. 直链下载（tgz）绕过了 npm，`npm_config_registry` 对它无效——
 *      必须自己准备一份可轮询的候选源。
 *
 * **不联网**：全是纯函数，改环境变量前后自己还原。
 */

import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  OFFICIAL,
  NPM_MIRROR,
  configureRegistry,
  downloadRegistries,
  normRegistry,
  registryArgs,
  resetRegistryCache,
  resolveRegistry,
  tgzUrl,
} from '../src/npm-registry.js';

let pass = 0;
const fails = [];
async function ok(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

/** 改环境变量跑一段，跑完还原 */
async function withEnv(patch, fn) {
  const old = {};
  for (const [k, v] of Object.entries(patch)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 每个用例都从「什么都没配」开始 */
function clean() {
  configureRegistry({});
  resetRegistryCache();
}

/* ---------------- 地址规范化 ---------------- */

await ok('normRegistry：补 https、去尾斜杠', () => {
  assert.equal(normRegistry('registry.npmmirror.com'), 'https://registry.npmmirror.com');
  assert.equal(normRegistry('https://registry.npmmirror.com///'), 'https://registry.npmmirror.com');
  assert.equal(normRegistry('  http://10.0.0.5:4873/  '), 'http://10.0.0.5:4873');
});

await ok('normRegistry：非 http(s) 一律不认', () => {
  assert.equal(normRegistry('ftp://example.com'), '');
  assert.equal(normRegistry('file:///tmp/x'), '');
  assert.equal(normRegistry(''), '');
  assert.equal(normRegistry(null), '');
});

/* ---------------- 配置 ---------------- */

await ok('配置 npmmirror：解析出镜像，并给 npm 拼 --registry', () => {
  clean();
  configureRegistry({ network: { npmRegistry: 'npmmirror' } });
  const r = resolveRegistry();
  assert.equal(r.url, NPM_MIRROR);
  assert.equal(r.source, 'config');
  assert.deepEqual(registryArgs(), [`--registry=${NPM_MIRROR}`]);
});

await ok('配置 official：回到官方源，且**不加** --registry 参数', () => {
  clean();
  configureRegistry({ network: { npmRegistry: 'official' } });
  return withEnv({ npm_config_registry: undefined, NPM_CONFIG_REGISTRY: undefined }, () => {
    const r = resolveRegistry();
    assert.equal(r.url, OFFICIAL);
    assert.equal(r.source, 'default');
    assert.deepEqual(registryArgs(), [], '官方源不该显式传参，让 npm 走自己的默认逻辑');
  });
});

await ok('配置自定义 URL：直接用，非法值退回官方源', () => {
  clean();
  configureRegistry({ network: { npmRegistry: 'https://npm.internal.corp/' } });
  assert.equal(resolveRegistry().url, 'https://npm.internal.corp');

  configureRegistry({ network: { npmRegistry: 'not a url' } });
  assert.equal(resolveRegistry().source, 'default', '写错了不该让装依赖直接失败');
});

/* ---------------- 优先级 ---------------- */

await ok('优先级：override > 配置 > 环境变量 > 默认', () => {
  clean();
  configureRegistry({ network: { npmRegistry: 'npmmirror' } });
  return withEnv({ npm_config_registry: 'https://env.example.com' }, () => {
    assert.equal(resolveRegistry().url, NPM_MIRROR, '配置要压过环境变量');
    assert.equal(
      resolveRegistry({ override: 'https://override.example.com' }).url,
      'https://override.example.com',
      '接口显式传的要压过配置',
    );
    configureRegistry({});
    assert.equal(resolveRegistry().url, 'https://env.example.com', '没配置时环境变量生效');
    assert.equal(resolveRegistry().source, 'env');
  });
});

await ok('.npmrc 里的 registry= 也认（排在环境变量之后）', () => {
  clean();
  const dir = mkdtempSync(path.join(tmpdir(), 'roost-rc-'));
  const oldCwd = process.cwd();
  try {
    writeFileSync(path.join(dir, '.npmrc'), '; 注释行不算\nregistry=https://rc.example.com/\n', 'utf8');
    process.chdir(dir);
    resetRegistryCache();
    return withEnv({ npm_config_registry: undefined, NPM_CONFIG_REGISTRY: undefined }, () => {
      const r = resolveRegistry();
      assert.equal(r.url, 'https://rc.example.com');
      assert.equal(r.source, 'npmrc');
    });
  } finally {
    process.chdir(oldCwd);
    clean();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 直链下载候选 ---------------- */

await ok('直链候选：官方优先，镜像兜底，不重复', () => {
  clean();
  const list = downloadRegistries();
  assert.deepEqual(list, [OFFICIAL, NPM_MIRROR]);
});

await ok('直链候选：用户配的源排第一，官方和镜像仍然在列表里', () => {
  clean();
  configureRegistry({ network: { npmRegistry: 'https://npm.internal.corp' } });
  assert.deepEqual(downloadRegistries(), ['https://npm.internal.corp', OFFICIAL, NPM_MIRROR]);
});

await ok('直链候选：配的就是官方源时不重复自己', () => {
  clean();
  configureRegistry({ network: { npmRegistry: OFFICIAL } });
  assert.deepEqual(downloadRegistries(), [OFFICIAL, NPM_MIRROR]);
});

/* ---------------- tgz 地址 ---------------- */

await ok('tgzUrl：scoped 包的文件名不带 scope', () => {
  assert.equal(
    tgzUrl('@andresaya/edge-tts', '1.9.1'),
    `${OFFICIAL}/@andresaya/edge-tts/-/edge-tts-1.9.1.tgz`,
  );
});

await ok('tgzUrl：换源时只换前缀，路径不变', () => {
  assert.equal(
    tgzUrl('ws', '8.18.3', NPM_MIRROR),
    `${NPM_MIRROR}/ws/-/ws-8.18.3.tgz`,
  );
  /** 传非 http(s) 的地址时退回官方，不拼出半截地址 */
  assert.equal(tgzUrl('ws', '8.18.3', 'ftp://x'), `${OFFICIAL}/ws/-/ws-8.18.3.tgz`);
});

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exitCode = 1;
}
