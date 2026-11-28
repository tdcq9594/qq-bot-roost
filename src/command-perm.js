/**
 * 命令权限判定
 * ============
 *
 * 从 `bot.js` 里抽出来的纯函数：那里是消息流水线，构造一次 Bot 要拉 API、
 * 插件、账号一堆东西，测一条权限规则不值当。判定逻辑单独放这儿，改规则
 * 只改一处，测试也只跑一个文件。
 *
 * 三档，从严到宽：
 *   ownerOnly   只有主人（`LEVEL.owner`）
 *   admin       ≥ 管理员（主人也算）
 *   globalAdmin 另需「全局」作用域权限（群管理员不算）
 *
 * 为什么 ownerOnly 必须是最先判：一个命令同时声明 ownerOnly + admin 时，
 * 语义应该是「只有主人」，不能被 admin 那一档放宽成「管理员也行」。
 */

import { LEVEL, levelName } from './roles.js';

/**
 * 判断某身份能否用这条命令。
 *
 * @param {object} entry 命令表条目（读 ownerOnly / admin / globalAdmin）
 * @param {object} who
 * @param {number} who.lv        当前作用域有效等级（越小越高）
 * @param {number|null} [who.globalLv] 全局作用域等级；只有 globalAdmin 命令才会被查
 * @param {string} [who.prefix]  命令前缀，用于提示文案
 * @returns {string} 拒绝理由；空串表示放行
 */
export function commandDenyReason(entry, { lv, globalLv = null, prefix = '/' } = {}) {
  if (entry?.ownerOnly && lv > LEVEL.owner) return '这个命令只有机器人主人能用。';
  if (entry?.admin && lv > LEVEL.admin) {
    return (
      `需要管理员权限才能用这个命令（你当前是${levelName(lv)}）。\n` +
      `发 ${prefix}admin me 查看自己的权限。`
    );
  }
  if (entry?.globalAdmin && globalLv !== null && globalLv > LEVEL.admin) {
    return '这个命令影响全局，需要「全局管理员」权限。';
  }
  return '';
}

/** 这条命令是否需要查权限（不用查就别白跑一次 roles.effective） */
export function needsPermissionCheck(entry) {
  return Boolean(entry?.ownerOnly || entry?.admin || entry?.globalAdmin);
}
