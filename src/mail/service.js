/**
 * MailService —— 邮件能力的唯一入口。
 *
 * 职责：读全局配置（热生效）、收件地址白名单、发信限频、串行发送、测试发送。
 * 不做的事（按需求明确砍掉）：故障告警、失败重试队列、告警去重、
 * 给主人发邮件/QQ 私聊、审计落盘。发信失败只写一行普通日志 + 把错误交给调用方展示。
 *
 * 三个调用方都走这里：面板「通知」页、内核自助绑定命令、`POST /api/mail/send`。
 */

import { sendSmtpMail, resolveSecurity, formatSmtpError, extractAddress, parseRecipients } from './smtp.js';
import { isValidUin } from '../identity.js';
import { SMTP_DEFAULTS } from './defaults.js';

export { SMTP_DEFAULTS };

/**
 * 字段与 BetterGI `NotificationConfig` 的邮件部分一一对齐
 * （SmtpServer / SmtpPort / SmtpUsername / SmtpPassword / FromEmail / FromName / ToEmail），
 * 只是把 ToEmail 改叫 ownerEmail：它现在只作「测试邮件收件人」。
 */

export class MailError extends Error {
  constructor(message, { code = 'EMAIL_FAILED' } = {}) {
    super(message);
    this.name = 'MailError';
    this.code = code;
  }
}

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export class MailService {
  /**
   * @param {{globalCfg?:object, log?:object, identity?:object}} deps
   *   globalCfg 传引用，configWatch 热重载后这里立刻能读到新配置，不用重启。
   *   identity 是 IdentityStore（可空），用于 openid → QQ 号。
   */
  constructor({ globalCfg = {}, log = null, identity = null } = {}) {
    this.globalCfg = globalCfg;
    this.log = log;
    this.identity = identity;
    /** 一次只跑一封：SMTP 连接串行，也顺带把「验证码风暴」挡在队列里 */
    this.chain = Promise.resolve();
    this.minuteStamps = [];
    this.dayCount = { key: dayKey(), n: 0 };
    this.lastResult = null;
  }

  /** 每次现读，绝不在构造时把配置快照下来 */
  cfg() {
    const raw = this.globalCfg?.notifications?.smtp ?? {};
    return { ...SMTP_DEFAULTS, ...raw };
  }

  /** 面板 GET 用：密码不回显，只回一个「已设置」标志 */
  publicConfig() {
    const c = this.cfg();
    return {
      ...c,
      pass: '',
      passSet: Boolean(c.pass),
      resolvedSecurity: resolveSecurity(c.host, c.port, c.security),
      lastResult: this.lastResult,
    };
  }

  /** 配置是否够发信。SMTP 用户名/密码允许为空（免认证内网中继） */
  checkConfig() {
    const c = this.cfg();
    const missing = [];
    if (!c.enabled) missing.push('「启用邮箱通知」开关');
    if (!String(c.host).trim()) missing.push('SMTP 服务器');
    const port = Number(c.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) missing.push('SMTP 端口');
    if (!extractAddress(c.from)) missing.push('发件人邮箱');
    return { ok: missing.length === 0, missing };
  }

  /**
   * 把调用方给的目标解析成收件地址。
   *
   * 三种写法，优先级从高到低：
   *   1. `openid`  → 查绑定表反查 QQ 号 → `<QQ号>@qq.com`
   *   2. `target` / `uin` / `to` 是**完整邮箱地址** → 原样使用（任意服务商：163 / Outlook /
   *      Gmail / 企业邮箱 / 自建都行），不再限制成 QQ 邮箱或主人邮箱
   *   3. 纯数字的 QQ 号 → 自动补 `@qq.com`（保留自助绑定的简写）
   *
   * 仍然守着的边界：地址格式必须合法、发信走全局限频与串行队列、SMTP 凭据不下发给插件。
   */
  resolveRecipient({ target = '', uin = '', openid = '', to = '' } = {}) {
    if (openid) {
      const n = String(this.identity?.uinOf?.(openid) ?? '').trim();
      if (!n) throw new MailError('这个用户还没绑定 QQ 号，暂时发不了邮件通知', { code: 'UNBOUND' });
      return `${n}@qq.com`;
    }
    const raw = String(target || uin || to || '').trim();
    if (!raw) throw new MailError('收件人不能为空（填完整邮箱地址，或 QQ 号）', { code: 'BAD_TO' });
    const addr = extractAddress(raw);
    if (addr) return addr;
    if (isValidUin(raw)) return `${raw}@qq.com`;
    throw new MailError('收件人要填完整邮箱地址，或 5–12 位的 QQ 号', { code: 'BAD_TO' });
  }

  #takeQuota() {
    const c = this.cfg();
    const now = Date.now();
    this.minuteStamps = this.minuteStamps.filter((t) => now - t < 60_000);
    const perMin = Math.max(1, Number(c.maxPerMinute) || SMTP_DEFAULTS.maxPerMinute);
    const perDay = Math.max(1, Number(c.dailyLimit) || SMTP_DEFAULTS.dailyLimit);
    if (this.minuteStamps.length >= perMin) {
      throw new MailError(`发信太频繁（每分钟最多 ${perMin} 封），稍后再试`, { code: 'RATE_LIMIT' });
    }
    const key = dayKey();
    if (this.dayCount.key !== key) this.dayCount = { key, n: 0 };
    if (this.dayCount.n >= perDay) {
      throw new MailError(`今天已发满 ${perDay} 封，明天再试（防邮箱被判垃圾邮件）`, { code: 'DAILY_LIMIT' });
    }
    this.minuteStamps.push(now);
    this.dayCount.n += 1;
  }

  /** 前一次失败不能堵住队列；任务本身的结果照常返回给调用方 */
  #enqueue(fn) {
    const task = this.chain.then(fn, fn);
    this.chain = task.catch(() => {});
    return task;
  }

  /**
   * 底层发送。`target` 由 resolveRecipient 得到，或内部直接给完整地址。
   * @returns {Promise<{ok:true,to:string,messageId:string,security:string,auth:string}>}
   */
  async send({ to, subject, text, html = false } = {}) {
    const check = this.checkConfig();
    if (!check.ok) throw new MailError(`邮箱还没配好，缺：${check.missing.join('、')}`, { code: 'NOT_CONFIGURED' });
    const list = parseRecipients(to);
    if (!list.length) throw new MailError('收件人邮箱不合法', { code: 'BAD_TO' });
    this.#takeQuota();

    const c = this.cfg();
    return this.#enqueue(async () => {
      try {
        const out = await sendSmtpMail({
          host: c.host,
          port: c.port,
          security: c.security,
          user: c.user,
          pass: c.pass,
          from: c.from,
          fromName: c.fromName,
          to: list,
          subject: String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200),
          text: String(text ?? ''),
          html,
          timeoutMs: c.timeoutMs,
          rejectUnauthorized: c.rejectUnauthorized,
        });
        this.lastResult = { ok: true, at: Date.now(), to: list.join(','), security: out.security };
        this.log?.info?.(`邮件已发送 → ${list.join(',')}（${c.host}:${c.port} / ${out.security}）`);
        return { ok: true, to: list.join(','), ...out };
      } catch (err) {
        const f = formatSmtpError(err, c.host, c.port);
        this.lastResult = { ok: false, at: Date.now(), to: list.join(','), code: f.code };
        // 普通日志，不是「故障通知」：不额外发邮件、不推 QQ、不落盘队列
        this.log?.error?.(`邮件发送失败 → ${c.host}:${c.port} [${f.code}] ${f.message}`);
        throw new MailError(f.message, { code: f.code });
      }
    });
  }

  /**
   * 发通知的主入口：`target` 可以是完整邮箱地址（任意服务商），也可以是 QQ 号简写。
   * 框架接口 `ctx.mail.send()` 和 HTTP `/api/mail/send` 最终都走这里。
   */
  sendTo(target, subject, text, opts = {}) {
    return this.send({ to: this.resolveRecipient({ target }), subject, text, ...opts });
  }

  /** QQ 号简写的便捷别名，等价 `sendTo(QQ号, ...)` */
  sendToUin(uin, subject, text, opts = {}) {
    return this.sendTo(uin, subject, text, opts);
  }

  /** 给已绑定的 openid 反查 QQ 号再发 */
  sendToOpenid(openid, subject, text, opts = {}) {
    return this.send({ to: this.resolveRecipient({ openid }), subject, text, ...opts });
  }

  /** 面板「测试邮件通知」按钮：发到主人邮箱 */
  async test() {
    const c = this.cfg();
    const owner = extractAddress(c.ownerEmail);
    if (!owner) throw new MailError('先填「主人邮箱」，测试邮件会发到这个地址', { code: 'NO_OWNER' });
    const when = new Date().toLocaleString('zh-CN', { hour12: false });
    const security = resolveSecurity(c.host, c.port, c.security);
    return this.send({
      to: owner,
      subject: '【栖】邮箱通知测试',
      text: [
        '这是一封来自 QQ 机器人框架的测试邮件。',
        '',
        `发送时间：${when}`,
        `SMTP 服务器：${c.host}:${c.port}`,
        `加密方式：${security}（auto 会自动判定）`,
        '',
        '能收到这封邮件，说明 SMTP 配置正确。',
      ].join('\r\n'),
    });
  }
}

/* ------------------------------------------------------------------ */
/* 框架接口：插件用的 ctx.mail                                         */
/* ------------------------------------------------------------------ */

/**
 * 进程级单例（照 `sharedIdentity()` 的写法）。
 *
 * 邮件通道是全进程唯一的一份：`config/bot.json` 里只有一组 SMTP 配置，
 * 所有机器人、所有插件共用。用单例就不必把 MailService 沿着
 * main → BotRuntime → PluginLoader → createContext 一路透传。
 */
let shared = null;
export function setSharedMail(svc) {
  shared = svc;
  return shared;
}
export function sharedMail() {
  return shared;
}

/**
 * 生成挂到 `ctx.mail` 上的框架接口。插件只要给 **收件人 + 内容**：
 *
 *   await ctx.mail.send('123456', '你的任务完成了');            // QQ 号 → 123456@qq.com
 *   await ctx.mail.send('someone@163.com', '日报已生成');        // 任意邮箱直接发
 *   await ctx.mail.send('someone@outlook.com', '<b>完成</b>', { subject: '提醒', html: true });
 *
 * 完整邮箱地址（任意服务商）原样使用，纯数字 QQ 号自动补 `@qq.com`。
 * 地址格式校验、限频、串行发送、SMTP 凭据保护全在 MailService 里。
 *
 * @param {(()=>MailService)|MailService} getService 延迟取服务，配置热更新后仍是同一个对象
 */
export function createMailApi(getService = sharedMail) {
  const service = () => {
    const svc = typeof getService === 'function' ? getService() : getService;
    if (!svc) throw new MailError('邮件服务还没初始化（框架版本太旧或尚未启动完成）', { code: 'NO_MAIL' });
    return svc;
  };
  return Object.freeze({
    /** SMTP 是否配好了。没配好时 send() 会抛中文错误，插件可先判一下 */
    get configured() {
      try { return service().checkConfig().ok; } catch { return false; }
    },
    /**
     * @param {string|number} target 完整邮箱地址，或 QQ 号（自动补 @qq.com）
     * @param {string} content 邮件正文
     * @param {{subject?:string, html?:boolean}} [opts] 主题默认「【栖】消息通知」
     * @returns {Promise<{ok:true,to:string,messageId:string}>}
     */
    async send(target, content, opts = {}) {
      const text = String(content ?? '').trim();
      if (!text) throw new MailError('邮件内容不能为空', { code: 'EMPTY_CONTENT' });
      const o = opts && typeof opts === 'object' ? opts : {};
      return service().sendTo(
        String(target ?? '').trim(),
        String(o.subject ?? '').trim() || '【栖】消息通知',
        text,
        { html: o.html === true },
      );
    },
  });
}
