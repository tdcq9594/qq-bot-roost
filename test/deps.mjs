/**
 * 插件依赖安装的离线测试。
 *
 * 盯的是一个真实事故：ai-chat 把 3 个**语音可选**依赖写在 `dependencies` 里，
 * 而 `deps.js` 找不到 npm 就直接抛错，`loader.js` 接住之后**整个插件不加载**
 * ——语音没装上，连文字都不回了。
 *
 * 两处结论必须钉住：
 *   1. 找不到安装器时，**可选依赖只能警告，不能拦加载**；必装依赖才该抛。
 *   2. 机器上没 npm 不等于没工具——DSH 桌面版自带 node + pnpm，
 *      只要它在，就不该麻烦用户去装 Node.js。
 *
 * **不联网**：装依赖那两条用 `node -e` 假冒安装器，只验调用链通不通。
 */

import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundledRuntimeRoots, detectRuntimes, ensurePluginDeps } from '../src/plugin/deps.js';

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

/** 造一个只有 package.json 的插件目录 */
function pluginDir(pkg) {
  const dir = mkdtempSync(path.join(tmpdir(), 'roost-deps-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  return dir;
}

const clean = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
};

/** 完全没有运行时（既没 npm 也没 pnpm，也没有 DSH 自带那份） */
const NO_RUNTIME = { python: null, installer: null, bundled: {} };

/** 假安装器：用当前 node 跑一段脚本，不联网也能验调用链 */
function fakeInstaller(script) {
  return { kind: 'npm', cmd: process.execPath, args: ['-e', script], label: '假 npm' };
}

/* ---------------- 自带运行时探测 ---------------- */

await ok('自带运行时：没有 ~/.dsh 时返回空，不抛', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'roost-home-'));
  try {
    assert.deepEqual(bundledRuntimeRoots({ home: empty }), []);
  } finally {
    clean(empty);
  }
});

await ok('自带运行时：能从 <home>/.dsh/dsh-runtimes/*/dependencies 里找到 pnpm', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'roost-home-'));
  const deps = path.join(home, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies');
  mkdirSync(path.join(deps, 'pnpm', 'bin'), { recursive: true });
  writeFileSync(path.join(deps, 'pnpm', 'bin', 'pnpm.cjs'), '// stub\n', 'utf8');
  try {
    const roots = bundledRuntimeRoots({ home });
    assert.equal(roots.length, 1, '应该找到 1 个运行时根目录');
    assert.ok(existsSync(path.join(roots[0], 'pnpm', 'bin', 'pnpm.cjs')), 'pnpm.cjs 路径要能算出来');
  } finally {
    clean(home);
  }
});

await ok('自带运行时：只有 dependencies 目录才算，空的 dsh-runtimes 不算', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'roost-home-'));
  mkdirSync(path.join(home, '.dsh', 'dsh-runtimes', 'half-installed'), { recursive: true });
  try {
    assert.deepEqual(bundledRuntimeRoots({ home }), [], '没有 dependencies 子目录就不该认');
  } finally {
    clean(home);
  }
});

await ok('探测：installer 带 cmd 和 args，光有命令名不够', async () => {
  const rt = await detectRuntimes({ refresh: true });
  if (!rt.installer) return; // 干净 CI 上可能一个都没有，跳过
  assert.equal(typeof rt.installer.cmd, 'string');
  assert.ok(Array.isArray(rt.installer.args) && rt.installer.args.length, 'args 不能是空的');
  assert.ok(rt.installer.args.includes('install'), '第一条命令得是 install');
  assert.ok(rt.installer.args.includes('--ignore-scripts'), '必须禁止 postinstall');
});

/* ---------------- 可选 vs 必装 ---------------- */

await ok('可选依赖 + 一个安装器都没有：只警告，绝不抛', async () => {
  const dir = pluginDir({ name: 'x', optionalDependencies: { 'silk-wasm': '^3.7.1' } });
  try {
    const r = await ensurePluginDeps({ dir, manifest: {}, runtimes: NO_RUNTIME });
    assert.equal(r.warnings.length, 1, `应该有一条警告：${JSON.stringify(r)}`);
    assert.match(r.warnings[0], /可选依赖/);
    assert.match(r.warnings[0], /silk-wasm/, '要说清缺的是哪个，别只说「依赖没装」');
    assert.deepEqual(r.installed, []);
  } finally {
    clean(dir);
  }
});

await ok('必装依赖 + 一个安装器都没有：必须抛，并说清怎么办', async () => {
  const dir = pluginDir({ name: 'x', dependencies: { '@napi-rs/canvas': '^0.1.0' } });
  try {
    await assert.rejects(
      () => ensurePluginDeps({ dir, manifest: {}, runtimes: NO_RUNTIME }),
      (e) => {
        assert.match(e.message, /@napi-rs\/canvas/, '要说出缺哪个包');
        assert.match(e.message, /nodejs\.org/, '要给出去哪装');
        return true;
      },
    );
  } finally {
    clean(dir);
  }
});

await ok('可选依赖 + 有安装器：真去装，装完记账', async () => {
  const dir = pluginDir({ name: 'x', optionalDependencies: { a: '^1.0.0' } });
  try {
    const r = await ensurePluginDeps({
      dir,
      manifest: {},
      runtimes: { python: null, installer: fakeInstaller('require("fs").mkdirSync("node_modules")') },
    });
    assert.equal(r.installed.length, 1, `应该报告装了东西：${JSON.stringify(r)}`);
    assert.ok(existsSync(path.join(dir, 'node_modules')), '安装器真的跑起来了');
    assert.ok(existsSync(path.join(dir, '.deps.json')), '要记账，别每次加载都重装');
  } finally {
    clean(dir);
  }
});

await ok('可选依赖 + 装失败：只警告，插件照常加载', async () => {
  const dir = pluginDir({ name: 'x', optionalDependencies: { a: '^1.0.0' } });
  try {
    const r = await ensurePluginDeps({
      dir,
      manifest: {},
      runtimes: { python: null, installer: fakeInstaller('process.exit(3)') },
    });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /不影响主功能/);
    assert.deepEqual(r.installed, []);
  } finally {
    clean(dir);
  }
});

await ok('必装依赖 + 装失败：必须抛，不能糊过去', async () => {
  const dir = pluginDir({ name: 'x', dependencies: { a: '^1.0.0' } });
  try {
    await assert.rejects(
      () => ensurePluginDeps({
        dir,
        manifest: {},
        runtimes: { python: null, installer: fakeInstaller('process.exit(3)') },
      }),
      /安装 Node 依赖失败/,
    );
  } finally {
    clean(dir);
  }
});

await ok('autoInstallDeps=false：跳过安装，不抛', async () => {
  const dir = pluginDir({ name: 'x', dependencies: { a: '^1.0.0' } });
  try {
    const r = await ensurePluginDeps({ dir, manifest: {}, enabled: false, runtimes: NO_RUNTIME });
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /autoInstallDeps/);
  } finally {
    clean(dir);
  }
});

await ok('没有 package.json：什么都不做，也不炸', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roost-deps-'));
  try {
    const r = await ensurePluginDeps({ dir, manifest: {}, runtimes: NO_RUNTIME });
    assert.deepEqual(r.installed, []);
    assert.deepEqual(r.warnings, []);
  } finally {
    clean(dir);
  }
});

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exitCode = 1;
}
