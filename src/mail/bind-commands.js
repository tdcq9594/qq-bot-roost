/**
 * 普通成员自助绑定 QQ 号的两条命令（纯逻辑，「消息 → 结果文本」）。
 *
 * 和 `identity-commands.js` 一样的规矩：永远返回 { ok, text }，不抛异常。
 * 命令本身注册在 `main.js` 的 `core()` 里 —— 插件拿不到身份表的写权限
 * （`ctx.identity` 是只读视图），只有内核的 `sharedIdentity()` 能 bind。
 *
 * ## 命令名坑
 * `message.js:417` 会把命令名 `.toLowerCase()`，所以注册时必须用
 * `绑定qq` / `qq验证码`（写成大写 Q 永远匹配不上）。
 */

import { isValidUin } from '../identity.js';
import { verifyMail } from './verify.js';

/** 只认 QQ 号；顺手剥掉用户可能多打的 @qq.com 后缀 */
export function parseUinArg(args = []) {
  for (const v of Array.isArray(args) ? args : []) {
    const s = String(v ?? '').trim().replace(/@qq\.com$/i, '');
    if (isValidUin(s)) return s;
  }
  return '';
}

export function parseCodeArg(args = []) {
  for (const v of Array.isArray(args) ? args : []) {
    const s = String(v ?? '').trim();
    if (/^\d{6}$/.test(s)) return s;
  }
  return '';
}

const NO_MAIL = '机器人还没配好邮箱，暂时没法自助绑定。请找主人用「绑定成员 @你 QQ号」代绑。';

/**
 * 冲突检查：按需求「直接拒绝」，不做 force、不做改绑、不覆盖任何已有记录。
 * 发验证码前和核对通过后各查一次（中间这 5 分钟里可能被人抢先绑了）。
 */
function conflictOf(identity, botId, openid, uin) {
  // 这个人在这只鸟下已经绑过号了
  const mine = identity.resolveUser?.(botId, openid);
  if (mine?.uin && String(mine.uin) !== uin) {
    return `你已经绑过 QQ 号 ${mine.uin} 了，自助绑定不能改绑。要换号请找主人在面板处理。`;
  }
  // 这个号已经属于别人
  const owner = String(identity.openidOf?.(botId, uin) ?? '').trim();
  if (owner && owner !== openid) {
    return `QQ 号 ${uin} 已经绑给别人了，直接拒绝。确认是这个号请找主人在面板处理。`;
  }
  // 有记录但本 bot 下查不到 openid（停用 / 被解绑 / 挂在别的机器人下）：一样拒绝
  if (!owner && identity.has?.('user', uin)) {
    return `QQ 号 ${uin} 已有绑定记录，自助绑定不覆盖已有记录。请找主人确认。`;
  }
  return '';
}

/**
 * `绑定QQ <QQ号>` → 发验证码到 `<QQ号>@qq.com`。
 */
export async function runBindQq({ msg, mail, verify, identity, botId = '', log = () => {} } = {}) {
  const openid = String(msg?.userId ?? '').trim();
  if (!openid) return { ok: false, text: '拿不到你的身份标识，稍后再发一条消息试试。' };

  const uin = parseUinArg(msg?.args);
  if (!uin) {
    return { ok: false, text: '用法：绑定QQ 你的QQ号（5–12 位数字）。验证码会发到「QQ号@qq.com」。' };
  }
  if (!mail || !mail.checkConfig().ok) return { ok: false, text: NO_MAIL };

  try {
    await identity.load?.();
    const conflict = conflictOf(identity, botId, openid, uin);
    if (conflict) return { ok: false, text: conflict };

    const issued = verify.issue({ openid, uin });
    try {
      await mail.send({ to: issued.to, ...verifyMail({ uin, code: issued.code }) });
    } catch (e) {
      // 发失败就撤销记录，别让用户白等 60 秒冷却
      verify.cancel?.(openid);
      return { ok: false, text: `验证码没发出去：${e.message}。稍后重试，或找主人代绑。` };
    }
    log(`自助绑定：${openid} 申请绑定 QQ ${uin}，验证码已发往 ${issued.to}`);
    return {
      ok: true,
      text: `验证码已发到 ${issued.to}，5 分钟内有效。请回复「QQ验证码 6位数字」完成绑定。`,
    };
  } catch (e) {
    return { ok: false, text: e?.message || '申请失败，请稍后再试。' };
  }
}

/**
 * `QQ验证码 <6位数字>` → 核对后写入 identity.json。
 * 验证码记录绑定的是发起者 openid，拿别人邮件里的码也绑不上。
 */
export async function runVerifyQq({ msg, verify, identity, botId = '', log = () => {} } = {}) {
  const openid = String(msg?.userId ?? '').trim();
  if (!openid) return { ok: false, text: '拿不到你的身份标识，稍后再发一条消息试试。' };

  const code = parseCodeArg(msg?.args);
  if (!code) return { ok: false, text: '用法：QQ验证码 123456（6 位数字）' };

  try {
    const r = verify.consume({ openid, code });
    await identity.load?.();
    const conflict = conflictOf(identity, botId, openid, r.uin);
    if (conflict) return { ok: false, text: conflict };

    await identity.bind({ kind: 'user', uin: r.uin, openid, botId, verifiedBy: 'email' });
    log(`自助绑定成功：${openid} ↔ QQ ${r.uin}（邮箱验证码）`);
    return { ok: true, text: `绑定成功：QQ 号 ${r.uin} 已绑到你的账号。` };
  } catch (e) {
    if (e?.code === 'CONFLICT') return { ok: false, text: `这个 QQ 号有冲突：${e.message}。请找主人在面板处理。` };
    return { ok: false, text: e?.message || '绑定失败，请稍后再试。' };
  }
}
