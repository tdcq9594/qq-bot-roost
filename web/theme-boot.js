/**
 * 主题引导（在样式生效前跑，避免刷新时闪一下白底）
 *
 * 为什么单独成文件、不写在 index.html 里：
 * 面板现在启用了 CSP `script-src 'self'`，内联脚本会被浏览器直接拦掉。
 * 想保留内联就得开 `'unsafe-inline'` —— 那等于把 CSP 对脚本的保护整个作废，
 * 面板里任何一处 XSS 都能执行任意代码，而面板的 localStorage 里存着访问密钥。
 *
 * 所以宁可多一个几毫秒的请求。
 *
 * 这里**只照抄已经算好的值**，不做任何色彩推导：
 *   · 这个脚本跑在 <link rel="stylesheet"> 之前，读不到 CSS 变量；
 *   · 派生要走浏览器的 color-mix / oklch，抄一份比重写一遍稳。
 * 真正的计算在 app.js 的 applyAppearance() 里，落盘后由这里复用。
 */
(function () {
  try {
    var root = document.documentElement;
    /** 四套内置配色：手挑底色，其余（含自定义）走派生 —— 用在哪都要，先声明 */
    var NATIVE = ['a', 'b', 'c', 'd', 'default'];
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var cfg = null;
    try {
      cfg = JSON.parse(localStorage.getItem('qqbot_appearance') || 'null');
    } catch (e) {
      cfg = null; // 坏数据当没有，下面退回老键
    }

    /** 明暗：新结构看 mode（auto 跟随系统）；没有就退回老键 light / dark */
    var mode = (cfg && cfg.mode) || localStorage.getItem('qqbot_theme') || 'auto';
    var theme = mode === 'light' || mode === 'dark' ? mode : (mq.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    if (cfg && cfg.preset) root.dataset.preset = cfg.preset;
    if (cfg && cfg.preset) root.dataset.colorway = NATIVE.indexOf(cfg.preset) < 0 ? 'derived' : 'native';

    /** 底色：新结构 base，老键 palette。只认 a/b/c/d，别的一律回默认 */
    var base = (cfg && cfg.base) || localStorage.getItem('qqbot_palette') || 'a';
    // 黑夜不写 data-palette：浅色配色块带 :not([data-theme="dark"])，但属性不在更保险
    if (theme === 'light') root.dataset.palette = /^[abcdw]$/.test(base) ? base : 'a';

    /**
     * 浅色下的自定义主色。
     *
     * 深色是**固定黑白**，不读种子（CSS 那边派生块也被 :not([data-theme=dark])
     * 挡着）——所以这里只在浅色时写。四套内置配色由 CSS 手挑值渲染，
     * 同样不能加 data-appearance。
     */
    var hex = /^#[0-9a-f]{6}$/i;
    var seed = cfg && (typeof cfg.seed === 'string' ? cfg.seed : cfg.seed && cfg.seed.light);
    var ink = cfg && (typeof cfg.ink === 'string' ? cfg.ink : cfg.ink && cfg.ink.light);
    if (theme === 'light' && cfg && cfg.preset && NATIVE.indexOf(cfg.preset) < 0
        && hex.test(seed) && hex.test(ink)) {
      root.dataset.appearance = 'custom';
      root.style.setProperty('--seed-light', seed);
      root.style.setProperty('--ink-light', ink);
    }

    /**
     * 背景图开关：先按 localStorage 把「半透明表面」铺好，图本身由 app.js 从
     * IndexedDB 读出来再接上（这里读不了 IDB，它是异步的）。
     * 先铺半透明是有意的——否则首屏是实心面板，图一出来整页跳一下。
     */
    if (cfg && cfg.bg && cfg.bg.on && Number.isFinite(cfg.bg.blur) && Number.isFinite(cfg.bg.bright)) {
      root.dataset.bg = 'image';
      root.style.setProperty('--bg-blur', cfg.bg.blur + 'px');
      root.style.setProperty('--bg-bright', cfg.bg.bright + '%');
      if (Number.isFinite(cfg.bg.alpha)) root.style.setProperty('--surface-alpha', cfg.bg.alpha + '%');
    }
  } catch (e) {}
})();
