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
  const entries = await fs.readdir(root, { withFileTypes: true });
  const plugins = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;

    const sub = path.join(root, e.name);
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
      path: e.name,
    });
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));

  const out = {
    ...(repo ? { repo } : {}),
    branch,
    updated: new Date().toISOString().slice(0, 10),
    plugins,
  };

  const target = path.join(root, 'index.json');
  await fs.writeFile(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  console.log(`\n已生成 ${target}`);
  console.log(`  ${plugins.length} 个插件${repo ? `，repo=${repo}` : ''}${repo ? '' : '（没传 --repo，安装会失败）'}`);
  for (const p of plugins) console.log(`  - ${p.id} v${p.version}（${p.runtime}）`);
}

main().catch((e) => {
  console.error('生成失败：', e.message);
  process.exit(1);
});
