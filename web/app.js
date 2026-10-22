/* QQ 机器人控制台前端：原生 JS，无框架、无构建 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// token 从 URL 取一次，之后存 localStorage，避免刷新丢失
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) localStorage.setItem('qqbot_token', urlToken);
const TOKEN = localStorage.getItem('qqbot_token') || '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { 'X-Token': TOKEN } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 工具 ---------------- */

function fmtDuration(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}天 ${h}小时`;
  if (h) return `${h}小时 ${m}分`;
  if (m) return `${m}分 ${sec}秒`;
  return `${sec}秒`;
}

function fmtAgo(ts) {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.max(1, Math.floor(diff / 1000))} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function shortId(id) {
  if (!id) return '-';
  return id.length > 18 ? id.slice(0, 8) + '…' + id.slice(-6) : id;
}

/* ---------------- Tab ---------------- */

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
    if (btn.dataset.tab === 'plugins') loadPlugins();
    if (btn.dataset.tab === 'config') loadConfig();
    if (btn.dataset.tab === 'groups') loadGroups();
  });
});

/* ---------------- 概览 ---------------- */

function renderStatus(s) {
  const pill = $('#connPill');
  pill.classList.toggle('online', s.connected);
  pill.classList.toggle('offline', !s.connected);
  $('#connText').textContent = s.connected ? '在线' : '离线';
  $('#connDot').style.background = '';
  $('#botName').textContent = s.connected ? s.botName || '已连接' : '未连接';

  $('#c-conn').textContent = s.connected ? '在线' : '离线';
  $('#c-uptime').textContent = fmtDuration(s.uptimeMs);
  $('#c-token').textContent = s.tokenExpiresIn ? `${Math.floor(s.tokenExpiresIn / 60)} 分` : '-';
  $('#c-mem').textContent = `${s.memoryMB} MB`;
  $('#c-recv').textContent = s.counters.recv;
  $('#c-sent').textContent = s.counters.sent;
  $('#c-cmd').textContent = s.counters.commands;
  $('#c-err').textContent = `${s.counters.errors} / ${s.counters.dedup + s.counters.limited + s.counters.rejected}`;

  $('#i-botid').textContent = s.botId || '-';
  $('#i-gw').textContent = s.gatewayUrl || '-';
  $('#i-session').textContent = shortId(s.sessionId);
  $('#i-intents').textContent = s.intents;
  $('#i-prefix').textContent = s.prefix;
  $('#i-reconn').textContent = s.reconnectCount;
  const evEl = $('#i-events');
  if (evEl) {
    if (!s.events || !s.events.length) {
      evEl.innerHTML = '<span style="color:var(--warn)">一条都没收到</span>';
    } else {
      evEl.textContent = s.events.map((e) => `${e.name}×${e.count}`).join('  ');
    }
  }
  $('#i-node').textContent = `${s.node} (${s.platform})`;

  const body = $('#chatBody');
  if (!s.chats?.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">暂无数据</td></tr>';
  } else {
    body.innerHTML = s.chats.map((c) => `
      <tr>
        <td class="mono" title="${c.id}">${shortId(c.id)}</td>
        <td>${c.kind === 'group' ? '群聊' : c.kind === 'c2c' ? '私聊' : c.kind}</td>
        <td class="num">${c.count}</td>
        <td>${fmtAgo(c.last)}</td>
      </tr>`).join('');
  }
}

async function pollStatus() {
  try {
    renderStatus(await api('/api/status'));
  } catch (e) {
    $('#connText').textContent = '面板断开';
    $('#connPill').className = 'status-pill offline';
  }
}

$('#btnReconnect').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await api('/api/gateway/reconnect', { method: 'POST' }); }
  catch (err) { alert('重连失败: ' + err.message); }
  finally { setTimeout(() => { e.target.disabled = false; pollStatus(); }, 1200); }
});

$('#btnRefreshToken').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await api('/api/token/refresh', { method: 'POST' }); alert('Token 已刷新'); }
  catch (err) { alert('刷新失败: ' + err.message); }
  finally { e.target.disabled = false; }
});

$('#btnSend').addEventListener('click', async (e) => {
  const scene = $('#sendScene').value;
  const target = $('#sendTarget').value.trim();
  const content = $('#sendContent').value.trim();
  const hint = $('#sendHint');
  if (!target || !content) { hint.textContent = '请填写目标和内容'; return; }
  e.target.disabled = true;
  try {
    await api('/api/send', { method: 'POST', body: JSON.stringify({ scene, target, content }) });
    hint.textContent = '已发送';
    $('#sendContent').value = '';
  } catch (err) {
    hint.textContent = '发送失败: ' + err.message;
  } finally { e.target.disabled = false; }
});

/* ---------------- 配置 ---------------- */

const INTENT_PRESETS = ['33554432', '1073741824', '33554434'];

function fillForm(c) {
  const f = $('#cfgForm');
  f.appId.value = c.appId || '';
  f.appSecret.value = '';
  f.appSecret.placeholder = c.appSecretSet ? '已设置，留空则不修改' : '请输入 AppSecret';
  f.baseUrl.value = c.baseUrl || '';
  f.commandPrefix.value = c.commandPrefix || '/';

  owners = [...(c.owners || [])];
  renderOwners();
  $('#autoOwner').checked = c.autoOwnerOnInvite !== false;

  const preset = INTENT_PRESETS.includes(String(c.intents)) ? String(c.intents) : 'custom';
  $('#intentsPreset').value = preset;
  $('#intentsCustomWrap').style.display = preset === 'custom' ? '' : 'none';
  f.intents.value = c.intents;

  f.whitelistEnabled.checked = Boolean(c.whitelist?.enabled);
  f.whitelistGroups.value = (c.whitelist?.groups || []).join('\n');
  f.whitelistUsers.value = (c.whitelist?.users || []).join('\n');
  f.rateLimitEnabled.checked = c.rateLimit?.enabled !== false;
  f.perChatPerMinute.value = c.rateLimit?.perChatPerMinute ?? 30;
  f.dedupWindowSec.value = c.dedupWindowSec ?? 120;

  f.webuiHost.value = c.webui?.host || '127.0.0.1';
  f.webuiPort.value = c.webui?.port ?? 8080;
  f.webuiToken.value = c.webui?.token || '';
  f.logLevel.value = c.logLevel || 'info';
}

async function loadConfig() {
  try {
    fillForm(await api('/api/config'));
  } catch (e) {
    $('#cfgMsg').textContent = '读取配置失败: ' + e.message;
  }
}

$('#intentsPreset').addEventListener('change', (e) => {
  const custom = e.target.value === 'custom';
  $('#intentsCustomWrap').style.display = custom ? '' : 'none';
  if (!custom) $('#cfgForm').intents.value = e.target.value;
});

$('#cfgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const lines = (v) => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const payload = {
    appId: f.appId.value.trim(),
    appSecret: f.appSecret.value.trim(),
    baseUrl: f.baseUrl.value.trim(),
    commandPrefix: f.commandPrefix.value.trim() || '/',
    intents: Number(f.intents.value),
    logLevel: f.logLevel.value,
    whitelist: {
      enabled: f.whitelistEnabled.checked,
      groups: lines(f.whitelistGroups.value),
      users: lines(f.whitelistUsers.value),
    },
    rateLimit: {
      enabled: f.rateLimitEnabled.checked,
      perChatPerMinute: Number(f.perChatPerMinute.value) || 30,
    },
    dedupWindowSec: Number(f.dedupWindowSec.value) || 0,
    webui: {
      host: f.webuiHost.value.trim() || '127.0.0.1',
      port: Number(f.webuiPort.value) || 8080,
      token: f.webuiToken.value.trim(),
    },
  };

  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#cfgMsg').textContent = '保存中…';
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
    $('#cfgMsg').textContent = '已保存' + (payload.appId ? '' : '（AppID 为空）');
    f.appSecret.value = '';
    setTimeout(() => ($('#cfgMsg').textContent = ''), 3000);
    pollStatus();
  } catch (err) {
    $('#cfgMsg').textContent = '保存失败: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 插件 ---------------- */

async function loadPlugins() {
  const wrap = $('#pluginList');
  try {
    const list = await api('/api/plugins');
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">还没有插件，把文件夹放进 plugins/ 即可</div>';
      return;
    }
    wrap.innerHTML = list.map((p) => `
      <div class="plugin" data-id="${p.id}">
        <div class="info">
          <div class="name">${p.name || p.id} <span class="hint">v${p.version || '0.0.0'}</span></div>
          <div class="meta">${p.id}${p.description ? ' · ' + p.description : ''}</div>
          ${p.error ? `<div class="err">加载失败: ${p.error}</div>` : ''}
        </div>
        <span class="badge ${p.loaded ? 'on' : p.enabled ? '' : 'off'}">
          ${p.loaded ? '运行中' : p.enabled ? '未加载' : '已禁用'}
        </span>
        <button class="btn small" data-act="${p.enabled ? 'disable' : 'enable'}">
          ${p.enabled ? '禁用' : '启用'}
        </button>
        <button class="btn small" data-act="reload">重载</button>
      </div>`).join('');

    wrap.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('.plugin').dataset.id;
        btn.disabled = true;
        try {
          await api(`/api/plugins/${encodeURIComponent(id)}/${btn.dataset.act}`, { method: 'POST' });
          await loadPlugins();
        } catch (e) {
          alert('操作失败: ' + e.message);
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    wrap.innerHTML = `<div class="empty">加载失败: ${e.message}</div>`;
  }
}

/* ---------------- 主人与群组 ---------------- */

let owners = [];

function renderOwners() {
  const wrap = $('#ownerChips');
  if (!wrap) return;
  if (!owners.length) {
    wrap.innerHTML = '<span class="hint">还没有主人。机器人被拉进群后会自动把邀请人设为主人，也可以手动添加。</span>';
    return;
  }
  wrap.innerHTML = owners
    .map((o) => `<span class="chip" data-id="${o}">${shortId(o)}<button class="chip-x" title="移除">×</button></span>`)
    .join('');
  wrap.querySelectorAll('.chip-x').forEach((btn) => {
    btn.addEventListener('click', () => removeOwner(btn.closest('.chip').dataset.id));
  });
}

async function saveOwners() {
  await api('/api/config', { method: 'PUT', body: JSON.stringify({ owners }) });
}

async function addOwner() {
  const input = $('#ownerInput');
  const v = input.value.trim();
  if (!v) return;
  if (owners.includes(v)) { input.value = ''; return; }
  owners.push(v);
  await saveOwners();
  input.value = '';
  renderOwners();
  pollStatus();
}

async function removeOwner(id) {
  owners = owners.filter((x) => x !== id);
  await saveOwners();
  renderOwners();
  pollStatus();
}

$('#btnAddOwner')?.addEventListener('click', addOwner);
$('#ownerInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addOwner(); }
});

$('#autoOwner')?.addEventListener('change', async (e) => {
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ autoOwnerOnInvite: e.target.checked }),
    });
  } catch (err) {
    alert('保存失败: ' + err.message);
    e.target.checked = !e.target.checked;
  }
});

async function loadGroups() {
  const body = $('#groupBody');
  if (!body) return;
  try {
    renderGroups(await api('/api/groups'));
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="empty">加载失败: ${e.message}</td></tr>`;
  }
}

function renderGroups(list) {
  const body = $('#groupBody');
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">还没有群。把机器人拉进群后这里会自动出现。</td></tr>';
    return;
  }
  body.innerHTML = list
    .map((g) => `
      <tr data-id="${g.groupOpenid}">
        <td class="mono" title="${g.groupOpenid}">${shortId(g.groupOpenid)}</td>
        <td class="mono" title="${g.inviterOpenid || ''}">${g.inviterOpenid ? shortId(g.inviterOpenid) : '-'}</td>
        <td><input class="inline-input admin-input" value="${g.adminOpenid || ''}" placeholder="未设置"></td>
        <td><span class="badge ${g.enabled ? 'on' : 'off'}">${g.enabled ? '在用' : '已移出'}</span></td>
        <td>${g.lastActiveAt ? fmtAgo(g.lastActiveAt) : '-'}</td>
        <td class="num">
          <button class="btn small" data-act="save">保存</button>
          <button class="btn small danger" data-act="del">删除</button>
        </td>
      </tr>`)
    .join('');

  body.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      btn.disabled = true;
      try {
        if (btn.dataset.act === 'save') {
          const val = tr.querySelector('.admin-input').value.trim();
          await api(`/api/groups/${encodeURIComponent(id)}`, {
            method: 'PUT',
            body: JSON.stringify({ adminOpenid: val }),
          });
        } else {
          if (!confirm('确定删除这个群的记录？机器人不会退群，只是忘掉它的配置。')) {
            btn.disabled = false;
            return;
          }
          await api(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
        }
        await loadGroups();
      } catch (e) {
        alert('操作失败: ' + e.message);
        btn.disabled = false;
      }
    });
  });
}

$('#btnReloadGroups')?.addEventListener('click', loadGroups);

async function addGroupManually() {
  const input = $('#groupInput');
  const id = input.value.trim();
  if (!id) return;
  try {
    await api(`/api/groups/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, note: '手动登记' }),
    });
    input.value = '';
    await loadGroups();
  } catch (e) {
    alert('登记失败: ' + e.message);
  }
}

$('#btnAddGroup')?.addEventListener('click', addGroupManually);
$('#groupInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addGroupManually(); }
});

/* ---------------- 日志 ---------------- */

const logView = $('#logView');
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
let logBuf = [];

function logLine(e) {
  const el = document.createElement('div');
  el.className = `log-line ${e.level}`;
  el.dataset.level = e.level;
  el.innerHTML = `<span class="t">${e.time}</span>${e.tag ? `<span class="tag">[${e.tag}]</span>` : ''}${escapeHtml(e.msg)}`;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function applyFilter() {
  const min = LEVEL_ORDER[$('#logLevelFilter').value] ?? 0;
  logView.querySelectorAll('.log-line').forEach((el) => {
    el.style.display = (LEVEL_ORDER[el.dataset.level] ?? 0) >= min ? '' : 'none';
  });
}

function appendLog(e) {
  logBuf.push(e);
  if (logBuf.length > 600) logBuf.shift();
  const el = logLine(e);
  const min = LEVEL_ORDER[$('#logLevelFilter').value] ?? 0;
  if ((LEVEL_ORDER[e.level] ?? 0) < min) el.style.display = 'none';
  const atBottom = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 40;
  logView.appendChild(el);
  if ($('#autoScroll').checked && atBottom) logView.scrollTop = logView.scrollHeight;
}

$('#logLevelFilter').addEventListener('change', applyFilter);
$('#btnClearLog').addEventListener('click', () => { logBuf = []; logView.innerHTML = ''; });

async function initLogs() {
  try {
    const list = await api('/api/logs?limit=300&level=debug');
    logView.innerHTML = '';
    list.forEach(appendLog);
    logView.scrollTop = logView.scrollHeight;
  } catch {}
}

/* ---------------- SSE ---------------- */

function connectStream() {
  const qs = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
  const es = new EventSource(`/api/stream${qs}`);
  es.addEventListener('status', (ev) => {
    try { renderStatus(JSON.parse(ev.data)); } catch {}
  });
  es.addEventListener('log', (ev) => {
    try { appendLog(JSON.parse(ev.data)); } catch {}
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectStream, 3000);
  };
}

/* ---------------- 启动 ---------------- */

(async function init() {
  await pollStatus();
  await initLogs();
  connectStream();
  setInterval(pollStatus, 5000);
  loadConfig();
  loadGroups();
})();
