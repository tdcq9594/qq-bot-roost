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
import path from 'node:path';
import { createLogger } from './logger.js';
import { fetchAndExtract } from './tarball.js';
import { ROOT } from './config.js';

const log = createLogger('update');

/** 仓库信息。换成自己的 fork 就改这里 */
const REPO = 'tdcq9594/qq-bot-roost';

/** 允许被更新覆盖的顶层条目。**用户数据一个都不在里面** */
const CODE_ENTRIES = ['src', 'web', 'test', 'docs', 'package.json', 'README.md', 'LICENSE', 'start.bat'];

/** 绝对不能删的目录，双保险 */
const PROTECTED = new Set(['config', 'data', 'logs', 'plugins', 'node_modules', '.git']);

/**
 * 比较语义化版本。和插件市场那套逻辑一致，但这里单独实现：
 * 框架更新不该依赖插件模块。
 * @returns {number} 1 = a 更新，-1 = b 更新，0 = 相等
 */
export function compareVersion(a, b) {
  const parse = (v) => {
    const m = String(v ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

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
export async function checkUpdate() {
  const cur = await currentVersion();

  let res = null;
  let lastErr = null;
  // 国内访问 github.com 经常抖（代理、DNS），重试一次再报错
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      res = await fetch(`https://github.com/${REPO}/releases/latest`, {
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
    return {
      ok: false,
      current: cur,
      error: `连不上 GitHub：${lastErr?.message ?? '未知错误'}（检查网络或代理）`,
    };
  }

  // 302 → Location: https://github.com/OWNER/REPO/releases/tag/v0.5.1
  const loc = res.headers.get('location') || '';
  const m = loc.match(/\/releases\/tag\/(v?[\d.]+)/);

  if (!m) {
    // 真的没有 release 时 GitHub 返回 404
    if (res.status === 404) {
      return { ok: true, current: cur, latest: cur, hasUpdate: false, note: '仓库还没有发布版本' };
    }
    // 3xx 但取不到 tag，说明被重定向到别处（登录页、限流页），不能当成「已是最新」
    return {
      ok: false,
      current: cur,
      error: `无法解析最新版本（HTTP ${res.status}）`,
    };
  }

  const tag = m[1];
  const latest = tag.replace(/^v/, '');
  const hasUpdate = compareVersion(cur, latest) < 0;

  return {
    ok: true,
    current: cur,
    latest,
    hasUpdate,
    tag,
    htmlUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
    // 公开直链，不需要 API
    tarball: `https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz`,
  };
}

/* ---------------- 下载与解包 ---------------- */

/**
 * 下载 tarball 并解包到临时目录。
 * 解析逻辑统一放在 src/tarball.js，插件市场和框架更新共用一份，
 * 免得两处 tar 解析以后跑偏。
 */
async function downloadTo(tmpDir, tarballUrl) {
  await fetchAndExtract(tarballUrl, tmpDir, {
    timeoutMs: 120000,
    retries: 1,
    onRetry: (m) => log.warn(m),
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
 * 执行更新。
 *
 * @param {object} [info] checkUpdate() 的返回值；不传就现查
 * @returns {Promise<{ok:boolean, from:string, to:string, backup?:string, error?:string}>}
 */
export async function applyUpdate(info) {
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
    await downloadTo(workDir, rel.tarball);

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
    for (const name of CODE_ENTRIES) {
      if (PROTECTED.has(name)) continue; // 理论上不会进来，双保险
      const from = path.join(workDir, name);
      const exists = await fs.access(from).then(() => true, () => false);
      if (!exists) continue;
      const to = path.join(ROOT, name);
      await fs.rm(to, { recursive: true, force: true });
      await fs.cp(from, to, { recursive: true });
    }

    log.info(`更新完成：${cur} → ${rel.latest}，重启后生效`);
    return { ok: true, from: cur, to: rel.latest, backup: path.relative(ROOT, backupDir) };
  } catch (e) {
    log.error(`更新失败，正在还原：${e.message}`);
    // 还原：把备份原样拷回去
    for (const name of CODE_ENTRIES) {
      const from = path.join(backupDir, name);
      const exists = await fs.access(from).then(() => true, () => false);
      if (!exists) continue;
      const to = path.join(ROOT, name);
      await fs.rm(to, { recursive: true, force: true }).catch(() => {});
      await fs.cp(from, to, { recursive: true }).catch(() => {});
    }
    return { ok: false, from: cur, to: rel.latest, error: e.message };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
