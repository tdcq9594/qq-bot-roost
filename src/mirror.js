/**
 * 下载源（镜像）
 * ==============
 *
 * 国内直连 github.com / raw.githubusercontent.com 经常超时，插件市场和框架更新
 * 都会失败。这里提供「可自由切换的下载源」，参考了 BetterGI / MAA 这类国产工具
 * 的通行做法：**不猜哪个源快，让用户选，并提供一键测速**。
 *
 * 两个真实来源，加一个逃生舱：
 *
 *   github   GitHub 官方（直连）
 *   gitee    作者维护的 Gitee 镜像仓库，内容与 GitHub 逐字节相同
 *   custom   自建代理前缀（你自己搭的 gh 代理，填在下面）
 *
 * `auto` 不是来源，是策略：先直连 GitHub，失败按顺序试 Gitee，
 * 记住这次成功的那个，10 分钟内优先用它——避免每次都要多等一次超时。
 *
 * **为什么只留这两个来源**：以前还带过 ghfast / ghproxy / gh-proxy / kkgithub
 * 一串公共代理和 MirrorChyan。实际用下来要么限速、要么挂掉、要么悄悄改内容，
 * 用户装了反而更难排查。作者自己的 Gitee 镜像是可控的，删到只剩它。
 *
 * 关于 archive 直链：Gitee 没有等价物（`/repository/archive/` 返回的是网页），
 * 所以 Gitee 源下的「整包下载」不走镜像改写，由调用方改走 git trees + raw
 * 逐文件拉（见 src/gitee.js）。这里的 `gitee` 映射只处理 raw 文件地址。
 */
import { createLogger } from './logger.js';

const log = createLogger('mirror');

/** 各源的定义。`kind` 决定怎么改写地址 */
export const PRESETS = [
  {
    id: 'auto',
    name: '自动（直连优先，失败切 Gitee）',
    kind: 'auto',
    note: '推荐。GitHub 能用就用，连不上自动换 Gitee 镜像',
  },
  { id: 'github', name: 'GitHub 官方', kind: 'none', note: '直连 github.com，最干净' },
  {
    id: 'gitee',
    name: 'Gitee 镜像（作者维护）',
    kind: 'gitee',
    note: 'gitee.com/tdcq9594 下的同名镜像仓库，国内直连快',
  },
  { id: 'custom', name: '自定义前缀', kind: 'custom', note: '自建 gh 代理，填在下面' },
];

/** 直连失败时按这个顺序试（auto 模式用） */
const FALLBACK_ORDER = ['gitee'];

/**
 * 测速用的固定小文件：框架仓库的 package.json，几百字节。
 *
 * **必须用 master 分支**。以前写的是 `main`，而这个仓库的默认分支是
 * `master`——于是每个源都返回 404，测速面板一片红，看着像「所有源都不通」，
 * 实际是探测地址本身错了。真实用户也会遇到：fork 出去改名分支的话，
 * 这里要跟着改，或者用下面的 PROBE_FALLBACKS 多试几个。
 */
export const PROBE_URL = 'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost/master/package.json';

/**
 * 主探测地址失败时按顺序换分支再试。
 *
 * 上面的 main/master 改来改去总有漏的一天（fork、改默认分支、文档抄错），
 * 而测速面板的错误信息是「所有源都不通」——用户只会以为是自己网络坏了。
 * 所以一个地址 404 时就换下一个，都不行才真的报不通。
 */
const PROBE_FALLBACKS = [
  PROBE_URL,
  PROBE_URL.replace('/master/', '/main/'),
  'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost/master/README.md',
  'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost/main/README.md',
];

/** 当前配置。由 main / 保存配置 / 配置热加载三处调用 configureMirror() 更新 */
let current = { id: 'auto', custom: '', giteeToken: '' };

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

  /**
   * 自定义下载前缀必须是 https。
   *
   * 这个值会被直接拼在 tarball 地址前面（见 applyMirror），而这个项目**更新包
   * 没有内容校验**（updater.js 的 expectSha256 恒为 null）。也就是说：
   * 填一个 http 地址，等于让链路上的任何人决定你下一版跑什么代码。
   *
   * 不合法就退回默认（不用它），而不是抛错 —— 配置文件写错了不该让整个框架起不来。
   */
  let custom = String(n.mirrorCustom ?? '').trim();
  if (custom) {
    let u = null;
    try {
      u = new URL(custom.includes('://') ? custom : `https://${custom}`);
    } catch {
      u = null;
    }
    if (!u || u.protocol !== 'https:') {
      log.warn(
        `network.mirrorCustom 必须是 https:// 开头，已忽略：${custom}\n` +
          '  （自定义下载源会决定你下一版跑什么代码，明文 http 等于把它交给链路上的任何人）',
      );
      custom = '';
    }
  }

  current = {
    id: PRESETS.some((p) => p.id === id) ? id : 'auto',
    custom,
    // Gitee 私人令牌：选填。公开仓库匿名也能用，填了只是把 API 配额提上去
    giteeToken: String(n.giteeToken ?? '').trim(),
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

/** 只改写 GitHub 相关域名，别的地址原样返回（比如自建图床、Gitee 自身） */
function isGitHubUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)github\.com$/.test(h) || /(^|\.)githubusercontent\.com$/.test(h);
  } catch {
    return false;
  }
}

/**
 * GitHub raw 地址 → Gitee raw 地址。
 *
 *   raw.githubusercontent.com/{repo}/{ref}/{path}
 *     → gitee.com/{repo}/raw/{ref}/{path}
 *
 * 只认 raw。github.com 的 archive / releases / api 地址在 Gitee 没有对应物，
 * 原样返回，由调用方走 src/gitee.js 的 trees 下载。
 */
function toGiteeRaw(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'raw.githubusercontent.com') return url;
    // /{repo}/{ref}/{path...}，repo 固定两段
    const seg = u.pathname.replace(/^\//, '').split('/');
    if (seg.length < 4) return url;
    const [owner, name, ref, ...rest] = seg;
    if (!owner || !name || !ref || !rest.length) return url;
    return `https://gitee.com/${owner}/${name}/raw/${ref}/${rest.join('/')}`;
  } catch {
    return url;
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

  if (preset.kind === 'gitee') {
    return toGiteeRaw(url);
  }

  if (preset.kind === 'prefix' || preset.kind === 'custom') {
    const base = preset.kind === 'custom' ? custom : preset.base;
    if (!base) return url;
    // 允许用户只填域名，自动补协议和结尾斜杠
    let b = base.trim();
    if (!/^https?:\/\//i.test(b)) b = `https://${b}`;
    /**
     * 自定义前缀必须是 https —— 这里再挡一道。
     *
     * configureMirror 已经校验过配置里的值，但 `probeMirrors` 的 custom 是
     * 面板请求体直接传进来的（「测速」按钮），不经过 configureMirror。
     * 不合法就**退回原始地址**，不要拼一个 http 前缀上去。
     */
    if (preset.kind === 'custom' && !/^https:\/\//i.test(b)) {
      log.warn(`自定义下载源必须是 https，已忽略：${base}`);
      return url;
    }
    if (!b.endsWith('/')) b += '/';
    // 已经是这个前缀了就别套第二次
    if (url.startsWith(b)) return url;
    return b + url;
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
      const started = Date.now();
      let lastErr = null;

      // 逐个探测地址试：404 说明这个分支不对，换下一个，别直接判「源不通」
      for (const probe of PROBE_FALLBACKS) {
        const target = applyMirror(probe, p, custom);
        try {
          const res = await fetch(target, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'User-Agent': 'qq-bot-roost' },
          });
          if (res.ok) {
            await res.arrayBuffer(); // 读完再算耗时，否则只测到首字节
            return { id: p.id, name: p.name, ok: true, ms: Date.now() - started };
          }
          lastErr = `HTTP ${res.status}`;
          // 404 是地址问题，值得换分支再试；其它状态码说明源活着，不用试了
          if (res.status !== 404) break;
        } catch (e) {
          lastErr = e?.name === 'TimeoutError' ? '超时' : e.message;
          // 超时/网络错是源的问题，换分支也没用
          break;
        }
      }

      return {
        id: p.id,
        name: p.name,
        ok: false,
        ms: Date.now() - started,
        error: lastErr ?? '未知错误',
      };
    }),
  );
}
