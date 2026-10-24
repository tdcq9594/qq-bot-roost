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
 * 用法：
 *   node scripts/check-secrets.mjs          扫默认目录
 *   node scripts/check-secrets.mjs --all    连 docs / README 一起扫
 *
 * 退出码：0 = 没发现问题，1 = 发现了
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 默认扫这些目录（代码所在处）。文档单独用 --all 才扫。 */
const CODE_DIRS = ['src', 'web', 'test', 'scripts', 'sdk'];
const DOC_DIRS = ['docs'];

const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.yml', '.yaml']);

/** 不扫的东西 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', 'config', 'dist', 'coverage']);

/**
 * 「键名像凭据 + 值是一段够长的无空格字符串」。
 *
 * 键名要收紧到这些词，否则 `token: x` 这种普通变量会被误抓。
 * 值的字符集按常见密钥来（base62 + 少量符号），长度门槛 16——
 * 真实的 AppSecret / access token 都在 30 位以上。
 */
const PATTERN =
  /(?:app_?secret|secret|access_?token|refresh_?token|api_?key|access_?key|client_?secret|password|passwd|private_?key)\s*[:=]\s*['"`]([A-Za-z0-9_\-+/=.]{16,})['"`]/gi;

/**
 * 值里含这些词就是占位符 / 假值，放行。
 *
 * `test-` 单独列出来是因为测试里常用 `test-secret-...` 这种命名。
 */
const SAFE = /fake|dummy|example|placeholder|sample|mock|test[-_]|not[-_]a[-_]real|change[-_]?me|your[-_]|xxxx|\*\*\*|\.\.\.|<|>|\$\{/i;

/** 递归收集文件 */
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

const args = process.argv.slice(2);
const scanAll = args.includes('--all');
const dirs = scanAll ? [...CODE_DIRS, ...DOC_DIRS] : CODE_DIRS;

const files = dirs.flatMap((d) => collect(path.join(ROOT, d)));
const hits = [];

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
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
        file: path.relative(ROOT, file).split(path.sep).join('/'),
        line: i + 1,
        // 只露头尾，别把完整值打到 CI 日志里——那等于二次泄露
        preview: value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '…',
        key: m[0].split(/[:=]/)[0].trim(),
      });
    }
  }
}

console.log(`扫描 ${files.length} 个文件（${dirs.join(', ')}）`);

if (!hits.length) {
  console.log('OK：没有发现硬编码的凭据');
  process.exit(0);
}

console.error(`\n发现 ${hits.length} 处疑似硬编码凭据：\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  ${h.key} = ${h.preview}`);
}
console.error(
  '\n怎么改：\n' +
    '  · 测试/示例里用明显的假值，比如 test-secret-not-a-real-key\n' +
    '  · 真凭据放 config/bot.json（已在 .gitignore 里），或用环境变量\n' +
    '  · 已经推上去过的，光改代码不够——必须去平台重置\n',
);
process.exit(1);
