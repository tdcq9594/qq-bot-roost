/**
 * npm 源（registry）解析
 * ======================
 *
 * 框架本体零依赖，但**插件依赖**和**外接依赖**都要走 npm。国内直连
 * `registry.npmjs.org` 常常几十秒超时，用户看到的只有一句「安装依赖失败」，
 * 分不清是网断了、没装 Node，还是源不通。
 *
 * 和 `mirror.js` 的分工：
 *   · `mirror.js` 改的是 **GitHub 地址**（raw / archive / codeload）；
 *   · 这里改的是 **npm registry**。
 * 两者互不相干，但策略一致——**不猜哪个源快，让用户选**。
 *
 * 解析优先级（高 → 低）：
 *   1. 调用方显式传的 `override`（面板/接口传进来的）
 *   2. `config.network.npmRegistry`（用户在本框架面板里选的）
 *   3. 环境变量 `npm_config_registry`（用户自己 `npm config set` 过）
 *   4. `~/.npmrc` / 当前目录 `.npmrc` 里的 `registry=`
 *   5. 官方源
 *
 * **默认永远官方源**：只有用户显式配了才换。自动测速会让「装依赖」这件
 * 本来就慢的事再多等几秒，还会引入一层不确定性——宁可让用户自己选。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('npm-registry');

/** 官方源。**不带尾斜杠**：下面拼 URL 时统一按「没有尾斜杠」处理 */
export const OFFICIAL = 'https://registry.npmjs.org';

/** 国内最常用的镜像。与官方同步有分钟级延迟，但直连快得多 */
export const NPM_MIRROR = 'https://registry.npmmirror.com';

/**
 * 面板下拉框用的预设。`url` 为空的项表示「要用户再填一个地址」。
 *
 * 只留官方 + npmmirror + 自定义：以前有人列过 cnpm / yarn 淘宝 / 腾讯云
 * 一堆，实测要么停服要么同步不全，多一个选项就多一种「装不上但不知道
 * 为什么」的排查成本。
 */
export const PRESETS = [
  { id: 'official', name: 'npm 官方源', url: OFFICIAL, note: '默认。直连 registry.npmjs.org' },
  { id: 'npmmirror', name: 'npmmirror 镜像（阿里）', url: NPM_MIRROR, note: '国内直连快，与官方有分钟级同步延迟' },
  { id: 'custom', name: '自定义', url: '', note: '公司内网源 / 自建 registry，必须 http(s)' },
];

/** 当前配置（由 `configureRegistry()` 更新，main / 配置热加载两处调用） */
let configured = { id: 'official', custom: '' };

/**
 * 规范化一个 registry 地址：补协议、去尾斜杠、只认 http(s)。
 * 认不出来返回空串（调用方按「没配」处理，不要抛）。
 */
export function normRegistry(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return withProto.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * 从 `globalCfg.network` 读 npm 源配置。
 *
 * `npmRegistry` 接受三种写法：
 *   ''            → 跟随系统（env / .npmrc），再没有就用官方源
 *   'official'    → 强制官方源
 *   'npmmirror'   → 淘宝镜像
 *   完整 URL      → 自定义源
 */
export function configureRegistry(globalCfg) {
  const n = globalCfg?.network ?? {};
  const raw = String(n.npmRegistry ?? '').trim();
  if (!raw || raw === 'official') {
    configured = { id: 'official', custom: '' };
    return configured;
  }
  if (raw === 'npmmirror') {
    configured = { id: 'npmmirror', custom: '' };
    return configured;
  }
  const url = normRegistry(raw);
  if (!url) {
    log.warn(`network.npmRegistry 不是合法的 http(s) 地址，已忽略：${raw}`);
    configured = { id: 'official', custom: '' };
    return configured;
  }
  configured = { id: 'custom', custom: url };
  return configured;
}

/** 只读当前配置（面板显示用） */
export function registryConfig() {
  return { ...configured };
}

/** 从 .npmrc 文本里挑出 `registry=` 那一行 */
function parseNpmrc(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const m = l.match(/^registry\s*=\s*(.+)$/i);
    if (!m) continue;
    const url = normRegistry(String(m[1]).replace(/^["']|["']$/g, ''));
    if (url) return url;
  }
  return '';
}

/** `.npmrc` 只读一次：它不会在进程生命周期里变（改了也该重启） */
let npmrcCache; // undefined = 没读过；'' = 读过了但没有
function npmrcRegistry() {
  if (npmrcCache !== undefined) return npmrcCache;
  /**
   * 顺序对齐 npm 自己：项目级 `.npmrc` 覆盖用户级。
   * 「项目」在这里指进程当前目录——`npm install` 的 cwd 也是它。
   */
  const files = [path.join(process.cwd(), '.npmrc'), path.join(homedir(), '.npmrc')];
  for (const f of files) {
    try {
      const url = parseNpmrc(readFileSync(f, 'utf8'));
      if (url) {
        npmrcCache = url;
        return url;
      }
    } catch {
      // 没有这个文件很正常
    }
  }
  npmrcCache = '';
  return '';
}

/** 测试/热加载用：丢掉 .npmrc 缓存 */
export function resetRegistryCache() {
  npmrcCache = undefined;
}

/**
 * 算出这次该用哪个 registry。
 *
 * @param {{override?: string}} [o] `override` 来自接口/面板，优先级最高
 * @returns {{url: string, source: 'explicit'|'config'|'env'|'npmrc'|'default'}}
 */
export function resolveRegistry({ override } = {}) {
  const own = normRegistry(override);
  if (own) return { url: own, source: 'explicit' };

  if (configured.id === 'npmmirror') return { url: NPM_MIRROR, source: 'config' };
  if (configured.id === 'custom' && configured.custom) return { url: configured.custom, source: 'config' };
  /** `official` 是「显式选官方」，但也要让 env/.npmrc 生效——用户可能只是想清掉面板里的选择 */

  const env = normRegistry(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY);
  if (env) return { url: env, source: 'env' };

  const rc = npmrcRegistry();
  if (rc) return { url: rc, source: 'npmrc' };

  return { url: OFFICIAL, source: 'default' };
}

/**
 * 给 `npm install` / `pnpm install` 拼 `--registry` 参数。
 *
 * **解析结果是官方源时不传**：那说明用户什么都没配，让 npm 走它自己的默认
 * 逻辑（还会读 `.npmrc` 里的 scoped registry），少一处可能互相打架的地方。
 *
 * @param {{override?: string}} [o]
 * @returns {string[]} 空数组表示「不用加参数」
 */
export function registryArgs(o) {
  const r = resolveRegistry(o);
  return r.source === 'default' ? [] : [`--registry=${r.url}`];
}

/**
 * 直链下载（tgz）用的候选源，按尝试顺序排列。
 *
 * 直链下载**绕过了 npm**，所以 `npm_config_registry` 对它无效——
 * 语音引擎那 50 多 MB 就是这么在国内下不动的。这里给它一份可轮询的列表：
 * 用户配的源优先，然后官方，最后镜像兜底。
 *
 * @param {{override?: string}} [o]
 * @returns {string[]}
 */
export function downloadRegistries(o) {
  const r = resolveRegistry(o);
  return [...new Set([r.url, OFFICIAL, NPM_MIRROR].filter(Boolean))];
}

/**
 * npm 包的 tgz 直链。
 *
 * scoped 包（`@scope/name`）的 tarball 文件名**不带 scope**：
 *   https://registry.npmjs.org/@scope/name/-/name-1.0.0.tgz
 */
export function tgzUrl(name, version, registry = OFFICIAL) {
  const base = normRegistry(registry) || OFFICIAL;
  const full = String(name);
  const short = full.includes('/') ? full.split('/').pop() : full;
  return `${base}/${full}/-/${short}-${version}.tgz`;
}
