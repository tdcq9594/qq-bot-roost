/**
 * 开放平台（开发者后台）能力层
 * ============================
 *
 * 面板的「开放平台」页签、宿主协议 `dev.*`、框架插件都走这里，**只有一份实现**。
 *
 * ## 边界
 *
 * 这里管的是**开发者账号下的机器人配置**：资料、连接方式、IP 白名单、能力开关。
 * 不管机器人自己的菜单/指令面板——那是 `qq.call` 的 `setGlobalMenu` / panels，
 * 权限模型完全不同（机器人 token vs 开发者票据），混在一起会让人以为
 * 「能改资料就能改菜单」。
 *
 * ## 登录：扫码为主，粘贴为备选
 *
 * 服务端直接扫是死路（2026-11-15 实测：`ret:5` 之后没有 `Set-Cookie`，
 * `developer_list` 报「登录鉴权参数异常」，登录态只在页面上下文里种）。
 * 所以默认路径是 `browser.js`：起一个独立 profile 的浏览器窗口，让用户在
 * 那个窗口里正常扫码，再用 CDP 把 httpOnly 票据读回来。
 *
 * 只有在本机没有 Chromium 系浏览器、或扫码被安全软件挡住时，才退到
 * 「从已登录浏览器复制 Cookie / cURL 粘进来」。
 *
 * ## 票据纪律
 *
 * **默认记住**：登录成功就把票据写进 `data/dev-session.json`（0600），
 * 否则用户每次重启框架都得重扫一遍——这是实测最招人烦的一点。面板上
 * 的「记住登录」是**可以关掉**的开关，不是必须手动打开。
 *
 * 文件里只有票据本身，没有机器人列表之类的缓存。`describe()` 永远不带值。
 * 目录跟随 `ROOST_HOME`，删掉这个文件就等于退出登录。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../paths.js';
import { createDevSession, parseCookies, bknOf, DEV_HOST, TICKET_KEYS } from './session.js';
import { DEV_ERRORS, devError } from './errors.js';
import { createScanLogin } from './browser.js';
import { fetchImageLimited } from './url-guard.js';

export { bknOf, DEV_HOST };

/** 文件落点：跟着 data 目录走，测试可以用 ROOST_HOME 隔离 */
const sessionFile = () => path.join(DIRS.data, 'dev-session.json');

/**
 * 「用哪个浏览器扫码」是机器级设置，和登录态分开存。
 *
 * 退出登录会把 `dev-session.json` 删掉，但浏览器路径不该跟着丢——
 * 那台机器上装的是绿色版/自定义路径，这个事实不会因为登出而改变。
 */
const browserFile = () => path.join(DIRS.data, 'dev-browser.json');

/**
 * 从一段文本里抠出 Cookie。
 *
 * 支持的粘贴形态（照实际用户会复制到的东西设计）：
 *   · `p_skey=xxx; qticket_lite=yyy`              —— DevTools 里直接复制 Cookie 值
 *   · `curl 'https://bot.q.qq.com/...' -H 'Cookie: ...'` —— Copy as cURL
 *   · `[{"name":"p_skey","value":"..."}]`         —— 扩展导出的 JSON
 *
 * 识别顺序很重要：cURL 文本里同时有 URL 和 header，先按 `Cookie:` 提，
 * 不要傻乎乎整段当 cookie 字符串切分——那样会得到一堆垃圾键。
 */
export function extractCookies(input) {
  const raw = String(input ?? '');
  if (!raw.trim()) return new Map();

  /**
   * cURL：`-H 'Cookie: a=1; b=2'` / `--header "cookie: ..."` / `-b '...'`。
   *
   * 三种平台的复制格式都要认：
   *   · bash（macOS / Linux / Git Bash）—— 单引号
   *   · cmd —— 双引号、行尾用 `^` 续行
   *   · PowerShell —— `curl.exe`，同样是双引号
   * 所以先剥掉续行符 `^\r?\n`，再统一按「引号里挑 cookie」处理。
   * 用 matchAll 而不是单次匹配：一条 cURL 里偶尔会有两个 cookie 头
   * （浏览器补一个、脚本再带一个），只取第一个会漏票。
   */
  const flat = raw.replace(/\^\r?\n/g, ' ').replace(/\\\r?\n/g, ' ');
  const headers = [...flat.matchAll(/(?:-H|--header)\s+['"]\s*cookie:\s*([^'"]+)['"]/gi)]
    .map((m) => m[1])
    .concat([...flat.matchAll(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/gi)].map((m) => m[1]));
  if (headers.length) {
    const merged = new Map();
    for (const h of headers) for (const [k, v] of parseCookies(h)) merged.set(k, v);
    return merged;
  }

  /**
   * 只复制了「请求头」面板的那一行（DevTools 里选中 header 右键 Copy value）。
   * 没有 `-H` 前缀，但明确带 `cookie:`，能认出来就别当垃圾串切。
   */
  const bare = /(?:^|\n)\s*cookie:\s*([^\n]+)/i.exec(flat);
  if (bare) return parseCookies(bare[1].trim());

  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      return parseCookies(Array.isArray(json) ? json : json?.cookies ?? json);
    } catch {
      /* 不是合法 JSON 就按 cookie 串处理 */
    }
  }

  return parseCookies(trimmed);
}

/**
 * 「只能改当前机器人」这道闸。
 *
 * 面板是**跟着本机跑着的那只鸟**走的：`config/bots/<id>.json` 里写了
 * AppID，页面就只认这一个。原因很实在——开发者账号下通常有好几只，
 * 而票据是**账号级**的，一旦允许在面板里随便挑，改错一只的代价是
 * 「线上那只的 Webhook / IP 白名单被人动了」，还很难看出来。
 *
 * 协议层（插件调用）不经过这里：插件要改谁由它自己显式给 appid，
 * 那是编程接口、看得见代码；面板是给人点的，必须钉死。
 *
 * @param {string} appid    请求里带的 appid
 * @param {string} bound    本机这只鸟的 appid（空 = 配置里还没填）
 * @param {string} [name]   本机这只鸟的名字，只用于报错文案
 */
export function requireBoundAppid(appid, bound, name = '当前机器人') {
  const mine = String(bound ?? '').trim();
  if (!mine) throw devError('NO_LOCAL_APPID', `「${name}」还没填 AppID，先在「机器人」页补上再回来`);
  const want = String(appid ?? '').trim();
  if (!want) throw devError('BAD_APPID', '要给 appid');
  if (want !== mine) {
    throw devError('NOT_BOUND', `只能改「${name}」（AppID ${mine}），不接受 ${want}`);
  }
  return want;
}

/**
 * 从票据里取 developer_id。
 *
 * **`developer_id_lite` 是 32 位十六进制串**（如 `c846ac08cbe603c3e9e0db8a3a5c4e7b`），
 * 不是数字。以前这里把非数字字符全删掉再 `Number()`，等于把
 * `c846ac...` 压成 `8460860339083547` 送上去——平台对不上号，稳定回
 * `retcode:10000 系统繁忙`。查了很久才在官方页面的请求体里抓到真身：
 * SPA 送的是**原样的字符串**。
 *
 * 纯数字的老格式（`o123456`）仍然兼容，转成数字发。
 */
export function developerIdOf(jar) {
  const raw = String(jar.get('developer_id_lite') || '').trim();
  if (!raw) return 0;
  // 十六进制串原样送，别做任何「清洗」
  if (/[a-f]/i.test(raw)) return raw;
  const n = Number(raw.replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 把 `retcode` 归一成给人看的一句话（面板直接显示） */
const friendly = (e) => {
  if (e?.code === 'NOT_LOGGED_IN') return '还没登录开放平台';
  if (e?.code === 'TICKET_EXPIRED' || e?.code === 'NO_SESSION') return '登录已过期，请重新登录';
  const rc = Number(e?.retcode);
  if (rc === 11001) return '这个机器人不在当前开发者主体下';
  if (rc === 11002) return '没有权限操作这个机器人';
  return String(e?.message || e);
};

/**
 * 「这只机器人不在账号里」的两个平台码。
 *
 * 11001/11002 是实测撞出来的：主体不对 / 没权限。把它单拎出来是因为
 * 面板要的结论不是「失败」，而是「你登错号了」——那是一句可执行的提示。
 */
export const BOT_SCOPE_RETCODES = [11001, 11002];

/**
 * 这次失败是不是「票据本身不行」。
 *
 * 判据只认三样：HTTP 401、`retcode` 401（`miss ticket`）、`TICKET_EXPIRED`。
 * 限频（`系统繁忙`）、超时、断网都不算——那种情况下票还是好的，
 * 丢掉它只会让下一轮变成「还没登录」，把一次限频演成一次登录失败。
 */
export function isAuthFailure(e) {
  if (!e) return false;
  if (e.code === 'TICKET_EXPIRED' || e.code === 'NO_SESSION') return true;
  if (Number(e.http) === 401 || Number(e.retcode) === 401) return true;
  return /miss ticket|未登录|登录已过期/i.test(String(e.message ?? ''));
}

/**
 * @param {{log?:(m:string)=>void, fetchImpl?:typeof fetch}} o
 */
export function createDevPlatform({ log = () => {}, fetchImpl = fetch, lookup = null } = {}) {
  /**
   * 传输层：**默认走 Node 直发**。
   *
   * 这里推翻过一次结论。之前 Node 直发稳定回 `retcode:10000 系统繁忙`，
   * 而同一份票在页面里发就 `retcode:0`，于是判定成「TLS 指纹被风控」，
   * 把扫码窗口改成了必须常驻的传输层——代价是用户关掉窗口就全废。
   *
   * 后来按官方页面的请求体对照才发现真凶：`developer_id` 是 32 位 hex 串，
   * 我们把它洗成数字送上去了（详见 `developerIdOf`）。修正后实测：
   *
   *   hex 原样 → retcode 0，3 个机器人，405ms
   *   剥成数字 → retcode 10000
   *
   * 也就是说 Node 直发一直是好的，「限频」是假象。所以默认回到 Node：
   * 扫码窗口只负责「取票 + 给人看」，关掉不影响任何接口调用。
   *
   * 页面通道保留成开关（`ROOST_DEV_PAGE_TRANSPORT=1`）：万一哪天平台真按
   * 客户端指纹收紧，还能一键切回去，不用重写。
   */
  const usePageTransport = process.env.ROOST_DEV_PAGE_TRANSPORT === '1';
  let pageTransport = null;
  /**
   * 自动续期的钩子。
   *
   * 会话层在收到平台 401 时会调它一次；这里晚一点才能拿到 `scanner`，所以
   * 先放一个可替换的函数，等扫码器建好再赋值。
   */
  let renewHandler = null;

  const session = createDevSession({
    log,
    onExpired: (e) => (renewHandler ? renewHandler(e) : false),
    fetchImpl: async (url, init) => {
      if (usePageTransport && pageTransport) {
        const res = await pageTransport(url, init);
        if (res) return res;
      }
      return fetchImpl(url, init);
    },
  });

  /** 最近一次写操作，面板用来做「刚才改了什么」的回显 */
  let lastWrite = null;

  /** `list_bots` 的结果缓存，见 `listBots` 里的说明 */
  let botsCache = null;

  /** 本次扫码要不要把票据落到本机（面板上的「记住登录」，发起时定） */
  let scanRemember = false;

  /**
   * 用户明确关掉了「记住登录」。
   *
   * 光靠「文件在不在」判断不够：取消勾选是删文件，而**正在跑的自动续期**
   * 可能在删之前已经判断过 `hasSaved()`，换票成功后一 `save` 就把文件写回来——
   * 表现就是「取消了没用，刷新还是已记住」。所以除了删文件，还落一个会话级
   * 标志，续期那条路径看到它就不许写盘。
   */
  let rememberOff = false;

  /**
   * 「记住登录」偏好**落到后端**。
   *
   * 之前这个选择只存在浏览器的 localStorage 里，后端完全不知道——于是重启时
   * `devTicket` 看到磁盘上有票（哪怕早过期了）就照旧开无头浏览器换票，
   * 用户看到的是「我都没登录，怎么又在后台登录」。
   *
   * 现在偏好写盘，启动时按它决定：
   *   · `remember:false` → 连**历史残留**一起清（票 + 扫码 profile），不自动续期；
   *   · 没存过 → 按 `true`（保持老行为，不能因为升级就把大家的登录踢掉）。
   */
  const prefFile = () => path.join(DIRS.data, 'dev-remember.json');
  let prefLoaded = null;

  async function loadPref() {
    try {
      const j = JSON.parse(await fs.readFile(prefFile(), 'utf8'));
      rememberOff = j?.remember === false;
    } catch {
      /** 没存过 = 默认记住（老用户升级后行为不变） */
      rememberOff = false;
    }
    if (rememberOff) {
      /**
       * 用户说过「别记住」：把上一版留下的东西收拾干净。
       *
       * 旧版本取消勾选只删票、不删 profile，所以升级后第一次启动必须补这一刀，
       * 否则「我没登录」和「后台在换票」会同时成立。
       */
      await wipe();
      try {
        if (!scanner.status?.().busy) await scanner.purgeProfile?.();
      } catch (e) {
        log(`[dev] 清理扫码 profile 失败（不影响启动）：${e?.message ?? e}`);
      }
    }
    return rememberOff;
  }

  /** 懒加载：构造函数是同步的，所以第一次用到时再读 */
  function ensurePref() {
    prefLoaded ??= loadPref();
    return prefLoaded;
  }

  async function savePref(on) {
    try {
      await fs.mkdir(DIRS.data, { recursive: true });
      await fs.writeFile(prefFile(), JSON.stringify({ remember: Boolean(on), at: Date.now() }, null, 2), {
        mode: 0o600,
      });
    } catch (e) {
      log(`[dev] 记住登录偏好没写成：${e?.message ?? e}`);
    }
  }

  /** 手填的浏览器路径，空 = 自动探测；扫码器每次 start 时现读，改了立刻生效 */
  let browserPath = '';

  /**
   * 扫码登录器。
   *
   * `verify` 是唯一把「cookie」和「接口」连起来的地方：票据装进会话 →
   * 真发一次 `list_bots`。通了才算登录成功，不通说明用户还在选主体、
   * 或者这个号根本没有开发者权限——两种都不该让面板显示「已登录」。
   */
  const scanner = createScanLogin({
    log,
    /** 传函数而不是值：面板改路径后不用重建扫码器，下次 start 就生效 */
    browserPath: () => browserPath,
    verify: async (jar) => {
      session.adopt(jar);
      /**
       * 换了票就可能换了号：上一份票缓存下来的「账号下有哪几只」必须作废，
       * 否则刚登进去的 30 秒里读到的仍是上一个账号的列表。
       */
      botsCache = null;
      try {
        const bots = await listBots();
        /** 扫码成功写盘同样要尊重「记住」开关：`scanRemember` 是发起时的选择，可能已过期 */
        if (scanRemember && !rememberOff) await save(Object.fromEntries(session.jar()));
        /**
         * 人已经手动登上了 → 之前那条「自动换票没成功」是上一轮的结论，作废。
         * 不清的话它会一直挂在「已登录」下面，看着像还得再扫一次。
         */
        resetRenewState();
        return bots.length;
      } catch (e) {
        /**
         * 只有「票确实是废的」才扔。
         *
         * 以前不分青红皂白 `clear()`：平台回一句 `系统繁忙`（限频）也把票丢了，
         * 于是下一次轮询 `post()` 直接报「还没登录开放平台」，
         * 面板上看到的是「登录失败」，实际只是被限频了——误导。
         * 票是好的就留着，等下一轮重试。
         */
        if (isAuthFailure(e)) session.clear();
        throw e;
      }
    },
  });

  /* ---------------- 自动续期（票据过期就开窗换票，拿到即关） ---------------- */

  /**
   * 为什么需要它：我们手里存的只是 `b-token` 这类**短期派生票**，而扫码用的
   * profile 里躺着一整套长期登录态。所以「面板说过期了、浏览器打开还是登录的」
   * 不是错觉——那份长期身份还活着，只是没人拿它换新票。
   *
   * 这里就补上这一环：平台一回 401，就用同一个 profile 开一次窗口，让页面
   * 自己换出新的 `b-token`，拿到立刻关窗、整份替换票据，然后**只重试一次**
   * 刚才那个请求。用户体验上就是「卡了一下，然后自己好了」。
   *
   * 三道闸，缺一不可：
   *   · `ROOST_DEV_AUTO_RELOGIN=0` 可整体关掉（自动化环境不该突然弹窗）
   *   · 20 秒内只尝试一次（否则一串并发请求会各开一次窗）
   *   · 续期过程中不再重入（续期自己要校验票据，校验失败会再触发一次 401）
   */
  let autoRenewDisabled = String(process.env.ROOST_DEV_AUTO_RELOGIN ?? '') === '0';
  let autoRenewAt = 0;
  let autoRenewing = false;
  let autoRenewPromise = null;
  /** 面板回显用：上次续期是什么时候、成没成 */
  let autoRenewInfo = { at: 0, ok: true, reason: '', message: '' };
  /** 正在「导入并验证」时不要自动开窗：那本来就是一次票据校验 */
  let suspendAutoRenew = false;
  /**
   * 失败之后的冷却。
   *
   * 如果 profile 里的登录态真的没了（用户登出过），每次请求都去开一个无头
   * 浏览器白白跑 25 秒，机器上会看到浏览器进程反复起落。失败一次就退避
   * 5 分钟，把「自动」留在真正能自愈的场景里。
   */
  let autoRenewBackoffUntil = 0;

  async function autoRelogin() {
    /**
     * 偏好先读出来：`remember:false` 的人，**任何路径都不该被开浏览器**。
     *
     * 这就是「我都没登录，怎么又在后台登录」的根：以前只看磁盘上有没有票，
     * 而票是上一轮留下的、早就过期了。
     */
    await ensurePref();
    if (rememberOff) return false;
    if (autoRenewDisabled || suspendAutoRenew || autoRenewing) return false;
    if (Date.now() < autoRenewBackoffUntil) return false;

    /**
     * 人正在扫码 → 自动续期让路，**而且不算失败**。
     *
     * 这两条路径会真的打架：它们共用同一个 `--user-data-dir`，扫码窗口开着
     * 的时候再起一个无头实例，第二个进程只会把 URL 转给已有实例、等不到调试
     * 端口；两边收尾又都会 `close()`，谁先结束谁把对方的窗口一起关掉。
     *
     * 更要紧的是**触发时机**：扫码成功那一刻，`verify()` 会拿刚到手的票据打
     * 一次 `list_bots`，票还没「生效」时平台回 401，正好被续期钩子接住——
     * 于是「登录刚成功」和「自动换票失败」同时出现。实测就是这个场面：
     * 面板红字说换票没成功，其实人正在扫码，扫完自然有票。
     *
     * 所以这里只记一条中性状态：不设退避、不动 `autoRenewAt`（扫完/取消后
     * 真过期了要能立刻换），也不写日志刷屏。
     */
    if (scanner.status?.().busy) {
      if (autoRenewInfo.reason !== 'scan-busy') {
        autoRenewInfo = {
          at: Date.now(), ok: false, skipped: true,
          reason: 'scan-busy', message: '正在扫码登录，自动换票先让路（扫完就有新票）',
        };
        log('[dev] 正在扫码登录，自动换票先让路（本轮不需要换票）');
      }
      return false;
    }

    if (Date.now() - autoRenewAt < 20_000) return false;
    if (autoRenewPromise) return autoRenewPromise;

    /**
     * 从没登录过 / 已经退出登录 → **根本不尝试续期**。
     *
     * 续期能成的前提是「扫码 profile 里还留着长期登录态」。这个前提不成立时
     * 开窗只会白等 25 秒，然后把「用户还没登录」写成一条失败——面板上就变成
     * 「自动换票没成功」，而用户连一次登录都还没完成。
     *
     * 两道判断都要过：手里有票（没票连 401 都发不出来）+ 机器上还留着 profile
     * 或存过票。手动粘 cURL 进来的票没有 profile，也只能走手动重登。
     */
    if (!session.has()) return false;
    if (!(await scanner.hasProfile?.()) && !(await hasSaved())) {
      if (autoRenewInfo.reason !== 'no-login') {
        autoRenewInfo = {
          at: Date.now(), ok: false, skipped: true,
          reason: 'no-login',
          message: '本机没有登录记录（profile 已没有），不能后台换票，需要手动扫码',
        };
        log('[dev] 本机没有扫码登录记录，跳过自动换票');
      }
      return false;
    }

    /**
     * 默认**后台无头**：这条路径由请求触发，不该在桌面正中弹一个窗口。
     * 某些环境（远程桌面、被安全软件拦、老旧内核）无头跑不起来，可以用
     * `ROOST_DEV_REFRESH_MODE=window` 换回可见窗口——只作调试用途。
     *
     * 这两个值必须在**任何用到它们的地方之前**算出来。踩过：声明写在 `log()`
     * 之后，而 `log()` 里已经引用了它 → `Cannot access 'wantWindow' before
     * initialization`，而且这一抛发生在 try 外面，`autoRenewing` 就永远卡在
     * true，后续所有自动续期都被自己的闸挡住（面板一直显示「正在换票」）。
     */
    const wantWindow = String(process.env.ROOST_DEV_REFRESH_MODE ?? '').toLowerCase() === 'window';
    const headless = !wantWindow;

    autoRenewAt = Date.now();
    autoRenewing = true;

    /**
     * 这一段包在 try 里是**必须**的。
     *
     * `autoRenewing` 是防重入闸，只由这里的 finally 放下来。之前踩过：在设完
     * 标志之后、进 try 之前抛了一个 TDZ 错，闸就永远关着——表现是「面板一直
     * 说正在换票，但再也不换了」，比重试失败难查得多。
     */
    try {
      autoRenewInfo = { at: Date.now(), ok: true, reason: 'running', message: '正在后台换新票据…' };
      log(`[dev] 票据过期，用扫码 profile 在${wantWindow ? '前台窗口' : '后台'}换一张新票…`);

      autoRenewPromise = (async () => {
        try {
          const r = await scanner.refresh({ timeoutMs: 25_000, headless });
          if (!r?.ok) {
            /**
             * `skipped`（扫码抢在前面）不是失败：不进退避，也不把红字写到
             * 面板上。真按失败处理的话，用户点一次扫码就能换来 5 分钟
             * 「不再自动尝试」——本来该自愈的场景被自己关掉了。
             */
            if (r?.skipped) {
              autoRenewInfo = {
                at: Date.now(), ok: false, skipped: true,
                reason: 'scan-busy',
                message: r?.message || '正在扫码登录，自动换票先让路（扫完就有新票）',
              };
              // 把 20 秒节流清零：扫码被取消后如果票真的是废的，下一发 401 要能立刻换
              autoRenewAt = 0;
              log('[dev] 自动换票让路：正在扫码登录，不设退避');
              return false;
            }
            const why = r?.message || '没换到新票，需要手动扫码登录';
            autoRenewInfo = {
              at: Date.now(), ok: false, reason: r?.reason || 'failed',
              message: headless ? `${why}（后台模式；设 ROOST_DEV_REFRESH_MODE=window 可看窗口）` : why,
            };
            // 失败一次就退避：别让「登录态真没了」变成「隔 20 秒开一次浏览器」
            autoRenewBackoffUntil = Date.now() + 5 * 60_000;
            log(`[dev] 自动换票失败（5 分钟内不再尝试）：${r?.reason}${r?.message ? `（${r.message}）` : ''}`);
            return false;
          }
          // 整份替换：新票和旧票混着用会 401（旧 cookie 可能已经被平台作废）
          session.adopt(r.jar);
          /**
           * 写回票据要同时满足两条：原本就存过 + 用户没关掉「记住」。
           *
           * 只看 `hasSaved()` 会有竞态：取消勾选删文件的同时续期正好在写，
           * 文件被复活，面板又显示「已记住」。`rememberOff` 是会话内的硬否决。
           */
          if (!rememberOff && (await hasSaved())) await save(Object.fromEntries(session.jar())).catch(() => {});
          // 换票之后「账号下有几只」可能变（换号了），缓存必须作废
          botsCache = null;
          autoRenewBackoffUntil = 0;
          autoRenewInfo = {
            at: Date.now(), ok: true, reason: '',
            message: r.reused ? '复用了已打开的窗口' : '后台取票后已自动关闭',
          };
          log('[dev] 自动换票成功，票据已更新');
          /**
           * 换票成功**就算成功**，不再在这里反复试：平台刚放出来的票有几十秒
           * 「还没生效」的窗口，连打只会把恢复时间往后推，用户还得盯三次失败。
           * 改成排一次 65 秒后的补拉，成了就把状态翻回正常，失败也有据可查。
           */
          scheduleWarmup();
          return true;
        } catch (e) {
          autoRenewInfo = { at: Date.now(), ok: false, reason: 'error', message: String(e?.message ?? e) };
          autoRenewBackoffUntil = Date.now() + 5 * 60_000;
          log(`[dev] 自动换票出错（5 分钟内不再尝试）：${e?.message ?? e}`);
          return false;
        } finally {
          autoRenewing = false;
          autoRenewPromise = null;
        }
      })();

      return autoRenewPromise;
    } catch (e) {
      // 连「起一次续期」都没成功（比如上面那种初始化错误）：把闸放回去，别锁死
      autoRenewing = false;
      autoRenewPromise = null;
      autoRenewBackoffUntil = Date.now() + 5 * 60_000;
      autoRenewInfo = { at: Date.now(), ok: false, reason: 'error', message: String(e?.message ?? e) };
      log(`[dev] 自动续期启动失败（5 分钟内不再尝试）：${e?.message ?? e}`);
      return false;
    }
  }

  /**
   * 换票后的「补一次」。
   *
   * 为什么是 65 秒：实测换票后平台有一段时间不接受新会话的请求（连试 5s /
   * 10s / 20s 全撞 `10000`），而 65 秒后再打就正常了。宁可等够，也不要让用户
   * 看到三次失败——那三次除了把恢复时间往后推，没有任何用处。
   *
   * 补拉成不成都要留记录（`status.warmup`），面板据此决定「要不要现在刷新」。
   */
  const warmupWaitMs = () => {
    const n = Number(process.env.ROOST_DEV_RENEW_WAIT_MS ?? 65_000);
    return Number.isFinite(n) && n >= 0 ? n : 65_000;
  };
  let warmupTimer = null;
  /** 最近一次补拉的结果：`ok: null` 表示还没跑 */
  let warmupInfo = { at: 0, ok: null, botCount: null, reason: '' };

  /**
   * 数据已经能拿到了 → 把排着的补拉撤掉。
   *
   * 不加这一条就会出现「即时重试已经成功、65 秒后又白打一次」——实测碰到过。
   * 补拉存在的意义是「当时没好、过一会再补」，好了就不该再补。
   */
  function cancelWarmup(botCount = null) {
    if (!warmupTimer) return;
    clearTimeout(warmupTimer);
    warmupTimer = null;
    warmupInfo = { at: Date.now(), ok: true, botCount, reason: '' };
    log('[dev] 已经能取到数据，取消排定的补拉');
  }

  function scheduleWarmup() {
    if (warmupTimer) clearTimeout(warmupTimer);
    const wait = warmupWaitMs();
    warmupInfo = { at: 0, ok: null, botCount: null, reason: '' };
    warmupTimer = setTimeout(async () => {
      warmupTimer = null;
      try {
        // 这一发是计划内的：先把上一轮留下的冷却解开，否则会在本地被拦下
        session.clearCooldown?.();
        const bots = await listBots({ maxAgeMs: 0 });
        warmupInfo = { at: Date.now(), ok: true, botCount: bots.length, reason: '' };
        log(`[dev] 补拉成功：平台已放开，${bots.length} 只机器人`);
      } catch (e) {
        warmupInfo = {
          at: Date.now(), ok: false, botCount: null,
          reason: `${e?.code ?? ''} ${e?.message ?? e}`.trim(),
        };
        log(`[dev] ${Math.round(wait / 1000)} 秒后补拉仍失败：${warmupInfo.reason}`);
      }
    }, wait);
    // 别为了一个补拉把进程吊着：定时器不阻止退出
    warmupTimer.unref?.();
    log(`[dev] 已排定 ${Math.round(wait / 1000)} 秒后补拉一次`);
  }

  /**
   * 「人已经登录成功了」→ 把上一轮换票的**结论**作废。
   *
   * 踩过的场面：扫码过程中 `verify` 撞了一次 401，自动换票被钩起来，跑满 25 秒
   * 只拿到半份票（`b-token` 有了、`developer_id_lite` 没种），于是在面板上留下
   * 一条红字「自动换票没成功……3 分钟内不会再自动尝试」。人其实已经登进去了，
   * 这条红字却一直挂在「已登录」下面——用户以为还得再扫一次，越点越乱。
   *
   * 清的是**结论**，不是能力：退避归零、排定的补拉撤掉，之后再真过期，401 还能
   * 立刻触发一次换票。
   */
  function resetRenewState() {
    autoRenewInfo = { at: 0, ok: null, reason: '', message: '' };
    autoRenewBackoffUntil = 0;
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
    warmupInfo = { at: 0, ok: null, botCount: null, reason: '' };
  }

  /** 挂到会话上：只有「平台明确说 401」才会走到这里 */
  renewHandler = autoRelogin;

  /** 有扫码窗口就走页面，没有返回 `null` 表示「交给 Node」 */
  pageTransport = async (url, init) => {
    if (!scanner.status?.().alive) return null;
    try {
      return await scanner.fetchInPage(url, init);
    } catch (e) {
      if (e?.code === 'NO_BROWSER') return null; // 刚关掉，退回 Node
      throw e;
    }
  };

  async function load() {
    try {
      const text = await fs.readFile(sessionFile(), 'utf8');
      const json = JSON.parse(text);
      if (json?.cookies) session.adopt(json.cookies);
      log('[dev] 已恢复本机保存的登录态');
    } catch {
      /* 没有文件 / 坏了都当没登录 */
    }
    try {
      const json = JSON.parse(await fs.readFile(browserFile(), 'utf8'));
      if (json?.path) browserPath = String(json.path);
    } catch {
      /* 没配过 */
    }
  }

  /**
   * 设置 / 清除手填的浏览器路径。
   *
   * 设置时会 stat 一次：路径打错要在这里就报出来，不能等用户点了「扫码登录」
   * 才在浏览器启动阶段失败——那时候面板上只剩一句「启动失败」。
   */
  async function setBrowserPath(input) {
    const p = String(input ?? '').trim();
    if (p) {
      try {
        await fs.access(p);
      } catch {
        throw Object.assign(new Error(`这个路径不存在：${p}`), { http: 400, code: 'BAD_PATH' });
      }
    }
    browserPath = p;
    await fs.mkdir(DIRS.data, { recursive: true });
    if (p) {
      await fs.writeFile(browserFile(), JSON.stringify({ path: p }, null, 2), { mode: 0o600 });
    } else {
      try {
        await fs.unlink(browserFile());
      } catch {
        /* 本来就没有 */
      }
    }
    log(p ? `[dev] 扫码浏览器已指定：${p}` : '[dev] 扫码浏览器改回自动探测');
    return { browserPath };
  }

  async function save(cookies) {
    await fs.mkdir(DIRS.data, { recursive: true });
    await fs.writeFile(sessionFile(), JSON.stringify({ cookies, savedAt: Date.now() }, null, 2), {
      mode: 0o600,
    });
  }

  async function wipe() {
    try {
      await fs.unlink(sessionFile());
    } catch {
      /* 本来就没有 */
    }
  }

  const ready = () => session.has();

  function requireReady() {
    if (!ready()) throw devError('NOT_LOGGED_IN', '还没登录开放平台');
  }

  /**
   * 导入票据。
   *
   * @param {string} input Cookie / cURL / JSON
   * @param {{remember?:boolean}} [o]
   */
  async function loginImport(input, { remember = true } = {}) {
    const jar = extractCookies(input);
    if (!jar.size) {
      throw devError('NO_COOKIE', '没认出 Cookie');
    }
    /**
     * 认出 cookie 不等于认出**票据**。
     *
     * 浏览器里同一个域下几十个无关 cookie，用户从别处顺手复制一段过来，
     * 以前会被当成「票据不可用」发出去打一次接口，回来只剩一句模糊的 401。
     * 先在本地筛一遍：一个票据键都没有就直接说清楚，别浪费一次平台请求
     * （`list_bots` 是最容易被打进限频的那个）。
     */
    const keys = [...jar.keys()].filter((k) => TICKET_KEYS.includes(k));
    if (!keys.length) {
      const seen = [...jar.keys()].slice(0, 6).join(', ') || '无';
      throw devError('NO_TICKET', `这段里没有开放平台票据（认出的键：${seen}）`);
    }
    session.adopt(jar);
    /**
     * 导入期间关掉自动续期：这次本来就是「验一下这串票据行不行」，
     * 一失败就自己开窗换票，会把「你粘错了」变成「看起来成功了」。
     */
    suspendAutoRenew = true;
    try {
      const bots = await listBots();
      /** 导入时勾没勾「记住」同样落一个否决位，后面自动续期才不会把文件写回来 */
      rememberOff = !remember;
      await savePref(remember);
      if (remember) await save(Object.fromEntries(session.jar()));
      /** 选了「不记住」就把旧票也清掉：留着的话下次启动又会被当成「已记住」 */
      else await wipe();
      // 手动粘进来的票已经验通了：上一轮「换票失败」的红字不该继续挂着
      resetRenewState();
      // keys 只回**键名**，值不出后端：名字够用来判断「是不是漏了 httpOnly 的那个」
      return { ok: true, ...session.describe(), botCount: bots.length, keys };
    } catch (e) {
      session.clear();
      const hint = keys.includes('b-token') || keys.includes('p_skey')
        ? ''
        : '（这段缺 b-token / p_skey，它们一般是 httpOnly，只有 Copy as cURL 才带得出来）';
      throw devError('BAD_TICKET', `票据不可用：${friendly(e)}${hint}`, { keys });
    } finally {
      suspendAutoRenew = false;
    }
  }

  /**
   * 登录之后改「记不记住」——面板上那个勾选框走的就是这个。
   *
   * 以前这个勾只在**发起登录前**读一次，所以用户的遭遇是：已经登录了，
   * 勾上它、刷新页面，勾又变回空的，票据也从来没落过盘。看起来像「少了
   * 一个保存按钮」，实际是这个勾根本没有生效的时机。
   *
   * 现在勾/取消勾立刻落到本机：勾上 = 把内存里这份票写盘，取消 = 删文件
   * （内存里的登录态保留，重启才需要重登）。返回 `remembered` 供面板回显。
   *
   * **例外：这张票已经被平台判过 401 时，取消「记住」会连内存票一起作废。**
   * 那种票留着没有任何用处——自动换票被 `rememberOff` 挡住了，它自愈不了，
   * 面板只会一直挂着「登录已过期」，而用户刚说过「别记住」，他以为自己退干净了。
   * 返回值里用 `droppedExpired` 告诉面板这一刀砍了。
   */
  async function setRemember(on) {
    const want = Boolean(on);
    rememberOff = !want;
    /** 偏好落到后端：重启后只有它知道该不该自动续期 */
    await savePref(want);
    /** 取消时顺手作废的废票：面板据此把话说全 */
    let droppedExpired = false;
    if (want) {
      requireReady();
      await save(Object.fromEntries(session.jar()));
    } else {
      await wipe();
      /**
       * **取消「记住登录」= 本机不再保留登录态**，所以连扫码用的浏览器 profile
       * 一起清掉。
       *
       * 只删票据文件是不够的：那份 profile 里躺着 QQ 的长期登录 cookie，
       * 后台续期会拿它自动换票——用户看到的是「我明明没让它记住，怎么还每次
       * 都在后台登录」。清掉之后 `autoRelogin` 的前提（profile 或存过票）
       * 不成立，自然不再开浏览器；内存里的票仍然可用，重启才需要重扫。
       */
      try {
        /** 正在扫码时别清：那会把用户眼前那个窗口一起关掉，等他扫完再说 */
        if (!scanner.status?.().busy) await scanner.purgeProfile?.();
      } catch (e) {
        log(`[dev] 清理扫码 profile 失败（不影响本次会话）：${e?.message ?? e}`);
      }
      /**
       * 票还活着就留着（用户不该为了「不记住」重扫一次）；
       * 已经被判过 401 的直接作废——留一张换不掉的废票只会让面板一直红字。
       */
      if (session.has() && session.describe().expired) {
        session.clear();
        botsCache = null;
        droppedExpired = true;
        log('[dev] 这张票已被平台判过期，取消「记住登录」时一并作废');
      }
    }
    return { ok: true, remembered: await hasSaved(), droppedExpired };
  }

  async function logout() {
    // 登录成功后扫码窗口是「请求通道」，退出登录必须把它一起关掉
    // 连 profile 一起删：只清内存的话，下次开窗还是已登录状态
    await scanner.purgeProfile?.();
    await scanner.close();
    session.clear();
    botsCache = null;
    await wipe();
    return { ok: true };
  }

  /** 发起扫码登录：拉起独立浏览器窗口，用户在里面用手机 QQ 扫 */
  async function startScan({ remember = true } = {}) {
    /**
     * 后台正在换票时先等它收尾，再开扫码窗口。
     *
     * 两边用同一个 `--user-data-dir`，而且都会 `close()`：直接开第二个实例，
     * 要么等不到调试端口，要么被续期的 `finally { close() }` 连窗带登录态
     * 一起关掉——用户看到的是「窗口一闪就没了」。续期自己有 25 秒上限，
     * 等这几秒比抢那一下划算。
     */
    if (autoRenewing && autoRenewPromise) {
      log('[dev] 后台正在换票，等它收尾后再开扫码窗口');
      await autoRenewPromise.catch(() => false);
    }
    scanRemember = Boolean(remember);
    /** 发起扫码时也同步一次否决位：面板可能刚把勾去掉，而 `scanRemember` 是上次的 */
    rememberOff = !scanRemember;
    await savePref(scanRemember);
    /** 同上：本次不记就顺手清掉旧票，别让上次的选择继续生效 */
    if (!scanRemember) await wipe();
    return scanner.start();
  }

  async function cancelScan() {
    return scanner.cancel();
  }

  /**
   * 面板上的「检查登录状态」。
   *
   * 存在的理由：自动检测再稳也有漏的时候——轮询在退避里、页面登录慢半拍、
   * 票刚种上又被页面刷掉、窗口被用户随手关掉。用户扫完了却看不到「已登录」，
   * 唯一的自救方式不该是「再扫一次码」。
   *
   * 两条路，按「窗口还在不在」分：
   *   · 窗口还在 → 让扫码器立刻读一次 cookie 并真发一次校验（可能顺手换到更新的票）
   *   · 窗口没了 → 用手里这张票直接 `list_bots`，至少给一个明确结论
   *
   * 返回里 `recheck` 单独一包，不跟 HTTP 的 `ok` 混——「请求成功」和
   * 「检查结果是已登录」是两件事。
   */
  async function recheckLogin({ bound = null } = {}) {
    const r = await scanner.recheck();
    if (r?.ok) {
      botsCache = null;
      resetRenewState();
      return {
        ...(await status()),
        recheck: { ok: true, message: `已确认登录：读到 ${Number(r.botCount) || 0} 个机器人` },
      };
    }

    /**
     * 窗口不在了，但手里还有票：拿它真发一次请求。
     *
     * 这一条不能省。扫码成功后窗口可以随手关掉（票已经落到 Node 这边），
     * 此时「检查登录状态」如果只会回一句「没有窗口」，用户会以为按钮坏了。
     */
    if (r?.reason === 'no-window' && session.has()) {
      const out = await checkSession({ verify: true, bound });
      /**
       * 这五个状态都说明**票据是好的**（只是可能登错了号 / 没填 AppID）；
       * `busy` / `renewed-wait` / `expired` / `error` 是「没核成」或「票废了」，
       * 不能算「已确认登录」——否则按钮会把一次失败说成成功。
       */
      const usable = ['ready', 'logged-in', 'no-appid', 'account-empty', 'bot-missing']
        .includes(String(out?.state || ''));
      return {
        ...(await status()),
        recheck: {
          ok: usable,
          state: out?.state || '',
          message: usable
            ? `${out?.message || '票据可用'}（扫码窗口已关，用的是手里这张票）`
            : `${out?.message || '票据不可用'}${out?.hint ? `：${out.hint}` : ''}`,
        },
      };
    }

    return {
      ...(await status()),
      recheck: {
        ok: false,
        reason: r?.reason || 'unknown',
        message: r?.message || '没检测到登录态，请点「扫码登录」重新登一次',
      },
    };
  }

  async function status() {
    /** 读偏好时会顺手清理「取消记住」留下的残留，面板拿到的就是清理后的真实状态 */
    await ensurePref();
    return {
      ...session.describe(),
      remembered: await hasSaved(),
      /**
       * 扫码 profile 还在不在。
       *
       * 面板要用它判断「取消记住之后是不是真清干净了」：只删票据文件、profile
       * 还留着的话，后台续期照样能自动登录——用户看到的是「我没让它记住，
       * 怎么每次打开还在登录」。
       */
      profile: Boolean(await scanner.hasProfile?.()),
      lastWrite,
      /** 手填的浏览器路径（空 = 自动探测）；面板要回显，改完不用猜 */
      browserPath,
      /** 扫码进度：面板直接照着这个字段渲染，不用自己维护状态机 */
      scan: scanner.status(),
      /**
       * 自动续期：票据一过期就开窗换票、拿到就关。
       * 面板要能说明「刚才那个窗口是干嘛的」，否则用户只会看到浏览器自己弹出来。
       */
      autoRelogin: {
        enabled: !autoRenewDisabled,
        /**
         * 防重入闸当前是开还是关。
         *
         * 单独暴露是因为它会**卡死**：一旦某次续期在放闸之前抛错，之后所有
         * 自动续期都会静默失效（面板还显示「正在换票」）。有了这个字段，
         * 面板和测试都能直接把「卡住」看见。
         */
        running: autoRenewing,
        last: autoRenewInfo,
        /**
         * 扫码占用着浏览器：续期此时**注定让路**。
         *
         * 露出来是为了让面板能把「换票没成功」和「人正在扫码」分开说——
         * 这两件事同时出现时，只有后者是真的，前者会自动消失。
         */
        scanBusy: Boolean(scanner.status?.().busy),
        /** 失败退避还剩多久：面板据此说明「这段时间不会再自动试」 */
        retryInMs: Math.max(0, autoRenewBackoffUntil - Date.now()),
        /** 65 秒后的补拉：`ok:null` = 还没跑，`ok:true` = 平台已放开 */
        warmup: warmupInfo,
        /** 补拉是否还排在队里 */
        warmupPending: Boolean(warmupTimer),
      },
    };
  }

  /**
   * 「到底能不能干活」的一次性健康检查。
   *
   * 面板和外部工具都需要回答同一个问题，而答案有**六个**状态，不是布尔：
   *
   *   need-login     本机没有票据                → 去扫码 / 粘 cURL
   *   logged-in      有票，但没向平台确认过      → 只查本地时的结果
   *   no-appid       有票，本机机器人没填 AppID  → 去「机器人」页填
   *   account-empty  平台说你名下没有机器人      → 登错号了
   *   bot-missing    账号里有机器人，但没有这只  → 登错号 / AppID 不对
   *   ready          对得上，可以改
   *
   * 为什么不复用 `/status` + `/bots` 两次调用再让前端拼：拼错了就会出现
   * 「面板显示已就绪，其实一只机器人都不在名下」这种最难查的状态。
   * `verify=false` 只查本地（不发网络请求，适合页面初始化）；`verify=true`
   * 才真发一次 `list_bots`（有 30 秒缓存，不会把平台打进限频）。
   *
   * @param {{verify?:boolean, bound?:{id?:string,name?:string,appid?:string}}} o
   */
  async function checkSession({ verify = false, bound = null } = {}) {
    const st = await status();
    const appid = String(bound?.appid ?? '').trim();
    const out = {
      ...st,
      bound: bound ?? null,
      verified: false,
      botCount: null,
      matched: null,
      state: 'need-login',
      code: 'NOT_LOGGED_IN',
      message: '还没登录开放平台',
      hint: '点「扫码登录」，或在「备选」里粘一次 cURL',
    };

    if (!st.loggedIn) return out;

    if (!verify) {
      return {
        ...out,
        state: appid ? 'logged-in' : 'no-appid',
        code: appid ? 'OK' : 'NO_LOCAL_APPID',
        message: appid ? `已登录（未校验），本机机器人 AppID ${appid}` : '已登录，但本机机器人还没填 AppID',
        hint: appid ? '' : '去「机器人」页把 AppID 填上',
      };
    }

    let bots;
    try {
      bots = await listBots();
      out.verified = true;
    } catch (e) {
      const code = e?.code === 'PLATFORM_BUSY' ? 'PLATFORM_BUSY'
        : e?.code === 'RENEWED_WAIT' ? 'RENEWED_WAIT'
          : isAuthFailure(e) ? 'TICKET_EXPIRED'
            : DEV_ERRORS[e?.code] ? e.code : 'PLATFORM_ERROR';
      return {
        ...out,
        state: code === 'RENEWED_WAIT' ? 'renewed-wait'
          : code === 'PLATFORM_BUSY' ? 'busy'
            : code === 'TICKET_EXPIRED' ? 'expired' : 'error',
        code,
        message: friendly(e),
        hint: e?.hint || DEV_ERRORS[code]?.hint || '',
        ...(e?.retcode != null ? { retcode: e.retcode } : {}),
        ...(e?.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}),
      };
    }

    out.botCount = bots.length;
    if (!appid) {
      return {
        ...out, state: 'no-appid', code: 'NO_LOCAL_APPID',
        message: '登录正常，但本机机器人还没填 AppID',
        hint: '去「机器人」页把 AppID 填上，面板才知道要改哪一只',
      };
    }
    if (!bots.length) {
      return {
        ...out, state: 'account-empty', code: 'ACCOUNT_NO_BOT', matched: false,
        message: '这个 QQ 号名下一条机器人也没有',
        hint: '扫码 / 粘贴用的号不对：退出登录换一个号',
      };
    }
    const hit = bots.find((b) => b.appid === appid) || null;
    if (!hit) {
      return {
        ...out, state: 'bot-missing', code: 'BOT_NOT_IN_ACCOUNT', matched: false,
        message: `账号里没有 AppID ${appid}（${bound?.name || '当前机器人'}）`,
        hint: `这个号名下是：${bots.map((b) => `${b.name || '未命名'}(${b.appid})`).join('、')}`,
      };
    }
    return {
      ...out, state: 'ready', code: 'OK', matched: true, bot: hit,
      message: `可以改：${hit.name || hit.appid}（AppID ${hit.appid}）`,
      hint: '',
    };
  }

  async function hasSaved() {
    try {
      await fs.access(sessionFile());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 机器人列表。字段取自 `info/list_bots`，只留面板要用的那些。
   *
   * `online_state` 是对象（`{online_state, links}`），统一折成布尔，
   * 免得前端到处判两层。
   */
  async function listBots({ maxAgeMs = 30_000 } = {}) {
    requireReady();
    /**
     * 缓存。`list_bots` 是平台限频最狠的一个接口：面板会同时被三处
     * （登录校验、页签初始化、扫码轮询）调用，不缓存就是自己把自己打进
     * `10000`。30 秒内的重复调用直接回同一份结果。
     */
    if (botsCache && Date.now() - botsCache.at < maxAgeMs) return botsCache.list;

    const data = await session.post('/cgi-bin/v2/info/list_bots', {
      developer_id: developerIdOf(session.jar()),
      filter: { create_remain: 1, online_state: 1, page_limit: 100 },
    });
    const list = Array.isArray(data?.bots) ? data.bots : [];
    const mapped = list.map((b) => ({
      appid: String(b.bot_appid ?? ''),
      name: String(b.bot_name ?? ''),
      avatar: String(b.bot_avatar ?? ''),
      desc: String(b.bot_desc ?? ''),
      uin: b.bot_uin == null ? '' : String(b.bot_uin),
      online: Boolean(b.online_state?.online_state),
      status: b.bot_status ?? 0,
      role: b.user_type ?? 0,
      // 正在注销的机器人不该出现在可编辑列表里，但要让用户看见「为什么少了」
      revoking: b.bot_status === 2,
    })).filter((b) => b.appid);
    botsCache = { at: Date.now(), list: mapped };
    // 能取到数据就说明平台已经放开：把排着的补拉撤掉，别白打一次
    cancelWarmup(mapped.length);
    return mapped;
  }

  /** 单个机器人的资料 + 开发设置，一次拿全（面板右侧用） */
  /**
   * 让扫码窗口跳到某个机器人的设置页。
   *
   * 管理端是「列表 → 点进去」两层，光停在列表上，用户还得自己再找一次。
   * 面板里选中机器人时顺手把窗口带过去，两边看的是同一个机器人。
   * 窗口不在（比如只导入了 Cookie）就什么都不做，返回 `opened:false`。
   */
  async function focus(appid) {
    const id = String(appid || '').replace(/[^\d]/g, '');
    if (!id) throw devError('BAD_APPID', '要给 bot_appid');
    const opened = await scanner.openBotPage?.(id);
    return { ok: true, appid: id, opened: Boolean(opened) };
  }

  async function getBot(appid) {
    requireReady();
    const id = Number(appid);
    if (!id) throw devError('BAD_APPID', '要给 bot_appid');

    const [info, dev] = await Promise.all([
      session.post('/cgi-bin/v2/info/query', {
        bot_appid: id,
        filter: { base_info: 1, private_proto: 0, developer_info: 1, online_state: 1 },
      }),
      session.post('/cgi-bin/v2/bot_dev_setting/query', {
        bot_appid: id,
        filter: { ip_whitelist_info: 1, connect_info: 1, event: 1, sensitive_alert: 0 },
      }),
    ]);

    const base = info?.base_info ?? {};
    return {
      appid: String(id),
      base: {
        name: String(base.bot_name ?? ''),
        desc: String(base.bot_desc ?? ''),
        avatar: String(base.bot_avatar ?? ''),
        // 改资料时的「每日/每月还能改几次」由官方限制，面板要显示出来
        modifyRemain: base.remaining_modify_count ?? null,
      },
      developer: {
        adminUin: info?.developer_info?.admin_uin == null ? '' : String(info.developer_info.admin_uin),
        adminName: String(info.developer_info?.admin_nick_name ?? ''),
        subjectType: info?.developer_info?.subject_type ?? 0,
      },
      connect: {
        mode: dev?.connect_info?.mode ?? 0,
        webhookUrl: String(dev?.connect_info?.webhook_url ?? ''),
      },
      events: {
        all: Boolean(dev?.event?.all_subscription),
        ids: (Array.isArray(dev?.event?.events) ? dev.event.events : [])
          .filter((e) => e?.is_subscribed).map((e) => String(e.id ?? '')),
        catalog: (Array.isArray(dev?.event?.events) ? dev.event.events : []).map((e) => ({
          id: String(e.id ?? ''),
          name: String(e.name ?? ''),
          type: String(e.type ?? ''),
          subscribed: Boolean(e.is_subscribed),
        })),
      },
      ipWhitelist: (Array.isArray(dev?.ip_whitelist_info?.ip_addresses) ? dev.ip_whitelist_info.ip_addresses : [])
        .map((ip) => String(ip ?? '')),
    };
  }

  /**
   * 改配置。**一个入口按 patch 分发**，而不是开六个方法：
   * 面板一次保存可能同时改资料和回调，分开调会出现「一半成功」。
   *
   * 支持的 patch：
   *   · `base:   { name?, desc?, avatarId?, previewItems? }`
   *   · `connect:{ action, webhookUrl?, event? }`   action 1 保存 / 2 校验 / 3 WebSocket
   *   · `ip:     { action, addresses }`             action 1 增 / 2 删
   *
   * 每一条都显式带 `bot_appid`，不接受「当前选中」这种隐式状态。
   */
  async function setBot(appid, patch = {}) {
    requireReady();
    const id = Number(appid);
    if (!id) throw devError('BAD_APPID', '要给 bot_appid');
    const done = [];

    if (patch.base && typeof patch.base === 'object') {
      const b = patch.base;
      const body = {
        bot_appid: id,
        filter: {
          name: b.name === undefined ? 0 : 1,
          avatar: b.avatarId === undefined ? 0 : 1,
          desc: b.desc === undefined ? 0 : 1,
          feature_preview: b.previewItems === undefined ? 0 : 1,
        },
        name: b.name ?? '',
        avatar_id: b.avatarId ?? '',
        desc: b.desc ?? '',
        preview_items: (Array.isArray(b.previewItems) ? b.previewItems : []).map((x) => (
          x?.uploadId ? { upload_id: x.uploadId } : { url: String(x?.url ?? '') }
        )),
      };
      await session.post('/cgi-bin/v2/info/modify', body);
      done.push('base');
    }

    if (patch.connect && typeof patch.connect === 'object') {
      const c = patch.connect;
      const action = Number(c.action) || 1;
      const body = { bot_appid: id, action };
      if (action === 1) {
        body.webhook_url = String(c.webhookUrl ?? '');
        if (c.event && typeof c.event === 'object') {
          body.event = {
            all_subscription: Boolean(c.event.all),
            event_ids: Array.isArray(c.event.ids) ? c.event.ids.map(String) : [],
          };
          body.filter = { event: 1 };
        }
      }
      await session.post('/cgi-bin/v2/bot_dev_setting/connect_info/modify', body);
      done.push('connect');
    }

    if (patch.ip && typeof patch.ip === 'object') {
      const addresses = (Array.isArray(patch.ip.addresses) ? patch.ip.addresses : [])
        .map((x) => String(x ?? '').trim()).filter(Boolean);

      if (patch.ip.mode === 'replace') {
        /**
         * 「保存」语义 = 让平台侧最终等于框里的内容。
         * 官方只有增(1)/删(2)两个动作，所以先读当前列表再算差集——
         * 少算这一步会变成「只能加不能删」，用户改错一个 IP 都撤不掉。
         */
        const cur = await getBot(id);
        const curSet = new Set(cur.ipWhitelist);
        const nextSet = new Set(addresses);
        const add = [...nextSet].filter((x) => !curSet.has(x));
        const del = [...curSet].filter((x) => !nextSet.has(x));
        if (add.length) {
          await session.post('/cgi-bin/v2/bot_dev_setting/ip_whitelist/modify', {
            bot_appid: id, action: 1, ip_addresses: add,
          });
        }
        if (del.length) {
          await session.post('/cgi-bin/v2/bot_dev_setting/ip_whitelist/modify', {
            bot_appid: id, action: 2, ip_addresses: del,
          });
        }
        done.push('ip');
      } else {
        const action = Number(patch.ip.action) || 1;
        if (!addresses.length) throw Object.assign(new Error('IP 白名单至少要填一个地址'), { http: 400 });
        await session.post('/cgi-bin/v2/bot_dev_setting/ip_whitelist/modify', {
          bot_appid: id, action, ip_addresses: addresses,
        });
        done.push('ip');
      }
    }

    if (!done.length) throw Object.assign(new Error('没有要改的字段'), { http: 400 });

    // 改过昵称/简介后列表里的展示就该变，别让缓存把旧名字挂 30 秒
    botsCache = null;
    lastWrite = { appid: String(id), parts: done, at: Date.now() };
    log(`[dev] 已更新 ${id}：${done.join(' / ')}`);
    return { ok: true, appid: String(id), parts: done };
  }

  /**
   * 换头像。
   *
   * 官方页面是两步：先把图片 multipart 传上去拿一个 `avatar_id`，再
   * `info/modify` 带 `avatar_id` 生效。上传那个 CGI 的路径没有公开文档，
   * 也没在 SDK 里出现过，所以这里按候选顺序试**一次**——全都不认就把
   * 每一次的失败原因原样回给面板，并明确给出兜底：去官方页面上传，
   * 把拿到的 avatar_id 直接填进来（面板头像那一行支持只贴 id）。
   *
   * 为什么不无限试：`bot.q.qq.com` 的限频是按时间段封的（见 session.js
   * 的 COOLDOWN_MS），瞎试候选等于自己把自己打进 10000，正常功能也跟着废。
   */
  const AVATAR_PATHS = [
    process.env.ROOST_DEV_AVATAR_PATH || '/cgi-bin/v2/info/upload_avatar',
    '/cgi-bin/v2/info/avatar/upload',
  ];

  /** 从上传接口的回包里挑出 id，字段名各版本不一样 */
  function pickAvatarId(data) {
    const hit = [];
    const walk = (v, depth = 0) => {
      if (!v || depth > 3) return;
      if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
      if (typeof v !== 'object') return;
      for (const [k, val] of Object.entries(v)) {
        if (/^(avatar|file|upload)?_?id$/i.test(k) && (typeof val === 'string' || typeof val === 'number') && String(val)) {
          hit.push(String(val));
        }
        walk(val, depth + 1);
      }
    };
    walk(data);
    return hit[0] || '';
  }

  /**
   * 官方对头像的限制（2026-11 在「修改机器人资料」弹窗里抄下来的）：
   *
   *   · 格式：png / bmp / jpeg / jpg / gif —— **不收 webp**
   *   · 大小：不可大于 2 MB
   *   · 形状：正方形（页面上可以裁剪）
   *   · 尺寸：弹窗建议 144×144；创建页要求 240×240 以上
   *   · 内容：不许涉政涉黄
   *
   * 面板侧会先把图缩成 512×512 的 PNG 再传（取「够清晰」和「远小于 2 MB」
   * 的中间值，PNG 也是官方说的最佳效果格式）。这里再拦一道，是因为
   * URL / 直接给 id 两条路都绕过了前端那层——本机这道闸不能松。
   */
  /** 白名单群上限：官方前端写死的 20（提示语「最多支持 20 个白名单群」） */
  const SCOPE_MAX_GROUPS = 20;

  const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
  const AVATAR_MIMES = ['image/png', 'image/bmp', 'image/jpeg', 'image/jpg', 'image/gif'];

  /**
   * 把 dataURL / 图片地址读成可以直接塞进 FormData 的 Blob。
   *
   * 上一版把 PNG 转成 JPEG（为了压体积），结果透明底的头像一圈黑边——
   * 官方本来就推荐 PNG，这里改成**原样透传**，压缩交给面板的 canvas 做。
   */
  async function readImage({ dataUrl = '', url = '' } = {}) {
    const check = (mime, size) => {
      const type = String(mime || '').toLowerCase();
      if (!AVATAR_MIMES.includes(type)) {
        throw devError('BAD_IMAGE', `官方只收 ${AVATAR_MIMES.map((m) => m.slice(6)).join(' / ')}，这张是 ${type || '未知格式'}`);
      }
      if (size > AVATAR_MAX_BYTES) {
        throw devError('BAD_IMAGE', `官方要求不超过 2 MB，这张 ${(size / 1024 / 1024).toFixed(1)} MB`);
      }
      return type;
    };

    const d = String(dataUrl || '').trim();
    if (d) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(d);
      if (!m) throw devError('BAD_IMAGE', '图片数据格式不对（要 data:image/...;base64,...）');
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw devError('BAD_IMAGE', '图片是空的');
      const type = check(m[1], buf.length);
      return { blob: new Blob([buf], { type }), filename: `avatar.${type.split('/')[1] || 'png'}`, bytes: buf.length };
    }

    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw devError('BAD_IMAGE', '要么选一张本地图片，要么填 http(s) 图片地址');
    /**
     * 出站校验不能只验 `^https?://`：OneBot 的 `set_qq_profile` 是**模型可触发**的，
     * 裸 fetch 等于把「让宿主访问任意地址」开给模型（内网 / 云元数据 / 端口探测）。
     * `fetchImageLimited` 逐跳校验、禁私有地址、按 2MB 流式截断。
     */
    let got;
    try {
      got = await fetchImageLimited(u, {
        maxBytes: AVATAR_MAX_BYTES,
        fetchImpl,
        ...(lookup ? { lookup } : {}),
      });
    } catch (e) {
      throw devError('BAD_IMAGE', `取图失败：${e?.message ?? e}`);
    }
    const type = check(got.type, got.buf.length);
    return { blob: new Blob([got.buf], { type }), filename: `avatar.${type.split('/')[1] || 'png'}`, bytes: got.buf.length };
  }

  /**
   * 昵称字段有两种形态：`friend_infos[].nick_name` 实测是字符串，但早期接口
   * 回过 `{nick: ...}` 这样的对象。两种都收，免得一个字段变化把整块白名单读空。
   */
  const nickNameOf = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return String(v.nick ?? v.nick_name ?? v.name ?? v.text ?? '');
    return String(v);
  };

  /**
   * 体验白名单：谁能用这只机器人。
   *
   * 两样东西在**同一个** CGI 里，分开读等于白挨两次「限频」：
   *   · 测试用户（官方叫体验成员）→ `friend_infos`，字段是 QQ 号 `uin`
   *   · 白名单群 → `group_admin_config.whitelist_groups`，但它是「规则」数组，
   *     规则里才挂 `group_ids`；面板要的是平铺的群列表，所以这里摊平去重，
   *     群名从 `whitelist_groups_info` 补（不在群里时拿不到名字，只回群号）
   *
   * 读的是 `scope_cfg/query` 而不是 `bot_group_list/query`：后者是「机器人
   * 已经进了哪些群」，跟白名单是两件事，混用会让用户以为「加了群就在白名单里」。
   */
  async function getScope(appid) {
    requireReady();
    const id = Number(appid);
    if (!id) throw devError('BAD_APPID', '要给 bot_appid');

    const data = await session.post('/cgi-bin/v2/bot_scope_manager/scope_cfg/query', {
      bot_appid: id,
      // 只要白名单与群管配置：scope_config / search_config 关掉，少传少解析
      query_filter: { scope_config: 0, white_list: 1, search_config: 0, group_admin_config: 1 },
    });

    const users = (Array.isArray(data?.friend_infos) ? data.friend_infos : [])
      .map((u) => ({ uin: u?.uin == null ? '' : String(u.uin), name: nickNameOf(u?.nick_name) }))
      .filter((u) => u.uin);

    const info = data?.whitelist_groups_info && typeof data.whitelist_groups_info === 'object'
      ? data.whitelist_groups_info
      : {};
    const ids = [];
    for (const rule of data?.group_admin_config?.whitelist_groups ?? []) {
      for (const gid of rule?.group_ids ?? []) {
        const one = String(gid ?? '').trim();
        if (one && !ids.includes(one)) ids.push(one);
      }
    }
    const groups = ids.map((gid) => ({
      groupId: gid,
      name: String(info[gid]?.group_name ?? ''),
      // false 多半是「机器人已经不在这个群了」，面板要能提醒而不是装作正常
      inGroup: info[gid]?.in_group === undefined ? null : Boolean(info[gid].in_group),
    }));

    return { appid: String(id), users, groups, limits: { groups: SCOPE_MAX_GROUPS } };
  }

  /**
   * 加 / 删白名单成员。
   *
   * 两条路不一样，是因为官方前端本身就是两套 CGI：
   *   · 测试用户 → `bot_scope_manager/white_list/modify`（`set_friend_whitelist`）
   *   · 白名单群 → `bot_scope_manager/dev_capability/modify`（群管能力，按群号增删）
   *
   * 一次只动一类、只动一份名单：平台对「加」和「删」是两个 action，混着发
   * 会出现「加成功、删失败」，用户看不出到底哪半生效了。
   *
   * @param {string} appid
   * @param {{kind:'users'|'groups', action:1|2, ids:string[]|string}} p  1 加 / 2 删
   */
  async function setScope(appid, p = {}) {
    requireReady();
    const id = Number(appid);
    if (!id) throw devError('BAD_APPID', '要给 bot_appid');

    const kind = String(p.kind || '');
    if (kind !== 'users' && kind !== 'groups') {
      throw devError('BAD_SCOPE', 'kind 只能是 users（测试用户）或 groups（白名单群）');
    }
    const action = Number(p.action) || 1;
    if (action !== 1 && action !== 2) throw devError('BAD_SCOPE', 'action 只能是 1（添加）或 2（移除）');

    const list = (Array.isArray(p.ids) ? p.ids : [p.ids])
      .map((x) => String(x ?? '').trim()).filter(Boolean);
    if (!list.length) throw devError('BAD_SCOPE', '要给至少一个号码');

    if (kind === 'users') {
      for (const u of list) {
        // 官方前端的校验是 5~11 位纯数字；先在本机拦住，省一次必然失败的网络请求
        if (!/^\d{5,11}$/.test(u)) throw devError('BAD_SCOPE', `QQ 号要 5~11 位纯数字，这个不对：${u}`);
      }
      await session.post('/cgi-bin/v2/bot_scope_manager/white_list/modify', {
        bot_appid: id,
        whitelist_filter: { set_friend_whitelist: action },
        friend_whitelist: { white_ids: list },
      });
    } else {
      for (const g of list) {
        // 群号 5~10 位；机器人不在群里也能先加，平台会标「不在群内」
        if (!/^\d{5,10}$/.test(g)) throw devError('BAD_SCOPE', `群号要 5~10 位纯数字，这个不对：${g}`);
      }
      if (action === 1 && list.length > SCOPE_MAX_GROUPS) {
        throw devError('BAD_SCOPE', `白名单群最多 ${SCOPE_MAX_GROUPS} 个，这次给了 ${list.length} 个`);
      }
      await session.post('/cgi-bin/v2/bot_scope_manager/dev_capability/modify', {
        // 这个接口的 bot_appid 官方发的是字符串，别的接口是数字，别「统一」掉
        bot_appid: String(id),
        set_dev_filter: { set_group_admin_config: 1 },
        group_admin_action: action === 1
          ? { add_group_ids: list, remove_group_ids: [] }
          : { add_group_ids: [], remove_group_ids: list },
      });
    }

    log(`[dev] 白名单 ${kind} ${action === 1 ? '添加' : '移除'} ${list.join('、')}（bot ${id}）`);
    return { ok: true, appid: String(id), kind, action, ids: list };
  }

  /**
   * 换头像：上传 → 立刻套用，一次调用对应用户点一次「保存头像」。
   *
   * @param {string} appid
   * @param {{dataUrl?:string, url?:string, avatarId?:string}} src
   *        `avatarId` 是兜底：用户从官方页面拿到了 id，直接生效，不用上传
   */
  async function setAvatar(appid, src = {}) {
    requireReady();
    const id = Number(appid);
    if (!id) throw devError('BAD_APPID', '要给 bot_appid');

    let avatarId = String(src.avatarId || '').trim();
    let uploaded = false;

    if (!avatarId) {
      const img = await readImage(src);
      const attempts = [];
      for (const p of AVATAR_PATHS) {
        const form = new FormData();
        form.append('bot_appid', String(id));
        form.append('file', img.blob, img.filename);
        try {
          const data = await session.postForm(p, form);
          const got = pickAvatarId(data);
          if (got) { avatarId = got; uploaded = true; break; }
          attempts.push(`${p} 没回 avatar_id`);
        } catch (e) {
          if (isAuthFailure(e)) throw e;
          attempts.push(`${p}：${friendly(e)}`);
          // 限频/冷却就别再换路子了，越试越封
          if (e.code === 'PLATFORM_BUSY') break;
        }
      }
      if (!avatarId) {
        throw devError('AVATAR_UPLOAD_FAILED', `上传头像失败（${attempts.join('；')}）`, { attempts });
      }
    }

    await setBot(id, { base: { avatarId } });
    lastWrite = { appid: String(id), parts: ['avatar'], at: Date.now() };
    log(`[dev] 已换头像 ${id}${uploaded ? '（上传）' : '（直接给 id）'}`);
    return { ok: true, appid: String(id), avatarId, uploaded };
  }

  /**
   * 给协议层与面板的方法清单。
   *
   * scope 与框架既有约定一致：只读 `read`，写 `message`（运维动作），
   * 不涉及权限变更所以不需要 `manage` 总闸。但**票据本身是账号级**，
   * 所以 `login.*` 单独标 `manage`——拿到它等于拿到该开发者全部机器人。
   */
  function methods() {
    return [
      { name: 'status', scope: 'read', desc: '开放平台登录状态（含扫码进度，不含票据）', args: [] },
      { name: 'session.check', scope: 'read', desc: '能不能干活：登录 / 账号里有几只 / 本机这只在不在（verify 才联网核）', args: ['verify?'] },
      { name: 'session.remember', scope: 'manage', desc: '把当前登录态写入 / 移出本机（重启后还要不要重登）', args: ['remember'] },
      { name: 'bots', scope: 'read', desc: '当前开发者主体下的机器人列表', args: [] },
      { name: 'bot.get', scope: 'read', desc: '单个机器人的资料 / 连接 / 白名单', args: ['appid'] },
      { name: 'bot.focus', scope: 'read', desc: '把扫码窗口切到该机器人的设置页', args: ['appid'] },
      { name: 'bot.set', scope: 'message', desc: '改资料 / 连接方式 / IP 白名单（显式 appid）', args: ['appid', 'patch'] },
      { name: 'bot.avatar', scope: 'message', desc: '换头像：传图或直接给 avatarId（显式 appid）', args: ['appid', 'src'] },
      { name: 'scope.get', scope: 'read', desc: '体验白名单：测试用户（QQ 号）+ 白名单群（群号）', args: ['appid'] },
      { name: 'scope.set', scope: 'message', desc: '加/删测试用户或白名单群（显式 appid）', args: ['appid', 'kind', 'action', 'ids'] },
      { name: 'login.scan', scope: 'manage', desc: '扫码登录：在本机拉起浏览器窗口，需要人扫码', args: ['remember?'] },
      { name: 'login.scan.cancel', scope: 'manage', desc: '取消扫码并关闭浏览器窗口', args: [] },
      { name: 'login.import', scope: 'manage', desc: '备选：导入浏览器 Cookie 或 cURL', args: ['input', 'remember?'] },
      { name: 'login.logout', scope: 'manage', desc: '清除本机登录态（同时关掉扫码窗口）', args: [] },
      { name: 'browser.set', scope: 'manage', desc: '指定扫码用的浏览器可执行文件路径（空 = 自动探测）', args: ['path'] },
    ];
  }

  return {
    load,
    status,
    setRemember,
    checkSession,
    startScan,
    cancelScan,
    recheckLogin,
    loginImport,
    logout,
    setBrowserPath,
    listBots,
    getBot,
    focus,
    setBot,
    setAvatar,
    getScope,
    setScope,
    methods,
    friendly,
    /**
     * 给插件的门面：**只有查询与改配置，没有登录**。
     *
     * 票据等于该开发者全部机器人的管理权，而且扫码会弹出 GUI 窗口——
     * 这两件事都只能由人从面板做。插件永远复用「已登录的那个人」的会话，
     * 且只活在本进程内存里。
     */
    facade: () => Object.freeze({
      status,
      check: checkSession,
      bots: listBots,
      getBot,
      setBot,
      setAvatar,
      scope: getScope,
      setScope,
    }),
    /** 面板/测试要直接戳会话或扫码器时用 */
    _session: session,
    /** 测试用：直接触发一次自动续期，验证「失败也不会把闸锁死」 */
    _autoRelogin: autoRelogin,
    _scanner: scanner,
  };
}
