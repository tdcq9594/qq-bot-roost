/**
 * 面板登录表单（2026-11-28）。
 *
 * 为什么单独一个文件：主面板 CSP 是 `script-src 'self'`，401 页里不能写内联
 * <script>，否则被 CSP 拦掉、表单按了没反应还查不出原因。同源静态文件不在
 * 鉴权范围内（见 server.js「静态文件」段），所以未登录时也加载得到。
 *
 * 密钥只在 POST body 里交给 /api/login；成功后服务端设 HttpOnly Cookie 并
 * 返回 200，这里 reload 让首页带上 Cookie 走正常会话。
 *
 * 保留兼容：?key= 首跳那条路一行没改，dsh-roost / roost-mcp 照常工作。
 */
(function () {
  'use strict';
  var form = document.getElementById('loginForm');
  var input = document.getElementById('panelKey');
  var err = document.getElementById('loginError');
  if (!form || !input || !err) return;

  /** 改完凭证被踢回登录页时，把原因显示出来（不是普通「没会话」） */
  try {
    var notice = sessionStorage.getItem('roostLoginNotice');
    if (notice) {
      err.textContent = notice;
      err.style.color = '';
      sessionStorage.removeItem('roostLoginNotice');
    }
  } catch (_) {
    /* 隐私模式下 sessionStorage 不可用，忽略 */
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    err.textContent = '';
    var key = input.value;
    if (!key) {
      err.textContent = '请输入访问密钥';
      return;
    }
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try {
      var res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key }),
      });
      if (res.ok) {
        location.reload();
        return;
      }
      var msg = '登录失败（' + res.status + '）';
      try {
        var data = await res.json();
        if (data && data.error) msg = data.error;
      } catch (_) {
        /* 非 JSON 响应：保留状态码文案 */
      }
      err.textContent = msg;
      input.focus();
      input.select();
    } catch (netErr) {
      err.textContent = '网络错误，请确认面板是否还在运行';
    } finally {
      if (btn) btn.disabled = false;
    }
  });
})();
