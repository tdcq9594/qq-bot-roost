/**
 * 供应链信任：签名与验签
 * ======================
 *
 * 为什么需要它：`index.json` 里的 `sha256` 和索引本身同仓同源，能改索引的人
 * 顺手就能把哈希一起改了，校验照过。哈希只证明「内容和这份清单一致」，
 * 不证明「这份清单是作者发的」——后者需要**独立于业务仓的密钥**。
 *
 * 所以这里只做一件事：**用一把离线私钥给清单签名，用内置公钥验签**。
 * 哈希仍然保留（它挡的是传输篡改和内容漂移），两者职责不同。
 *
 * 设计取舍：
 *   · 签的是**规范化后的 JSON**，不是原始字节。镜像站可能重新序列化
 *     （缩进、键序、末尾换行），签字节会被这些无关差异搞挂。
 *   · 规范化规则必须稳定且可复现：键排序、无空白、数组保序。
 *   · 信封格式 `{alg, keyId, sig}`，也接受裸 base64，方便手工签。
 *   · **没有公钥 = unavailable，不是通过也不是拒绝**。调用方必须显式决定
 *     怎么处理，不能让「没配公钥」悄悄变成放行。
 */

import crypto from 'node:crypto';

/** 发版时填进来的内置公钥（PEM 或 32 字节 base64）。留空 = 本版不启用验签。 */
export const EMBEDDED_PUBKEY = 'bqmZDZi/gnW7FppqKCOa5Zvc1XUvT/vw7fiiHR2hcIo=';

/**
 * 内置强制开关。
 *
 * **发版时把它改成 `true`，所有没显式配置的用户就默认开启强制验签**——
 * 这就是「后续一个更新就能马上打开」的那个开关。
 *
 * 为什么不在这次直接开：签名文件还没铺到索引里，现在开会让所有安装失败。
 * 顺序必须是「先发签名 → 再开开关」。
 *
 * 优先级（见 `resolveTrust`）：
 *   配置 `security.trust.enforce` > 环境变量 `ROOST_TRUST_ENFORCE` > 本常量
 */
export const EMBEDDED_ENFORCE = false;

/**
 * 规范化：键排序 + 无空白 + 数组保序。
 *
 * 不能直接用 `JSON.stringify(data)`——它按插入顺序输出键，
 * 同一个对象经过一次 parse/stringify 往返就可能换序。
 *
 * @param {unknown} v
 * @returns {string}
 */
export function canonicalize(v) {
  if (v === undefined) throw new Error('canonicalize 不接受 undefined');
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalize(x)).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(',')}}`;
}

/**
 * 文本规范化：CRLF → LF，去掉末尾空白。
 *
 * 为什么需要：`SHA256SUMS` 这类纯文本文件会被 git 的 `eol` 属性和编辑器改写
 * 换行符。签原始字节的话，Windows 检出一次签名就失效了。
 *
 * 注意：JSON 不走这里，走 `canonicalize`。
 *
 * @param {string} s
 */
export function normalizeText(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * 把 PEM / 裸 base64 / JWK 统一成 KeyObject。
 *
 * @param {string} text
 * @returns {import('node:crypto').KeyObject|null}
 */
export function publicKeyFrom(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try {
    if (t.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(t);
    const raw = Buffer.from(t, 'base64');
    if (raw.length !== 32) return null;
    return crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/**
 * 签名。Ed25519 的算法参数是 `null`（不是 'sha256'）。
 *
 * @param {string} text 已规范化的内容
 * @param {string} privateKeyPem
 * @returns {string} base64 签名
 */
export function signText(text, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(text, 'utf8'), key).toString('base64');
}

/**
 * 验签。任何异常都返回 false —— 验签失败的原因不该抛给上层，
 * 上层只需要「过 / 不过」和一句能看懂的话。
 *
 * @param {string} text
 * @param {string} sigB64
 * @param {string} publicKeyPem
 * @returns {boolean}
 */
export function verifyText(text, sigB64, publicKeyPem) {
  try {
    const key = typeof publicKeyPem === 'string' ? publicKeyFrom(publicKeyPem) : publicKeyPem;
    if (!key) return false;
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(String(sigB64), 'base64'));
  } catch {
    return false;
  }
}

/**
 * 解析签名信封。接受 `{alg,keyId,sig}` 或裸 base64。
 *
 * @param {string} raw
 * @returns {{alg:string, keyId:string, sig:string}|null}
 */
export function parseSig(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t);
      if (!o || typeof o.sig !== 'string' || !o.sig) return null;
      return { alg: String(o.alg ?? ''), keyId: String(o.keyId ?? ''), sig: o.sig };
    } catch {
      return null;
    }
  }
  return { alg: 'ed25519', keyId: '', sig: t };
}

/**
 * 从配置解析信任策略。
 *
 * `security.trust = { pubkey, enforce, allowUnsigned: [] }`
 * 也接受直接传 trust 对象（测试用）。
 *
 * @param {object} cfg
 */
export function resolveTrust(cfg = {}) {
  const t = cfg?.security?.trust ?? cfg ?? {};

  /**
   * 优先级：配置（面板开关）> 环境变量 > 内置常量。
   *
   * **配置必须最后生效**：面板上的开关是用户能看见的唯一入口，
   * 如果环境变量能压过它，就会出现「我明明关了它还拦」这种查不出来的怪事。
   * 环境变量只作为没写配置时的兜底（排查、临时灰度）。
   */
  let enforce = EMBEDDED_ENFORCE;
  const env = String(process.env.ROOST_TRUST_ENFORCE ?? '').trim().toLowerCase();
  if (env === '1' || env === 'true') enforce = true;
  else if (env === '0' || env === 'false') enforce = false;
  if (t.enforce !== undefined) enforce = t.enforce === true;

  return {
    pubkey: String(t.pubkey ?? '') || EMBEDDED_PUBKEY,
    enforce,
    allowUnsigned: Array.isArray(t.allowUnsigned) ? t.allowUnsigned.map(String) : [],
    /** 额外声明为「官方源」的地址（自建代理 / 镜像用），默认只认 market.js 里的官方地址 */
    officialUrls: Array.isArray(t.officialUrls) ? t.officialUrls.map(String) : [],
  };
}

/**
 * 公钥能不能用。
 *
 * 面板要拿它区分「没配」和「配错了」——这两种都让开关不起作用，
 * 但用户的修法完全不同：一个是去配，一个是去改。
 *
 * @param {string} pubkey
 */
export function pubkeyUsable(pubkey) {
  return Boolean(publicKeyFrom(pubkey));
}

/**
 * 校验一份清单。
 *
 * 返回的 `status` 有五种，调用方必须显式处理每一种：
 *   ok          签名有效
 *   unsigned    有公钥、没签名文件
 *   bad         签名存在但不匹配（内容被改过 / 用错密钥）
 *   invalid     配了公钥但解析不了（**不是「没配」**，强制时必须拦）
 *   unavailable 没配公钥，本版无法验签
 *
 * @param {{data:unknown, sigText?:string, trust:object, kind?:string}} o
 */
export function checkTrust({ data, sigText, trust, kind = '清单' }) {
  if (!trust?.pubkey) return { status: 'unavailable', why: `没有配置信任公钥，${kind}未验签` };
  /**
   * 配了但解析不了 → `invalid`，不能并进 `unavailable`。
   *
   * 并进去的后果很严重：用户把公钥粘错一个字符、打开强制开关，然后
   * **一切照常放行**——他以为受保护了，实际什么都没验。这类「安全开关
   * 看起来开着、其实没生效」比没有开关更危险，所以必须单独一个状态。
   */
  if (!publicKeyFrom(trust.pubkey)) {
    return { status: 'invalid', why: '信任公钥无法解析（应为 PEM 或 32 字节 base64）' };
  }

  const env = parseSig(sigText);
  if (!env) return { status: 'unsigned', why: `${kind}没有签名文件` };
  if (env.alg && env.alg !== 'ed25519') return { status: 'bad', why: `不支持的签名算法：${env.alg}` };

  const ok = verifyText(canonicalize(data), env.sig, trust.pubkey);
  if (!ok) return { status: 'bad', why: `${kind}的签名与内容不匹配` };
  return { status: 'ok', keyId: env.keyId };
}

/**
 * 该不该拦。
 *
 * 返回 `null` = 放行；返回字符串 = 拦截理由。
 *
 * **只对官方源强制**。理由：手写插件不走市场索引（`loader.js` 只扫 `plugins/`
 * 目录，完全不碰验签），所以「用户自己写插件」这条路从来不受影响；
 * 而用户自己填的 `plugins.marketUrl` 属于他自己的信任决定——他信那个仓库，
 * 我们没资格替他拦。签名要防的是「官方渠道被悄悄换掉」，不是「用户自己的源」。
 *
 * `unavailable` **永远放行**：没配公钥就拦，等于让所有没升级配置的用户
 * 一次性断掉，那不是安全，是事故。
 *
 * @param {object} trust
 * @param {string} status
 * @param {string} [id]
 * @param {{official?: boolean}} [opts]
 * @returns {string|null}
 */
export function blockReason(trust, status, id = '', opts = {}) {
  if (!trust?.enforce) return null;
  if (opts.official === false) return null;
  if (status === 'ok' || status === 'unavailable') return null;
  /**
   * 配错公钥必须拦：否则「开关开着、实际没验」，用户以为受保护了。
   * 这条不能算进 `unavailable`——那个是「没配」，放行是有意的。
   */
  if (status === 'invalid') {
    return '信任公钥无法解析，强制校验无法生效（检查 security.trust.pubkey，或等内置公钥的版本）';
  }
  if (status === 'unsigned' && trust.allowUnsigned.includes(String(id))) return null;
  if (status === 'bad') return '签名校验失败：内容与签名不一致（可能被篡改，或用错了密钥）';
  return `没有签名，且不在 allowUnsigned 白名单里（${id || '该项'}）`;
}
