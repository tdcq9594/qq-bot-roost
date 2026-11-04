/**
 * 零依赖 SMTP 客户端 —— 只用 node:net / node:tls / node:crypto。
 *
 * ## 来源与为什么这样写
 *
 * 1. 协议状态机（应答解析、STARTTLS 升级、MIME、dot-stuffing、超时）参考
 *    本工作区 `douluo/snowluma/index.mjs` 的 `src/notifications/smtp.ts` 实现，
 *    以及 `ersinkoc/mailer`（MIT，github.com/ersinkoc/mailer）的能力清单。
 * 2. **「怎么适配任意邮箱服务商」的配置与加密决策，参考 BetterGI**
 *    （babalae/better-genshin-impact，GPL-3.0）：
 *      - `Service/Notifier/EmailNotifier.cs` → `GetSecureSocketOptions()` /
 *        `IsKnownServerWithSpecialRequirements()`：465 = 隐式 TLS、587 = STARTTLS、
 *        25 = 明文、其它端口自动协商；**网易系 163/126/yeah 的 587 实际是隐式 TLS**，
 *        必须特判（用户截图里 smtp.163.com:587 能发信就是靠这条）。
 *      - `Service/Notification/NotificationConfig.cs` → 字段集合。
 *      - `Service/Notifier/EmailNotifier.cs` → 用户名为空就不做认证（内网中继）。
 *    这里只借鉴「规则与字段设计」，未复制其 C# / MailKit 代码；框架仍保持零依赖。
 * 3. 协议规范：RFC 5321（SMTP）、3207（STARTTLS）、4954（AUTH）、2047（头部编码）。
 *
 * ## 边界
 * 本模块只做协议收发：不读配置、不落盘、不做限频、不认识 QQ 号。
 * 配置、目标白名单、限频在 `service.js`；面板与命令在各自模块。
 */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 15_000;
/** 服务端单次应答的缓冲区上限，防恶意/异常服务器无限灌数据 */
const MAX_REPLY_BYTES = 512 * 1024;

/* ------------------------------------------------------------------ */
/* 错误                                                                */
/* ------------------------------------------------------------------ */

export class SmtpError extends Error {
  constructor(message, { code = 'ESMTP', responseCode = 0, stage = '', cause = null } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.responseCode = Number(responseCode) || 0;
    this.stage = stage;
    if (cause) this.cause = cause;
  }
}

/** 把底层异常翻成「用户能看懂、能照着改」的中文 */
export function formatSmtpError(err, host = '', port = 0) {
  const where = `${host || 'SMTP'}${port ? `:${port}` : ''}`;
  const errno = String(err?.cause?.code || err?.code || '');
  const rc = Number(err?.responseCode) || 0;
  const msg = String(err?.message || err || '');

  let code = 'ESMTP';
  let message = `邮件发送失败：${msg}`;

  if (rc === 535 || rc === 534 || rc === 530 || err?.stage === 'AUTH') {
    code = 'EAUTH';
    message = `SMTP 认证失败（${rc || '认证被拒'}）：检查用户名是否是完整邮箱地址、密码是否用授权码而不是登录密码，以及邮箱是否开启了 SMTP 服务。`;
  } else if (/self-signed|unable to verify|certificate|CERT_/i.test(msg) || /^ECERT/.test(errno)) {
    code = 'ECERT';
    message = `SMTP 证书校验失败：${where}。自签名证书的内网服务器可把 smtp.rejectUnauthorized 设为 false。`;
  } else if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(errno)) {
    code = errno;
    message = `连不上 SMTP 服务器 ${where}（${errno}）：检查服务器地址、端口和防火墙；端口 25 常被运营商封禁，改用 465 或 587。`;
  } else if (rc === 550 || rc === 551 || rc === 552 || rc === 553 || err?.stage === 'RCPT') {
    code = 'ERCPT';
    message = `收件人被服务器拒绝（${rc}）：检查收件邮箱是否存在、是否被判为垃圾邮件。`;
  } else if (err?.stage === 'STARTTLS') {
    code = 'ESTARTTLS';
    message = `STARTTLS 协商失败：${msg}`;
  } else if (rc === 421 || rc === 451 || rc === 452) {
    code = 'ETEMPFAIL';
    message = `服务器临时拒收（${rc}）：${msg || '稍后再试'}`;
  } else if (err?.stage === 'GREETING' || err?.stage === 'EHLO') {
    code = 'EGREETING';
    message = `SMTP 握手失败：${msg}。若这个端口实际要求 SSL，可把 smtp.security 设为 'tls' 再试。`;
  }
  return { code, message };
}

/* ------------------------------------------------------------------ */
/* 地址与 MIME                                                         */
/* ------------------------------------------------------------------ */

/** 宽松校验：user@localhost 这类内网地址也算合法 */
export function extractAddress(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = /<([^<>]+)>/.exec(s);
  const addr = (m ? m[1] : s).trim();
  return /^[^\s<>@]+@[^\s<>@]+$/.test(addr) ? addr : null;
}

/** string / array 都收，支持逗号、分号、换行分隔，去重 */
export function parseRecipients(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]+/);
  const seen = new Set();
  const out = [];
  for (const part of list) {
    const addr = extractAddress(part);
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** 头部一律去掉换行，防 CRLF 注入 */
function cleanHeader(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * RFC 2047 encoded-word。中文主题必须编码，且按 base64 的 4 字节边界切块，
 * 保证每一行都不超过 76 列、又不会把多字节字符劈成两半。
 */
function encodeWord(value) {
  const prefix = '=?UTF-8?B?';
  const suffix = '?=';
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const chunk = Math.max(4, Math.floor((75 - prefix.length - suffix.length) / 4) * 4);
  const words = [];
  for (let i = 0; i < b64.length; i += chunk) {
    words.push(`${prefix}${b64.slice(i, i + chunk)}${suffix}`);
  }
  return words.join(`${CRLF} `) || prefix + suffix;
}

function encodeHeader(value) {
  const v = cleanHeader(value);
  return /^[\x20-\x7E]*$/.test(v) ? v : encodeWord(v);
}

function formatAddress(addr, name = '') {
  const a = extractAddress(addr);
  if (!a) throw new SmtpError(`邮箱地址不合法：${addr}`, { code: 'EADDRESS' });
  const n = cleanHeader(name);
  return n ? `${encodeHeader(n)} <${a}>` : `<${a}>`;
}

function rfc5322Date(d) {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

function wrap76(b64) {
  return b64.replace(/.{1,76}/g, (line) => `${line}${CRLF}`).trimEnd();
}

/** DATA 阶段以点开头的行必须多点一个点 */
function dotStuff(payload) {
  return payload.replace(/^\./gm, '..');
}

/**
 * 生成单部分 MIME 文本。正文统一 base64（最兼容，不依赖 8BITMIME）。
 * @param {{from:string, fromName?:string, to:string[], cc?:string[],
 *          subject?:string, text?:string, html?:boolean, replyTo?:string}} mail
 */
export function buildMimeMessage(mail, now = new Date()) {
  const to = parseRecipients(mail.to);
  const cc = parseRecipients(mail.cc);
  const fromAddr = extractAddress(mail.from);
  if (!fromAddr) throw new SmtpError('发件人邮箱不合法', { code: 'EADDRESS' });
  if (!to.length && !cc.length) throw new SmtpError('没有收件人', { code: 'EADDRESS' });

  const domain = fromAddr.split('@')[1] || 'localhost';
  const isHtml = mail.html === true;
  const headers = [
    `From: ${formatAddress(fromAddr, mail.fromName)}`,
    `To: ${to.map((a) => `<${a}>`).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map((a) => `<${a}>`).join(', ')}`] : []),
    `Subject: ${encodeHeader(mail.subject ?? '')}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${now.getTime()}.${crypto.randomBytes(8).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
  ];
  const replyTo = extractAddress(mail.replyTo);
  if (replyTo) headers.push(`Reply-To: <${replyTo}>`);

  const body = wrap76(Buffer.from(String(mail.text ?? ''), 'utf8').toString('base64'));
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
}

/* ------------------------------------------------------------------ */
/* 加密方式决策（BetterGI 规则）                                       */
/* ------------------------------------------------------------------ */

/**
 * 把用户配置 + host/port 解析成实际连接方式。
 *
 * 返回：
 *   'tls'       隐式 TLS（SslOnConnect），建连即 TLS
 *   'starttls'  明文建连 → EHLO → 服务器支持就升级（不支持则明文继续）
 *   'auto'      同 starttls，但完全按 EHLO 能力协商（其它端口）
 *   'none'      明文，不升级
 *
 * 对齐 BetterGI `EmailNotifier.GetSecureSocketOptions()`：
 *   465 → SslOnConnect / 587 → StartTls / 25 → None / 其它 → Auto，
 *   以及网易系 163/126/yeah 的 587 是隐式 TLS 这条特例。
 * 差别：这里 587 用「可用则升级」而不是「必须升级」，避免某些服务商
 * 587 只提供明文时直接失败；并额外做一次隐式 TLS 回退（见 sendSmtpMail）。
 */
export function resolveSecurity(host, port, security = 'auto') {
  const explicit = String(security || 'auto').trim().toLowerCase();
  if (['tls', 'ssl', 'ssl/tls', 'sslonconnect'].includes(explicit)) return 'tls';
  if (['starttls', 'starttlswhenavailable'].includes(explicit)) return 'starttls';
  if (['none', 'plain', 'off'].includes(explicit)) return 'none';

  const h = String(host || '').toLowerCase();
  const p = Number(port) || 587;
  // 网易邮箱 587 端口实际是 SSL-on-connect（BetterGI 的已知特例表）
  if (p === 587 && /(?:^|\.)(?:163|126)\.com$|yeah\.net$|(?:^|\.)yeah\.com$/.test(h)) return 'tls';
  if (p === 465) return 'tls';
  if (p === 587) return 'starttls';
  if (p === 25) return 'none';
  return 'auto';
}

/* ------------------------------------------------------------------ */
/* 应答解析与会话                                                      */
/* ------------------------------------------------------------------ */

/** 从缓冲区取出一条完整的多行应答（末行第 4 字符是空格） */
function consumeReply(buf) {
  let offset = 0;
  const lines = [];
  let code = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf('\n', offset);
    if (nl === -1) return null;
    const line = buf.slice(offset, nl).replace(/\r$/, '');
    offset = nl + 1;
    const m = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!m) continue;
    code = Number(m[1]);
    lines.push(m[3]);
    if (m[2] === ' ') {
      return { reply: { code, lines, text: lines.join('\n') }, rest: buf.slice(offset) };
    }
  }
  return null;
}

function parseCapabilities(reply) {
  const auth = new Set();
  let starttls = false;
  let size = 0;
  for (const line of reply?.lines ?? []) {
    const u = String(line).toUpperCase().trim();
    if (u === 'STARTTLS' || u.startsWith('STARTTLS ')) starttls = true;
    if (u.startsWith('AUTH ')) {
      for (const mech of u.slice(5).split(/\s+/)) if (mech) auth.add(mech);
    } else if (u === 'AUTH') {
      // 有些服务器把机制分行列在 AUTH 之后
      auth.add('__BARE__');
    }
    const sz = /^SIZE\s+(\d+)/.exec(u);
    if (sz) size = Number(sz[1]);
  }
  return { starttls, auth, size };
}

function connectSocket(host, port, secure, timeoutMs, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    const common = {
      host,
      port,
      servername: net.isIP(host) === 0 ? host : undefined,
    };
    const opt = secure
      ? {
          ...common,
          rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
          ...(tlsOptions.minVersion ? { minVersion: tlsOptions.minVersion } : {}),
        }
      : common;
    const sock = secure ? tls.connect(opt) : net.connect(opt);
    const fail = (err) => {
      sock.destroy();
      reject(new SmtpError(`连接 ${host}:${port} 失败：${err.message}`, {
        code: 'ECONNECT', cause: err, stage: 'CONNECT',
      }));
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => fail(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' })));
    sock.once('error', fail);
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.removeAllListeners('timeout');
      sock.removeAllListeners('error');
      resolve(sock);
    });
  });
}

function upgradeTls(socket, host, timeoutMs, tlsOptions = {}) {
  return new Promise((resolve, reject) => {
    const up = tls.connect({
      socket,
      servername: net.isIP(host) === 0 ? host : undefined,
      rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
      ...(tlsOptions.minVersion ? { minVersion: tlsOptions.minVersion } : {}),
    }, () => resolve(up));
    up.setTimeout(timeoutMs);
    up.once('timeout', () => {
      up.destroy();
      reject(new SmtpError('STARTTLS 握手超时', { code: 'ETIMEDOUT', stage: 'STARTTLS' }));
    });
    up.once('error', (err) => reject(new SmtpError(`STARTTLS 失败：${err.message}`, {
      code: 'ESTARTTLS', stage: 'STARTTLS', cause: err,
    })));
  });
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
  }

  destroy() {
    try { this.socket.destroy(); } catch { /* 已断开 */ }
  }

  setTimeout(ms, onTimeout) {
    this.socket.setTimeout(ms);
    this.socket.once('timeout', onTimeout);
  }

  async read() {
    const ready = consumeReply(this.buf);
    if (ready) {
      this.buf = ready.rest;
      return ready.reply;
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.removeListener('data', onData);
        this.socket.removeListener('error', onError);
        this.socket.removeListener('close', onClose);
      };
      const onData = (chunk) => {
        this.buf += chunk.toString('utf8');
        if (this.buf.length > MAX_REPLY_BYTES) {
          cleanup();
          reject(new SmtpError('SMTP 应答过长', { code: 'EREPLY' }));
          return;
        }
        const got = consumeReply(this.buf);
        if (!got) return;
        this.buf = got.rest;
        cleanup();
        resolve(got.reply);
      };
      const onError = (err) => {
        cleanup();
        reject(new SmtpError(`SMTP 连接错误：${err.message}`, { code: 'ESOCKET', cause: err }));
      };
      const onClose = () => {
        cleanup();
        reject(new SmtpError('SMTP 连接被关闭', { code: 'ECLOSED' }));
      };
      this.socket.on('data', onData);
      this.socket.once('error', onError);
      this.socket.once('close', onClose);
    });
  }

  write(data) {
    this.socket.write(data, 'utf8');
  }

  async command(line, ok, stage = '') {
    this.write(`${line}${CRLF}`);
    const reply = await this.read();
    if (!ok(reply.code)) {
      throw new SmtpError(`${stage || line.split(' ')[0] || 'SMTP'} 失败：${reply.code} ${reply.text}`.trim(), {
        code: 'EREPLY', responseCode: reply.code, stage,
      });
    }
    return reply;
  }

  replaceSocket(next) {
    this.socket = next;
    this.buf = '';
  }
}

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

async function plainAuth(session, user, pass) {
  const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
  await session.command(`AUTH PLAIN ${token}`, (c) => c === 235, 'AUTH');
}

async function loginAuth(session, user, pass) {
  await session.command('AUTH LOGIN', (c) => c === 334, 'AUTH');
  await session.command(Buffer.from(user, 'utf8').toString('base64'), (c) => c === 334, 'AUTH');
  await session.command(Buffer.from(pass, 'utf8').toString('base64'), (c) => c === 235, 'AUTH');
}

async function cramAuth(session, user, pass) {
  const r = await session.command('AUTH CRAM-MD5', (c) => c === 334, 'AUTH');
  const challenge = Buffer.from(r.lines.join(''), 'base64').toString('utf8');
  const digest = crypto.createHmac('md5', pass).update(challenge).digest('hex');
  const answer = Buffer.from(`${user} ${digest}`, 'utf8').toString('base64');
  await session.command(answer, (c) => c === 235, 'AUTH');
}

async function xoauth2Auth(session, user, token) {
  const payload = `user=${user}\x01auth=Bearer ${token}\x01\x01`;
  try {
    await session.command(`AUTH XOAUTH2 ${Buffer.from(payload, 'utf8').toString('base64')}`,
      (c) => c === 235, 'AUTH');
  } catch (e) {
    // OAuth2 失败时服务器会先回 334 带错误说明，必须吃掉再发空行结束挑战
    await session.command('', () => true, 'AUTH').catch(() => {});
    throw e;
  }
}

/**
 * 按服务器 EHLO 宣告的机制挑一个能用的。
 * 用户名为空 => 完全跳过认证（内网中继 / 免认证 SMTP），对齐 BetterGI。
 */
async function authenticate(session, caps, { user, pass, accessToken = '' }) {
  const u = String(user ?? '').trim();
  const p = String(pass ?? '');
  if (!u && !accessToken) return 'none';

  if (accessToken) {
    await xoauth2Auth(session, u, accessToken);
    return 'XOAUTH2';
  }

  const mechs = caps.auth ?? new Set();
  const attempts = [];
  if (mechs.has('PLAIN')) attempts.push(['PLAIN', plainAuth]);
  if (mechs.has('LOGIN')) attempts.push(['LOGIN', loginAuth]);
  if (mechs.has('CRAM-MD5')) attempts.push(['CRAM-MD5', cramAuth]);
  // 服务器没宣告任何机制（或 EHLO 降级成 HELO）时盲试，老企业邮箱常见
  if (!attempts.length) attempts.push(['PLAIN', plainAuth], ['LOGIN', loginAuth]);

  let last = null;
  for (const [name, fn] of attempts) {
    try {
      await fn(session, u, p);
      return name;
    } catch (e) {
      last = e;
      if (e.responseCode === 535 || e.responseCode === 534) throw e; // 凭据错，别再试别的机制
    }
  }
  throw new SmtpError(`没有可用的 SMTP 认证方式：${last?.message || '服务器拒绝了认证'}`, {
    code: 'EAUTH', stage: 'AUTH', cause: last,
  });
}

/* ------------------------------------------------------------------ */
/* 发送                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} mail
 *   host, port, security, user, pass, accessToken, from, fromName,
 *   to (string|string[]), cc, bcc, subject, text, html, replyTo, ehloName
 * @param {object} opts  timeoutMs, rejectUnauthorized, minVersion
 * @returns {Promise<{ok:true, messageId:string, accepted:number, security:string, auth:string}>}
 */
export async function sendSmtpMail(mail = {}, opts = {}) {
  const host = String(mail.host ?? '').trim();
  const port = Number(mail.port) || 587;
  const timeoutMs = Number(opts.timeoutMs ?? mail.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const tlsOptions = {
    rejectUnauthorized: opts.rejectUnauthorized ?? mail.rejectUnauthorized,
    minVersion: opts.minVersion ?? mail.minVersion,
  };
  const resolved = resolveSecurity(host, port, mail.security ?? opts.security);

  const to = parseRecipients(mail.to);
  const cc = parseRecipients(mail.cc);
  const bcc = parseRecipients(mail.bcc);
  const envelopeTo = [...to, ...cc, ...bcc];
  const from = String(mail.from ?? mail.user ?? '').trim();
  const mimeMail = { ...mail, from, fromName: mail.fromName ?? '', to, cc };
  const mime = buildMimeMessage(mimeMail);
  const fromAddr = extractAddress(from);
  const ehloName = String(mail.ehloName || '[127.0.0.1]');

  if (!host) throw new SmtpError('还没配置 SMTP 服务器', { code: 'ECONFIG', stage: 'CONFIG' });
  if (!envelopeTo.length) throw new SmtpError('没有收件人', { code: 'EADDRESS', stage: 'CONFIG' });
  if (opts.maxSize && mime.length > opts.maxSize) {
    throw new SmtpError(`邮件内容超过服务器限制（${opts.maxSize} 字节）`, { code: 'ESIZE' });
  }

  /** 真正跑一遍会话。implicitTls=true 用隐式 TLS；否则明文 + 能力协商 */
  const attempt = async (implicitTls) => {
    let sock = await connectSocket(host, port, implicitTls, timeoutMs, tlsOptions);
    const session = new SmtpSession(sock);
    let done = false;
    const onTimeout = () => {
      if (!done) session.destroy();
    };
    session.setTimeout(timeoutMs, onTimeout);
    try {
      const greeting = await session.read();
      if (greeting.code !== 220) {
        throw new SmtpError(`SMTP 欢迎语异常：${greeting.code} ${greeting.text}`.trim(), {
          code: 'EGREETING', responseCode: greeting.code, stage: 'GREETING',
        });
      }

      let caps = { starttls: false, auth: new Set(), size: 0 };
      try {
        caps = parseCapabilities(await session.command(`EHLO ${ehloName}`, (c) => c === 250, 'EHLO'));
      } catch (e) {
        // 只把「服务器不认识 EHLO」当降级信号；连接断了别硬套 HELO
        if (!(e.responseCode >= 500 && e.responseCode < 600)) throw e;
        // 老服务器不认 EHLO，降级 HELO（之后没有能力表，认证靠盲试）
        await session.command(`HELO ${ehloName}`, (c) => c === 250, 'EHLO');
      }

      let usedStarttls = false;
      // 'none' 是用户显式要求明文，即使服务器宣告 STARTTLS 也不升级
      if (!implicitTls && caps.starttls && resolved !== 'none') {
        await session.command('STARTTLS', (c) => c === 220, 'STARTTLS');
        const upgraded = await upgradeTls(sock, host, timeoutMs, tlsOptions);
        session.replaceSocket(upgraded);
        session.setTimeout(timeoutMs, onTimeout);
        sock = upgraded;
        caps = parseCapabilities(await session.command(`EHLO ${ehloName}`, (c) => c === 250, 'EHLO'));
        usedStarttls = true;
      }
      // 587 没宣告 STARTTLS 时按明文继续（部分服务商如此），不硬失败

      if (opts.maxSize == null && caps.size > 0 && mime.length > caps.size) {
        throw new SmtpError(`邮件内容超过服务器 SIZE 限制（${caps.size} 字节）`, {
          code: 'ESIZE', stage: 'MAIL',
        });
      }

      const auth = await authenticate(session, caps, {
        user: mail.user, pass: mail.pass, accessToken: mail.accessToken,
      });

      await session.command(`MAIL FROM:<${fromAddr}>`, (c) => c === 250, 'MAIL');
      const accepted = [];
      for (const rcpt of envelopeTo) {
        try {
          await session.command(`RCPT TO:<${rcpt}>`, (c) => c === 250 || c === 251, 'RCPT');
          accepted.push(rcpt);
        } catch (e) {
          if (envelopeTo.length === 1) throw e;
        }
      }
      if (!accepted.length) {
        throw new SmtpError('所有收件人都被服务器拒绝', { code: 'ERCPT', stage: 'RCPT' });
      }

      await session.command('DATA', (c) => c === 354, 'DATA');
      session.write(dotStuff(mime));
      await session.command('.', (c) => c === 250, 'DATA');
      await session.command('QUIT', (c) => c === 221, 'QUIT').catch(() => {});

      done = true;
      const idMatch = /Message-ID:\s*(<[^>]+>)/.exec(mime);
      return {
        ok: true,
        messageId: idMatch?.[1] ?? '',
        accepted: accepted.length,
        security: implicitTls ? 'tls' : (usedStarttls ? 'starttls' : 'none'),
        auth,
      };
    } finally {
      done = true;
      session.destroy();
    }
  };

  const firstSecure = resolved === 'tls';
  try {
    return await attempt(firstSecure);
  } catch (err) {
    /**
     * 自动回退：不少服务商把 587 / 自定义端口做成隐式 TLS，却没写进文档。
     * 明文握手阶段就失败（拿不到 220 / 直接断连 / 超时）时，改用隐式 TLS 再试一次。
     * 认证失败、收件人被拒这类「已经聊上了」的错误绝不重试，避免锁号或重复发信。
     */
    const errno = String(err?.cause?.code || '');
    const canRetry = !firstSecure
      && resolved !== 'none'
      && (['EGREETING', 'ECONNECT', 'ECLOSED', 'ESOCKET'].includes(err?.code)
        || errno === 'ECONNRESET' || errno === 'ETIMEDOUT');
    if (!canRetry) throw err;
    return await attempt(true);
  }
}
