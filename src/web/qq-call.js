/**
 * 通用能力调用：`POST /api/qq/call`
 *
 * 为什么不做成「每个官方接口一条 REST」：
 *   47 条路由要写、要测、要文档，官方加接口时还得两边改。
 *   通用调用 + 白名单 + 能力清单，新增接口只在 `endpoints.js` 加一行。
 *
 * 调用方是 AI（见 dsh-roost 插件），它看的是 `method` 和说明，不看 URL 长什么样。
 *
 * 安全边界（三层，缺一不可）：
 *   1. 路由本身在 `authorized()` / CSRF / 同源校验之后，跟面板其他接口一个待遇
 *   2. `method` 必须在 `CALLABLE_METHODS` 白名单里
 *   3. 风险等级 `danger` 的必须显式 `confirm: true`
 */

import { OFFICIAL_ENDPOINTS, CALLABLE_METHODS, riskOf, capabilityList } from '../endpoints.js';

/** api 方法名 → 风险等级（取同名接口里最严的那档） */
const RISK_BY_API = (() => {
  const order = { read: 0, write: 1, danger: 2 };
  const m = new Map();
  for (const ep of OFFICIAL_ENDPOINTS) {
    if (!ep.api) continue;
    const r = riskOf(ep);
    if (!m.has(ep.api) || order[r] > order[m.get(ep.api)]) m.set(ep.api, r);
  }
  return m;
})();

/** 官方错误码 → 人话。AI 拿到的是这句，不是一串数字 */
const ERR_HINTS = {
  40034128: '被动回复超限（5 分钟窗口，同一条最多 5 次）。等用户再说一句，或改用主动消息',
  40034100: '被官方限流了，稍后再试',
  40034008: '消息内容不合法（markdown 和 content 不能同时给）',
  304023: '消息已进入审核（这不是失败，会正常发出）',
  11253: '这个接口需要官方内邀白名单，当前机器人没开',
  850018: '机器人或群被禁言了',
  850031: '文件超过大小限制',
  40093002: '今天发文件的容量用完了',
};

/**
 * 把 `{ __target, __rest, ...opts }` 还原成位置参数。
 *
 * 官方接口的签名五花八门：
 *   sendGroup(target, opts)
 *   retractGroupMessage(target, messageId)
 *   muteMembers(target, list)
 *   createPanel(opts)
 *
 * 统一约定：
 *   `__target` → 第一个位置参数
 *   `__rest`   → 后续位置参数（数组）
 *   剩下的键   → 合成一个对象，追加在最后
 */
export function buildCallArgs(raw = {}) {
  const args = { ...raw };
  const target = args.__target;
  delete args.__target;
  const rest = Array.isArray(args.__rest) ? args.__rest : [];
  delete args.__rest;

  const out = [];
  if (target !== undefined && target !== null && target !== '') out.push(target);
  out.push(...rest);
  if (Object.keys(args).length) out.push(args);
  return out;
}

/** 从异常里扒出官方错误码 */
function errorCode(e) {
  return e?.code ?? e?.body?.code ?? e?.status ?? null;
}

function humanError(e) {
  const code = errorCode(e);
  const hint = code != null ? ERR_HINTS[Number(code)] : null;
  const raw = String(e?.message ?? e);
  if (hint) return `${hint}（原始错误：${raw}）`;
  return raw;
}

/**
 * 处理一次调用。
 *
 * @param {object} p
 * @param {object[]} p.runtimes 所有机器人运行时
 * @param {object} p.body 请求体 `{ bot, method, args, confirm }`
 * @param {object} [p.fallbackRuntime] 没指定 bot 时用哪个（面板已经按 ?bot= 选过了）
 * @param {object} [p.log] 日志器
 * @returns {Promise<{code:number, body:object}>}
 */
export async function handleQqCall({ runtimes = [], body = {}, fallbackRuntime = null, log = null }) {
  const method = String(body?.method ?? '').trim();

  if (!method) {
    return { code: 400, body: { ok: false, error: '缺少 method' } };
  }
  if (!CALLABLE_METHODS.has(method)) {
    return {
      code: 400,
      body: {
        ok: false,
        error: `方法 ${method} 不在可调用白名单里。用 GET /api/qq/capabilities 看有哪些`,
      },
    };
  }

  // 选机器人：body.bot 优先，其次是面板按 ?bot= 选中的那个
  let rt = fallbackRuntime;
  if (body?.bot) {
    rt = runtimes.find((r) => r.id === body.bot) ?? null;
    if (!rt) {
      return { code: 404, body: { ok: false, error: `没有这个机器人：${body.bot}` } };
    }
  }
  if (!rt?.api) {
    return { code: 503, body: { ok: false, error: '机器人还没就绪（没连上网关或没拿到 api）' } };
  }

  // 危险操作要确认
  const risk = RISK_BY_API.get(method) ?? 'write';
  if (risk === 'danger' && body?.confirm !== true) {
    return {
      code: 403,
      body: {
        ok: false,
        risk,
        error: `${method} 属于不可逆操作，需要带 confirm: true 才执行`,
      },
    };
  }

  const args = buildCallArgs(body?.args ?? {});
  const t0 = Date.now();
  try {
    const result = await rt.api[method](...args);
    log?.info?.(`qq.call ${rt.id} ${method} ✓ ${Date.now() - t0}ms`);
    return { code: 200, body: { ok: true, result: result ?? null } };
  } catch (e) {
    const code = errorCode(e);
    log?.warn?.(`qq.call ${rt.id} ${method} ✗ ${e?.message ?? e}`);
    return {
      code: 502,
      body: { ok: false, error: humanError(e), code, risk },
    };
  }
}

/** `GET /api/qq/capabilities` 的返回：给 AI 看的说明书 */
export function capabilityPayload() {
  return capabilityList();
}
