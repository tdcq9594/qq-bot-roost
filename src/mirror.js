/**
 * 下载源（镜像）
 * ==============
 *
 * 国内直连 github.com / raw.githubusercontent.com 经常超时，插件市场和框架更新
 * 都会失败。这里提供「可自由切换的下载源」，参考了 BetterGI / MAA 这类国产工具
 * 的通行做法：**不猜哪个源快，让用户选，并提供一键测速**。
 *
 * 三种改写方式：
 *   none     直连，不改
 *   prefix   在前面加前缀，`https://ghfast.top/` + 原地址
 *            （ghfast / ghproxy / gh-proxy 都是这个套路）
 *   host     换域名，`github.com` → `kkgithub.com`
 *
 * `auto` 不是第四种改写，是策略：先直连，失败按顺序试镜像，
 * 记住这次成功的那个，10 分钟内优先用它——避免每次都要多等一次超时。
 *
 * 关于 MirrorChyan（BGI / MAA / M9A 都在用的 CDN）：
 * 它需要项目方先注册资源 ID，且下载包格式由上传方决定，和我们的 tar.gz 更新链
 * 不一定兼容。所以这里**只用它做版本检查**（快、稳、不限速），
 * 下载仍走镜像 tarball。没填 res_id 就完全不启用。
 */
import { createLogger } from './logger.js';

const log = createLogger('mirror');

/** 各源的定义。`kind` 决定怎么改写地址 */
export const PRESETS = [
  {
    id: 'auto',
    name: '自动（直连优先，失败切镜像）',
    kind: 'auto',
    note: '推荐。直连能用就用直连，连不上自动换镜像',
  },
  { id: 'github', name: 'GitHub 直连', kind: 'none', note: '不走任何代理，最干净' },
  {
    id: 'ghfast',
    name: 'ghfast.top',
    kind: 'prefix',
    base: 'https://ghfast.top/',
    note: '公共 gh 代理，支持 release 与 raw',
  },
  {
    id: 'ghproxy',
    name: 'ghproxy.net',
    kind: 'prefix',
    base: 'https://ghproxy.net/',
    note: '公共 gh 代理，老牌但偶尔限速',
  },
  {
    id: 'gh-proxy',
    name: 'gh-proxy.com',
    kind: 'prefix',
    base: 'https://gh-proxy.com/',
    note: '公共 gh 代理，备用',
  },
  {
    id: 'kkgithub',
    name: 'kkgithub.com',
    kind: 'host',
    map: {
      'github.com': 'kkgithub.com',
      'raw.githubusercontent.com': 'raw.kkgithub.com',
      'api.github.com': 'api.kkgithub.com',
      'objects.githubusercontent.com': 'objects.kkgithub.com',
    },
    note: '整站镜像，换域名不换路径',
  },
  { id: 'custom', name: '自定义前缀', kind: 'custom', note: '自建代理，填在下面' },
];

/** 直连失败时按这个顺序试（auto 模式用） */
const FALLBACK_ORDER = ['ghfast', 'ghproxy', 'gh-proxy', 'kkgithub'];

/** 测速用的固定小文件：框架仓库的 package.json，几百字节 */
export const PROBE_URL = 'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost/main/package.json';

/** 当前配置。由 main / 保存配置 / 配置热加载三处调用 configureMirror() 更新 */
let current = { id: 'auto', custom: '', chyanResId: '', chyanCdk: '' };

/** auto 模式记住上次成功的源：{ id, at } */
let autoPick = null;
const AUTO_TTL = 10 * 60_000;

/**
 * 从全局配置里读下载源设置。
 * @param {object} globalCfg config/bot.json 的内容
 */
export function configureMirror(globalCfg) {
  const n = globalCfg?.network ?? {};
  const id = String(n.mirror ?? 'auto').trim() || 'auto';
  current = {
    id: PRESETS.some((p) => p.id === id) ? id : 'auto',
    custom: String(n.mirrorCustom ?? '').trim(),
    chyanResId: String(n.mirrorChyanResId ?? '').trim(),
    chyanCdk: String(n.mirrorChyanCdk ?? '').trim(),
  };
  // 换了源就把「自动记住的那个」清掉，否则会继续用旧的
  autoPick = null;
  return current;
}

/** 当前设置（给面板显示） */
export function currentMirror() {
  return { ...current, preset: PRESETS.find((p) => p.id === current.id) ?? PRESETS[0] };
}

export function presetOf(id) {
  return PRESETS.find((p) => p.id === id) ?? null;
}

/** 只改写 GitHub 相关域名，别的地址原样返回（比如自建图床、MirrorChyan） */
function isGitHubUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)github\.com$/.test(h) || /(^|\.)githubusercontent\.com$/.test(h);
  } catch {
    return false;
  }
}

/**
 * 按某个源改写地址。
 * @param {string} url 原始地址
 * @param {object} preset PRESETS 里的一项
 * @param {string} [custom] 自定义前缀（preset.kind === 'custom' 时用）
 */
export function applyMirror(url, preset, custom = current.custom) {
  if (!url || !preset || preset.kind === 'none' || preset.kind === 'auto') return url;
  if (!isGitHubUrl(url)) return url;

  if (preset.kind === 'prefix' || preset.kind === 'custom') {
    const base = preset.kind === 'custom' ? custom : preset.base;
    if (!base) return url;
    // 允许用户只填域名，自动补协议和结尾斜杠
    let b = base.trim();
    if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
    if (!b.endsWith('/')) b += '/';
    // 已经是这个前缀了就别套第二次
    if (url.startsWith(b)) return url;
    return b + url;
  }

  if (preset.kind === 'host') {
    try {
      const u = new URL(url);
      const to = preset.map[u.hostname];
      if (!to) return url;
      u.hostname = to;
      return u.toString();
    } catch {
      return url;
    }
  }
  return url;
}

/**
 * 这次请求应该依次尝试哪些地址。
 *
 * @param {string} url 原始 GitHub 地址
 * @returns {string[]} 按优先级排好的候选地址
 */
export function mirrorCandidates(url) {
  if (!url || !isGitHubUrl(url)) return [url];

  const cfg = current;
  const preset = presetOf(cfg.id);

  // 指定了具体源：只走它（用户明确选择，不要偷偷改回直连）
  if (preset && preset.kind !== 'auto') {
    const one = applyMirror(url, preset, cfg.custom);
    // 自定义前缀没填：退回直连，别把请求发到空地址
    if (preset.kind === 'custom' && one === url && !cfg.custom) return [url];
    return one === url ? [url] : [one];
  }

  // auto：直连 → 记住的那个 → 其余镜像
  const order = [];
  if (autoPick && Date.now() - autoPick.at < AUTO_TTL) order.push(autoPick.id);
  for (const id of FALLBACK_ORDER) if (!order.includes(id)) order.push(id);

  const out = [url];
  for (const id of order) {
    const p = presetOf(id);
    const u = applyMirror(url, p, cfg.custom);
    if (u !== url && !out.includes(u)) out.push(u);
  }
  return out;
}

/**
 * 带镜像兜底的 fetch。
 *
 * 只有「网络层失败 / 5xx / 403 限流」才换源；4xx（除了 403）说明地址本身有问题，
 * 换源也没用，直接返回给调用方判断。
 *
 * **3xx 必须算成功。** 这是踩过的坑：`checkUpdate` 用 `redirect: 'manual'`
 * 去读 `releases/latest` 的 302 Location，而 `Response.ok` 只对 2xx 为真。
 * 以前这里写的是 `res.ok || (4xx…)`，于是直连拿到 302 被判成「失败」，
 * 转去试镜像、镜像又超时，最后报「连不上 GitHub」——
 * 明明直连一秒就通了，用户看到的是永远检查不出来。
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchViaMirror(url, init = {}) {
  const candidates = mirrorCandidates(url);
  let lastErr = null;

  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i];
    try {
      const res = await fetch(target, init);
      // 3xx：调用方多半在等 Location，不能当失败
      const accepted =
        res.ok ||
        (res.status >= 300 && res.status < 400) ||
        (res.status >= 400 && res.status < 500 && res.status !== 403);
      if (accepted) {
        // 成功了，记一下是哪个源（只有 auto 且不是直连时才记）
        if (res.ok && i > 0) rememberPick(target, url);
        return res;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < candidates.length - 1) {
      log.debug(`下载源 ${i + 1}/${candidates.length} 失败（${lastErr?.message}），换下一个`);
    }
  }

  throw lastErr ?? new Error('所有下载源都失败了');
}

/** 从成功的地址反推是哪个源，记下来下次优先 */
function rememberPick(target, origin) {
  if (current.id !== 'auto') return;
  for (const id of FALLBACK_ORDER) {
    const p = presetOf(id);
    if (applyMirror(origin, p, current.custom) === target) {
      if (autoPick?.id !== id) log.info(`自动下载源已切换到 ${p.name}`);
      autoPick = { id, at: Date.now() };
      return;
    }
  }
}

/**
 * 并发测速。面板上「测速」按钮用它，让用户按自己网络实际情况选。
 *
 * @param {{timeoutMs?: number, custom?: string}} [opts]
 * @returns {Promise<Array<{id:string, name:string, ok:boolean, ms:number, error?:string}>>}
 */
export async function probeMirrors({ timeoutMs = 6000, custom = current.custom } = {}) {
  const list = PRESETS.filter((p) => p.id !== 'auto');
  return Promise.all(
    list.map(async (p) => {
      const target = applyMirror(PROBE_URL, p, custom);
      const started = Date.now();
      try {
        const res = await fetch(target, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'qq-bot-roost' },
        });
        const ms = Date.now() - started;
        if (!res.ok) return { id: p.id, name: p.name, ok: false, ms, error: `HTTP ${res.status}` };
        await res.arrayBuffer(); // 读完再算耗时，否则只测到首字节
        return { id: p.id, name: p.name, ok: true, ms: Date.now() - started };
      } catch (e) {
        return {
          id: p.id,
          name: p.name,
          ok: false,
          ms: Date.now() - started,
          error: e?.name === 'TimeoutError' ? '超时' : e.message,
        };
      }
    }),
  );
}

/* ---------------- MirrorChyan（可选，只做版本检查） ---------------- */

/**
 * 用 MirrorChyan 查最新版本。
 *
 * 为什么只用它检查、不用它下载：它分发的是**项目方上传的包**，
 * 格式由上传方决定，和我们「拉仓库 tar.gz」的更新链不一定兼容。
 * 拿它当 CDN 查版本（快、稳、不限速）是安全的；拿它当下载源则有兼容风险。
 *
 * 没配 res_id 时返回 null，调用方走 GitHub。
 */
export async function checkViaMirrorChyan(currentVersion) {
  const { chyanResId, chyanCdk } = current;
  if (!chyanResId) return null;

  const q = new URLSearchParams({
    current_version: String(currentVersion ?? ''),
    user_agent: 'qq-bot-roost',
  });
  if (chyanCdk) q.set('cdk', chyanCdk);

  const url = `https://mirrorchyan.com/api/resources/${encodeURIComponent(chyanResId)}/latest?${q}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 0) {
      return { ok: false, error: data?.msg || `MirrorChyan 返回 HTTP ${res.status}` };
    }
    return {
      ok: true,
      version: String(data.data?.version_name ?? '').replace(/^v/i, ''),
      releaseNote: data.data?.release_note ?? '',
      // 有 CDK 且是新版才会给 url；格式不保证是 tar.gz，所以只做参考
      url: data.data?.url ?? '',
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'TimeoutError' ? '超时' : e.message };
  }
}
