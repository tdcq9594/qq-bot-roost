/**
 * 框架自身更新
 * =============
 *
 * 从 GitHub 检查新版本、下载、替换代码。
 *
 * **保守是这里的第一原则**。更新会覆盖代码，出问题用户就再也起不来了。
 * 所以：
 *   1. 只替换代码目录，**绝不碰** config/ data/ logs/ plugins/
 *   2. 替换前把整个代码目录备份到 data/backups/，失败自动还原
 *   3. 逐项校验新版本里确实有 src/main.js，否则拒绝更新
 *   4. 不自动重启——让用户自己重启，他能看到更新后的日志
 *
 * 下载用 GitHub 的 tarball 接口，不依赖 git（用户可能是下载 zip 用的，没装 git）。
 */
import fs from 'node:fs/promises';
import { compareVersion } from './semver.js';
import path from 'node:path';
import { createLogger } from './logger.js';
import { fetchAndExtract } from './tarball.js';
import { fetchViaMirror, checkViaMirrorChyan } from './mirror.js';
import { ROOT } from './config.js';

const log = createLogger('update');

/** 仓库信息。换成自己的 fork 就改这里 */
const REPO = 'tdcq9594/qq-bot-roost';

/** 允许被更新覆盖的顶层条目。**用户数据一个都不在里面** */
const CODE_ENTRIES = ['src', 'web', 'test', 'docs', 'package.json', 'README.md', 'LICENSE', 'start.bat'];

/** 绝对不能删的目录，双保险 */
const PROTECTED = new Set(['config', 'data', 'logs', 'plugins', 'node_modules', '.git']);

/**
 * 比较语义化版本。
 *
 * 实现放在 `src/semver.js` —— 插件市场、框架更新、插件版本兼容校验
 * 三处共用一份，避免出现「市场说能升、更新器说不能」这种自相矛盾。
 * 这里再导出一次，是为了不破坏既有的导入路径。
 */
export { compareVersion } from './semver.js';

/** 读当前版本 */
export async function currentVersion() {
  try {
    const raw = await fs.readFile(path.join(ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 代码已经换成新版、但进程还在跑旧代码？
 *
 * 更新只替换磁盘上的文件，正在运行的进程还是旧代码。判断依据：
 * **package.json 的修改时间晚于本进程的启动时间**，说明更新发生在启动之后。
 *
 * 为什么需要这个：不重启的话「检查更新」会说「已是最新 v0.6.9」，
 * 而用户实际用的还是 0.6.7 的行为——看起来像更新没成功，于是反复点。
 * 把这个状态说出来，用户才知道该做的是重启，不是再点一次。
 *
 * 留 2 秒容差：解压/拷贝和 stat 之间总有毫秒级误差。
 */
async function updatedButNotRestarted() {
  try {
    const st = await fs.stat(path.join(ROOT, 'package.json'));
    const startedAt = Date.now() - process.uptime() * 1000;
    return st.mtimeMs > startedAt + 2000;
  } catch {
    return false;
  }
}

/**
 * 查最新版本。
 *
 * **不用 GitHub API**：未认证的 API 每小时只有 60 次，而且是按 IP 算的，
 * 家用宽带 / 共享出口很容易被限成 403。用户点一下「检查更新」就失败，体验很差。
 *
 * 改用 `releases/latest` 的 302 重定向——它会把 Location 指到
 * `.../releases/tag/v0.5.1`，从中取版本号。这个路径**不消耗 API 配额**，
 * 只要仓库是公开的就能用。
 *
 * 代价是拿不到 release notes 和 tarball_url，两个都自己拼：
 *   - tarball: `.../archive/refs/tags/v<版本>.tar.gz`（公开直链）
 *   - notes：让用户点 htmlUrl 自己看
 */
/**
 * 查最新版本，并顺带说明「是不是已经更新了但还没重启」。
 *
 * 包一层而不是往 checkUpdate 里塞：里面有好几个返回分支（MirrorChyan /
 * 主站 302 / API 兜底 / 404 / 失败），每个都手写一遍 needsRestart 迟早漏一个。
 */
export async function checkUpdate() {
  const needsRestart = await updatedButNotRestarted();
  const r = await checkUpdateCore();
  return { ...r, needsRestart };
}

async function checkUpdateCore() {
  const cur = await currentVersion();

  /**
   * 先问 MirrorChyan（配了 res_id 才启用）。
   *
   * 这是 BGI / MAA / M9A 那一套的做法：CDN 覆盖国内外、不限速、不消耗
   * GitHub 配额，用来**查版本**最省事。下载仍然走镜像 tarball——
   * 它分发的包格式由上传方决定，不一定是我们能解的 tar.gz。
   */
  const chyan = await checkViaMirrorChyan(cur);
  if (chyan && !chyan.ok) log.warn(`MirrorChyan 检查失败，改问 GitHub：${chyan.error}`);
  if (chyan?.ok && chyan.version) {
    return buildResult(cur, `v${chyan.version}`, {
      source: 'mirrorchyan',
      releaseNote: chyan.releaseNote,
    });
  }

  let res = null;
  let lastErr = null;
  // 国内访问 github.com 经常抖（代理、DNS），重试一次再报错
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      res = await fetchViaMirror(`https://github.com/${REPO}/releases/latest`, {
        method: 'GET',
        redirect: 'manual', // 要自己看 Location
        headers: { 'User-Agent': 'qq-bot-roost-updater' },
        signal: AbortSignal.timeout(8000),
      });
      break;
    } catch (e) {
      lastErr = e;
      res = null;
    }
  }

  if (!res) {
    // 连不上主站：还有一次机会——问 API（走的是另一套域名和 CDN）
    try {
      return buildResult(cur, await fetchLatestTagViaApi(), { source: 'github-api' });
    } catch (e) {
      return {
        ok: false,
        current: cur,
        error: `连不上 GitHub：${lastErr?.message ?? e.message}（换个下载源试试）`,
      };
    }
  }

  // 302 → Location: https://github.com/OWNER/REPO/releases/tag/v0.5.1
  const loc = res.headers.get('location') || '';
  const m = loc.match(/\/releases\/tag\/(v?[\d.]+)/);

  if (!m) {
    // 真的没有 release 时 GitHub 返回 404
    if (res.status === 404) {
      return { ok: true, current: cur, latest: cur, hasUpdate: false, note: '仓库还没有发布版本' };
    }
    /**
     * 3xx 但取不到 tag：可能被重定向到别处（登录页、限流页），
     * 也可能是镜像把 302 变成了 200 直出 HTML。再问一次 API，
     * 它返回的是 JSON，不受重定向影响。
     */
    try {
      return buildResult(cur, await fetchLatestTagViaApi(), { source: 'github-api' });
    } catch (e) {
      return {
        ok: false,
        current: cur,
        error: `无法解析最新版本（HTTP ${res.status}）：${e.message}`,
      };
    }
  }

  return buildResult(cur, m[1], { source: 'github' });
}

/**
 * 问 GitHub API 要最新 tag。
 * 会消耗匿名配额（60 次/小时/IP），只在主站走不通时兜底用。
 */
async function fetchLatestTagViaApi() {
  const res = await fetchViaMirror(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: {
      'User-Agent': 'qq-bot-roost-updater',
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub API 返回 HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  const tag = String(data?.tag_name ?? '');
  if (!tag) throw new Error('GitHub API 没返回 tag_name');
  return tag;
}

/** 把 tag 组装成面板要的结构 */
function buildResult(cur, tag, extra = {}) {
  const latest = String(tag).replace(/^v/, '');
  return {
    ok: true,
    current: cur,
    latest,
    hasUpdate: compareVersion(cur, latest) < 0,
    tag,
    htmlUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    // 公开直链，不需要 API；实际下载时会按「下载源」设置改写
    tarball: `https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz`,
    ...extra,
  };
}

/* ---------------- 下载与解包 ---------------- */

/**
 * 下载 tarball 并解包到临时目录。
 * 解析逻辑统一放在 src/tarball.js，插件市场和框架更新共用一份，
 * 免得两处 tar 解析以后跑偏。
 */
async function downloadTo(tmpDir, tarballUrl, sha256 = null) {
  await fetchAndExtract(tarballUrl, tmpDir, {
    // 版本信息里带了 sha256 就校验（发布说明里没写就是 null，只 warn）
    expectSha256: sha256,
    timeoutMs: 120000,
    retries: 1,
    onRetry: (m) => log.warn(m),
    // 走下载源：面板里选了镜像或 auto，这里就自动用上
    fetcher: (u, init) => fetchViaMirror(u, init),
  });
  return tmpDir;
}


/**
 * 只保留最近 N 份更新备份，老的删掉。
 * 每份约 1MB（整个代码目录），不清理会一直涨。
 */
async function pruneBackups(keep = 3) {
  const dir = path.join(ROOT, 'data', 'backups');
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }

  const items = [];
  for (const name of names) {
    const p = path.join(dir, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isDirectory()) continue;
    items.push({ name, p, at: st.mtimeMs });
  }
  if (items.length <= keep) return;

  // 按修改时间倒序，保留前 keep 个
  items.sort((a, b) => b.at - a.at);
  for (const it of items.slice(keep)) {
    await fs.rm(it.p, { recursive: true, force: true }).catch(() => {});
    log.info(`清理旧备份 ${it.name}`);
  }
}

/**
 * 启动时检查「上次更新有没有半路被打断」，有就回滚。
 *
 * 只有一种情况会留下标记：替换过程中进程被强杀（断电、任务管理器结束）。
 * 那时 src/ 可能是半新半旧，直接启动会在各种莫名其妙的地方报错。
 *
 * 回滚来源是标记里记的备份目录，幂等——回滚完删标记，下次不会再跑。
 *
 * @returns {Promise<{recovered:boolean, from?:string, to?:string, error?:string}>}
 */
export async function recoverInterruptedUpdate() {
  /**
   * 这里用 `ROOT/data` 而不是 `DIRS.data`，是有意的。
   *
   * 更新相关的临时文件和备份必须**跟代码在同一棵目录树下**：
   * 备份是用来还原 `src/` 的，放到 ROOST_HOME 指的临时目录里，
   * 一次重启就没了，还原就成了一句空话。
   */
  const marker = path.join(ROOT, 'data', '.update-pending.json');
  let info;
  try {
    info = JSON.parse(await fs.readFile(marker, 'utf8'));
  } catch {
    return { recovered: false }; // 没有标记，正常启动
  }

  const backupDir = info.backup;
  const hasBackup = backupDir
    ? await fs.access(backupDir).then(() => true, () => false)
    : false;

  if (!hasBackup) {
    // 备份都没了，回滚不了。留着标记只会每次启动都报一遍，删掉并说清楚。
    await fs.rm(marker, { force: true }).catch(() => {});
    const msg = `上次更新（${info.from} → ${info.to}）被打断，且备份目录已不存在，无法自动回滚`;
    log.error(msg);
    return { recovered: false, error: msg };
  }

  log.warn(
    `检测到上次更新（${info.from} → ${info.to}）没有完成，正在回滚到 ${info.from}…`,
  );
  let failed = 0;
  for (const name of CODE_ENTRIES) {
    const from = path.join(backupDir, name);
    const exists = await fs.access(from).then(() => true, () => false);
    if (!exists) continue;
    const to = path.join(ROOT, name);
    await fs.rm(to, { recursive: true, force: true }).catch(() => {});
    await fs.cp(from, to, { recursive: true }).catch(() => {
      failed += 1;
    });
  }

  if (failed) {
    const msg = `回滚时有 ${failed} 个目录没拷回去，备份仍在 ${path.relative(ROOT, backupDir)}`;
    log.error(msg);
    return { recovered: false, error: msg };
  }

  await fs.rm(marker, { force: true }).catch(() => {});
  log.info(`已回滚到 ${info.from}，可以正常启动`);
  return { recovered: true, from: info.from, to: info.to };
}

/**
 * 执行更新。
 *
 * @param {object} [info] checkUpdate() 的返回值；不传就现查
 * @returns {Promise<{ok:boolean, from:string, to:string, backup?:string, error?:string}>}
 */
/** 进程内互斥：面板点更新和自动更新同时来，会互相踩文件 */
let applying = false;

export async function applyUpdate(info) {
  if (applying) {
    throw new Error('已经有一个更新在进行中，等它完成再试');
  }
  applying = true;
  try {
    return await applyUpdateOnce(info);
  } finally {
    applying = false;
  }
}

async function applyUpdateOnce(info) {
  const cur = await currentVersion();
  const rel = info ?? (await checkUpdate());
  if (!rel.ok) throw new Error(rel.error || '检查更新失败');
  if (!rel.hasUpdate) throw new Error(`已经是最新版本 ${cur}`);
  if (!rel.tarball) throw new Error('没有可下载的包');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workDir = path.join(ROOT, 'data', `.update-${stamp}`);
  const backupDir = path.join(ROOT, 'data', 'backups', `${cur}-${stamp}`);

  log.info(`开始更新 ${cur} → ${rel.latest}`);
  await fs.mkdir(workDir, { recursive: true });

  try {
    await downloadTo(workDir, rel.tarball, rel.sha256 ?? null);

    // 校验：新版本里必须有 src/main.js，否则不是我们要的包
    const mainJs = path.join(workDir, 'src', 'main.js');
    await fs.access(mainJs).catch(() => {
      throw new Error('下载的包里没有 src/main.js，不是合法的框架包，已中止');
    });

    // 备份现有代码
    await fs.mkdir(backupDir, { recursive: true });
    for (const name of CODE_ENTRIES) {
      const src = path.join(ROOT, name);
      const has = await fs.access(src).then(() => true, () => false);
      if (has) await fs.cp(src, path.join(backupDir, name), { recursive: true });
    }
    log.info(`已备份到 ${path.relative(ROOT, backupDir)}`);

    // 只留最近 3 份备份。每份约 1MB，不清理的话更新十几次就几十 MB
    await pruneBackups(3).catch(() => {});

    // 替换
    /**
     * 写「正在更新」标记，成功后才删掉。
     *
     * 这一步是给「进程被强杀」准备的：rm + cp 是逐个目录覆盖的，
     * 中途断电 / 任务管理器结束进程，catch 根本不会执行，
     * 下次启动看到的就是一半新版一半旧版的 src/，报错都看不出原因。
     *
     * 为什么不直接「目录交换」（rename 旧的走、rename 新的进来）：
     * Windows 上重命名一个还有打开句柄的目录会 EBUSY，而 src/ 正是
     * 当前进程正在执行的那份代码。交换失败反而更危险。
     * 所以保留 rm+cp，用标记 + 启动时自愈来兜底。
     */
    const marker = path.join(ROOT, 'data', '.update-pending.json');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(
      marker,
      JSON.stringify({ from: cur, to: rel.latest, backup: backupDir, at: Date.now() }, null, 2),
      'utf8',
    );

    for (const name of CODE_ENTRIES) {
      if (PROTECTED.has(name)) continue; // 理论上不会进来，双保险
      const from = path.join(workDir, name);
      const exists = await fs.access(from).then(() => true, () => false);
      if (!exists) continue;
      const to = path.join(ROOT, name);
      await fs.rm(to, { recursive: true, force: true });
      await fs.cp(from, to, { recursive: true });
    }

    // 全部换完了，标记才算失效
    await fs.rm(marker, { force: true }).catch(() => {});

    log.info(`更新完成：${cur} → ${rel.latest}，重启后生效`);
    return { ok: true, from: cur, to: rel.latest, backup: path.relative(ROOT, backupDir) };
  } catch (e) {
    log.error(`更新失败，正在还原：${e.message}`);
    // 还原：把备份原样拷回去
    let failed = 0;
    for (const name of CODE_ENTRIES) {
      const from = path.join(backupDir, name);
      const exists = await fs.access(from).then(() => true, () => false);
      if (!exists) continue;
      const to = path.join(ROOT, name);
      await fs.rm(to, { recursive: true, force: true }).catch(() => {});
      await fs.cp(from, to, { recursive: true }).catch(() => {
        failed += 1;
      });
    }
    // 还原干净了才撤标记；还有目录没拷回去就留着，下次启动再试一遍
    if (!failed) {
      await fs.rm(path.join(ROOT, 'data', '.update-pending.json'), { force: true }).catch(() => {});
    } else {
      log.warn(`有 ${failed} 个目录没能还原，标记保留，下次启动会自动再试`);
    }
    return { ok: false, from: cur, to: rel.latest, error: e.message };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
