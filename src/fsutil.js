/**
 * 小工具：把 JSON 安全地写进文件
 * ==============================
 *
 * 直接 `fs.writeFile(file, JSON.stringify(...))` 有个要命的窗口：
 * 写到一半进程被杀 / 断电，文件就是半截 JSON。下次启动解析失败，
 * 权限表、群档案这种「全量重写」的数据就整体没了。
 *
 * 这里走标准的 tmp + rename：rename 在同一分区上是原子的，
 * 要么看到旧文件，要么看到完整的新文件，不会看到半截。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 原子写 JSON。
 * @param {string} file 目标路径
 * @param {any} data 会被 JSON.stringify 的内容
 */
export async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 临时文件放在同目录，保证 rename 不跨分区
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  try {
    /**
     * `mode: 0o600` —— 只有属主能读写。
     *
     * 这些 JSON 里有 `config/bot.json`、`config/bots/<id>.json`，都带明文
     * AppSecret；还有权限表、群档案。Linux 默认 umask 022 下新建文件是 644，
     * 同机其他用户直接 `cat` 就能拿到机器人凭证。
     *
     * 注意两点：
     *   - mode 只在**创建**时生效，而这里的 tmp 每次都是新文件，所以一定吃到
     *   - rename 会保留临时文件的权限，覆盖掉旧文件原来的 644 —— 也就是说
     *     用户只要保存过一次配置，老文件的权限就被修正了，不需要单独做迁移
     *   - Windows 上 mode 被忽略，不影响运行
     */
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 读 JSON；解析失败时把坏文件留一份再返回 null。
 *
 * 以前是 `catch { return {} }`，然后把默认值写回去——原文件被静默覆盖，
 * 用户永远不知道自己的权限表是怎么没的。
 *
 * @param {string} file
 * @param {(msg: string) => void} [onError] 出错回调（通常是 log.error）
 * @returns {Promise<any|null>} 解析失败返回 null
 */
export async function readJsonSafe(file, onError) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    // 文件不存在是正常的（首次运行）
    if (e.code === 'ENOENT') return null;
    onError?.(`读取 ${path.basename(file)} 失败：${e.message}`);
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    // 坏文件先留档，别让后面的「写回默认值」把它覆盖掉
    const bak = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, bak).catch(() => {});
    onError?.(`${path.basename(file)} 解析失败（${e.message}），已备份为 ${path.basename(bak)}，本次用默认值`);
    return null;
  }
}
