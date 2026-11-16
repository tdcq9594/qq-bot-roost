/**
 * 出站图片地址的安全校验
 * ======================
 *
 * 为什么单独一个文件：`readImage` 有三个入口——面板 `/api/dev/avatar`、
 * `ctx.dev.setAvatar`（内核插件）、OneBot `set_qq_profile`（**模型可触发**）。
 * 只验 `^https?://` 等于把「让宿主去 fetch 任意地址」开给模型：内网服务、
 * 云元数据（169.254.169.254）、本机管理端口都能打，错误回显还能当端口探针。
 *
 * 判据与 `dsh-roost/src/ssrf.js` 同一套（那个仓已经在用；两个仓互不依赖，
 * 所以按同样口径各实现一份，改一边要想着另一边）：
 *
 *   · 只放行 http / https，不许带账号密码
 *   · 字面 IP 直接判私有；域名先解析，**任一**地址私有就拒（防 DNS rebinding）
 *   · `::ffff:` 映射地址还原成 IPv4 再判——`new URL` 会把
 *     `::ffff:127.0.0.1` 规范成 `::ffff:7f00:1`，只认点分会漏
 *   · 跟随重定向要**逐跳**再校验，不能只查第一跳
 */

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** 把 IPv6 展开成 8 个 16 位整数；不是合法 IPv6 返回 null */
function expandV6(ip) {
  const s = String(ip ?? '').toLowerCase().split('%')[0];
  if (isIP(s) !== 6) return null;
  /** 尾部可能是点分 IPv4（`::ffff:127.0.0.1`），先换成两组十六进制 */
  let body = s;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (tail) {
    const p = tail[1].split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((p[0] << 8) | p[1]).toString(16);
    const lo = ((p[2] << 8) | p[3]).toString(16);
    body = `${body.slice(0, -tail[1].length)}${hi}:${lo}`;
  }
  const [head, rest] = body.includes('::') ? body.split('::') : [body, null];
  const a = head ? head.split(':') : [];
  const b = rest ? rest.split(':') : [];
  if (rest !== null && b.length && b[b.length - 1] === '') b.pop();
  const fill = rest === null ? 0 : 8 - a.length - b.length;
  if (fill < 0) return null;
  const groups = [...a, ...Array(rest === null ? 0 : fill).fill('0'), ...b];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => parseInt(g, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null;
}

/**
 * 取出 IPv6 里**编进去的 IPv4**；没有就返回 ''。
 *
 * 四种形态都要认，否则一条 IPv6 就能绕过全部 IPv4 判断：
 *   `::ffff:a.b.c.d`（IPv4-mapped）、`::a.b.c.d`（IPv4-compatible，`::/96`，已废弃但仍可能被路由）、
 *   `64:ff9b::/96`（NAT64，NAT64 网关会把它翻回 IPv4）、`2002::/16`（6to4，前 32 位就是 IPv4）
 */
function embeddedV4(ip) {
  const h = expandV6(ip);
  if (!h) return '';
  const v4 = (hi, lo) => `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
  const zeros = (from, to) => h.slice(from, to).every((n) => n === 0);
  /** ::ffff:a.b.c.d —— 前 5 组为 0、第 6 组是 ffff */
  if (zeros(0, 5) && h[5] === 0xffff) return v4(h[6], h[7]);
  /** ::a.b.c.d —— 前 6 组全 0（`::` 与 `::1` 由调用方先排除） */
  if (zeros(0, 6)) return v4(h[6], h[7]);
  /** 64:ff9b::/96 */
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return v4(h[6], h[7]);
  /** 2002::/16 —— 6to4 把 IPv4 放在第 2、3 组 */
  if (h[0] === 0x2002) return v4(h[1], h[2]);
  return '';
}

/** IPv4 / IPv6 的私有、回环、链路本地、保留、组播地址 */
export function isPrivateIp(ip) {
  const s = String(ip ?? '').toLowerCase().split('%')[0];
  if (!s) return true; // 空地址一律当不安全
  if (isIP(s) === 4) {
    const p = s.split('.').map(Number);
    const [a, b] = p;
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)                 // 链路本地 / 云元数据
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)       // CGNAT
      || (a === 192 && b === 0 && p[2] === 0)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;                                // 组播 + 保留
  }
  if (isIP(s) === 6) {
    if (s === '::' || s === '::1') return true;
    /** 编了 IPv4 的形态一律按里面那个 IPv4 判（映射 / 兼容 / NAT64 / 6to4） */
    const v4 = embeddedV4(s);
    if (v4) return isPrivateIp(v4);
    /** 落在 `::/96` 却认不出映射目标 → fail-closed，别再放行 */
    if (s.startsWith('::')) return true;
    const head = s.split(':')[0];
    if (/^f[cd]/.test(head)) return true;          // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(head)) return true;       // fe80::/10 链路本地
    return false;
  }
  return false;
}

/**
 * 校验一个出站地址。不合法就抛，消息直接给用户看（中文、说清哪一条不过）。
 *
 * @param {string} raw
 * @param {{lookup?:Function}} [o] `lookup` 只为测试注入，生产用系统解析
 * @returns {Promise<URL>}
 */
export async function assertSafeHttpUrl(raw, { lookup = dnsLookup } = {}) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error('不是合法的地址');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('只允许 http / https 地址');
  }
  if (u.username || u.password) {
    throw new Error('地址里不许带账号密码');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('地址缺少主机名');

  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问内网 / 本机地址');
    return u;
  }

  let addrs = [];
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    throw new Error(`解析不了这个域名（${e?.message ?? e}）`);
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new Error('这个域名没有解析结果');
  /** 任一地址私有就拒：不能「有公网就放行」——那正是 DNS rebinding 的用法 */
  for (const a of addrs) {
    if (isPrivateIp(a?.address)) throw new Error('这个域名指向内网 / 本机地址，已拒绝');
  }
  return u;
}

/** 读响应体，超过上限立刻中止（避免无 content-length 的流把内存顶满） */
async function readBodyLimited(res, maxBytes) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`这张 ${(buf.length / 1024 / 1024).toFixed(1)} MB，超过 ${maxBytes / 1024 / 1024} MB 上限`);
    }
    return buf;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* 已经断了就算了 */ }
      throw new Error(`这张超过 ${maxBytes / 1024 / 1024} MB 上限`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * 取一张图：逐跳校验地址、手动跟重定向、按上限流式读取。
 *
 * @param {string} raw
 * @param {{maxBytes:number, fetchImpl?:Function, lookup?:Function,
 *          timeoutMs?:number, maxRedirects?:number}} o
 * @returns {Promise<{buf:Buffer, type:string, finalUrl:string}>}
 */
export async function fetchImageLimited(raw, {
  maxBytes,
  fetchImpl = fetch,
  lookup = dnsLookup,
  timeoutMs = 15_000,
  maxRedirects = 3,
} = {}) {
  let cur = String(raw);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertSafeHttpUrl(cur, { lookup });
    const res = await fetchImpl(cur, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`取图被重定向（HTTP ${res.status}）但没给目标地址`);
      /** 相对地址要按当前跳解析；下一轮会再校验它是否私有 */
      cur = new URL(loc, cur).href;
      continue;
    }
    if (!res.ok) throw new Error(`取图失败（HTTP ${res.status}）`);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      throw new Error(`这张 ${(declared / 1024 / 1024).toFixed(1)} MB，超过 ${maxBytes / 1024 / 1024} MB 上限`);
    }
    const buf = await readBodyLimited(res, maxBytes);
    return { buf, type, finalUrl: cur };
  }
  throw new Error('重定向次数太多，已放弃');
}
