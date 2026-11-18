/**
 * 开放平台会话（开发者账号级）
 * ============================
 *
 * 这里只做三件事：拿住票据、算 bkn、把请求发到 `bot.q.qq.com`。
 * 选机器人、改哪些配置属于 `platform.js`，展示属于面板，互不混。
 *
 * ## 为什么票据是「账号级」而不是「机器人级」
 *
 * 开放平台的登录态挂在 `.q.qq.com` 下，一个开发者账号下可以有 N 个机器人。
 * 所以会话只有一份，`bot_appid` 是每次请求的参数——**任何写操作都必须显式带
 * appid**，不能靠"当前选中"隐式推断，否则切机器人时很容易写到上一个身上。
 *
 * ## bkn 是什么
 *
 * 腾讯网页接口的 CSRF token：把 `p_skey` 做一遍 hash-5381 再取低 31 位，
 * 作为 query 参数带上去。没有它，写接口一律 `retcode=-10001`。
 * 这段算法没有任何依赖，直接写死比引库稳。
 *
 * ## 日志纪律
 *
 * 票据**永远不进日志、不进错误信息、不进返回值**。`describe()` 只给
 * "有没有、什么时候拿到的"，连长度都不给——长度也能用来做指纹。
 */

import { devError } from './errors.js';

export const DEV_HOST = 'https://bot.q.qq.com';
export const DEV_ORIGIN = 'https://q.qq.com';
export const DEV_REFERER = 'https://q.qq.com/qqbot/dashboard/';

/**
 * 登录态需要的 cookie。缺 `p_skey` 就没法算 bkn，缺 ticket 就没身份。
 *
 * 导出给 `browser.js` 共用一份：扫码取票时按同一张表筛选，
 * 两处各写一份迟早会漂移（比如一边加了 `b-token` 一边没加）。
 */
export const TICKET_KEYS = ['p_skey', 'qticket_lite', 'qticket', 'quid', 'quin', 'developer_id_lite', 'b-token'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/**
 * 命中限频后停手多久——**递进**：10 秒起，连续命中才翻倍，最多 60 秒。
 *
 * 早先一律锁 60 秒，是按「平台一忙就得好几分钟」估的。后来密集采样发现恢复
 * 常常只要几秒（2.2s / 2.5s / 13s 都有），一律锁一分钟的后果是：平台早就好了，
 * 面板还挂着一句「约 60 秒后恢复」，用户点一次失败一次——观感就是「每次都失败」。
 *
 * 但也不能不锁：真限频（每 5 秒试一次、连试 90 秒全是 10000 的那种）靠的就是
 * 把请求压下去，所以连续命中时仍然会涨到 60 秒。成功一次就归零。
 */
const COOLDOWN_STEPS = [10_000, 20_000, 40_000, 60_000];


/**
 * 腾讯经典 bkn：hash-5381，取低 31 位。
 *
 * `p_skey` 是带特殊字符的 base64 风格字符串，必须按 UTF-16 码元逐位累加，
 * 不能先转 Buffer——中文/符号会算出不同的值。
 */
export function bknOf(skey = '') {
  let hash = 5381;
  const s = String(skey ?? '');
  for (let i = 0; i < s.length; i += 1) hash += (hash << 5) + s.charCodeAt(i);
  return hash & 0x7fffffff;
}

/**
 * 把各种形态的 cookie 输入归一成 Map。
 *
 * 支持：`"a=1; b=2"`、`[{name,value}]`（浏览器导出的 JSON）、`{a:'1'}`。
 * 值里可能有 `=`（base64 padding），所以只按**第一个** `=` 切分。
 */
export function parseCookies(input) {
  const out = new Map();
  if (!input) return out;

  const put = (name, value) => {
    const k = String(name ?? '').trim();
    if (!k) return;
    out.set(k, String(value ?? '').trim());
  };

  if (typeof input === 'string') {
    for (const part of input.split(';')) {
      const s = part.trim();
      if (!s) continue;
      const i = s.indexOf('=');
      if (i <= 0) continue;
      put(s.slice(0, i), s.slice(i + 1));
    }
    return out;
  }

  if (Array.isArray(input)) {
    for (const c of input) if (c && typeof c === 'object') put(c.name, c.value);
    return out;
  }

  /**
   * Map 要单独判：`Object.entries(new Map([['a','1']]))` 是空数组
   * （Map 的内容不在自有可枚举属性上），落到下面的通用对象分支会**静默丢光票据**。
   * 这个坑是 `adopt(extractCookies(...))` 这条链路第一次跑测试时暴露的。
   */
  if (input instanceof Map) {
    for (const [k, v] of input) put(k, v);
    return out;
  }

  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) put(k, v);
  }
  return out;
}

export function cookieHeaderOf(jar) {
  const parts = [];
  for (const [k, v] of jar) {
    if (!v) continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join('; ');
}

/** 从 Set-Cookie 数组里合并票据。只收我们认识的键，避免把无关 cookie 带进请求。 */
export function mergeSetCookies(jar, list = []) {
  let n = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const first = String(raw ?? '').split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (!TICKET_KEYS.includes(name)) continue;
    // 服务端删票据时会给空值 + 过期时间，照收（等于清掉）
    jar.set(name, value);
    n += 1;
  }
  return n;
}

/**
 * 一个会话对象。
 *
 * @param {{fetchImpl?:typeof fetch, log?:(m:string)=>void, timeoutMs?:number}} o
 */
export function createDevSession({
  fetchImpl = fetch,
  log = () => {},
  timeoutMs = 20_000,
  /**
   * 票据过期时的「自动换票」钩子。
   *
   * 平台会回 `retcode:401 miss ticket`，而浏览器里那份登录态往往还活着
   * （profile 里有长期的身份 cookie，页面一开就重新换出 `b-token`）。
   * 所以这里把「失败了」升级成「先试着续一次，再决定要不要报错」：
   * 返回 `true` 表示票已换好，`post` / `postForm` 会**只重试一次**。
   *
   * 只在服务端明确说 401 时调用。`NOT_LOGGED_IN`（本机根本没票）不走这里——
   * 那种情况自动弹浏览器等于「打开面板就自己开窗」，纯属打扰。
   */
  onExpired = null,
} = {}) {
  /** @type {Map<string,string>} */
  let jar = new Map();
  let updatedAt = 0;

  /** 平台限频的冷却截止时间（毫秒时间戳）；0 = 不在冷却期 */
  let cooldownUntil = 0;
  /** 连续命中次数：决定这次锁多久（见 COOLDOWN_STEPS），成功一次归零 */
  let cooldownStep = 0;
  /**
   * 平台明确判过 401 的记账（0 = 没判过）。
   *
   * 为什么要记：用户取消「记住登录」后，内存里这张票按设计还留着，但自动换票
   * 已经被否决位挡住——**它没有任何自愈路径**。如果这张票本来就已经被判过期，
   * 面板会一直红字「登录已过期」，而用户刚说过「别记住」，他以为自己退干净了。
   * 上层拿这个标记就能把废票一起作废（见 `setRemember(false)`）。
   *
   * 只记时间，不记内容；`adopt` / `clear` 会归零。
   */
  let expiredAt = 0;

  /**
   * 有没有可以发请求的登录态。
   *
   * 判据要和扫码那边一致（`hasTickets`）：新版登录只有 `b-token`，
   * 没有 `p_skey`。这里漏判会让「明明登录成功」变成「没登录」。
   */
  const has = () => Boolean(jar.get('b-token') || jar.get('p_skey') || jar.get('developer_id_lite'));

  function adopt(input) {
    const next = parseCookies(input);
    // 整份替换而不是合并：用户重新登录时旧票必须丢掉，混着用会 401
    jar = new Map([...next].filter(([k]) => TICKET_KEYS.includes(k)));
    updatedAt = Date.now();
    // 换了票就是换了会话，上一份票攒下的冷却（含递进计数）不该继续拦着
    cooldownUntil = 0;
    cooldownStep = 0;
    /** 新票还没被平台判过——上一张的「过期」结论不能带到这张票头上 */
    expiredAt = 0;
    return describe();
  }

  function merge(list) {
    const n = mergeSetCookies(jar, list);
    if (n) updatedAt = Date.now();
    return n;
  }

  function clear() {
    jar = new Map();
    updatedAt = 0;
    cooldownUntil = 0;
    cooldownStep = 0;
    expiredAt = 0;
  }

  function describe() {
    return {
      loggedIn: has(),
      // 只给布尔，不给值也不给长度
      hasPskey: Boolean(jar.get('p_skey')),
      hasTicket: Boolean(jar.get('qticket_lite') || jar.get('qticket')),
      hasQuid: Boolean(jar.get('quid')),
      hasDeveloperId: Boolean(jar.get('developer_id_lite')),
      updatedAt,
      /** 平台判过 401：这张票留着也用不了（上层据此决定要不要直接作废） */
      expired: Boolean(expiredAt),
      /** 还要等多久才解封（毫秒）；0 表示当前可用 */
      cooldownMs: Math.max(0, cooldownUntil - Date.now()),
    };
  }

  /**
   * 发一个请求，返回原始 `Response`（不解析 retcode）。
   *
   * 抽出来是因为头像上传走 **multipart**，跟 JSON 那条只有 `Content-Type`
   * 和 body 形态不同——票据、bkn、冷却、401 判定这些必须一模一样，
   * 各写一份迟早会出现「改接口只改了一半」。
   */
  /**
   * 记一次「平台忙」并抛出。冷却时长按连续命中次数递进。
   *
   * 抽成函数是因为 `send` 和 `postForm` 两条路径都要记同一笔账；各写一遍迟早
   * 出现「表单那条涨、JSON 那条不涨」这种对不上的状态。
   */
  function busyNow(json, retcode) {
    cooldownStep = Math.min(cooldownStep + 1, COOLDOWN_STEPS.length);
    const ms = COOLDOWN_STEPS[cooldownStep - 1];
    cooldownUntil = Date.now() + ms;
    return devError('PLATFORM_BUSY', String(json?.msg || '平台繁忙'), { retcode, retryAfterMs: ms });
  }

  async function send(path, { method = 'POST', headers = {}, body } = {}) {
    if (!has()) throw devError('NOT_LOGGED_IN', '还没登录开放平台');

    /**
     * 冷却期内直接拒绝，不发真请求。
     *
     * 平台限频（`retcode:10000 系统繁忙`）不是「这次失败」，而是一段时间内
     * 整个 `list_bots` 都不可用；实测同一份票被打进限频后，页面里连发十几次
     * 全都是 10000，干等几分钟才恢复。冷却期还继续打，只会把恢复时间往后推
     * ——所以这里主动停手，把「还要等多久」明确回给面板。
     */
    const left = cooldownUntil - Date.now();
    if (left > 0) {
      throw devError('PLATFORM_BUSY', `平台限频，${Math.ceil(left / 1000)} 秒后自动重试`, { retryAfterMs: left });
    }

    const skey = jar.get('p_skey') || jar.get('qticket_lite') || jar.get('qticket') || '';
    const url = new URL(path.startsWith('http') ? path : `${DEV_HOST}${path}`);
    url.searchParams.set('bkn', String(bknOf(skey)));

    const res = await fetchImpl(url, {
      method,
      headers: {
        Cookie: cookieHeaderOf(jar),
        Origin: DEV_ORIGIN,
        Referer: DEV_REFERER,
        'User-Agent': UA,
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    merge(res.headers.getSetCookie?.() ?? []);
    return res;
  }

  /**
   * 发一个 CGI。返回 `data`（已剥掉外层），业务错误统一抛 `DEV_<retcode>`。
   *
   * 为什么不用 `res.ok` 判断：网关对未登录也回 200，错误在 body 的 retcode 里。
   */
  async function postOnce(path, body = {}, { raw = false } = {}) {
    const res = await send(path, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw devError('BAD_RESPONSE', `开放平台返回了非 JSON（HTTP ${res.status}）`);
    }

    if (raw) return { status: res.status, json, headers: res.headers };

    const retcode = Number(json?.retcode ?? 0);
    if (res.status === 401 || retcode === 401) {
      expiredAt = Date.now();
      throw devError('TICKET_EXPIRED', '登录已过期，请重新登录开放平台');
    }
    if (retcode !== 0) {
      /**
       * `10000` 是平台限频/风控的兜底话术，跟「票据坏了」是两件事：
       * 命中它就进入冷却，期间不再发请求，票照样留着。
       */
      if (retcode === 10000) throw busyNow(json, retcode);
      throw devError('PLATFORM_ERROR', String(json?.msg || `开放平台返回 retcode=${retcode}`), { retcode });
    }
    // 成功就归零：下次再忙还是从 10 秒起步，而不是接着上次的 60 秒
    cooldownStep = 0;
    /** 这一发通了，说明票是活的（可能被网关的 Set-Cookie 续过），撤掉过期结论 */
    expiredAt = 0;
    log(`[dev] ${path} ok`);
    return json?.data ?? {};
  }

  /**
   * multipart 版本（头像上传用）。
   *
   * 传的是 `FormData`，Node 会自己算 boundary，**不能**手写 Content-Type，
   * 否则 boundary 对不上、平台侧收到空文件。返回和 `post` 同一套剥壳结果。
   */
  async function postFormOnce(path, form) {
    const res = await send(path, { body: form });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw devError('BAD_RESPONSE', `上传接口返回了非 JSON（HTTP ${res.status}）`);
    }
    const retcode = Number(json?.retcode ?? 0);
    if (res.status === 401 || retcode === 401) {
      expiredAt = Date.now();
      throw devError('TICKET_EXPIRED', '登录已过期，请重新登录开放平台');
    }
    if (retcode !== 0) {
      if (retcode === 10000) throw busyNow(json, retcode);
      throw devError('PLATFORM_ERROR', String(json?.msg || `开放平台返回 retcode=${retcode}`), { retcode });
    }
    expiredAt = 0;
    log(`[dev] ${path} ok`);
    return json?.data ?? {};
  }

  /**
   * 票据过期时的「换一次票 + 试一次」包装。
   *
   * 只对平台明确回的 401 触发：限频、业务错、网络错都不该换票——那几种
   * 情况开浏览器解决不了问题，只会多开一个窗口。
   */
  /**
   * 换票成功但平台还没放开时，隔多久再来。
   *
   * 这里不再「隔几秒连试三次」——实测连着三次全撞 `retcode:10000`
   * （5s / 10s / 20s 各一次，都没过）。平台的恢复是按时间段的，短间隔试
   * 只是把恢复时间往后推，用户还得盯着三次失败。
   *
   * 所以口径改成：**换票成功即视为登录恢复**，本次请求如果平台仍忙，就
   * 明确告诉调用方「登录已恢复，65 秒后再来」，期间不再打；真要重试交给
   * 上层（`platform` 会在 65 秒后自己补一次，面板也按这个时间重新拉）。
   *
   * `ROOST_DEV_RENEW_WAIT_MS` 可改这个等待。
   */
  const renewWaitMs = () => {
    const n = Number(process.env.ROOST_DEV_RENEW_WAIT_MS ?? 65_000);
    return Number.isFinite(n) && n >= 0 ? n : 65_000;
  };

  async function withRenew(fn, args, err) {
    if (!onExpired || err?.code !== 'TICKET_EXPIRED') return null;
    let renewed = false;
    try {
      renewed = Boolean(await onExpired(err));
    } catch (e) {
      log(`[dev] 自动续期出错：${e?.message ?? e}`);
      return null;
    }
    if (!renewed) return null;

    /**
     * 换完票先**立刻**试一次。
     *
     * 有相当一部分情况平台是马上就能用的（实测有 +2.2s 就 `retcode:0` 的），
     * 那一下就省掉 65 秒等待。但只试这一次：不过就停手，不连打。
     */
    cooldownUntil = 0;
    log('[dev] 票据已自动续期，试一次刚才那个请求');
    try {
      return await fn(...args);
    } catch (e2) {
      const busy = e2?.code === 'PLATFORM_BUSY' || Number(e2?.retcode) === 10000;
      if (!busy) {
        log(`[dev] 续期后重试仍失败：${e2?.code ?? ''} ${e2?.message ?? e2}`);
        throw e2;
      }
      /**
       * 平台还没放开：把票留着、把等待写清楚，然后停手。
       *
       * 冷却按同一个等待设上（不是 10/20/40 递进）——这时候反复请求没有意义，
       * 只会让平台把恢复时间往后推。65 秒后由上层补一次，面板也按这个时间刷新。
       */
      const wait = renewWaitMs();
      cooldownUntil = Date.now() + wait;
      log(`[dev] 票据已换新，平台还在忙：${Math.round(wait / 1000)} 秒后再试（不再连打）`);
      throw devError('RENEWED_WAIT', `票据已换新，平台还在忙，${Math.round(wait / 1000)} 秒后自动重试`, {
        retryAfterMs: wait,
        retcode: 10000,
      });
    }
  }

  async function post(path, body = {}, opts = {}) {
    try {
      return await postOnce(path, body, opts);
    } catch (e) {
      const retried = await withRenew(postOnce, [path, body, opts], e);
      if (retried !== null) return retried;
      throw e;
    }
  }

  async function postForm(path, form) {
    try {
      return await postFormOnce(path, form);
    } catch (e) {
      const retried = await withRenew(postFormOnce, [path, form], e);
      if (retried !== null) return retried;
      throw e;
    }
  }

  return {
    adopt, merge, clear, describe, post, postForm, send, has,
    jar: () => new Map(jar),
    /**
     * 解开冷却（连递进计数一起清）。
     *
     * 给「计划内的重试」用：65 秒后补拉那一次是**我们自己排好的**，不该被
     * 上一轮留下的冷却在本地拦下——那种情况下日志会写「没重试」，实际是
     * 一次都没出网。
     */
    clearCooldown: () => { cooldownUntil = 0; cooldownStep = 0; },
  };
}
