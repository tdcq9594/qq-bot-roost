import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('market');

/** 官方插件仓库。改这里就能指向你自己的插件源 */
export const DEFAULT_INDEX_URL =
  'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost-plugins/main/index.json';

/**
 * 拉取插件市场的索引。
 * @param {string} [url]
 * @returns {Promise<{schema:number, repo:string, branch:string, updated:string, plugins:object[]}>}
 */
export async function fetchIndex(url = DEFAULT_INDEX_URL) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`连不上插件市场：${e.message}`);
  }
  if (!res.ok) throw new Error(`插件市场返回 HTTP ${res.status}`);

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('插件市场返回的不是合法 JSON');
  }
  if (!Array.isArray(data?.plugins)) throw new Error('插件市场索引格式不对（缺少 plugins 数组）');

  return data;
}

/** 跑一条命令，收集输出。失败时把 stderr 带出来 */
function run(cmd, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} 超时`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法执行 ${cmd}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} 退出码 ${code}\n${err.slice(-400)}`));
    });
  });
}

/**
 * 安装一个插件。
 *
 * 做法是 `git clone --depth 1` 到临时目录，再把插件目录整个复制进 plugins/。
 * 不用 zip/tar 是因为本项目零依赖，而 git 一定在（项目本身就是 clone 下来的）。
 *
 * @param {object} p
 * @param {object} p.entry    index.json 里的一条
 * @param {string} p.pluginsDir 目标插件目录
 * @param {string} [p.repo]   仓库，如 tdcq9594/qq-bot-roost-plugins
 * @param {string} [p.branch] 分支
 * @param {(id:string)=>boolean} [p.exists] 判断插件是否已存在
 * @returns {Promise<{id:string, dir:string}>}
 */
export async function installPlugin({ entry, pluginsDir, repo, branch = 'main', exists }) {
  const id = String(entry?.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new Error(`插件 id 不合法：${id}`);
  if (!entry?.path) throw new Error('索引里缺少 path 字段');
  if (!repo) throw new Error('索引里缺少 repo 字段');

  if (exists?.(id)) throw new Error(`插件 ${id} 已经装过了，先删掉再装`);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-plugin-'));
  try {
    log.info(`开始安装插件 ${id}（来自 ${repo}）`);
    await run(
      'git',
      ['clone', '--depth', '1', '--branch', branch, `https://github.com/${repo}.git`, tmp],
      { timeoutMs: 120000 },
    );

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
