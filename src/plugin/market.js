import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../logger.js';
import { fetchAndExtract, branchTarballUrl } from '../tarball.js';
import { DIRS } from '../paths.js';
import { hashDir } from '../hashdir.js';
// re-export 不会在本模块内绑定名字，内部还要用就必须单独 import
import { compareVersion } from '../semver.js';
import { fetchViaMirror, currentMirror } from '../mirror.js';
import { fetchGiteeTree } from '../gitee.js';

const log = createLogger('market');

/** 同一个索引地址同时只允许一个请求在飞 */
const indexInFlight = new Map();

/** 官方插件仓库。改这里就能指向你自己的插件源 */
export const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost-plugins/main/index.json';

/**
 * 拉取插件市场的索引。
 *
 * 国内访问 raw.githubusercontent.com 经常抖，所以做了三层兜底：
 *   1. **并发去重**：同一时刻多个调用只发一个请求（启动时的自动检查 + 用户点市场
 *      会同时触发，并发打 GitHub 容易一起超时）
 *   2. **重试**：失败再试一次
 *   3. **本地缓存**：成功后存一份到 data/，网络挂了就用缓存，
 *      并在返回值里标 `stale: true` 让面板提示「离线数据」。
 *
 * 有缓存这一层很关键——不然网络一抖，用户连"我装过哪些插件"都看不到。
 */
/**
 * 市场地址必须是 https（本机调试除外）。
 *
 * 面板的 `?source=` 参数直接交给服务端 fetch，以前不限制 scheme 和 host：
 * `?source=http://127.0.0.1:9/x` 就能让服务端去打内网，
 * 云环境的 169.254.169.254 元数据接口同理。这里统一挡在入口。
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function assertSafeIndexUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`插件市场地址不是合法 URL：${raw}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol === 'https:') return u;
  // 本机 http 只作为「显式开发开关」放行：默认关闭，避免面板可达时被拿来做内网探测。
  if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(host) && process.env.ROOST_ALLOW_LOCAL_INDEX === '1') {
    return u;
  }
  const hint =
    u.protocol === 'http:' && LOOPBACK_HOSTS.has(host) ? '（本机调试请设 ROOST_ALLOW_LOCAL_INDEX=1）' : '';
  throw new Error(`插件市场地址必须用 https${hint}：${u.protocol}//${host}`);
}

export async function fetchIndex(url = DEFAULT_INDEX_URL) {
  const key = String(url || DEFAULT_INDEX_URL);
  assertSafeIndexUrl(key);
  const running = indexInFlight.get(key);
  if (running) return running;

  const task = fetchIndexOnce(key)
    .then(async (data) => {
      await writeIndexCache(key, data).catch(() => {});
      return data;
    })
    .catch(async (e) => {
      // 网络挂了：有缓存就用缓存，但要让调用方知道这是旧的
      const cached = await readIndexCache(key).catch(() => null);
      if (cached) {
        log.warn(`拉取插件市场失败（${e.message}），改用本地缓存（${cached.age}）`);
        return { ...cached.data, stale: true, staleAge: cached.age };
      }
      throw e;
    })
    .finally(() => indexInFlight.delete(key));

  indexInFlight.set(key, task);
  return task;
}

/* ---------------- 索引缓存 ---------------- */

function cachePath() {
  return path.join(DIRS.data, 'market-cache.json');
}

async function writeIndexCache(url, data) {
  await fs.mkdir(DIRS.data, { recursive: true });
  await fs.writeFile(
    cachePath(),
    JSON.stringify({ url, at: Date.now(), data }, null, 0),
    'utf8',
  );
}

async function readIndexCache(url) {
  const raw = await fs.readFile(cachePath(), 'utf8');
  const obj = JSON.parse(raw);
  // 换了市场源，旧缓存不能用
  if (obj.url !== url) return null;
  if (!Array.isArray(obj.data?.plugins)) return null;

  const mins = Math.round((Date.now() - obj.at) / 60000);
  const age = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
  return { data: obj.data, age };
}

async function fetchIndexOnce(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));

    /**
     * 加个时间戳参数，绕开 CDN / 代理的缓存。
     *
     * 不加的话会出现这种连环套：索引是缓存的旧版、tarball 是新的，
     * 于是 sha256 校验失败，用户以为仓库坏了。
     * （实测过：`curl` 走代理拿到新索引、Node 直连拿到旧的，同一台机器。）
     *
     * 重试那一轮参数不同，等于强制要一份新的。
     */
    const bust = `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}-${attempt}`;

    let res;
    try {
      // 走下载源：直连超时会自动换镜像（见 src/mirror.js）
      res = await fetchViaMirror(bust, { signal: AbortSignal.timeout(20000) });
    } catch (e) {
      lastErr = new Error(`连不上插件市场：${e.message}`);
      continue;
    }
    if (!res.ok) {
      lastErr = new Error(`插件市场返回 HTTP ${res.status}`);
      // 4xx 是地址错了，重试没意义
      if (res.status >= 400 && res.status < 500) throw lastErr;
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('插件市场返回的不是合法 JSON');
    }
    if (!Array.isArray(data?.plugins)) throw new Error('插件市场索引格式不对（缺少 plugins 数组）');

    return data;
  }
  throw lastErr ?? new Error('连不上插件市场');
}


/**
 * 安装一个插件。
 *
 * 下载仓库的 tarball 到临时目录，再把插件目录整个复制进 plugins/。
 *
 * **不用 git**：之前用 `git clone`，理由是「项目本身是 clone 下来的，git 一定在」。
 * 这个假设是错的——很多人下载 zip 解压用，机器上没装 git，
 * 于是安装插件直接报 `spawn git ENOENT`。改成 tarball 直链后不需要任何外部命令。
 *
 * @param {object} p
 * @param {object} p.entry    index.json 里的一条
 * @param {string} p.pluginsDir 目标插件目录
 * @param {string} [p.repo]   仓库，如 tdcq9594/qq-bot-roost-plugins
 * @param {string} [p.branch] 分支
 * @param {(id:string)=>boolean} [p.exists] 判断插件是否已存在
 * @param {string|null} [p.sha256] 索引里给的仓库包校验值，有就验
 * @returns {Promise<{id:string, dir:string}>}
 */
/**
 * 校验失败时说清楚：到底是「索引过期」还是「内容真被改了」。
 *
 * 这两种情况用户要做的事完全不同：
 *   · 索引过期 → 刷新市场 / 重启，重试即可（我们自己的缓存问题）
 *   · 内容不符 → 仓库被改动，该去查，不该硬装
 *
 * 以前两种情况都说「可能仓库被改动」，用户一头雾水——明明刚发的版本。
 */
async function shaMismatchError(entry, dir, got) {
  const actualVer = await readVersionLoose(dir);
  const idxVer = String(entry.version ?? '');
  if (actualVer && idxVer && actualVer !== idxVer) {
    return new Error(
      '插件市场索引过期了\n' +
        `  索引里是 v${idxVer}，实际下载到 v${actualVer}\n` +
        '  面板「插件 → 市场」点「刷新」，或重启程序后重试。\n' +
        '  已中止，原有插件未动。',
    );
  }
  return new Error(
    '插件内容校验失败（sha256 不匹配）\n' +
      `  索引 ${entry.sha256}\n  实际 ${got}\n` +
      '  索引和实际内容对不上，可能是仓库被改动。已中止，原有插件未动。',
  );
}

/**
 * 只读文件里的 version，不 import 模块。
 *
 * 不用 `readPluginVersion`：那个会 import 插件模块，对「刚下载到临时目录、
 * 还没信任过」的代码执行顶层语句，没必要。
 */
async function readVersionLoose(dir) {
  try {
    const s = await fs.readFile(path.join(dir, 'index.js'), 'utf8');
    const m = s.match(/^\s*version:\s*['"]([^'"]+)['"]/m);
    if (m) return m[1];
  } catch {
    /* 没有 index.js，试试 plugin.json */
  }
  try {
    const j = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    return j.version ? String(j.version) : null;
  } catch {
    return null;
  }
}

/** 插件安装时用，逻辑同 installPlugin 里的校验 */
export async function verifyPluginDir(entry, dir) {
  if (!entry?.sha256) return;
  const got = await hashDir(dir);
  if (got !== String(entry.sha256).toLowerCase()) {
    throw await shaMismatchError(entry, dir, got);
  }
}

/**
 * 把插件仓库的内容拉到临时目录。市场和框架更新共用一套下载源逻辑。
 *
 * 两条路：
 *   · GitHub（默认）：tarball 直链，走 fetchViaMirror（auto 模式下会自动换源）
 *   · Gitee：没有可用的 archive 直链，走 git trees 列清单 + raw 逐个拉
 *
 * auto 模式下 GitHub 失败会自动切 Gitee——面板选 auto 时的承诺行为。
 *
 * @param {object} o
 * @param {string} o.repo     `owner/name`
 * @param {string} o.branch   分支
 * @param {string} o.destDir  临时目录
 * @param {string[]} [o.only] 只拉这些路径前缀（装单个插件用，少拉一半文件）
 * @param {string|null} [o.expectSha256] 整包 sha256（仅 tarball 路径能验）
 * @param {number} [o.timeoutMs]
 * @param {(msg:string)=>void} [o.onRetry]
 */
async function downloadRepoContents({
  repo,
  branch,
  destDir,
  only = null,
  expectSha256 = null,
  timeoutMs = 120000,
  onRetry,
}) {
  const id = currentMirror().id;
  const token = currentMirror().giteeToken;

  if (id === 'gitee') {
    return fetchGiteeTree({ repo, ref: branch, destDir, only, timeoutMs, token });
  }

  try {
    return await fetchAndExtract(branchTarballUrl(repo, branch), destDir, {
      expectSha256,
      timeoutMs,
      onRetry,
      // 下载源可在面板切换，国内直连 GitHub 经常断
      fetcher: (u, init) => fetchViaMirror(u, init),
    });
  } catch (e) {
    if (id !== 'auto') throw e;
    log.warn(`GitHub 下载失败（${e.message}），改用 Gitee 镜像`);
    // 清掉可能写了一半的残留，再整树重拉
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    return fetchGiteeTree({ repo, ref: branch, destDir, only, timeoutMs, token });
  }
}

export async function installPlugin({ entry, pluginsDir, repo, branch = 'main', exists, sha256 = null }) {
  const id = String(entry?.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`插件 id 不合法：${id}`);
  if (!entry?.path) throw new Error('索引里缺少 path 字段');
  if (!repo) throw new Error('索引里缺少 repo 字段');

  if (exists?.(id)) throw new Error(`插件 ${id} 已经装过了，先删掉再装`);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-plugin-'));
  try {
    log.info(`开始下载插件 ${id}（来自 ${repo}@${branch}）`);
    await downloadRepoContents({
      repo,
      branch,
      destDir: tmp,
      // 只拉这个插件的目录：Gitee 源下一次能少拉一半文件
      only: [`${entry.path}/`],
      // 索引里带了校验值就验；没带会在 tarball 那边 warn 一句
      expectSha256: sha256,
      timeoutMs: 120000,
      onRetry: (m) => log.warn(m),
    });

    const src = path.join(tmp, entry.path);
    // 防路径穿越：解析后必须仍在 clone 目录内
    const resolved = path.resolve(src);
    if (!resolved.startsWith(path.resolve(tmp) + path.sep)) {
      throw new Error('索引里的 path 指向了仓库外部，已拒绝');
    }

    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`仓库里找不到目录 ${entry.path}`);

    // 必须能识别出是哪种插件
    const files = await fs.readdir(resolved);
    if (!files.includes('index.js') && !files.includes('plugin.json')) {
      throw new Error('这个目录既没有 index.js 也没有 plugin.json，不是合法插件');
    }

    /**
     * 内容校验：索引里存了插件目录的指纹，这里算一遍对上才装。
     *
     * 这是唯一能真正实现的校验方式——GitHub 的分支 tarball 是现场打包的，
     * 没有稳定的压缩包哈希可对。校验放在**拷贝进 plugins/ 之前**，
     * 对不上就什么都不留。
     */
    if (entry.sha256) {
      const got = await hashDir(resolved);
      if (got !== String(entry.sha256).toLowerCase()) {
        throw await shaMismatchError(entry, resolved, got);
      }
      log.info(`插件 ${id} 内容 sha256 校验通过`);
    } else {
      log.warn(`索引里没有 ${id} 的 sha256，本次安装未做内容校验`);
    }

    const dest = path.join(pluginsDir, id);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.cp(resolved, dest, { recursive: true });

    log.info(`插件 ${id} 已装到 ${dest}`);
    return { id, dir: dest };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 把市场索引和本地已装插件对上，给面板用。
 * @param {object[]} indexPlugins
 * @param {Set<string>} installedIds
 */
export function mergeWithInstalled(indexPlugins, installedIds) {
  return indexPlugins.map((p) => ({
    ...p,
    installed: installedIds.has(p.id),
  }));
}

/* ------------------------------------------------------------------ */
/* 版本比较与更新检测                                                  */
/* ------------------------------------------------------------------ */

/**
 * 比较两个语义化版本号。
 *
 * 实现在 `src/semver.js`，和框架更新、插件兼容校验共用一份。
 * 这里再导出一次，是为了不破坏既有的导入路径。
 */
export { compareVersion } from '../semver.js';

/**
 * 对照市场索引，找出本地有新版可用的插件。
 *
 * @param {object[]} indexPlugins 市场索引
 * @param {Object<string,string>} localVersions 本地已装插件的版本 { id: version }
 * @returns {Array<{id:string, current:string, latest:string, entry:object}>}
 */
export function detectUpdates(indexPlugins, localVersions = {}) {
  const out = [];
  for (const entry of indexPlugins ?? []) {
    const cur = localVersions[entry.id];
    // 没装、或本地版本号缺失/不合法 → 不提示，让用户自己决定
    if (!cur) continue;
    if (compareVersion(cur, entry.version) < 0) {
      out.push({ id: entry.id, current: cur, latest: entry.version, entry });
    }
  }
  return out;
}

/**
 * 同步插件仓库：拉一次索引 + clone 一次源码，拿到所有插件的本地副本。
 *
 * 为什么不是每个插件单独 clone：N 个插件要更新就是 N 次完整 clone，
 * 每次几十秒。参考 BetterGI 的 ScriptRepoUpdater——先拉中央仓库，
 * 再从里面逐个检出。调用方用完必须调 `cleanupRepo()`。
 *
 * @returns {Promise<{tmp:string, index:object}>}
 */
export async function syncRepo({ repo, branch = 'main', indexUrl } = {}) {
  const index = await fetchIndex(indexUrl);
  if (!repo) repo = index.repo;
  if (!repo) throw new Error('索引里缺少 repo 字段，无法同步');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-repo-'));
  try {
    log.info(`正在下载插件仓库 ${repo}@${branch}…`);
    await downloadRepoContents({
      repo,
      branch,
      destDir: tmp,
      // 索引里带了校验值就验；没带会在 tarball 那边 warn 一句
      expectSha256: index?.archive?.sha256 ?? index?.sha256 ?? null,
      timeoutMs: 180000,
      onRetry: (m) => log.warn(m),
    });
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new Error(`下载插件仓库失败：${e.message}`);
  }
  return { tmp, index };
}

/** 删掉 syncRepo 拉下来的临时目录 */
export async function cleanupRepo(tmp) {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}

/** 校验仓库里的某个目录确实是插件，返回其绝对路径 */
async function resolvePluginDir(tmp, entry) {
  if (!entry?.path) throw new Error('索引里缺少 path 字段');
  const resolved = path.resolve(path.join(tmp, entry.path));
  // 防路径穿越：解析后必须仍在 clone 目录内
  if (!resolved.startsWith(path.resolve(tmp) + path.sep)) {
    throw new Error('索引里的 path 指向了仓库外部，已拒绝');
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`仓库里找不到目录 ${entry.path}`);
  const files = await fs.readdir(resolved);
  if (!files.includes('index.js') && !files.includes('plugin.json')) {
    throw new Error('这个目录既没有 index.js 也没有 plugin.json，不是合法插件');
  }
  return resolved;
}

/**
 * 从已同步的仓库里更新一批插件。
 *
 * 每个插件都是「先备份到临时目录 → 复制新的 → 失败则还原」，
 * 单个插件失败不影响其他插件。备份放在调用方传入的 tmp 里，
 * 不放在 plugins/ 旁边——否则会被 loader 扫成幽灵插件。
 *
 * @param {object} p
 * @param {string} p.tmp        syncRepo 返回的临时目录
 * @param {object} p.index      syncRepo 返回的索引
 * @param {string} p.pluginsDir 目标插件目录
 * @param {string[]} [p.ids]    只更新这些；不传则更新全部「有新版」的
 * @param {Object<string,string>} [p.localVersions] 本地版本，用于判断谁有新版
 * @returns {Promise<{updated:Array, skipped:Array, failed:Array}>}
 */
export async function updatePlugins({ tmp, index, pluginsDir, ids, localVersions = {} }) {
  const want = ids?.length ? new Set(ids) : null;
  const result = { updated: [], skipped: [], failed: [] };

  for (const entry of index.plugins ?? []) {
    if (want && !want.has(entry.id)) continue;

    const dest = path.join(pluginsDir, entry.id);
    const cur = localVersions[entry.id];

    // 本地没装 → 不是更新，跳过（要走 install）
    if (!cur) {
      result.skipped.push({ id: entry.id, reason: '本地未安装' });
      continue;
    }
    // 没有新版 → 跳过
    if (compareVersion(cur, entry.version) >= 0) {
      result.skipped.push({ id: entry.id, reason: `已是最新 ${cur}` });
      continue;
    }

    /**
     * 备份放在插件目录旁边，**不能**放 os.tmpdir()。
     * Windows 上项目在 D:、TEMP 在 C: 时，fs.rename 跨盘会抛 EXDEV，
     * 结果是市场更新全部失败——而且失败还被 catch 吞成一句 warn。
     */
    const backup = path.join(pluginsDir, `.bak-${entry.id}`);
    try {
      const src = await resolvePluginDir(tmp, entry);

      /**
       * 更新也要校验内容，和首次安装一样。
       *
       * 以前只在 `installPlugin` 里校验，更新路径漏了——那等于
       * 「第一次装的时候小心，以后随便覆盖」，供应链校验的意义就没了。
       * 校验放在**动旧目录之前**：对不上就什么都不碰，用户手上的插件还是好的。
       */
      if (entry.sha256) {
        const got = await hashDir(src);
        if (got !== String(entry.sha256).toLowerCase()) {
          throw await shaMismatchError(entry, src, got);
        }
      }

      const hadOld = await fs.stat(dest).catch(() => null);
      if (hadOld) await fs.rename(dest, backup);

      try {
        await fs.cp(src, dest, { recursive: true });
      } catch (e) {
        // 复制失败：把旧的放回去，别让用户丢插件
        await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
        await fs.rename(backup, dest).catch(() => {});
        throw new Error(`复制失败，已还原：${e.message}`);
      }

      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
      result.updated.push({ id: entry.id, from: cur, to: entry.version });
      log.info(`插件 ${entry.id} 已更新 ${cur} → ${entry.version}`);
    } catch (e) {
      result.failed.push({ id: entry.id, error: e.message });
      log.warn(`插件 ${entry.id} 更新失败: ${e.message}`);
    }
  }

  // 明确要更新但市场里没有的，也报告出来
  if (want) {
    const inIndex = new Set((index.plugins ?? []).map((p) => p.id));
    for (const id of want) {
      if (!inIndex.has(id)) result.failed.push({ id, error: '市场里没有这个插件' });
    }
  }

  return result;
}

/** 读本地插件目录里声明的版本号，读不到返回空串 */
export async function readPluginVersion(dir) {
  // 内建插件：import 模块拿 default 导出（只 import 不执行 setup）
  for (const f of ['index.js', 'index.mjs', 'main.js']) {
    const p = path.join(dir, f);
    if (await fs.access(p).then(() => true, () => false)) {
      try {
        const mod = await import(`${pathToFileURL(p).href}?v=${Date.now()}`);
        const meta = mod.default ?? mod.plugin;
        if (meta?.version) return String(meta.version);
      } catch {
        /* 读不出来就算了，用 plugin.json 兜底 */
      }
      break;
    }
  }
  // 外部插件：读 plugin.json
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    if (raw?.version) return String(raw.version);
  } catch {
    /* 没有就不是外部插件 */
  }
  return '';
}
