/**
 * 外接依赖的备选下载源 —— 市场仓的 `deps/` 目录
 * ================================================
 *
 * npm 这条路会坏：用户机器上根本没装 npm、公司网拦了 registry、源超时到
 * 180 秒、装完 `require` 起来还是报错。这时回到我们自己的市场仓取包，
 * **直接解包、不经过 npm**——所以「没有 npm」这一种也能救。
 *
 * ## 为什么只放得下这两个包
 *
 * `ws`（36KB）和 `silk-wasm`（105KB）都是**零依赖**，解包到
 * `node_modules/<名字>/` 就能 `require`，不需要解依赖树——这是「不经过
 * npm」的前提。`@ffmpeg-installer/ffmpeg` 挂着 8 个平台子包、上百 MB、
 * GPL/LGPL 系，不在镜像里（理由见市场仓 `deps/README.md`）。
 *
 * ## 信任链
 *
 * 地址由**市场索引地址**推导（同一个 host、同一个 repo），不另外接受
 * 用户输入——否则「装依赖」就成了一个新的任意下载入口。
 * 包内容按索引里的 `sha256` 校验，索引本身走 https，信任级别和装插件一致。
 *
 * ## 版本
 *
 * 索引里的版本必须落在白名单 `range` 里才用。放旧版不是灾难（退回 npm），
 * 但**硬装一个不满足范围的版本**会让面板显示「已安装」而实际 API 不兼容。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchAndExtract } from './tarball.js';
import { fetchViaMirror } from './mirror.js';
import { fetchIndex } from './plugin/market.js';

/**
 * 版本是否满足 `range`。
 *
 * **只支持白名单里实际用到的两种写法**：`^X.Y.Z`（锁主版本）与精确
 * `X.Y.Z`。刻意不引 semver 包——框架本体零依赖，而这三个包的范围都是
 * 手写的常量，多带一个解析器只为了算 `^` 不值得。
 *
 * `^0.x.y` 的语义和 `^8.x.y` 不同（次版本号也锁），这里按 semver 处理：
 * `^0.2.0` 不接受 `0.3.0`。
 * `~` / `>=` / `||` / 预发布版都没实现——白名单里没用过，写了也只是没人走的分支。
 * 要加就先统一白名单写法。
 *
 * @param {string} version 实际版本，如 `8.23.0`
 * @param {string} range 期望范围，如 `^8.18.0`
 * @returns {boolean}
 */
export function satisfiesRange(version, range) {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  const r = /^(\^)?(\d+)\.(\d+)\.(\d+)$/.exec(String(range ?? '').trim());
  if (!v || !r) return false;
  /** 全转成数字再比：match 数组里是字符串，`8 !== '8'` 会让所有判断恒假 */
  const [, va, vi, vp] = v.map(Number);
  const caret = r[1] === '^';
  const ra = Number(r[2]);
  const ri = Number(r[3]);
  const rp = Number(r[4]);
  if (caret) {
    /**
     * `^X.Y.Z`：主版本相同、且不低于下界。
     * 只锁主版本、不锁次版本，但**不能不比下界**——`^8.18.0` 放行
     * `8.17.9` 就是装了一个比白名单更老的版本。
     *
     * `^0.x.y` 是例外：semver 里它连次版本一起锁（`^0.2.0` 不含 `0.3.0`），
     * 所以 0 主版本还要求次版本相等。
     */
    if (va !== ra) return false;
    if (va === 0) return vi === ri && vp >= rp;
    return vi > ri || (vi === ri && vp >= rp);
  }
  return va === ra && vi === ri && vp === rp;
}

/**
 * 由市场索引地址推出依赖包地址。
 *
 * 例：`https://raw.githubusercontent.com/o/r/main/index.json` +
 * `deps/ws-8.23.0.tgz` → `https://raw.githubusercontent.com/o/r/main/deps/ws-8.23.0.tgz`
 *
 * @param {string} indexUrl
 * @param {string} rel 索引里的 `path`（相对仓库根）
 * @returns {string} 拼不出合法地址时返回空串
 */
export function depUrlOf(indexUrl, rel) {
  try {
    const base = new URL(indexUrl);
    if (base.protocol !== 'https:') return '';
    const clean = String(rel ?? '').replace(/^\/+/, '');
    /**
     * 索引里写 `../../../x` 就能跳出仓目录——这条路是「装依赖」的入口，
     * 不该能被索引带着去任意路径取文件。出现 `.` / `..` 段一律不认。
     */
    if (!clean || clean.split('/').some((seg) => seg === '.' || seg === '..')) return '';
    const dir = base.pathname.replace(/[^/]*$/, '');
    base.pathname = dir + clean;
    return base.toString();
  } catch {
    return '';
  }
}

/**
 * 拉一次市场索引，取出 `deps` 列表。
 *
 * `maxAge: 0` 是**故意的**：这是写路径（要装东西），缓存 60 秒会让刚换过
 * 依赖包的镜像读到旧 sha256，然后稳定地校验失败。
 *
 * @param {string} indexUrl
 * @returns {Promise<{entries: Array<object>, error: string}>} 失败时 entries 为空
 */
export async function listMirrorDeps(indexUrl) {
  try {
    const index = await fetchIndex(indexUrl, { maxAge: 0 });
    const entries = Array.isArray(index?.deps) ? index.deps.filter((d) => d?.name && d?.version && d?.path) : [];
    return { entries, error: '' };
  } catch (e) {
    return { entries: [], error: `读市场索引失败：${String(e?.message ?? e)}` };
  }
}

/**
 * 从镜像装一个包。
 *
 * 下载 → 校验 sha256 → 解包到临时目录 → 只把 `package/` 搬进
 * `node_modules/<名字>/`。**先解到临时目录再搬**，是因为校验失败必须做到
 * 「一个字节都没写进 node_modules」。
 *
 * @param {string} indexUrl 市场索引地址
 * @param {object} entry 索引里的一条 `deps` 记录
 * @param {string} dest node_modules 所在目录
 * @param {object} [opts]
 * @param {Function} [opts.fetcher] 替换下载实现（单测用，正常不传）
 * @returns {Promise<{ok:boolean, error:string}>}
 */
export async function installOneFromMirror(indexUrl, entry, dest, opts = {}) {
  const url = depUrlOf(indexUrl, entry.path);
  if (!url) return { ok: false, error: `镜像地址拼不出来（索引 ${indexUrl}）` };

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-dep-'));
  try {
    await fetchAndExtract(url, tmp, {
      /** 走用户选定的 GitHub 镜像：官方 raw 在国内经常连不上，那正是要救的场景 */
      fetcher: opts.fetcher ?? ((u, init) => fetchViaMirror(u, init)),
      expectSha256: entry.sha256,
      timeoutMs: 60_000,
      retries: 1,
    });

    /**
     * `extractEntries` 会**剥掉唯一的顶层目录**，npm 包的 `package/` 前缀
     * 已经没了——文件直接落在 `tmp/` 下。这里两种都认：万一将来换了解包
     * 实现不剥前缀，`package/` 那条分支能接上。
     */
    let unpacked = tmp;
    let pkgJson = await fs.readFile(path.join(tmp, 'package.json'), 'utf8').catch(() => null);
    if (!pkgJson) {
      const nested = path.join(tmp, 'package');
      pkgJson = await fs.readFile(path.join(nested, 'package.json'), 'utf8').catch(() => null);
      if (pkgJson) unpacked = nested;
    }
    if (!pkgJson) throw new Error('包里没有 package.json（不是 npm 包？）');
    /** 名字必须对得上：索引说装 ws，包里却是别的包，等于装错了东西 */
    const realName = String(JSON.parse(pkgJson)?.name ?? '');
    if (realName !== entry.name) {
      throw new Error(`包名不符：索引是 ${entry.name}，包里是 ${realName || '(空)'}`);
    }

    const target = path.join(dest, 'node_modules', ...entry.name.split('/'));
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(unpacked, target, { recursive: true });
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 一次装多个：只装 `names` 里、索引里有的、版本满足 range 的。
 *
 * @param {object} p
 * @param {string[]} p.names 包名（已过白名单）
 * @param {Record<string, {range: string}>} p.whitelist 包名 → 版本范围
 * @param {string} p.dir 数据目录（`data/deps/ext`，下面有 node_modules）
 * @param {string} p.indexUrl 市场索引地址
 * @param {Array<object>} [p.entries] 直接给索引条目（单测用，正常走网络）
 * @param {Function} [p.fetcher] 替换下载实现（单测用）
 * @returns {Promise<{installed: Array<{name:string,version:string}>, errors: string[], absent: string[]}>}
 */
export async function installFromMirror({ names, whitelist, dir, indexUrl, entries: given, fetcher }) {
  const out = { installed: [], errors: [], absent: [] };
  const { entries, error } = given
    ? { entries: given, error: '' }
    : await listMirrorDeps(indexUrl);
  if (error) {
    out.errors.push(error);
    return out;
  }
  for (const name of names) {
    const entry = entries.find((d) => d.name === name);
    if (!entry) {
      out.absent.push(name);
      continue;
    }
    const range = whitelist?.[name]?.range;
    if (range && !satisfiesRange(entry.version, range)) {
      out.errors.push(
        `镜像里的 ${name} 是 ${entry.version}，不满足 ${range}（镜像该刷新了），已跳过`,
      );
      continue;
    }
    const r = await installOneFromMirror(indexUrl, entry, dir, { fetcher });
    if (r.ok) out.installed.push({ name, version: entry.version });
    else out.errors.push(`${name}：${r.error}`);
  }
  return out;
}
