/**
 * 阶段 2 影子编译样本：src/fsutil.js 的 TS 版本。
 *
 * 这不是入口文件，主程序仍用 src/fsutil.js。它的唯一用途：
 *   1. 用 tsc 编译到 out/fsutil.js
 *   2. 对照测试证明编译产物与原 JS 行为一致（含错误路径）
 *
 * 这样在真正把任何文件改名成 .ts 之前，先验证"编译产物 ≡ 手写 JS"这条假设。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 原子写 JSON。（与 src/fsutil.js 逐字等价，只多了类型注解）
 * @param file 目标路径
 * @param data 会被 JSON.stringify 的内容
 */
export async function writeJsonAtomic(file: string, data: any): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 读 JSON；解析失败时把坏文件留一份再返回 null。（与 src/fsutil.js 逐字等价）
 * @param file
 * @param onError 出错回调（通常是 log.error）
 * @returns 解析失败返回 null
 */
export async function readJsonSafe(
  file: string,
  onError?: (msg: string) => void,
): Promise<any | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    onError?.(`读取 ${path.basename(file)} 失败：${e.message}`);
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (e: any) {
    const bak = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, bak).catch(() => {});
    onError?.(`${path.basename(file)} 解析失败（${e.message}），已备份为 ${path.basename(bak)}，本次用默认值`);
    return null;
  }
}
