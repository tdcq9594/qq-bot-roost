#!/usr/bin/env node
/**
 * 发版材料一键准备
 * ==================
 *
 * 发版要改的东西里，只有两样需要人判断：**版本号**和 **RELEASE_NOTES 正文**。
 * 其余全是机械活，而且改错任何一个都会红：
 *
 *   · README 版本徽章 —— `ci.yml` 的「版本徽章」是必需检查，不一致直接卡 PR；
 *   · `SHA256SUMS` —— 忘了重跑，用户的自动更新会被**拒绝**（updater 是严格模式）；
 *   · 文档里的测试数 —— 不是门禁，但会把一个假的数字挂在首页和 README 上。
 *
 * ── 为什么不让 CI 在合并后自动改 ──
 *
 * CI 用 `GITHUB_TOKEN` 推出来的提交**不会触发新的 workflow**（GitHub 防递归），
 * 等于「要被发布的那个提交没跑过测试」；改用 PAT 能绕开，但那是长期令牌要进
 * secret，还得给 `GITHUB_TOKEN` 开 bypass 直推 master——那正是铁律 11 要守的
 * 那条线。所以机械部分放在合并前、由这个脚本一次做完，版本号仍由人传参决定，
 * 保留「协议不兼容时跳 minor」的能力（不按 commit 语义推断，见发版铁律）。
 *
 * ── 用法 ──
 *
 *   node scripts/release-prepare.mjs 1.1.8
 *   node scripts/release-prepare.mjs 1.1.8 --no-test   # 跳过测试统计，数字沿用现值
 *   node scripts/release-prepare.mjs 1.1.8 --dry-run   # 只打印将要改什么，不落盘
 *
 * ── 它做什么（顺序不能乱）──
 *
 *   1. 校验：版本号递增、工作区干净（发版材料要叠在已提交的代码上）
 *   2. bump `package.json`
 *   3. 跑测试统计：自检 / 四个小脚本 / node:test 文件数与用例数 / e2e
 *   4. 改 README：两处徽章 + 四个统计数字（**每个都必须命中，否则报错**）
 *   5. 在 `RELEASE_NOTES.md` 顶部插骨架（本次提交列表放在 HTML 注释里做参考）
 *   6. `git add -A` → `npm run sums` → `git add SHA256SUMS` → `sums:verify`
 *
 * ── 它不做什么 ──
 *
 * 不写 notes 正文、不 commit、不 push、不开 PR、不打标签。那些是人的决定。
 *
 * ── 失败了怎么办 ──
 *
 * 全场只动 4 个文件，直接回滚即可：
 *   `git checkout -- package.json README.md RELEASE_NOTES.md SHA256SUMS`
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { compareVersion } from '../src/semver.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const README = path.join(ROOT, 'README.md');
const NOTES = path.join(ROOT, 'RELEASE_NOTES.md');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const SKIP_TEST = argv.includes('--no-test');
const target = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));

const die = (msg, hint = '') => {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▸ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

/** 读写都保持文件原来的换行风格：Windows 工作区可能是 CRLF，改完别整篇标红 */
function readText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  return { text: crlf ? raw.replace(/\r\n/g, '\n') : raw, crlf };
}
function writeText(file, text, crlf) {
  if (DRY) return;
  fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text);
}

/**
 * 替换并断言**至少命中一次**。
 *
 * 宁可在这里报错，也不要静默跳过——静默跳过的后果是 README 上继续挂着旧数字，
 * 而下一次发版还是不会有人发现。
 */
function mustReplace(text, re, replacer, label) {
  if (!re.test(text)) die(`${label}：在 README 里找不到匹配（正则 ${re}）`, '可能是文档改写了，先更新脚本里的正则');
  re.lastIndex = 0;
  return text.replace(re, replacer);
}

/* ---------------- 1. 参数与前��� ---------------- */

if (!target) {
  die('缺少版本号', '用法：node scripts/release-prepare.mjs 1.1.8');
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
const cur = String(pkg.version);
if (compareVersion(target, cur) === 0) {
  console.log(`版本已经是 ${target}，跳过 bump，只重算材料。`);
} else if (compareVersion(target, cur) < 0) {
  die(`目标版本 ${target} 低于当前 ${cur}`, '版本号只能往上走；发错了只能再发一个更高版本');
}

/**
 * 要求工作区干净：
 *   · 发版材料必须叠在**已经提交**的代码上，否则 `git add -A` 会把无关改动卷进来；
 *   · 指纹是按工作区内容算的，半成品也会被写进 SHA256SUMS。
 */
if (!DRY) {
  const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) {
    die('工作区有未提交的改动，先把它们提交掉', `当前：\n${dirty.split('\n').map((l) => `    ${l}`).join('\n')}`);
  }
}

/* ---------------- 2. 跑测试统计 ---------------- */

/**
 * 统计口径（与 README 徽章一致）：
 *   总数 = `PASS` 行数（5 个脚本自己打印的） + `# tests` 之和（node:test 用例）
 *
 * `PASS` 只来自那 5 个脚本，所以「selftest = PASS 总数 − 另外四个」，不必把
 * selftest 单独再跑一遍（它是最慢的那一个）。
 */
function countPass(text) {
  return (text.match(/^PASS /gm) || []).length;
}
function sumNodeTests(text) {
  let n = 0;
  for (const m of text.matchAll(/^# tests (\d+)$/gm)) n += Number(m[1]);
  return n;
}

const run = (args, label) => {
  try {
    return execFileSync(args[0], args.slice(1), {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    die(`${label} 失败`, (e.stdout || '') + (e.stderr || '') || e.message);
  }
};

/**
 * `npm` 在 Windows 上是 `npm.cmd`，Node 20 起 `execFile` 不能直接跑 `.cmd`
 * （CVE-2024-27980 之后必须经 shell），所以这条路单独走 `execSync`。
 */
const runNpm = (cmd, label) => {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    die(`${label} 失败`, (e.stdout || '') + (e.stderr || '') || e.message);
  }
};

let stats = null;
if (SKIP_TEST) {
  console.log('\n▸ 跳过测试统计（--no-test），README 里的数字保持现值');
} else {
  step('跑 npm test（约 1–2 分钟）');
  const testOut = runNpm('npm test', 'npm test');
  const passTotal = countPass(testOut);
  const nodeTests = sumNodeTests(testOut);
  ok(`PASS ${passTotal} 行，node:test ${nodeTests} 项`);

  step('单独统计四个小脚本（几秒）');
  const small = {};
  for (const name of ['qrlogin', 'deps', 'npm-registry', 'deps-external']) {
    small[name] = countPass(run([process.execPath, `test/${name}.mjs`], name));
    ok(`${name}: ${small[name]}`);
  }
  const smallSum = Object.values(small).reduce((a, b) => a + b, 0);
  const selftest = passTotal - smallSum;
  if (selftest <= 0) {
    die(`自检项数算出来是 ${selftest}，明显不对`, 'PASS 行的构成变了？检查 npm test 的输出格式');
  }
  ok(`selftest: ${selftest}（= ${passTotal} − ${smallSum}）`);

  step('跑 e2e（约 30 秒）');
  const e2e = countPass(run([process.execPath, 'test/e2e.mjs'], 'e2e'));
  ok(`e2e: ${e2e}`);

  const testScript = String(pkg.scripts?.test ?? '');
  const testFiles = (testScript.match(/node --test/g) || []).length;
  ok(`node:test 文件数: ${testFiles}`);

  stats = {
    total: passTotal + nodeTests,
    passTotal,
    nodeTests,
    selftest,
    qrlogin: small.qrlogin,
    deps: small.deps,
    npmRegistry: small['npm-registry'],
    depsExternal: small['deps-external'],
    testFiles,
    e2e,
  };
}

/* ---------------- 3. 改 package.json ---------------- */

if (compareVersion(target, cur) > 0) {
  step(`bump ${cur} → ${target}`);
  if (!DRY) {
    const raw = fs.readFileSync(PKG, 'utf8');
    /** 只替换顶层 `"version"` 那一个，别把依赖里的版本号动了 */
    const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${target}$2`);
    if (next === raw) die('package.json 里没找到顶层 version 字段');
    fs.writeFileSync(PKG, next);
  }
  ok(`package.json: ${cur} → ${target}`);
}

/* ---------------- 4. 改 README ---------------- */

step('对齐 README 的徽章与统计数字');
const rd = readText(README);
let r = rd.text;

/** 版本徽章（含 alt 文案）——`ci.yml` 的硬门禁就查这一处 */
r = mustReplace(
  r,
  /badge\/version-[\d.]+-blueviolet" alt="版本 [\d.]+"/,
  `badge/version-${target}-blueviolet" alt="版本 ${target}"`,
  '版本徽章',
);

if (stats) {
  /** 测试数徽章：badge 里是 URL 编码的空格（%20），alt 里是普通空格 */
  r = mustReplace(
    r,
    /badge\/tests-\d+%20passed-brightgreen" alt="测试 \d+ 项"/,
    `badge/tests-${stats.total}%20passed-brightgreen" alt="测试 ${stats.total} 项"`,
    '测试数徽章',
  );

  /** 目录树里的两项 */
  r = mustReplace(r, /框架自检（\d+ 项）/, (m) => m.replace(/\d+/, stats.selftest), 'selftest 项数');
  r = mustReplace(r, /端到端测试（\d+ 项/, (m) => m.replace(/\d+/, stats.e2e), 'e2e 项数');

  /** 命令速查里那一整行：五段分解 + node:test 文件数 + 用例总数 */
  r = mustReplace(
    r,
    /自检 \d+ \+ qrlogin \d+ \+ deps \d+ \+ npm-registry \d+ \+ deps-external \d+，另跑 \d+ 个 node:test 文件（共 \d+ 项）/,
    `自检 ${stats.selftest} + qrlogin ${stats.qrlogin} + deps ${stats.deps} + npm-registry ${stats.npmRegistry} + deps-external ${stats.depsExternal}，另跑 ${stats.testFiles} 个 node:test 文件（共 ${stats.nodeTests} 项）`,
    '命令速查的测试分解',
  );

  /** 「全量约 N 项」= npm test 总数 + e2e（live-driver 要真机，历史口径没算它） */
  r = mustReplace(r, /全量约 \d+ 项/, `全量约 ${stats.total + stats.e2e} 项`, '全量项数');
}

writeText(README, r, rd.crlf);
ok(`README: 徽章 ${target}、测试数 ${stats ? stats.total : '(未重算)'}`);

/* ---------------- 5. RELEASE_NOTES 骨架 ---------------- */

step('准备 RELEASE_NOTES 顶部段');
const nd = readText(NOTES);
const firstHead = /^## v([\d.]+)/m.exec(nd.text);
if (firstHead && firstHead[1] === target) {
  ok(`顶部段已经是 v${target}，不重复插入`);
} else {
  /** 本次改动 = 上一个 tag 之后的提交；没有 tag 就退回最近 20 条 */
  let commits = [];
  try {
    commits = execSync('git log --oneline --no-decorate -20', { cwd: ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    /* 没 git 也不致命，草稿里少一段参考而已 */
  }
  const skeleton = [
    `## v${target}：<一句话主题（会被用作 Release 标题）>`,
    '',
    `> \`latest\` 从 **${cur}** 升到 **${target}**。<一句话说清这版改了什么、要不要用户动手>`,
    '',
    '<!-- 下面这段是 release-prepare 生成的提交参考，写完正文可以整块删掉 -->',
    '<!--',
    ...commits.map((c) => `- ${c}`),
    '-->',
    '',
  ].join('\n');
  writeText(NOTES, `${skeleton}\n${nd.text}`, nd.crlf);
  ok(`已插入 v${target} 骨架（正文待写）`);
}

/* ---------------- 6. 指纹 ---------------- */

step('重算内容指纹');
if (DRY) {
  console.log('  （--dry-run 跳过）');
} else {
  /**
   * 顺序是硬要求：
   *   ① 先 `git add -A` —— `build-sums` 用 `git ls-files` 拿清单，未跟踪的新文件不在里面；
   *   ② 跑 sums 写文件；
   *   ③ 再 `git add SHA256SUMS` —— 它在 ② 之后才变，不重新 add 的话提交里是旧指纹。
   */
  execSync('git add -A', { cwd: ROOT, stdio: 'inherit' });
  execSync('node scripts/build-sums.mjs', { cwd: ROOT, stdio: 'inherit' });
  execSync('git add SHA256SUMS', { cwd: ROOT, stdio: 'inherit' });
  execSync('node scripts/build-sums.mjs --verify', { cwd: ROOT, stdio: 'inherit' });
  ok('指纹已重算并校验一致');
}

/* ---------------- 收尾 ---------------- */

console.log(`
${DRY ? '（--dry-run，以上都没有落盘）' : ''}
下一步（都需要人做）：
  1. 写 RELEASE_NOTES.md 顶部段的正文（版本号和主题必须保留，\`## v${target}：\` 开头）
  2. git commit（脚本没有提交）
  3. git push 推分支 → 开 PR → **给 PR 打 \`release\` 标签**
  4. CI 全绿后合并 —— 合并即自动发版（tag / Release / npm / 签名 / beta）

回滚：git checkout -- package.json README.md RELEASE_NOTES.md SHA256SUMS
`);
