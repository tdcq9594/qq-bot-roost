/**
 * 扫码登录：让本机浏览器自己完成登录，再把登录态接回来
 * ====================================================
 *
 * ## 为什么必须借浏览器，而不是后端直接扫
 *
 * 2026-11-15 实测官方 `/api/v3/login/qrcode/*`：手机确认后服务端轮询停在
 * `ret:5`，`developer_list` 直接报「登录鉴权参数异常」，**全程没有 `Set-Cookie`**。
 * 登录态只在 q.qq.com 的页面上下文里种，进程外接不到。所以「纯后端扫码」
 * 这条路是死的——不是轮询太短，也不是少调了哪个接口。
 *
 * 可行做法只有一个：起一个**独立 profile 的浏览器窗口**，让它在页面上正常
 * 走完扫码，再用 DevTools 协议（CDP）把 `p_skey` / `qticket` 读出来。
 * 这些票据是 httpOnly，`document.cookie` 读不到，`Storage.getCookies` 才能给。
 *
 * ## 为什么不复用用户平时的 Edge
 *
 * Edge 把 `Network/Cookies` 独占锁住（同一天实测：PowerShell 共享读、
 * Python `immutable=1` 全部失败），进程外解不开。独立 `--user-data-dir`
 * 既不碰用户的浏览器资料，也绕开这把锁；profile 持久化后下次打开往往
 * 还是登录态，**可以免扫码直接进**。
 *
 * ## 端口为什么用 0
 *
 * `--remote-debugging-port=0` 让 Chromium 自己挑空闲端口，再写进 profile 下的
 * `DevToolsActivePort`（第一行端口、第二行 ws 路径）。自己先探测一个空闲端口
 * 会留竞态：探测完到 spawn 之间可能被别人占掉。
 *
 * ## `--remote-allow-origins=*` 的取舍
 *
 * Node 的 WebSocket 握手会带 `Origin`，Chromium 默认拒绝带 Origin 的 CDP 连接。
 * 放宽它的代价是：窗口存活期间，本机恶意网页理论上也能连这个调试端口。
 * 所以窗口是**短命**的——登录成功 / 超时 / 取消都立刻关掉，不做常驻。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../paths.js';
import { TICKET_KEYS } from './session.js';

/**
 * 扫码窗口的落地页。
 *
 * 必须是 `q.qq.com/#/` 这个登录入口，**不能直接开 `qqbot/dashboard/`**：
 * 未登录时那个地址不会跳登录页，只会停在一个空壳上，用户看不到二维码。
 * 登录成功后页面自己会进 dashboard，我们的循环只认 cookie，不依赖 URL。
 */
export const LOGIN_URL = 'https://q.qq.com/#/';

/** 管理端地址，扫码成功后页面会自己落到这里；仅用于文案与 Referer */
export const DASHBOARD_URL = 'https://q.qq.com/qqbot/dashboard/';

/**
 * 注入页面执行的请求函数。
 *
 * 用字符串而不是函数 `toString()`：它要跨进程边界送给 `Runtime.evaluate`，
 * 写成明文最不容易被包一层作用域或压缩搞坏。**不能引用外部任何变量。**
 */
const PAGE_FETCH_SRC = `async function (p) {
  try {
    const res = await fetch(p.url, {
      method: p.method,
      headers: p.headers,
      body: p.body == null ? undefined : p.body,
      credentials: 'include',
      cache: 'no-store',
    });
    return { status: res.status, body: await res.text() };
  } catch (e) {
    return { status: 0, body: '', error: String((e && e.message) || e) };
  }
}`;

/** 扫码窗口尺寸：够宽放得下侧栏，又不至于遮住整个屏幕 */
const WINDOW = '600,900';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/**
 * 不 unref 的 sleep。
 *
 * 扫码循环用 `sleep` 是对的：窗口在等，进程不该为它活着。但**自动续期是在
 * 请求链里同步等的**，用 unref 版会出现「等票的那个 await 永远不返回、进程
 * 却直接退出」（Node 报 `unsettled top-level await`）——因为它一看没有其它
 * 句柄就收工了。这里的等待必须抓住事件循环。
 */
const sleepRef = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 找本机的 Chromium 系浏览器。
 *
 * 只认 Edge 和 Chrome：它们都支持 CDP，且 Windows 上基本必然有一个。
 * 顺序按国内装机量来——Edge 在前。
 *
 * 注入 `exists` 是为了测试能跑在任意平台，不用真去 stat 一堆路径。
 */
export function findBrowsers({
  platform = process.platform,
  env = process.env,
  exists = (p) => { try { return fs.existsSync(p); } catch { return false; } },
  /** 用户在面板里手填的路径，或 `ROOST_DEV_BROWSER`。命不中就当没填 */
  browserPath = '',
} = {}) {
  const out = [];
  const push = (id, name, p) => {
    if (!p) return;
    if (out.some((x) => x.path === p)) return;
    if (!exists(p)) return;
    out.push({ id, name, path: p });
  };

  /**
   * 显式指定优先。
   *
   * 探测链再全也有覆盖不到的：绿色版解压到 D 盘、企业统一装的定制包、
   * 改了名的可执行文件。这类用户给一条路径就能自救，比我们穷举路径便宜。
   */
  const forced = String(browserPath || env.ROOST_DEV_BROWSER || '').trim();
  if (forced) push('custom', '指定的浏览器', forced);

  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean);
    const rels = [
      ['edge', 'Microsoft Edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
      ['chrome', 'Google Chrome', 'Google\\Chrome\\Application\\chrome.exe'],
      ['chromium', 'Chromium', 'Chromium\\Application\\chrome.exe'],
      ['brave', 'Brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      ['vivaldi', 'Vivaldi', 'Vivaldi\\Application\\vivaldi.exe'],
    ];
    for (const root of roots) for (const [id, name, rel] of rels) push(id, name, path.join(root, rel));
  } else if (platform === 'darwin') {
    /**
     * 除了 `/Applications`，还要看用户目录下的 `~/Applications`：
     * 没有管理员权限时 Chromium 系浏览器经常装在那里。
     */
    const roots = ['/Applications', path.join(env.HOME || '', 'Applications')].filter((r) => r && r !== 'Applications');
    const apps = [
      ['edge', 'Microsoft Edge', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['chrome', 'Google Chrome', 'Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['chromium', 'Chromium', 'Chromium.app/Contents/MacOS/Chromium'],
      ['brave', 'Brave', 'Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['vivaldi', 'Vivaldi', 'Vivaldi.app/Contents/MacOS/Vivaldi'],
    ];
    for (const root of roots) for (const [id, name, rel] of apps) push(id, name, path.join(root, rel));
  } else {
    /**
     * Linux 的发行版差异最大：包管理器、snap、flatpak 落的路径都不一样。
     * 注意 flatpak 的可执行文件名和包名不一致（`com.google.Chrome` 这个文件
     * 本身就是启动器），所以这里按实际路径写死，不做推导。
     */
    const linux = [
      ['edge', 'Microsoft Edge', '/usr/bin/microsoft-edge'],
      ['edge', 'Microsoft Edge', '/usr/bin/microsoft-edge-stable'],
      ['chrome', 'Google Chrome', '/usr/bin/google-chrome'],
      ['chrome', 'Google Chrome', '/usr/bin/google-chrome-stable'],
      ['chromium', 'Chromium', '/usr/bin/chromium'],
      ['chromium', 'Chromium', '/usr/bin/chromium-browser'],
      ['brave', 'Brave', '/usr/bin/brave-browser'],
      ['brave', 'Brave', '/usr/bin/brave'],
      ['vivaldi', 'Vivaldi', '/usr/bin/vivaldi'],
      ['chromium', 'Chromium (snap)', '/snap/bin/chromium'],
      ['chrome', 'Google Chrome (flatpak)', '/var/lib/flatpak/exports/bin/com.google.Chrome'],
      ['chromium', 'Chromium (flatpak)', '/var/lib/flatpak/exports/bin/org.chromium.Chromium'],
    ];
    for (const [id, name, p] of linux) push(id, name, p);
  }
  return out;
}

/** cookie 域是不是 qq.com 家族（`qq.com` / `.qq.com` / `.q.qq.com` …） */
function isQqDomain(domain) {
  const d = String(domain ?? '').toLowerCase().replace(/^\./, '');
  return d === 'qq.com' || d.endsWith('.qq.com');
}

/**
 * 从 CDP 的 cookie 列表里挑出票据。
 *
 * 同名的 cookie 可能挂在不同域上（`.qq.com` 和 `.q.qq.com` 各一份）。
 * 更具体的域优先，因为 dashboard 用的是 `q.qq.com` 那份——拿错了会 401。
 */
export function pickTickets(list = []) {
  const rank = (d) => (String(d ?? '').includes('q.qq.com') ? 0 : 1);
  const items = (Array.isArray(list) ? list : [])
    .filter((c) => c && typeof c.name === 'string' && c.value)
    .filter((c) => TICKET_KEYS.includes(c.name))
    .filter((c) => isQqDomain(c.domain))
    .sort((a, b) => rank(a.domain) - rank(b.domain));

  const out = new Map();
  for (const c of items) if (!out.has(c.name)) out.set(c.name, String(c.value));
  return out;
}

/**
 * 票据够不够「可以去试一次」。
 *
 * 判据是**登录态标记**，不是「有没有某个 ticket」：
 *   · `b-token`   —— 2026-11 实测的新版登录令牌（httpOnly，手机扫码后下发）
 *   · `p_skey`    —— 老版登录令牌，新号可能根本不下发，只能当兼容分支
 *   · `developer_id_lite` —— 登录后才落，用它兜住「令牌换了名字」的情况
 *
 * 不能拿 `qticket/qticket_lite/quid/quin` 当判据：q.qq.com 对**未登录的访客**
 * 也会种这几个，按「有票」放行会在用户还盯着二维码时报「已取到登录态」。
 */
export function hasTickets(jar) {
  return Boolean(jar?.get?.('b-token') || jar?.get?.('p_skey') || jar?.get?.('developer_id_lite'));
}

/**
 * 「够干活的票据」——比 `hasTickets` 严一级。
 *
 * `b-token` 只是凭据；每次请求还要带 `developer_id`，那个值取自
 * `developer_id_lite`（见 `developerIdOf()`）。只有 `b-token` 时平台回
 * `401 miss ticket`（实测确认过）。
 *
 * 这个区别很关键：换票用的页面刚起来时，`b-token` 先种、`developer_id_lite`
 * 后种。读得太早就拿到**半份票**，于是「换票成功」下一次请求又过期，接着再换
 * ——看起来像平台抽风，其实是自己抢跑了。
 */
export function hasUsableTickets(jar) {
  // 老版登录态（p_skey 时代）是整套一起种的，不要求新字段
  if (jar?.get?.('p_skey')) return true;
  return Boolean(jar?.get?.('b-token') && jar?.get?.('developer_id_lite'));
}

/**
 * 票据指纹，只用来判断「票变了没有」。
 *
 * 两个硬要求：
 *   · 必须是**值**的指纹。只看长度会漏：用户退出重登后 `qticket` 还是 32 位，
 *     长度签名一模一样，于是被判成「票没变」永远不再验一次。
 *   · 不能回原文。这个值会进状态对象、进日志，票据值不该出现在那里。
 */
export function ticketSig(jar) {
  const keys = ['b-token', 'p_skey', 'qticket', 'qticket_lite', 'developer_id_lite'];
  let h = 5381;
  for (const k of keys) {
    const v = String(jar?.get?.(k) ?? '');
    for (let i = 0; i < v.length; i += 1) h = ((h * 33) ^ v.charCodeAt(i)) >>> 0;
    h = ((h * 33) ^ 0x7c) >>> 0; // 加分隔符，免得 a+b 和 ab 撞成同一个
  }
  return h.toString(36);
}

/** 一个最小的 CDP 客户端：发命令、等回包、断线时有明确错误 */
function connectCdp(url, { onClose } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(new Error(`连不上浏览器调试端口：${e?.message ?? e}`));
      return;
    }

    let seq = 0;
    const pending = new Map();
    let settled = false;

    const failAll = (msg) => {
      for (const p of pending.values()) p.reject(new Error(msg));
      pending.clear();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* 已经断了 */ }
      reject(new Error('连不上浏览器调试端口（握手超时）'));
    }, 8_000);
    timer.unref?.();

    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        send(method, params) {
          if (ws.readyState !== 1) return Promise.reject(new Error('浏览器连接已断开'));
          const id = ++seq;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            try {
              ws.send(JSON.stringify({ id, method, params: params ?? {} }));
            } catch (e) {
              pending.delete(id);
              rej(new Error(`CDP 发送失败：${e?.message ?? e}`));
              return;
            }
            const t = setTimeout(() => {
              if (pending.delete(id)) rej(new Error(`${method} 超时`));
            }, 10_000);
            t.unref?.();
          });
        },
        close() {
          try { ws.close(); } catch { /* 已经断了 */ }
        },
      });
    });

    ws.addEventListener('message', (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'CDP 返回错误'));
      else p.resolve(msg.result);
    });

    ws.addEventListener('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('连不上浏览器调试端口'));
      }
    });

    ws.addEventListener('close', () => {
      failAll('浏览器连接已断开');
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('浏览器调试端口提前关闭'));
      }
      onClose?.();
    });
  });
}

/**
 * 扫码登录状态机。
 *
 * 状态：`idle → starting → waiting → verifying → ok`
 * 分支：`expired`（等待超时）/ `canceled`（关窗或手动取消）/ `error`（启动失败）
 *
 * `verify` 由 `platform.js` 注入：它负责把票据装进会话、真发一次
 * `list_bots` 看通不通。**browser.js 不认识接口，只认识 cookie**——
 * 这样这一层可以被假 launcher 完整测掉，不联网。
 */
export function createScanLogin({
  log = () => {},
  profileDir = path.join(DIRS.data, 'dev-browser'),
  finder = findBrowsers,
  spawnFn = nodeSpawn,
  /** 面板里手填的浏览器可执行文件路径（空 = 全自动探测） */
  browserPath = '',  /** 注入点：测试用假 CDP 客户端，生产走 `connectCdp` */
  connect = connectCdp,
  verify = null,
  /** 等待扫码的总时长。太短会让用户手忙脚乱，太长等于常驻一个调试端口 */
  ttlMs = 180_000,
  pollMs = 1_500,
  /**
   * 校验失败后的退避起点 / 上限。
   *
   * 失败一次就把间隔翻倍：平台回「系统繁忙」（限频）时，1.5 秒一轮接着打
   * 等于自己把限频窗口续上，越重试越出不来。
   */
  backoffMs = 3_000,
  backoffMaxMs = 15_000,
  readyTimeoutMs = 25_000,
  now = () => Date.now(),
} = {}) {
  let proc = null;
  let cdp = null;
  let pageCdp = null;
  let cdpPort = 0;
  let running = false;
  let closing = false;
  /** 手动检查正在跑：挡住连点，也挡住和轮询同时打 `list_bots` */
  let rechecking = false;
  let st = blank();
  /**
   * 本轮等待登录的时长。
   *
   * 扫码是人在操作，给 180 秒；自动续期是「用已登录的 profile 换张票」，
   * 几秒就该出结果，等满 3 分钟只会在用户桌面上挂一个没人管的窗口。
   */
  let activeTtl = ttlMs;
  /**
   * 取到票之后要不要立刻校验一次。
   *
   * 扫码登录要（用户得知道「票是不是真的能用」）。**自动续期不要**：
   * 校验本身就是一次 `list_bots`，紧接着重试又要打一次，两连发很容易被平台
   * 判成限频，变成「刚续好的票立刻报系统繁忙」——实测踩过。
   * 续期时让被重试的那个真实请求自己去证伪就够了。
   */
  let activeVerify = true;
  /**
   * 这次起的浏览器要不要「无头」（不弹窗）。
   *
   * 扫码必须是可见的（人要扫二维码）。**自动续期必须是无头的**：它由后台请求
   * 触发，突然在桌面正中弹一个窗口非常打扰——实测用户的第一反应是「我是不是
   * 中毒了」。无头模式下页面照样跑 JS、照样能换票，只是没有窗口。
   */
  let activeHeadless = false;

  function blank() {
    return { state: 'idle', message: '', startedAt: 0, botCount: 0, error: '', browser: '' };
  }

  function status() {
    return {
      ...st,
      /** 浏览器还连着吗：面板靠它区分「能发请求」和「只剩一份可能过期的 cookie」 */
      alive: Boolean(cdp) && !closing,
      /**
       * 这一轮流程（起浏览器 → 等扫码 → 校验）是不是还没收尾。
       *
       * 自动续期要知道这件事：**不能在扫码途中开自己的窗口**。两边共用同一个
       * `--user-data-dir`，第二个进程只会把 URL 转给已有实例然后等不到调试
       * 端口；而且两边收尾时都会 `close()`，谁先结束谁就把对方的窗口一起关掉。
       */
      busy: Boolean(running),
      expiresIn: st.startedAt ? Math.max(0, st.startedAt + ttlMs - now()) : 0,
    };
  }

  const active = () => st.state === 'starting' || st.state === 'waiting' || st.state === 'verifying';

  async function readDevToolsUrl(portFile) {
    const text = await fsp.readFile(portFile, 'utf8');
    const [portRaw, wsPath] = text.split(/\r?\n/);
    const port = Number(portRaw);
    if (!Number.isFinite(port) || port <= 0) return '';
    cdpPort = port;
    if (wsPath && wsPath.startsWith('/')) return `ws://127.0.0.1:${port}${wsPath}`;
    // 老版本只写端口，ws 路径得自己问
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    const json = await res.json();
    return String(json?.webSocketDebuggerUrl ?? '');
  }

  async function waitDevTools(portFile) {
    const deadline = now() + readyTimeoutMs;
    while (now() < deadline) {
      if (!running) throw Object.assign(new Error('已取消'), { state: 'canceled' });
      try {
        const url = await readDevToolsUrl(portFile);
        if (url) return url;
      } catch {
        /* 文件还没写出来，或者 ws 路径要再等一次 */
      }
      await sleep(250);
    }
    throw new Error('浏览器没能打开调试端口（可能被安全软件拦了）');
  }

  /**
   * 连上那个页面（dashboard 所在的那个 tab）。
   *
   * `Library.getCookies` 之外还要在这里发 fetch，所以页面连接是长期持有的：
   * 关掉再连一次会丢 `Network.enable` 的状态，`getAllCookies` 会静默返回空。
   */
  /**
   * 把窗口挪到管理端（只做一次）。
   *
   * 起步页必须是 `/#/`（未登录直接开 dashboard 会卡空页），但停在 `/#/apps`
   * 时官方 SPA 只加载了门户首页，机器人模块没初始化——它自己的心跳
   * （`/info/hit`）和票据续期都挂在那个模块上。
   *
   * 幂等：循环每轮都会调，真正导航只发生一次；失败不抛，下一轮再试。
   */
  let navigated = false;
  async function goDashboard() {
    if (navigated || !cdp) return;
    try {
      const page = await pageConnection();
      const cur = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      const href = String(cur?.result?.value || '');
      if (href && !/^https:\/\/q\.qq\.com\/?#?\/?$/.test(href) && href.includes('qqbot/dashboard')) {
        navigated = true;
        return;
      }
      await page.send('Page.navigate', { url: DASHBOARD_URL });
      navigated = true;
    } catch { /* 导航失败不影响登录态，下一轮再试 */ }
  }

  /**
   * 直接把窗口开到某个机器人的设置页。
   *
   * 管理端是「先列表、再点进去」两层：只停在列表页时，用户还得自己找那个
   * 机器人点一下才能改。面板里已经选了机器人的情况下，窗口应该跟着走，
   * 屏幕上看到的和正在编辑的是同一个东西。
   *
   * 路由是实测出来的：点卡片后地址变成 `/qqbot/dashboard/manage/<appid>`。
   */
  async function openBotPage(appid) {
    const id = String(appid || '').replace(/[^\d]/g, '');
    if (!id || !cdp) return false;
    try {
      const page = await pageConnection();
      await page.send('Page.navigate', { url: `${DASHBOARD_URL}manage/${id}` });
      navigated = true;
      return true;
    } catch {
      return false;
    }
  }

  async function pageConnection() {
    if (pageCdp) return pageCdp;
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: AbortSignal.timeout(3_000),
    });
    const list = await res.json();
    const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('浏览器里没有可用的页面');
    pageCdp = await connectCdp(page.webSocketDebuggerUrl);
    await pageCdp.send('Network.enable', {});
    return pageCdp;
  }

  /**
   * 读全部 cookie。
   *
   * 正常走 browser target 的 `Storage.getCookies`；某些 Chromium 版本对它
   * 支持不全，退回 page target 的 `Network.getAllCookies`。
   * 后者必须 `Network.enable` 过一次，否则返回空列表——这个坑不报错，只是
   * 你会眼看着「明明登录了却一直读不到票」。
   */
  async function readAllCookies() {
    try {
      const r = await cdp.send('Storage.getCookies', {});
      return r?.cookies ?? [];
    } catch {
      const page = await pageConnection();
      const r = await page.send('Network.getAllCookies', {});
      return r?.cookies ?? [];
    }
  }

  /**
   * 在**页面上下文里**发一个请求，返回一个够 `session.post()` 用的 Response 替身。
   *
   * 为什么不用 Node 直接发：实测同一份票据，Node `fetch` 打十几次后平台稳定回
   * `retcode:10000 系统繁忙`，而同一时刻在页面里 `fetch` 立刻 `retcode:0`。
   * 差别是 TLS/HTTP 指纹，票据本身是好的。所以只要扫码窗口还开着，
   * 就让请求走浏览器，风控看不见「这不是浏览器」。
   *
   * `Set-Cookie` 在页面里读不到（跨站也不暴露），这里返回空数组；
   * 平台下发的 cookie 浏览器自己会收，需要时用 `cookies()` 整份回读。
   */
  async function fetchInPage(url, init = {}) {
    if (!cdp) {
      throw Object.assign(new Error('扫码窗口已关闭，请重新扫码后再操作'), { code: 'NO_BROWSER' });
    }
    const page = await pageConnection();
    const payload = {
      url: String(url),
      method: String(init.method || 'GET'),
      headers: init.headers || {},
      body: init.body == null ? null : String(init.body),
    };
    const expr = `(${PAGE_FETCH_SRC})(${JSON.stringify(payload)})`;
    const r = await page.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    const info = r?.result?.value;
    if (!info || typeof info !== 'object') {
      const msg = r?.result?.exceptionDetails?.text
        || r?.result?.description
        || '页面里发请求失败';
      throw Object.assign(new Error(String(msg)), { code: 'PAGE_FETCH' });
    }
    if (info.error) throw Object.assign(new Error(String(info.error)), { code: 'PAGE_FETCH' });

    return {
      status: Number(info.status) || 0,
      ok: Number(info.status) >= 200 && Number(info.status) < 300,
      headers: { getSetCookie: () => [] },
      async text() {
        return String(info.body ?? '');
      },
      async json() {
        return JSON.parse(String(info.body || 'null'));
      },
    };
  }

  /** 当前浏览器里的票据（Map），给会话层整份替换用 */
  async function cookies() {
    return pickTickets(await readAllCookies());
  }

  async function shutdown() {
    closing = true;
    try { await cdp?.send('Browser.close', {}); } catch { /* 已经关了 */ }
    cdp?.close();
    pageCdp?.close();
    cdp = null;
    pageCdp = null;

    const p = proc;
    proc = null;
    if (p && p.exitCode === null) {
      try { p.kill(); } catch { /* 已经退了 */ }
      /**
       * Windows 上 Chromium 的渲染进程是主进程的子进程，主进程被 kill 后
       * 子进程可能还挂着（表现为窗口残留）。补一刀硬杀，只在这一步做，
       * 不做轮询——正常退出走 `Browser.close`，这里只是兜底。
       */
      const t = setTimeout(() => {
        if (p.exitCode === null) { try { p.kill('SIGKILL'); } catch { /* 已经退了 */ } }
      }, 1_500);
      t.unref?.();
    }
  }

  function onProcExit() {
    if (closing) return;
    if (st.state === 'ok') return;
    if (active()) {
      running = false;
      st.state = 'canceled';
      st.message = '浏览器窗口已关闭';
    }
  }

  async function loop() {
    const deadline = st.startedAt + activeTtl;
    let lastSig = '';
    /** 校验连续失败时的退避：1.5s 死磕会把「平台限频」变成「永远登录不上」 */
    let backoff = 0;

    while (running) {
      await sleep(pollMs);
      if (!running) return;

      if (now() > deadline) {
        st.state = 'expired';
        /**
         * 两种超时要分开说：扫码超时是「人没扫」，续期超时是「profile 里
         * 的登录态也没了」。后者让用户去「重新扫码」是对的，但不能说成
         * 「等待超时」——听起来像是我们等慢了。
         */
        st.message = activeHeadless
          ? 'profile 里的登录态已失效（可能被登出过），需要手动扫码登录'
          : '等待超时，请重新发起扫码';
        await shutdown();
        running = false;
        return;
      }

      let cookies;
      try {
        cookies = await readAllCookies();
      } catch {
        continue;
      }

      const jar = pickTickets(cookies);
      if (!hasTickets(jar)) continue;

      /**
       * 拿到票据就把窗口挪到管理端，**不等校验通过**。
       *
       * 以前是 `verify` 成功后才导航，结果被限频时 `verify` 一直失败，
       * 窗口就永远停在首页 `/#/apps`——用户看到的是「明明显示已登录，
       * 怎么还停在首页不进机器人页」。导航不需要接口，有票就能走。
       */
      /**
       * 只有「人在扫码」时才把窗口挪到机器人页。
       *
       * 自动续期是无头的，没人看那个页面；多导航一次就多一轮 SPA 自己的
       * 接口请求（`list_bots` / `scope_cfg`），正是它让我们紧接着的重试
       * 撞进限频窗口。
       */
      if (activeVerify) await goDashboard();

      /**
       * 窗口一开就「已登录」，是因为扫码窗口用的是独立 profile，上一轮登录
       * 的 cookie 就存在里面（这也是它能持续当请求通道的原因）。不说清楚，
       * 用户会以为「我还没扫码怎么就登录了」。这里如实说明来源。
       */
      if (st.state === 'waiting') {
        st.message = '窗口里已有上次的登录态，正在校验；要换号请点「退出登录」';
      }

      /**
       * 票据没变就不再打接口：dashboard 的 cookie 会随心跳刷新，
       * 每 1.5 秒真发一次 list_bots 等于自己给自己上频控。
       *
       * 签名必须是**值**的指纹，不能只看长度。踩过：用户退出重登后
       * `qticket` 还是 32 位，长度签名一模一样 → 判定「票没变」→
       * 再也不验一次，面板永远停在「等平台同步」。
       * 用指纹不存原文，日志里也泄不出去。
       */
      const sig = ticketSig(jar);
      if (sig === lastSig) continue;
      lastSig = sig;

      const prevState = st.state;
      st.state = 'verifying';
      st.message = '已取到登录态，正在校验…';

      try {
        const botCount = activeVerify && verify ? await verify(jar) : 0;
        st.state = 'ok';
        st.botCount = Number(botCount) || 0;
        st.error = '';
        /**
         * 登录成功后窗口**不再必须**：票据已经拿到，后续请求由 Node 直发。
         * 留着它只是方便用户跟着面板一起看（导航到机器人页），
         * 用户随手关掉也不影响任何操作。
         */
        st.message = st.botCount
          ? `登录成功，读到 ${st.botCount} 个机器人；窗口可以留着看，也可以关掉`
          : '登录成功；窗口可以留着看，也可以关掉';
        log(activeHeadless
          ? '[dev] 后台换票成功（票据已到手，窗口已关）'
          : '[dev] 扫码登录成功（票据已到手，后续走 Node 直发）');
        /**
         * 先放闸，再导航。
         *
         * `goDashboard()` 是一次真的页面跳转，慢的时候要好几秒；票已经到手，
         * 这几秒里 `running` 还挂着，`refresh()` 就会当成「正在扫码」让路，
         * `startScan()` 也会白等——明明已经登录完成了。**同上，`status='ok'`
         * 与 `running=false` 之间不能隔 await**，否则外面会看到一个自相矛盾的
         * 中间态：状态说已登录，`busy` 说还在扫。
         */
        running = false;
        await goDashboard();
        return;
      } catch (e) {
        // 选完主体 / 页面还在跳的时候会短暂 401，退回 waiting 继续等，不判死
        st.state = prevState === 'canceled' ? 'canceled' : 'waiting';
        /**
         * 平台说「繁忙」= 自己把自己打成限频了（或者对方真忙）。
         * 这时 1.5 秒一轮继续打，只会让限频窗口一直续上，所以拉长间隔；
         * 文案也要说清是「在等」而不是「失败」，否则用户以为票据坏了。
         */
        const rateLimited = /繁忙|频繁|限频|rate\s*limit/i.test(String(e?.message ?? ''));
        st.message = rateLimited
          ? '平台限频了，正在放慢节奏重试…'
          : '已取到登录态，正在等平台同步（选完主体后通常几秒）…';
        st.error = String(e?.message ?? e);
        backoff = Math.min(backoff ? backoff * 2 : backoffMs, backoffMaxMs);
        // 退避不能睡过 ttl，否则「超时收尾」会被拖成「还活着」
        await sleep(Math.min(backoff, Math.max(0, deadline - now())));
      }
    }
  }

  async function start({ ttlMs: ttlOverride = 0, verify: wantVerify = true, headless = false } = {}) {
    if (running) return status();
    activeTtl = Number(ttlOverride) > 0 ? Number(ttlOverride) : ttlMs;
    activeVerify = wantVerify !== false;
    activeHeadless = Boolean(headless);
    /**
     * 已经有一个扫码窗口活着（登录成功后它不关）：再点一次「扫码」不能直接
     * 起第二个实例——同一个 `--user-data-dir` 上的第二个进程只会把 URL 转给
     * 已有实例，然后我们等不到 DevToolsActivePort，报「浏览器没能打开调试端口」。
     * 先收掉旧的再开新的。
     */
    if (cdp) await close();

    running = true;
    closing = false;
    st = blank();
    st.state = 'starting';
    st.startedAt = now();
    st.message = '正在启动浏览器…';

    try {
      const wantPath = String(typeof browserPath === 'function' ? browserPath() : browserPath || '').trim();
      const list = finder({ browserPath: wantPath });
      if (!list.length) {
        throw new Error(wantPath
          ? `打不开指定的浏览器：${wantPath}（路径不存在，或者不是 Chromium 系）`
          : '本机没找到 Chromium 系浏览器（Edge / Chrome / Chromium / Brave / Vivaldi）。可以装一个，或在下面手填浏览器路径，或展开「手动粘贴 Cookie」作为备选');
      }
      const exe = list[0];
      st.browser = exe.name;

      await fsp.mkdir(profileDir, { recursive: true });
      const portFile = path.join(profileDir, 'DevToolsActivePort');
      // 上一次留下的端口文件会让 waitDevTools 读到死端口，先清掉
      await fsp.rm(portFile, { force: true });

      proc = spawnFn(exe.path, [
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        /**
         * 扩展必须关掉。
         *
         * Windows 上装在机器级（注册表 External Extensions / 企业策略）的扩展
         * 对**每个新 profile 都生效**：实测新建 profile 后 Edge 自己弹出一个
         * 「正在加载扩展…」标签页在装 AdGuard，抢走焦点还把登录页挤到后台。
         * 这个窗口只是用来扫一次码，任何第三方扩展在这里都只有坏处 ——
         * 多一个能读 cookie 的东西，也多一个能弹窗打断扫码的东西。
         */
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,OptimizationHints',
        `--window-size=${WINDOW}`,
        /**
         * 无头模式：`--headless=new` 是 Chromium 109+ 的新无头，跑的是完整
         * 渲染器（旧的无头对 SPA 支持差，很多页面直接白屏）。
         * 只有自动续期会走到这里，扫码永远是可见窗口。
         */
        ...(activeHeadless ? ['--headless=new', '--mute-audio'] : []),
        LOGIN_URL,
      ], { stdio: 'ignore' });

      proc.once('exit', onProcExit);
      proc.once('error', (e) => {
        if (closing) return;
        running = false;
        st.state = 'error';
        st.error = `启动 ${exe.name} 失败：${e?.message ?? e}`;
        st.message = st.error;
      });

      const url = await waitDevTools(portFile);
      cdp = await connect(url, {
        onClose: () => {
          pageCdp = null;
          if (closing) return;
          cdp = null;
          /**
           * 已经登录成功之后用户又把窗口关了：登录态还在（cookie 已落盘），
           * 但「请求走页面」这条路断了。只降级，不把状态打回未登录——
           * 否则面板会把一次「关窗」显示成一次「登录失败」。
           */
          if (st.state === 'ok') {
            st.message = '扫码窗口已关闭，后续请求会回退到 Cookie 直连（可能被平台风控）';
            return;
          }
          if (active()) {
            running = false;
            st.state = 'canceled';
            st.message = '浏览器已关闭';
          }
        },
      });

      if (!running) return status(); // 启动过程中被 cancel

      st.state = 'waiting';
      st.message = activeHeadless
        ? '后台无头浏览器已就绪，正在等登录态…'
        : '浏览器窗口已打开，请用手机 QQ 扫码登录';
      log(activeHeadless ? '[dev] 后台无头浏览器已就绪' : '[dev] 扫码窗口已就绪');
      loop().catch((e) => {
        log(`[dev] 扫码轮询出错：${e?.message ?? e}`);
      });
    } catch (e) {
      await shutdown();
      running = false;
      if (st.state !== 'canceled') {
        st.state = 'error';
        st.error = String(e?.message ?? e);
        st.message = st.error;
      }
    }
    return status();
  }

  async function cancel() {
    if (!active()) return status();
    running = false;
    st.state = 'canceled';
    st.message = '已取消';
    await shutdown();
    return status();
  }

  /**
   * 静默续期：用**同一个 profile** 开一次窗口，把过期票据换新，拿到就关。
   *
   * 为什么这条能成：profile 里存的是长期登录态（`.qq.com` 那套），
   * 我们手里的 `b-token` 只是它派生出来的短期票据。浏览器一开，页面自己
   * 就会拿长期身份换一张新的 `b-token`——这正是用户看到的「我打开浏览器
   * 还是登录状态，怎么面板说过期了」。
   *
   * 两种进入方式：
   *   · 窗口已经开着 → 直接读 cookie（不重开窗，几百毫秒）
   *   · 窗口关着 → 起一个窗口，等到有票立刻关；**超时也关**，不留残窗
   *
   * 返回 `{ ok, jar }`：`jar` 是票据 Map，交给会话层整份替换。
   */
  async function refresh({ timeoutMs = 25_000, verify: wantVerify = false, headless = true } = {}) {
    /**
     * 正在等用户扫码：别抢，也别把人家的窗口关掉。
     *
     * `skipped` 是给上层看的**关键区别**：这不是「换票失败」，而是「这回合
     * 轮不到换票」。以前上层一律按失败处理，于是用户刚点完扫码，面板上就多
     * 一条红字「自动换票没成功」+ 5 分钟退避——明明什么都没坏。
     */
    if (running) {
      return {
        ok: false,
        skipped: true,
        reason: 'busy',
        message: '正在扫码登录，先等这个流程结束',
      };
    }

    // 窗口本来就开着：直接读，最快也最稳
    if (cdp) {
      try {
        const jar = pickTickets(await readAllCookies());
        if (hasUsableTickets(jar)) return { ok: true, jar, reused: true, closed: false };
      } catch { /* 读不到就走下面重新开窗 */ }
    }

    /**
     * 默认**不校验**：续期的成败由「重试那个真实请求」来判定。
     * 多打一次 `list_bots` 只会把自己送进限频，见 `activeVerify` 的说明。
     */
    await start({ ttlMs: timeoutMs, verify: wantVerify, headless });
    const deadline = now() + timeoutMs + 5_000;

    try {
      let partial = null;
      while (now() < deadline) {
        if (st.state === 'ok') {
          const jar = cdp ? pickTickets(await readAllCookies().catch(() => [])) : new Map();
          if (hasUsableTickets(jar)) return { ok: true, jar, reused: false, closed: true, browser: st.browser };
          /**
           * 只拿到半份（`b-token` 有了、`developer_id_lite` 还没种）就继续等。
           * 抢跑拿走的半份票会让下一次请求又是 401，白换一次。
           */
          if (hasTickets(jar)) partial = jar;
        } else if (st.state === 'error' || st.state === 'canceled' || st.state === 'expired') {
          return { ok: false, reason: st.state, message: st.message || st.error };
        }
        await sleepRef(400);
      }
      return partial
        ? {
          ok: false,
          reason: 'incomplete',
          message: `只拿到 b-token，developer_id_lite 没种出来（页面登录还没完成），${Math.round(timeoutMs / 1000)} 秒内没等到`,
        }
        : {
          ok: false,
          reason: 'timeout',
          message: `等了 ${Math.round(timeoutMs / 1000)} 秒没换到新票（可能 profile 里的登录态也过期了）`,
        };
    } finally {
      /**
       * 一律收窗。
       *
       * 走到这里就意味着「窗口是我们起的」（已经开着的窗口在上面的快速
       * 分支就返回了），所以不管换没换到票都得关掉——这条路径本来就是
       * 后台自动跑的，留在桌面上只会让人莫名其妙。
       */
      await close();
    }
  }

  /**
   * 手动再查一次（面板上的「检查登录状态」）。
   *
   * 为什么需要它：轮询有自己的节奏——校验失败要退避（最慢 15 秒一轮），限频时
   * 更慢；而「扫完码」那一刻人是盯着屏幕等结果的。自动检测也真会漏：页面登录
   * 慢半拍、票刚种上又被页面刷掉、窗口被随手关掉，都会让面板一直停在「等待扫码」。
   *
   * 所以这条路径**不重开窗、不动轮询**，只做一件事：立刻读一次窗口里的 cookie，
   * 够用就真发一次校验，验过了当场把状态推到 ok。半份票不认（见
   * `hasUsableTickets`）——抢跑拿走半份票，下一次请求又是 401。
   */
  async function recheck() {
    if (!cdp || closing) {
      return {
        ok: false,
        reason: 'no-window',
        message: running
          ? '浏览器还在启动，过一秒再点一次'
          : '扫码窗口已经不在了（票据还在手上的话不影响接口）；要重新取票请点「扫码登录」',
      };
    }
    /**
     * 轮询正在校验时别插队：两个 `list_bots` 并发只会把自己打进限频。
     * 等它自己出结果通常就是几百毫秒。
     */
    if (rechecking || st.state === 'verifying') {
      return { ok: false, reason: 'busy', message: '正在校验，过一秒再看' };
    }

    rechecking = true;
    try {
      const jar = pickTickets(await readAllCookies());
      if (!hasTickets(jar)) {
        return {
          ok: false,
          reason: 'no-ticket',
          message: '窗口里还没有登录态：扫码可能还没完成，或者页面刚跳转；过两秒再点一次',
        };
      }
      if (!hasUsableTickets(jar)) {
        return {
          ok: false,
          reason: 'incomplete',
          message: '只拿到半份票据（b-token 有了，developer_id_lite 还没种），等页面加载完再点一次',
        };
      }

      const prevState = st.state;
      st.state = 'verifying';
      st.message = '手动检查：已取到登录态，正在校验…';
      try {
        const botCount = verify ? await verify(jar) : 0;
        st.state = 'ok';
        st.botCount = Number(botCount) || 0;
        st.error = '';
        st.message = st.botCount
          ? `登录成功，读到 ${st.botCount} 个机器人；窗口可以留着看，也可以关掉`
          : '登录成功；窗口可以留着看，也可以关掉';
        // 同上：状态与 running 之间不能隔 await，否则会露出「已登录但还在扫」的中间态
        running = false;
        log('[dev] 手动检查通过：票据已就绪');
        return { ok: true, botCount: st.botCount, message: st.message };
      } catch (e) {
        st.state = prevState === 'ok' ? 'ok' : 'waiting';
        const rateLimited = /繁忙|频繁|限频|rate\s*limit/i.test(String(e?.message ?? ''));
        st.message = rateLimited
          ? '平台限频了：票可能没问题，过一会再点「检查登录状态」'
          : '已取到登录态，但平台还没认（选完主体后通常几秒）；过两秒再点一次';
        st.error = String(e?.message ?? e);
        return { ok: false, reason: 'verify-failed', message: st.message, error: st.error };
      }
    } catch (e) {
      return { ok: false, reason: 'error', message: String(e?.message ?? e) };
    } finally {
      rechecking = false;
    }
  }

  /**
   * 主动关窗（退出登录 / 面板关闭时用）。
   *
   * 和 `cancel()` 的区别：`cancel()` 只对「正在等扫码」有意义，
   * 登录成功后 `active()` 是 false，只能走这里。
   */
  async function close() {
    running = false;
    await shutdown();
    cdp = null;
    pageCdp = null;
    st = blank();
    return status();
  }

  /**
   * 这个 profile 还在不在。
   *
   * 自动续期全靠它：profile 里才有长期登录态，删掉就等于「从没登录过」。
   * 这种情况下再去开窗只会白等 25 秒超时，然后报一个听起来很严重的失败。
   */
  async function hasProfile() {
    try {
      await fsp.access(profileDir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 连 profile 一起删掉。
   *
   * 这个 profile 是扫码窗口专用的独立目录，登录态就存在里面——所以「退出登录」
   * 如果只清内存票据、不删目录，下次开窗依旧是已登录（用户看到的就是
   * 「我明明退出了，怎么一打开又是登录状态」）。真正的退出必须把目录也端掉。
   */
  async function purgeProfile() {
    await close();
    navigated = false;
    try {
      await fsp.rm(profileDir, { recursive: true, force: true });
    } catch { /* 目录被占用（浏览器没退干净）就下次再说 */ }
    return status();
  }

  return {
    start,
    refresh,
    recheck,
    cancel,
    close,
    hasProfile,
    purgeProfile,
    openBotPage,
    status,
    fetchInPage,
    cookies,
    pickTickets,
    _internals: { hasTickets, ticketSig },
  };
}
