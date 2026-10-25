/**
 * Gitee 下载源
 * ============
 *
 * Gitee 没有 GitHub 那样的「archive 直链」：`/repository/archive/{ref}.tar.gz`
 * 现在返回的是一个「下载仓库」网页（按需生成 + 跳转），没法当二进制拉。
 * 所以走另一条路：**git trees API 列文件 + raw 逐个拉**，纯 fetch，不依赖 git。
 *
 *   GET /api/v5/repos/{repo}/git/trees/{ref}?recursive=1   → 全量文件清单
 *   GET /{repo}/raw/{ref}/{path}                            → 文件内容
 *
 * 两条都是公开端点，不需要 token。API 匿名配额约 60 次/小时，所以每次下载
 * 只用 **1 次** API（列清单），文件内容全走 raw（web 端点，不吃 API 配额）。
 * 框架整包 86 个文件、单个插件目录 2~8 个文件，都在可接受范围。
 *
 * **私人令牌（选填）**：匿名配额是全局共享的，碰上限流就查不了清单。
 * 填了 `giteeToken` 就以认证身份查 API（配额高一个量级），没填就走匿名——
 * 公开仓库两种都能用，令牌只影响 API 调用，raw 下载不需要。
 *
 * 为什么不用 Gitee 的 contents API 逐目录走：框架更新要拉整个代码树，
 * 二十多个目录就要二十多次 API 调用，匿名配额撑不住。trees 一把梭。
 *
 * 哈希一致性：Gitee 是 GitHub 的克隆，blob 内容和 GitHub 逐字节相同
 * （实测 trees API 返回的 sha 与本地 git 对象一致），所以插件市场索引里的
 * sha256 校验在 Gitee 源上同样成立。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('gitee');

const API = 'https://gitee.com/api/v5';
const UA = 'qq-bot-roost';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 同时最多几个文件在飞。gitee raw 虽快，也别一下打满 */
const CONCURRENCY = 4;

/** 单文件重试：gitee 的 CDN 在突发流量下会返 451/429（实测连拉 86 个文件时中过招），
 *  退避后重试基本都能过。404 不重试——文件真的没有，重试没意义 */
const FILE_RETRIES = 3;
const RETRYABLE = new Set([408, 425, 429, 451, 500, 502, 503, 504]);

function isRetryable(res, err) {
  if (err) return true; // 网络层错误
  return RETRYABLE.has(res?.status);
}

/** raw 地址：`https://gitee.com/{repo}/raw/{ref}/{path}` */
export function giteeRawUrl(repo, ref, filePath) {
  const p = String(filePath ?? '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `https://gitee.com/${repo}/raw/${encodeURIComponent(ref)}/${p}`;
}

/**
 * 把仓库某个 ref 的内容拉到本地目录。
 *
 * @param {object} o
 * @param {string} o.repo     `owner/name`
 * @param {string} o.ref      分支 / tag，如 master / main
 * @param {string} o.destDir  目标目录（已存在则复用）
 * @param {string} [o.token]  Gitee 私人令牌（选填）。只加在 API 调用上
 * @param {string[]} [o.only] 只拉这些路径前缀。目录要以 `/` 结尾，
 *                            如 ['src/', 'package.json']；不传拉全仓
 * @param {number} [o.timeoutMs] 单文件超时
 * @param {(msg:string)=>void} [o.onProgress] 每拉完一个文件调一次
 * @returns {Promise<{files:number, skipped:number}>}
 */
export async function fetchGiteeTree({
  repo,
  ref,
  destDir,
  token = '',
  only = null,
  timeoutMs = 120000,
  onProgress,
}) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Gitee 仓库名不合法：${repo}`);
  if (!ref) throw new Error('Gitee 下载缺少分支/tag');

  // 1) 列清单（整个下载只用这一次 API）
  const q = new URLSearchParams({ recursive: '1' });
  if (token) q.set('access_token', token);
  const apiUrl = `${API}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?${q}`;
  let tree;
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tree = await res.json();
  } catch (e) {
    throw new Error(`拉取 Gitee 文件清单失败（${repo}@${ref}）：${e.message}`);
  }
  if (!Array.isArray(tree?.tree) || !tree.tree.length) {
    throw new Error(`Gitee 上 ${repo}@${ref} 没有文件（仓库是空的？）`);
  }
  if (tree.truncated) {
    // 我们的仓库远没到GitHub 的 10 万条目上限，真出现了说明 ref 指错了东西
    log.warn(`Gitee trees 被截断（${repo}@${ref}），结果可能不完整`);
  }

  // 2) 过滤：只要普通文件；only 给了就按前缀收窄
  const prefixes = Array.isArray(only) && only.length ? only : null;
  const files = tree.tree.filter((e) => {
    if (e?.type !== 'blob' || !e.path) return false;
    if (!prefixes) return true;
    return prefixes.some((p) => e.path === p || e.path.startsWith(p));
  });
  if (!files.length) {
    throw new Error(`Gitee 上 ${repo}@${ref} 找不到要拉的文件${prefixes ? `（范围 ${prefixes.join(', ')}）` : ''}`);
  }

  // 3) 并发拉 raw，写盘
  await fs.mkdir(destDir, { recursive: true });
  let done = 0;
  let failed = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i];
      const dest = path.resolve(path.join(destDir, f.path));
      // 防路径穿越：清单来自服务端，仍按不可信处理
      const base = path.resolve(destDir);
      if (dest !== base && !dest.startsWith(base + path.sep)) {
        log.warn(`跳过越界路径：${f.path}`);
        continue;
      }
      try {
        let res = null;
        let lastErr = null;
        for (let attempt = 1; attempt <= FILE_RETRIES; attempt++) {
          try {
            res = await fetch(giteeRawUrl(repo, ref, f.path), {
              headers: { 'User-Agent': UA },
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.ok) break;
            lastErr = new Error(`HTTP ${res.status}`);
            if (!isRetryable(res, null)) {
              res = null;
              break;
            }
            res = null;
          } catch (e) {
            lastErr = e;
            res = null;
            if (!isRetryable(null, e)) break;
          }
          if (attempt < FILE_RETRIES) {
            await sleep(attempt * 1000); // 1s、2s 退避
          }
        }
        if (!res) throw lastErr ?? new Error('未知错误');
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('内容是空的');
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        done += 1;
        onProgress?.(`${done}/${files.length} ${f.path}`);
      } catch (e) {
        failed += 1;
        log.warn(`拉取失败 ${f.path}: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

  if (failed) {
    throw new Error(`Gitee 下载 ${repo}@${ref}：${files.length} 个文件里 ${failed} 个失败，已中止`);
  }
  return { files: done, skipped: files.length - done };
}

/**
 * 猜仓库在 Gitee 上的默认分支：先 master 再 main。
 *
 * 不调 `/api/v5/repos/{repo}` 拿 default_branch——那要花一次 API 配额，
 * 而这里只是拉个 package.json 试试，raw 不吃配额。两个分支都没有才报错。
 *
 * @param {string} repo
 * @param {string} [probe] 用哪个文件试探，默认 package.json
 * @returns {Promise<string>} 分支名
 */
export async function detectGiteeRef(repo, probe = 'package.json') {
  const errors = [];
  for (const ref of ['master', 'main']) {
    try {
      const res = await fetch(giteeRawUrl(repo, ref, probe), {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return ref;
      errors.push(`${ref}: HTTP ${res.status}`);
    } catch (e) {
      errors.push(`${ref}: ${e.message}`);
    }
  }
  throw new Error(`Gitee 上找不到 ${repo} 的 master/main 分支（${errors.join('；')}）`);
}
