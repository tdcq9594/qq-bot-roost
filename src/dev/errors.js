/**
 * 开放平台错误码（`dev.*` 的唯一词汇表）
 * ======================================
 *
 * 为什么单开一张表、而不是各处 `throw new Error('...')`：
 *
 * 面板、宿主协议、插件三条路都会撞到同一批失败——没登录、票据过期、平台限频、
 * 登错账号。只给一句中文，前端只能原样贴出来，用户看不出「是我操作错了，还是
 * 平台抽风，还是该重新登录」。所以每个失败都带一个**稳定的英文码**：
 *
 *   · `code`  —— 给程序判断用，不会因为改文案而变
 *   · `http`  —— 给 HTTP 层用，401/403/429 语义要准
 *   · `error` —— 已经写好的一句话，直接展示
 *   · `hint`  —— **下一步该干什么**，这是用户真正需要的那句
 *
 * 码表本身也对外暴露（`GET /api/dev/errors`、`dev.session` 返回里的 `code`），
 * 前端不用维护第二份映射。
 *
 * 命名约定：`NEED_*` 是「要先做一件事」，`*_FAILED` 是「做了但没成」。
 */

export const DEV_ERRORS = {
  /* ---- 登录态 ---- */
  NOT_LOGGED_IN: {
    http: 401,
    hint: '点「扫码登录」，或在「备选」里粘一次 cURL',
  },
  TICKET_EXPIRED: {
    http: 401,
    hint: '票据过期了：重新扫码，或重新粘贴一次 cURL',
  },
  NO_COOKIE: {
    http: 400,
    hint: 'F12 → Network → 右键任意 bot.q.qq.com 请求 → Copy as cURL，整段粘进来',
  },
  NO_TICKET: {
    http: 400,
    hint: '这段里没有票据键。不要复制 document.cookie（b-token 是 httpOnly，读不到），用 Copy as cURL',
  },
  BAD_TICKET: {
    http: 401,
    hint: '这段票据平台不认，确认粘的是**刚登录**那次的请求，再试一次',
  },
  PLATFORM_BUSY: {
    http: 429,
    hint: '平台限频是按时间段封的，等提示的秒数过去会自动恢复，别反复点',
  },
  /**
   * 「票已经换好了，只是平台还没放开」。
   *
   * 和 `PLATFORM_BUSY` 必须分开：那条说的是「你被限频了，等」，这条说的是
   * 「登录已经恢复，数据稍后自己回来」。用户看到的动作完全不同——前者要去
   * 处理限频，后者**什么都不用做**。
   */
  RENEWED_WAIT: {
    http: 429,
    hint: '登录已经自动恢复，不用重新扫码；等平台放开后会自动刷新',
  },
  PLATFORM_ERROR: {
    // 平台回了业务错（11001/11002…）：请求本身是通的，是这一次被拒，
    // 按 4xx 上报。502 留给「网关层就不对」（见 BAD_RESPONSE）。
    http: 400,
    hint: '这是平台侧回的错，不是本机的问题；retcode 可对照开放平台文档',
  },
  BAD_RESPONSE: {
    http: 502,
    hint: '平台返回的不是 JSON，通常是被代理 / 风控页拦住了',
  },

  /* ---- 机器人绑定 ---- */
  BAD_APPID: {
    http: 400,
    hint: '请求里要带 bot_appid',
  },
  NO_LOCAL_APPID: {
    http: 400,
    hint: '去「机器人」页把 AppID 填上，面板才知道要改哪一只',
  },
  NOT_BOUND: {
    http: 403,
    hint: '这块面板只改本机跑着的那只机器人；要改别的，先在「机器人」页切过去',
  },
  ACCOUNT_NO_BOT: {
    http: 403,
    hint: '这个 QQ 号名下一条机器人也没有——扫码/粘贴用的号不对，退出登录换一个',
  },
  BOT_NOT_IN_ACCOUNT: {
    http: 403,
    hint: '确认这只机器人在哪个 QQ 号名下，然后用那个号重新登录',
  },

  /* ---- 具体动作 ---- */
  AVATAR_UPLOAD_FAILED: {
    http: 400,
    hint: '官方上传接口没认；可以先在开放平台页面上传一次，再把 avatar_id 填进来保存',
  },
  BAD_SCOPE: {
    http: 400,
    hint: '测试用户填 QQ 号（5~11 位数字），白名单群填群号（5~10 位数字）；白名单群最多 20 个',
  },
  BAD_IMAGE: {
    http: 400,
    hint: '官方只收 png / bmp / jpeg / jpg / gif，不超过 2 MB，且要正方形（面板会自动裁成 512×512）',
  },
  NO_BROWSER: {
    http: 400,
    hint: '装个 Chromium 系浏览器（Edge / Chrome）后重试，或在「没找到浏览器」里手填路径',
  },
  SCAN_FAILED: {
    http: 500,
    hint: '看扫码区那行提示；实在不行走「备选」粘贴 cURL',
  },
  INTERNAL: {
    http: 500,
    hint: '本机异常，看 logs/bot.log',
  },
};

/**
 * 造一个带码的错误。
 *
 * @param {keyof typeof DEV_ERRORS} code
 * @param {string} [message] 具体到这次的一句话（缺省用码表的 hint）
 * @param {object} [extra]   额外字段（retcode / retryAfterMs / keys …）
 */
export function devError(code, message = '', extra = {}) {
  const known = Boolean(DEV_ERRORS[code]);
  const meta = known ? DEV_ERRORS[code] : DEV_ERRORS.INTERNAL;
  const err = new Error(String(message || meta.hint || (known ? code : '本机异常')));
  err.code = known ? code : 'INTERNAL';
  err.http = Number(extra.http) || meta.http;
  err.hint = meta.hint;
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'http') continue;
    err[k] = v;
  }
  return err;
}

/**
 * 任意异常 → 统一响应体。
 *
 * 认不出来的异常**不留空码**：一律落到 `INTERNAL`，否则前端会拿着一个
 * 空白 `code` 去查表，查不到就只剩一句「失败」。
 */
export function devErrorPayload(e) {
  const code = DEV_ERRORS[e?.code] ? e.code : 'INTERNAL';
  const meta = DEV_ERRORS[code];
  const out = {
    code,
    http: Number(e?.http) || meta.http,
    error: String(e?.message ?? e ?? meta.hint ?? code),
    hint: String(e?.hint ?? meta.hint ?? ''),
  };
  if (e?.retcode != null) out.retcode = e.retcode;
  if (e?.retryAfterMs) out.retryAfterMs = e.retryAfterMs;
  if (Array.isArray(e?.keys)) out.keys = e.keys;
  if (Array.isArray(e?.attempts)) out.attempts = e.attempts;
  return out;
}

/** 码表副本，给 `GET /api/dev/errors` 用（不要暴露可变引用） */
export function devErrorTable() {
  return Object.entries(DEV_ERRORS).map(([code, v]) => ({
    code, http: v.http, hint: v.hint,
  }));
}
