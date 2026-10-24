/* QQ 机器人控制台前端：原生 JS，无框架、无构建 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// 面板访问密钥从 URL 取一次，之后存 localStorage，避免刷新丢失
const params = new URLSearchParams(location.search);
const urlKey = params.get('key') || params.get('token');
if (urlKey) localStorage.setItem('qqbot_key', urlKey);
const ACCESS_KEY = localStorage.getItem('qqbot_key') || '';

// 当前正在看的机器人。所有 /api 请求都会带上 ?bot=<id>
let CURRENT_BOT = localStorage.getItem('qqbot_bot') || '';

// 上下线请求进行中：按钮置灰，避免连点重复连网关
let CONN_BUSY = false;

async function api(path, opts = {}) {
  let url = path;
  if (CURRENT_BOT && !/[?&]bot=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'bot=' + encodeURIComponent(CURRENT_BOT);
  }
  const res = await fetch(url, {
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

/* ---------------- 通用确认弹窗 ---------------- */

/**
 * 弹一个确认框，返回 Promise<boolean>。
 * 支持 Esc 取消、Enter 确认、点遮罩取消。
 * message 用 innerHTML 渲染，调用方只传自己写死的文案，不要塞用户输入。
 */
function confirmDialog({ title = '确认', message = '', okText = '确定', danger = false } = {}) {
  const mask = $('#modalMask');
  const btnOk = $('#modalOk');
  const btnCancel = $('#modalCancel');

  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = message;
  btnOk.textContent = okText;
  btnOk.classList.toggle('danger', danger);
  btnOk.hidden = false;
  btnCancel.hidden = false;
  mask.hidden = false;
  btnCancel.focus();

  return new Promise((resolve) => {
    const cleanup = () => {
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      document.removeEventListener('keydown', onKey);
    };
    const done = (v) => {
      cleanup();
      mask.hidden = true;
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onMask = (e) => {
      if (e.target === mask) done(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') done(false);
      else if (e.key === 'Enter') done(true);
    };

    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    document.addEventListener('keydown', onKey);
  });
}

/* ---------------- 机器人切换器 ---------------- */

let BOTS = [];

function botById(id) {
  return BOTS.find((b) => b.id === id) ?? null;
}

function updateBotTrigger() {
  const cur = botById(CURRENT_BOT) ?? BOTS[0] ?? null;
  $('#botNameLabel').textContent = cur ? cur.name : '无机器人';
  const dot = $('#botDot');
  dot.className = 'bot-dot' + (cur?.online ? ' on' : cur ? ' off' : '');
  dot.title = cur?.online ? '在线' : '离线';
}

function renderBotMenu(keyword = '') {
  const kw = keyword.trim().toLowerCase();
  const items = BOTS.filter(
    (b) => !kw || b.id.toLowerCase().includes(kw) || b.name.toLowerCase().includes(kw),
  );

  $('#botList').innerHTML = items
    .map((b) => {
      const active = b.id === (CURRENT_BOT || BOTS[0]?.id);
      const stateText = b.online ? '在线' : b.state === 'error' ? '连接失败' : '离线';
      return `
        <div class="bot-item${active ? ' active' : ''}" data-id="${b.id}" role="option">
          <span class="bot-dot ${b.online ? 'on' : 'off'}"></span>
          <span class="bot-item-main">
            <b>${escapeHtml(b.name)}</b>
            <i>${b.id} · ${stateText} · ${b.plugins} 个插件</i>
          </span>
          <button class="bot-del" data-del="${b.id}" title="删除">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>
            </svg>
          </button>
        </div>`;
    })
    .join('');

  $('#botEmpty').hidden = items.length > 0;
  // 项目多时才显示搜索框，少的时候别占地方
  $('#botSearch').hidden = BOTS.length <= 3;

  $$('.bot-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.bot-del')) return;
      selectBot(el.dataset.id);
    });
  });
  $$('.bot-del').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteBot(el.dataset.del);
    });
  });
}

/**
 * 把单个机器人的最新状态同步到列表和「已打开」的下拉菜单。
 *
 * 不整体重渲染菜单——那会让搜索框丢焦点、正在点的人被闪一下。
 * 只改状态点和那一行文字。菜单没开就只更新数据，下次打开自然是新的。
 */
function syncBotListState(botId, { online, state }) {
  if (!botId) return;
  const b = BOTS.find((x) => x.id === botId);
  if (b) {
    b.online = online;
    b.state = state;
  }

  const menu = $('#botMenu');
  if (!menu || menu.hidden) return;
  const el = menu.querySelector(`.bot-item[data-id="${CSS.escape(botId)}"]`);
  if (!el) return;

  const dot = el.querySelector('.bot-dot');
  if (dot) dot.className = `bot-dot ${online ? 'on' : 'off'}`;

  const sub = el.querySelector('i');
  if (sub && b) {
    const stateText = online ? '在线' : state === 'error' ? '连接失败' : '离线';
    sub.textContent = `${b.id} · ${stateText} · ${b.plugins} 个插件`;
  }
}

async function loadBots() {
  try {
    const d = await api('/api/bots');
    BOTS = d.bots ?? [];
    if (!CURRENT_BOT || !botById(CURRENT_BOT)) {
      CURRENT_BOT = d.current ?? BOTS[0]?.id ?? '';
      if (CURRENT_BOT) localStorage.setItem('qqbot_bot', CURRENT_BOT);
    }
    updateBotTrigger();
    renderBotMenu($('#botSearch')?.value ?? '');
  } catch (e) {
    $('#botNameLabel').textContent = '加载失败';
  }
}

/**
 * 打开机器人下拉。
 *
 * **每次打开都重新拉一次状态**：BOTS 是初始化时拉的快照，
 * 那时候机器人可能还没上线（启动要 1~2 秒）。不重拉的话，
 * 用户会看到「离线」，得手动点刷新才对——这就是之前那个 bug。
 *
 * 先用现有数据立刻渲染（菜单要马上出来，不能等网络），
 * 拉到新数据后 loadBots 内部会再渲染一次。
 */
async function openBotMenu() {
  $('#botMenu').hidden = false;
  $('#botTrigger').setAttribute('aria-expanded', 'true');
  renderBotMenu($('#botSearch')?.value ?? '');
  await loadBots();
  if (!$('#botSearch').hidden) $('#botSearch').focus();
}

function closeBotMenu() {
  $('#botMenu').hidden = true;
  $('#botTrigger').setAttribute('aria-expanded', 'false');
}

async function selectBot(id) {
  if (!id) return;
  CURRENT_BOT = id;
  localStorage.setItem('qqbot_bot', id);
  closeBotMenu();
  updateBotTrigger();
  // 所有页签的数据都跟机器人走，重拉一遍
  await pollStatus();
  // 插件注册的页面也跟着机器人走：不同机器人启用的插件不一样
  await loadPluginPages();
  const tab = location.hash.slice(1) || 'overview';
  if (tab === 'config') loadConfig();
  if (tab === 'plugins') loadPlugins();
  if (tab === 'events') loadEvents();
  if (tab === 'groups') loadGroups();
  if (tab === 'roles') loadRoles();
  if (tab === 'stats') loadStats();
  // 停在插件页面上切机器人：这一页在新机器人下可能不存在，退回到概览
  if (tab.startsWith('page:')) {
    activateTab($$('.tab').some((b) => b.dataset.tab === tab) ? tab : 'overview');
  }
  await loadBots();
}

async function deleteBot(id) {
  const b = botById(id);
  if (!b) return;
  closeBotMenu();
  const ok = await confirmDialog({
    title: `删除机器人「${b.name}」`,
    message:
      `将删除 <b>${id}</b> 的配置、权限、群档案、插件存档和日志。\n\n` +
      '<b>这个操作不可撤销。</b>插件代码不会被删，只删这个机器人的数据。',
    okText: '确认删除',
    danger: true,
  });
  if (!ok) return;

  try {
    await api('/api/bots/delete', { method: 'POST', body: JSON.stringify({ id, purge: true }) });
  } catch (e) {
    await confirmDialog({ title: '删除失败', message: e.message, okText: '知道了' });
    return;
  }
  if (CURRENT_BOT === id) {
    CURRENT_BOT = '';
    localStorage.removeItem('qqbot_bot');
  }
  await loadBots();
  if (CURRENT_BOT) await selectBot(CURRENT_BOT);
}

/* ---------------- 新建机器人 ---------------- */

function openNewBot() {
  closeBotMenu();
  $('#nbId').value = '';
  $('#nbName').value = '';
  $('#nbAppId').value = '';
  $('#nbSecret').value = '';
  $('#nbErr').hidden = true;
  $('#newBotMask').hidden = false;
  $('#nbId').focus();
}

function closeNewBot() {
  $('#newBotMask').hidden = true;
}

async function submitNewBot() {
  const id = $('#nbId').value.trim();
  const err = $('#nbErr');
  err.hidden = true;

  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
    err.textContent = 'ID 只能用小写字母、数字、下划线、短横线，且不能以符号开头';
    err.hidden = false;
    return;
  }

  const btn = $('#nbOk');
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    await api('/api/bots', {
      method: 'POST',
      body: JSON.stringify({
        id,
        name: $('#nbName').value.trim() || id,
        appId: $('#nbAppId').value.trim(),
        appSecret: $('#nbSecret').value.trim(),
      }),
    });
    closeNewBot();
    await loadBots();
    await selectBot(id);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '创建并连接';
  }
}

$('#botTrigger')?.addEventListener('click', () => {
  if ($('#botMenu').hidden) openBotMenu();
  else closeBotMenu();
});
$('#botSearch')?.addEventListener('input', (e) => renderBotMenu(e.target.value));
$('#botAddBtn')?.addEventListener('click', openNewBot);
$('#nbCancel')?.addEventListener('click', closeNewBot);
$('#nbOk')?.addEventListener('click', submitNewBot);
$('#newBotMask')?.addEventListener('click', (e) => {
  if (e.target === $('#newBotMask')) closeNewBot();
});
document.addEventListener('click', (e) => {
  if (!$('#botSwitch')?.contains(e.target)) closeBotMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#botMenu').hidden) closeBotMenu();
});

/* ---------------- 主题 ---------------- */

const THEME_KEY = 'qqbot_theme';

function updateThemeBtn(t) {
  const btn = $('#btnTheme');
  if (btn) btn.title = t === 'dark' ? '切换到日间模式' : '切换到夜间模式';
}

function setTheme(t, { persist = true } = {}) {
  document.documentElement.dataset.theme = t;
  if (persist) {
    try { localStorage.setItem(THEME_KEY, t); } catch {}
  }
  updateThemeBtn(t);
}

function initTheme() {
  const btn = $('#btnTheme');
  const saved = (() => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } })();
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // 没手动选过就跟随系统，且不写入 localStorage，保持「跟随系统」状态
  setTheme(saved || (sysDark ? 'dark' : 'light'), { persist: Boolean(saved) });

  btn?.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    setTheme(cur);
  });

  // 用户没手动选过时，系统主题变了跟着变
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', (e) => {
    let hasSaved = null;
    try { hasSaved = localStorage.getItem(THEME_KEY); } catch {}
    if (!hasSaved) setTheme(e.matches ? 'dark' : 'light', { persist: false });
  });
}

/* ---------------- 工具 ---------------- */

/**
 * 时长格式化。
 * 用「时:分:秒」而不是「21分 33秒」——指标卡片很窄，
 * 中文单位加空格会折行，冒号版紧凑且一眼能读。
 */
function fmtDuration(ms) {
  if (!ms || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');

  if (d) return `${d}天 ${p2(h)}:${p2(m)}`;
  if (h) return `${h}:${p2(m)}:${p2(sec)}`;
  if (m) return `${m}:${p2(sec)}`;
  return `${sec}s`;
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
  // 插件指标只在插件页轮询，切走就停——别在后台白耗请求
  if (name === 'plugins') {
    loadPlugins();
    startPluginDashPolling();
  } else {
    stopPluginDashPolling();
  }
  if (name === 'events') loadEvents();
  // 统计页：进来先拉一次，之后 10 秒一轮（统计本身是 1 秒批量落盘的，不用更密）
  if (name === 'stats') {
    loadStats();
    startStatsPolling();
  } else {
    stopStatsPolling();
  }
  // 插件自定义页面：第一次点开才真正去拉 html，不点不请求；切机器人后地址会变，重新加载
  if (name.startsWith('page:')) {
    const frame = $(`#tab-${CSS.escape(name)} .plugin-page`);
    if (frame?.dataset.key) {
      const url = pluginPageUrl(frame.dataset.key);
      if (frame.getAttribute('src') !== url) frame.src = url;
    }
  }
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
  // 以机器人实例状态为准：mock 模式下没有网关连接，但机器人是「在线」的
  const state = s.state || (s.connected ? 'online' : 'offline');
  const online = state === 'online';
  const starting = state === 'starting';

  // 把最新状态同步回机器人列表，下拉菜单里才不会显示旧状态
  syncBotListState(s.botId, { online, state });

  pill.classList.toggle('online', online);
  pill.classList.toggle('offline', !online && !starting);
  pill.classList.toggle('busy', starting);
  pill.disabled = starting || CONN_BUSY;

  $('#connText').textContent = starting
    ? '连接中'
    : online
      ? '在线'
      : state === 'error'
        ? '连接失败'
        : '离线';
  $('#connAction').textContent = CONN_BUSY ? (online ? '下线中…' : '上线中…') : online ? '下线' : '上线';
  pill.title = online ? '点击下线（只断开连接，插件与存档保留）' : '点击上线';
  $('#connDot').style.background = '';
  $('#botName').textContent = online ? s.botName || '已连接' : '未连接';

  $('#c-conn').textContent = online ? '在线' : state === 'error' ? '连接失败' : '离线';
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
  // 框架版本：status 里直接带，不用等用户点「检查更新」
  if (s.version) $('#updCurrent').textContent = s.version;

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

/* 上下线按钮：只断/连网关，不卸载插件、不清存档 */
$('#connPill').addEventListener('click', async () => {
  if (CONN_BUSY) return;
  const botId = CURRENT_BOT || BOTS[0]?.id;
  if (!botId) return;

  const online = $('#connPill').classList.contains('online');
  const action = online ? 'offline' : 'online';

  CONN_BUSY = true;
  $('#connAction').textContent = online ? '下线中…' : '上线中…';
  $('#connPill').disabled = true;

  try {
    const r = await api(`/api/bots/${encodeURIComponent(botId)}/${action}`, {
      method: 'POST',
      body: '{}',
    });
    if (r?.state === 'error') throw new Error(r.error || '连接失败');
  } catch (e) {
    alert(`${online ? '下线' : '上线'}失败：${e.message}`);
  } finally {
    CONN_BUSY = false;
    $('#connPill').disabled = false;
    await pollStatus();
    await loadBots();
  }
});

$('#btnReconnect').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try { await api('/api/gateway/reconnect', { method: 'POST' }); }
  catch (err) { alert('重连失败: ' + err.message); }
  finally { setTimeout(() => { e.target.disabled = false; pollStatus(); }, 1200); }
});

/* ---------------- 后台服务 ---------------- */

async function loadServices() {
  const wrap = $('#serviceList');
  if (!wrap) return;
  try {
    const d = await api('/api/services');
    const list = d.services || [];
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">没有启用任何后台服务</div>';
      return;
    }
    wrap.innerHTML = list
      .map(
        (s) => `
      <div class="service-item">
        <span class="service-dot ${s.state === 'running' ? 'ok' : s.state === 'error' ? 'bad' : ''}"></span>
        <span class="service-name">${escapeHtml(s.label || s.name)}</span>
        <span class="service-detail">${escapeHtml(s.detail || '')}</span>
      </div>`,
      )
      .join('');
  } catch (e) {
    wrap.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

/* ---------------- 框架版本与更新 ---------------- */

let pendingUpdate = null;

async function checkFrameworkUpdate() {
  const btn = $('#btnCheckUpdate');
  const msg = $('#updMsg');
  btn.disabled = true;
  msg.textContent = '正在检查…';
  try {
    const d = await api('/api/update/check');
    $('#updCurrent').textContent = d.current || '-';
    if (!d.ok) {
      msg.textContent = '检查失败：' + (d.error || '未知错误');
      return;
    }
    if (!d.hasUpdate) {
      msg.textContent = `已是最新版本 v${d.current}`;
      $('#btnApplyUpdate').hidden = true;
      pendingUpdate = null;
      return;
    }
    pendingUpdate = d;
    msg.innerHTML =
      `发现新版本 <b>v${escapeHtml(d.latest)}</b>` +
      (d.publishedAt ? `（${escapeHtml(d.publishedAt.slice(0, 10))}）` : '') +
      '<br>更新只替换代码目录，配置 / 存档 / 日志 / 插件都不会动。';
    $('#btnApplyUpdate').hidden = false;
  } catch (e) {
    msg.textContent = '检查失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

$('#btnCheckUpdate').addEventListener('click', checkFrameworkUpdate);

$('#btnApplyUpdate').addEventListener('click', async (e) => {
  if (!pendingUpdate) return;
  const ok = await confirmDialog({
    title: `更新到 v${pendingUpdate.latest}`,
    message:
      `当前版本 <b>v${pendingUpdate.current}</b>，将更新到 <b>v${pendingUpdate.latest}</b>。<br><br>` +
      '只替换 <code>src/ web/ test/ docs/</code> 等代码目录，' +
      '<b>配置、存档、日志、插件都不会动</b>，更新前还会自动备份到 <code>data/backups/</code>。<br><br>' +
      '更新完成后需要<b>手动重启程序</b>才会生效。',
    okText: '确认更新',
  });
  if (!ok) return;

  e.target.disabled = true;
  const msg = $('#updMsg');
  msg.textContent = '正在下载并替换…（可能需要几十秒）';
  try {
    const r = await api('/api/update/apply', { method: 'POST', body: '{}' });
    msg.innerHTML =
      `<b>已更新 v${escapeHtml(r.from)} → v${escapeHtml(r.to)}</b>，` +
      `备份在 <code>${escapeHtml(r.backup || '')}</code>。<br>` +
      '<b>请关闭程序后重新启动，新版本才会生效。</b>';
    $('#btnApplyUpdate').hidden = true;
  } catch (err) {
    msg.textContent = '更新失败：' + err.message + '（代码已自动还原）';
    e.target.disabled = false;
  }
});

/* ---------------- 关闭程序 ---------------- */

$('#btnShutdown')?.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '关闭机器人程序',
    message:
      '确定要关闭吗？\n\n' +
      '机器人会从 QQ 下线，正在进行的对话会中断。\n' +
      '存档、权限、主动消息额度都会保存，不会丢数据。\n\n' +
      '<b>需要重新运行 node src/main.js 才能恢复。</b>',
    okText: '关闭程序',
    danger: true,
  });
  if (!ok) return;

  const btn = $('#btnShutdown');
  btn.disabled = true;
  btn.style.opacity = '.5';

  try {
    await api('/api/shutdown', { method: 'POST', body: '{}' });
  } catch {
    // 进程退出时连接会断，请求报错属于正常现象，不用提示
  }

  // 盖一个「已关闭」的提示，免得用户对着不动的界面猜
  $('#modalTitle').textContent = '程序已关闭';
  $('#modalBody').innerHTML =
    '机器人已经停止，这个页面可以关掉了。\n\n' +
    '要重新启动，在 <b>bot</b> 目录再运行一次 <b>node src/main.js</b>，' +
    '或用 <b>start.bat</b>。';
  $('#modalOk').hidden = true;
  $('#modalCancel').hidden = true;
  $('#modalMask').hidden = false;
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
  f.connectionMode.value = c.connection?.mode || 'websocket';

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
  f.webuiPort.value = c.webui?.port ?? 15207;
  f.webuiAccessKey.value = c.webui?.accessKey || '';
  f.logLevel.value = c.logLevel || 'info';

  f.groupInvited.checked = Boolean(c.groupManage?.invited);
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
  // 勾选即生效：不用再点保存
  autoSaveIntents();
}

/**
 * 订阅事件自动保存。
 *
 * 防抖 900ms——连着勾 5 个只提交一次。
 * 每次提交都会让后端**重连网关**（intents 是连接参数），
 * 不做防抖的话勾几个就重连几次，机器人会反复掉线。
 */
let intentsSaveTimer = null;
function autoSaveIntents() {
  const tip = $('#cfgMsgTop');
  if (intentsSaveTimer) clearTimeout(intentsSaveTimer);
  if (tip) tip.textContent = '事件订阅待应用…';

  intentsSaveTimer = setTimeout(async () => {
    intentsSaveTimer = null;
    const v = Number($('#cfgForm').intents.value) || 0;
    if (tip) tip.textContent = '正在应用（会重连）…';
    try {
      await api('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ intents: v }),
      });
      if (tip) {
        tip.textContent = `已生效（intents=${v}），网关正在重连`;
        setTimeout(() => {
          if (tip.textContent.startsWith('已生效')) tip.textContent = '';
        }, 4000);
      }
    } catch (e) {
      if (tip) tip.textContent = '应用失败: ' + e.message;
    }
  }, 900);
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
    // 高级模式手填数值同样立即生效
    $('#cfgForm').intents.value = v;
    autoSaveIntents();
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
    connection: { mode: f.connectionMode.value === 'webhook' ? 'webhook' : 'websocket' },
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
      port: Number(f.webuiPort.value) || 15207,
      accessKey: f.webuiAccessKey.value.trim(),
    },
    groupManage: {
      invited: f.groupInvited.checked,
    },
  };

  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#cfgMsg').textContent = '保存中…';
  try {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
    // 后端在填完 AppID / AppSecret 后会把占位名换成官方昵称，这里同步显示
    const renamed = r?.name && r.name !== botById(CURRENT_BOT)?.name;
    $('#cfgMsg').textContent =
      (renamed ? `已保存，机器人昵称同步为「${r.name}」` : '已保存') +
      (payload.appId ? '' : '（AppID 为空）');
    f.appSecret.value = '';
    setTimeout(() => ($('#cfgMsg').textContent = ''), 4000);
    await loadBots();
    pollStatus();
  } catch (err) {
    $('#cfgMsg').textContent = '保存失败: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- 插件注册的面板页面 ---------------- */

/**
 * 把插件注册的页面挂到标签栏上。
 *
 * 每次插件列表刷新都重跑一遍：插件装了/卸了/重载了，页面也跟着变。
 * 已存在的标签不重建，避免正在看的页面被刷掉。
 */
async function loadPluginPages() {
  let list = [];
  try {
    list = await api('/api/pages');
  } catch {
    return; // 拿不到就不显示，不影响其它页
  }

  const nav = $('.tabs');
  const main = $('main');
  if (!nav || !main) return;

  const wanted = new Set(list.map((p) => `page:${p.key}`));

  // 去掉已经不存在的
  $$('.tab[data-plugin-page]').forEach((b) => {
    if (!wanted.has(b.dataset.tab)) b.remove();
  });
  $$('.panel[data-plugin-page]').forEach((p) => {
    if (!wanted.has(p.dataset.tab)) p.remove();
  });

  for (const p of list) {
    const tabName = `page:${p.key}`;
    if ($$('.tab').some((b) => b.dataset.tab === tabName)) continue;

    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.tab = tabName;
    btn.dataset.pluginPage = p.key;
    btn.textContent = p.label;
    btn.title = `来自插件 ${p.pluginId}`;
    nav.appendChild(btn);

    const sec = document.createElement('section');
    sec.className = 'panel';
    sec.id = `tab-${tabName}`;
    sec.dataset.pluginPage = p.key;
    sec.dataset.tab = tabName;

    const frame = document.createElement('iframe');
    frame.className = 'plugin-page';
    frame.title = p.label;
    /**
     * allow-same-origin 是为了让页面能调 /api/ 拿数据；
     * allow-scripts 让它能跑自己的脚本。插件本来就是可信代码
     * （内建插件跑在主进程），这里隔离的是**样式**，不是权限。
     */
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    /**
     * 地址在「点开的时候」才算，不在这里定死：
     * 页面数据是跟着当前机器人的，切了机器人必须重新拼地址才能拿到对的 bot。
     */
    frame.dataset.key = p.key;
    sec.appendChild(frame);
    main.appendChild(sec);
  }
}

/** 插件页面 iframe 的地址：带上密钥和当前机器人 */
function pluginPageUrl(key) {
  const q = new URLSearchParams();
  if (ACCESS_KEY) q.set('key', ACCESS_KEY);
  if (CURRENT_BOT) q.set('bot', CURRENT_BOT);
  const s = q.toString();
  return `/api/pages/${encodeURIComponent(key)}/html${s ? `?${s}` : ''}`;
}

/* ---------------- 统计 ---------------- */

/** 每天一根柱子，纯 CSS 不用图表库——多引一个库就破了零依赖 */
function renderStatsChart(series) {
  if (!series?.length) return '<div class="empty">还没有数据</div>';
  const max = Math.max(1, ...series.map((s) => s.messages));
  return (
    '<div class="bars">' +
    series
      .map((s) => {
        const h = Math.max(2, Math.round((s.messages / max) * 100));
        const zero = s.messages === 0 ? ' zero' : '';
        return `<div class="bar-wrap" title="${escapeHtml(s.day)}：${s.messages} 条 / ${s.commands} 个命令">
          <div class="bar${zero}" style="height:${h}%"></div>
          <span class="bar-day">${escapeHtml(s.day.slice(5))}</span>
        </div>`;
      })
      .join('') +
    '</div>'
  );
}

/** 排行条：名字 + 占比条 + 数值 */
function renderStatList(items, label, value, unit = '') {
  if (!items?.length) return '<div class="empty">暂无数据</div>';
  const max = Math.max(1, ...items.map(value));
  return items
    .map(
      (it) => `<div class="stat-row">
        <span class="stat-name" title="${escapeHtml(label(it))}">${escapeHtml(label(it))}</span>
        <span class="stat-track"><i style="width:${Math.round((value(it) / max) * 100)}%"></i></span>
        <span class="stat-val">${value(it)}${unit}</span>
      </div>`,
    )
    .join('');
}

let statsTimer = null;

/** 统计页只在打开时轮询，切走就停——和插件指标一个思路，不在后台白耗请求 */
function startStatsPolling() {
  stopStatsPolling();
  statsTimer = setInterval(loadStats, 10000);
}

function stopStatsPolling() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = null;
}

async function loadStats() {
  const days = Number($('#statsDays')?.value) || 7;
  const tip = $('#statsUnavailable');
  const cards = $('#statsCards');
  const chart = $('#statsChart');
  const foot = $('#statsFoot');

  let d;
  try {
    d = await api(`/api/stats?days=${days}`);
  } catch (e) {
    if (tip) {
      tip.hidden = false;
      tip.textContent = `统计读取失败：${e.message}`;
    }
    return;
  }

  if (!d?.available) {
    if (tip) {
      tip.hidden = false;
      tip.textContent =
        '统计不可用：当前 Node 不支持内置 SQLite（需要 22.5 以上）。其它功能不受影响。';
    }
    if (cards) cards.innerHTML = '';
    if (chart) chart.innerHTML = '';
    if (foot) foot.textContent = '';
    return;
  }

  if (tip) tip.hidden = true;

  if (cards) {
    cards.innerHTML = [
      ['今日消息', d.today.messages],
      ['今日活跃', d.today.users],
      ['今日命令', d.today.commands],
      ['累计消息', d.total],
      ['成员档案', d.members.total],
      ['7 日活跃成员', d.members.active],
    ]
      .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`)
      .join('');
  }

  if (chart) chart.innerHTML = renderStatsChart(d.series);
  if (foot) {
    // 措辞要和表结构对得上：确实存了会话/成员 id，别写成「只有数量」
    foot.textContent = `明细保留 ${d.retentionDays} 天；只记录数量、时间与会话/成员 id，不存消息正文。`;
  }

  const cmds = $('#statsTopCommands');
  if (cmds) cmds.innerHTML = renderStatList(d.topCommands, (x) => '/' + x.name, (x) => x.count, ' 次');

  const chats = $('#statsTopChats');
  if (chats) {
    /**
     * scope 存的是 msg.kind，取值只有 group / c2c / guild / dm
     * （见 src/events.js 的 message 字段）。别写成 'channel'——那个值不存在。
     */
    const scopeName = (s) => (s === 'group' ? '群' : s === 'guild' ? '频道' : '私聊');
    chats.innerHTML = renderStatList(
      d.topChats,
      (x) => `${scopeName(x.scope)} ${x.chatId.slice(0, 10)}…`,
      (x) => x.messages,
      ' 条',
    );
  }
}

/* ---------------- 插件 ---------------- */

/** 把插件上报的指标渲染成小 chip，最多 3 个 */
function renderDashChips(metrics) {
  return (metrics ?? [])
    .slice(0, 3)
    .map(
      (m) =>
        `<span class="dash-chip">${escapeHtml(m.label)} <b>${escapeHtml(String(m.value))}${
          m.unit ? escapeHtml(m.unit) : ''
        }</b></span>`,
    )
    .join('');
}

let pluginDashTimer = null;

/**
 * 只刷新指标，**不重建卡片**。
 *
 * 整块重绘会让滚动位置丢失、正在点的按钮消失，用户会以为界面在抽风。
 * 所以这里只改 .plugin-metrics 的 innerHTML。
 */
async function refreshPluginDashboards() {
  const wrap = $('#pluginList');
  if (!wrap || !wrap.querySelector('.plugin')) return;

  let dash;
  try {
    dash = await api('/api/plugins/dashboard');
  } catch {
    return; // 网络抖一下不打断轮询，下一轮继续
  }

  for (const [id, d] of Object.entries(dash || {})) {
    const card = wrap.querySelector(`.plugin[data-id="${CSS.escape(id)}"]`);
    if (!card) continue;

    const html = renderDashChips(d?.metrics);
    let box = card.querySelector('.plugin-metrics');

    if (box) {
      box.innerHTML = html;
      if (!html) box.remove(); // 指标清空了，容器也别留着占位
    } else if (html) {
      // 首次没指标、后来才有了：补一个容器
      const info = card.querySelector('.info');
      if (info) {
        box = document.createElement('div');
        box.className = 'plugin-metrics';
        box.innerHTML = html;
        info.appendChild(box);
      }
    }
  }
}

function startPluginDashPolling() {
  stopPluginDashPolling();
  pluginDashTimer = setInterval(refreshPluginDashboards, 5000);
}

function stopPluginDashPolling() {
  if (pluginDashTimer) clearInterval(pluginDashTimer);
  pluginDashTimer = null;
}

async function loadPlugins() {
  const wrap = $('#pluginList');
  // 插件装了/卸了，它注册的面板页面也会变，顺带刷一下标签栏
  loadPluginPages();
  try {
    // 运行数据单独一个接口，拿不到不影响列表显示
    const [list, dash, upd] = await Promise.all([
      api('/api/plugins'),
      api('/api/plugins/dashboard').catch(() => ({})),
      api('/api/plugins/updates').catch(() => ({ updates: [] })),
    ]);
    const updMap = {};
    for (const u of upd.updates || []) updMap[u.id] = u;

    if (!list.length) {
      wrap.innerHTML = '<div class="empty">还没有插件，把文件夹放进 plugins/ 即可</div>';
      return;
    }
    wrap.innerHTML = list.map((p) => {
      // 插件自己上报的指标，卡片上最多露 3 个，详情在「设置 → 运行数据」
      const d = dash[p.id];
      const chips = renderDashChips(d?.metrics);

      const u = updMap[p.id];

      return `
      <div class="plugin" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name || p.id)}">
        <div class="info">
          <div class="name">${
            p.icon
              ? `<img class="plugin-icon" src="${escapeHtml(p.icon)}" alt="" loading="lazy">`
              : ''
          }${escapeHtml(p.name || p.id)} <span class="hint">v${escapeHtml(p.version || '0.0.0')}</span>
            ${u ? `<span class="upd-tag">可更新 ${escapeHtml(u.latest)}</span>` : ''}
          </div>
          <div class="meta">
            ${escapeHtml(p.id)}
            <span class="kind-tag ${p.kind === 'external' ? 'ext' : 'int'}">
              ${p.kind === 'external' ? '外部 · ' + escapeHtml(p.runtime) : '内建 · node'}
            </span>
            ${p.pid ? `<span class="hint">pid ${p.pid}</span>` : ''}
            ${
              p.frameworkVersion
                ? `<span class="hint" title="插件声明的框架版本要求">需框架 ${escapeHtml(p.frameworkVersion)}</span>`
                : ''
            }
            ${(p.shortDesc || p.description) ? '<br>' + escapeHtml(p.shortDesc || p.description) : ''}
          </div>
          ${chips ? `<div class="plugin-metrics">${chips}</div>` : ''}
          ${p.error ? `<div class="err">加载失败: ${escapeHtml(p.error)}</div>` : ''}
          ${p.menuMissing ? '<div class="err">未提供指令菜单，用户看不到它能做什么</div>' : ''}
        </div>
        <span class="badge ${p.loaded ? 'on' : p.enabled ? '' : 'off'}">
          ${p.loaded ? '运行中' : p.enabled ? '未加载' : '已禁用'}
        </span>
        ${u ? `<button class="btn small primary" data-update-one="${escapeHtml(p.id)}">更新</button>` : ''}
        <button class="btn small" data-act="${p.enabled ? 'disable' : 'enable'}">
          ${p.enabled ? '禁用' : '启用'}
        </button>
        <button class="btn small" data-act="reload">重载</button>
        <button class="btn small" data-act="panel">设置</button>
        <button class="btn small danger" data-act="remove" title="删除插件代码，数据保留">卸载</button>
      </div>`;
    }).join('');

    // 顶部提示：有几个可更新
    const n = (upd.updates || []).length;
    const tip = $('#pluginUpdateTip');
    if (tip) {
      tip.innerHTML = n
        ? `<b>${n} 个插件有新版本</b>，去「插件市场」一键更新。` +
          `<a href="javascript:void(0)" id="lnkUpdateAll">全部更新</a>`
        : '';
      const lnk = $('#lnkUpdateAll');
      if (lnk) lnk.addEventListener('click', () => updateAllFromMarket());
    }

    wrap.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.plugin');
        const id = card.dataset.id;
        // 「设置」不是启停操作，走独立弹窗
        if (btn.dataset.act === 'panel') {
          openPluginPanel(id);
          return;
        }

        /**
         * 卸载是不可逆的（代码目录直接删），必须先问清楚。
         * 数据目录不删——用户重装后还想接着用存档。
         */
        if (btn.dataset.act === 'remove') {
          const name = card.dataset.name || id;
          const ok = await confirmDialog({
            title: `卸载插件「${name}」`,
            message:
              `会删除 <code>plugins/${escapeHtml(id)}</code> 整个目录，插件代码就没了。\n\n` +
              '它的<b>数据会保留</b>（群档案、插件存档都在 data/ 里），重装之后还能接着用。\n\n' +
              '确定卸载？',
            okText: '卸载',
            danger: true,
          });
          if (!ok) return;
        }

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

    // 单个插件的「更新」按钮
    wrap.querySelectorAll('[data-update-one]').forEach((btn) => {
      btn.addEventListener('click', () => updateFromMarket(btn.dataset.updateOne, btn));
    });
  } catch (e) {
    wrap.innerHTML = `<div class="empty">加载失败: ${e.message}</div>`;
  }
}

/* ---------------- 事件订阅与接收 ---------------- */

async function loadEvents() {
  const sum = $('#eventSummary');
  const wrap = $('#eventGroups');
  if (!sum || !wrap) return;

  let d;
  try {
    d = await api('/api/events');
  } catch (e) {
    sum.innerHTML = `<div class="empty">加载失败: ${e.message}</div>`;
    return;
  }

  sum.innerHTML = `
    <div class="ev-stat"><b>${d.total}</b><span>已登记事件</span></div>
    <div class="ev-stat"><b>${d.enabled.length}</b><span>已订阅 intent</span></div>
    <div class="ev-stat"><b>${d.received}</b><span>收到过的事件</span></div>
    <div class="ev-stat"><b>${d.intents}</b><span>intents 掩码</span></div>
  `;

  wrap.innerHTML = d.groups
    .map((g) => {
      const rows = g.items
        .map((it) => {
          const cls = !it.subscribed ? 'off' : it.count > 0 ? 'hit' : 'on';
          const meta = [
            it.intentName,
            it.message ? `→ Message(${it.message})` : '→ 原始 d',
            it.doc ? '' : '文档未列出',
          ]
            .filter(Boolean)
            .join(' · ');
          const right =
            it.count > 0
              ? `<span class="ev-count">${it.count} 次</span><span class="ev-ago">${fmtAgo(it.lastAt)}</span>`
              : `<span class="ev-never">${it.subscribed ? '等待中' : '未订阅'}</span>`;
          return `
            <div class="ev-row ${cls}">
              <b class="ev-dot ${cls}"></b>
              <code class="ev-name">${it.name}</code>
              <span class="ev-desc">${it.desc}<i class="ev-meta">${meta}</i></span>
              <span class="ev-right">${right}</span>
            </div>`;
        })
        .join('');
      return `
        <div class="ev-group">
          <div class="ev-group-hd">${g.group}<span>${g.items.length}</span></div>
          ${rows}
        </div>`;
    })
    .join('');
}

/* ---------------- 插件刷新与市场 ---------------- */

/** 重新扫描 plugins/ 目录，加载新放进去的、卸载已删除的 */
async function rescanPlugins() {
  const btn = $('#btnRescanPlugins');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    const r = await api('/api/plugins/rescan', { method: 'POST', body: '{}' });
    const parts = [];
    if (r.added?.length) parts.push(`新加载：${r.added.join('、')}`);
    if (r.removed?.length) parts.push(`已卸载：${r.removed.join('、')}`);
    // 加载失败要说出来，不然用户只会看到「没有新插件」，以为插件没放进去
    if (r.errors?.length) {
      parts.push('加载失败：' + r.errors.map((e) => `${e.id}（${e.error}）`).join('、'));
    }
    const msg = parts.join('\n') || '没有发现新插件';
    await loadPlugins();
    await confirmDialog({ title: '刷新完成', message: msg, okText: '知道了' });
  } catch (e) {
    await confirmDialog({ title: '刷新失败', message: e.message, okText: '知道了' });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function loadMarket() {
  const box = $('#marketBox');
  const list = $('#marketList');
  const meta = $('#marketMeta');
  box.hidden = false;
  meta.textContent = '获取中…';
  list.innerHTML = '<div class="empty">正在从 GitHub 获取插件列表…</div>';

  let d;
  try {
    d = await api('/api/market');
  } catch (e) {
    meta.textContent = '获取失败';
    list.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
    return;
  }

  meta.textContent = `${d.repo} · 更新于 ${d.updated || '未知'}`;
  // 网络不通时后端会退回本地缓存，得让用户知道这是旧数据
  if (d.stale) {
    meta.innerHTML =
      `${escapeHtml(d.repo)} · <span class="stale-tip">离线缓存（${escapeHtml(d.staleAge || '未知')}）</span>`;
  }
  if (!d.plugins.length) {
    list.innerHTML = '<div class="empty">市场里还没有插件</div>';
    return;
  }

  const upd = {};
  for (const u of d.updates || []) upd[u.id] = u;

  list.innerHTML = d.plugins
    .map(
      (p) => {
        const u = upd[p.id];
        return `
      <div class="plugin">
        <div class="info">
          <div class="name">${escapeHtml(p.name || p.id)}
            <span class="hint">v${escapeHtml(p.version || '0.0.0')}</span>
            ${u ? `<span class="upd-tag">可更新 ${escapeHtml(u.current)} → ${escapeHtml(u.latest)}</span>` : ''}
          </div>
          <div class="meta">
            ${escapeHtml(p.id)}
            <span class="kind-tag ${p.runtime === 'node' ? 'int' : 'ext'}">
              ${p.runtime === 'node' ? '内建 · node' : '外部 · ' + escapeHtml(p.runtime || '')}
            </span>
            ${p.author ? `<span class="hint">by ${escapeHtml(p.author)}</span>` : ''}
            ${p.credits ? `<span class="hint">${escapeHtml(p.credits)}</span>` : ''}
            ${p.description ? '<br>' + escapeHtml(p.description) : ''}
            ${(p.tags || []).length ? '<br><span class="hint">' + p.tags.map(escapeHtml).join(' / ') + '</span>' : ''}
            ${u ? `<br><span class="hint">本地版本 v${escapeHtml(u.current)}</span>` : ''}
          </div>
        </div>
        ${
          u
            ? `<button class="btn small primary" data-update="${escapeHtml(p.id)}">更新到 ${escapeHtml(u.latest)}</button>`
            : p.installed
              ? '<span class="badge on">已安装</span>'
              : `<button class="btn small primary" data-install="${escapeHtml(p.id)}">安装</button>`
        }
      </div>`;
      },
    )
    .join('');

  $$('[data-install]').forEach((b) => {
    b.addEventListener('click', () => installFromMarket(b.dataset.install, b));
  });
  $$('[data-update]').forEach((b) => {
    b.addEventListener('click', () => updateFromMarket(b.dataset.update, b));
  });
}

/** 一键更新全部有新版 的插件 */
async function updateAllFromMarket() {
  let count = 0;
  let names = '';
  try {
    const d = await api('/api/plugins/updates?force=1');
    count = (d.updates || []).length;
    names = (d.updates || []).map((u) => `${u.name || u.id} ${u.current}→${u.latest}`).join('\n');
  } catch {
    /* 拿不到详情就用通用文案 */
  }
  if (!count) {
    alert('没有可更新的插件');
    return;
  }

  const ok = await confirmDialog({
    title: `更新 ${count} 个插件`,
    message:
      `以下插件会被覆盖更新：\n\n${escapeHtml(names)}\n\n` +
      '<b>插件目录会被整体覆盖</b>——手动改过的代码会丢失。' +
      '玩家存档在 <code>data/</code> 下，不受影响。\n\n' +
      '更新后会自动重载。',
    okText: '全部更新',
  });
  if (!ok) return;

  try {
    const r = await api('/api/market/update-all', { method: 'POST', body: '{}' });
    const lines = [`更新完成：成功 ${r.updated?.length ?? 0} 个`];
    if (r.skipped?.length) lines.push(`跳过 ${r.skipped.length} 个（已是最新或未安装）`);
    if (r.failed?.length) {
      lines.push(`失败 ${r.failed.length} 个：`);
      for (const f of r.failed) lines.push(`  · ${f.id}：${f.error}`);
    }
    alert(lines.join('\n'));
    await loadPlugins();
    if (!$('#marketBox').hidden) await loadMarket();
  } catch (e) {
    alert('更新失败: ' + e.message);
  }
}

/** 更新插件。会覆盖本地目录，必须先跟用户说清楚 */
async function updateFromMarket(id, btn) {
  let info = null;
  try {
    const d = await api('/api/plugins/updates?force=1');
    info = (d.updates || []).find((u) => u.id === id) || null;
  } catch {
    /* 拿不到详情就用通用文案 */
  }

  const ok = await confirmDialog({
    title: `更新插件「${info?.name || id}」`,
    message:
      `将把 <b>${escapeHtml(id)}</b> 从 ` +
      `<b>v${escapeHtml(info?.current || '?')}</b> 更新到 <b>v${escapeHtml(info?.latest || '?')}</b>。<br><br>` +
      '<b>插件目录会被整体覆盖</b>——如果你手动改过这个插件的代码，改动会丢失。' +
      '玩家存档在 <code>data/</code> 下，不受影响。<br><br>' +
      '更新后会自动重载插件。',
    okText: '确认更新',
  });
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const r = await api('/api/market/update', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    btn.textContent = '已更新';
    await loadMarket();
    await loadPlugins();
    if (r.error) alert(r.error);
  } catch (e) {
    alert('更新失败: ' + e.message);
    btn.disabled = false;
    btn.textContent = '重试';
  }
}

async function installFromMarket(id, btn) {
  const ok = await confirmDialog({
    title: `安装插件「${id}」`,
    message:
      '插件代码会从 GitHub 拉下来，并**在当前进程里运行**。\n\n' +
      '只装你信得过的来源——它能读到机器人的全部数据。',
    okText: '确认安装',
  });
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = '安装中…';
  try {
    const r = await api('/api/market/install', { method: 'POST', body: JSON.stringify({ id }) });
    await loadPlugins();
    await loadMarket();
    await confirmDialog({
      title: '安装完成',
      message: r.added?.length
        ? `已加载：${r.added.join('、')}`
        : r.errors?.length
          ? `插件已安装，但加载失败：\n${r.errors.map((e) => `${e.id}：${e.error}`).join('\n')}`
          : '插件已安装，但没能自动加载，看日志找原因',
      okText: '知道了',
    });
  } catch (e) {
    await confirmDialog({ title: '安装失败', message: e.message, okText: '知道了' });
    btn.disabled = false;
    btn.textContent = '安装';
  }
}

$('#btnRescanPlugins')?.addEventListener('click', rescanPlugins);

// 统计：换时间范围、手动刷新
$('#btnRefreshStats')?.addEventListener('click', loadStats);
$('#statsDays')?.addEventListener('change', loadStats);
$('#btnRefreshMarket')?.addEventListener('click', loadMarket);
$('#btnLoadMarket')?.addEventListener('click', () => {
  const box = $('#marketBox');
  if (box.hidden) loadMarket();
  else box.hidden = true;
});

/* ---------------- 插件设置面板 ---------------- */

let PP = null; // 当前打开面板的插件数据

async function openPluginPanel(id) {
  try {
    PP = await api(`/api/plugins/${encodeURIComponent(id)}/panel`);
  } catch (e) {
    await confirmDialog({ title: '打不开', message: e.message, okText: '知道了' });
    return;
  }
  $('#ppTitle').textContent = `${PP.name} · 设置`;
  renderPPConfig();
  renderPPData();
  renderPPDash();
  switchPPTab('config');
  $('#pluginPanelMask').hidden = false;
}

function switchPPTab(name) {
  $$('.pp-tab').forEach((b) => b.classList.toggle('active', b.dataset.pp === name));
  $('#ppConfig').hidden = name !== 'config';
  $('#ppData').hidden = name !== 'data';
  $('#ppDash').hidden = name !== 'dash';
  $('#ppSave').hidden = name !== 'config';
}

/**
 * 「运行数据」标签：插件自己决定显示什么。
 * 数据来自插件导出的 dashboard() 或 ctx.setDashboard()，框架只负责排版。
 */
function renderPPDash() {
  const box = $('#ppDash');
  const d = PP.dashboard;
  if (!d || (!d.metrics?.length && !d.note)) {
    box.innerHTML =
      '<div class="empty">这个插件没有提供运行数据。<br>' +
      '插件可以导出 <code>dashboard()</code> 或用 <code>ctx.setDashboard()</code> 上报。</div>';
    return;
  }

  const cards = (d.metrics ?? [])
    .map(
      (m) => `
      <div class="dash-card">
        <div class="dash-k">${escapeHtml(m.label)}</div>
        <div class="dash-v">${escapeHtml(m.value)}${
          m.unit ? `<span class="dash-unit">${escapeHtml(m.unit)}</span>` : ''
        }</div>
        ${m.hint ? `<div class="dash-hint">${escapeHtml(m.hint)}</div>` : ''}
      </div>`,
    )
    .join('');

  box.innerHTML =
    (cards ? `<div class="dash-grid">${cards}</div>` : '') +
    (d.note ? `<pre class="dash-note">${escapeHtml(d.note)}</pre>` : '') +
    `<div class="pp-hint" style="margin-top:10px">插件上报于 ${new Date(
      d.updatedAt || Date.now(),
    ).toLocaleTimeString()}</div>`;
}

function renderPPConfig() {
  const keys = Object.keys(PP.schema || {});
  const box = $('#ppConfig');
  if (!keys.length) {
    box.innerHTML =
      '<div class="empty">这个插件没有声明可配置项。<br>' +
      '在插件的 config 里写默认值，就会自动出现在这里。</div>';
    return;
  }

  box.innerHTML = keys
    .map((k) => {
      const s = PP.schema[k];
      const v = PP.config?.[k] ?? s.default;
      const id = escapeHtml(k);
      let input;
      if (s.type === 'boolean') {
        input = `<label class="pp-switch"><input type="checkbox" data-cfg="${id}" ${v ? 'checked' : ''}> ${v ? '开' : '关'}</label>`;
      } else if (s.type === 'number') {
        input = `<input type="number" data-cfg="${id}" value="${Number(v) || 0}">`;
      } else if (s.type === 'select') {
        input = `<select data-cfg="${id}">${(s.options || [])
          .map((o) => `<option ${o === v ? 'selected' : ''}>${escapeHtml(o)}</option>`)
          .join('')}</select>`;
      } else if (s.type === 'json') {
        input = `<textarea data-cfg="${id}" rows="4">${escapeHtml(JSON.stringify(v ?? null, null, 2))}</textarea>`;
      } else {
        input = `<input type="text" data-cfg="${id}" value="${escapeHtml(v ?? '')}">`;
      }
      return `<label class="pp-field"><span>${id}</span>${input}${s.desc ? `<i>${escapeHtml(s.desc)}</i>` : ''}</label>`;
    })
    .join('');
}

function renderPPData() {
  const keys = PP.dataKeys || [];
  const box = $('#ppData');
  if (!keys.length) {
    box.innerHTML = '<div class="empty">这个插件还没有存任何数据。</div>';
    return;
  }

  box.innerHTML =
    `<div class="pp-hint">共 ${keys.length} 条。改完点保存立即生效，插件不用重载。</div>` +
    keys
      .map(
        (k) => `
      <div class="pp-data-row">
        <div class="pp-data-key">${escapeHtml(k)}</div>
        <textarea rows="3" data-val="${escapeHtml(k)}">${escapeHtml(JSON.stringify(PP.data[k], null, 2))}</textarea>
        <div class="pp-data-acts">
          <button class="btn small" data-save="${escapeHtml(k)}">保存</button>
          <button class="btn small danger" data-del="${escapeHtml(k)}">删除</button>
        </div>
      </div>`,
      )
      .join('');

  $$('[data-save]').forEach((b) => b.addEventListener('click', () => savePPData(b.dataset.save, b)));
  $$('[data-del]').forEach((b) => b.addEventListener('click', () => deletePPData(b.dataset.del, b)));
}

async function savePPConfig() {
  const patch = {};
  let bad = null;

  $$('[data-cfg]').forEach((el) => {
    const k = el.dataset.cfg;
    const type = PP.schema[k]?.type;
    if (type === 'boolean') patch[k] = el.checked;
    else if (type === 'number') patch[k] = Number(el.value);
    else if (type === 'json') {
      try {
        patch[k] = JSON.parse(el.value || 'null');
      } catch {
        bad = k;
      }
    } else patch[k] = el.value;
  });

  if (bad) {
    await confirmDialog({ title: '格式不对', message: `「${bad}」不是合法 JSON`, okText: '知道了' });
    return;
  }

  try {
    const r = await api(`/api/plugins/${encodeURIComponent(PP.id)}/config`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    PP.config = r.config;
    await confirmDialog({ title: '已保存', message: '配置已生效，插件立刻能读到新值。', okText: '知道了' });
  } catch (e) {
    await confirmDialog({ title: '保存失败', message: e.message, okText: '知道了' });
  }
}

async function savePPData(key, btn) {
  const ta = document.querySelector(`[data-val="${CSS.escape(key)}"]`);
  if (!ta) return;
  let value;
  try {
    value = JSON.parse(ta.value);
  } catch {
    await confirmDialog({ title: '格式不对', message: `「${key}」的内容不是合法 JSON`, okText: '知道了' });
    return;
  }
  btn.disabled = true;
  try {
    await api(`/api/plugins/${encodeURIComponent(PP.id)}/data`, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    });
    PP.data[key] = value;
  } catch (e) {
    await confirmDialog({ title: '保存失败', message: e.message, okText: '知道了' });
  } finally {
    btn.disabled = false;
  }
}

async function deletePPData(key, btn) {
  const ok = await confirmDialog({
    title: `删除 ${key}`,
    message: '这条存档会被直接删掉，不可恢复。',
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await api(`/api/plugins/${encodeURIComponent(PP.id)}/data`, {
      method: 'POST',
      body: JSON.stringify({ key, remove: true }),
    });
    delete PP.data[key];
    PP.dataKeys = Object.keys(PP.data);
    renderPPData();
  } catch (e) {
    await confirmDialog({ title: '删除失败', message: e.message, okText: '知道了' });
    btn.disabled = false;
  }
}

$$('.pp-tab').forEach((b) => b.addEventListener('click', () => switchPPTab(b.dataset.pp)));
$('#ppClose')?.addEventListener('click', () => {
  $('#pluginPanelMask').hidden = true;
});
$('#ppSave')?.addEventListener('click', savePPConfig);
$('#pluginPanelMask')?.addEventListener('click', (e) => {
  if (e.target === $('#pluginPanelMask')) $('#pluginPanelMask').hidden = true;
});

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
const LEVEL_LABEL = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };
let logBuf = [];

/** 模块名 → 颜色类（plugin:dice 这类取前缀 plugin） */
function tagClass(tag) {
  if (!tag) return '';
  const base = String(tag).split(':')[0];
  const known = ['gateway', 'api', 'core', 'webui', 'plugins', 'roles', 'groups', 'message', 'token', 'plugin'];
  return known.includes(base) ? `tag-${base}` : 'tag-other';
}

/** 按内容判断消息类型，决定正文颜色 */
function msgClass(text) {
  const s = String(text ?? '');
  if (/失败|错误|出错|异常|超时|拒绝|无效|不正确|无法|error|failed/i.test(s)) return 'msg-err';
  if (/^收到\s/.test(s)) return 'msg-in';
  if (/已就绪|已连接|已恢复|成功|已加载|已启用|已禁用|已设为|已设置|已保存|已重载|已移除/.test(s)) {
    return 'msg-ok';
  }
  if (/(^|[\s：:])[\/][a-z]/i.test(s)) return 'msg-cmd';
  return '';
}

function logLine(e) {
  const el = document.createElement('div');
  el.className = `log-line ${e.level}`;
  el.dataset.level = e.level;

  const lv = `<span class="lv">${LEVEL_LABEL[e.level] ?? e.level}</span>`;
  const tag = e.tag ? `<span class="tag ${tagClass(e.tag)}">${escapeHtml(e.tag)}</span>` : '';
  const cls = msgClass(e.msg);
  const body = `<span class="m${cls ? ' ' + cls : ''}">${escapeHtml(e.msg)}</span>`;

  el.innerHTML = `<span class="t">${e.time}</span>${lv}${tag}${body}`;
  return el;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function applyFilter() {
  renderLogs();
}

/* 日志来源分类：给「来源」下拉用 */
function logSourceOf(e) {
  const tag = e.tag ?? '';
  if (tag.startsWith('plugin:') || tag === 'plugins') return 'plugin';
  if (tag === 'gateway' || tag === 'api' || tag === 'token') return 'net';
  return 'core';
}

function logMatches(e) {
  const min = LEVEL_ORDER[$('#logLevelFilter').value] ?? 0;
  if ((LEVEL_ORDER[e.level] ?? 0) < min) return false;

  const src = $('#logSourceFilter').value;
  if (src !== 'all' && logSourceOf(e) !== src) return false;

  const kw = ($('#logSearch').value ?? '').trim().toLowerCase();
  if (kw) {
    const hay = `${e.msg ?? ''} ${e.tag ?? ''}`.toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  return true;
}

/** 按当前过滤条件整页重绘（切换筛选时用） */
function renderLogs() {
  const atBottom = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 40;
  logView.innerHTML = '';
  for (const e of logBuf) {
    if (logMatches(e)) logView.appendChild(logLine(e));
  }
  if ($('#autoScroll').checked && atBottom) logView.scrollTop = logView.scrollHeight;
}

function appendLog(e) {
  logBuf.push(e);
  if (logBuf.length > 600) logBuf.shift();
  if (!logMatches(e)) return;
  const el = logLine(e);
  const atBottom = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 40;
  logView.appendChild(el);
  if ($('#autoScroll').checked && atBottom) logView.scrollTop = logView.scrollHeight;
}

$('#logLevelFilter').addEventListener('change', applyFilter);
$('#logSourceFilter').addEventListener('change', applyFilter);
// 输入防抖：每敲一个字就重绘 600 条日志会卡
let logSearchTimer = null;
$('#logSearch').addEventListener('input', () => {
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(applyFilter, 180);
});
$('#btnClearLog').addEventListener('click', () => { logBuf = []; logView.innerHTML = ''; });

async function initLogs() {
  try {
    const list = await api('/api/logs?limit=300&level=debug');
    // 缓冲区也要清，否则切换机器人后日志会重复堆叠
    logBuf = [];
    logView.innerHTML = '';
    list.forEach(appendLog);
    logView.scrollTop = logView.scrollHeight;
  } catch {}
}

/* ---------------- SSE ---------------- */

function connectStream() {
  // 调试用：地址带 ?nosse 就不建 SSE。
  // 无头浏览器截图时 SSE 长连接会让页面一直处于加载态，截不到渲染结果。
  if (location.search.includes('nosse')) return;
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
  /**
   * 插件注册的页面标签 + 深链接先处理。
   *
   * 这两步放在最前面：/#page:xxx 这类地址要**立刻**切过去，
   * 不能等 loadBots / pollStatus / 日志这些网络请求跑完——
   * 用户看到的应该是自己点的那一页，而不是先闪一下概览。
   */
  await loadPluginPages();
  const initial = location.hash.slice(1);
  if (initial) activateTab(initial);

  await loadBots(); // 先确定当前机器人，后面的请求都会带上 ?bot=
  await pollStatus();
  await initLogs();
  connectStream();
  initTheme();
  setInterval(pollStatus, 5000);
  bindIntentsUI();
  loadConfig();
  loadGroups();
  // 后台服务状态：detail 会变（内存、下次重启时间），30 秒刷一次够了
  loadServices();
  setInterval(loadServices, 30000);
  // 机器人确定后再刷一次：上面那次是抢时间，这次才是准数据
  if (initial) activateTab(initial);
  // 调试用：?openmenu 直接展开机器人下拉，方便截图和检查样式
  if (location.search.includes('openmenu')) openBotMenu();
})();
