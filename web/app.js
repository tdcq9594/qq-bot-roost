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
      if (e.key === 'Escape') return done(false);
      /**
       * 默认焦点在「取消」上（删除类操作的安全默认）。
       * 以前 Enter 无条件走 done(true)：焦点明明在取消，回车却执行了删除。
       * 只有焦点真的在确认按钮上才认 Enter。
       */
      if (e.key === 'Enter') done(document.activeElement === btnOk);
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
  // SSE 在连接建立时就绑死了机器人，切换后必须重建，否则状态还是旧的
  connectStream();
  // 所有页签的数据都跟机器人走，重拉一遍
  await pollStatus();
  // 插件注册的页面也跟着机器人走：不同机器人启用的插件不一样
  await loadPluginPages();
  const tab = location.hash.slice(1) || 'overview';
  if (tab === 'config') loadConfig();
  if (tab === 'plugins') loadPlugins();
  if (tab === 'events') loadEvents();
  if (tab === 'groups') loadGroups();
  if (tab === 'roles') { loadRoles(); loadPeople(); }
  if (tab === 'stats') loadStats();
  // 体检是按机器人做的，切了要重查
  loadDoctor();
  // 停在插件页面上切机器人：这一页在新机器人下可能不存在，退回到概览
  if (tab.startsWith('page:')) {
    activateTab(tabButton(tab) ? tab : 'overview');
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
  // 插件页面的 CSS 变量是跟着主题走的，切了要让它重新加载一次
  $$('.plugin-page').forEach((f) => {
    if (!f.dataset.key || !f.getAttribute('src')) return;
    const url = pluginPageUrl(f.dataset.key);
    if (f.getAttribute('src') !== url) f.src = url; // 主题没变就别重载
  });
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

/**
 * 「昵称（id）」——可读性优先。
 *
 * 以前面板上只有截断的 openid（`577C4A90…90D08`），用户根本认不出
 * 是哪个群、是哪个人。现在有昵称就放前面，id 缩在括号里；
 * 没有昵称（没说过话、群名没拉到）就退回原来的截断 id。
 *
 * @param {string} name 昵称 / 群名，可为空
 * @param {string} id openid
 * @returns {string}
 */
function labelWithId(name, id) {
  const s = shortId(id);
  const n = String(name ?? '').trim();
  return n ? `${escapeHtml(n)}（${escapeHtml(s)}）` : escapeHtml(s);
}

/* ---------------- Tab ---------------- */

/** 找到某个页签的按钮：一级按钮，或分组菜单里的项 */
function tabButton(name) {
  return (
    $$('[data-tab]').find(
      (b) =>
        b.dataset.tab === name &&
        (b.classList.contains('tab') || b.classList.contains('tab-item')),
    ) ?? null
  );
}

/** 收起所有下拉，except 那个分组留着 */
function closeTabMenus(except = null) {
  $$('.tab-group').forEach((g) => {
    if (g === except) return;
    g.classList.remove('open');
    g.querySelector('.tab-parent')?.setAttribute('aria-expanded', 'false');
    const menu = g.querySelector('.tab-menu');
    if (menu) menu.hidden = true;
  });
}

function activateTab(name) {
  const btn = tabButton(name);
  if (!btn) return;
  $$('.tab[data-tab], .tab-item[data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  /**
   * 选中的项在菜单里时，父级也要亮。
   * 否则用户看着「概览」亮着、内容却是日志，会以为自己点错了。
   */
  $$('.tab-group').forEach((g) => {
    const on = Boolean(g.querySelector('.tab-item.active'));
    g.classList.toggle('has-active', on);
    g.querySelector('.tab-parent')?.classList.toggle('active', on);
  });
  closeTabMenus();
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
  if (name === 'roles') { loadRoles(); loadPeople(); }
}

/**
 * 一级按钮和下拉菜单项都走同一套激活逻辑。
 *
 * 用**事件委托**绑在 nav 上，不是逐个 addEventListener。
 * 插件页面（`loadPluginPages`）的按钮是运行时动态创建的吗——
 * 不，动态创建的就是它。页面同步的 `$$('.tab-item')` 那时候还不存在，
 * 逐个绑的方式永远漏掉它们，表现就是「点了骰子战绩没反应」。
 *
 * 委托在祖先元素上，后来加进来的子元素一样能响应。
 */
$('nav')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab[data-tab], .tab-item[data-tab]');
  if (!btn || !btn.isConnected) return;
  activateTab(btn.dataset.tab);
  // 记进地址栏，刷新后还停在这一页，也方便直接分享 /#config
  history.replaceState(null, '', `#${btn.dataset.tab}`);
});

/* ---------------- 分组下拉 ---------------- */

$$('.tab-group').forEach((g) => {
  const parent = g.querySelector('.tab-parent');
  const menu = g.querySelector('.tab-menu');
  if (!parent || !menu) return;

  parent.addEventListener('click', (e) => {
    e.stopPropagation(); // 别让 document 的「点外面就收起」立刻把它关掉
    const open = !g.classList.contains('open');
    closeTabMenus(g);
    g.classList.toggle('open', open);
    parent.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
  });
});

document.addEventListener('click', () => closeTabMenus());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTabMenus();
});

// 支持直接打开 /#config 这类地址
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (name) activateTab(name);
});

/* ---------------- 概览 ---------------- */

function renderStatus(s) {
  // 迟到的别的机器人的状态包，直接丢掉
  if (s && s.botId && CURRENT_BOT && s.botId !== CURRENT_BOT) return;
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
        <td title="${escapeHtml(c.id)}">${labelWithId(c.name, c.id)}</td>
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
      /**
       * 磁盘上已经是新版、但进程还在跑旧代码。
       *
       * 这时候说「已是最新」会让人以为更新没成功——明明行为还是旧的。
       * 该做的是重启，不是再点一次「检查更新」。
       */
      if (d.needsRestart) {
        msg.innerHTML =
          `代码已更新到 <b>v${escapeHtml(d.current)}</b>，但程序还在跑更新前的版本。<br>` +
          '<b>重启程序后新版本才会生效</b>（配置、存档、插件都不受影响）。';
      } else {
        msg.textContent = `已是最新版本 v${d.current}`;
      }
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
  // 密钥不回显（后端只返回 accessKeySet）：留空 = 不修改
  f.webuiAccessKey.value = '';
  f.webuiAccessKey.placeholder = c.webui?.accessKeySet ? '已设置（留空则保持不变）' : '未设置';
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
    // 换连接方式要重启才生效，后端会带 restartRequired + message，原样转达
    $('#cfgMsg').textContent = r?.message
      ? r.message
      : (renamed ? `已保存，机器人昵称同步为「${r.name}」` : '已保存') +
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

  const nav = $('#pluginPageItems');
  const main = $('main');
  if (!nav || !main) return;

  const wanted = new Set(list.map((p) => `page:${p.key}`));

  // 去掉已经不存在的
  $$('.tab-item[data-plugin-page]').forEach((b) => {
    if (!wanted.has(b.dataset.tab)) b.remove();
  });
  $$('.panel[data-plugin-page]').forEach((p) => {
    if (!wanted.has(p.dataset.tab)) p.remove();
  });

  for (const p of list) {
    const tabName = `page:${p.key}`;
    if ($$('.tab-item').some((b) => b.dataset.tab === tabName)) continue;

    const btn = document.createElement('button');
    btn.className = 'tab-item';
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
     * allow-same-origin 是为了让页面能带密钥调 /api/ 拿数据；
     * allow-scripts 让它能跑自己的脚本。
     *
     * 必须说清楚：**这两个一起开等于没有隔离**。同源意味着插件页面
     * 能读 parent.document、localStorage，能以面板身份调任何接口。
     * 这里只挡住了样式互相污染，不挡权限。
     * 所以「插件注册远端 HTML」要当成引入第三方代码来对待，
     * 只装自己信得过的插件。
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

  // 一个插件页面都没有时，菜单里别留一条空的分隔线和「插件页面」标题
  const hasPages = nav.children.length > 0;
  const sep = $('#pluginPageSep');
  const label = $('#pluginPageLabel');
  if (sep) sep.hidden = !hasPages;
  if (label) label.hidden = !hasPages;

  // 正停在被删掉的那个插件页上（插件卸载了），退回概览，别让内容区空着
  const activeId = $('.panel.active')?.id?.replace(/^tab-/, '') ?? '';
  if (activeId.startsWith('page:') && !tabButton(activeId)) activateTab('overview');
}

/** 插件页面 iframe 的地址：带上密钥、当前机器人和主题 */
function pluginPageUrl(key) {
  const q = new URLSearchParams();
  if (ACCESS_KEY) q.set('key', ACCESS_KEY);
  if (CURRENT_BOT) q.set('bot', CURRENT_BOT);
  // 带上主题，页面里的 CSS 变量就能跟着面板切换，插件作者不用自己适配
  q.set('theme', document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
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

/* ---------------- 体检 ---------------- */

const DOCTOR_ICON = { ok: '✓', warn: '!', error: '✕' };

/**
 * 跑一遍体检并渲染。
 *
 * 自动跑一次：用户最常问的就是「我配好了为什么没反应」，与其等他去点，
 * 不如打开面板就告诉他。只有出现 error 时才自动展开，全绿就只留一行字。
 */
/**
 * 首次体检：等网关就绪再跑。
 *
 * 以前是打开面板立刻体检。刚启动时网关还在握手，state 是 starting，
 * 体检必定报「还没连上」——用户打开面板看到的第一个东西就是一条黄字，
 * 而他其实什么都没做错，几秒后自己就好了。
 *
 * 现在：状态还在 starting / idle 就等，连上（或明确失败、被下线）再跑。
 * 最多等 12 秒——12 秒还没连上，那是真有问题，这时候报出来才有意义。
 */
async function doctorWhenReady({ maxWaitMs = 12000 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const s = await api('/api/status').catch(() => null);
    const st = s?.state;
    // 已经就绪，或者明确失败 / 被下线：都别等了
    if (st === 'online' || st === 'offline' || st === 'stopped' || st === 'error' || s?.mock) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  loadDoctor();
}

async function loadDoctor({ expand } = {}) {
  const list = $('#doctorList');
  const summary = $('#doctorSummary');
  if (!list || !summary) return;

  summary.textContent = '检查中…';
  let d;
  try {
    d = await api('/api/doctor');
  } catch (e) {
    summary.textContent = `检查失败：${e.message}`;
    return;
  }

  const items = d.items ?? [];
  const bad = items.filter((x) => x.level === 'error');
  const warn = items.filter((x) => x.level === 'warn');

  summary.textContent = d.summary || '';
  summary.className = bad.length ? 'hint err-text' : 'hint';

  list.innerHTML = items
    .map(
      (x) => `<div class="doctor-item ${x.level}">
        <span class="doctor-icon">${DOCTOR_ICON[x.level] ?? '·'}</span>
        <div class="doctor-body">
          <b>${escapeHtml(x.title)}</b>
          <div class="doctor-detail">${escapeHtml(x.detail)}</div>
          ${x.fix ? `<div class="doctor-fix">→ ${escapeHtml(x.fix)}</div>` : ''}
        </div>
      </div>`,
    )
    .join('');

  // 全绿就不占地方，只留标题那一行
  list.hidden = expand === true ? false : !(bad.length || warn.length);
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
          ${
            p.error
              ? `<div class="err">加载失败: ${escapeHtml(p.error)}${
                  p.errorStack
                    ? `<details class="err-stack"><summary>查看堆栈</summary><pre>${escapeHtml(
                        p.errorStack,
                      )}</pre></details>`
                    : ''
                }</div>`
              : ''
          }
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
    wrap.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
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
    sum.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
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

/* ---------------- 下载源 ---------------- */

let MIRRORS = null;

/**
 * 下载源选择器。
 *
 * 国内直连 GitHub 经常超时，插件市场和框架更新都会失败。
 * 这里不猜哪个快——把源列出来，配一个测速按钮，用户按自己网络挑。
 */
async function loadMirrorBar() {
  const sel = $('#mirrorSelect');
  if (!sel) return;

  try {
    const d = await api('/api/mirror');
    MIRRORS = d;
    sel.innerHTML = (d.presets || [])
      .map(
        (p) =>
          `<option value="${escapeHtml(p.id)}"${p.id === d.current?.id ? ' selected' : ''}>${escapeHtml(
            p.name,
          )}</option>`,
      )
      .join('');
    syncMirrorCustom();
    const preset = (d.presets || []).find((p) => p.id === d.current?.id);
    $('#mirrorTip').textContent = preset?.note ?? '';
  } catch {
    sel.innerHTML = '<option value="auto">自动</option>';
  }
}

/** 选了「自定义前缀」才显示输入框 */
function syncMirrorCustom() {
  const sel = $('#mirrorSelect');
  const inp = $('#mirrorCustom');
  if (!sel || !inp) return;
  inp.hidden = sel.value !== 'custom';
  if (!inp.hidden && !inp.value) inp.value = MIRRORS?.current?.custom ?? '';
}

async function saveMirror() {
  const sel = $('#mirrorSelect');
  const inp = $('#mirrorCustom');
  const tip = $('#mirrorTip');
  if (!sel) return;

  try {
    const r = await api('/api/mirror', {
      method: 'PUT',
      body: JSON.stringify({
        mirror: sel.value,
        mirrorCustom: inp?.value ?? '',
        // 这两项在插件市场页不展示，原样带回去，别把用户填的清空
        mirrorChyanResId: MIRRORS?.current?.chyanResId ?? '',
        mirrorChyanCdk: MIRRORS?.current?.chyanCdk ?? '',
      }),
    });
    MIRRORS = { ...(MIRRORS ?? {}), current: r.current };
    const preset = (MIRRORS.presets || []).find((p) => p.id === sel.value);
    if (tip) tip.textContent = `已切换：${preset?.name ?? sel.value}（立即生效）`;
  } catch (e) {
    if (tip) tip.textContent = `切换失败：${e.message}`;
  }
}

async function testMirrors() {
  const tip = $('#mirrorTip');
  const btn = $('#btnMirrorTest');
  if (!tip || !btn) return;

  btn.disabled = true;
  tip.textContent = '测速中（最多 6 秒）…';
  try {
    const d = await api('/api/mirror/test', {
      method: 'POST',
      body: JSON.stringify({ custom: $('#mirrorCustom')?.value ?? '' }),
    });
    const rows = (d.results || []).map((r) =>
      r.ok ? `${r.name} ${r.ms}ms` : `${r.name} ✗`,
    );
    const okCount = (d.results || []).filter((r) => r.ok).length;
    tip.textContent = `${okCount}/${(d.results || []).length} 可用：${rows.join(' · ')}`;
  } catch (e) {
    tip.textContent = `测速失败：${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadMarket() {
  const box = $('#marketBox');
  const list = $('#marketList');
  const meta = $('#marketMeta');
  box.hidden = false;
  meta.textContent = '获取中…';
  list.innerHTML = '<div class="empty">正在从 GitHub 获取插件列表…</div>';
  // 下载源选择器：第一次打开市场时拉一次
  if (!MIRRORS) loadMirrorBar();

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
    MARKET.all = [];
    list.innerHTML = '<div class="empty">市场里还没有插件</div>';
    return;
  }

  const upd = {};
  for (const u of d.updates || []) upd[u.id] = u;

  MARKET.all = d.plugins;
  MARKET.upd = upd;
  buildMarketCats();
  renderMarketRows();
}

/** 市场数据与筛选状态 */
const MARKET = { all: [], upd: {}, q: '', tag: '' };

/** 搜索框和标签筛选都在前端做——索引就几十条，没必要每次都请求 */
function matchMarket(p) {
  const tag = MARKET.tag;
  if (tag) {
    const tags = [...(p.tags || []), p.category].filter(Boolean);
    if (!tags.includes(tag)) return false;
  }
  const q = MARKET.q.trim().toLowerCase();
  if (!q) return true;
  return [p.id, p.name, p.description, p.author, ...(p.tags || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(q);
}

/** 用索引里出现过的标签填充筛选下拉 */
function buildMarketCats() {
  const sel = $('#marketCat');
  if (!sel) return;
  const tags = new Set();
  for (const p of MARKET.all) {
    for (const t of p.tags || []) tags.add(t);
    if (p.category) tags.add(p.category);
  }
  const keep = MARKET.tag || '';
  sel.innerHTML =
    '<option value="">全部分类</option>' +
    [...tags].sort().map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  sel.value = keep;
}

function renderMarketRows() {
  const list = $('#marketList');
  const upd = MARKET.upd;
  const shown = MARKET.all.filter(matchMarket);

  if (!shown.length) {
    list.innerHTML = `<div class="empty">没有匹配的插件${
      MARKET.q || MARKET.tag ? '，换个关键词或分类试试' : ''
    }</div>`;
    return;
  }

  list.innerHTML = shown
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
$('#btnDoctor')?.addEventListener('click', () => loadDoctor({ expand: true }));

// 导出：直接开下载，不用 fetch——浏览器自己会带上 accessKey（拼在地址里）
$('#btnExportStats')?.addEventListener('click', () => {
  const days = Number($('#statsDays')?.value) || 7;
  const q = new URLSearchParams({ days: String(days) });
  if (ACCESS_KEY) q.set('key', ACCESS_KEY);
  if (CURRENT_BOT) q.set('bot', CURRENT_BOT);
  window.location.href = `/api/stats/export?${q}`;
});
$('#statsDays')?.addEventListener('change', loadStats);
$('#btnRefreshMarket')?.addEventListener('click', loadMarket);

// 市场筛选：纯前端过滤，输入即生效
$('#marketSearch')?.addEventListener('input', (e) => {
  MARKET.q = e.target.value;
  renderMarketRows();
});
$('#marketCat')?.addEventListener('change', (e) => {
  MARKET.tag = e.target.value;
  renderMarketRows();
});

// 下载源：换源立即保存并生效，测速只是给个参考
$('#btnMirrorTest')?.addEventListener('click', testMirrors);
$('#mirrorSelect')?.addEventListener('change', () => {
  syncMirrorCustom();
  saveMirror();
});
$('#mirrorCustom')?.addEventListener('change', saveMirror);
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
  $('#ppGroups').hidden = name !== 'groups';
  $('#ppSave').hidden = name !== 'config';
  $('#ppReset').hidden = name !== 'config';
  if (name === 'groups') renderPPGroups();
}

/**
 * 「分群开关」标签：这个插件在哪些群是关的。
 *
 * 和群页面那个「插件」弹窗读写同一份配置（cfg.plugins.groups），
 * 只是视角反过来——那边是「一个群能开哪些」，这边是「一个插件在哪些群关」。
 */
async function renderPPGroups() {
  const box = $('#ppGroups');
  if (!box) return;
  box.innerHTML = '<div class="empty">读取中…</div>';

  let d;
  try {
    d = await api(`/api/plugins/${encodeURIComponent(PP.id)}/groups`);
  } catch (e) {
    box.innerHTML = `<div class="empty">读取失败: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!d.groups?.length) {
    box.innerHTML = '<div class="empty">还没有群。把机器人拉进群后这里会自动出现。</div>';
    return;
  }

  const g = d.global ?? { mode: 'all', list: [] };
  const gText =
    g.mode === 'all'
      ? '全部启用'
      : `${g.mode === 'exclude' ? '排除' : '仅启用'} ${(g.list ?? []).length} 个`;
  box.innerHTML =
    `<div class="pp-hint">取消勾选 = 这个群不用这个插件；其它群照全局来（全局：${escapeHtml(gText)}）。改完立即生效。</div>` +
    d.groups
      .map((x) => {
        /**
         * 群名优先，没有名字就用备注，再没有才退回 openid 前缀。
         *
         * 以前这里固定渲染「名字 + shortId」两行，而名字永远是空的，
         * 于是每个群都是同一串 `577C4A90…` 出现两次——用户根本分不清
         * 要在哪个群关掉插件。现在把第二行让给「最近活跃」，
         * 认不出名字时至少能靠时间对上号。
         */
        const title = x.name || x.note || '';
        const label = title ? escapeHtml(title) : escapeHtml(shortId(x.chatId));
        const meta = [
          title ? escapeHtml(shortId(x.chatId)) : '',
          x.lastActiveAt ? escapeHtml(agoText(x.lastActiveAt)) : '还没说过话',
        ]
          .filter(Boolean)
          .join(' · ');
        return `<label class="gplug-item">
          <input type="checkbox" data-gid="${escapeHtml(x.chatId)}" ${x.enabled ? 'checked' : ''}>
          <span class="gp-name">${label}</span>
          <span class="gp-id">${meta}</span>
        </label>`;
      })
      .join('');

  box.querySelectorAll('input[data-gid]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try {
        await api(`/api/plugins/${encodeURIComponent(PP.id)}/groups`, {
          method: 'PUT',
          body: JSON.stringify({ chatId: cb.dataset.gid, enabled: cb.checked }),
        });
      } catch (e) {
        cb.checked = !cb.checked;
        await confirmDialog({ title: '改不了', message: e.message, okText: '知道了' });
      } finally {
        cb.disabled = false;
      }
    });
  });
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

  /**
   * 「快速填入」预设。
   *
   * 一次填好几个字段（比如换了服务商，baseUrl 和 model 要一起改），
   * 所以按钮放在整个表单上面，不是挂在某一个字段旁边。
   * 只填表，不保存——用户还能改完再点保存，填错了也不会直接落盘。
   */
  const presets = Array.isArray(PP.presets) ? PP.presets : [];
  const presetBar = presets.length
    ? `<div class="pp-presets">
         <span class="pp-presets-label">快速填入</span>
         ${presets
           .map(
             (p, i) =>
               `<button type="button" class="btn small" data-preset="${i}" title="${escapeHtml(
                 p.desc || '',
               )}">${escapeHtml(p.name || '预设')}</button>`,
           )
           .join('')}
       </div>
       <div class="pp-hint pp-presets-tip" hidden></div>`
    : '';

  box.innerHTML = presetBar + keys
    .map((k) => {
      const s = PP.schema[k];
      const v = PP.config?.[k] ?? s.default;
      const id = escapeHtml(k);
      let input;
      // 作者声明了 min/max/pattern/required 就带上，浏览器先拦一道；
      // 后端 setConfig 还会再校验一次（面板不是唯一入口）
      const attrs = [
        s.min !== undefined ? `min="${escapeHtml(String(s.min))}"` : '',
        s.max !== undefined ? `max="${escapeHtml(String(s.max))}"` : '',
        s.pattern ? `pattern="${escapeHtml(s.pattern)}"` : '',
        s.required ? 'required' : '',
        s.placeholder ? `placeholder="${escapeHtml(s.placeholder)}"` : '',
      ]
        .filter(Boolean)
        .join(' ');

      if (s.type === 'boolean') {
        /**
         * 内层**不能用 label**：外层已经是 `<label class="pp-field">`，
         * HTML 规范不允许 label 嵌套 label，浏览器会重新解析这段，
         * 结果就是复选框和文字竖着排、位置也歪。
         */
        input = `<span class="pp-switch"><input type="checkbox" data-cfg="${id}" ${
          v ? 'checked' : ''
        }> <span class="pp-switch-text">${v ? '开' : '关'}</span></span>`;
      } else if (s.type === 'number') {
        input = `<input type="number" data-cfg="${id}" value="${Number(v) || 0}" ${attrs}>`;
      } else if (s.type === 'select') {
        /**
         * 选项可以是纯字符串，也可以是 `{ value, label }`。
         *
         * 后者是为了「值给代码、文字给人」：比如 access 的值必须是
         * `allowlist`（代码里要判断），但下拉里写「只白名单」才好懂。
         * 值用 value 属性带上，显示用 label。
         */
        input = `<select data-cfg="${id}">${(s.options || [])
          .map((o) => {
            const val = o && typeof o === 'object' ? o.value : o;
            const text = o && typeof o === 'object' ? (o.label ?? o.value) : o;
            return `<option value="${escapeHtml(String(val))}" ${
              val === v ? 'selected' : ''
            }>${escapeHtml(String(text))}</option>`;
          })
          .join('')}</select>`;
      } else if (s.type === 'json') {
        input = `<textarea data-cfg="${id}" rows="4">${escapeHtml(JSON.stringify(v ?? null, null, 2))}</textarea>`;
      } else if (s.type === 'textarea') {
        // 人设、提示词这类长文本，单行 input 没法编辑
        input = `<textarea data-cfg="${id}" rows="4" ${
          s.placeholder ? `placeholder="${escapeHtml(s.placeholder)}"` : ''
        }>${escapeHtml(v ?? '')}</textarea>`;
      } else {
        input = `<input type="text" data-cfg="${id}" value="${escapeHtml(v ?? '')}" ${attrs}>`;
      }
      return `<label class="pp-field"><span>${escapeHtml(s.label || k)}${
        s.required ? '<i class="req">*</i>' : ''
      }</span>${input}${s.desc ? `<i>${escapeHtml(s.desc)}</i>` : ''}</label>`;
    })
    .join('');

  /**
   * 预设按钮：把值填进表单，**不自动保存**。
   *
   * 用户可能还要改模型名或者接着填 API Key，自动保存会把半成品写进配置。
   */
  box.querySelectorAll('button[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = presets[Number(btn.dataset.preset)];
      if (!p?.values) return;
      for (const [k, val] of Object.entries(p.values)) {
        const el = box.querySelector(`[data-cfg="${CSS.escape(k)}"]`);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = Boolean(val);
        else el.value = String(val ?? '');
      }
      // 让用户知道「填好了但没保存」，否则以为已经生效
      const hint = box.querySelector('.pp-presets-tip');
      if (hint) {
        hint.textContent = `已填入「${p.name}」的参数，检查后点下面的保存才会生效`;
        hint.hidden = false;
      }
    });
  });

  // 开关旁边那个「开/关」要跟着勾选变，否则勾了还显示「关」，看着像没点上
  box.querySelectorAll('.pp-switch input[type="checkbox"]').forEach((el) => {
    el.addEventListener('change', () => {
      const t = el.parentElement?.querySelector('.pp-switch-text');
      if (t) t.textContent = el.checked ? '开' : '关';
    });
  });
}

function renderPPData() {
  const keys = PP.dataKeys || [];
  const box = $('#ppData');
  if (!keys.length) {
    box.innerHTML = '<div class="empty">这个插件还没有存任何数据。</div>';
    return;
  }

  box.innerHTML =
    `<div class="pp-hint">共 ${keys.length} 条。改完点保存立即生效，插件不用重载。
      <button class="btn small danger" id="ppClearAll" style="margin-left:8px">清除全部数据</button>
    </div>` +
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
  $('#ppClearAll')?.addEventListener('click', (e) => clearPPData(e.currentTarget));
}

/**
 * 清空这个插件的全部存档。
 *
 * 只删数据，不动配置、不动插件本身。删了没法恢复，
 * 所以弹窗里把「多少条」写清楚，还要手打确认。
 */
async function clearPPData(btn) {
  const n = (PP.dataKeys ?? []).length;
  if (!n) return;
  const ok = await confirmDialog({
    title: '清除全部数据',
    message:
      `要把「${PP.name || PP.id}」的 ${n} 条存档全部删掉吗？\n\n` +
      '插件配置不受影响，但玩家数据、运行记录这些会一起没了，删了没法恢复。',
    okText: '全部删除',
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    const r = await api(`/api/plugins/${encodeURIComponent(PP.id)}/data`, {
      method: 'POST',
      body: JSON.stringify({ clear: true }),
    });
    PP.data = {};
    PP.dataKeys = [];
    renderPPData();
    await confirmDialog({
      title: '已清除',
      message: `删掉了 ${r.cleared ?? n} 条存档。`,
      okText: '知道了',
    });
  } catch (e) {
    await confirmDialog({ title: '清除失败', message: e.message, okText: '知道了' });
    btn.disabled = false;
  }
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

/**
 * 恢复出厂配置。
 *
 * 走单独接口，而不是「把每个默认值提交一遍」：那个接口是合并语义，
 * 插件升级后遗留的旧键会一直留在文件里。后端是删了重建，才真的干净。
 *
 * **会连 API Key 一起清掉**，所以必须让用户明确确认——这不是「改一下」，
 * 是「清空重来」。
 */
async function resetPPConfig() {
  const ok = await confirmDialog({
    title: `恢复「${PP.name}」的默认设置`,
    message:
      '所有配置项会恢复成插件声明的默认值。<br><br>' +
      '<b>填过的内容会一起清空</b>，包括 API 密钥这类需要重新申请或重新粘贴的值。' +
      '<br><br>确定要恢复吗？',
    okText: '恢复默认',
    danger: true,
  });
  if (!ok) return;

  const btn = $('#ppReset');
  btn.disabled = true;
  try {
    const r = await api(`/api/plugins/${encodeURIComponent(PP.id)}/resetconfig`, {
      method: 'POST',
      body: '{}',
    });
    PP.config = r.config ?? {};
    // 重新渲染，让表单显示新的（默认）值
    renderPPConfig();
    await confirmDialog({
      title: '已恢复默认',
      message: '配置已重置。需要重新填的项（比如 API 密钥）请补上再保存。',
      okText: '知道了',
    });
  } catch (e) {
    await confirmDialog({ title: '恢复失败', message: e.message, okText: '知道了' });
  } finally {
    btn.disabled = false;
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
$('#ppReset')?.addEventListener('click', resetPPConfig);
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
  /**
   * openid 是外部输入（手输 / 导入别人的配置），必须转义。
   * 以前直接拼进 innerHTML：填 `<img src=x onerror=...>` 就能在面板里执行，
   * 而面板能调所有 /api。
   */
  wrap.innerHTML = owners
    .map(
      (o) =>
        `<span class="chip" data-id="${escapeHtml(o)}">${escapeHtml(shortId(o))}<button class="chip-x" title="移除">×</button></span>`,
    )
    .join('');  wrap.querySelectorAll('.chip-x').forEach((btn) => {
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
  // openid 是十六进制串；挡掉明显的乱填和带尖括号的输入
  if (!/^[0-9A-Fa-f]{16,64}$/.test(v)) {
    alert('openid 应该是一串十六进制字符（16–64 位），可以在「权限 → 最近说过话的人」里点一下自动填入');
    return;
  }
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
    body.innerHTML = `<tr><td colspan="6" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
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
      <tr data-id="${escapeHtml(g.groupOpenid)}">
        <td title="${escapeHtml(g.groupOpenid)}">${labelWithId(g.groupName, g.groupOpenid)}</td>
        <td title="${escapeHtml(g.inviterOpenid || '')}">${g.inviterOpenid ? labelWithId(g.inviterName, g.inviterOpenid) : '-'}</td>
        <td title="${escapeHtml(g.ownerOpenid || '')}">${g.ownerOpenid ? labelWithId(g.ownerName, g.ownerOpenid) : '-'}</td>
        <td><span class="badge ${g.enabled ? 'on' : 'off'}">${g.enabled ? '在用' : '已移出'}</span></td>
        <td>${g.lastActiveAt ? fmtAgo(g.lastActiveAt) : '-'}</td>
        <td class="num">
          <button class="btn small" data-act="plugins" title="这个群能用哪些插件">插件</button>
          <button class="btn small danger" data-act="del">删除</button>
        </td>
      </tr>`)
    .join('');

  body.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      if (btn.dataset.act === 'plugins') {
        openGroupPlugins(id);
        return;
      }
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

/**
 * 分群插件开关。
 *
 * 一个机器人常在好几个群里，有的群要骰子、有的群嫌吵。这里给每个群
 * 一份独立的启用名单，不配的群跟着全局走。
 *
 * 只改「分发时」的判断，不动加载——插件在进程里是全局加载的，
 * 按群卸载等于每个群一套运行时。
 *
 * @param {string} chatId 群 openid
 */
async function openGroupPlugins(chatId) {
  const mask = $('#gplugMask');
  const list = $('#gplugList');
  const save = $('#gplugSave');
  const cancel = $('#gplugCancel');
  if (!mask || !list || !save || !cancel) return;

  let d;
  try {
    d = await api(`/api/groups/${encodeURIComponent(chatId)}/plugins`);
  } catch (e) {
    return alert('读取失败: ' + e.message);
  }

  const own = d.own;
  const g = d.global ?? { mode: 'all', list: [] };
  $('#gplugSub').textContent = `群 ${shortId(chatId)}：只影响这一个群，其它群不受影响。`;  $('#gplugGlobalHint').textContent =
    g.mode === 'all'
      ? '（全局：全部启用）'
      : `（全局：${g.mode === 'exclude' ? '排除' : '仅启用'} ${(g.list ?? []).length} 个）`;

  for (const r of document.querySelectorAll('input[name="gplugMode"]')) {
    r.checked = r.value === (own ? 'custom' : 'global');
  }

  list.innerHTML = d.plugins?.length
    ? d.plugins
        .map(
          (p) => `<label class="gplug-item">
            <input type="checkbox" value="${escapeHtml(p.id)}" ${p.enabled ? 'checked' : ''}>
            <span class="gp-name">${escapeHtml(p.name)}</span>
            <span class="gp-id">${escapeHtml(p.id)}</span>
            <span class="gp-ver">${escapeHtml(p.version || '')}</span>
          </label>`,
        )
        .join('')
    : '<div class="gplug-empty">这个机器人还没加载任何插件</div>';

  const syncMode = () => {
    const custom = document.querySelector('input[name="gplugMode"]:checked')?.value === 'custom';
    list.hidden = !custom;
  };
  for (const r of document.querySelectorAll('input[name="gplugMode"]')) r.onchange = syncMode;
  syncMode();

  mask.hidden = false;

  cancel.onclick = () => {
    mask.hidden = true;
  };
  save.onclick = async () => {
    const custom = document.querySelector('input[name="gplugMode"]:checked')?.value === 'custom';
    save.disabled = true;
    try {
      const body = custom
        ? {
            mode: 'include',
            list: [...list.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value),
          }
        : { reset: true };
      await api(`/api/groups/${encodeURIComponent(chatId)}/plugins`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      mask.hidden = true;
      await loadGroups();
    } catch (e) {
      alert('保存失败: ' + e.message);
    } finally {
      save.disabled = false;
    }
  };
}

$('#btnReloadGroups')?.addEventListener('click', loadGroups);

// 手动登记群：官方没有「列出所在群」的接口，只能靠事件被动发现
$('#btnAddGroup')?.addEventListener('click', async () => {
  const gid = $('#groupOpenidInput')?.value.trim();
  const note = $('#groupNoteInput')?.value.trim();
  if (!gid) return alert('群 openid 不能为空');
  try {
    await api('/api/groups', { method: 'POST', body: JSON.stringify({ groupOpenid: gid, note }) });
    if ($('#groupOpenidInput')) $('#groupOpenidInput').value = '';
    if ($('#groupNoteInput')) $('#groupNoteInput').value = '';
    await loadGroups();
  } catch (e) {
    alert(`登记失败：${e.message}`);
  }
});

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

$('#btnAddGroupManual')?.addEventListener('click', addGroupManually);
$('#groupInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addGroupManually(); }
});

/* ---------------- 权限 ---------------- */

const LEVEL_TEXT = { 0: '主人', 1: '管理员', 2: '群管', 3: '助手' };
const levelText = (n) => LEVEL_TEXT[n] ?? (n >= 9999 ? '普通成员' : `${n} 级管理`);

/** 多久以前说过话 */
function agoText(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/** msg.kind → 权限作用域前缀 */
const SCOPE_OF_KIND = { group: 'group', guild: 'channel', dm: 'channel', c2c: 'user' };

function scopeText(scope) {
  const [kind, ...rest] = String(scope).split(':');
  const id = rest.join(':');
  const label =
    kind === 'group' ? '群' : kind === 'channel' ? '频道' : kind === 'user' ? '私聊' : kind;
  return id ? `${label} ${shortId(id)}` : label;
}

/**
 * 「最近说过话的人」。
 *
 * openid 是每个机器人独立的长串，用户不可能手输。让人从刚说过话的名单里点一下，
 * 比去日志里翻要靠谱——这也是这一页最容易卡住的地方。
 */
async function loadPeople() {
  const box = $('#peopleList');
  if (!box) return;
  try {
    const list = await api('/api/roles/candidates');
    if (!Array.isArray(list) || !list.length) {
      box.innerHTML =
        '<div class="empty">还没有收到消息。让要授权的人在群里说句话，这里就会出现。</div>';
      return;
    }
    box.innerHTML = list
      .map((p) => {
        const scope = `${SCOPE_OF_KIND[p.scope] ?? 'group'}:${p.chatId}`;
        return `<button class="person" data-openid="${escapeHtml(p.openid)}" data-scope="${escapeHtml(
          scope,
        )}" title="${escapeHtml(p.openid)}">
          <b>${escapeHtml(p.name || '（无昵称）')}</b>
          <span class="mono">${escapeHtml(shortId(p.openid))}</span>
          <i>${escapeHtml(scopeText(scope))} · ${escapeHtml(agoText(p.at))}</i>
        </button>`;
      })
      .join('');
  } catch (e) {
    box.innerHTML = `<div class="empty">读取失败：${escapeHtml(e.message)}</div>`;
  }
}

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
          <td title="${escapeHtml(r.scope)}">${escapeHtml(r.groupName ? `${r.groupName}（${shortId(r.scope.split(':').slice(1).join(':'))}）` : scopeText(r.scope))}</td>
          <td title="${escapeHtml(r.openid)}">${labelWithId(r.name, r.openid)}</td>
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
    body.innerHTML = `<tr><td colspan="4" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

$('#btnReloadRoles')?.addEventListener('click', loadRoles);
$('#btnReloadPeople')?.addEventListener('click', loadPeople);

/**
 * 点一个人 → 把 openid 和作用域填进表单，用户只要选等级再点保存。
 * 不直接写入权限：授予权限是不可逆的外部状态变更，得让人确认一次。
 */
$('#peopleList')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.person');
  if (!btn) return;
  const openid = $('#roleOpenid');
  const scope = $('#roleScope');
  if (openid) openid.value = btn.dataset.openid;
  if (scope) scope.value = btn.dataset.scope;
  openid?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#roleLevel')?.focus();
});

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
  if (logBuf.length > 600) {
    logBuf.shift();
    // 缓冲区裁剪的同时要把 DOM 也裁掉，否则只 appendChild 不删，节点无限累积
    if (logView.firstElementChild && logView.children.length > 600) logView.firstElementChild.remove();
  }
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

let stream = null;

function connectStream() {
  // 调试用：地址带 ?nosse 就不建 SSE。
  // 无头浏览器截图时 SSE 长连接会让页面一直处于加载态，截不到渲染结果。
  if (location.search.includes('nosse')) return;
  /**
   * 必须带 bot 参数。
   * 服务端在连接建立时用 pickRuntime() 绑定机器人，不带就是 runtimes[0]；
   * 切到机器人 B 后，5 秒一次的 pollStatus 显示 B，2 秒一次的 SSE 又用 A 覆盖回来。
   */
  const sp = new URLSearchParams();
  if (ACCESS_KEY) sp.set('key', ACCESS_KEY);
  if (CURRENT_BOT) sp.set('bot', CURRENT_BOT);
  stream?.close?.();
  const es = new EventSource(`/api/stream?${sp}`);
  stream = es;
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
  // 打开面板就体检一次：等网关就绪再跑，别在握手阶段就报「还没连上」
  doctorWhenReady();
  // 机器人确定后再刷一次：上面那次是抢时间，这次才是准数据
  if (initial) activateTab(initial);
})();
