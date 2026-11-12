/**
 * OneBot 兼容层的按需依赖
 * ========================
 *
 * 兼容层需要 `ws`（WS 服务端），语音还需要 `silk-wasm`（WAV → SILK）。
 * 两者都**不进** `package.json`——框架本体保持零依赖这条不变，
 * 用户在面板「兼容」页点「一键安装」才真正装到 `data/deps/onebot/`。
 *
 * 三条硬原则：
 *
 *   1. **包名白名单**。只接受 `WHITELIST` 里的名字。面板传来的任意包名等于
 *      把「面板弱口令」升级成「远程代码执行」——这条不能让步。
 *   2. **装到数据目录**，不碰项目根 `node_modules`。否则「零依赖」变成假话，
 *      `npm ci` 会把它们清掉，用户 `git pull` 后行为还会变。
 *   3. **不自动装、不自动升级**。安装是一次显式动作；启动时只读状态。
 *
 * 安装本身复用 `src/plugin/deps.js` 的 `ensurePluginDeps`：npm / pnpm 探测、
 * DSH 自带运行时、`--ignore-scripts`、超时、失败原因都已经在里面了，
 * 这里只补「白名单 + 状态 + 加载 + 冒烟」。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DIRS } from '../paths.js';
import { createLogger } from '../logger.js';
import { ensurePluginDeps } from '../plugin/deps.js';

const log = createLogger('onebot-deps');

/**
 * 白名单。
 *
 * `range` 是写进 package.json 的版本范围。**不用 `latest`**：
 * 大版本漂移会改 API（`ws` 8 → 9 就换过默认行为），锁主版本再留补丁位。
 */
export const WHITELIST = {
  ws: {
    range: '^8.18.0',
    required: true,
    size: '~120KB',
    desc: 'WS 服务端（兼容模式必需）',
  },
  'silk-wasm': {
    range: '^3.7.1',
    required: false,
    size: '~1.5MB',
    desc: '语音转 SILK（可选，发语音才需要）',
  },
};

/** 装在哪：`data/deps/onebot/`。跟着数据走，升级不丢，也不污染仓库 */
export function depsDir() {
  return path.join(DIRS.data, 'deps', 'onebot');
}

const pkgFile = () => path.join(depsDir(), 'package.json');

/** 已加载的模块缓存（`{ws, silk}`），`remove()` / `install()` 后要清 */
const loaded = new Map();

/** 共用一个 createRequire，`resetCache` 要拿它去删 Node 自己的模块缓存 */
let requireFrom = null;
function req() {
  requireFrom ??= createRequire(path.join(depsDir(), 'package.json'));
  return requireFrom;
}

/** 安装串行化：两个人同时点「一键安装」不该各起一个 npm */
let installChain = Promise.resolve();

/** 只接受白名单里的名字；有非法项就整体拒绝，不做「部分安装」 */
export function pickPackages(names) {
  const want = Array.isArray(names) ? names : [names];
  const picked = [];
  const bad = [];
  for (const raw of want) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    if (!Object.hasOwn(WHITELIST, name)) bad.push(name);
    else if (!picked.includes(name)) picked.push(name);
  }
  if (bad.length) {
    throw new Error(
      `不认识的依赖：${bad.join('、')}。只允许安装 ${Object.keys(WHITELIST).join(' / ')}——` +
        '白名单是为了防止「面板被改一下就能在机器上执行任意包」',
    );
  }
  return picked;
}

/** 读一个已装包的版本；没装返回空串 */
async function installedVersion(name) {
  const file = path.join(depsDir(), 'node_modules', name, 'package.json');
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8'));
    return String(j.version ?? '');
  } catch {
    return '';
  }
}

/**
 * 当前状态。
 *
 * 只读文件，不装任何东西，也不 `require`——面板每秒都可能调它。
 * `resolvable` 用 `require.resolve` 判断（比 require 便宜，且能发现
 * 「版本号还在、文件被删了」这种半坏状态）。
 */
export async function status() {
  const dir = depsDir();
  const r = req();
  const out = { dir, packages: {}, missing: [], required: [], error: '' };

  for (const [name, meta] of Object.entries(WHITELIST)) {
    const version = await installedVersion(name);
    let resolvable = false;
    if (version) {
      try {
        r.resolve(name);
        resolvable = true;
      } catch {
        resolvable = false;
      }
    }
    out.packages[name] = {
      version,
      resolvable,
      required: meta.required,
      desc: meta.desc,
      size: meta.size,
      range: meta.range,
    };
    if (meta.required) out.required.push(name);
    if (!version || !resolvable) out.missing.push(name);
  }

  return out;
}

/** 必需依赖是否齐（`enabled` 的开关要用它） */
export async function ready() {
  const s = await status();
  return s.required.every((n) => s.packages[n]?.resolvable);
}

/**
 * 冒烟校验：真 require 一次，能实例化才算装好。
 *
 * 单独导出是因为面板「自检」也要用它——「版本号在、文件坏了」这种情况
 * 只有真加载一次才发现。
 *
 * @param {string[]} [names] 默认校验全部白名单包
 * @returns {Promise<string[]>} 错误描述列表，空数组 = 全过
 */
export async function verify(names = Object.keys(WHITELIST)) {
  const out = [];
  for (const name of pickPackages(names)) {
    const why = await smoke(name);
    if (why) out.push(`${name}：${why}`);
  }
  return out;
}

/** 冒烟：真 require 一次，能实例化才算装好 */
async function smoke(name) {
  if (name === 'ws') {
    const mod = await load('ws');
    if (!mod) return '加载失败';
    try {
      const wss = new mod.WebSocketServer({ noServer: true });
      wss.close();
      return '';
    } catch (e) {
      return `实例化失败：${e.message}`;
    }
  }
  if (name === 'silk-wasm') {
    const mod = await load('silk-wasm');
    if (!mod) return '加载失败';
    if (typeof mod.encode !== 'function') return '模块里没有 encode()';
    return '';
  }
  return '';
}

/**
 * 加载一个依赖。装不上/没装都返回 null（调用方按「缺依赖」处理，别抛）。
 *
 * 先 `require`，失败再试 `import()`：两个包现在都是 CJS，
 * 但 `silk-wasm` 同时提供 `.mjs`，将来若把 `main` 换成 ESM，这里不至于炸。
 */
export async function load(name) {
  if (!Object.hasOwn(WHITELIST, name)) return null;
  if (loaded.has(name)) return loaded.get(name);

  const r = req();
  let mod = null;
  try {
    mod = r(name);
  } catch (e) {
    const code = String(e?.code ?? '');
    if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE') {
      try {
        mod = await import(pathToFileURL(r.resolve(name)).href);
      } catch (e2) {
        log.warn(`加载 ${name} 失败：${e2.message}`);
        mod = null;
      }
    } else {
      log.debug(`加载 ${name} 失败：${e.message}`);
      mod = null;
    }
  }
  loaded.set(name, mod);
  return mod;
}

/**
 * 清缓存：装/卸之后必须调，否则还拿着旧模块。
 *
 * **两层都要清**：自己的 `loaded` 和 Node 的 `require.cache`。
 * 只清前者的话，`remove()` 删掉文件后再 `require` 仍会命中 Node 的缓存，
 * 表现是「卸载了但还是能加载」——面板上点了重装也还是旧代码。
 */
export function resetCache() {
  loaded.clear();
  const r = req();
  for (const name of Object.keys(WHITELIST)) {
    try {
      delete r.cache[r.resolve(name)];
    } catch {
      // 没装/解析不到：本来就没有缓存可删
    }
  }
}

/**
 * 安装。**只装白名单里的**，装完做一次冒烟。
 *
 * 串行化：后一次调用排队等前一次，避免两个请求同时跑 npm 把目录写坏。
 *
 * @param {string[]} names
 * @returns {Promise<{ok:boolean, installed:string[], error:string, status:object}>}
 */
export function install(names) {
  const run = async () => {
    const picked = pickPackages(names);
    if (!picked.length) throw new Error('没有要安装的依赖');

    const dir = depsDir();
    await fs.mkdir(dir, { recursive: true });

    /**
     * **先写 package.json 再调安装器**。
     *
     * `ensurePluginDeps` 是「读 dir/package.json 决定装什么」，文件不存在
     * 它会认为「没有依赖」直接跳过——顺序反了就是「点了安装但什么都没装」。
     *
     * **必须合并已有依赖**：npm 7+ 的 `npm install` 会按 package.json 做 prune，
     * 只写本次这两个包的话，先装 ws 再装 silk-wasm 会把 ws 删掉，
     * 而且返回还是 ok。键排序是为了让内容哈希稳定，避免每次都重装。
     */
    let existing = {};
    try {
      const cur = JSON.parse(await fs.readFile(pkgFile(), 'utf8'));
      for (const [k, v] of Object.entries(cur?.dependencies ?? {})) {
        // 只保留白名单里的：历史遗留的怪名字不往新清单里带
        if (Object.hasOwn(WHITELIST, k)) existing[k] = String(v);
      }
    } catch {
      // 首次安装：没有旧文件很正常
    }
    const merged = { ...existing };
    for (const name of picked) merged[name] = WHITELIST[name].range;
    const dependencies = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
    await fs.writeFile(
      pkgFile(),
      `${JSON.stringify({ name: 'roost-onebot-deps', private: true, dependencies }, null, 2)}\n`,
      'utf8',
    );

    log.info(`安装 OneBot 依赖：${picked.join('、')}（目录 ${dir}）`);
    await ensurePluginDeps({ dir, manifest: {}, enabled: true, log });

    resetCache();
    const errors = await verify(picked);

    const st = await status();
    return {
      ok: errors.length === 0,
      installed: picked,
      error: errors.join('；'),
      status: st,
    };
  };

  const p = installChain.then(run, run);
  // 失败不把链条卡死：下一次调用照样能跑
  installChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/**
 * 卸载（「装坏了重装」用）。
 *
 * 只删 `node_modules/<pkg>` 与 package.json 里的那一项，不跑 `npm uninstall`——
 * 少一次网络往返，也不会因为 npm 不在而失败。
 */
export function remove(names) {
  const run = async () => {
    const picked = pickPackages(names);
    for (const name of picked) {
      await fs.rm(path.join(depsDir(), 'node_modules', name), { recursive: true, force: true });
    }
    /**
     * **必须删掉哈希标记**。
     *
     * `ensurePluginDeps` 用 `.deps.json` 里的哈希判断「依赖没变，跳过安装」。
     * 我们删了 node_modules 却没删标记，下一次 install 会被判定「没变化」直接跳过，
     * 表现是「点了安装、也返回成功，但包根本没装回来」——这个坑真踩过。
     */
    await fs.rm(path.join(depsDir(), '.deps.json'), { force: true });
    resetCache();
    // package.json 里去掉这些项，避免下次 install 之外的地方读到脏数据
    try {
      const j = JSON.parse(await fs.readFile(pkgFile(), 'utf8'));
      for (const name of picked) delete j.dependencies?.[name];
      await fs.writeFile(pkgFile(), `${JSON.stringify(j, null, 2)}\n`, 'utf8');
    } catch {
      // 文件本来就不在：没什么可清
    }
    return status();
  };
  const p = installChain.then(run, run);
  installChain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

/** 面板显示用：给一行「手动装」的命令，装不上时用户能自己来 */
export function manualCommand(names = ['ws']) {
  const picked = pickPackages(names).join(' ');
  return `npm i ${picked} --prefix data/deps/onebot --omit=dev --no-audit --no-fund`;
}
