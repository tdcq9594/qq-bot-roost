#!/usr/bin/env node
/**
 * 生成插件市场索引
 * ================
 *
 *   npm run market:index -- ../qq-bot-roost-plugins
 *   npm run market:index -- ../qq-bot-roost-plugins --repo tdcq9594/qq-bot-roost-plugins
 *
 * 扫一遍插件仓库里每个目录的 `plugin.json`（内建插件读 `index.js` 的默认导出），
 * 生成 `index.json`。以前这一步是手写的——版本号忘改、路径写错、
 * 插件删了索引里还留着，都是这么来的。
 *
 * 生成的 index.json 结构：
 *   { "repo": "owner/name", "branch": "main", "updated": "2026-10-24",
 *     "plugins": [{ id, name, version, description, tags, path, runtime, ... }] }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { hashDir } from '../src/hashdir.js';

const args = process.argv.slice(2);
const repoIdx = args.indexOf('--repo');
const branchIdx = args.indexOf('--branch');

/** 第一个「不是选项、也不是选项值」的参数才是目录 */
const dir =
  args.find((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = args[i - 1];
    return !(prev === '--repo' || prev === '--branch');
  }) || '.';

const repo = repoIdx >= 0 ? args[repoIdx + 1] : '';
const branch = branchIdx >= 0 ? args[branchIdx + 1] : 'main';

/** 内建插件：读 index.js 的默认导出 */
async function readInternal(file) {
  try {
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
    const meta = mod.default ?? mod.plugin;
    if (!meta?.id) return null;
    return {
      id: meta.id,
      name: meta.name ?? meta.id,
      version: meta.version ?? '0.0.0',
      description: meta.shortDesc ?? meta.description ?? '',
      tags: meta.tags ?? [],
      frameworkVersion: meta.frameworkVersion ?? '',
      runtime: 'node',
    };
  } catch (e) {
    console.warn(`  跳过 ${path.basename(path.dirname(file))}：index.js 加载失败（${e.message}）`);
    return null;
  }
}

/** 外部插件：读 plugin.json */
async function readExternal(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw.id) return null;
    return {
      id: raw.id,
      name: raw.name ?? raw.id,
      version: raw.version ?? '0.0.0',
      description: raw.shortDesc ?? raw.description ?? '',
      tags: raw.tags ?? [],
      frameworkVersion: raw.frameworkVersion ?? '',
      runtime: raw.runtime ?? 'python',
    };
  } catch (e) {
    console.warn(`  跳过 ${path.basename(path.dirname(file))}：plugin.json 解析失败（${e.message}）`);
    return null;
  }
}

async function main() {
  const root = path.resolve(dir);

  /**
   * 插件仓库的布局是 `plugins/<id>/`，而不是仓库根下直接放 `<id>/`。
   *
   * 以前这个脚本只扫根目录，于是把 `path` 写成 `dice`——安装时
   * `path.join(解包目录, 'dice')` 根本不存在，装什么都是「仓库里找不到目录」。
   * 现在：根目录下没有插件就自动往下看一层 `plugins/`，并把前缀带进 path。
   */
  let scanDir = root;
  let prefix = '';
  const top = await fs.readdir(root, { withFileTypes: true });
  const hasPluginAtTop = async (e) => {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') return false;
    const sub = path.join(root, e.name);
    for (const f of ['plugin.json', 'index.js']) {
      if (await fs.access(path.join(sub, f)).then(() => true, () => false)) return true;
    }
    return false;
  };
  let found = false;
  for (const e of top) if (await hasPluginAtTop(e)) found = true;
  if (!found) {
    const nested = path.join(root, 'plugins');
    const ok = await fs.stat(nested).then((s) => s.isDirectory(), () => false);
    if (ok) {
      scanDir = nested;
      prefix = 'plugins/';
    }
  }

  const entries = await fs.readdir(scanDir, { withFileTypes: true });
  const plugins = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;

    const sub = path.join(scanDir, e.name);
    const manifest = path.join(sub, 'plugin.json');
    const internal = path.join(sub, 'index.js');

    const hasManifest = await fs.access(manifest).then(() => true).catch(() => false);
    const hasInternal = await fs.access(internal).then(() => true).catch(() => false);

    let meta = null;
    if (hasManifest) meta = await readExternal(manifest);
    else if (hasInternal) meta = await readInternal(internal);
    if (!meta) continue;

    if (meta.id !== e.name) {
      console.warn(`  ${e.name}：声明的 id 是 ${meta.id}，与目录名不一致（以目录名为准）`);
      meta.id = e.name;
    }

    plugins.push({
      ...meta,
      // 仓库里的相对路径，安装时按它找目录
      path: `${prefix}${e.name}`,
      /**
       * 插件目录的内容指纹。安装时按同一算法重算，对不上就拒绝。
       * 算法在 `src/hashdir.js`，两边共用一份，不能各写一遍。
       */
      sha256: await hashDir(sub),
    });
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));

  const target = path.join(root, 'index.json');

  /**
   * 和已有的 index.json **按 id 合并**，不要整份覆盖。
   *
   * 索引里有几个字段是手写的、脚本产不出来：`author`、`commands`、
   * `addedAt`、`schema`。整份重写会把它们抹掉，面板上的「命令」一栏
   * 就全空了——看起来像「更新了一下索引」，实际是数据丢失。
   *
   * 规则：脚本认识的字段以磁盘为准（版本号、路径、哈希必须最新），
   * 脚本不认识的原样保留。
   */
  let prev = { plugins: [] };
  let prevEol = '\n';
  try {
    const raw = await fs.readFile(target, 'utf8');
    prev = JSON.parse(raw);
    // 跟着原文件的换行符走，别把整份文件变成「每行都改了」
    if (raw.includes('\r\n')) prevEol = '\r\n';
  } catch {
    /* 第一次生成，没有旧索引 */
  }
  const prevById = new Map((prev.plugins ?? []).map((p) => [p.id, p]));

  /**
   * 只更新「必须跟着仓库走」的字段，其余手写内容原样保留。
   *
   * 索引里有两类字段：
   *   1. 结构字段（id / version / path / runtime / sha256）—— 必须与仓库一致，
   *      否则装错版本、找不到目录、校验对不上。这些一律以磁盘为准。
   *   2. 展示字段（name / description / tags / author / commands / credits）——
   *      手写的，往往比代码里的短描述更完整（比如 kun 的「24 个命令」）。
   *      脚本不该去改文案，只补新增插件的。
   *
   * 以前的写法是整份覆盖，结果一次「更新索引」就把 tags 清空、
   * 把描述里的补充说明抹掉，看起来像升级，实际是数据丢失。
   */
  const STRUCT_FIELDS = ['id', 'version', 'path', 'runtime', 'sha256', 'frameworkVersion'];

  const merged = plugins.map((p) => {
    const old = prevById.get(p.id);
    if (!old) return p; // 新插件：全量写入
    const out = { ...old };
    for (const k of STRUCT_FIELDS) {
      if (p[k] !== undefined && p[k] !== '') out[k] = p[k];
    }
    return out;
  });

  const out = {
    // schema 是索引格式版本，不是脚本能推出来的东西
    ...(prev.schema ? { schema: prev.schema } : {}),
    ...(repo ? { repo } : prev.repo ? { repo: prev.repo } : {}),
    branch: branch ?? prev.branch,
    updated: new Date().toISOString().slice(0, 10),
    plugins: merged,
  };

  await fs.writeFile(target, `${JSON.stringify(out, null, 2)}\n`.replace(/\n/g, prevEol), 'utf8');

  console.log(`\n已生成 ${target}`);
  console.log(`  ${merged.length} 个插件${out.repo ? `，repo=${out.repo}` : '（没有 repo，安装会失败）'}`);
  for (const p of merged) {
    console.log(`  - ${p.id} v${p.version}（${p.runtime}）${p.sha256 ? '' : '  ⚠ 无 sha256'}`);
  }
}

main().catch((e) => {
  console.error('生成失败：', e.message);
  process.exit(1);
});
