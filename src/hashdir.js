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
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HASH_SKIP } from './skipdirs.js';

/**
 * 不参与哈希的东西见 ./skipdirs.js（HASH_SKIP）。
 * **改它会改变已发布插件的 sha256，必须同步重建 index.json。**
 */
const SKIP_DIRS = HASH_SKIP;
const SKIP_FILES = new Set(['.deps.json', '.DS_Store', 'Thumbs.db']);

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
async function collect(root) {
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
        if (SKIP_DIRS.has(it.name)) continue;
        await walk(path.join(dir, it.name), prefix ? `${prefix}/${it.name}` : it.name);
      } else if (it.isFile()) {
        if (SKIP_FILES.has(it.name)) continue;
        out.push(prefix ? `${prefix}/${it.name}` : it.name);
      }
      // 符号链接一律跳过：它可能指向仓库外，内容不稳定
    }
  };

  await walk(root, '');
  return out.sort();
}

/**
 * 算目录的内容指纹。
 *
 * @param {string} dir 插件目录
 * @returns {Promise<string>} 64 位十六进制
 */
export async function hashDir(dir) {
  const files = await collect(dir);
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const buf = normalize(await fs.readFile(path.join(dir, rel)));
    h.update(rel);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
    h.update('\0');
  }
  return h.digest('hex');
}
