/**
 * QQ 开放平台 Webhook 签名
 * ========================
 *
 * Webhook 模式下，平台会先发一个 `op=13` 的验证请求，带 `plain_token` 和 `event_ts`。
 * 我们要用 `AppSecret` 做 Ed25519 私钥，对 `event_ts + plain_token` 签名，
 * 把 `{plain_token, signature}` 原样返回，验证通过后才会推事件。
 *
 * 算法细节（官方没写清楚，从实现反推的）：
 *   - 私钥种子 = AppSecret 循环填充/截断到 **32 字节**（UTF-8）
 *   - 签名内容 = `${event_ts}${plain_token}` 的 UTF-8 字节
 *   - 签名结果 = 64 字节 Ed25519 签名，**十六进制小写**
 *
 * Node 22 内置 `crypto` 就支持 Ed25519，不需要额外依赖。
 */
import crypto from 'node:crypto';

/** Ed25519 私钥的 PKCS#8 DER 前缀（后面接 32 字节种子） */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * 把 AppSecret 规整成 32 字节的 Ed25519 种子。
 * secret 比 32 短就循环拼接，比 32 长就截断——官方就是这么干的。
 */
export function seedFromSecret(secret) {
  const s = String(secret ?? '');
  if (!s) throw new Error('AppSecret 为空，无法签名');
  const buf = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = buf[i % buf.length];
  return out;
}

/**
 * 生成回调签名。
 * @param {string} secret   AppSecret
 * @param {string|number} eventTs  事件时间戳
 * @param {string} plainToken      平台下发的验证 token
 * @returns {string} 十六进制签名
 */
export function signCallback(secret, eventTs, plainToken) {
  const seed = seedFromSecret(secret);
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const payload = Buffer.from(`${eventTs}${plainToken}`, 'utf8');
  return crypto.sign(null, payload, key).toString('hex');
}

/**
 * 处理 `op=13` 验证请求。
 * @returns {{plain_token:string, signature:string}|null} 缺字段时返回 null
 */
export function verifyRequest(secret, body) {
  const d = body?.d ?? {};
  const plainToken = d.plain_token;
  const eventTs = d.event_ts;
  if (!plainToken || eventTs === undefined || eventTs === null) return null;
  return {
    plain_token: plainToken,
    signature: signCallback(secret, String(eventTs), String(plainToken)),
  };
}

/**
 * 给一段事件体签名（自测 / 本地模拟平台推送时用）。
 *
 * @param {string} secret AppSecret
 * @param {string|number} timestamp 秒级时间戳
 * @param {string} rawBody 原始请求体字符串
 * @returns {string} 十六进制签名
 */
export function signEventBody(secret, timestamp, rawBody) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seedFromSecret(secret)]),
    format: 'der',
    type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(`${timestamp}${rawBody}`, 'utf8'), key).toString('hex');
}

/**
 * 校验平台推来的事件签名。
 *
 * 平台对每个事件都带 `X-Signature-Ed25519` 和 `X-Signature-Timestamp`，
 * 签名内容同样是 `${timestamp}${rawBody}`，密钥就是 AppSecret 派生的那把。
 * 以前只验 op=13、不验普通事件——知道回调地址和 appId 的人可以伪造任意事件，
 * 包括冒充群主 openid 触发管理命令。
 *
 * @param {string} secret      AppSecret
 * @param {string} timestamp   请求头里的时间戳（秒）
 * @param {string} rawBody     原始请求体（**不要**用 JSON.stringify 重新序列化）
 * @param {string} signatureHex 请求头里的十六进制签名
 * @param {number} [toleranceSec] 时间戳容忍窗口，默认 300 秒
 * @returns {{ok:boolean, reason?:string}}
 */
export function verifyEventSignature(secret, timestamp, rawBody, signatureHex, toleranceSec = 300) {
  if (!signatureHex || !timestamp) return { ok: false, reason: '缺少签名头' };

  // 防重放：时间戳必须落在窗口内
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: '时间戳不是数字' };
  const skew = Math.abs(Date.now() / 1000 - ts);
  if (skew > toleranceSec) return { ok: false, reason: `时间戳偏差 ${Math.round(skew)} 秒，超出窗口` };

  let sig;
  try {
    sig = Buffer.from(String(signatureHex), 'hex');
  } catch {
    return { ok: false, reason: '签名不是合法十六进制' };
  }
  if (sig.length !== 64) return { ok: false, reason: `签名长度 ${sig.length}，应为 64` };

  try {
    const priv = crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seedFromSecret(secret)]),
      format: 'der',
      type: 'pkcs8',
    });
    const pub = crypto.createPublicKey(priv);
    const payload = Buffer.from(`${timestamp}${rawBody}`, 'utf8');
    return crypto.verify(null, payload, pub, sig)
      ? { ok: true }
      : { ok: false, reason: '签名不匹配' };
  } catch (e) {
    return { ok: false, reason: `验签出错：${e.message}` };
  }
}
