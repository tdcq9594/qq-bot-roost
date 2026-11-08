/**
 * 插件**运行期**错误的环形缓冲。
 *
 * 加载期错误一直有 `errorStacks`；但「装得上、面板显示成功、handler 每轮抛错」
 * 以前一点痕迹都没有，用户只看到机器人不回话。留最近 8 条就够看出
 * 「一直在报同一个错」，又不会把内存吃穿。
 */

export const RUNTIME_ERROR_MAX = 8;

/**
 * @param {Array} ring 已有条目（原地追加后返回同一个数组）
 * @param {unknown} err 异常对象或字符串
 * @param {number} [at] 时间戳，测试里可注入
 * @returns {Array} 截断到 8 条的环形缓冲
 */
export function pushRuntimeError(ring, err, at = Date.now()) {
  const list = Array.isArray(ring) ? ring : [];
  list.push({
    at,
    message: String(err?.message ?? err ?? ''),
    // 完整堆栈太长，面板只展得开前几行；第一行通常就够定位
    stack: String(err?.stack ?? '').split('\n').slice(0, 4).join('\n'),
  });
  if (list.length > RUNTIME_ERROR_MAX) list.splice(0, list.length - RUNTIME_ERROR_MAX);
  return list;
}
