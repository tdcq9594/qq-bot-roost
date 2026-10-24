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
    await fs.writeFile(tmp, text, 'utf8');
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
