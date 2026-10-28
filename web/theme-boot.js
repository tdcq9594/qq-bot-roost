/**
 * 主题引导（在样式生效前跑，避免刷新时闪一下白底）
 *
 * 为什么单独成文件、不写在 index.html 里：
 * 面板现在启用了 CSP `script-src 'self'`，内联脚本会被浏览器直接拦掉。
 * 想保留内联就得开 `'unsafe-inline'` —— 那等于把 CSP 对脚本的保护整个作废，
 * 面板里任何一处 XSS 都能执行任意代码，而面板的 localStorage 里存着访问密钥。
 *
 * 所以宁可多一个几毫秒的请求。
 */
(function () {
  try {
    var t = localStorage.getItem('qqbot_theme');
    if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
