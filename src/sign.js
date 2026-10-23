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
