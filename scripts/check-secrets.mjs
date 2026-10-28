/**
 * 硬编码凭据扫描
 * ==============
 *
 * 为什么需要这个：`test/e2e.mjs` 里曾经硬编码过**真实的 AppSecret**，
 * 仓库是公开的，等于把机器人凭证摆在明面上。人肉 review 抓不住这种事
 * ——那一行看起来和「随便一个测试字符串」没区别。
 *
 * 判据故意做得**窄**：只看「键名像凭据、值够长、不像占位符」的赋值。
 * 宁可漏报也不误报——一个动不动就报错的检查，两天后就会被人加 `|| true`
 * 绕过去，那还不如没有。
 *
 * ## 2026-10-28 改：从「扫目录」改成「扫 git 跟踪的文件」
 *
 * 原来的实现是列几个目录递归扫，而且 `SKIP_DIRS` 里**有 `config`**——
 * 理由是「运行时配置本来就放密钥，别误报」。结果 CI 天天跑这个检查，
 * 却从来不看 `config/` 一眼：`config/backups/` 里 14 份配置备份
 * （12 份带真 AppSecret）被推到了 GitHub + Gitee，这个脚本一路绿灯。
 *
 * 教训是**判据选错了**。要守的不是「磁盘上有没有密钥」——本机配置里
 * 有密钥是正常的、必须的；要守的是「**仓库里**有没有密钥」。
 * 所以现在直接拿 `git ls-files`，跟踪了什么就扫什么，一个目录都不跳。
 * 没被跟踪的文件（比如 `config/bot.json`）自然不在列表里，不用靠
 * `.gitignore` 的规则去猜。
 *
 * 另外加了一条硬规则：`config/backups/` 下只要还有被跟踪的文件就报错。
 * 那个目录是运行时备份，**里面必然是明文 AppSecret**，永远不该入库。
 *
 * 用法：
 *   node scripts/check-secrets.mjs          扫 git 跟踪的全部文件
 *   node scripts/check-secrets.mjs --all    同上（保留旧参数，别让 CI 挂）
 *
 * 不在 git 仓库里（比如 npm 包里跑）时退化成扫目录，行为同旧版。
 *
 * 退出码：0 = 没发现问题，1 = 发现了
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 没有 git 时退化成扫这些目录（代码所在处） */
const CODE_DIRS = ['src', 'web', 'test', 'scripts', 'sdk'];
const DOC_DIRS = ['docs'];

const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.yml', '.yaml']);

/** 只在这个模式下用；git 模式下一个目录都不跳 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', 'dist', 'coverage']);

/**
 * 「键名像凭据 + 值是一段够长的无空格字符串」。
 *
 * 键名要收紧到这些词，否则 `token: x` 这种普通变量会被误抓。
 * 值的字符集按常见密钥来（base62 + 少量符号），长度门槛 16——
 * 真实的 AppSecret / access token 都在 30 位以上。
 *
 * 键名后面那个 `["']?` 不能省：JSON 里写的是 `"appSecret": "…"`，
 * 键名和冒号之间隔着一个引号。少了它，**所有 .json 配置文件都不会被扫到**
 * ——而密钥恰恰最常躺在 JSON 里。2026-10-28 那次泄露就同时踩了这一个坑。
 */
const PATTERN =
  /(?:app_?secret|secret|access_?token|refresh_?token|api_?key|access_?key|client_?secret|password|passwd|private_?key)["']?\s*[:=]\s*['"`]([A-Za-z0-9_\-+/=.]{16,})['"`]/gi;

/**
 * 值里含这些词就是占位符 / 假值，放行。
 *
 * `test-` 单独列出来是因为测试里常用 `test-secret-...` 这种命名。
 */
const SAFE = /fake|dummy|example|placeholder|sample|mock|test[-_]|not[-_]a[-_]real|change[-_]?me|your[-_]|xxxx|\*\*\*|\.\.\.|<|>|\$\{/i;

/**
 * 永远不该入库的目录（相对仓库根）。
 *
 * 这些不是「可能有密钥」，是「**必然**有明文密钥」：
 * 运行时生成的备份、日志、数据目录。命中就报，不商量。
 */
const NEVER_TRACK = ['config/backups/'];

/** 递归收集文件（没有 git 时的退路） */
function collect(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(path.join(dir, e.name), out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 仓库里被跟踪的文件（相对路径，斜杠分隔）。不是 git 仓库就返回 null */
function trackedFiles() {
  try {
    const raw = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return raw.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const scanAll = args.includes('--all');

const tracked = trackedFiles();
let files;
let scope;

if (tracked) {
  // git 模式：跟踪了什么就扫什么。只按扩展名过滤，不按目录跳
  files = tracked.filter((f) => EXTS.has(path.extname(f).toLowerCase()));
  scope = `git 跟踪的 ${files.length} 个文件`;
} else {
  const dirs = scanAll ? [...CODE_DIRS, ...DOC_DIRS] : CODE_DIRS;
  files = dirs.flatMap((d) => collect(path.join(ROOT, d)));
  scope = `扫描 ${files.length} 个文件（${dirs.join(', ')}；没有 git，退化为扫目录）`;
}

const hits = [];

/* ---------- 规则一：必然带密钥的目录，不许入库 ---------- */

if (tracked) {
  for (const prefix of NEVER_TRACK) {
    const bad = tracked.filter((f) => f.startsWith(prefix));
    if (!bad.length) continue;
    hits.push({
      file: prefix,
      line: 0,
      key: '不该入库',
      preview: `${bad.length} 个文件（如 ${bad[0]}）`,
      hard: true,
    });
  }
}

/* ---------- 规则二：值像真密钥 ---------- */

for (const rel of files) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 注释掉的代码也可能是从别处粘过来的真密钥，照样扫
    PATTERN.lastIndex = 0;
    let m;
    while ((m = PATTERN.exec(line)) !== null) {
      const value = m[1];
      if (SAFE.test(value)) continue;
      // 全数字的不算（AppID、时间戳、端口）
      if (/^\d+$/.test(value)) continue;
      hits.push({
        file: rel.split(path.sep).join('/'),
        line: i + 1,
        // 只露头尾，别把完整值打到 CI 日志里——那等于二次泄露
        preview: value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '…',
        key: m[0].split(/[:=]/)[0].trim(),
      });
    }
  }
}

console.log(scope);

if (!hits.length) {
  console.log('OK：没有发现硬编码的凭据');
  process.exit(0);
}

console.error(`\n发现 ${hits.length} 处问题：\n`);
for (const h of hits) {
  const where = h.line ? `${h.file}:${h.line}` : h.file;
  console.error(`  ${where}  ${h.key} = ${h.preview}`);
}
console.error(
  '\n怎么改：\n' +
    '  · 测试/示例里用明显的假值，比如 test-secret-not-a-real-key\n' +
    '  · 真凭据放 config/bot.json（已在 .gitignore 里），或用环境变量\n' +
    '  · config/backups/ 是运行时备份，里面必然是明文密钥——加进 .gitignore，\n' +
    '    再从索引里摘掉：git rm -r --cached config/backups\n' +
    '  · 已经推上去过的，光改代码不够——**必须去平台重置**（历史删不干净）\n',
);
process.exit(1);
