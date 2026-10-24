/**
 * tar.gz 下载与解包（零依赖）
 * ==========================
 *
 * 用途：从 GitHub 拉代码，**不依赖 git**。
 *
 * 为什么不用 git：
 *   一开始插件安装和框架更新都用 `git clone`，理由是「项目本身是 clone 下来的，
 *   git 一定在」。这个假设是错的——很多人是下载 zip 解压用的，机器上根本没装 git，
 *   于是安装插件直接报 `spawn git ENOENT`。
 *
 *   改用 `https://github.com/{repo}/archive/refs/heads/{branch}.tar.gz`
 *   这个公开直链，浏览器能下，fetch 也能下，不需要任何外部命令。
 *
 * 解包是自己写的（zlib 内置 + 手写 tar 头解析），够用：
 *   - 只处理普通文件和目录（GitHub 的包里没有硬链接、设备文件）
 *   - 剥掉顶层目录（`repo-main/` 这种包裹层）
 *   - 防路径穿越
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('tarball');

/**
 * 解析 tar 缓冲区。
 * @returns {Array<{name:string, dir:boolean, content?:Buffer}>}
 */
export function parseTar(buf) {
  const entries = [];
  let off = 0;

  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // 全零块 = 结束
    if (header.every((b) => b === 0)) break;

    const readStr = (start, len) => {
      const slice = header.subarray(start, start + len);
      const end = slice.indexOf(0);
      return slice.subarray(0, end === -1 ? len : end).toString('utf8');
    };

    const name = readStr(0, 100);
    const size = parseInt(readStr(124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(header[156]) || '0';
    // ustar 前缀，长路径会用它
    const prefix = readStr(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    off += 512;
    const content = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;

    if (type === '5') entries.push({ name: fullName, dir: true });
    else if (type === '0' || type === '\0') entries.push({ name: fullName, dir: false, content });
    // pax 头（type 'x'）只影响下一条的路径，我们的路径都不长，跳过即可
  }
  return entries;
}

/**
 * 把 tar 条目写到磁盘，剥掉唯一的顶层目录。
 *
 * **不能假设第一条就是顶层目录**：GitHub 的包第一条是 `repo-main/`，
 * 但用 `tar czf` 自己打的包第一条往往是 `./`，拿 entries[0] 去算前缀会得到 `.`，
 * 结果所有路径都剥不掉。所以先去掉 `./` 前缀，再看所有条目的公共顶层段。
 */
export async function extractEntries(entries, destDir) {
  const cleaned = entries
    .map((e) => ({ ...e, name: e.name.replace(/^\.\//, '') }))
    .filter((e) => e.name);

  const tops = new Set();
  for (const e of cleaned) {
    const seg = e.name.split('/')[0];
    if (seg) tops.add(seg);
  }
  // 只有一个顶层段 → 整个包被包在一个目录里，剥掉；多个 → 扁平结构，不剥
  const wrapper = tops.size === 1 ? [...tops][0] : null;

  const base = path.resolve(destDir);
  let count = 0;

  for (const e of cleaned) {
    const rel = wrapper && e.name.startsWith(wrapper + '/') ? e.name.slice(wrapper.length + 1) : e.name;
    if (!rel) continue;

    // 防路径穿越：解析后必须仍在目标目录内
    const dest = path.resolve(path.join(base, rel));
    if (dest !== base && !dest.startsWith(base + path.sep)) continue;

    if (e.dir) {
      await fs.mkdir(dest, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, e.content);
      count += 1;
    }
  }
  return count;
}

/**
 * 下载一个 tar.gz 并解包到目录。
 *
 * @param {string} url
 * @param {string} destDir
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 单次请求超时，默认 120 秒
 * @param {number} [opts.retries]   失败重试次数，默认 1
 * @param {(msg:string)=>void} [opts.onRetry]
 * @returns {Promise<number>} 写出的文件数
 */
export async function fetchAndExtract(url, destDir, opts = {}) {
  const { timeoutMs = 120000, retries = 1, onRetry, fetcher, expectSha256 = null } = opts;
  // 默认裸 fetch；插件市场和框架更新会传一个带镜像兜底的实现
  const doFetch = fetcher ?? fetch;

  let res = null;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      onRetry?.(`下载失败（${lastErr?.message ?? '未知'}），重试第 ${attempt} 次…`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    try {
      res = await doFetch(url, {
        headers: { 'User-Agent': 'qq-bot-roost' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) break;
      lastErr = new Error(`HTTP ${res.status}`);
      res = null;
      // 404 说明地址错了，重试没意义
      if (lastErr.message === 'HTTP 404') break;
    } catch (e) {
      lastErr = e;
      res = null;
    }
  }

  if (!res) throw new Error(`下载失败：${lastErr?.message ?? '未知错误'}`);

  const gz = Buffer.from(await res.arrayBuffer());

  /**
   * 供应链校验：索引里给了 sha256 就必须对上。
   * 镜像运营方或被中间人换掉的 tar.gz 直接就是进程里的代码（RCE）。
   * 没给就只提示一句，不阻断——老索引没有这个字段，硬卡会让所有人装不了插件。
   */
  if (expectSha256) {
    const got = crypto.createHash('sha256').update(gz).digest('hex');
    if (got.toLowerCase() !== String(expectSha256).toLowerCase()) {
      throw new Error(
        `下载内容校验失败（sha256 不匹配）\n  期望 ${expectSha256}\n  实际 ${got}\n` +
          '镜像可能被篡改，或索引与包不同步。已中止，未写入任何文件。',
      );
    }
    log.info('下载内容 sha256 校验通过');
  } else {
    log.warn('索引没有提供 sha256，本次安装未做内容校验');
  }
  /**
   * 解压必须带上限。
   * 一个几十 KB 的 gzip 炸弹能解出几十 GB，直接把进程内存打爆。
   * 插件仓库正常也就几 MB，64MB 足够宽松。
   */
  const MAX_UNZIPPED = 64 * 1024 * 1024;
  let tar;
  try {
    tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_UNZIPPED });
  } catch (e) {
    if (String(e.message).includes('maxOutputLength')) {
      throw new Error(`解压后超过 ${MAX_UNZIPPED / 1048576}MB 上限，已中止（可能是 gzip 炸弹）`);
    }
    throw new Error('下载到的不是合法的 gzip 文件');
  }

  const entries = parseTar(tar);
  if (!entries.length) throw new Error('下载到的包是空的');

  await fs.mkdir(destDir, { recursive: true });
  return extractEntries(entries, destDir);
}

/** GitHub 仓库某个分支的 tarball 直链 */
export function branchTarballUrl(repo, branch = 'main') {
  return `https://github.com/${repo}/archive/refs/heads/${branch}.tar.gz`;
}

/** GitHub 仓库某个 tag 的 tarball 直链 */
export function tagTarballUrl(repo, tag) {
  return `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`;
}
