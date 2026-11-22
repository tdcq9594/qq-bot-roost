#!/usr/bin/env node
/**
 * 生成插件市场索引
 * ================
 *
 *   npm run market:index -- ../qq-bot-roost-plugins
 *   npm run market:index -- ../qq-bot-roost-plugins --repo roost-qq/qq-bot-roost-plugins
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
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { hashDir } from '../src/hashdir.js';

const args = process.argv.slice(2);
/**
 * `--check`：只比对、不写文件。
 *
 * 2026-11-22 的教训：拿这个脚本去「校验」市场仓时，它直接把人工作区里
 * 未提交的 `index.json` 覆盖了——脚本没有只读模式，想看一眼现状的唯一
 * 办法就是写一遍。现在比对与生成分开，CI / 人工校验都走 `--check`。
 */
const checkMode = args.includes('--check');
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

/**
 * 外部条目：读 plugin.json。
 *
 * 这里和插件仓 `scripts/build-index.mjs` 的 `readMeta` 必须**同一套规则**：
 * 两份脚本都能生成索引，规则不一致就会出现「仓库脚本生成的索引 47 与框架脚本
 * 生成的不一样」这种最难查的偏差。
 */
async function readExternal(file) {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!raw.id) return null;
    /** `kind:'dsh-extension'` = DSH 扩展（MCP server），不是框架插件，见 build-index.mjs 的注释。 */
    const isExt = raw.kind === 'dsh-extension';
    return {
      id: raw.id,
      name: raw.name ?? raw.id,
      /** 扩展没有 version 契约（更新看 sha256），不要凭空填 '0.0.0' 与插件仓不一致。 */
      version: isExt ? '' : (raw.version ?? '0.0.0'),
      description: raw.shortDesc ?? raw.description ?? '',
      tags: raw.tags ?? [],
      frameworkVersion: raw.frameworkVersion ?? '',
      ...(isExt ? { kind: 'dsh-extension', runtime: 'mcp' } : { runtime: raw.runtime ?? 'python' }),
      /** 与插件仓 build-index.mjs 同步：只存原始权限声明，等级由宿主现算 */
      ...(isExt && Array.isArray(raw.scopes) ? { scopes: raw.scopes.map(String) } : {}),
      ...(isExt && Array.isArray(raw.overrides) ? { overrides: raw.overrides.map(String) } : {}),
      ...(isExt && typeof raw.form === 'string' && raw.form ? { form: raw.form } : {}),
    };
  } catch (e) {
    console.warn(`  跳过 ${path.basename(path.dirname(file))}：plugin.json 解析失败（${e.message}）`);
    return null;
  }
}

/**
 * 读 `<仓库>/deps/manifest.json`，算出每个依赖包的 sha256 与体积。
 *
 * 没有 `deps/` 目录＝这个市场没配镜像，返回空数组（不是错误）。
 * 声明了文件却找不到**必须抛错**：静默跳过会让 `index.json` 少一条，
 * 用户那边表现为「镜像里没有这个包」，而我们会以为已经发布了。
 *
 * @param {string} root 市场仓库根目录
 * @returns {Promise<Array<{name:string,version:string,path:string,sha256:string,size:number,license?:string}>>}
 */
async function readDeps(root) {
  const dir = path.join(root, 'deps');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`deps/manifest.json 读不出：${e.message}`);
  }

  /** 读一个 tgz 的字节；缺文件立刻抛（静默跳过的后果是用户那边「镜像里没有」） */
  const readOne = async (rel, owner) => {
    const buf = await fs.readFile(path.join(dir, rel)).catch(() => null);
    if (!buf) throw new Error(`deps/${rel} 不存在（manifest 里声明了 ${owner}）`);
    return { buf, hash: createHash('sha256').update(buf).digest('hex') };
  };

  const list = [];
  for (const p of manifest.packages ?? []) {
    if (!p?.name || !p?.version || !p?.file) {
      throw new Error(`deps/manifest.json 里有条目缺 name/version/file：${JSON.stringify(p)}`);
    }
    const { buf, hash } = await readOne(p.file, `${p.name}@${p.version}`);
    list.push({
      name: p.name,
      version: p.version,
      path: `deps/${p.file}`,
      sha256: hash,
      size: buf.length,
      ...(p.license ? { license: p.license } : {}),
    });
  }

  /**
   * `bundles` = 带传递依赖的整棵树（`qrcode` 有 29 个包）。
   *
   * **这一段的规则必须与插件仓 `scripts/build-index.mjs` 的 `readDeps()`
   * 完全一致**：两个脚本都可能被用来重建同一份 `index.json`，规则一分叉，
   * 谁跑一次就会把对方写的内容改一遍（甚至把 bundle 整段删掉）。
   */
  for (const b of manifest.bundles ?? []) {
    if (!b?.name || !b?.version || !b?.dir) {
      throw new Error(`deps/manifest.json 的 bundles 条目缺 name/version/dir：${JSON.stringify(b)}`);
    }
    if (!Array.isArray(b.packages) || !b.packages.length) {
      throw new Error(`bundle ${b.name} 没有 packages：空树发布出去等于告诉用户「有」却装不上`);
    }
    const packages = [];
    for (const p of b.packages) {
      if (!p?.name || !p?.version || !p?.file) {
        throw new Error(`bundle ${b.name} 里有条目缺 name/version/file：${JSON.stringify(p)}`);
      }
      const rel = `${b.dir}/${p.file}`;
      const { buf, hash } = await readOne(rel, `${b.name} → ${p.name}@${p.version}`);
      packages.push({
        name: p.name,
        version: p.version,
        path: `deps/${rel}`,
        sha256: hash,
        size: buf.length,
        ...(p.license ? { license: p.license } : {}),
      });
    }
    list.push({
      name: b.name,
      version: b.version,
      kind: 'bundle',
      ...(b.license ? { license: b.license } : {}),
      ...(b.why ? { why: b.why } : {}),
      packages,
    });
  }

  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `--check` 的比对：只比「脚本能算出来、索引里会过期」的部分。
 *
 * 忽略 `updated`（天天在变）与字段顺序。规则与插件仓
 * `scripts/build-index.mjs` 的 `diff()` 保持同一套：两个脚本都可能被用来
 * 重建同一份 `index.json`，判定口径一分叉，「谁跑谁改一遍」的老问题就回来了。
 *
 * @param {object} prev 现有索引
 * @param {object} next 刚算出来的索引
 * @returns {{problems:string[], notes:string[]}} `problems` 让退出码变 1，`notes` 只提示
 */
function diffIndex(prev, next) {
  const problems = [];
  const notes = [];
  const byId = new Map((prev.plugins ?? []).map((p) => [p.id, p]));
  for (const p of next.plugins ?? []) {
    const old = byId.get(p.id);
    if (!old) { problems.push(`${p.id}: 索引里没有这个插件`); continue; }
    byId.delete(p.id);
    for (const k of ['version', 'sha256', 'runtime', 'path', 'verified', 'category']) {
      const a = old[k] ?? '';
      const b = p[k] ?? '';
      /** scopes / overrides 是数组，String() 会把 ['a','b'] 和 ['a,b'] 混为一谈 */
      const sa = typeof a === 'object' ? JSON.stringify(a) : String(a);
      const sb = typeof b === 'object' ? JSON.stringify(b) : String(b);
      if (sa === sb) continue;
      /**
       * `version` 一边空一边有值：两个脚本对 mcp 扩展的版本来源口径不同
       * （插件仓从 `transport` 认扩展，这里只认 `kind:'dsh-extension'`）。
       * 这是**既有差异**，与本次 bundle 无关；报成硬错会让 `--check` 在市场仓
       * 上永久为红，反而没人看。归入 notes，不算失败。
       */
      if (k === 'version' && (!sa || !sb)) { notes.push(`${p.id}: version 索引里是 ${sa || '(空)'}，实际是 ${sb || '(空)'}（版本来源口径不同，可能是 mcp 扩展）`); continue; }
      problems.push(`${p.id}: ${k} 索引里是 ${sa || '(空)'}，实际是 ${sb || '(空)'}`);
    }
  }
  for (const id of byId.keys()) problems.push(`${id}: 索引里有，但仓库里已经没有这个插件`);

  const oldDeps = new Map((prev.deps ?? []).map((d) => [d.name, d]));
  for (const d of next.deps ?? []) {
    const old = oldDeps.get(d.name);
    if (!old) { problems.push(`依赖 ${d.name}: 索引里没有这一条`); continue; }
    oldDeps.delete(d.name);
    /** bundle 没有顶层 path/sha256：逐个子包比，只比 version 会漏掉「换了某个子包」 */
    if (Array.isArray(d.packages)) {
      const op = Array.isArray(old.packages) ? old.packages : [];
      if (!op.length) { problems.push(`依赖 ${d.name}: 索引里还是单包形态，实际已是 bundle`); continue; }
      const byName = new Map(op.map((x) => [x.name, x]));
      for (const p of d.packages) {
        const o = byName.get(p.name);
        if (!o) { problems.push(`依赖 ${d.name}/${p.name}: 索引里没有这一条`); continue; }
        byName.delete(p.name);
        for (const k of ['version', 'sha256', 'path']) {
          if (String(o[k] ?? '') !== String(p[k] ?? '')) {
            problems.push(`依赖 ${d.name}/${p.name}: ${k} 索引里是 ${o[k] ?? '(空)'}，实际是 ${p[k] ?? '(空)'}`);
          }
        }
      }
      for (const n of byName.keys()) problems.push(`依赖 ${d.name}/${n}: 索引里有，deps/ 下已经没有`);
      continue;
    }
    if (Array.isArray(old.packages)) { problems.push(`依赖 ${d.name}: 索引里是 bundle 形态，实际已是单包`); continue; }
    for (const k of ['version', 'path', 'sha256', 'size']) {
      if (String(old[k] ?? '') !== String(d[k] ?? '')) {
        problems.push(`依赖 ${d.name}: ${k} 索引里是 ${old[k] ?? '(空)'}，实际是 ${d[k] ?? '(空)'}`);
      }
    }
  }
  for (const name of oldDeps.keys()) problems.push(`依赖 ${name}: 索引里有，但 deps/ 下已经没有这个包`);
  return { problems, notes };
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
  /** 与插件仓 `scripts/build-index.mjs` 的 `STRUCT_FIELDS` 保持一致（kind 决定下游怎么处理）。 */
  const STRUCT_FIELDS = [
    'id', 'version', 'path', 'runtime', 'sha256', 'frameworkVersion', 'kind',
    'scopes', 'overrides', 'form',
  ];

  const merged = plugins.map((p) => {
    const old = prevById.get(p.id);
    const out = old ? { ...old } : { ...p }; // 新条目：全量写入
    if (old) {
      for (const k of STRUCT_FIELDS) {
        if (p[k] !== undefined && p[k] !== '') out[k] = p[k];
      }
    }
    /**
     * 清空判据看**磁盘实读的 `p`**，不是合并结果 `out`：
     * `out` 是 `{...old}`，旧值还在，`if (!out.kind)` 恒假（上一版就错在这里）。
     */
    if (p.kind === undefined) delete out.kind;
    if (!p.version) delete out.version;
    for (const k of ['scopes', 'overrides', 'form']) {
      if (p[k] === undefined) delete out[k];
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

  /**
   * 依赖镜像：`<仓库>/deps/manifest.json` + 同目录的 tgz。
   *
   * 规则与插件仓 `scripts/build-index.mjs` 的 `readDeps()` **必须一致**，
   * 否则谁跑一次都会把对方写的内容改一遍。哈希一律现算——清单里只写
   * 名字/版本/文件名，哈希手抄一次就多一个出错点。
   */
  const depsList = await readDeps(dir);
  if (depsList.length) out.deps = depsList;

  if (checkMode) {
    const { problems, notes } = diffIndex(prev, out);
    for (const n of notes) console.warn(`  ! ${n}`);
    if (problems.length) {
      console.error(`✗ 索引不一致（${problems.length} 处）：`);
      for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
      if (problems.length > 40) console.error(`  …还有 ${problems.length - 40} 处`);
      console.error('  跑 `node scripts/build-market-index.mjs` 重新生成。');
      process.exitCode = 1;
      return;
    }
    console.log(`✓ 索引一致（${out.plugins?.length ?? 0} 个插件、${(out.deps ?? []).length} 个依赖镜像${notes.length ? `，${notes.length} 条提示` : ''}）`);
    return;
  }

  await fs.writeFile(target, `${JSON.stringify(out, null, 2)}\n`.replace(/\n/g, prevEol), 'utf8');

  console.log(`\n已生成 ${target}`);
  console.log(`  ${merged.length} 个插件${out.repo ? `，repo=${out.repo}` : '（没有 repo，安装会失败）'}`);
  for (const p of merged) {
    console.log(`  - ${p.id}${p.version ? ` v${p.version}` : ''}（${p.runtime}）${p.sha256 ? '' : '  ⚠ 无 sha256'}`);
  }
  for (const d of out.deps ?? []) {
    if (Array.isArray(d.packages)) {
      const kb = Math.round(d.packages.reduce((s, p) => s + (Number(p.size) || 0), 0) / 1024);
      console.log(`  · 依赖镜像 ${d.name}@${d.version}（${d.packages.length} 个包平铺，${kb}KB）`);
      continue;
    }
    console.log(`  · 依赖镜像 ${d.name}@${d.version}（${Math.round(d.size / 1024)}KB）`);
  }
}

main().catch((e) => {
  console.error('生成失败：', e.message);
  process.exit(1);
});
