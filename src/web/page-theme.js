/**
 * 插件页主题注入。
 *
 * 色值唯一真相源是 web/theme-vars.css，**这里一个颜色都不写**。
 * 服务端只做两件事：
 *   1. 把面板当前外观收敛成一组 data-* 属性与种子变量，写进插件页；
 *   2. 把 theme-vars.css 与基础排版一起内联注入。
 *
 * 为什么用 data-* 而不是服务端算好最终色值：
 *   算色值就得复制 oklch / color-mix 那套派生公式，style.css 一改就漂移。
 *   把状态传过去，让同一份 CSS 在插件页里自己匹配，才是真的零漂移。
 *
 * 为什么内联 theme-vars.css 而不是 <link>：
 *   插件页是 opaque origin，CSP 靠 http: 通配才放行外链；少一次请求还能
 *   避免首屏无样式闪一下；文件级缓存由 fsCache 做，不是浏览器缓存。
 *
 * 为什么 @layer（在 theme-vars.css 里）：
 *   分层样式的优先级低于插件自己写的未分层 CSS —— 插件作者写一句
 *   `:root{--panel:#fff}` 就能盖掉宿主配色，这是「也可以自己写」的保证。
 */

import fsSync from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const VARS_FILE = path.join(ROOT, 'web', 'theme-vars.css');

/** 必须与 web/app.js 的 PRESETS 保持一致；测试会比对两张表 */
export const NATIVE_PRESETS = new Set(['a', 'b', 'c', 'd', 'default']);
export const PRESET_IDS = new Set([
  'a', 'rose', 'b', 'sky', 'gold', 'c', 'green', 'd', 'pink', 'default', 'custom',
]);
const BASES = new Set(['a', 'b', 'c', 'd', 'w']);
const HEX = /^#[0-9a-f]{6}$/i;

function oneOf(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function safeHex(value, fallback) {
  return HEX.test(String(value ?? '')) ? value : fallback;
}

function clampInt(value, lo, hi, fallback) {
  // Number(null) === 0，不挡住的话「没传 alpha」会被 clamp 成下限而不是默认值
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

/** 插件页基础排版：和面板的组件样式隔开，只给插件作者一个能直接用的底 */
export const BASE_CSS = `
body{margin:0;padding:16px;background:var(--panel);color:var(--text);
font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:var(--primary)}
h1,h2,h3{color:var(--text);font-weight:600}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)}
th{font-size:12px;font-weight:600;color:var(--muted)}
code{background:var(--panel-2);padding:1px 5px;border-radius:4px}
`;

/** theme-vars.css 是静态文件，读一次缓存住；改样式要重启框架进程才生效 */
let varsCache = '';
function themeVarsCss() {
  if (!varsCache) varsCache = fsSync.readFileSync(VARS_FILE, 'utf8');
  return varsCache;
}

/**
 * 把 URL 参数收敛成已知安全的状态。
 *
 * 所有值都经白名单 / 正则 / clamp —— 它们会拼进 <script>，不能信原始输入。
 * 非法值一律退到默认值，不抛错：插件页宁可用错配色，也不能打不开。
 */
export function pageThemeState(params) {
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const preset = oneOf(params.get('preset'), PRESET_IDS, 'a');
  const base = oneOf(params.get('base'), BASES, 'a');
  /**
   * colorway / appearance 由 preset 推导，不收前端传来的值：
   * 前端若传了自相矛盾的一对（preset=rose + colorway=native），CSS 会
   * 显示成 A 配色，作者很难查。这里只认 preset，天然一致。
   */
  const native = NATIVE_PRESETS.has(preset);
  const colorway = native ? 'native' : 'derived';
  const appearance = theme === 'light' && !native;
  return {
    theme,
    preset,
    base,
    colorway,
    appearance,
    seed: safeHex(params.get('seed'), '#af5504'),
    ink: safeHex(params.get('ink'), '#ffffff'),
    glass: params.get('glass') === '1',
    alpha: clampInt(params.get('alpha'), 60, 96, 84),
  };
}

/** 生成要插在插件 HTML 最前面的内容（doctype 之后、插件自己的样式之前） */
export function buildPageTheme(params) {
  const s = pageThemeState(params);
  const attrs = [['theme', s.theme], ['preset', s.preset], ['colorway', s.colorway]];
  // 深色刻意不写 data-palette / data-appearance：CSS 里虽有 :not([data-theme=dark])
  // 挡着，这里再摘掉属性是第二道保险，和面板 applyAppearance 同一口径。
  if (s.theme === 'light') attrs.push(['palette', s.base]);
  if (s.appearance) attrs.push(['appearance', 'custom']);
  if (s.glass) attrs.push(['bg', 'image']);

  const assigns = attrs
    .map(([k, v]) => `r.setAttribute('data-${k}',${JSON.stringify(v)})`)
    .join(';');
  const script =
    '<script>(function(){var r=document.documentElement;' + assigns +
    ';r.style.setProperty(\'--seed-light\',' + JSON.stringify(s.seed) + ')' +
    ';r.style.setProperty(\'--ink-light\',' + JSON.stringify(s.ink) + ')' +
    ';r.style.setProperty(\'--surface-alpha\',' + JSON.stringify(s.alpha + '%') + ')' +
    ';})();</script>';

  return script + '<style>' + themeVarsCss() + BASE_CSS + '</style>';
}
