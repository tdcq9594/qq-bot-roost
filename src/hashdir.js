/**
 * 目录内容哈希
 * ============
 *
 * 给插件目录算一个稳定的指纹，用来做供应链校验：索引里存一份，
 * 下载解包后本地再算一遍，对不上就不装。
 *
 * 为什么不用「压缩包的 sha256」：
 * 市场是从 GitHub 拉**分支 tarball**，那个包是 GitHub 每次请求时现场打包的，
 * 字节流不保证稳定（gzip 头里的 mtime、文件顺序都可能变），
 * 根本没法预先算出一个能对上的值。所以只能算**解包后的内容**。
 *
 * 算法：按相对路径排序，逐个喂 `路径 \0 大小 \0 内容 \0`，最后取 sha256。
 * 只跟文件内容与相对路径有关，与机器、时间、打包方式无关。
 *
 * **换行符要归一**：Windows 上 `core.autocrlf=true` 的仓库，检出是 CRLF，
 * 而 GitHub 打的 tarball 里是 LF。按原始字节哈希，两边永远对不上，
 * 结果是「每个插件都校验失败」——比不校验更糟。所以文本文件统一按 LF 算。
 *
 * 两套算法（与插件仓 scripts/hashdir.mjs、dsh-roost src/ext-bundle.js 同步）：
 *   · algo1 = 老算法，纯文档 / LICENSE 计入指纹；旧索引的 `sha256` 是它算的；
 *   · algo2 = 现行算法（HASH_ALGO），排除文档与运行时状态；`sha256_v2` 是它算的。
 * 安装 / 更新时两个都认（见 plugin/market.js 的 entryHashes）；框架自更新的
 * `hashFileList()` 仍只走下面的 `isHashedFile()`，行为不变——别把两套规则混起来。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HASH_SKIP } from './skipdirs.js';

/**
 * algo1 的老跳过表：1.4.0 及以前就是这几项，只用来校验旧索引的 `sha256`。
 * 来自 ./skipdirs.js 的 HASH_SKIP——改它会改变已发布插件的 sha256，必须同步重建索引。
 */
const LEGACY_SKIP_DIRS = HASH_SKIP;
const LEGACY_SKIP_FILES = new Set(['.deps.json', '.DS_Store', 'Thumbs.db']);

/**
 * algo2 额外排除：旧依赖位置、抽帧目录与运行时状态文件。
 * 这些文件不入库，但用户机器上会生成——带进去会让同一份插件算出不同指纹。
 */
const SKIP_DIRS_ALGO2 = new Set([...HASH_SKIP, 'deps', 'shots']);
const SKIP_FILES_ALGO2 = new Set([
  ...LEGACY_SKIP_FILES,
  'ui-data.json', 'qr.png', 'cookie.txt',
  'replies.json', 'replied.json', 'pending.json', 'history.json', 'seen.json',
]);

/** 纯文档不进 algo2 指纹：改 README / LICENSE 不该逼维护者重算索引。 */
function isDocFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || /^(license|licence|copying)(\.[a-z0-9]+)?$/.test(lower);
}

/** 算法版本。与插件仓 scripts/hashdir.mjs、dsh-roost src/ext-bundle.js 保持一致。 */
export const HASH_ALGO = 2;

/**
 * 一个相对路径（`/` 分隔，含文件名）是否参与**框架自更新**的内容指纹。
 *
 * **只服务 hashFileList()（框架自更新 / SHA256SUMS）**，不是插件目录哈希的排除规则：
 * 插件目录哈希走下面 collect() 的 algo1 / algo2 两套表。两处别混——2026-11 就
 * 因为发版脚本漏了这里的文档排除规则，导致 SHA256SUMS 记录的指纹含 17 个
 * md/LICENSE、而更新器解包后算出的不含，v1.1.11 及之后所有版本的自更新全部失败。
 *
 * @param {string} rel 相对路径，如 `src/main.js` / `docs/架构说明.md`
 * @returns {boolean}
 */
export function isHashedFile(rel) {
  const parts = String(rel).split('/');
  const name = parts.pop();
  if (!name) return false;
  // 任一级目录在跳过表里就排除（与 collect 逐层剪枝等价）
  if (parts.some((seg) => LEGACY_SKIP_DIRS.has(seg))) return false;
  if (LEGACY_SKIP_FILES.has(name)) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) return false;
  if (/^(license|licence|copying)(\.[a-z0-9]+)?$/.test(lower)) return false;
  return true;
}

/**
 * 把文本文件的 CRLF 折成 LF；二进制原样返回。
 *
 * 判断依据是「有没有 NUL 字节」，和 git 自己判定二进制的思路一致。
 * 二进制在两侧都不做转换（git 也不会转），所以哈希仍然一致。
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function normalize(buf) {
  if (buf.includes(0)) return buf; // 二进制
  // 没有 \r 就不用动，省一次全量复制
  if (!buf.includes(0x0d)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/**
 * 递归收集目录下的文件（相对路径，统一用 `/`）。
 * @param {string} root
 * @returns {Promise<string[]>} 已排序的相对路径
 */
async function collect(root, algo) {
  const dirs = algo >= 2 ? SKIP_DIRS_ALGO2 : LEGACY_SKIP_DIRS;
  const files = algo >= 2 ? SKIP_FILES_ALGO2 : LEGACY_SKIP_FILES;
  const out = [];

  const walk = async (dir, prefix) => {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (dirs.has(it.name)) continue;
        await walk(path.join(dir, it.name), prefix ? `${prefix}/${it.name}` : it.name);
      } else if (it.isFile()) {
        if (files.has(it.name)) continue;
        if (algo >= 2 && isDocFile(it.name)) continue;
        const rel = prefix ? `${prefix}/${it.name}` : it.name;
        out.push(rel);
      }
      // 符号链接一律跳过：它可能指向仓库外，内容不稳定
    }
  };

  await walk(root, '');
  return out.sort();
}

/**
 * 按给定的相对路径清单算指纹。
 *
 * 为什么要单独一个入口：仓库根目录里有 `data/`、`logs/`、`config/`、`plugins/`
 * 这些**不会被 tarball 打包**的东西，直接 `hashDir(ROOT)` 会把它们算进去，
 * 跟「解包后的 tarball」永远对不上。
 *
 * 所以发布流程用 `git ls-files` 拿到「真正会被打进包的文件」，再喂给这里；
 * 更新校验则用 `hashDir(解包目录)`。两边必须用同一套拼接方式，否则校验必失败。
 *
 * @param {string} root 根目录
 * @param {string[]} rels 相对路径（`/` 分隔）；内部会去重并排序，顺序无关
 * @returns {Promise<string>} 64 位十六进制
 */
export async function hashFileList(root, rels) {
  const files = [...new Set(rels)].sort();
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const buf = normalize(await fs.readFile(path.join(root, rel)));
    h.update(rel);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * 算目录的内容指纹。
 *
 * @param {string} dir 插件目录
 * @param {{algo?: number, exclude?: string[], only?: string[]}} [opts]
 *   - `algo`：1 = 老算法（含文档），2 = 现行算法（排除文档与运行时状态）；默认 HASH_ALGO。
 *     校验市场条目时两个都算，见 plugin/market.js 的 entryHashes。
 *   - `exclude`：精确匹配要跳过的相对路径（如 `SHA256SUMS` 这种会自引用的文件）
 *   - `only`：只算这些路径（`src` 这类目录前缀，或 `package.json` 这类文件名）。
 *     用途：GitHub 的 tarball 是**全量**（含 .github、scripts、sdk），
 *     而 Gitee 源只拉会被更新覆盖的那几个条目，两边目录内容天生不同。
 *     用 `only` 把范围收窄到「真正会被替换的代码」，两边才算得出同一个值。
 * @returns {Promise<string>} 64 位十六进制
 */
export async function hashDir(dir, opts = {}) {
  const algo = Number.isFinite(opts.algo) ? Number(opts.algo) : HASH_ALGO;
  /**
   * 根目录不存在时必须报错，**不能静默返回空哈希**。
   *
   * `collect()` 里对每个目录都有 try/catch（遍历时子目录读不到要跳过），
   * 但连根目录都不存在时它也会安静地返回空数组，算出来就是
   * `e3b0c442…`（空字符串的 sha256）—— 那是一个**合法值**，会像真指纹一样
   * 参与比对，现象是「内容全变了」而不是「路径写错了」，排查时非常误导。
   */
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`算指纹失败：目录不存在或不是目录 —— ${dir}`);

  const skip = new Set(opts.exclude ?? []);
  const only = (opts.only ?? []).map((p) => String(p));
  let files = (await collect(dir, algo)).filter((rel) => !skip.has(rel));
  if (only.length) {
    files = files.filter((rel) =>
      only.some((p) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`)),
    );
  }
  return hashFileList(dir, files);
}
