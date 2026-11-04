/**
 * QQ 号自助绑定的邮箱验证码。
 *
 * 刻意只放**进程内存**：验证码活 5 分钟，框架是单进程，重启失效让用户重发一次
 * 比落盘便宜得多，也彻底避开 `data/identity.json` 的跨进程 claims 合并语义、
 * `ctx.storage` 的非原子写、以及「验证码明文落盘」这三件事。
 * 代价是重启后待验证记录全部作废 —— 这是可接受且更安全的行为。
 *
 * 安全边界：**验证码绑定的是发起者 openid**。
 * 拿到别人邮箱里的验证码也绑不上，因为 consume() 只按当前 openid 找记录。
 */

import { randomInt, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isValidUin } from '../identity.js';

export const VERIFY_TTL_MS = 5 * 60 * 1000;
export const VERIFY_MAX_ATTEMPTS = 5;
export const VERIFY_RESEND_GAP_MS = 60 * 1000;
export const VERIFY_PER_UIN_PER_DAY = 3;

export class VerifyError extends Error {
  constructor(message, code = 'VERIFY_FAILED') {
    super(message);
    this.name = 'VerifyError';
    this.code = code;
  }
}

function hashCode(salt, openid, code) {
  return createHash('sha256').update(`${salt}:${openid}:${code}`).digest();
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class VerifyStore {
  /** @param {{now?:()=>number, ttlMs?:number}} opts 测试可注入假时钟 */
  constructor({ now = () => Date.now(), ttlMs = VERIFY_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** openid -> { uin, hash(hex), expiresAt, attempts, createdAt } */
    this.pending = new Map();
    /** openid -> 上次发信时间 */
    this.lastSent = new Map();
    /** `${day}:${uin}` -> 次数 */
    this.uinDaily = new Map();
  }

  #sweep() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= t) this.pending.delete(k);
    const day = dayKey(new Date(t));
    for (const k of this.uinDaily.keys()) if (!k.startsWith(`${day}:`)) this.uinDaily.delete(k);
  }

  /**
   * 生成并发放一个验证码。
   * @returns {{code:string, uin:string, to:string, expiresAt:number}}
   *   code 只在这里出现一次，调用方立刻拿去发邮件，不落盘、不进日志。
   */
  issue({ openid = '', uin = '' } = {}) {
    const oid = String(openid).trim();
    const n = String(uin).trim();
    if (!oid) throw new VerifyError('拿不到你的身份标识，请重新发一条消息再试', 'NO_OPENID');
    if (!isValidUin(n)) throw new VerifyError('QQ 号不合法（要 5–12 位数字，首位不能是 0）', 'BAD_UIN');
    this.#sweep();

    const t = this.now();
    const since = t - (this.lastSent.get(oid) ?? 0);
    if (since < VERIFY_RESEND_GAP_MS) {
      throw new VerifyError(`发得太勤了，${Math.ceil((VERIFY_RESEND_GAP_MS - since) / 1000)} 秒后才能再发一次`, 'TOO_SOON');
    }
    const day = dayKey(new Date(t));
    const dayK = `${day}:${n}`;
    if ((this.uinDaily.get(dayK) ?? 0) >= VERIFY_PER_UIN_PER_DAY) {
      throw new VerifyError('这个 QQ 号今天要验证码的次数用完了，明天再试，或找主人代绑', 'UIN_DAY_LIMIT');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const record = {
      uin: n,
      hash: hashCode(salt, oid, code).toString('hex'),
      // 校验时重新拼哈希需要 salt，salt 不是秘密，可以一起放内存
      salt,
      expiresAt: t + this.ttlMs,
      attempts: 0,
      createdAt: t,
    };
    this.pending.set(oid, record);
    this.lastSent.set(oid, t);
    this.uinDaily.set(dayK, (this.uinDaily.get(dayK) ?? 0) + 1);
    return { code, uin: n, to: `${n}@qq.com`, expiresAt: record.expiresAt };
  }

  /** 有没有待验证记录（给命令提示用） */
  has(openid) {
    this.#sweep();
    return this.pending.has(String(openid ?? '').trim());
  }

  /** 撤销待验证记录（邮件发送失败时用）。发信冷却仍保留，防反复触发 */
  cancel(openid) {
    this.pending.delete(String(openid ?? '').trim());
  }

  /**
   * 核对验证码。失败会累计次数，超过上限直接作废记录（要重新发）。
   * @returns {{ok:true, uin:string, to:string}}
   */
  consume({ openid = '', code = '' } = {}) {
    const oid = String(openid).trim();
    const c = String(code).trim();
    const rec = this.pending.get(oid);
    if (!rec) throw new VerifyError('没有待验证的记录，或验证码已过期。先发「绑定QQ 你的QQ号」', 'NO_PENDING');
    if (rec.expiresAt <= this.now()) {
      this.pending.delete(oid);
      throw new VerifyError('验证码已过期，请重新发送「绑定QQ 你的QQ号」', 'EXPIRED');
    }
    if (!/^\d{6}$/.test(c)) throw new VerifyError('验证码是 6 位数字，用法：QQ验证码 123456', 'BAD_FORMAT');

    rec.attempts += 1;
    const given = hashCode(rec.salt, oid, c).toString('hex');
    if (!safeEqualHex(given, rec.hash)) {
      if (rec.attempts >= VERIFY_MAX_ATTEMPTS) this.pending.delete(oid);
      const left = VERIFY_MAX_ATTEMPTS - rec.attempts;
      throw new VerifyError(
        left > 0 ? `验证码不对，还能试 ${left} 次` : '错太多次了，验证码已作废，请重新发送「绑定QQ 你的QQ号」',
        'MISMATCH',
      );
    }
    this.pending.delete(oid);
    return { ok: true, uin: rec.uin, to: `${rec.uin}@qq.com` };
  }
}

/** 验证码邮件模板。主题/正文都保持朴素，别被 QQ 邮箱反垃圾规则拦下 */
export function verifyMail({ uin, code, minutes = 5 } = {}) {
  return {
    subject: '【栖】QQ 号绑定验证码',
    text: [
      `你正在把 QQ 号 ${uin} 绑定到这个机器人。`,
      '',
      `验证码：${code}`,
      '',
      `${minutes} 分钟内有效，最多可试 ${VERIFY_MAX_ATTEMPTS} 次。`,
      '如果这不是你本人操作，直接忽略这封邮件就好，不要把验证码告诉任何人。',
    ].join('\r\n'),
  };
}
