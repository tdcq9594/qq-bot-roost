#!/usr/bin/env node
/**
 * 生成 / 校验 SHA256SUMS
 * ======================
 *
 * 为什么需要这个文件：框架的「自更新」是下载 tarball 然后覆盖 `src/`、`web/`。
 * 以前这一步**不校验任何内容** —— 只要能改掉下载地址（自定义镜像、上游仓库被入侵），
 * 就能决定用户下一版跑什么代码。这是远程代码执行。
 *
 * SHA256SUMS 记录每个版本的**内容指纹**，更新时解包后自己算一遍比对，
 * 不一致就中止并保留旧版本。
 *
 * 为什么不用「压缩包的 sha256」：GitHub 的 `archive/refs/tags/*.tar.gz` 是
 * 每次请求现场打包的，gzip 头里的时间戳、压缩实现都会让字节流不同，
 * 同一个 tag 两次下载能算出两个值，根本没法预先记录。
 *
 * 用法：
 *   node scripts/build-sums.mjs           生成当前版本的指纹并写入 SHA256SUMS
 *   node scripts/build-sums.mjs --check   只检查「当前版本是否有条目」（CI 用）
 *   node scripts/build-sums.mjs --verify  条目存在、且指纹与当前内容一致
 *
 * 指纹口径必须与「解包后的 tarball」完全一致：
 *   - 这里用 `git ls-files` 拿会被打包的文件（`data/`、`logs/`、`config/`、
 *     `plugins/` 都不在版本控制里，也就不在包里）
 *   - 算法与 src/hashdir.js 的 hashFileList 相同（路径、大小、内容、CRLF 归一）
 *
 * **SHA256SUMS 自己不能算进去**：它记录的是它自己所在目录的内容，
 * 把自己算进去就成了循环依赖 —— 写进去的瞬间指纹就变了，永远对不上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashFileList } from '../src/hashdir.js';
import { CODE_ENTRIES } from '../src/update-scope.js';
import { compareVersion } from '../src/semver.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SUMS_FILE = 'SHA256SUMS';
const SUMS_PATH = path.join(ROOT, SUMS_FILE);

const args = new Set(process.argv.slice(2));

/** 当前版本号（去掉可能存在的 v 前缀） */
function currentVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return String(pkg.version ?? '').replace(/^v/i, '') || '0.0.0';
}

/** 会被打进 tarball 的文件清单（排除 SHA256SUMS 自身） */
function trackedFiles() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    console.error('读不到 git 文件清单（不在 git 仓库里？）：' + e.message);
    console.error('这个脚本必须在仓库根目录下、且 git 可用时运行。');
    process.exit(2);
  }
  /**
   * 只算「会被更新覆盖的那些路径」——必须与 updater.js 校验时的范围完全一致。
   *
   * 原因：GitHub 的 tarball 是全量（还带 .github、scripts、sdk、types），
   * 而 Gitee 源只拉 CODE_ENTRIES 这几个条目。如果指纹按「包里全部文件」算，
   * 两条下载路径必然算出不同值 —— 一条永远校验失败，一条等于没校验。
   */
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => f !== SUMS_FILE)
    .filter((f) => CODE_ENTRIES.some((p) => f === p || f.startsWith(`${p}/`)));
}

/**
 * 哪些「会被算进指纹的」文件**还没进索引**。
 *
 * 为什么必须拦：`trackedFiles()` 和 `hashFileList()` 读的都是**工作区**里的
 * 文件内容，而指纹要描述的是**提交出去、别人下载到**的那份内容。工作区里还
 * 躺着没 `git add` 的改动，等于给一个不存在的版本盖章 —— tag 一打，所有从
 * 这个版本更新的人都会校验失败，而且现象很像「下载源被篡改」，极难往回追。
 *
 * 判据是「工作区 vs 索引」，**不是「索引 vs HEAD」**：发版顺序本来就是
 * `git add -A` → bump → `npm run sums` → commit，跑 sums 时改动已暂存、
 * 还没提交，那是正常状态，指纹照样准确。
 *
 * 两样都算：
 *   ① `git diff` —— 改了但没 add；
 *   ② 未跟踪文件 —— `git ls-files` 根本列不到它们，指纹会**静默漏掉**
 *      （曾经漏了 `src/reach.js`，CI 与 tag 双红）。
 *
 * 只看进指纹的条目：改了 `config/`、`logs/` 这些不参与打包的东西不算。
 *
 * @returns {string[]} 还没进索引的相对路径
 */
function dirtyTracked() {
  const run = (argv) => {
    try {
      return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' });
    } catch {
      return ''; // 读不到就交给后面的 hashFileList 去报错，这里不添乱
    }
  };
  const unstaged = run(['diff', '--name-only', '-z']).split('\0');
  const untracked = run(['ls-files', '-o', '--exclude-standard', '-z']).split('\0');

  return [...new Set([...unstaged, ...untracked])]
    .filter(Boolean)
    .filter((f) => f !== SUMS_FILE)
    .filter((f) => CODE_ENTRIES.some((p) => f === p || f.startsWith(`${p}/`)));
}

/** 读现有 SHA256SUMS → Map<version, hash> */
function readSums() {
  const map = new Map();
  if (!fs.existsSync(SUMS_PATH)) return map;
  for (const line of fs.readFileSync(SUMS_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+v?([0-9][\w.+-]*)$/i.exec(line.trim());
    if (m) map.set(m[2].replace(/^v/i, ''), m[1].toLowerCase());
  }
  return map;
}

function writeSums(map) {
  /**
   * 版本号倒序（新的在上面），方便肉眼看最近几版。
   *
   * 必须按**语义版本**比，不能按字符串：字符串比较下 `'0.8.10' < '0.8.9'`、
   * `'0.10.0' < '0.9.0'`，新版会被插到中间，而且每次跑出来的顺序还可能不一样，
   * 白白多出无意义的 diff。
   */
  const lines = [...map.entries()]
    .sort((a, b) => compareVersion(b[0], a[0]))
    .map(([v, h]) => `${h}  v${v}`);
  fs.writeFileSync(SUMS_PATH, `${lines.join('\n')}\n`, 'utf8');
}

const version = currentVersion();
const existing = readSums();

if (args.has('--check')) {
  /**
   * CI 用：只检查「当前 package.json 的版本在 SHA256SUMS 里有条目」。
   *
   * 为什么不顺带校验指纹：开发过程中代码一直在变，而版本号没变，
   * 指纹必然对不上 —— 那样 CI 会天天红，最后大家就把它当噪音忽略了。
   * 真正该拦的是「发版时忘了生成指纹」：版本一 bump，这里就会报缺条目。
   */
  if (existing.has(version)) {
    console.log(`OK：SHA256SUMS 里有 v${version} 的指纹（${existing.get(version).slice(0, 12)}…）`);
    process.exit(0);
  }
  console.error(`✗ SHA256SUMS 里没有 v${version} 的条目。`);
  console.error('  发版前请运行：npm run sums');
  process.exit(1);
}

const actual = await hashFileList(ROOT, trackedFiles());

if (args.has('--verify')) {
  const rec = existing.get(version);
  if (!rec) {
    console.error(`✗ SHA256SUMS 里没有 v${version}`);
    process.exit(1);
  }
  if (rec !== actual) {
    console.error('✗ 指纹不一致：');
    console.error(`  记录 ${rec}`);
    console.error(`  实际 ${actual}`);
    const dirty = dirtyTracked();
    if (dirty.length) {
      console.error(`  注意：有 ${dirty.length} 个改动还没进索引（${dirty.slice(0, 3).join('、')}${dirty.length > 3 ? ' 等' : ''}）`);
      console.error('        这时算出的「实际」不等于即将提交的内容，先 git add 再验。');
    } else {
      console.error('  改了代码却忘了重新生成？跑 npm run sums');
    }
    process.exit(1);
  }
  console.log(`OK：v${version} 指纹一致（${rec.slice(0, 12)}…）`);
  process.exit(0);
}

// 默认：写入当前版本
/**
 * 写入前必须干净。
 *
 * `--allow-dirty` 是给「只想预演一下数字」留的逃生阀，**不能用于发版**：
 * 这样写进去的指纹描述的是工作区，tag 里却是另一个内容。
 */
const dirty = dirtyTracked();
if (dirty.length && !args.has('--allow-dirty')) {
  console.error(`✗ 有 ${dirty.length} 个改动还没进索引，不能就这么生成指纹：`);
  for (const f of dirty.slice(0, 10)) console.error(`    ${f}`);
  if (dirty.length > 10) console.error(`    …还有 ${dirty.length - 10} 个`);
  console.error('  指纹描述的是「提交出去、别人下载到」的内容。没 add 的改动不在提交里，');
  console.error('  未跟踪的新文件更是连 git ls-files 都列不到 —— 指纹会漏掉它，');
  console.error('  该 tag 的自动更新会全部失败。');
  console.error('  正确顺序：git add -A → bump → npm run sums。只想看数字可以加 --allow-dirty。');
  process.exit(1);
}

const prev = existing.get(version);
existing.set(version, actual);
writeSums(existing);
console.log(`已写入 v${version} → ${actual}`);
if (prev && prev !== actual) console.log(`  （覆盖了旧值 ${prev.slice(0, 12)}…）`);
console.log(`  共记录 ${existing.size} 个版本：${[...existing.keys()].join(', ')}`);
