/* QQ 机器人控制台前端：原生 JS，无框架、无构建 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// 面板访问密钥从 URL 取一次，之后存 localStorage，避免刷新丢失
const params = new URLSearchParams(location.search);
const urlKey = params.get('key') || params.get('token');
if (urlKey) localStorage.setItem('qqbot_key', urlKey);
const ACCESS_KEY = localStorage.getItem('qqbot_key') || '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(ACCESS_KEY ? { 'X-Access-Key': ACCESS_KEY } : {}),
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

function activateTab(name) {
  const btn = $$('.tab').find((b) => b.dataset.tab === name);
  if (!btn) return;
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'plugins') loadPlugins();
  if (name === 'config') loadConfig();
  if (name === 'groups') loadGroups();
  if (name === 'roles') loadRoles();
}

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activateTab(btn.dataset.tab);
    // 记进地址栏，刷新后还停在这一页，也方便直接分享 /#config
    history.replaceState(null, '', `#${btn.dataset.tab}`);
  });
});

// 支持直接打开 /#config 这类地址
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (name) activateTab(name);
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
  $('#c-cred').textContent = s.credentialExpiresIn
    ? `${Math.floor(s.credentialExpiresIn / 60)} 分`
    : '-';
  $('#c-mem').textContent = `${s.memoryMB} MB`;
  $('#c-recv').textContent = s.counters.recv;
  $('#c-sent').textContent = s.counters.sent;
  $('#c-cmd').textContent = s.counters.commands;
  const blocked =
    (s.counters.dedup ?? 0) +
    (s.counters.limited ?? 0) +
    (s.counters.rejected ?? 0) +
    (s.counters.ignored ?? 0);
  $('#c-err').textContent = `${s.counters.errors} / ${blocked}`;

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
        <td class="mono" title="${escapeHtml(c.id)}">${escapeHtml(shortId(c.id))}</td>
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

$('#btnRefreshCred').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await api('/api/credential/refresh', { method: 'POST' }); alert('凭证已刷新'); }
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

function fillForm(c) {
  const f = $('#cfgForm');
  f.appId.value = c.appId || '';
  f.appSecret.value = '';
  f.appSecret.placeholder = c.appSecretSet ? '已设置，留空则不修改' : '请输入 AppSecret';
  f.baseUrl.value = c.baseUrl || '';
  f.commandPrefix.value = c.commandPrefix || '/';

  owners = [...(c.owners || [])];
  renderOwners();

  setIntents(c.intents);

  f.whitelistEnabled.checked = Boolean(c.whitelist?.enabled);
  f.whitelistGroups.value = (c.whitelist?.groups || []).join('\n');
  f.whitelistUsers.value = (c.whitelist?.users || []).join('\n');
  f.rateLimitEnabled.checked = c.rateLimit?.enabled !== false;
  f.perChatPerMinute.value = c.rateLimit?.perChatPerMinute ?? 30;
  f.dedupWindowSec.value = c.dedupWindowSec ?? 120;

  const ml = c.messageLog ?? {};
  f.messageLogEnabled.checked = ml.enabled !== false;
  const mute = ml.muteKinds ?? [];
  f.muteGroup.checked = mute.includes('group');
  f.muteC2c.checked = mute.includes('c2c');
  f.muteGuild.checked = mute.includes('guild');
  f.muteDm.checked = mute.includes('dm');

  f.webuiHost.value = c.webui?.host || '127.0.0.1';
  f.webuiPort.value = c.webui?.port ?? 8080;
  f.webuiAccessKey.value = c.webui?.accessKey || '';
  f.logLevel.value = c.logLevel || 'info';
}

/* ---------------- 事件订阅 intents ---------------- */

const INTENTS = [
  {
    bit: 25, group: 'chat', name: '群聊与私聊', needsApply: true,
    events: '群里 @机器人、私聊消息、机器人入群/退群、加好友/删好友',
    note: '需要在开放平台开通「群聊」能力，否则连接会被拒（关闭码 4014）',
  },
  {
    bit: 0, group: 'guild', name: '频道基础',
    events: '频道创建/更新/删除、子频道创建/更新/删除',
  },
  {
    bit: 30, group: 'guild', name: '频道 @消息',
    events: '频道里 @机器人 的消息、频道消息被撤回',
  },
  {
    bit: 1, group: 'guild', name: '频道成员',
    events: '成员加入频道、成员资料变更、成员离开',
  },
  {
    bit: 9, group: 'guild', name: '频道全量消息', needsApply: true,
    events: '频道内所有消息（不只 @机器人），仅私域机器人可申请',
  },
  {
    bit: 10, group: 'guild', name: '表情表态', needsApply: true,
    events: '为消息添加/删除表情表态',
  },
  {
    bit: 12, group: 'guild', name: '频道私信', needsApply: true,
    events: '用户私信机器人、私信被撤回',
  },
  {
    bit: 26, group: 'guild', name: '互动事件', needsApply: true,
    events: '按钮等互动组件的点击回调',
  },
  {
    bit: 27, group: 'guild', name: '消息审核', needsApply: true,
    events: '消息审核通过 / 不通过',
  },
  {
    bit: 28, group: 'guild', name: '论坛事件', needsApply: true,
    events: '论坛主题、帖子、评论的增删，仅私域机器人',
  },
  {
    bit: 29, group: 'guild', name: '音频动作', needsApply: true,
    events: '音频开始/结束、上麦/下麦',
  },
];

const KNOWN_MASK = INTENTS.reduce((m, it) => m | (1 << it.bit), 0);

function intentValueOf(bit) {
  return 1 << bit;
}

function renderIntents() {
  for (const group of ['chat', 'guild']) {
    const box = $(group === 'chat' ? '#intentGroupChat' : '#intentGroupGuild');
    box.innerHTML = INTENTS.filter((it) => it.group === group)
      .map(
        (it) => `
        <label class="intent-item" data-bit="${it.bit}">
          <input type="checkbox" data-bit="${it.bit}">
          <span class="intent-body">
            <span class="intent-name">
              ${it.name}
              ${it.needsApply ? '<span class="tag-need">需申请</span>' : '<span class="tag-free">默认可用</span>'}
            </span>
            <span class="intent-events">${it.events}</span>
            ${it.note ? `<span class="intent-note">${it.note}</span>` : ''}
          </span>
          <span class="intent-value">${intentValueOf(it.bit)}</span>
        </label>`,
      )
      .join('');
  }

  $$('#intentGroupChat input[type=checkbox], #intentGroupGuild input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if ($('#intentsAdvanced').checked) return; // 高级模式下不联动
      updateIntentsValue();
    });
  });
}

/** 从数值反推勾选状态 */
function setIntents(value) {
  const v = Number(value) || 0;
  const unknown = v & ~KNOWN_MASK;

  $$('#intentGroupChat input[type=checkbox], #intentGroupGuild input[type=checkbox]').forEach((cb) => {
    const bit = Number(cb.dataset.bit);
    cb.checked = Boolean(v & (1 << bit));
  });

  // 含未知位（比如官方新加的事件），自动切到高级模式，避免静默丢配置
  const adv = unknown !== 0;
  $('#intentsAdvanced').checked = adv;
  $('#intentsManual').style.display = adv ? '' : 'none';
  $('#intentsManual').value = v;
  $('#intentsValue').textContent = v;
  renderIntentSummary(v, adv);
}

/** 由勾选状态算出数值 */
function updateIntentsValue() {
  let v = 0;
  $$('#intentGroupChat input[type=checkbox], #intentGroupGuild input[type=checkbox]').forEach((cb) => {
    if (cb.checked) v += 1 << Number(cb.dataset.bit);
  });
  $('#cfgForm').intents.value = v;
  $('#intentsValue').textContent = v;
  renderIntentSummary(v, false);
}

function renderIntentSummary(v, advanced) {
  const desc = $('#intentsDesc');
  const warn = $('#intentsWarn');

  if (!v) {
    desc.textContent = '未订阅任何事件，机器人收不到任何消息';
    warn.textContent = '没有订阅事件时，连接会成功但永远不会有消息进来。';
    warn.style.display = '';
    return;
  }

  const picked = INTENTS.filter((it) => v & (1 << it.bit)).map((it) => it.name);
  const unknown = advanced ? v & ~KNOWN_MASK : 0;

  desc.textContent = picked.length ? picked.join(' + ') : '自定义组合';

  const needsApply = INTENTS.filter((it) => (v & (1 << it.bit)) && it.needsApply).map((it) => it.name);
  const msgs = [];
  if (needsApply.length) {
    msgs.push(`「${needsApply.join('、')}」需要先在开放平台申请权限，否则连接会被拒（关闭码 4014）。`);
  }
  if (unknown) {
    msgs.push(`另有未识别的位 ${unknown}，可能是官方新增事件，已按原样保留。`);
  }
  warn.textContent = msgs.join(' ');
  warn.style.display = msgs.length ? '' : 'none';
}

function bindIntentsUI() {
  renderIntents();

  $$('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = {
        chat: [25],
        guild: [0, 30, 1],
        all: INTENTS.map((it) => it.bit),
        none: [],
      };
      const bits = map[btn.dataset.preset] ?? [];
      $('#intentsAdvanced').checked = false;
      $('#intentsManual').style.display = 'none';
      $$('#intentGroupChat input[type=checkbox], #intentGroupGuild input[type=checkbox]').forEach((cb) => {
        cb.checked = bits.includes(Number(cb.dataset.bit));
      });
      updateIntentsValue();
    });
  });

  $('#intentsAdvanced').addEventListener('change', (e) => {
    const on = e.target.checked;
    $('#intentsManual').style.display = on ? '' : 'none';
    if (on) {
      // 进入高级模式时，用当前勾选结果作为起点
      let v = 0;
      $$('#intentGroupChat input[type=checkbox], #intentGroupGuild input[type=checkbox]').forEach((cb) => {
        if (cb.checked) v += 1 << Number(cb.dataset.bit);
      });
      $('#intentsManual').value = v;
      $('#intentsValue').textContent = v;
    } else {
      // 退出高级模式：按数值回填勾选
      setIntents(Number($('#intentsManual').value) || 0);
    }
  });

  $('#intentsManual').addEventListener('input', (e) => {
    const v = Number(e.target.value) || 0;
    $('#intentsValue').textContent = v;
    renderIntentSummary(v, true);
  });
}

async function loadConfig() {
  try {
    fillForm(await api('/api/config'));
  } catch (e) {
    $('#cfgMsg').textContent = '读取配置失败: ' + e.message;
  }
}

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
    messageLog: {
      enabled: f.messageLogEnabled.checked,
      muteKinds: [
        f.muteGroup.checked ? 'group' : null,
        f.muteC2c.checked ? 'c2c' : null,
        f.muteGuild.checked ? 'guild' : null,
        f.muteDm.checked ? 'dm' : null,
      ].filter(Boolean),
    },
    webui: {
      host: f.webuiHost.value.trim() || '127.0.0.1',
      port: Number(f.webuiPort.value) || 8080,
      accessKey: f.webuiAccessKey.value.trim(),
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
      <div class="plugin" data-id="${escapeHtml(p.id)}">
        <div class="info">
          <div class="name">${escapeHtml(p.name || p.id)} <span class="hint">v${escapeHtml(p.version || '0.0.0')}</span></div>
          <div class="meta">${escapeHtml(p.id)}${p.description ? ' · ' + escapeHtml(p.description) : ''}</div>
          ${p.error ? `<div class="err">加载失败: ${escapeHtml(p.error)}</div>` : ''}
          ${p.menuMissing ? '<div class="err">未提供指令菜单，用户看不到它能做什么</div>' : ''}
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
    body.innerHTML = '<tr><td colspan="7" class="empty">还没有群。把机器人拉进群后这里会自动出现。</td></tr>';
    return;
  }
  body.innerHTML = list
    .map((g) => `
      <tr data-id="${escapeHtml(g.groupOpenid)}">
        <td class="mono" title="${escapeHtml(g.groupOpenid)}">${escapeHtml(shortId(g.groupOpenid))}</td>
        <td class="mono" title="${escapeHtml(g.inviterOpenid || '')}">${g.inviterOpenid ? escapeHtml(shortId(g.inviterOpenid)) : '-'}</td>
        <td class="mono" title="${escapeHtml(g.ownerOpenid || '')}">${g.ownerOpenid ? escapeHtml(shortId(g.ownerOpenid)) : '-'}</td>
        <td><span class="badge ${g.enabled ? 'on' : 'off'}">${g.enabled ? '在用' : '已移出'}</span></td>
        <td>${g.lastActiveAt ? fmtAgo(g.lastActiveAt) : '-'}</td>
        <td class="num">
          <button class="btn small danger" data-act="del">删除</button>
        </td>
      </tr>`)
    .join('');

  body.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (!confirm('确定删除这个群的档案？机器人不会退群，只是忘掉这条记录（权限不受影响）。')) {
        return;
      }
      btn.disabled = true;
      try {
        await api(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

/* ---------------- 权限 ---------------- */

const LEVEL_TEXT = { 0: '主人', 1: '管理员', 2: '群管', 3: '助手' };
const levelText = (n) => LEVEL_TEXT[n] ?? (n >= 9999 ? '普通成员' : `${n} 级管理`);

async function loadRoles() {
  const body = $('#roleBody');
  if (!body) return;
  try {
    const data = await api('/api/roles');
    const rows = data.rows ?? [];

    // 作用域候选：global + 已知群
    const scopes = new Set(['global']);
    for (const r of rows) scopes.add(r.scope);
    try {
      for (const g of await api('/api/groups')) scopes.add(`group:${g.groupOpenid}`);
    } catch {}
    $('#scopeList').innerHTML = [...scopes].map((x) => `<option value="${x}">`).join('');

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="empty">还没有配置权限</td></tr>';
      return;
    }
    body.innerHTML = rows
      .map(
        (r) => `
        <tr>
          <td class="mono">${escapeHtml(r.scope)}</td>
          <td class="mono" title="${escapeHtml(r.openid)}">${escapeHtml(shortId(r.openid))}</td>
          <td>${levelText(r.level)} <span class="hint">${r.level}</span></td>
          <td class="num"><button class="btn small danger" data-scope="${escapeHtml(r.scope)}" data-openid="${escapeHtml(r.openid)}">移除</button></td>
        </tr>`,
      )
      .join('');

    body.querySelectorAll('button[data-scope]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/roles/remove', {
            method: 'POST',
            body: JSON.stringify({ scope: btn.dataset.scope, openid: btn.dataset.openid }),
          });
          await loadRoles();
        } catch (e) {
          alert('移除失败: ' + e.message);
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="empty">加载失败: ${e.message}</td></tr>`;
  }
}

$('#btnReloadRoles')?.addEventListener('click', loadRoles);

$('#btnAddRole')?.addEventListener('click', async () => {
  const scope = $('#roleScope').value.trim();
  const openid = $('#roleOpenid').value.trim();
  const level = Number($('#roleLevel').value);
  if (!scope || !openid) return alert('作用域和 openid 都要填');
  try {
    await api('/api/roles/set', {
      method: 'POST',
      body: JSON.stringify({ scope, openid, level }),
    });
    $('#roleOpenid').value = '';
    await loadRoles();
  } catch (e) {
    alert('保存失败: ' + e.message);
  }
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
  const qs = ACCESS_KEY ? `?key=${encodeURIComponent(ACCESS_KEY)}` : '';
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
  bindIntentsUI();
  loadConfig();
  loadGroups();
  const initial = location.hash.slice(1);
  if (initial) activateTab(initial);
})();
