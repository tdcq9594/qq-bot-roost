import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from '../config.js';
import { DIRS, botPaths, listBotIds, rel } from '../paths.js';
import { createLogger, recentLogs, onLog, getLevel, setLevel } from '../logger.js';
import { EVENT_NAMES, INTENT_META, describeIntents, groupEvents } from '../events.js';
import {
  fetchIndex,
  installPlugin,
  syncRepo,
  cleanupRepo,
  updatePlugins,
  mergeWithInstalled,
  detectUpdates,
  compareVersion,
} from '../plugin/market.js';
import {
  checkUpdate as checkFrameworkUpdate,
  applyUpdate as applyFrameworkUpdate,
  currentVersion,
} from '../updater.js';
// 面板改插件启停时要同步机器人配置里的过滤器，两边不能各说各的
import { pluginFilterOf, pluginAllowedIn } from '../bot.js';
import { userFacingSendError } from '../outbound.js';
import { runRoute } from '../plugin/routes.js';
import { toggleGroupPlugin } from '../plugin/groupscope.js';
import { suspendPluginWatch } from '../services/plugin-watch.js';
import { onMessage as onBusMessage } from '../message-bus.js';
import { handleQqCall, capabilityPayload } from './qq-call.js';
import { runDoctor, summarize } from '../doctor.js';
import { createBindTask, pollBindResult } from '../qq/qrlogin.js';
import { toSvg as qrToSvg } from '../qq/qrsvg.js';
import {
  PRESETS,
  PROBE_URL,
  configureMirror,
  currentMirror,
  probeMirrors,
} from '../mirror.js';

const log = createLogger('webui');
const WEB_ROOT = path.join(ROOT, 'web');

/**
 * 进程实例标识。
 *
 * 面板用它判断「服务是不是重启过」。重启意味着两件事同时发生：
 *   - 页面令牌全部重新生成 → 已打开的插件页 iframe 手里拿的全是废牌，
 *     之后每个请求都会被判成跨站（403）
 *   - 会话 Cookie 全部失效
 *
 * 前端拿到这个值一变化，就可以立刻重载 iframe，而不是干等兜底轮询
 * （用户会看到一条红色报错闪过，体验很差）。
 */
const PROCESS_STARTED_AT = Date.now();

/**
 * 主面板的 CSP。
 *
 * 几个取舍说明一下，免得后来人以为写错了：
 *   - `script-src 'self'` 是硬要求：主题脚本已外置成 /theme-boot.js，
 *     面板里不再有内联 <script>。开 'unsafe-inline' 等于放弃脚本防护，
 *     而面板 localStorage 里存着访问密钥。
 *   - `style-src` **必须**留 'unsafe-inline'：app.js 里有二十多处
 *     `style="width:...%"` 这类动态样式，去掉它布局直接散架。
 *   - `img-src` 带 data: 和 blob:：二维码是 SVG 内联，插件图标可能用 data URI。
 *   - 不设 HSTS：本地是 http，加了会让浏览器以后强制走 https 打不开。
 *     反代终止 TLS 时由 Nginx/Caddy 那边加。
 *   - `frame-src 'self'` 是给插件页面 iframe 用的，与 `frame-ancestors 'none'`
 *     不冲突：前者管「我能嵌谁」，后者管「谁能嵌我」。
 */
const CSP_MAIN = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 插件页面的 CSP —— 必须比主面板宽，而且**一条 `'self'` 都不能有**。
 *
 * 两个坑，都是实测踩出来的：
 *
 * 1. 插件页跑在 `sandbox="allow-scripts allow-forms"` 的 iframe 里（没有
 *    allow-same-origin），它的源是 **opaque origin**。CSP 里 `'self'` 的语义是
 *    「文档自己的源」，而 opaque origin 跟谁都不相等 —— 于是 `connect-src 'self'`
 *    会把插件页**所有** fetch 拦死。现象是页面渲染正常、数据永远加载不出来，
 *    控制台报 `Failed to fetch`，而服务端一条请求记录都没有。
 * 2. 所以这里改用协议通配（`http:` / `https:`）而不是源通配。
 *    敢放宽的前提是隔离靠 sandbox 不靠 CSP：插件页读不到父页的 localStorage /
 *    Cookie / DOM，调接口必须带 URL 上那把只属于本页面的 `pt` 令牌。
 *
 * 也不设 `frame-ancestors`：opaque origin 下它同样认不出「谁在嵌我」，
 * 反而可能连面板自己都嵌不进去。防外部嵌套由主面板那套 X-Frame-Options 负责。
 */
const CSP_PAGE = [
  "default-src 'none'",
  "script-src 'unsafe-inline' http: https:",
  "style-src 'unsafe-inline' http: https:",
  "img-src data: blob: http: https:",
  "font-src data: http: https:",
  "connect-src http: https:",
].join('; ');

/**
 * 插件页的「自动带令牌」补丁 —— 注入到插件页 HTML 最前面。
 *
 * **为什么需要（0.8.12 修的回归）**：iframe 地址上带的凭证以前是面板密钥
 * `?key=`，插件页面自己把它转发给接口。0.8.9 起换成了一次性页面令牌
 * `?pt=`，但**已有插件的页面还在转发 `key`** —— 于是它们发出的请求一个
 * 凭证都没带；iframe 又是 opaque origin（`Origin: null`），`isSameOrigin()`
 * 判跨站 → 403，页面永远停在「加载中…」，控制台只看到 `Failed to load
 * resource: 403`。dice 的战绩页就是这么挂的。
 *
 * 不能指望每个插件作者都回来改这一行（市场里的插件都在外部仓库），
 * 所以框架替页面把 `pt` 补上。
 *
 * **安全边界没变**：
 * - 只补发给**面板自己**（目标 origin 必须等于文档基准的 origin），
 *   第三方站点拿不到令牌；
 * - 能碰哪些路径仍由 `pageTokenAllows()` 决定，拿着令牌也调不了
 *   /api/config、/api/logs、/api/bots。
 *
 * @param {string} pt 本次请求的页面令牌
 * @returns {string} 一段 `<script>`，无令牌时返回空串
 */
export const pageTokenPatch = (pt) => {
  const token = String(pt ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (!token) return '';
  return (
    '<script>(function(){var PT=' +
    JSON.stringify(token) +
    ',BASE=document.baseURI||location.href,SELF="";' +
    'try{SELF=new URL(BASE).origin}catch(e){}' +
    // 只给面板自己的地址补令牌：第三方 origin 原样发出，绝不外泄
    'function add(u){try{var n=new URL(u,BASE);' +
    'if(SELF&&n.origin!==SELF)return u;' +
    'if(n.searchParams.get("pt"))return n.href;' +
    'n.searchParams.set("pt",PT);return n.href}catch(e){return u}}' +
    'var f=window.fetch;if(f)window.fetch=function(i,o){try{' +
    'if(typeof i==="string")i=add(i);' +
    'else if(i instanceof URL)i=new URL(add(i.href));' +
    'else if(typeof Request!=="undefined"&&i instanceof Request){var h=add(i.url);' +
    'if(h!==i.url)i=new Request(h,i)}}catch(e){}return f.call(window,i,o)};' +
    'var X=window.XMLHttpRequest;' +
    'if(X&&X.prototype&&X.prototype.open){var O=X.prototype.open;' +
    'X.prototype.open=function(m,u){if(typeof u==="string"){' +
    'try{arguments[1]=add(u)}catch(e){}}return O.apply(this,arguments)}};' +
    'var E=window.EventSource;' +
    'if(E){var W=function(u,c){return new E(add(String(u)),c)};W.prototype=E.prototype;' +
    'try{W.CONNECTING=E.CONNECTING;W.OPEN=E.OPEN;W.CLOSED=E.CLOSED}catch(e){}' +
    'window.EventSource=W}})();<\/script>'
  );
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 请求体解析失败时带上状态码，让上层能回 413/400 而不是一律 500 */
class BodyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function readBody(req, limit = 1024 * 256) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      // 超限就断开，别让对端继续往一个已经废掉的请求里灌数据
      req.destroy?.();
      throw new BodyError(`请求体过大（上限 ${Math.round(limit / 1024)} KB）`, 413);
    }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError('请求体不是合法 JSON', 400);
  }
}

/**
 * 依次尝试 startPort、startPort+1 … 直到能监听为止。
 * 端口被占用不再直接失败——换一个继续，避免「上次没关干净」导致面板打不开。
 *
 * @returns {Promise<number>} 实际监听成功的端口
 */
/** 扫码建机器人的临时任务表：taskId → { bindKey, at } */
const qrTasks = new Map();

function listenWithFallback(server, host, startPort, { tries = 20, onBusy } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryOnce = () => {
      const p = startPort + attempt;

      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && attempt < tries - 1) {
          onBusy?.(p);
          attempt += 1;
          // 稍等一下再试，给上一个 socket 一点清理时间
          setTimeout(tryOnce, 10);
          return;
        }
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(p);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(p, host);
      } catch (e) {
        server.off('listening', onListening);
        reject(e);
      }
    };

    tryOnce();
  });
}

/**
 * 插件页面的基础样式与主题变量。
 *
 * 目的是让插件作者**不用管深浅色**：直接用 `var(--panel)` `var(--text)` 就行。
 * 变量名和 web/style.css **必须保持一致**——插件作者在面板里看到的是
 * `var(--text)`，在插件页面里也应该是同一个名字，不能自创一套。
 * 面板切主题时 iframe 会带着 theme 参数重新加载，页面自动跟着变。
 */
const BASE_CSS = `
body{margin:0;padding:16px;background:var(--panel);color:var(--text);
font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:var(--primary)}
h1,h2,h3{color:var(--text);font-weight:600}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)}
th{font-size:12px;font-weight:600;color:var(--muted)}
code{background:var(--panel-2);padding:1px 5px;border-radius:4px}
`;

/** 两套主题的变量值，和 web/style.css 的 :root 一一对应 */
const PAGE_THEME = {
  light: `<style>
:root{color-scheme:light;--bg:#f8f5f1;--panel:#fffdfb;--panel-2:#f6f2ed;--panel-3:#efeae4;
--border:#e2dbd4;--border-strong:#c5bcb3;--text:#251d19;--text-2:#534b45;--muted:#787069;
--faint:#a39d97;--primary:#af5504;--primary-hover:#993800;--ok:#137d41;--warn:#a56300;
--err:#b3382c;--radius:9px;--radius-sm:6px}
${BASE_CSS}
</style>`,
  dark: `<style>
:root{color-scheme:dark;--bg:#19120e;--panel:#211a16;--panel-2:#2a221d;--panel-3:#342c26;
--border:#372e29;--border-strong:#50453f;--text:#ede7df;--text-2:#c1b9b1;--muted:#928b83;
--faint:#635c56;--primary:#eca342;--primary-hover:#fdbd63;--ok:#63d18f;--warn:#f5b75b;
--err:#f97676;--radius:9px;--radius-sm:6px}
${BASE_CSS}
</style>`,
};

/**
 * id 会被拼进文件路径，这里挡掉分隔符和 `..`。
 *
 * 不限制大小写和点，是为了兼容手工建的目录名；但 `..` 和路径分隔符一律拒绝。
 */
function isSafeId(s) {
  const v = String(s ?? '');
  if (!v || v.length > 64) return false;
  if (v.includes('..') || /[\\/]/.test(v)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v);
}

/**
 * 常量时间比较，避免用响应时间猜密钥。
 * 长度不同直接 false——长度本身不是秘密。
 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * 可视化面板。
 *
 * 默认只监听 127.0.0.1，不对外暴露。
 * 设置 webui.accessKey 后，所有 /api/* 请求需要带 X-Access-Key 头或 ?key=。
 */
export async function startWebServer({
  globalCfg,
  runtimes,
  saveBotConfig,
  saveGlobalConfig,
  onBotAdd,
  onBotRemove,
  onShutdown,
  services = null,
  mock = false,
}) {
  const wc = globalCfg.webui ?? {};

  /**
   * 当前版本号——**每次现读，不能启动时算一次就固定住**。
   *
   * 踩过的坑：以前这里是 `const frameworkVersion = await currentVersion()`，
   * 只算一次。更新会把 package.json 换成新版，但进程要重启才生效，
   * 于是面板显示 0.6.7（启动时的常量）、点「检查更新」却回「已是最新 v0.6.9」
   * （那个是现读文件的）——两个数字来自不同源，用户看到版本号闪一下 0.6.9
   * 又被轮询刷回 0.6.7，以为更新坏了，反复点。
   *
   * 2 秒缓存只为省掉 status 轮询（5 秒一次）每次都碰磁盘，不影响「更新后立刻反映」。
   */
  let verCache = { at: 0, v: '' };
  const versionNow = () => {
    if (verCache.v && Date.now() - verCache.at < 2000) return verCache.v;
    try {
      const raw = fsSync.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
      verCache = { at: Date.now(), v: JSON.parse(raw).version ?? '0.0.0' };
    } catch {
      verCache = { at: Date.now(), v: '0.0.0' };
    }
    return verCache.v;
  };

  if (wc.enabled === false) {
    log.info('可视化面板已禁用（config/bot.json → webui.enabled = false）');
    return null;
  }

  const host = wc.host || '127.0.0.1';
  const port = Number(wc.port) || 15207;
  const accessKey = wc.accessKey || wc.token || '';

  /**
   * 硬阻断：监听非 loopback 却没设 accessKey。
   *
   * 以前只在 doctor 里软告警。`authorized()` 在 accessKey 为空时无条件放行，
   * 于是 `webui.host=0.0.0.0` 且忘设 key 的面板在全部网卡零认证开放——
   * 远程可建/删机器人、改配置、装任意插件（插件代码在子进程执行 = RCE）。
   * 这种误配不该靠人记得去看 doctor，直接在启动期拒绝。
   */
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '']);
  if (!LOOPBACK_HOSTS.has(String(host)) && !accessKey) {
    throw new Error(
      `面板监听 ${host} 但未设置 webui.accessKey。\n` +
        `这样任何人访问该端口都能无认证接管面板（含安装插件=执行任意代码）。\n` +
        `请在 config/bot.json 里设置 webui.accessKey，或把 webui.host 改回 127.0.0.1。`,
    );
  }

  /**
   * 反向代理设置。
   *
   * `trustProxy` 默认关：不开就是不信任任何转发头，客户端自己塞的
   * `X-Forwarded-For` / `X-Forwarded-Host` 一律当不存在（防伪造）。
   * 只有用户明确知道自己在反代后面时才打开。
   */
  const TRUST_PROXY = wc.trustProxy === true;
  const PROXY_HOPS = Math.min(Math.max(Number(wc.trustProxyHops) || 1, 1), 10);

  /**
   * 监听在非 loopback 却没开 trustProxy —— 十有八九是放在 Nginx 后面。
   * 这种情况下所有请求的来源地址都是代理自己，认证失败限速会退化成
   * 「全局一个桶」：别人打 20 次错密钥，你自己也进不来，而且日志里全是代理 IP。
   */
  if (!LOOPBACK_HOSTS.has(String(host)) && !TRUST_PROXY) {
    log.warn(
      `面板监听 ${host} 但未开启 webui.trustProxy。\n` +
        '  如果前面有 Nginx / Caddy / CDN，请设 webui.trustProxy=true（多层再加 trustProxyHops），\n' +
        '  否则限速会按代理地址统计：攻击者发 20 次错误密钥就能让所有人 60 秒进不来。',
    );
  }

  /**
   * 取客户端 IP，用于认证失败限速。
   *
   * 开了 trustProxy 才看 `X-Forwarded-For`，并且**从右往左**数第 `hops` 个：
   * 右边是各级代理自己追加的（可信），左边是客户端可以随便伪造的。
   * 单层反代取最后一个；CDN + Nginx 取倒数第二个，否则拿到的是 CDN 的地址，
   * 所有人又挤回一个桶里，等于白配。
   */
  const clientIp = (req) => {
    if (TRUST_PROXY) {
      const xff = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (xff.length) {
        return xff[Math.max(0, xff.length - PROXY_HOPS)] || xff[xff.length - 1];
      }
    }
    return req.socket?.remoteAddress || 'unknown';
  };

  /**
   * 取「浏览器实际访问的 Host」，用于同源校验。
   *
   * 不处理这个的话：Nginx 默认 `proxy_set_header Host $proxy_host`，转发给面板的
   * Host 是 `127.0.0.1:15207`，而浏览器发来的 Origin 是自己的域名 —— 两者永远不等，
   * 结果面板**所有写操作都 403**（读能用、保存全失败），现象很像权限问题。
   */
  const clientHost = (req) => {
    if (TRUST_PROXY) {
      const xfh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      if (xfh) return xfh;
    }
    return String(req.headers['host'] || '');
  };

  // res -> 这个连接正在看哪个机器人，状态推送时按各自的目标过滤
  const sseClients = new Map();
  /** 同时最多多少个 SSE 连接（一个页面一个） */
  const MAX_SSE = 32;

  /**
   * 按 ?bot=<id> 选机器人，没传就用第一个。
   * 下面每个 handler 开头都会用同名变量把外层的 cfg / plugins / groups … 遮住，
   * 这样 17 个接口的主体逻辑一行都不用改。
   */
  const pickRuntime = (url) => {
    const id = url.searchParams.get('bot');
    if (id) {
      const hit = runtimes.find((r) => r.id === id);
      if (hit) return hit;
    }
    return runtimes[0] ?? null;
  };

  /**
   * 只改「配置里的启用名单」，**不碰运行时**。
   *
   * 和 setPluginEnabled 的区别很重要：
   * 装完插件时只想把它加进名单，然后让 rescan 去加载——
   * 如果这里顺手 load 了，rescan 会发现「已加载」而跳过，added 就是空的，
   * 前端就会误报「插件已安装，但没能自动加载」。
   *
   * @returns {Promise<boolean>} 是否真的改了配置
   */
  const ensurePluginInList = async (rt, id, enabled = true) => {
    const spec = rt?.cfg?.plugins ?? { mode: 'all', list: [] };
    let mode = spec.mode ?? 'all';
    let list = new Set(spec.list ?? []);
    let changed = false;

    if (enabled) {
      if (mode === 'include' && !list.has(id)) {
        list.add(id);
        changed = true;
      } else if (mode === 'exclude' && list.has(id)) {
        list.delete(id);
        changed = true;
      }
    } else if (mode === 'include' && list.has(id)) {
      list.delete(id);
      changed = true;
    } else if (mode === 'exclude' && !list.has(id)) {
      list.add(id);
      changed = true;
    } else if (mode === 'all') {
      // all 模式下禁用单个插件，只能转成「排除名单」
      mode = 'exclude';
      list = new Set([id]);
      changed = true;
    }

    if (!changed) return false;

    rt.cfg.plugins = { ...spec, mode, list: [...list] };
    // filter 是内存里的，不同步的话这次改动不生效
    rt.plugins.filter = pluginFilterOf(rt.cfg.plugins);
    try {
      await saveBotConfig(rt.id, rt.cfg);
    } catch (e) {
      log.warn(`保存插件启用配置失败：${e.message}`);
    }
    return true;
  };

  /**
   * 面板开关 → 改配置 + 真的加载/卸载。
   */
  const setPluginEnabled = async (rt, id, enabled) => {
    await ensurePluginInList(rt, id, enabled);
    return rt.plugins.setEnabled(id, enabled);
  };

  const statusPayload = (rt) => {
    // 每个机器人读自己的指标，多 bot 下不再串台
    const m = rt?.metrics;
    const snap = m
      ? m.snapshot({
          credentialExpiresIn: Math.max(0, Math.round(((rt?.tokens?.expiresAt ?? 0) - Date.now()) / 1000)),
          plugins: rt ? rt.plugins.list() : [],
          cfg: rt?.cfg ?? {},
          botName: rt?.name ?? null,
          // 上下线按钮要看机器人自己的状态：idle / starting / online / offline / error / stopped
          state: rt?.state ?? 'offline',
          // 面板「框架版本」直接显示，不用等用户点「检查更新」才有值
          version: versionNow(),
          startedAt: rt?.startedAt ?? 0,
          uptimeMs: rt?.startedAt ? Date.now() - rt.startedAt : 0,
        })
      : {};

    /**
     * 给「活跃会话」补上名字。
     *
     * perChat 记的是 chatId——群聊是群 openid，私聊是用户 openid。
     * 面板上只显示截断的 openid，用户认不出是哪个群、哪个人。
     * 群名从 rt.groupNames 拿（异步拉的缓存），私聊对象从 recentPeople 拿。
     */
    if (Array.isArray(snap.chats)) {
      const people = rt?.listRecentPeople?.(200) ?? [];
      snap.chats = snap.chats.map((c) => ({
        ...c,
        name:
          c.kind === 'group'
            ? rt?.groupName?.(c.id) ?? ''
            : people.find((p) => p.openid === c.id)?.name ?? '',
      }));
    }
    /**
     * 进程实例标识：前端一看到它变了就知道服务重启过，
     * 页面令牌和会话都已作废，需要立刻重载插件页而不是等下轮轮询。
     */
    snap.instanceId = `${process.pid}-${PROCESS_STARTED_AT}`;
    return snap;
  };

  // 日志实时推送：日志是全局的，所有连接都收到同一份
  const offLog = onLog((entry) => {
    const data = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const [res] of sseClients) {
      /**
       * 背压：write 返回 false 说明对端消费不过来（页面卡住、网络差）。
       * 继续往里塞只会让内存涨，直接断开让它重连。
       */
      if (res.writableLength > 1024 * 1024) {
        sseClients.delete(res);
        try {
          res.destroy();
        } catch {}
        continue;
      }
      try {
        res.write(data);
      } catch {}
    }
  });

  /**
   * 消息实时推送：`event: message`
   *
   * 面板本身不显示聊天内容（那是隐私），但**外部 AI 宿主**需要这一路：
   * dsh-roost 这类插件订阅它，把群消息喂给模型。
   *
   * 推的是规范化后的字段（见 src/message-bus.js），**不含 raw**——
   * 原始事件体里有 `auth_token`，漏出去等于把会话凭据给了订阅者。
   */
  const offMsg = onBusMessage((payload) => {
    if (!sseClients.size) return;
    const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [res, botId] of sseClients) {
      // 客户端可能只盯着某一个机器人，别把别人的消息也塞过去
      if (botId && payload.botId && botId !== payload.botId) continue;
      if (res.writableLength > 1024 * 1024) {
        sseClients.delete(res);
        try {
          res.destroy();
        } catch {}
        continue;
      }
      try {
        res.write(data);
      } catch {}
    }
  });

  const statusTimer = setInterval(() => {
    if (!sseClients.size) return;
    // 每个客户端可能在看不同机器人，各自推各自的
    for (const [res, botId] of sseClients) {
      const rt = runtimes.find((r) => r.id === botId) ?? runtimes[0];
      try {
        res.write(`event: status\ndata: ${JSON.stringify(statusPayload(rt))}\n\n`);
      } catch {}
    }
  }, 2000);
  statusTimer.unref?.();

  /**
   * 鉴权失败计数：per-IP 滑动窗口。
   * timingSafeEqual 只防时序侧信道，挡不住「弱 key 被顺序猜」。
   * 正确 key 不受影响（成功后清零），误伤面很小。
   */
  /**
   * 面板会话：sid -> 过期时间戳。
   *
   * 为什么要有它：accessKey 是长期固定的，挂在 URL 上会进浏览器历史、书签同步、
   * Referer、反向代理 access_log，每一条都是明文泄露面。换成 HttpOnly Cookie 之后，
   * 页面脚本读不到、外链带不出去，而且重启进程就全部作废（等于一键踢掉所有会话）。
   *
   * 只存内存。重启后要重新用带 ?key= 的地址进一次 —— 这是有意为之：
   * 落盘就等于多存一份长期凭据，和「减少凭据扩散」的目标相反。
   */
  const sessions = new Map();
  const SESSION_TTL_MS = 7 * 864e5;
  const sessionTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
  }, 60_000);
  sessionTimer.unref?.();

  const authFails = new Map(); // ip -> { count, start }
  const AUTH_WINDOW = 60_000;
  const AUTH_MAX_FAILS = 20;

  /**
   * 从 URL 上的 `pt` 反查插件页面。
   *
   * 为什么需要它：插件页在 iframe 里是 **opaque origin**（sandbox 不给
   * allow-same-origin），既带不了 Cookie，也带不了 X-Access-Key 头，
   * 唯一的凭证只能挂在地址上。所以给它一把只属于那个页面的随机令牌。
   */
  const pickPageToken = (url) => {
    const pt = url.searchParams.get('pt');
    if (!pt) return null;
    for (const r of runtimes) {
      const hit = r?.plugins?.pages?.findByToken?.(pt);
      if (hit) return hit;
    }
    return null;
  };

  /**
   * 页面令牌能碰哪些路径 —— **最小权限**，不是「只读」。
   *
   * 只放行这个插件自己的入口：
   *   /api/pages/<插件id>:<key>/html   iframe 载入页面本体
   *   /api/plugins/<插件id>/panel      面板数据（dice 的战绩就是这么取的）
   *   /api/plugins/<插件id>/r/*        插件自己的路由（斗罗后台全在这一层）
   *   /api/status                      只读状态
   *
   * **方法不限制**。斗罗那种运营后台要 POST/PATCH 改数据，只给 GET 会直接
   * 把它废掉；而「限制插件写自己的数据」没有安全收益 —— 插件本来就有子进程
   * 执行权。真正的边界是**不让它碰面板接口**：/api/config、/api/logs、
   * /api/bots、/api/qq/call 一个都不在名单里。
   */
  const pageTokenAllows = (pathname, ptPage) => {
    const id = String(ptPage?.pluginId ?? '');
    if (!id) return false;
    if (pathname === `/api/pages/${ptPage.key}/html`) return true;
    if (pathname === `/api/plugins/${id}/panel`) return true;
    if (pathname.startsWith(`/api/plugins/${id}/r/`)) return true;
    if (pathname === '/api/status') return true;
    return false;
  };

  const authorized = (req, url, ptPage = null) => {
    if (!accessKey) return true;

    // 插件页面令牌：不是面板密钥，权限由 pageTokenAllows() 再收一道
    if (ptPage) return true;

    /**
     * 会话 Cookie —— 浏览器正常路径都走这里。
     *
     * 只在正则上限制 64 位十六进制是防「畸形 cookie 撑爆 Map」，
     * 不是安全边界；真正的校验是下面查表 + 过期判断。
     */
    const cookie = String(req.headers.cookie || '');
    const sid = /(?:^|;\s*)roost_sid=([a-f0-9]{64})/.exec(cookie)?.[1];
    if (sid) {
      const exp = sessions.get(sid);
      if (exp && exp > Date.now()) return true;
      sessions.delete(sid);
    }

    const ip = clientIp(req);
    const now = Date.now();
    const rec = authFails.get(ip);
    if (rec && now - rec.start < AUTH_WINDOW && rec.count >= AUTH_MAX_FAILS) {
      /**
       * 锁定期要留痕。以前这里直接 `return false` 一句话都没有，
       * 于是管理员只看到「访问密钥无效」，分不清是自己敲错还是有人在打，
       * 也拿不到来源 IP。
       */
      log.error(`面板认证失败次数过多，已临时封禁 ${ip}（${Math.ceil((AUTH_WINDOW - (now - rec.start)) / 1000)} 秒后解除）`);
      return false;
    }
    // 兼容旧的 X-Token / ?token= 写法
    const given =
      req.headers['x-access-key'] ||
      req.headers['x-token'] ||
      url.searchParams.get('key') ||
      url.searchParams.get('token');
    const ok = safeEqual(given, accessKey);
    if (ok) {
      authFails.delete(ip);
    } else {
      const cur = rec && now - rec.start < AUTH_WINDOW ? rec : { count: 0, start: now };
      cur.count += 1;
      authFails.set(ip, cur);
      // 记失败但不记密钥本身：只记来源与累计次数
      log.warn(`面板认证失败：来源 ${ip}，本窗口第 ${cur.count} 次`);
      if (authFails.size > 5000) authFails.clear(); // 防内存膨胀
    }
    return ok;
  };

  /**
   * 写操作必须是 `application/json`，而且是**精确匹配**。
   *
   * 以前用 `ct.includes('application/json')`：跨站页面发
   * `Content-Type: text/plain;application/json` 就能绕过——
   * MIME 本质仍是 text/plain，浏览器不预检，服务端却以为它是 JSON。
   */
  const isJsonRequest = (req) => {
    const ct = String(req.headers['content-type'] || '');
    return ct.split(';')[0].trim().toLowerCase() === 'application/json';
  };

  /**
   * 同源校验：带了 Origin / Referer 就必须是本站。
   *
   * 端口不固定（会自动顺延），所以只比 host 部分。
   */
  const isSameOrigin = (req, ptPage = null) => {
    /**
     * 插件页的例外：sandbox 不给 allow-same-origin 之后，它就是 opaque origin，
     * 发请求时 `Origin` 恒为字符串 `"null"`，new URL('null') 会抛错 → 当跨站拒掉。
     *
     * 只对「带有效页面令牌」的请求放行，而且这类请求的路径已经被
     * pageTokenAllows() 限死在该插件自己的接口上。没有 pt 的 `Origin: null`
     * 依旧按跨站处理。
     */
    if (ptPage && String(req.headers.origin || '') === 'null') return true;

    // 反代场景下要用 X-Forwarded-Host，不能直接看 req.headers.host：
    // Nginx 默认把 Host 改写成 $proxy_host，与浏览器的 Origin 永远不等。
    const host = clientHost(req);
    for (const h of ['origin', 'referer']) {
      const v = req.headers[h];
      if (!v) continue;
      try {
        const o = new URL(String(v));
        if (o.host !== host) return false;
      } catch {
        return false; // 畸形 Origin 一律当跨站
      }
    }
    return true;
  };

  /**
   * 把机器人显示名同步成官方昵称。
   *
   * 全新安装时配置里的名字是「默认机器人」这种占位符，填完 AppID / AppSecret
   * 之后没人会记得回来改它，面板上就一直显示占位名。所以保存凭证时顺手调一次
   * /users/@me 拿真实昵称。
   *
   * 只在占位名（空 / 等于 id / 「默认机器人」）时替换——用户自己起过的名字不动。
   * 拉取失败不影响配置保存，只记一条 warn。
   */
  const PLACEHOLDER_NAME = /^(默认机器人|未命名|新机器人)$/;
  const syncBotName = async (r) => {
    if (!r || r.mock || !r.cfg.appId || !r.cfg.appSecret) return null;
    const cur = String(r.name ?? '').trim();
    if (cur && cur !== r.id && !PLACEHOLDER_NAME.test(cur)) return null;

    try {
      const me = await r.api.getMe();
      const nick = String(me?.username ?? me?.nickname ?? '').trim();
      if (!nick || nick === r.name) return null;
      r.name = nick;
      r.cfg.name = nick;
      await saveBotConfig(r.id, r.cfg);
      log.info(`机器人昵称已同步为「${nick}」`);
      return nick;
    } catch (e) {
      log.warn(`拉取机器人昵称失败（不影响使用）：${e.message}`);
      return null;
    }
  };

  /* ---------------- 插件更新检查 ---------------- */

  /**
   * 更新检查结果按机器人缓存。插件**代码**是全局共享的，但启用状态 per-bot，
   * 所以每个机器人看到的「可更新」可能不同，缓存也跟着分。
   *
   * 注意这些必须放在 startWebServer 作用域：以前它们写在请求处理器里，
   * 每个 /api/* 请求都会新建一个 Map 和一个 1 小时的 interval，永不回收。
   */
  const updateCache = new Map(); // botId -> { at, updates, error }
  const UPDATE_CACHE_MS = 5 * 60 * 1000;

  /**
   * 对照插件市场，看这个机器人有哪些插件能更新。
   * 只检查不安装——安装会覆盖本地目录，必须用户点。
   */
  const checkUpdates = async (r, { force = false } = {}) => {
    if (!r) return { at: 0, updates: [], error: '没有可用的机器人' };
    const hit = updateCache.get(r.id);
    if (hit && !force && Date.now() - hit.at < UPDATE_CACHE_MS) return hit;

    const out = { at: Date.now(), updates: [], error: '' };
    try {
      const idx = await fetchIndex(globalCfg.plugins?.marketUrl || undefined);
      const localVers = await r.plugins.localVersions();
      out.updates = detectUpdates(idx.plugins, localVers).map((u) => ({
        id: u.id,
        current: u.current,
        latest: u.latest,
        name: u.entry.name ?? u.id,
      }));
      if (out.updates.length) {
        log.info(
          `[${r.id}] 插件市场有 ${out.updates.length} 个更新：` +
            out.updates.map((u) => `${u.id} ${u.current}→${u.latest}`).join('、'),
        );
      }
    } catch (e) {
      // 连不上市场是常事（离线、代理、限流），不该刷错误日志
      out.error = e.message;
    }
    updateCache.set(r.id, out);
    return out;
  };

  /**
   * 插件更新 / 卸载之后，把已经生效的 id 从「可更新」缓存里摘掉。
   *
   * 缓存 5 分钟是为了少打几次市场接口，但更新完前端会立刻再拉一次
   * `/api/plugins/updates`——命中旧缓存就继续显示「可更新 x.y.z」和
   * 「N 个插件有新版本」，看着像没更新成功，得等 5 分钟才消失。
   *
   * 插件**代码**是全局共享的，所以每个机器人的缓存都要摘，不只是当前这个。
   */
  const forgetUpdates = (ids) => {
    const drop = new Set((ids || []).filter(Boolean).map(String));
    if (!drop.size) return;
    for (const [botId, hit] of updateCache) {
      const before = hit.updates || [];
      const left = before.filter((u) => !drop.has(u.id));
      if (left.length === before.length) continue;
      updateCache.set(botId, { ...hit, updates: left });
    }
  };

  // 启动后过一会儿查一次，别拖慢启动；之后每小时一次。
  // 60 秒是有意的：启动瞬间面板、插件、市场可能都在拉数据，
  // 再叠一个 GitHub 请求容易一起超时。fetchIndex 内部也有并发去重兜底。
  const updateTimer = setInterval(() => {
    for (const r of runtimes) checkUpdates(r).catch(() => {});
  }, 60 * 60 * 1000);
  updateTimer.unref?.();

  setTimeout(() => {
    for (const r of runtimes) checkUpdates(r).catch(() => {});
  }, 60000).unref?.();

  const server = http.createServer(async (req, res) => {
    /**
     * 安全响应头：面板一旦反代到公网，这几条是浏览器侧的最后一道。
     *
     * `Referrer-Policy: no-referrer` 尤其重要——它顺手堵掉「点面板里的外链
     * 把 URL 上的密钥带到别人服务器」那条路（GitHub/Gitee 链接就在面板里）。
     */
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP_MAIN);

    /**
     * URL 解析必须在 try 里面。
     *
     * 以前这两行在 try 外面：`GET /%` 会让 decodeURIComponent 抛 URIError，
     * `Host: [` 会让 new URL 抛 ERR_INVALID_URL。都在 async 回调里 → 未捕获
     * rejection → Node 22+ 直接退出进程。一张网页的 <img src=".../%E0%A4%A">
     * 就能把面板和所有机器人一起打掉。
     */
    let url;
    let pathname;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return json(res, 400, { error: '请求地址不合法' });
    }

    /**
     * 首跳把 `?key=` 换成会话 Cookie，然后 302 到干净地址。
     *
     * 只对**页面导航**这么做（`/api/` 不动）：脚本类调用方（roost-mcp 这类）
     * 还在用 `?key=` 直连接口，一刀切会让它们全挂。等它们改成 X-Access-Key 头
     * 再收掉 query 分支。
     *
     * 换成 Cookie 之后浏览器地址栏、历史记录、书签同步里就没有密钥了，
     * 而 Cookie 是 HttpOnly，页面脚本读不到。
     */
    if (!pathname.startsWith('/api/')) {
      const qKey = url.searchParams.get('key') || url.searchParams.get('token');
      if (qKey && accessKey && safeEqual(qKey, accessKey)) {
        const sid = crypto.randomBytes(32).toString('hex');
        sessions.set(sid, Date.now() + SESSION_TTL_MS);
        const rest = new URLSearchParams(url.search);
        rest.delete('key');
        rest.delete('token');
        const qs = rest.toString();
        // 用 url.pathname（原始编码形式）而不是解码后的，否则带 %2F 的路径会被改坏
        res.writeHead(302, {
          'Set-Cookie': `roost_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(
            SESSION_TTL_MS / 1000,
          )}`,
          Location: url.pathname + (qs ? `?${qs}` : ''),
        });
        return res.end();
      }
    }

    /**
     * 面板首页的「没凭证」提示。
     *
     * 会话改成 Cookie 之后，最常见的新问题是「书签里的地址没有 key 了，打开一片空白」。
     * 静态文件本身不鉴权（也不该鉴权，不然 CSS/JS 都拿不到），但首页可以给一句人话，
     * 而不是让用户对着空面板怀疑是不是坏了。
     */
    if ((pathname === '/' || pathname === '/index.html') && accessKey) {
      const ck = String(req.headers.cookie || '');
      const sid0 = /(?:^|;\s*)roost_sid=([a-f0-9]{64})/.exec(ck)?.[1];
      const exp0 = sid0 ? sessions.get(sid0) : 0;
      if (!exp0 || exp0 <= Date.now()) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(
          '<!doctype html><meta charset="utf-8"><title>需要访问密钥</title>' +
            '<body style="font:15px/1.6 system-ui;max-width:34em;margin:14vh auto;padding:0 1.2em">' +
            '<h1 style="font-size:18px">需要访问密钥</h1>' +
            '<p>面板已开启访问密钥，但当前浏览器还没有会话（进程重启后会话会全部失效）。</p>' +
            '<p>请用带密钥的地址打开一次，之后会在浏览器里记住 7 天：</p>' +
            '<pre style="background:rgba(128,128,128,.14);padding:10px 12px;border-radius:6px;overflow:auto">' +
            `http://${shownHost}:${actualPort}/?key=你的密钥</pre>` +
            '<p style="opacity:.65;font-size:13px">密钥在 config/bot.json 的 webui.accessKey，或启动时设置的环境变量里。</p>',
        );
      }
    }

    try {
      /**
       * 健康检查端点（**不鉴权**）。
       *
       * 为什么必须免鉴权：Docker 的 healthcheck 以前探 `/api/status`，而配了
       * `accessKey` 之后那个接口恒返 401 —— 容器永久 unhealthy。反过来不配 key
       * 时，机器人明明掉线了它照样报健康。两个方向都是错的。
       *
       * 返回什么：进程活着、且至少有一个机器人是 online 才算 200。
       * 全掉线就 503，让监控一眼看出「面板在、但机器人没连上」。
       *
       * 只给 id / state / 计数，不给 botName（可能是群里的昵称，不该对匿名请求暴露）。
       *
       * 注意：Docker 的 healthcheck 只是打标记，**不会**因此重启容器
       * （重启只由 restart 策略在进程退出时触发），所以不会变成重启循环。
       */
      if (pathname === '/healthz') {
        const bots = runtimes.map((r) => ({ id: r?.id ?? '', state: r?.state ?? 'offline' }));
        const online = bots.filter((b) => b.state === 'online').length;
        const ok = bots.length === 0 ? true : online > 0;
        res.writeHead(ok ? 200 : 503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(
          JSON.stringify({
            ok,
            bots,
            online,
            total: bots.length,
            uptime: Math.round(process.uptime()),
          }),
        );
      }

      // ---------------- API ----------------
      if (pathname.startsWith('/api/')) {
        const ptPage = pickPageToken(url);

        /**
         * 插件页是 opaque origin（跨源），浏览器要求响应带 CORS 头才肯把内容
         * 交给页面。只在带有效 pt 时回，且回 `null` —— 这只匹配 opaque origin，
         * 普通网页拿到的 `Access-Control-Allow-Origin: null` 与自己的 Origin
         * 不相等，仍然读不到。
         */
        if (ptPage && String(req.headers.origin || '') === 'null') {
          res.setHeader('Access-Control-Allow-Origin', 'null');
          res.setHeader('Vary', 'Origin');
        }

        /**
         * CORS 预检直接答，**不要先认令牌**。
         *
         * 这里踩过一次：原来写成 `if (ptPage && req.method === 'OPTIONS')`，
         * 于是「令牌没认出来」的预检会继续往下走，撞到「写操作必须
         * application/json」那道闸门 —— 预检没有 body，于是回 415，
         * 浏览器判定预检失败，页面拿到的是 `Failed to fetch`。
         *
         * 而插件页里 `fetch` 只要带了 `Content-Type: application/json`
         * （斗罗对所有请求都带），连 GET 都会触发预检，所以这个坑表现为
         * 「页面渲染正常、数据一条都没有」。
         *
         * 预检不返回任何数据，谁来问都答 204 即可，不需要鉴权。
         */
        if (req.method === 'OPTIONS') {
          const origin = String(req.headers.origin || '');
          /**
           * 允许的头**回显浏览器要的那个**，不写死。
           *
           * 踩过的坑：原来写死 `Content-Type`，看着没错，但浏览器报的是
           * 「Request header field content-type is not allowed by
           * Access-Control-Allow-Headers in preflight response」。
           * 回显 `Access-Control-Request-Headers` 就永远不会对不上 ——
           * 它问什么我给什么，反正是插件页自己的只读请求。
           *
           * **不要加 `Access-Control-Max-Age`**：加了浏览器会把这次预检结果
           * 缓存好几分钟，一旦某次响应是错的（或者服务端刚改过逻辑），
           * 后面再改代码都没用 —— 浏览器压根不会重新来问，只会一直报同一个错，
           * 排查时会以为是代码没生效。本地面板的预检几乎没有开销，不值得缓存。
           */
          const wantHeaders = String(req.headers['access-control-request-headers'] || '');
          res.writeHead(204, {
            ...(origin === 'null' ? { 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' } : {}),
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': wantHeaders || 'Content-Type, X-Access-Key, X-Token',
          });
          return res.end();
        }

        if (!authorized(req, url, ptPage)) return json(res, 401, { error: '访问密钥无效' });

        /**
         * 页面令牌的权限闸门：**紧跟着鉴权做**，不能放到路由里。
         * 否则拿到任意插件页 token 就能调 /api/config、/api/logs。
         */
        if (ptPage && !pageTokenAllows(pathname, ptPage)) {
          return json(res, 403, { error: '插件页面无权访问这个接口' });
        }

        /**
         * CSRF / 同源校验必须在**路由之前**。
         *
         * 以前它写在 /api/bots 那几个路由后面，于是「新建机器人」「删除机器人」
         * 完全不受保护——跨站页面一个 text/plain 表单就能把它们打出去。
         */
        if (req.method !== 'GET' && req.method !== 'HEAD' && !isJsonRequest(req)) {
          /**
           * 这里以前完全静默 —— 而它恰恰是「插件页一片空白」最可能的入口：
           * CORS 预检（OPTIONS）没有 body，如果哪天 OPTIONS 分支漏了或顺序错了，
           * 预检就会掉进这里拿 415，浏览器判定预检失败，页面只看到
           * `TypeError: Failed to fetch`，服务端一条日志都没有，排查全靠猜。
           */
          log.warn(
            `拒绝写操作：${req.method} ${pathname}` +
              `（Content-Type: ${req.headers['content-type'] || '无'}，需要 application/json）`,
          );
          return json(res, 415, { error: '写操作需要 Content-Type: application/json' });
        }
        if (!isSameOrigin(req, ptPage)) {
          /**
           * 这里踩过一个很隐蔽的坑：插件页是 opaque origin，请求 `Origin` 恒为
           * 字符串 `null`。它发的请求如果没带有效 `pt`（比如面板重启后 iframe
           * 还拿着旧令牌），就会落到这个分支。
           *
           * 两个后果叠加，导致排查极其困难：
           *   1. 403 响应没带 CORS 头 → 浏览器不给页面读状态码，页面只看到
           *      `TypeError: Failed to fetch`，看起来像网络断了或服务没起
           *   2. 这里不写日志 → 服务端一条记录都没有，像是请求根本没到
           *
           * 所以：给 opaque origin 补上 CORS 头（让它能读到 403 和错误文案），
           * 并且**一定要留一条 warn**。没带令牌的情况单独说清楚，否则下次
           * 还是得靠猜。
           */
          if (String(req.headers.origin || '') === 'null') {
            res.setHeader('Access-Control-Allow-Origin', 'null');
            res.setHeader('Vary', 'Origin');
          }
          log.warn(
            `拒绝跨站请求：${req.method} ${pathname}` +
              `（Origin: ${req.headers.origin || '无'}${ptPage ? '，页面令牌有效' : '，无有效页面令牌'}）`,
          );
          return json(res, 403, { error: '跨站请求被拒绝' });
        }

        // 选中要操作的机器人，并用同名变量遮住外层的聚合对象，
        // 这样下面所有 handler 的写法都不用变
        const rt = pickRuntime(url);

        /* ---------------- 官方能力通道（给 AI 宿主 / 外部工具用） ---------------- */

        /**
         * 能力清单：哪些官方接口能调、风险等级、限制。
         * 静态表，跟当前选中哪个机器人无关。
         */
        if (pathname === '/api/qq/capabilities' && req.method === 'GET') {
          return json(res, 200, capabilityPayload());
        }

        /**
         * 通用调用：`POST /api/qq/call { bot?, method, args, confirm? }`
         *
         * 白名单和风险分级都在 qq-call.js 里，这里只负责把请求递过去。
         * 能走到这里说明已经过了 authorized() + CSRF + 同源校验，
         * 跟面板其他写接口一个待遇。
         */
        if (pathname === '/api/qq/call' && req.method === 'POST') {
          let body;
          try {
            body = await readBody(req);
          } catch (e) {
            return json(res, 400, { ok: false, error: e.message });
          }
          const out = await handleQqCall({ runtimes, body, fallbackRuntime: rt, log });
          return json(res, out.code, out.body);
        }

        /**
         * mock 模式下注入一条群消息，用来在面板里手工试插件 / 验证消息推送。
         *
         * **只在 `rt.mock` 时存在**：真实机器人上这条路由直接 404，
         * 不会变成「谁都能伪造一条群消息」的后门。
         *
         * 为什么需要它：`--mock --serve` 时 mock 的 stdin 交互是不启用的
         * （那条路径只跑面板），所以没有别的方式从外部喂一条消息进来。
         */
        if (pathname === '/api/mock/message' && req.method === 'POST') {
          if (!rt?.mock) return json(res, 404, { error: '只有 mock 模式能用' });
          const b = await readBody(req);
          const text = String(b?.text ?? '').trim();
          if (!text) return json(res, 400, { error: '缺 text' });
          await rt.dispatch('GROUP_AT_MESSAGE_CREATE', {
            id: `mock-inject-${Date.now()}`,
            content: text,
            group_openid: String(b?.groupId ?? 'mock-group'),
            author: {
              member_openid: String(b?.userId ?? 'mock-user'),
              username: String(b?.userName ?? '测试用户'),
            },
            timestamp: String(Date.now()),
          });
          return json(res, 200, { ok: true });
        }

  /* ---------------- 机器人管理（不依赖当前选中项） ---------------- */

        if (pathname === '/api/bots' && req.method === 'GET') {
          const ids = await listBotIds();
          const list = ids.map((id) => {
            const r = runtimes.find((x) => x.id === id);
            return {
              id,
              name: r?.name ?? id,
              state: r?.state ?? 'not-loaded',
              online: Boolean(r?.online),
              appId: r?.cfg.appId ?? '',
              plugins: r?.plugins ? r.plugins.loaded.size : 0,
              enabled: r ? true : false,
              error: r?.lastError ?? '',
            };
          });
          return json(res, 200, { bots: list, current: rt?.id ?? null });
        }

        /**
         * 扫码建机器人：两步（建任务 / 轮询）。
         *
         * bindKey 是解 AppSecret 的密钥，**只在服务端留着**，
         * 下发出去等于把密钥给了浏览器，没必要。
         * 任务 10 分钟后自动清掉，免得 Map 无限涨。
         */
        if (pathname === '/api/bots/qr/start' && req.method === 'POST') {
          for (const [k, v] of qrTasks) {
            if (Date.now() - v.at > 10 * 60_000) qrTasks.delete(k);
          }
          try {
            const t = await createBindTask();
            qrTasks.set(t.taskId, { bindKey: t.bindKey, at: Date.now() });
            // qrSvg 给不装 QR 库的调用方（比如 dsh-roost 面板）直接用
            let qrSvg = '';
            try {
              qrSvg = qrToSvg(t.qrUrl);
            } catch {}
            return json(res, 200, { taskId: t.taskId, qrUrl: t.qrUrl, qrSvg });
          } catch (e) {
            return json(res, 502, { error: e.message });
          }
        }

        if (pathname === '/api/bots/qr/poll' && req.method === 'POST') {
          const body = await readBody(req);
          const taskId = String(body.taskId ?? '').trim();
          const rec = qrTasks.get(taskId);
          if (!rec) return json(res, 400, { error: '这个二维码已经失效了，重新生成一个' });
          try {
            const r = await pollBindResult({ taskId, bindKey: rec.bindKey });
            // 有结论就把任务删掉，别让它一直轮询
            if (r.status !== 'pending') qrTasks.delete(taskId);
            return json(res, 200, r);
          } catch (e) {
            return json(res, 502, { error: e.message });
          }
        }

        if (pathname === '/api/bots' && req.method === 'POST') {
          if (!onBotAdd) return json(res, 501, { error: '当前模式不支持新建机器人' });
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
            return json(res, 400, {
              error: 'id 只能用小写字母、数字、下划线、短横线，1–32 位，且不能以符号开头',
            });
          }
          if ((await listBotIds()).includes(id)) {
            return json(res, 409, { error: `机器人 ${id} 已存在` });
          }
          try {
            const created = await onBotAdd(id, {
              name: String(body.name ?? '').trim() || id,
              appId: String(body.appId ?? '').trim(),
              appSecret: String(body.appSecret ?? '').trim(),
            });
            // 没填显示名时用官方昵称补上
            const name = await syncBotName(created);
            return json(res, 200, { ok: true, id, name: name ?? created?.name ?? id, state: created?.state ?? 'unknown' });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        if (pathname === '/api/bots/delete' && req.method === 'POST') {
          if (!onBotRemove) return json(res, 501, { error: '当前模式不支持删除机器人' });
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { error: '缺少 id' });
          // 和新建用同一个规则：id 会被拼进路径，还跟着递归删除，不能放行 `..`
          if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
            return json(res, 400, { error: 'id 格式不合法' });
          }
          if (runtimes.length <= 1 && runtimes.some((r) => r.id === id)) {
            return json(res, 400, { error: '这是最后一个机器人，删掉就没得跑了' });
          }
          try {
            await onBotRemove(id, { purge: body.purge !== false });
            return json(res, 200, { ok: true });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        if (!rt) return json(res, 503, { error: '没有可用的机器人' });
        const cfg = rt.cfg;
        const plugins = rt.plugins;
        const groups = rt.groups;
        const roles = rt.roles;
        const api = rt.api;
        const tokens = rt.tokens;
        const getGateway = () => rt.gateway;

        /* ---------------- 上下线 ---------------- */

        // 面板的上下线按钮。只动网关连接，不卸载插件、不清存档
        const bo = pathname.match(/^\/api\/bots\/([^/]+)\/(online|offline)$/);
        if (bo && req.method === 'POST') {
          const target = runtimes.find((r) => r.id === decodeURIComponent(bo[1]));
          if (!target) return json(res, 404, { error: '没有这个机器人' });
          try {
            const state =
              bo[2] === 'online' ? await target.goOnline() : await target.goOffline();
            return json(res, 200, {
              ok: state === 'online' || state === 'offline',
              state,
              online: target.online,
              error: target.lastError || '',
            });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        // 状态
        if (pathname === '/api/status' && req.method === 'GET') {
          return json(res, 200, statusPayload(rt));
        }

        // 配置读取（隐藏密钥）
        if (pathname === '/api/config' && req.method === 'GET') {
          return json(res, 200, {
            ...cfg,
            // webui 和 logLevel 是**全局**设置（config/bot.json），所有机器人共用，
            // 不在这台机器人的 cfg 里。不返回的话面板永远显示默认值，
            // 用户改完也看不出当前是什么。
            // 访问密钥不回显（和 appSecret 一个待遇），只告诉面板「设过没」
            webui: {
              ...(globalCfg.webui ?? {}),
              accessKey: '',
              accessKeySet: Boolean(globalCfg.webui?.accessKey),
            },
            logLevel: globalCfg.logLevel ?? 'info',
            appSecret: cfg.appSecret ? '********' : '',
            appSecretSet: Boolean(cfg.appSecret),
          });
        }

        // 配置保存
        if (pathname === '/api/config' && req.method === 'PUT') {
          const body = await readBody(req);
          const before = JSON.stringify({ appId: cfg.appId, intents: cfg.intents });
          const oldSecret = cfg.appSecret;

          if (typeof body.appId === 'string') cfg.appId = body.appId.trim();
          // 密钥留空或仍是掩码时保持原值
          if (typeof body.appSecret === 'string' && body.appSecret && body.appSecret !== '********') {
            cfg.appSecret = body.appSecret.trim();
          }
          /**
           * baseUrl 必须校验，否则这里等于「把 access_token 送人」的开关。
           *
           * `api.js` 用这个 baseUrl 拼请求，并带上 `Authorization: QQBot <token>`。
           * 面板一旦被改成第三方地址，下一次 API 调用就把机器人令牌发到那台机器，
           * 拿到令牌就能冒充机器人在它所在的任何群里发消息 —— 面板弱口令会因此
           * 直接升级成「机器人身份被完全接管」。
           *
           * 用 `*.qq.com` 而不是写死 `api.sgroup.qq.com`：官方历史上用过
           * `api.bot.qq.com` 这类别名（现有配置里就有），写死会把用户自己的
           * 合法配置挡回去。qq.com 是腾讯的域，第三方拿不到子域。
           */
          if (body.baseUrl !== undefined && body.baseUrl !== '') {
            let u = null;
            try {
              u = new URL(String(body.baseUrl).trim());
            } catch {
              return json(res, 400, { error: 'baseUrl 不是合法 URL' });
            }
            const host = u.hostname.toLowerCase();
            const official = host === 'qq.com' || host.endsWith('.qq.com');
            if (u.protocol !== 'https:' || !official) {
              return json(res, 400, {
                error:
                  'baseUrl 只允许 https 的腾讯官方域名（如 https://api.sgroup.qq.com）。\n' +
                  '改成第三方地址会把 access_token 发过去，等于交出机器人身份。',
              });
            }
            cfg.baseUrl = u.origin;
          }
          if (body.intents !== undefined) {
            const n = Number(body.intents);
            if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) {
              return json(res, 400, { error: 'intents 必须是 0 ~ 2147483647 的整数' });
            }
            cfg.intents = n;
          }
          if (body.commandPrefix) cfg.commandPrefix = body.commandPrefix;
          if (Array.isArray(body.owners)) cfg.owners = body.owners.map((s) => String(s).trim()).filter(Boolean);
          if (body.logLevel) {
            globalCfg.logLevel = body.logLevel;
            setLevel(body.logLevel);
            await saveGlobalConfig?.(globalCfg).catch(() => {});
            configureMirror(globalCfg);
          }
          if (body.whitelist && typeof body.whitelist === 'object') {
            cfg.whitelist = {
              enabled: Boolean(body.whitelist.enabled),
              groups: (body.whitelist.groups ?? []).map(String).filter(Boolean),
              users: (body.whitelist.users ?? []).map(String).filter(Boolean),
            };
          }
          if (body.rateLimit && typeof body.rateLimit === 'object') {
            cfg.rateLimit = {
              enabled: Boolean(body.rateLimit.enabled),
              perChatPerMinute: Math.max(1, Number(body.rateLimit.perChatPerMinute) || 30),
            };
          }
          if (body.dedupWindowSec !== undefined) {
            cfg.dedupWindowSec = Math.max(0, Number(body.dedupWindowSec) || 0);
          }
          /**
           * 连接方式：面板一直在提交这个字段，但服务端从来没读过——
           * 用户选「Webhook」保存后毫无变化、也没有任何提示，以为已经切了。
           */
          let connectionChanged = false;
          if (body.connection && typeof body.connection === 'object') {
            const mode = String(body.connection.mode || 'websocket').trim();
            if (mode !== 'websocket' && mode !== 'webhook') {
              return json(res, 400, { error: 'connection.mode 只能是 websocket 或 webhook' });
            }
            if ((cfg.connection?.mode ?? 'websocket') !== mode) connectionChanged = true;
            cfg.connection = { ...(cfg.connection ?? {}), mode };
          }
          if (body.messageLog && typeof body.messageLog === 'object') {
            cfg.messageLog = {
              enabled: body.messageLog.enabled !== false,
              muteKinds: Array.isArray(body.messageLog.muteKinds)
                ? body.messageLog.muteKinds.filter((k) => ['group', 'c2c', 'guild', 'dm'].includes(k))
                : [],
            };
          }
          if (body.webui && typeof body.webui === 'object') {
            // webui 是全局设置，不能写进机器人 cfg：
            // 写进去 saveBotConfig 也不保存它（白名单式保存），
            // 结果是面板提示「已保存」但什么都没变。
            const patch = { ...body.webui };
            // 面板不回显密钥，所以空值代表「不修改」，不是「清空」
            if (!patch.accessKey) delete patch.accessKey;
            delete patch.accessKeySet;
            globalCfg.webui = { ...globalCfg.webui, ...patch };
            await saveGlobalConfig?.(globalCfg).catch(() => {});
            configureMirror(globalCfg);
          }
          // 群管内邀开关：同步给 api 层，否则要等重启才生效
          if (body.groupManage && typeof body.groupManage === 'object') {
            cfg.groupManage = { invited: Boolean(body.groupManage.invited) };
            rt.api?.setGroupInvited?.(cfg.groupManage.invited);
          }

          await saveBotConfig(rt.id, cfg);
          log.info('配置已通过面板更新');

          const after = JSON.stringify({ appId: cfg.appId, intents: cfg.intents });
          // 凭证变了要让 token 管理器跟着换，否则还在用旧 AppID 的 access_token
          if (cfg.appSecret !== oldSecret) {
            if (tokens) {
              tokens.appSecret = cfg.appSecret;
              tokens.token = '';
              tokens.expiresAt = 0;
            }
          }
          if (before !== after) {
            if (tokens && tokens.appId !== cfg.appId) {
              tokens.appId = cfg.appId;
              tokens.token = '';
              tokens.expiresAt = 0;
            }
            log.info('连接参数变化，正在重连网关...');
            rt.gateway?.restart?.().catch(() => {});
          }

          // 填完 AppID / AppSecret 顺手把「默认机器人」换成官方昵称
          const name = await syncBotName(rt);
          return json(res, 200, {
            ok: true,
            name: name ?? rt.name,
            // 换了连接方式必须重启才生效，明确告诉前端，别让用户以为已经切了
            ...(connectionChanged
              ? {
                  restartRequired: true,
                  message:
                    '连接方式已保存，需要重启程序才生效' +
                    (cfg.connection?.mode === 'webhook' && !globalCfg.webhook?.enabled
                      ? '；注意全局 webhook.enabled 还是 false，Webhook 服务没开'
                      : ''),
                }
              : {}),
          });
        }

        // 插件
        if (pathname === '/api/plugins' && req.method === 'GET') {
          return json(res, 200, plugins.list());
        }

        /**
         * 统计概览：消息量、活跃人数、命令排行、会话排行。
         * ?days=7 控制窗口（1~365）。SQLite 不可用时返回 available:false，
         * 面板据此显示「统计不可用」而不是画一堆 0。
         */
        if (pathname === '/api/stats' && req.method === 'GET') {
          /**
           * `days` 必须夹紧。同文件下面的 `/api/stats/export` 早就 clamp 到
           * 1~365 了，这里漏了 —— 传个极大值就能让 SQLite 扫全表，
           * 面板上一次点击就变成一次自伤式 DoS。
           */
          const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 7));
          try {
            return json(res, 200, rt.stats?.overview(days) ?? { available: false });
          } catch (e) {
            return json(res, 500, { error: e.message, available: false });
          }
        }

        /**
         * 导出 CSV。
         *
         * 导的是**汇总**（按天 / 按会话 / 按命令），不是逐条明细——
         * 明细带 openid 和时间戳，做表格分析用不上那么细，还会把隐私带出去。
         * 开头加 BOM，Excel 打开中文才不乱码。
         */
        if (pathname === '/api/stats/export' && req.method === 'GET') {
          const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
          const data = rt.stats?.exportSummary?.(days) ?? { daily: [], chats: [], commands: [] };
          const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
          const lines = [
            `# 栖 Roost 统计导出（最近 ${days} 天）`,
            '',
            '日期,消息数,命令数,活跃会话',
            ...data.daily.map((r) => [r.day, r.messages, r.commands, r.chats].map(q).join(',')),
            '',
            '场景,会话,消息数,命令数',
            ...data.chats.map((r) => [r.scope, r.chatId, r.messages, r.commands].map(q).join(',')),
            '',
            '命令,次数',
            ...data.commands.map((r) => [r.name, r.count].map(q).join(',')),
          ];
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="roost-stats-${rt.id}-${days}d.csv"`,
            'Cache-Control': 'no-store',
          });
          return res.end(`\ufeff${lines.join('\n')}\n`);
        }

        // 最近消息（不含正文，只有时间/会话/是否命令）
        if (pathname === '/api/stats/recent' && req.method === 'GET') {
          const limit = Number(url.searchParams.get('limit')) || 50;
          try {
            return json(res, 200, rt.stats?.recent(limit) ?? []);
          } catch (e) {
            return json(res, 500, { error: e.message });
          }
        }

        /**
         * **只在 --mock 模式下注册**：往运行时塞一条假消息。
         *
         * 用途：没有真机也能验证整条链路——统计、权限、命令、限流。
         * 连真 QQ 时这个路由根本不存在，所以不构成额外入口。
         */
        if (mock && pathname === '/api/mock/dispatch' && req.method === 'POST') {
          const body = await readBody(req);
          const event = String(body.event || 'GROUP_AT_MESSAGE_CREATE');
          const data = body.data ?? {
            id: `mock-${Date.now()}`,
            content: String(body.content ?? ''),
            timestamp: new Date().toISOString(),
            group_openid: String(body.groupId ?? 'mock-group'),
            author: { member_openid: String(body.userId ?? 'mock-user'), username: '测试用户' },
          };
          try {
            await rt.dispatch(event, data);
            return json(res, 200, { ok: true, event });
          } catch (e) {
            // 插件在处理里抛错不该让接口 500——调用方要能看到「消息收下了但处理失败」
            return json(res, 200, { ok: false, event, error: e.message });
          }
        }

        // 插件自定义运行数据：一次拿全部，面板轮询这个接口
        if (pathname === '/api/plugins/dashboard' && req.method === 'GET') {
          return json(res, 200, await plugins.dashboards());
        }

        /* ---------------- 体检 ---------------- */

        /**
         * 「我配好了为什么没反应」——一次把可能的卡点都查一遍。
         * 只读，不改任何东西。
         */
        if (pathname === '/api/doctor' && req.method === 'GET') {
          const items = await runDoctor({ cfg, globalCfg, rt, mock });
          return json(res, 200, { items, summary: summarize(items) });
        }

        /* ---------------- 下载源 ---------------- */

        // 有哪些源可选、当前选的是哪个
        if (pathname === '/api/mirror' && req.method === 'GET') {
          return json(res, 200, {
            current: currentMirror(),
            presets: PRESETS,
            probeUrl: PROBE_URL,
          });
        }

        // 一键测速：并发打一遍，让用户按自己网络选
        if (pathname === '/api/mirror/test' && req.method === 'POST') {
          const body = await readBody(req);
          const results = await probeMirrors({
            timeoutMs: Math.min(15000, Number(body?.timeoutMs) || 6000),
            custom: body?.custom ?? globalCfg.network?.mirrorCustom ?? '',
          });
          return json(res, 200, { results });
        }

        // 改下载源
        if (pathname === '/api/mirror' && req.method === 'PUT') {
          const body = await readBody(req);
          const id = String(body?.mirror ?? '').trim();
          if (!PRESETS.some((p) => p.id === id)) {
            return json(res, 400, { error: `没有这个下载源：${id}` });
          }
          globalCfg.network = {
            ...(globalCfg.network ?? {}),
            mirror: id,
            mirrorCustom: String(body?.mirrorCustom ?? '').trim(),
            giteeToken: String(body?.giteeToken ?? '').trim(),
          };
          // 立刻生效：模块里缓存的那份要同步，不然要等重启
          configureMirror(globalCfg);
          await saveGlobalConfig?.(globalCfg).catch(() => {});
          return json(res, 200, { ok: true, current: currentMirror() });
        }


        // 有哪些页面（不含 html，可能很大）
        if (pathname === '/api/pages' && req.method === 'GET') {
          return json(res, 200, plugins.pages?.list() ?? []);
        }

        // 页面本体。iframe 直接 src 到这里，所以返回 text/html 而不是 JSON
        const pageM = pathname.match(/^\/api\/pages\/(.+)\/html$/);
        if (pageM && req.method === 'GET') {
          const key = decodeURIComponent(pageM[1]);
          const p = plugins.pages?.get(key);
          if (!p) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('页面不存在（插件可能已卸载或重载）');
          }
          /**
           * 插件页要单独换一套 CSP：它允许内联脚本和样式。
           * 不换的话会继承入口那套 `script-src 'self'`，插件页的内联脚本
           * 直接不执行 —— 表现是页面渲染出来了、但按钮全都没反应。
           */
          res.setHeader('Content-Security-Policy', CSP_PAGE);
          /**
           * `X-Frame-Options` 必须从入口的 DENY 改成 SAMEORIGIN。
           *
           * 入口给所有响应都加了 DENY（防止面板被别的网站嵌套），但插件页
           * **本来就该被面板自己嵌**。留着 DENY 的后果是：iframe 加载这个地址时
           * 被浏览器拒绝渲染，Chrome 显示「127.0.0.1 拒绝连接」——
           * 看起来像服务没起来，实际上是安全头把它自己挡在门外。
           *
           * SAMEORIGIN 仍然挡住「外部站点嵌插件页」，这是需要的。
           */
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            // 插件页面可能随插件更新而变，不缓存
            'Cache-Control': 'no-store',
          });
          // 带上主题变量，插件页面不用自己适配深浅色
          const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
          /**
           * doctype 必须是文档里的第一个东西。
           * 直接拼在最前面会让浏览器进怪异模式（盒模型、行高全变），
           * 所以有 doctype 就插在它后面。
           */
          const style = PAGE_THEME[theme];
          /**
           * 自动带令牌的补丁必须比页面自己的脚本**先**执行，所以跟主题样式
           * 一起插在最前面（doctype 之后 / 没有 doctype 就文档开头）。
           */
          const patch = pageTokenPatch(url.searchParams.get('pt') || ptPage?.token || '');
          const prefix = patch + style;
          const html = /^<!doctype/i.test(p.html.trimStart())
            ? p.html.replace(/^(\s*<!doctype[^>]*>)/i, `$1${prefix}`)
            : prefix + p.html;
          return res.end(html);
        }

        // 有哪些插件能更新。结果缓存 5 分钟，?force=1 强制重新查
        if (pathname === '/api/plugins/updates' && req.method === 'GET') {
          const force = url.searchParams.get('force') === '1';
          return json(res, 200, await checkUpdates(rt, { force }));
        }

        // 后台服务状态：健康巡检、清理、配置热加载、定时重启、检查更新
        if (pathname === '/api/services' && req.method === 'GET') {
          const list = services?.status?.() ?? [];
          // 把健康采样和更新检查结果也带上，面板一处显示
          const extra = {};
          for (const s of services?.list ?? []) {
            if (typeof s.snapshot === 'function') extra[s.name] = s.snapshot();
          }
          return json(res, 200, { services: list, extra });
        }

        /* ---------------- 框架自身更新 ---------------- */

        // 查最新版本（不装）
        if (pathname === '/api/update/check' && req.method === 'GET') {
          try {
            return json(res, 200, await checkFrameworkUpdate());
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message });
          }
        }

        // 执行更新。会覆盖代码目录，前端必须先确认过
        if (pathname === '/api/update/apply' && req.method === 'POST') {
          try {
            const info = await checkFrameworkUpdate();
            if (!info.ok) return json(res, 400, { error: info.error || '检查更新失败' });
            if (!info.hasUpdate) return json(res, 400, { error: `已经是最新版本 ${info.current}` });

            const r = await applyFrameworkUpdate(info);
            if (!r.ok) return json(res, 500, { error: r.error, from: r.from });
            return json(res, 200, {
              ok: true,
              from: r.from,
              to: r.to,
              backup: r.backup,
              message: '更新完成，重启程序后生效',
            });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }
        /* ---------------- 插件设置面板 ---------------- */

        // 拿某个插件的配置 schema、当前值、存档
        const pm = pathname.match(/^\/api\/plugins\/([^/]+)\/panel$/);
        if (pm && req.method === 'GET') {
          if (!isSafeId(pm[1])) return json(res, 400, { error: '插件 id 不合法' });
          const p = await plugins.panelOf(pm[1]);
          if (!p) return json(res, 404, { error: '插件没加载' });
          return json(res, 200, p);
        }

        // 改插件配置
        const pc = pathname.match(/^\/api\/plugins\/([^/]+)\/config$/);
        if (pc && req.method === 'PUT') {
          if (!isSafeId(pc[1])) return json(res, 400, { error: '插件 id 不合法' });
          const body = await readBody(req);
          try {
            const next = await plugins.setConfig(pc[1], body ?? {});
            return json(res, 200, { ok: true, config: next });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        // 改 / 删一条插件存档
        const pd = pathname.match(/^\/api\/plugins\/([^/]+)\/data$/);
        if (pd && req.method === 'POST') {
          if (!isSafeId(pd[1])) return json(res, 400, { error: '插件 id 不合法' });
          const id = pd[1];
          const body = await readBody(req);
          const key = String(body.key ?? '').trim();
          try {
            /**
             * clear 必须放在 key 校验**之前**。
             *
             * 「清除全部数据」是整库操作，本来就没有具体 key 可传；
             * 之前先判 `if (!key) return 400`，导致面板上那个按钮
             * 永远返回「缺少 key」——点了没反应，看起来像按钮坏了。
             */
            if (body.clear) {
              // 清空这个插件的全部存档（面板「清除全部数据」）
              const r = await plugins.clearData(id);
              return json(res, 200, { ok: true, cleared: r.removed });
            }
            if (!key) return json(res, 400, { error: '缺少 key' });
            if (body.remove) {
              await plugins.deleteData(id, key);
              return json(res, 200, { ok: true, removed: key });
            }
            // value 允许是任意 JSON；字符串原样存
            const value = typeof body.value === 'string' ? body.value : body.value;
            await plugins.setData(id, key, value);
            return json(res, 200, { ok: true, key });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        /**
         * 按「插件」看分群开关。
         *
         * 群页面那边是「一个群能开哪些插件」，这里是反过来：
         * 一个插件在哪些群是关的。两边读写的是同一份 cfg.plugins.groups。
         */
        const pgm = pathname.match(/^\/api\/plugins\/([^/]+)\/groups$/);
        if (pgm && (req.method === 'GET' || req.method === 'PUT')) {
          const pid = decodeURIComponent(pgm[1]);
          const spec = rt.cfg.plugins ?? { mode: 'all', list: [] };
          const groups = await (rt.groups?.list?.() ?? Promise.resolve([]));   // list() 按最近活跃排序

          if (req.method === 'GET') {
            /**
             * 群名要现拉：官方事件里根本没有群名，只有 `rt.groupNames` 缓存里有。
             * 以前这里读的是 `g.groupName`（群档案里从来没这个字段），
             * 于是面板永远只显示 `577C4A90…`，用户认不出是哪个群——
             * 「在哪个群关掉这个插件」这件事就变得没法操作了。
             */
            await rt?.fetchGroupNames?.(groups.map((g) => g.groupOpenid));
            return json(res, 200, {
              pluginId: pid,
              global: { mode: spec.mode ?? 'all', list: spec.list ?? [] },
              groups: groups.map((g) => ({
                chatId: g.groupOpenid,
                name: rt?.groupName?.(g.groupOpenid) ?? '',
                note: g.note ?? '',
                lastActiveAt: g.lastActiveAt ?? 0,
                enabled: pluginAllowedIn(spec, g.groupOpenid, pid),
              })),
            });
          }

          const body = await readBody(req);
          const chatId = String(body.chatId ?? '').trim();
          if (!chatId) return json(res, 400, { error: '缺少 chatId' });
          const enabled = Boolean(body.enabled);
          const groupsCfg = toggleGroupPlugin(spec, chatId, pid, enabled);
          rt.cfg.plugins = { ...spec, groups: groupsCfg };
          await saveBotConfig(rt.id, rt.cfg);
          return json(res, 200, {
            ok: true,
            chatId,
            enabled: pluginAllowedIn(rt.cfg.plugins, chatId, pid),
          });
        }

        const m = pathname.match(/^\/api\/plugins\/([^/]+)\/(enable|disable|reload|remove|resetconfig)$/);
        if (m && req.method === 'POST') {
          const [, rawId, action] = m;
          /**
           * 这里**不能**再 decodeURIComponent 一次。
           *
           * pathname 在入口已经解过码，再解一次就把 `%252F` 变成 `/`：
           * `POST /api/plugins/..%252F..%252Fx/reload` → id = `../../x`。
           * 而 enable/disable/reload 以前不做任何校验，load() 里直接拼路径 import。
           */
          const id = rawId;
          if (!isSafeId(id)) return json(res, 400, { error: `插件 id 不合法：${id}` });

          /* ---------------- 卸载插件 ---------------- */
          if (action === 'remove') {
            // id 只允许字母数字下划线横线，和安装时的校验保持一致
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
              return json(res, 400, { error: `插件 id 不合法：${id}` });
            }
            const base = path.resolve(DIRS.plugins);
            const dir = path.resolve(base, id);
            // 防路径穿越：必须严格是 plugins/ 下的一级子目录
            if (dir !== path.join(base, id) || !dir.startsWith(base + path.sep)) {
              return json(res, 400, { error: '路径越界，已拒绝' });
            }
            const st = await fs.stat(dir).catch(() => null);
            if (!st?.isDirectory()) return json(res, 404, { error: `插件 ${id} 没装` });

            try {
              // 删目录时同样要挂起热重载：文件一个个消失会被当成「用户改代码」
              suspendPluginWatch(15000);
              // 先卸运行时再删文件，顺序反了会出现进程还在读已删除的代码
              if (plugins.loaded.has(id)) await plugins.unload(id).catch(() => {});
              await ensurePluginInList(rt, id, false).catch(() => {});
              await fs.rm(dir, { recursive: true, force: true });
              // 清掉 state 里的残留，否则重装会被旧的 false 挡住
              await plugins.forget(id).catch(() => {});
              const scanned = await plugins.rescan();
              suspendPluginWatch(1000);
              // 卸载后缓存里还留着它的「可更新」，提示条计数会虚高
              forgetUpdates([id]);
              log.info(`已卸载插件 ${id}（数据目录保留，重装可继续用）`);
              return json(res, 200, { ok: true, id, ...scanned });
            } catch (e) {
              suspendPluginWatch(1000);
              log.error(`卸载插件 ${id} 失败：${e.message}`);
              return json(res, 500, { error: e.message });
            }
          }

          /**
           * 恢复出厂配置。
           *
           * 单独一个动作而不是走 `PUT /config`：那个是合并语义，
           * 插件升级后遗留的旧键清不掉。这里删文件重新生成，才真的干净。
           *
           * 面板那边必须先弹确认——API Key 这类值会被一起清空。
           */
          if (action === 'resetconfig') {
            try {
              const config = await plugins.resetConfig(id);
              return json(res, 200, { ok: true, config });
            } catch (e) {
              return json(res, 400, { error: e.message });
            }
          }

          let ok = false;
          if (action === 'enable') ok = await setPluginEnabled(rt, id, true);
          else if (action === 'disable') ok = await setPluginEnabled(rt, id, false);
          else ok = await plugins.reload(id);
          return json(res, ok ? 200 : 500, { ok, error: ok ? undefined : '操作失败，看日志' });
        }

        // 群档案
        /* ---------------- 插件市场 ---------------- */

        // 重新扫描插件目录，加载新放进去的、卸载已删除的
        if (pathname === '/api/plugins/rescan' && req.method === 'POST') {
          const r = await plugins.rescan();
          return json(res, 200, { ok: true, ...r, plugins: plugins.list() });
        }

        // 拉取插件市场索引，并标出哪些已安装
        if (pathname === '/api/market' && req.method === 'GET') {
          const url2 = url.searchParams.get('source') || globalCfg.plugins?.marketUrl || undefined;
          try {
            const idx = await fetchIndex(url2);
            const installedIds = new Set(plugins.loaded.keys());
            // 目录里存在但没加载成功的也算「已装」
            try {
              for (const d of await fs.readdir(DIRS.plugins, { withFileTypes: true })) {
                if (d.isDirectory()) installedIds.add(d.name);
              }
            } catch {}
            const localVers = await plugins.localVersions();
            const updates = detectUpdates(idx.plugins, localVers);
            return json(res, 200, {
              repo: idx.repo,
              updated: idx.updated,
              source: url2 || 'default',
              plugins: mergeWithInstalled(idx.plugins, installedIds),
              // 本地有新版可用的插件
              updates: updates.map((u) => ({
                id: u.id,
                current: u.current,
                latest: u.latest,
              })),
              localVersions: localVers,
              // 网络挂了用的是本地缓存，面板要提示用户「这是旧数据」
              stale: idx.stale === true,
              staleAge: idx.staleAge || '',
            });
          } catch (e) {
            return json(res, 502, { error: e.message });
          }
        }

        // 一键安装
        if (pathname === '/api/market/install' && req.method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { error: '缺少插件 id' });
          try {
            const src = globalCfg.plugins?.marketUrl || undefined;
            const idx = await fetchIndex(src);
            const entry = idx.plugins.find((p) => p.id === id);
            if (!entry) return json(res, 404, { error: `市场里没有 ${id}` });

            /**
             * 下载 + 解包期间要挂起插件热重载。
             *
             * 插件是逐个文件复制进 plugins/ 的，中途会短暂出现「只有一半文件」
             * 的状态。热重载若在那时触发，会读到半个 index.js 报语法错，
             * 用户看到的就是「装完提示加载失败」，而其实装得好好的。
             */
            suspendPluginWatch(30000);

            const r = await installPlugin({
              entry,
              pluginsDir: DIRS.plugins,
              repo: idx.repo,
              branch: idx.branch || 'main',
              // 索引给了仓库包校验值就带上，tarball 那边会比对
              sha256: idx?.archive?.sha256 ?? idx?.sha256 ?? null,
              exists: (pid) => plugins.loaded.has(pid),
            });

            /**
             * 装完先确保它在启用名单里，**然后交给 rescan 去加载**。
             *
             * 这里只能调 ensurePluginInList（只改配置），不能调 setPluginEnabled
             * ——后者会顺手 load，导致 rescan 看到「已加载」就跳过，added 变成空，
             * 前端就会误报「插件已安装，但没能自动加载」。
             */
            await ensurePluginInList(rt, r.id, true);

            // 装完立刻扫一遍，用户不用重启
            const scanned = await plugins.rescan();
            // 收窄挂起窗口：装完了，1 秒后恢复监视并重建基线
            suspendPluginWatch(1000);
            return json(res, 200, { ok: true, id: r.id, ...scanned });
          } catch (e) {
            suspendPluginWatch(1000);
            return json(res, 400, { error: e.message });
          }
        }

        /**
         * 可达性：谁能私聊、哪个群能主动推。
         *
         * 官方**没有查好友的接口**，这些状态全部来自 6 个事件
         * （FRIEND_ADD/DEL、C2C_MSG_REJECT/RECEIVE、GROUP_MSG_REJECT/RECEIVE）。
         * 接入之前就存在的关系是 `null`（未知）——**未知不等于不可达**，
         * 面板要把它显示成「未知」而不是「不能」。
         */
        if (pathname === '/api/reach' && (req.method === 'GET' || req.method === 'POST')) {
          /**
           * 判定结论在服务端算，前端只负责显示。
           *
           * 判定顺序（和 `reach.canC2C` 必须一致，否则面板说的和实际发的会打架）：
           * 无好友 → 关了推送 → 有好友 → 未知。
           * **`null` 是「未知」不是「不能」**，单独一个分支。
           */
          const snapshot = async () => {
            const snap = (await rt?.reach?.snapshot?.()) ?? { users: {}, groups: {} };
            const people = rt?.listRecentPeople?.(200) ?? [];
            const nameOf = (id) => people.find((p) => p.openid === id)?.name || '';

            const users = Object.entries(snap.users).map(([openid, u]) => ({
              openid,
              name: nameOf(openid),
              friend: u.friend ?? null,
              c2cPush: u.c2cPush ?? null,
              unionOpenid: u.unionOpenid || '',
              evidence: u.evidence || '',
              updatedAt: u.updatedAt || 0,
              lastFailAt: u.lastFailAt || 0,
              lastFailCode: u.lastFailCode || 0,
              lastOkAt: u.lastOkAt || 0,
              verdict:
                u.friend === 0
                  ? 'not-friend'
                  : u.c2cPush === 0
                    ? 'push-off'
                    : u.friend === 1
                      ? 'ok'
                      : 'unknown',
            }));

            const groups = Object.entries(snap.groups).map(([groupOpenid, g]) => ({
              groupOpenid,
              name: rt?.groupName?.(groupOpenid) || '',
              push: g.push ?? null,
              by: g.by || '',
              evidence: g.evidence || '',
              updatedAt: g.updatedAt || 0,
              verdict: g.push === 0 ? 'push-off' : g.push === 1 ? 'ok' : 'unknown',
            }));

            return { users, groups };
          };

          if (req.method === 'GET') return json(res, 200, await snapshot());

          /**
           * 人工标注。
           *
           * 好友事件是增量的，接入之前的老关系永远是 `unknown`，只能人工纠正。
           * `friend` / `c2cPush` / `push` 三个字段的约定：
           *   - 不传     → 这项不动
           *   - `1`/`0`  → 明确设定
           *   - `null`   → 重置为未知（**撤销标注用这个**）
           */
          if (!rt?.reach?.noteManual) {
            return json(res, 503, { error: '机器人没在运行，改不了可达性状态' });
          }
          const body = await readBody(req);
          const triOf = (v) => (v === 1 || v === true ? 1 : v === 0 || v === false ? 0 : v === null ? null : undefined);

          const gid = String(body?.groupOpenid ?? '').trim();
          if (gid) {
            const push = triOf(body?.push);
            if (push === undefined && body?.push !== undefined) {
              return json(res, 400, { error: 'push 只能是 1、0 或 null' });
            }
            await rt.reach.noteGroupManual({ groupOpenid: gid, push });
            return json(res, 200, { ok: true, ...(await snapshot()) });
          }

          const openid = String(body?.openid ?? '').trim();
          if (!openid) return json(res, 400, { error: 'openid 或 groupOpenid 不能为空' });

          const friend = triOf(body?.friend);
          const c2cPush = triOf(body?.c2cPush);
          if (friend === undefined && body?.friend !== undefined) {
            return json(res, 400, { error: 'friend 只能是 1、0 或 null' });
          }
          if (c2cPush === undefined && body?.c2cPush !== undefined) {
            return json(res, 400, { error: 'c2cPush 只能是 1、0 或 null' });
          }
          await rt.reach.noteManual({ openid, friend, c2cPush });
          return json(res, 200, { ok: true, ...(await snapshot()) });
        }

        /**
         * 事件账本：官方没有历史消息接口，这是唯一能翻到「刚才说了什么」的地方。
         *
         * 三条路由：
         *   GET /api/ledger/stats              总量、时间范围、保留天数
         *   GET /api/ledger?chatId=&limit=     某会话最近 N 条（正序）
         *   GET /api/ledger/context?chatId=&seq=  以某条为锚点的前后邻文
         *
         * `payload`（原始报文）**一律不返回**：里面虽然有脱敏过的凭证，
         * 但整包给前端没有意义（前端只要正文和元信息），只会把面板变成数据外泄面。
         */
        if (pathname === '/api/ledger/stats' && req.method === 'GET') {
          const st = rt?.ledger?.stats?.() ?? { available: false, total: 0 };
          return json(res, 200, st);
        }

        if (pathname === '/api/ledger/context' && req.method === 'GET') {
          const chatId = String(url.searchParams.get('chatId') ?? '').trim();
          const seq = Number(url.searchParams.get('seq') ?? 0);
          if (!chatId || !seq) return json(res, 400, { error: '需要 chatId 和 seq' });
          const before = Number(url.searchParams.get('before') ?? 2);
          const after = Number(url.searchParams.get('after') ?? 2);
          const list = rt?.ledger?.timeline?.({ chatId, anchorSeq: seq, before, after }) ?? [];
          return json(res, 200, { items: list, empty: list.length === 0 });
        }

        if (pathname === '/api/ledger' && req.method === 'GET') {
          const chatId = String(url.searchParams.get('chatId') ?? '').trim();
          if (!chatId) return json(res, 400, { error: '需要 chatId' });
          const limit = Number(url.searchParams.get('limit') ?? 50);
          const beforeSeq = Number(url.searchParams.get('beforeSeq') ?? 0) || undefined;
          const items = rt?.ledger?.recent?.({ chatId, limit, beforeSeq }) ?? [];
          return json(res, 200, { items });
        }

        if (pathname === '/api/groups' && req.method === 'GET') {
          const list = await groups.list();
          /**
           * 补上群名和邀请者/群主的昵称。
           *
           * 官方事件里没有群名，是 BotRuntime 在入群/收消息时异步拉的
           * （`groupNames` 缓存）；用户昵称则来自 `recentPeople`——
           * 都是「有就用，没有就退回 openid」，不影响原有字段。
           */
          const people = rt?.listRecentPeople?.(200) ?? [];
          const nameOf = (id) => people.find((p) => p.openid === id)?.name || '';
          /**
           * 缺的群名先现拉一轮，最多等 2.5 秒。
           *
           * 以前是「这次不阻塞、下次刷新才有」——结果是打开面板永远先看到
           * 一串 openid，用户以为功能坏了。现在第一次打开就能看到名字；
           * 接口慢或没权限时到点就用 openid 兜底，不会把面板卡死。
           */
          await rt?.fetchGroupNames?.(list.map((g) => g.groupOpenid));
          const withNames = list.map((g) => ({
            ...g,
            groupName: rt?.groupName?.(g.groupOpenid) ?? '',
            inviterName: nameOf(g.inviterOpenid),
            ownerName: nameOf(g.ownerOpenid),
          }));
          return json(res, 200, withNames);
        }

        /**
         * 手动登记一个群。
         *
         * 官方没有「列出机器人所在的群」的接口，群档案只能靠事件被动发现——
         * 没被 @ 过的群根本不会出现。所以给一个手动入口，配合权限页一起用。
         */
        if (pathname === '/api/groups' && req.method === 'POST') {
          const body = await readBody(req);
          const gid = String(body?.groupOpenid ?? '').trim();
          if (!gid) return json(res, 400, { error: 'groupOpenid 不能为空' });
          const saved = await groups.upsert(gid, {
            note: String(body?.note ?? '').trim(),
            manual: true,
          });
          return json(res, 200, { ok: true, group: saved });
        }
        const gm = pathname.match(/^\/api\/groups\/([^/]+)$/);
        if (gm && (req.method === 'PUT' || req.method === 'DELETE')) {
          const id = decodeURIComponent(gm[1]);
          if (req.method === 'DELETE') {
            await groups.remove(id);
            return json(res, 200, { ok: true });
          }
          const body = await readBody(req);
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
          if (body.note !== undefined) patch.note = String(body.note);
          const g = await groups.upsert(id, patch);
          return json(res, 200, g);
        }

        /**
         * 分群插件开关。
         *
         * 一个机器人常在好几个群里，有的群要骰子、有的群嫌吵。
         * 这里只改**分发时**的判断（`pluginAllowedIn`），不碰加载——
         * 插件在进程里是全局加载的，按群卸载等于每个群一套运行时，
         * 内存和重载逻辑都会炸。
         *
         * `groups` 的键是 chatId：群聊是群 openid，私聊是用户 openid。
         */
        const gpm = pathname.match(/^\/api\/groups\/([^/]+)\/plugins$/);
        if (gpm) {
          const chatId = decodeURIComponent(gpm[1]);
          const spec = rt.cfg.plugins ?? { mode: 'all', list: [] };
          const own = spec.groups?.[chatId] ?? null;

          if (req.method === 'GET') {
            const all = [...rt.plugins.loaded.values()]
              .map((p) => ({
                id: p.meta?.id ?? '',
                name: p.meta?.name ?? p.meta?.id ?? '',
                version: p.meta?.version ?? '',
              }))
              .filter((p) => p.id && p.id !== '__core')
              .sort((a, b) => a.id.localeCompare(b.id));
            return json(res, 200, {
              chatId,
              global: { mode: spec.mode ?? 'all', list: spec.list ?? [] },
              own,
              plugins: all.map((p) => ({ ...p, enabled: pluginAllowedIn(spec, chatId, p.id) })),
            });
          }

          if (req.method === 'PUT') {
            const body = await readBody(req);
            const groupsCfg = { ...(spec.groups ?? {}) };
            if (body.reset) {
              delete groupsCfg[chatId];
            } else {
              const mode = String(body.mode ?? 'include');
              if (!['all', 'include', 'exclude'].includes(mode)) {
                return json(res, 400, { error: 'mode 只能是 all / include / exclude' });
              }
              const list = Array.isArray(body.list)
                ? [...new Set(body.list.map((x) => String(x).trim()).filter(Boolean))]
                : [];
              groupsCfg[chatId] = { mode, list };
            }
            rt.cfg.plugins = { ...spec, groups: groupsCfg };
            await saveBotConfig(rt.id, rt.cfg);
            return json(res, 200, { ok: true, own: groupsCfg[chatId] ?? null });
          }
        }

        // 权限
        /**
         * 最近说过话的人，给「权限」页做候选人。
         *
         * openid 是每个机器人独立的长串，用户不可能手输。让他从「刚在群里
         * 说过话的人」里点一下，比去日志里翻要靠谱得多。
         */
        if (pathname === '/api/roles/candidates' && req.method === 'GET') {
          return json(res, 200, rt.listRecentPeople?.() ?? []);
        }

        if (pathname === '/api/roles' && req.method === 'GET') {
          const all = await roles.all();
          const rows = [];
          for (const [scope, members] of Object.entries(all)) {
            for (const [openid, level] of Object.entries(members)) {
              rows.push({ scope, openid, level });
            }
          }
          rows.sort((a, b) => b.level - a.level || a.scope.localeCompare(b.scope));
          /**
           * 补上昵称和群名。openid 是长串，面板上只显示截断的中间几位，
           * 用户认不出是谁；有昵称就一起给，没有就退回 openid。
           */
          const people = rt?.listRecentPeople?.(200) ?? [];
          const nameOf = (id) => people.find((p) => p.openid === id)?.name || '';
          const enriched = rows.map((r) => {
            const kind = r.scope.split(':')[0];
            const id = r.scope.split(':').slice(1).join(':');
            const groupName = kind === 'group' ? rt?.groupName?.(id) ?? '' : '';
            return { ...r, name: nameOf(r.openid), groupName };
          });
          return json(res, 200, { owners: cfg.owners, rows: enriched });
        }
        if (pathname === '/api/roles/set' && req.method === 'POST') {
          const body = await readBody(req);
          const scope = String(body.scope || '').trim();
          const openid = String(body.openid || '').trim();
          const level = Number(body.level);
          if (!scope || !openid || !Number.isInteger(level)) {
            return json(res, 400, { error: '缺少参数或等级不是整数' });
          }
          if (level === 0) return json(res, 400, { error: '主人只能在 config/bot.json 设置' });
          if (level < 1 || level > 98) return json(res, 400, { error: '等级需在 1-98 之间' });
          await roles.set(scope, openid, level);
          return json(res, 200, { ok: true });
        }
        if (pathname === '/api/roles/remove' && req.method === 'POST') {
          const body = await readBody(req);
          await roles.remove(String(body.scope || ''), String(body.openid || ''));
          return json(res, 200, { ok: true });
        }

        // 日志
        if (pathname === '/api/logs' && req.method === 'GET') {
          const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
          const level = url.searchParams.get('level') || 'debug';
          return json(res, 200, recentLogs(limit, level));
        }

        // 日志级别
        if (pathname === '/api/loglevel' && req.method === 'POST') {
          const body = await readBody(req);
          setLevel(body.level);
          globalCfg.logLevel = body.level;
          await saveGlobalConfig?.(globalCfg).catch(() => {});
          configureMirror(globalCfg);
          return json(res, 200, { ok: true, level: getLevel() });
        }

        // 网关操作
        if (pathname === '/api/gateway/reconnect' && req.method === 'POST') {
          // 已经下线时没有「重连」可言，直接当上线处理，免得点了没反应
          if (!rt.online) {
            const state = await rt.goOnline();
            return json(res, 200, { ok: state === 'online', state, error: rt.lastError || '' });
          }
          await getGateway?.()?.restart();
          return json(res, 200, { ok: true, state: rt.state });
        }
        if (
          (pathname === '/api/credential/refresh' || pathname === '/api/token/refresh') &&
          req.method === 'POST'
        ) {
          await tokens?.refresh();
          return json(res, 200, { ok: true });
        }

        // 主动发消息（调试用）
        /**
         * 面板手动发消息（调试用）。
         *
         * **必须走 outbound**。这条以前直连 `api.sendGroup` / `api.sendC2C`，
         * 绕过了每秒限速、主动消息额度记账（20/分 + 1000/天）和离线判断。
         * 面板随手点几下就能把额度打满，而额度账本里一条记录都没有——
         * **半真的账本比没有账本更糟**，因为你会相信它。
         *
         * 错误按 SendError 的 code 分开回：`quota` 用 429（等一会儿能好），
         * 其余用 400（重试也不会好，比如离线、被动窗口已过）。
         */
        if (pathname === '/api/send' && req.method === 'POST') {
          const body = await readBody(req);
          const { scene, target, content } = body;
          if (!target || !content) return json(res, 400, { error: '需要 target 和 content' });
          const kind = scene === 'c2c' ? 'c2c' : 'group';
          const sender = kind === 'c2c' ? api?.sendC2C : api?.sendGroup;
          if (!sender) return json(res, 503, { error: '未连接' });

          if (rt.outbound) {
            try {
              const r = await rt.outbound.send({
                kind,
                target,
                chatKey: `${kind}:${target}`,
                payload: { content },
              });
              // pending = 主动消息进了审核。既不是失败，也不是「已经送达」
              return json(res, 200, { ok: true, id: r?.id ?? '', pending: Boolean(r?.pending) });
            } catch (e) {
              const hint = userFacingSendError(e);
              if (!hint) throw e; // 真正的接口错误交给外层兜底（500 + 原始信息）
              // quota（等跨天）和 rate（等一分钟）都是「等会儿能好」，用 429 让调用方知道可以重试
              const retriable = e.code === 'quota' || e.code === 'rate';
              return json(res, retriable ? 429 : 400, { error: hint, code: e.code });
            }
          }

          // 只有自造 Bot 实例（没建调度器）才会走到这里，直发兜底
          const r = await sender.call(api, target, { content });
          return json(res, 200, { ok: true, id: r?.id });
        }

        // SSE
        if (pathname === '/api/stream' && req.method === 'GET') {
          /**
           * 连接数上限必须**先检查再写头**。
           *
           * 之前是「先 writeHead(200, SSE 头) 再判满、判满再 writeHead(503)」，
           * 满载时对同一个 res 写两次头，Node 直接抛 `ERR_HTTP_HEADERS_SENT`，
           * 请求崩掉、连接也不释放。SSE 是长连接，每个连接占一个 fd + 一份缓冲；
           * 面板被脚本反复刷新时不设限就是稳定泄漏。
           */
          if (sseClients.size >= MAX_SSE) {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('SSE 连接数已满，请关闭多余的页面后重试');
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`event: status\ndata: ${JSON.stringify(statusPayload(rt))}\n\n`);
          sseClients.set(res, rt.id);
          const ping = setInterval(() => {
            try {
              res.write(': ping\n\n');
            } catch {
              /**
               * 写失败 = 连接其实已经断了，但 `close` 事件可能没触发
               * （客户端异常断开、半开连接、keep-alive 下不发 FIN）。
               * 不在这里清的话，这个僵尸连接会一直占着 MAX_SSE 的配额，
               * 直到真 close 才释放。所以失败即主动清理。
               */
              clearInterval(ping);
              sseClients.delete(res);
              try {
                res.end();
              } catch {}
            }
          }, 15000);
          req.on('close', () => {
            clearInterval(ping);
            sseClients.delete(res);
          });
          return;
        }

        // 事件订阅与接收情况
        if (pathname === '/api/events' && req.method === 'GET') {
          const mask = Number(cfg.intents) || 0;
          const { enabled } = describeIntents(mask);
          const groups = [];
          for (const [group, items] of groupEvents()) {
            groups.push({
              group,
              items: items.map((it) => ({
                name: it.name,
                intent: it.intent,
                intentName: INTENT_META[it.intent]?.name ?? it.intent,
                desc: it.desc,
                message: it.message ?? null,
                doc: it.doc !== false,
                subscribed: enabled.includes(it.intent),
                count: rt.metrics.eventCounts.get(it.name) ?? 0,
                lastAt: rt.metrics.eventLastAt.get(it.name) ?? 0,
              })),
            });
          }
          return json(res, 200, {
            intents: mask,
            enabled,
            intentsMeta: INTENT_META,
            total: EVENT_NAMES.length,
            received: EVENT_NAMES.filter((n) => (rt.metrics.eventCounts.get(n) ?? 0) > 0).length,
            groups,
          });
        }

        // 更新一个已安装的插件。会覆盖本地目录，所以前端必须弹窗确认过
        if (pathname === '/api/market/update' && req.method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { error: '缺少插件 id' });
          let repo = null;
          try {
            const src = globalCfg.plugins?.marketUrl || undefined;
            const idx = await fetchIndex(src);
            const entry = idx.plugins.find((p) => p.id === id);
            if (!entry) return json(res, 404, { error: `市场里没有 ${id}` });

            const localVers = await plugins.localVersions();
            const cur = localVers[id];
            if (!cur) return json(res, 400, { error: `本地没装 ${id}，先用「安装」` });
            if (compareVersion(cur, entry.version) >= 0) {
              return json(res, 400, { error: `${id} 已经是 ${cur}，没有新版` });
            }

            // 拉一次仓库，只更新指定的这一个
            repo = await syncRepo({ repo: idx.repo, branch: idx.branch || 'main', indexUrl: src });
            const r = await updatePlugins({
              tmp: repo.tmp,
              index: repo.index,
              pluginsDir: DIRS.plugins,
              ids: [id],
              localVersions: localVers,
            });
            if (r.failed.length) return json(res, 400, { error: r.failed[0].error });
            if (!r.updated.length) return json(res, 400, { error: `${id} 没有可用的更新` });

            // 更新完重载该插件。玩家存档在 data/ 下，不受影响
            await plugins.reload(id).catch((e) => {
              log.warn(`插件 ${id} 更新后重载失败: ${e.message}`);
            });
            const scanned = await plugins.rescan();
            // 版本已经落地，缓存里的「可更新」要跟着消失，否则面板还挂着旧标注
            forgetUpdates([id]);
            return json(res, 200, { ok: true, from: r.updated[0].from, to: r.updated[0].to, ...scanned });
          } catch (e) {
            return json(res, 400, { error: e.message });
          } finally {
            await cleanupRepo(repo?.tmp);
          }
        }

        // 一键更新全部有新版 的插件。同样会覆盖本地目录
        if (pathname === '/api/market/update-all' && req.method === 'POST') {
          let repo = null;
          try {
            const src = globalCfg.plugins?.marketUrl || undefined;
            repo = await syncRepo({ indexUrl: src });
            const localVers = await plugins.localVersions();
            const r = await updatePlugins({
              tmp: repo.tmp,
              index: repo.index,
              pluginsDir: DIRS.plugins,
              localVersions: localVers,
            });

            // 更新成功的逐个重载，失败的不碰
            for (const u of r.updated) {
              await plugins.reload(u.id).catch((e) => {
                log.warn(`插件 ${u.id} 更新后重载失败: ${e.message}`);
              });
            }
            const scanned = await plugins.rescan();
            forgetUpdates(r.updated.map((u) => u.id));
            return json(res, 200, { ok: true, ...r, ...scanned });
          } catch (e) {
            return json(res, 400, { error: e.message });
          } finally {
            await cleanupRepo(repo?.tmp);
          }
        }

        // 关闭程序（前端已做二次确认）
        if (pathname === '/api/shutdown' && req.method === 'POST') {
          log.info('面板请求关闭程序');
          // 先把响应发出去，再退出，否则前端只会看到连接中断
          json(res, 200, { ok: true, message: '正在关闭' });
          setTimeout(() => {
            try {
              if (onShutdown) onShutdown();
              else process.exit(0);
            } catch {
              process.exit(0);
            }
          }, 200);
          return;
        }

        /* ---------------- 插件自定义路由 ---------------- */

        /**
         * `/api/plugins/<id>/r/<插件自己的路径>`
         *
         * 前缀 `/r/` 是刻意选的：上面的 `/api/plugins/:id/panel|config|data`
         * 已经被占用，换一个前缀就不用去改那些分支。
         *
         * 能走到这里，说明已经过了 authorized() + Content-Type + 同源校验，
         * 插件只拿到整理好的数据，拿不到裸 req/res，绕不开鉴权。
         */
        const pr = pathname.match(/^\/api\/plugins\/([^/]+)\/r(\/.*)?$/);
        if (pr) {
          if (!isSafeId(pr[1])) return json(res, 400, { error: '插件 id 不合法' });
          if (!plugins?.routes) return json(res, 501, { error: '当前环境不支持插件路由' });

          const sub = pr[2] || '/';
          const hit = plugins.routes.match(pr[1], req.method, sub);
          if (!hit) return json(res, 404, { error: `插件 ${pr[1]} 没有这个接口：${sub}` });

          let body = null;
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = await readBody(req);
          }
          const query = Object.fromEntries(url.searchParams.entries());

          try {
            const out = await runRoute(hit, { query, body, method: req.method });
            // 204 表示插件有意不回内容
            if (out.code === 204) {
              res.writeHead(204);
              return res.end();
            }
            return json(res, out.code, out.data);
          } catch (e) {
            log.error(`插件 ${pr[1]} 路由 ${sub} 出错: ${e.stack || e.message}`);
            return json(res, 500, { error: e.message });
          }
        }

        return json(res, 404, { error: '接口不存在' });
      }

      // ---------------- 静态文件 ----------------
      let filePath = pathname === '/' ? '/index.html' : pathname;
      const abs = path.resolve(WEB_ROOT, '.' + filePath);
      const rel = path.relative(WEB_ROOT, abs);
      // rel 以 .. 开头或为绝对路径，说明跑出了 web 目录
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      let content;
      try {
        content = await fs.readFile(abs);
      } catch {
        // 只有「不像静态资源」的路径才回退到 index.html（前端路由），
        // 带扩展名的直接 404，免得把缺失的 js/css 也伪装成 200
        if (path.extname(abs)) {
          res.writeHead(404);
          return res.end('not found');
        }
        try {
          content = await fs.readFile(path.join(WEB_ROOT, 'index.html'));
          filePath = '/index.html';
        } catch {
          res.writeHead(404);
          return res.end('not found');
        }
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch (e) {
      log.error('面板请求出错:', e.message);
      if (!res.headersSent) {
        // BodyError 自带状态码（413 超限 / 400 非法 JSON），别一律回 500
        json(res, e.status || 500, { error: e.message });
      } else {
        res.end();
      }
    }
  });

  /* ---------------- 监听（端口被占用自动顺延） ---------------- */

  /**
   * 容器里**禁用端口顺延**。
   *
   * docker-compose 把宿主机的 15207 固定映射到容器的 15207。容器内一旦因为
   * 端口被占而顺延到 15208，宿主那边映射就悬空了 —— 面板不是报错，而是
   * 静默地访问不到，日志里只有一行「换 15208 试试」，极难对上号。
   *
   * 桌面环境顺延是好事（用户不想为端口冲突折腾），容器里则应该**直接失败**，
   * 让 restart 策略或者人看到明确的错误。
   */
  const IN_CONTAINER = process.env.ROOST_STRICT_PORT === '1' || (() => {
    try {
      return fsSync.existsSync('/.dockerenv');
    } catch {
      return false;
    }
  })();
  const tries = IN_CONTAINER ? 1 : Math.max(1, Number(wc.portTries) || 20);
  if (IN_CONTAINER && Number(wc.portTries) > 1) {
    log.info(`容器环境：已禁用端口顺延（固定映射只能对上 ${port}）`);
  }
  let actualPort;
  try {
    actualPort = await listenWithFallback(server, host, port, {
      tries,
      onBusy: (p) => log.warn(`端口 ${p} 被占用，换 ${p + 1} 试试`),
    });
  } catch (e) {
    log.error(
      `端口 ${port}${tries > 1 ? `~${port + tries - 1}` : ''} 都不可用，可视化面板未启动: ${e.message}`,
    );
    clearInterval(statusTimer);
    offLog();
    offMsg();
    return null;
  }

  // 面板监听成功后，运行期再出错只记日志，不影响机器人本体
  server.on('error', (e) => log.error('面板出错:', e.message));

  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;

  /**
   * 把实际端口写进「端口租约」，让 dsh-roost 知道面板到底在哪。
   *
   * 为什么要这个：面板端口被占会自动顺延（上面 listenWithFallback），
   * 但 `config/bot.json` 里还是用户写的那个——dsh-roost 按配置去连就连不上。
   * 配置是**意愿**，这里是**现实**，两个都得留着。
   *
   * 写 `<root>/data/ports.json`，dsh-roost 读同一个文件。
   */
  try {
    const { mkdirSync, writeFileSync, renameSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const leaseFile = join(ROOT, 'data', 'ports.json');
    let lease = {};
    try {
      lease = JSON.parse(readFileSync(leaseFile, 'utf8')) || {};
    } catch {}
    lease.roost = { want: port, actual: actualPort, pid: process.pid, at: new Date().toISOString() };
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    // 原子写：先写 .tmp 再 rename，免得 dsh-roost 读到半截 JSON
    writeFileSync(`${leaseFile}.tmp`, JSON.stringify(lease, null, 2), 'utf8');
    renameSync(`${leaseFile}.tmp`, leaseFile);
    if (actualPort !== port) {
      log.warn(`面板实际在 ${actualPort}（配置写的是 ${port}，那个被占了）。已写入 data/ports.json`);
    }
  } catch (e) {
    // 写不进去不影响面板运行
    log.warn(`端口租约写不进去：${e.message}`);
  }

  /**
   * 两把地址：一把给人看（进日志），一把给 openBrowser 用（带密钥，不进日志）。
   *
   * 以前只有一把，`log.info` 直接把带 `?key=` 的完整 URL 打出去 —— 于是密钥
   * 落到 logs/、docker logs、截图、贴到群里求助的日志里。而面板 key 等价于
   * 「能装插件 = 子进程执行代码」，一条日志就是一次长期凭据泄露。
   *
   * 服务商日志、容器 json-file、journald 都会把它留存很久，所以只能保证
   * 「从不产生」，不能靠事后清理。
   */
  const baseUrl = `http://${shownHost}:${actualPort}/`;
  // 自动打开浏览器用（main.js → openBrowser），带密钥，只走内存
  const url = accessKey ? `${baseUrl}?key=${encodeURIComponent(accessKey)}` : baseUrl;

  log.info(`可视化面板: ${baseUrl}`);
  if (accessKey) {
    log.info('面板已开启访问密钥：浏览器会自动带上；手动访问时在地址后加 ?key=<你的密钥>（日志里不打印）');
  }

  return {
    server,
    url,
    port: actualPort,
    close() {
      clearInterval(statusTimer);
      offLog();
    offMsg();
      for (const c of sseClients.keys()) {
        try {
          c.end();
        } catch {}
      }
      sseClients.clear();
      server.close();
    },
  };
}
