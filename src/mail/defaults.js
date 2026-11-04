/**
 * SMTP 默认值放在一个无依赖的纯数据模块里：
 * `config.js`（全局默认配置）和 `mail/service.js`（运行时现读）共用同一份，
 * 免得两边各写一份、以后加字段时悄悄漂移。
 */

export const SMTP_DEFAULTS = Object.freeze({
  enabled: false,
  host: '',
  port: 587,
  /** auto = 按端口规则 + 服务商特例自动判定；也可手填 tls / starttls / none */
  security: 'auto',
  user: '',
  pass: '',
  from: '',
  fromName: '',
  /** 原「收件人邮箱」：只作测试邮件收件人。用户 QQ 邮箱由 QQ 号现拼，不在这里配 */
  ownerEmail: '',

  /* 高级项，面板不展示，可手改 config/bot.json */
  timeoutMs: 15_000,
  rejectUnauthorized: true,
  maxPerMinute: 5,
  dailyLimit: 50,
});
