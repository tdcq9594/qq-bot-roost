/**
 * 代理支持
 * ========
 *
 * 为什么需要它：Node 的 `fetch`（undici）**既不读 Windows 的「系统代理」设置，
 * 默认也不读 `HTTPS_PROXY` 环境变量**——它永远是直连。而浏览器走系统代理，
 * 于是出现最让人困惑的一种现象：
 *
 *   浏览器打开 raw.githubusercontent.com 1 秒就出来了，框架却说「连不上 GitHub」。
 *
 * 实测（2026-11-09，作者机器）：系统代理 `127.0.0.1:7892` 下 raw 索引 0.75 秒 200；
 * 同一个地址 Node 直连 10～20 秒超时。DNS 是干净的，纯粹是 TCP 连不上。
 * 以前只能靠 `auto` 模式超时后切 Gitee 兜底，代价是**每次冷启动白等十几秒**。
 *
 * 这里补上两条路：
 *   - HTTPS 目标：CONNECT 隧道，再在隧道上做 TLS
 *   - HTTP 目标：直接给代理发绝对地址（absolute-form），不用隧道
 *
 * 只支持 **http / https 代理**（Clash、v2rayN、Fiddler 这些本地代理都是 http）。
 * SOCKS 不认——写错了会落到「没有代理」，面板会提示，不会静默乱来。
 *
 * 接管范围只有「下载相关」的出站：插件市场索引与包、框架更新、镜像测速、Gitee 拉取。
 * QQ 官方接口、扫码登录、预签名上传仍用原生 `fetch` 直连——那些是国内地址，
 * 套一层本地代理只会更慢，甚至被对端拒掉。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { createLogger } from './logger.js';

const log = createLogger('proxy');

/** CONNECT 握手最多等这么久。真代理建隧道是毫秒级，6 秒还没动静基本就是死的 */
const CONNECT_TIMEOUT_MS = 6000;

/** 判定「这个代理不可用」之后，多久之内不再试它（避免每个请求都白等 6 秒） */
const DEAD_TTL_MS = 60_000;

/** 跟随重定向的上限。原生 fetch 默认 20，我们只下静态文件，5 跳足够 */
const MAX_REDIRECT = 5;

/**
 * 当前设置：`auto` 跟随系统 / `off` 直连 / 具体代理地址。
 *
 * 由 configureProxy() 从 `config/bot.json` 的 `network.proxy` 读进来。
 */
let setting = 'auto';

/** 解析结果的缓存（读注册表要起子进程，不能每次请求都读） */
let cache = null;

/** `raw -> 到期时间`：被判死的代理在一分钟内跳过 */
const deadUntil = new Map();

/** 代理本身不可用（连不上 / 拒绝 CONNECT / 握手超时），可以降级直连 */
class ProxyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyError';
    this.proxyFailure = true;
  }
}

/**
 * 从全局配置里读代理设置。main / 保存配置 / 配置热加载三处都要调。
 *
 * @param {object} globalCfg config/bot.json 的内容
 */
export function configureProxy(globalCfg) {
  const raw = String(globalCfg?.network?.proxy ?? 'auto').trim();
  const next = raw === '' ? 'auto' : raw;
  if (next !== setting) log.info(`代理设置：${next}`);
  setting = next;
  cache = null;
}

/**
 * 校验并规范化用户填的代理地址。
 *
 * @param {string} raw
 * @returns {{ok: boolean, value?: string, error?: string}}
 */
export function normalizeProxySetting(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: '代理地址不能为空（不想用代理请选「直连」）' };
  if (s === 'auto' || s === 'off') return { ok: true, value: s };
  // 允许只填 127.0.0.1:7890，自动补 http://
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, error: `代理地址看不懂：${s}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      ok: false,
      error: `只支持 http / https 代理，不支持 ${u.protocol.replace(':', '')}（SOCKS 请用 Clash 之类的混合端口）`,
    };
  }
  if (!u.hostname) return { ok: false, error: `代理地址缺少主机名：${s}` };
  return { ok: true, value: `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}` };
}

/** 面板显示用：当前生效的是哪个代理、从哪来的 */
export function proxyInfo() {
  const c = resolve();
  return {
    mode: setting,
    active: c.primary ? c.primary.raw : '',
    /** config / system / env / none */
    source: c.primary ? c.primary.source : 'none',
    candidates: c.list.map((p) => `${p.raw}（${p.source}）`),
    bypass: c.bypass,
  };
}

/* ------------------------------------------------------------------ */
/* 解析：配置 → 系统 → 环境变量                                          */
/* ------------------------------------------------------------------ */

/**
 * 把「不走代理」的例外列表摊平成 host 数组。
 *
 * 来源有三种：注册表的 `ProxyOverride`（分号）、`NO_PROXY`（逗号或分号）、
 * 以后可能有人传数组。统一在这里切开，别让调用方各自 `split`。
 *
 * **为什么单独成一个函数**：2026-11-09 那次「配了代理还是连不上 GitHub」，
 * 根因就是 `bypass.push(...sys.bypass)` —— 展开字符串把
 * `*zhihu.com;localhost;…` 摊成了一百多个单字符，其中那个 `*` 使
 * `shouldBypass()` 对**任何**域名都返回 true，于是 netFetch 全部退回直连，
 * 日志里连一句「代理不可用」都没有，只剩 `fetch failed`。
 * 这里顺手兜一手：万一又被人摊成字符数组，先拼回去再切。
 *
 * @param {string|Array<string|string[]>} [input]
 * @returns {string[]}
 */
export function splitBypass(input) {
  let items = Array.isArray(input) ? input : [input];
  if (items.length > 2 && items.every((s) => typeof s === 'string' && s.length <= 1)) {
    items = [items.join('')];
  }
  return items
    .flatMap((s) => (Array.isArray(s) ? s : [s]))
    .flatMap((s) => String(s ?? '').split(/[,;]/))
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolve() {
  if (cache) return cache;

  const bypass = [];
  const list = [];

  const push = (proxy, source) => {
    if (!proxy) return;
    const src = source ?? proxy.source;
    if (list.some((p) => p.raw === proxy.raw)) return;
    list.push({ ...proxy, source: src });
  };

  if (setting === 'off') {
    cache = { list: [], primary: null, bypass };
    return cache;
  }

  if (setting !== 'auto') {
    // 用户明确指定：只用它，不去猜系统设置
    const one = parseProxyUrl(setting);
    if (one) push({ ...one, source: 'config' });
    else log.warn(`network.proxy 不是一个可用的代理地址，已按直连处理：${setting}`);
    cache = { list, primary: list[0] ?? null, bypass };
    return cache;
  }

  /**
   * auto 的顺序：**系统代理优先，环境变量在后**。
   *
   * 直觉上应该反过来（curl / wget 就是环境变量优先），但这是一个桌面工具：
   * 用户脑子里的等价物是「浏览器能打开，你就该能打开」，而浏览器走的是系统
   * 代理。实测过反例——这台机器上 `HTTPS_PROXY=127.0.0.1:8654` 是个对 raw
   * 完全不通的东西（10 秒失败），而系统代理 7892 是好的；环境变量优先会让
   * 框架一直用一个坏代理。想强制用环境变量，就把配置填成具体地址。
   */
  const sys = readSystemProxy();
  if (sys) {
    push(sys.proxy, 'system');
    /**
     * **必须是 push 这个字符串本身，不能展开。**
     * `push(...sys.bypass)` 会把 `*zhihu.com;localhost;…` 摊成一百多个单字符，
     * 其中那个 `*` 让 shouldBypass() 对**所有**域名都返回 true —— 代理彻底失效，
     * 日志里只剩一句 `fetch failed`。2026-11-09 踩过，见 splitBypass 的注释。
     */
    bypass.push(sys.bypass);
  }
  push(parseProxyUrl(process.env.HTTPS_PROXY || process.env.https_proxy), 'env');
  push(parseProxyUrl(process.env.HTTP_PROXY || process.env.http_proxy), 'env');
  bypass.push(process.env.NO_PROXY || process.env.no_proxy || '');

  cache = {
    list,
    primary: list[0] ?? null,
    bypass: splitBypass(bypass),
  };
  if (cache.primary) log.debug(`代理：${cache.primary.raw}（来自 ${cache.primary.source}）`);
  return cache;
}

/**
 * 解析一条代理地址。支持 `http://user:pass@host:port`。
 *
 * @param {string} [raw]
 */
export function parseProxyUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!u.hostname || !Number.isFinite(port) || port <= 0) return null;
  return {
    raw: `${u.protocol}//${u.host}`,
    host: u.hostname,
    port,
    /** 代理本身是 https（少见，但支持） */
    secure: u.protocol === 'https:',
    auth: u.username
      ? Buffer.from(
          `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`,
        ).toString('base64')
      : '',
  };
}

/**
 * 读 Windows 的系统代理（IE / 设置里的那个，Clash 之类的「系统代理」开关改的就是它）。
 *
 * 用 `reg query` 而不是 PowerShell：后者启动要几百毫秒，这里可能被每次请求调用。
 * 结果在 resolve() 里缓存，一个进程只读一次。
 *
 * @returns {{proxy: object, bypass: string} | null}
 */
function readSystemProxy() {
  if (process.platform !== 'win32') return null;
  /**
   * 逃生舱：某些环境把 `reg.exe` 拦了（企业策略 / 沙箱），一调就是进程级失败。
   * 设 `ROOST_NO_SYSTEM_PROXY=1` 就完全不读系统设置，只用环境变量或直连。
   */
  if (process.env.ROOST_NO_SYSTEM_PROXY) return null;
  let out = '';
  try {
    out = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 },
    );
  } catch {
    return null;
  }
  return parseWindowsProxyReg(out);
}

/**
 * 解析 `reg query` 的输出（抽出来单独测：起子进程的方式在 CI / 沙箱里不一定能跑）。
 *
 * 输出长这样：
 *     ProxyEnable    REG_DWORD    0x1
 *     ProxyServer    REG_SZ    127.0.0.1:7892
 *     ProxyOverride  REG_SZ    *zhihu.com;localhost;<local>
 *
 * @param {string} out
 * @returns {{proxy: object, bypass: string} | null}
 */
export function parseWindowsProxyReg(out) {
  const val = (name) => {
    const m = new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(String(out || ''));
    return m ? m[1].trim() : '';
  };

  if (val('ProxyEnable') !== '0x1' && val('ProxyEnable') !== '0x00000001') return null;

  // 可能是 `127.0.0.1:7892`，也可能是 `http=...;https=...` 按协议分开的写法
  let server = val('ProxyServer');
  if (!server) return null;
  if (server.includes('=')) {
    const parts = Object.fromEntries(
      server.split(';').map((kv) => {
        const i = kv.indexOf('=');
        return i < 0 ? [kv, ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      }),
    );
    server = parts.https || parts.http || '';
  }
  const proxy = parseProxyUrl(server);
  if (!proxy) return null;
  return { proxy, bypass: val('ProxyOverride') };
}

/**
 * 这个目标地址该不该走代理（`no_proxy` / Windows 的「例外」列表）。
 *
 * 支持 `*`、`.example.com`、`example.com`、`host:port`，以及 Windows 那种
 * 写在前面的通配（`*zhihu.com`）。不支持 CIDR——写 `10.0.0.0/8` 的人极少数，
 * 而且认错了比不认更危险。
 */
export function shouldBypass(host, port, bypass = []) {
  const h = String(host || '').toLowerCase();
  for (const entry of bypass) {
    if (!entry) continue;
    let e = entry.toLowerCase();
    if (e === '<local>') {
      if (!h.includes('.')) return true;
      continue;
    }
    if (e === '*') return true;

    // 端口限定：example.com:8080
    let needPort = null;
    const colon = e.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(e.slice(colon + 1))) {
      needPort = Number(e.slice(colon + 1));
      e = e.slice(0, colon);
    }
    if (needPort && Number(port) !== needPort) continue;

    e = e.replace(/^\*\.?/, '').replace(/^\./, '');
    if (!e) continue;
    // 尾部通配：Windows 例外列表里 `10.*` / `127.*` / `172.16.*` 都是这个意思
    if (e.endsWith('*')) {
      const prefix = e.slice(0, -1);
      if (prefix && h.startsWith(prefix)) return true;
      continue;
    }
    if (h === e || h.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** 这个地址能用哪些代理（已排掉 no_proxy 与「刚判死」的） */
function candidatesFor(target) {
  const c = resolve();
  if (!c.list.length) return [];
  if (shouldBypass(target.hostname, target.port, c.bypass)) return [];
  const now = Date.now();
  return c.list.filter((p) => (deadUntil.get(p.raw) ?? 0) <= now);
}

function markDead(proxy, why) {
  deadUntil.set(proxy.raw, Date.now() + DEAD_TTL_MS);
  log.warn(`代理 ${proxy.raw} 不可用（${why}），${DEAD_TTL_MS / 1000} 秒内改走直连`);
}

/* ------------------------------------------------------------------ */
/* 对外的 fetch                                                       */
/* ------------------------------------------------------------------ */

/**
 * 和 `fetch` 一样的调用方式，但**有代理就走代理**。
 *
 * 返回的是标准 `Response`（内容已经整块读进内存），所以 `.ok`、`.status`、
 * `.headers`、`.json()`、`.text()`、`.arrayBuffer()` 都能照常用。
 * 唯一不支持的是流式 `res.body`——本项目只下索引和 tarball（几百 KB），
 * 不值得为流式再写一套。
 *
 * 代理挂了会自动降级直连（并记住 60 秒），所以「装了代理又关掉」不会把面板卡死。
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function netFetch(url, init = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return fetch(url, init);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return fetch(url, init);

  const candidates = candidatesFor(target);
  if (!candidates.length) return fetch(url, init);

  for (const proxy of candidates) {
    try {
      return await withProxy(target, init, proxy);
    } catch (e) {
      if (!e?.proxyFailure) throw e; // 目标那边的问题，交给调用方（镜像兜底 / 重试）
      markDead(proxy, e.message);
    }
  }

  // 代理全挂了：退回直连，别让面板因为一个配错/已关掉的代理彻底不能下载
  return fetch(url, init);
}

/** 走代理抓一个地址，自己跟随重定向（3xx 也要能拿到，调用方可能在看 Location） */
async function withProxy(target, init, proxy) {
  let url = target;
  let method = String(init.method || 'GET').toUpperCase();
  let body = normalizeBody(init.body);
  const headers = stripUnsupported(init.headers);

  for (let hop = 0; hop <= MAX_REDIRECT; hop++) {
    const res = await requestOnce(url, { ...init, method, body, headers }, proxy);
    if (init.redirect === 'manual') return res;
    const loc = res.headers.get('location');
    if (!loc || ![301, 302, 303, 307, 308].includes(res.status)) return res;
    url = new URL(loc, url);
    // 303 一律变 GET；301/302 上的 POST 也按浏览器习惯降级（下载用不到，但别写错）
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = null;
    }
  }
  throw new Error('重定向次数过多');
}

/** 发一次请求（https 先建隧道；http 直接让代理转发绝对地址） */
async function requestOnce(target, init, proxy) {
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port || (isHttps ? 443 : 80));
  const method = String(init.method || 'GET').toUpperCase();

  /**
   * https：隧道和 TLS 都先建好，再交给一个只服务这一次请求的 Agent。
   *
   * **不能**把隧道 socket 直接塞进 `http.request({createConnection})`——试过，
   * 请求写出去了但永远读不到响应（8 秒无数据），而手写 HTTP 帧却是通的。
   * 原因是那条 socket 上还挂着上一次 http 客户端的状态。用 Agent 的
   * `createConnection(options, cb)` 回调形式交出去才是干净的路子。
   */
  let agent;
  if (isHttps) {
    const raw = await connectTunnel(proxy, target.hostname, port, init.signal);
    const tlsSocket = await startTls(raw, target.hostname);
    agent = new SingleSocketAgent(tlsSocket);
  }

  /**
   * 明文目标走 absolute-form：直接请求代理，path 写完整 URL。
   * 这种请求连到的是代理，代理本身是 https 时要用 https.request。
   */
  const mod = isHttps ? https : proxy.secure ? https : http;
  const opts = isHttps
    ? {
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: init.headers,
        agent,
        signal: init.signal,
      }
    : {
        host: proxy.host,
        port: proxy.port,
        method,
        path: target.href,
        headers: {
          ...init.headers,
          Host: target.host,
          ...(proxy.auth ? { 'Proxy-Authorization': `Basic ${proxy.auth}` } : {}),
        },
        agent: false,
        signal: init.signal,
      };

  return await new Promise((resolve, reject) => {
    let responded = false;
    const req = mod.request(opts, (res) => {
      responded = true;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(buildResponse(res, Buffer.concat(chunks))));
      res.on('error', (e) => reject(abortAware(e, init.signal)));
    });
    req.once('error', (e) => {
      const err = abortAware(e, init.signal);
      /**
       * 明文目标连的是**代理**，所以「连不上」在这里指的是代理挂了
       * （端口没开、进程退了），要标成 ProxyError 才能触发直连降级。
       * 已经收到响应之后的错误不算——那是目标或链路的问题。
       */
      if (!isHttps && !responded && isConnFailure(err)) {
        return reject(new ProxyError(`连不上代理 ${proxy.raw}：${err.message}`));
      }
      reject(err);
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}

/** 这些错误码说明是「根本没连上」，可以换下一个源 / 降级直连 */
function isConnFailure(e) {
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT'].includes(
    e?.code,
  );
}

/**
 * 只服务一次请求的 Agent：把已经建好的 TLS socket 交还给 http 客户端。
 *
 * 用它而不是 `createConnection: () => socket`，是因为后者在隧道 socket 上
 * 会卡住（详见 requestOnce 里的注释）。
 */
class SingleSocketAgent extends https.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this._socket = socket;
  }

  createConnection(options, cb) {
    cb(null, this._socket);
  }
}

/** CONNECT 建隧道，返回一条已经打通的裸连接 */
function connectTunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));

    /**
     * **手写 CONNECT 帧**，不走 `http.request({method:'CONNECT'})`。
     *
     * 走 http.request 的话，拿到的 socket 上还留着那个 ClientRequest 的状态
     * （解析器、`_httpMessage`），后面谁再往这条 socket 上发请求都要么被卡住、
     * 要么数据被旧解析器吞掉。手写三十行，省掉一整类诡异问题。
     */
    const sock = proxy.secure
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
      : net.connect({ port: proxy.port, host: proxy.host });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener('data', onData);
      fn(arg);
    };

    const timer = setTimeout(() => {
      sock.destroy();
      finish(reject, new ProxyError(`连接代理超时（${CONNECT_TIMEOUT_MS / 1000} 秒没建好隧道）`));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return; // 响应头还没收全
      const head = buf.slice(0, end).toString('latin1');
      const rest = buf.slice(end + 4);
      const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1] || 0);
      if (status !== 200) {
        sock.destroy();
        const why =
          status === 407
            ? '代理要求认证（407），请在地址里写上用户名密码'
            : `代理拒绝 CONNECT（HTTP ${status || '未知'}）`;
        return finish(reject, new ProxyError(why));
      }
      // 隧道里多出来的字节要还给上层，不能丢
      if (rest.length) sock.unshift(rest);
      finish(resolve, sock);
    };

    sock.setNoDelay?.(true);
    sock.once(proxy.secure ? 'secureConnect' : 'connect', () => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Proxy-Connection: keep-alive',
      ];
      if (proxy.auth) lines.push(`Proxy-Authorization: Basic ${proxy.auth}`);
      sock.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    sock.on('data', onData);

    sock.once('error', (e) => {
      if (signal?.aborted) return finish(reject, signal.reason ?? e);
      finish(reject, new ProxyError(`连不上代理 ${proxy.raw}：${e.message}`));
    });

    // 调用方超时（AbortSignal.timeout）→ 拆掉隧道，把 TimeoutError 原样抛上去
    if (signal) {
      const onAbort = () => {
        sock.destroy();
        finish(reject, signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      sock.once('close', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

/** 在隧道上做 TLS，并对齐 SNI（不然 CDN 会回错证书） */
function startTls(socket, host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
    const onErr = (e) => reject(new Error(`与 ${host} 建立 TLS 失败：${e.message}`));
    s.once('secureConnect', () => {
      s.removeListener('error', onErr);
      resolve(s);
    });
    s.once('error', onErr);
  });
}

function buildResponse(res, buf) {
  const status = res.statusCode || 0;
  // 204/304 带 body 会被 Response 拒绝
  const body = status === 204 || status === 304 ? null : buf;
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, String(v));
  }
  return new Response(body, {
    status: status >= 200 && status <= 599 ? status : 502,
    statusText: res.statusMessage || '',
    headers,
  });
}

/** 超时（AbortSignal.timeout）要原样抛出 TimeoutError，调用方靠它区分「超时」和「连不上」 */
function abortAware(e, signal) {
  if (signal?.aborted) return signal.reason instanceof Error ? signal.reason : new Error('aborted');
  return e;
}

/**
 * 我们自己管理解压：只发 identity，**不要** accept-encoding。
 *
 * 原生 fetch 会替我们解开 gzip；这里拿到的是原始字节，如果对方还压着，
 * `res.json()` 会直接报「不是合法 JSON」——那种错误极难对上号。
 */
function stripUnsupported(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = k.toLowerCase();
    if (key === 'accept-encoding' || key === 'connection' || key === 'host') continue;
    out[k] = v;
  }
  return out;
}

function normalizeBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  throw new Error('代理模式下不支持这个请求体类型（只支持字符串 / Buffer）');
}

/** 给测试和「设置页」用：清掉缓存与「判死」记录 */
export function resetProxyState() {
  cache = null;
  deadUntil.clear();
}
