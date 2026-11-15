/**
 * 「别的目录里已经装了」不该被当成缺依赖。
 *
 * 真实场景：用户把 Roost 放进自己的项目里，或者用 pnpm / npm workspaces
 * 装了依赖（hoisted 到上层 `node_modules`）。以前 `deps.js` 只看
 * `<插件目录>/node_modules` 在不在，于是「明明机器上有」也会被重新下载一遍；
 * 没有 npm 的机器上更糟——直接判定「缺依赖」把插件拦在门外。
 *
 * 这里钉住两件事：
 *   1. 全部依赖都能从上层解析到时 → 跳过安装，**不碰安装器**；
 *   2. 只要有一个解析不到 → 仍然按老规矩装（或抛），不能糊过去。
 */

import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensurePluginDeps } from '../src/plugin/deps.js';

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

/** 完全没运行时：任何「真去装」都会失败，正好用来证明「没装」 */
const NO_RUNTIME = { python: null, installer: null, bundled: {} };

/** 假安装器：跑一段 node 脚本，被调用时留下一个痕迹文件 */
function tracerInstaller(markerFile) {
  return {
    kind: 'npm',
    cmd: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerFile)}, 'x')`],
    label: '假 npm',
  };
}

/**
 * 造一棵「上层已经有依赖」的树：
 *
 *   <root>/node_modules/<pkg>/…
 *   <root>/plugins/demo/package.json
 */
function tree({ deps = {}, installed = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'roost-ext-'));
  for (const name of installed) {
    const p = path.join(root, 'node_modules', name);
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js' }));
    writeFileSync(path.join(p, 'index.js'), 'module.exports = {};\n');
  }
  const dir = path.join(root, 'plugins', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', dependencies: deps }, null, 2));
  return { root, dir };
}

const clean = (d) => {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {}
};

await ok('上层 node_modules 里全都有：跳过安装，不碰安装器', async () => {
  const { root, dir } = tree({
    deps: { alpha: '^1.0.0', beta: '^1.0.0' },
    installed: ['alpha', 'beta'],
  });
  const marker = path.join(root, 'installer-ran');
  try {
    const r = await ensurePluginDeps({
      dir,
      manifest: {},
      runtimes: { python: null, installer: tracerInstaller(marker), bundled: {} },
    });
    assert.deepEqual(r.installed, [], `不该真装：${JSON.stringify(r)}`);
    assert.equal(existsSync(marker), false, '安装器一次都不该被调用');
    assert.ok(
      r.skipped.some((s) => /外部目录/.test(s)),
      `要说清楚是复用了外部那份：${JSON.stringify(r.skipped)}`,
    );
    /** 也不该往插件目录里塞 node_modules */
    assert.equal(existsSync(path.join(dir, 'node_modules')), false);
  } finally {
    clean(root);
  }
});

await ok('只解析到一部分：仍然老老实实装，不能半跳过', async () => {
  const { root, dir } = tree({
    deps: { alpha: '^1.0.0', beta: '^1.0.0' },
    installed: ['alpha'],
  });
  const marker = path.join(root, 'installer-ran');
  try {
    const r = await ensurePluginDeps({
      dir,
      manifest: {},
      runtimes: { python: null, installer: tracerInstaller(marker), bundled: {} },
    });
    assert.equal(existsSync(marker), true, '缺一个就该去装');
    assert.equal(r.installed.length, 1);
  } finally {
    clean(root);
  }
});

await ok('一个都解析不到 + 没有安装器：必装依赖照旧抛', async () => {
  const { root, dir } = tree({ deps: { gamma: '^1.0.0' } });
  try {
    await assert.rejects(
      () => ensurePluginDeps({ dir, manifest: {}, runtimes: NO_RUNTIME }),
      /gamma/,
    );
  } finally {
    clean(root);
  }
});

await ok('可选依赖解析不到 + 没有安装器：只警告，不抛', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'roost-ext-'));
  const dir = path.join(root, 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', optionalDependencies: { delta: '^1.0.0' } }),
  );
  try {
    const r = await ensurePluginDeps({ dir, manifest: {}, runtimes: NO_RUNTIME });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /可选依赖/);
  } finally {
    clean(root);
  }
});

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exitCode = 1;
}
