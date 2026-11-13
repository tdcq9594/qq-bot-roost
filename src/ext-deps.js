/**
 * 外接依赖（OneBot 兼容层 + 宿主协议共用）
 * ==========================================
 *
 * 两条出口都要 `ws`（WS 服务端），语音都要 `silk-wasm`（WAV → SILK）。
 * 所以这是一份**共用依赖**，不是 OneBot 专属——2026-11-13 之前它叫
 * `onebot/deps.js`、装在 `data/deps/onebot/`，现在目录和命名都改回中性。
 *
 * 两者都**不进** `package.json`——框架本体保持零依赖这条不变，
 * 用户在面板「外接 → 依赖」点「一键安装」才真正装到 `data/deps/ext/`。
 *
 * 三条硬原则：
 *
 *   1. **包名白名单**。只接受 `WHITELIST` 里的名字。面板传来的任意包名等于
 *      把「面板弱口令」升级成「远程代码执行」——这条不能让步。
 *   2. **装到数据目录**，不碰项目根 `node_modules`。否则「零依赖」变成假话，
 *      `npm ci` 会把它们清掉，用户 `git pull` 后行为还会变。
 *   3. **不在启动时自动装**。启动/后台只读状态；唯一的自动安装是
 *      **第一次真的要发语音**时补 `silk-wasm`（用户动作触发，见 `ensureSilk`）。
 *
 * 安装本身复用 `src/plugin/deps.js` 的 `ensurePluginDeps`：npm / pnpm 探测、
 * DSH 自带运行时、`--ignore-scripts`、超时、失败原因都已经在里面了，
 * 这里只补「白名单 + 状态 + 加载 + 冒烟 + 共用目录迁移」。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DIRS } from './paths.js';
import { createLogger } from './logger.js';
import { ensurePluginDeps } from './plugin/deps.js';

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

/** 装在哪：`data/deps/ext/`。两条出口共用，跟着数据走，升级不丢，也不污染仓库 */
export function depsDir() {
  return path.join(DIRS.data, 'deps', 'ext');
}

/**
 * 旧目录：2026-11-13 之前只有 OneBot 用，叫 `data/deps/onebot`。
 *
 * 用户已经在那装过 `ws` / `silk-wasm`，不能让他们重下一遍（尤其是网络不好
 * 的时候）。第一次访问时整目录搬过来，旧路径之后不再写。
 */
const legacyDir = () => path.join(DIRS.data, 'deps', 'onebot');

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

/** 旧目录只查一次：`null` = 还没查过 */
let migratedLegacy = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把旧目录 `data/deps/onebot/` 整体搬到 `data/deps/ext/`。
 *
 * 失败不致命：搬不动就继续用新目录（顶多让用户重装一次），
 * 但**绝不能删用户的旧目录**——那是他们装过的东西。
 */
async function migrateLegacy() {
  if (migratedLegacy !== null) return migratedLegacy;
  const from = legacyDir();
  const to = depsDir();
  try {
    const oldSt = await fs.stat(from).catch(() => null);
    if (!oldSt?.isDirectory()) {
      migratedLegacy = false;
      return false;
    }
    const newSt = await fs.stat(to).catch(() => null);
    if (!newSt) {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      log.info(`依赖目录已迁移：${from} → ${to}（宿主协议与 OneBot 共用）`);
      migratedLegacy = true;
      return true;
    }
    /** 两边都在（手动拷过 / 上次迁移一半断了）：以新目录为准，旧的原样留着 */
    log.info(`旧依赖目录还在（${from}），但新目录已存在，按新目录为准`);
    migratedLegacy = false;
    return false;
  } catch (e) {
    log.warn(`依赖目录迁移失败（继续用 ${to}）：${e.message}`);
    migratedLegacy = false;
    return false;
  }
}

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
  await migrateLegacy();
  const dir = depsDir();
  const r = req();
  const out = { dir, packages: {}, missing: [], required: [], ready: false, error: '' };

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

  /** 面板直接读它，省得每处自己再算一遍「必需项是不是都齐了」 */
  out.ready = out.required.every((n) => out.packages[n]?.resolvable);
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
 * 装完立刻冒烟，但**给文件系统一点时间**。
 *
 * npm 在 Windows 上返回后，杀毒扫描/写入延迟还能让新文件几毫秒内不可见；
 * 只验一次就判「装失败」，用户看到的就是「明明装上了却报错」。
 * 4 次 × 250ms 足够，不会让人等。
 */
async function verifyWithRetry(names, tries = 4, everyMs = 250) {
  let errors = await verify(names);
  for (let i = 1; i < tries && errors.length; i++) {
    await sleep(everyMs);
    resetCache();
    errors = await verify(names);
  }
  return errors;
}

/** 已加载过就直接给（不触发安装）：面板的「能不能发语音」要看这个 */
export function cached(name) {
  return loaded.get(name) ?? null;
}

/** silk 自动安装的单飞与冷却 */
let silkInflight = null;
let silkFailedAt = 0;
const SILK_RETRY_MS = 10 * 60_000;

/**
 * 第一次真的发语音时把 `silk-wasm` 装上。
 *
 * 为什么不放在启动时：它 1.5MB，还要走 npm；绝大多数用户根本不发语音，
 * 启动时自动装等于替所有人付一次下载 + 一次失败告警。放在**用户动作**
 * （发一条语音）触发，装完这条消息就能用，失败也只影响这一条。
 *
 * 三件事必须做对：
 *   · 单飞：一条消息里可能有多段语音，不能各起一个 npm；
 *   · 冷却：装失败后 10 分钟内不再试（否则每条消息都等一次超时）；
 *   · 不抛：返回 `null` 让调用方给「装不上，先发文字」的降级，而不是 500。
 *
 * @param {{reason?: string}} [o]
 * @returns {Promise<any|null>}
 */
export async function ensureSilk({ reason = '发语音' } = {}) {
  const mod = await load('silk-wasm');
  if (mod) return mod;
  if (silkInflight) return await silkInflight;
  if (Date.now() - silkFailedAt < SILK_RETRY_MS) return null;

  silkInflight = (async () => {
    try {
      log.info(`第一次${reason}，自动安装 silk-wasm（约 1.5MB，只装这一次）…`);
      const r = await install(['silk-wasm']);
      if (!r.ok) {
        silkFailedAt = Date.now();
        log.warn(`silk-wasm 自动安装失败：${r.error || '未知原因'}`);
        return null;
      }
      const m = await load('silk-wasm');
      if (!m) {
        silkFailedAt = Date.now();
        log.warn('silk-wasm 装上了但加载不了（看上面的加载日志）');
        return null;
      }
      log.info('silk-wasm 已就绪，接下来发语音不用再等');
      return m;
    } catch (e) {
      silkFailedAt = Date.now();
      log.warn(`silk-wasm 自动安装失败：${e?.message ?? e}`);
      return null;
    } finally {
      silkInflight = null;
    }
  })();
  return await silkInflight;
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
  await migrateLegacy();

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
    await migrateLegacy();
    await fs.mkdir(dir, { recursive: true });

    /**
     * 已经能 `require` 就别跑 npm。
     *
     * 2026-11-13 实机：面板连点「一键安装」，几秒内起了四份 npm 互相踩，
     * `node_modules` 被写到一半，冒烟读到「Cannot find module」→ 报安装失败，
     * 可几秒后文件又是好的。依赖在就跳过，返回 `skipped`，让调用方知道
     * 「这次没干活」，而不是假装装了一遍。
     */
    const already = [];
    for (const name of picked) {
      try {
        req().resolve(name);
        already.push(name);
      } catch {
        /* 真缺 */
      }
    }
    if (already.length === picked.length) {
      log.debug(`依赖已就绪，跳过安装：${picked.join('、')}`);
      return { ok: true, installed: [], skipped: true, error: '', status: await status() };
    }

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

    log.info(`安装外接依赖：${picked.join('、')}（目录 ${dir}）`);
    /**
     * `ensurePluginDeps` 的返回值**必须看**：
     *   · `installed` 为空 = 它按 `.deps.json` 判定「没变化」跳过了；
     *   · `warnings` 里才是 npm 失败的真实原因（超时、镜像 502、没有 npm）。
     * 以前这里直接丢掉返回值，用户只能看到一句「加载失败」，根本不知道
     * 是网络问题还是目录坏了。
     */
    let res = await ensurePluginDeps({ dir, manifest: {}, enabled: true, log });

    resetCache();
    let errors = await verifyWithRetry(picked);

    /**
     * 「标记说没事、磁盘上其实没有」的死角。
     *
     * `.deps.json` 是 `ensurePluginDeps` 的跳过依据；npm 装到一半被打断、
     * 用户手动删了 `node_modules`、杀毒软件隔离文件，都会留下「标记命中 +
     * 包不在」的状态。这时它连 npm 都不跑，怎么点都装不上。
     * 删掉标记强制重装一次，仍失败才如实报错。
     */
    if (errors.length && res.installed.length === 0) {
      await fs.rm(path.join(dir, '.deps.json'), { force: true });
      log.info(`依赖记录与磁盘不一致，强制重装：${picked.join('、')}`);
      res = await ensurePluginDeps({ dir, manifest: {}, enabled: true, log });
      resetCache();
      errors = await verifyWithRetry(picked);
    }

    const st = await status();
    const warn = (res.warnings ?? []).map((w) => String(w).replace(/\s+/g, ' ').trim()).filter(Boolean);
    return {
      ok: errors.length === 0,
      installed: picked,
      skipped: false,
      /**
       * 失败的文案要能直接回答「为什么」：
       * 先给冒烟结果，再带上安装器的原始原因（截断，避免把 600 字噪声塞进面板）。
       */
      error: [...errors, ...warn].filter(Boolean).join('；').slice(0, 800),
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
    await migrateLegacy();
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
  return `npm i ${picked} --prefix data/deps/ext --omit=dev --no-audit --no-fund`;
}
