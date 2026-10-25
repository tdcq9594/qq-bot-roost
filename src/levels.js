/**
 * 权限等级空间
 * ============
 * 等级是数字，越小权限越高。整个空间分区管理，避免内核和插件、插件和插件之间撞号。
 *
 *   0 - 3    内核独占，语义固定，插件只能读不能改
 *              0 主人 / 1 管理员 / 2 群管 / 3 助手
 *   4 - 9    内核预留（以后加「超管」「审计」之类不用重排）
 *   10 - 999 插件区，主程序在启动时按插件 id 排序，每个插件分 10 个号位
 *              第 1 个插件 10-19，第 2 个 20-29，以此类推
 *   1000+    留给以后（比如跨机器人的联合权限）
 *
 * 为什么按 id 排序而不是按加载顺序：
 * 加载顺序可能因为目录读取顺序变化，重启后号段漂移会让已配置的权限错位。
 * 按 id 字典序分配是**确定性**的，同一个插件永远拿到同一个号段。
 */

export const CORE = {
  owner: 0,
  admin: 1,
  manager: 2,
  helper: 3,
};

/** 内核保留区间（含两端） */
export const CORE_RESERVED = { min: 0, max: 9 };

/** 插件区起点与每个插件的号位数量 */
export const PLUGIN_START = 10;
export const PLUGIN_STRIDE = 10;

/** 无权限 */
export const NO_PERM = 9999;

/**
 * 给一批插件分配等级号段。
 * @param {string[]} pluginIds
 * @returns {Map<string, {base:number, end:number, index:number}>}
 */
export function allocateLevels(pluginIds) {
  const sorted = [...new Set(pluginIds)].sort();
  const map = new Map();
  sorted.forEach((id, index) => {
    const base = PLUGIN_START + index * PLUGIN_STRIDE;
    map.set(id, { base, end: base + PLUGIN_STRIDE - 1, index });
  });
  return map;
}

/** 该等级属于哪个区 */
export function zoneOf(level) {
  if (level <= CORE_RESERVED.max) return 'core';
  if (level >= PLUGIN_START && level < 1000) return 'plugin';
  return 'reserved';
}

/** 人类可读的等级说明 */
export function describeLevel(level) {
  if (level === 0) return '主人';
  if (level === 1) return '管理员';
  if (level === 2) return '群管';
  if (level === 3) return '助手';
  if (level === NO_PERM) return '普通成员';
  if (level >= 4 && level <= 9) return `框架预留 ${level}`;
  if (level >= PLUGIN_START && level < 1000) return `插件等级 ${level}`;
  return `${level} 级`;
}
