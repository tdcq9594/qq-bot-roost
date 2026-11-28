/**
 * 面板访问密钥强度（2026-11-28）。
 *
 * 为什么需要它：`accessKey` 等价于「能装插件 = 子进程执行任意代码」，而现状
 * 只查「非空」+ 20 次/分钟限流。弱 key（如 `123456`）一天可被穷举完（20/分钟
 * ≈ 2.8 万次/天），限流只是拖慢，不是挡住。
 *
 * 设计依据（已查证，见归档设计稿）：
 *   - NIST SP 800-63B Q-B10：建议增加长度，**明确反对**大小写/数字/符号组合规则；
 *     Q-B19：黑名单比对**完整值**，不查子串。
 *   - Gitea：`MIN_PASSWORD_LENGTH` 默认 8、`PASSWORD_COMPLEXITY` 默认 off。
 *     但 Gitea 的 8 是给人记的密码；我们这是复制粘贴的机器令牌且泄露即 RCE，
 *     门槛提到 16——即便全是小写字母也有 ~76 bit 熵。
 *
 * 纯函数、零依赖，测试不需要起服务。
 */

/** 机器令牌长度门槛：比人密码的 8 更高，因为用户是复制粘贴而非手输 */
export const MIN_KEY_LENGTH = 16;

/**
 * 常见弱密钥黑名单（NIST Q-B08：放「很可能被用到的值」，不必穷举字典）。
 * 比对完整值、大小写不敏感（Q-B19：不查子串，所以 `password12345` 不算弱）。
 * 这些值一旦被拿去当面板 key，等价于把 RCE 权限写在门口。
 */
export const WEAK_KEYS = new Set([
  // 纯数字 / 连续键盘
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678901',
  '123123123', '111111', '000000', '666666', '888888', '654321',
  'qwerty', 'qwertyuiop', 'asdfgh', '1q2w3e4r', 'zxcvbnm',
  // 常见口令
  'password', 'password1', 'password123', 'admin', 'admin123', 'administrator',
  'root', 'toor', 'test', 'test123', 'guest', 'welcome', 'iloveyou', 'letmein',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  // 与其它项目默认值撞车（迁移/复制粘贴最常见的来源）
  'secret', 'secretkey', 'accesskey', 'changeme', 'default', 'roost', 'bot',
]);

/**
 * 校验面板密钥强度。
 * @returns {{ok: boolean, reason?: 'length'|'weak', message?: string}}
 */
export function checkKeyStrength(key) {
  const s = String(key ?? '');
  /**
   * 先查黑名单再查长度：常见弱口令（123456 / password）都短于 16，
   * 若先判长度就永远走不到黑名单——黑名单一行形同虚设，而且「太常见」
   * 比「太短」对用户更有指导性（知道该换个思路，而不是再加几个字符）。
   */
  if (WEAK_KEYS.has(s.toLowerCase().trim())) {
    return { ok: false, reason: 'weak', message: '这个密钥太常见，请换一个随机字符串' };
  }
  if (s.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      reason: 'length',
      message: `访问密钥至少需要 ${MIN_KEY_LENGTH} 个字符（当前 ${s.length} 个）`,
    };
  }
  return { ok: true };
}

/**
 * 登录密码强度（**给人用**，区别于给机器用的 accessKey）。
 *
 * NIST SP 800-63B 的 8 字符是「人记的密码」底线，Gitea 默认也是 8：人要在
 * 登录页输这个，16 位对人不合理。但同样反对字符组合规则、同样要黑名单。
 * accessKey 仍是 16+——它给机器用（复制粘贴），且泄露即 RCE。
 */
export const MIN_LOGIN_PASSWORD_LENGTH = 8;

export function checkLoginPasswordStrength(password) {
  const s = String(password ?? '');
  if (WEAK_KEYS.has(s.toLowerCase().trim())) {
    return { ok: false, reason: 'weak', message: '这个登录密码太常见，请换一个' };
  }
  if (s.length < MIN_LOGIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'length',
      message: `登录密码至少需要 ${MIN_LOGIN_PASSWORD_LENGTH} 个字符（当前 ${s.length} 个）`,
    };
  }
  return { ok: true };
}

/**
 * 给启动日志用的简短提示（不阻断本机 loopback 用户）。
 * 弱 key 仍可用，只是提醒去换——升级不锁死老用户。
 */
export function warnWeakKey(key) {
  const r = checkKeyStrength(key);
  return r.ok ? '' : `${r.message}；建议到面板「设置」页更换（登录与 ?key= 仍可正常使用）`;
}
