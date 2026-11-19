/* QQ 机器人控制台前端：原生 JS，无框架、无构建 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// 面板访问密钥不再由前端保存：服务端在首跳用 ?key= 换成 HttpOnly Cookie，
// 之后的请求浏览器自动带上。以前存 localStorage，等于任何一处 XSS 都能直接
// 读走面板全权（拿到 key 就能装插件 = 执行任意代码）。
// 顺手清掉旧版本残留的那份，否则它会一直躺在浏览器里。
try { localStorage.removeItem('qqbot_key'); } catch {}

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
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    /**
     * 把后端的错误码和「下一步」一起带出来。
     *
     * 只给 `message` 的话，前端只能原样贴一句话，用户看不出是自己操作错了、
     * 平台限频了、还是该重新登录。`code` 用于分支判断，`hint` 用于展示。
     */
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.code = String(data?.code || '');
    err.hint = String(data?.hint || '');
    err.status = res.status;
    throw err;
  }
  return data;
}

/** 错误 + 下一步，统一成一行给人看 */
function errText(e) {
  const msg = String(e?.message || e || '');
  const hint = String(e?.hint || '');
  return hint && !msg.includes(hint) ? `${msg}（${hint}）` : msg;
}

/* ---------------- 轻量提示 ---------------- */

/**
 * 右下角短提示。此前只有调用点（概览页 dry 卡等 3 处）、全仓没有定义，
 * 点一下就抛 ReferenceError。这里补上：不引第三方、不新增 CSS 变量、
 * 容器用 createElement 动态生成，不进 index.html 的静态快照。
 * 主要反馈仍走就地文案 / 内联提示，toast 只承接瞬时确认。
 */
function toast(message, kind = 'info') {
  let host = $('#toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' toast-err' : kind === 'ok' ? ' toast-ok' : '');
  el.textContent = String(message ?? '');
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 240);
  }, 4000);
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
  // danger 是兜底：万一 btn-danger 的规则被拿掉，至少还退成红描边，不会变成普通按钮
  btnOk.classList.toggle('danger', danger);
  btnOk.classList.toggle('btn-danger', danger);
  btnOk.classList.toggle('primary', !danger);
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
  /**
   * 顶栏不再画状态点（见 index.html 里的说明）：那里只回答「我在管哪只鸟」。
   * 在线状态照旧在「运行」页和下拉列表里看，数据一点没少，只是不再用颜色当唯一信号。
   */
  const trigger = $('#botTrigger');
  if (trigger) {
    trigger.title = cur ? `${cur.name}${cur.online ? ' · 在线' : ' · 离线'}` : '还没有机器人';
  }
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
  // 扫出来的是「当前这只鸟」的新凭证：换了机器人就不能再往新表单里灌
  if (qrSlot === 'cfg') resetQr();
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
  if (tab === 'ledger') loadLedger();
  if (tab === 'reach') loadReach();
  if (tab === 'onebot') loadOnebot();
  if (tab === 'delivery') loadDelivery();
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

/* ---------------- 扫码（新建机器人 / 更新凭证） ---------------- */

/**
 * 官方有「绑定」接口，手机 QQ 扫一下就能拿到 AppID / AppSecret，
 * 不用去 q.qq.com 手动建机器人、再手动复制两个值。
 *
 * 二维码内容是官方给的一个 URL，我们本地画成二维码（web/vendor/qrcode.js）。
 * 密钥（bindKey）留在服务端，前端只拿到 taskId。
 *
 * 两个入口共用这套逻辑，区别只在「扫完之后把值填哪」：
 *   · `new` —— 新建机器人弹窗：填进 #nbAppId / #nbSecret，等用户补个 ID 再创建；
 *   · `cfg` —— 配置页的连接凭证：填进 cfgForm，AppSecret 被重置、或者整只机器人
 *     换账号时用，点「保存设置」才生效（自动保存会在用户没反应过来时重连一次，
 *     扫码本来就可能是误点，不该顺带把在线连接掐掉）。
 *
 * 同一时刻只允许一个扫码任务：换位置扫会先把上一个收掉，免得两个 interval
 * 抢同一个 taskId、或者把结果填到已经关掉的弹窗里。
 */
let qrTaskId = '';
let qrTimer = null;
let qrSlot = '';

const QR_SLOTS = {
  new: {
    box: '#nbQr', code: '#nbQrCode', tip: '#nbQrTip', btn: '#nbQrStart',
    hint: '用手机 QQ 扫码，确认后会自动填好 AppID / AppSecret',
    onDone(r) {
      $('#nbAppId').value = r.appId || '';
      $('#nbSecret').value = r.appSecret || '';
      $('#nbQrTip').textContent = `✓ 已拿到 AppID ${r.appId}，填个 ID 就能创建`;
      $('#nbId').focus();
    },
  },
  cfg: {
    box: '#cfgQr', code: '#cfgQrCode', tip: '#cfgQrTip', btn: '#cfgQrStart',
    hint: '用手机 QQ 扫码，确认后自动填到上面，再点「保存设置」生效',
    onDone(r) {
      const f = $('#cfgForm');
      f.appId.value = r.appId || '';
      // 扫码给的是完整的一对，直接覆盖输入框；留空会被后端当成「不修改」
      f.appSecret.value = r.appSecret || '';
      /**
       * 二维码已经用完了，留着只是一块黑白方块：清掉图纸，让提示单独留着，
       * 这样用户视线落在「点保存设置」上，而不是再扫一次。
       */
      const code = $('#cfgQrCode');
      if (code) code.innerHTML = '';
      $('#cfgQrTip').textContent = `✓ 已换成 AppID ${r.appId}，点「保存设置」生效`;
      $('#cfgSaveTop')?.focus();
    },
  },
};

function qrEls(name) {
  const s = QR_SLOTS[name];
  if (!s) return null;
  return { s, box: $(s.box), code: $(s.code), tip: $(s.tip), btn: $(s.btn) };
}

function stopQrPoll() {
  if (qrTimer) {
    clearInterval(qrTimer);
    qrTimer = null;
  }
}

/** 收掉两个位置的二维码，顺带清空任务——打开/关闭弹窗、重扫都走这里 */
function resetQr() {
  stopQrPoll();
  qrTaskId = '';
  qrSlot = '';
  for (const name of Object.keys(QR_SLOTS)) {
    const els = qrEls(name);
    if (!els) continue;
    if (els.box) els.box.hidden = true;
    if (els.code) els.code.innerHTML = '';
    if (els.tip) els.tip.textContent = '';
  }
}

function drawQr(url, code) {
  if (!code || typeof qrcode !== 'function') return false;
  const qr = qrcode(0, 'M'); // 0 = 自动选版本
  qr.addData(url);
  qr.make();
  code.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 6 });
  return true;
}

async function startQr(name = 'new') {
  const els = qrEls(name);
  if (!els) return;
  const { box, tip, btn } = els;
  if (!box || !tip || !btn) return;

  if (qrSlot && qrSlot !== name) resetQr();
  qrSlot = name;
  box.hidden = false;
  tip.textContent = '正在生成二维码…';
  btn.disabled = true;
  try {
    const r = await api('/api/bots/qr/start', { method: 'POST', body: '{}' });
    qrTaskId = r.taskId;
    if (!drawQr(r.qrUrl, els.code)) {
      tip.textContent = '二维码库没加载上，刷新页面再试一次';
      return;
    }
    tip.textContent = els.s.hint;
    stopQrPoll();
    qrTimer = setInterval(pollQr, 2000);
  } catch (e) {
    tip.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

async function pollQr() {
  if (!qrTaskId) return stopQrPoll();
  const els = qrEls(qrSlot);
  if (!els || !els.tip) return stopQrPoll();
  const { tip } = els;
  try {
    const r = await api('/api/bots/qr/poll', {
      method: 'POST',
      body: JSON.stringify({ taskId: qrTaskId }),
    });
    if (r.status === 'pending') return;
    stopQrPoll();
    qrTaskId = '';
    if (r.status === 'done') els.s.onDone(r);
    else tip.textContent = r.message || '二维码失效了，重新生成一个';
  } catch (e) {
    stopQrPoll();
    if (tip) tip.textContent = e.message;
  }
}

/* ---------------- 新建机器人 ---------------- */

function openNewBot() {
  closeBotMenu();
  $('#nbId').value = '';
  $('#nbName').value = '';
  $('#nbAppId').value = '';
  $('#nbSecret').value = '';
  $('#nbErr').hidden = true;
  resetQr();
  $('#newBotMask').hidden = false;
  $('#nbId').focus();
}

function closeNewBot() {
  resetQr();
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

// 传箭头函数：直接把 startQr 挂上去会把 click 事件当成位置名传进去
$('#nbQrStart')?.addEventListener('click', () => startQr('new'));
$('#cfgQrStart')?.addEventListener('click', () => startQr('cfg'));

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

/* ---------------- 主题与外观 ---------------- */

/**
 * 三个 localStorage 键的分工（改这段之前先看一眼，顺序很容易搞反）：
 *
 *   qqbot_appearance  新结构，唯一真相：{ mode, preset, base, seed, ink, bg }
 *   qqbot_theme       老键，只存 light / dark —— 降级回旧版本时还认得明暗
 *   qqbot_palette     老键，只存 a/b/c/d —— 降级时至少认得四套底色
 *
 * 后两个**只写不读**；只有在没有新键时（从旧版本升上来的用户）才拿来迁移。
 */
const THEME_KEY = 'qqbot_theme';
const PALETTE_KEY = 'qqbot_palette';
const APPEARANCE_KEY = 'qqbot_appearance';

/**
 * 五组底色。id 沿用 a/b/c/d/w：CSS 里本来就写着这五块。
 *
 * 现在**没有单独入口**了（「外观」页的底色那一行已撤）：底色由预设隐含，
 * 换底色 = 换预设。这张表留着是为了校验存下来的 base 是否合法，
 * 以及给自定义配色提供 ink 的候选色。
 *
 * **只在浅色下生效**——黑夜是固定黑白，不跟配色走（见 style.css 的
 * [data-theme="dark"]）。
 */
const BASES = [
  { id: 'a', name: '暖褐', light: '#f8f5f1', dark: '#0a0a0a' },
  { id: 'b', name: '冷蓝', light: '#f2f5fb', dark: '#0a0a0a' },
  { id: 'c', name: '青绿', light: '#f2efea', dark: '#0a0a0a' },
  { id: 'd', name: '紫调', light: '#f5f2fb', dark: '#0a0a0a' },
  // 默认：纯白底 + 蓝主色，不染色（黑夜不用它，黑夜是固定黑白）
  { id: 'w', name: '默认', light: '#ffffff', dark: '#0a0a0a' },
];

/** 浅色下按钮深字的候选：取该底色暗侧的面板色，跟着底色走才不脏 */
const BASE_INK = { a: '#1f1813', b: '#222a3b', c: '#182c2c', d: '#322e45', w: '#26262b' };

/**
 * 十套配色（**只在浅色下可用**）。
 *
 * 前四套 `native: true` 不参与派生：它们的 `--primary-*` 是 CSS 里手挑的，
 * 走原路径才能保证像素级零回归。后四套的 seed 会派生出 hover/fill/soft/border，
 * 取自主流暗色项目的原生强调色（Catppuccin red / Tokyo Night yellow /
 * One Dark green / Catppuccin pink），落在 8 个高星配色项目实测的
 * L 0.70–0.85 / C 0.08–0.14 区间内。
 */
const PRESETS = [
  { id: 'a', name: '琥珀', base: 'a', seed: '#af5504', native: true },
  { id: 'rose', name: '玫红', base: 'a', seed: '#b02a48' },
  { id: 'b', name: '靛蓝', base: 'b', seed: '#3b55d9', native: true },
  /**
   * 浅蓝：满大街按钮的那个蓝（Element UI 主色 #409EFF）。
   * 它比靛蓝亮一档、色相偏青，走派生配色——底色也会跟着变成极浅的蓝。
   * 按钮文字由 inkFor 自动选：白字在这个亮度上只有 2.6:1，会落到深色字上。
   */
  { id: 'sky', name: '浅蓝', base: 'b', seed: '#409eff' },
  { id: 'gold', name: '姜黄', base: 'b', seed: '#8a6400' },
  { id: 'c', name: '青', base: 'c', seed: '#2e6e76', native: true },
  { id: 'green', name: '松绿', base: 'c', seed: '#3f7d20' },
  { id: 'd', name: '紫罗兰', base: 'd', seed: '#5a48cf', native: true },
  { id: 'pink', name: '品红', base: 'd', seed: '#a03a72' },
  { id: 'default', name: '默认', base: 'w', seed: '#2563eb', native: true },
];

/** 当前外观（已收敛过的）。全站只有这一份，改外观一律走 applyAppearance() */
let APPEARANCE = null;
/** 背景图的 objectURL：换图 / 清除时要 revoke，不 then 会一直占内存 */
let bgObjectUrl = '';

/* --- 色彩小工具：只用来选黑/白，不做派生（派生交给 CSS） --- */

function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}

function relLuminance(hex) {
  const [r, g, b] = hexToRgb(hex)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [x, y] = [relLuminance(a), relLuminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/**
 * 浅色下主色按钮上的字用白还是用该底色的深色。
 *
 * 深色主题不用这套：那边按钮固定白底黑字（--primary-ink 写死在 CSS 里）。
 * 浅黄 seed 上白字只有 1.44:1，必须翻深色——所以比两个候选的对比度，谁高用谁。
 */
function inkFor(seed, base) {
  const dark = BASE_INK[base] || BASE_INK.a;
  return contrastRatio(seed, '#ffffff') >= contrastRatio(seed, dark) ? '#ffffff' : dark;
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const isHex = (v) => HEX_RE.test(String(v || ''));

/**
 * 这个浏览器会不会算相对色（`oklch(from …)`）。
 *
 * 不会的话，CSS 里那块派生被 @supports 挡住了，**自定义主色不会生效**——
 * 页面必须说清楚，否则用户拖半天取色器以为坏了。内置四套不受影响。
 */
const CAN_DERIVE = (() => {
  try { return CSS.supports('color', 'oklch(from red l c h)'); } catch { return false; }
})();

/**
 * 把任意输入（localStorage / 导入的 JSON / 页面上的临时改动）收敛成合法结构。
 *
 * 兼容旧版存下来的 `seed: {light, dark}`：深色现在不参与渲染，取 light 就够。
 * seed 或 base 一旦和预设本身不一致，就把 preset 降级成 `custom`，免得
 * 用户改了主色、预设名却还写着「琥珀」。
 */
function normalizeAppearance(input) {
  const src = input && typeof input === 'object' ? input : {};
  const byId = PRESETS.find((p) => p.id === src.preset) || null;
  const base = BASES.some((b) => b.id === src.base) ? src.base : (byId?.base || 'a');
  const fallback = byId || PRESETS[0];
  const rawSeed = typeof src.seed === 'string' ? src.seed : src.seed?.light;
  const seed = isHex(rawSeed) ? rawSeed : fallback.seed;
  let preset = byId ? byId.id : 'custom';
  if (byId && (byId.base !== base || byId.seed !== seed)) preset = 'custom';

  /**
   * custom = **用户自己挑的那个色**，与 seed（当前生效色）分开存。
   *
   * 不分开的话，切一次预设就把用户的色覆盖掉了，再点「自定义」看到的
   * 是上一个预设的颜色——那就等于没记住（2026-11-19 主人反馈）。
   * 空串表示「还没自定义过」，UI 上显示成彩虹点。
   */
  const custom = isHex(src.custom) ? src.custom : (preset === 'custom' ? seed : '');

  const bg = src.bg && typeof src.bg === 'object' ? src.bg : {};
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };

  return {
    v: 1,
    mode: ['auto', 'light', 'dark'].includes(src.mode) ? src.mode : 'auto',
    preset,
    base,
    seed,
    custom,
    ink: inkFor(seed, base),
    bg: {
      on: Boolean(bg.on),
      blur: clamp(bg.blur, 0, 24, 10),
      bright: clamp(bg.bright, 40, 100, 88),
      alpha: clamp(bg.alpha, 60, 96, 78),
    },
  };
}

function readAppearance() {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (raw) return normalizeAppearance(JSON.parse(raw));
  } catch { /* 坏 JSON 当没有，往下走迁移 */ }

  /**
   * 迁移：旧版本只存「明暗 + 四选一」。
   * 映射成对应的内置预设，浅色画面和升级前一模一样。
   */
  let mode = 'auto';
  let base = 'a';
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') mode = t;
    const p = localStorage.getItem(PALETTE_KEY);
    if (['a', 'b', 'c', 'd'].includes(p)) base = p;
  } catch {}
  const preset = PRESETS.find((x) => x.id === base) || PRESETS[0];
  return normalizeAppearance({ v: 1, mode, preset: preset.id, base: preset.base, seed: preset.seed });
}

function resolveTheme(mode = APPEARANCE?.mode || 'auto') {
  if (mode === 'light' || mode === 'dark') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** 插件页的变量由服务端按明暗注入，主题一变就得让 iframe 重新取一次 */
function reloadPluginFrames() {
  $$('.plugin-page').forEach((f) => {
    if (!f.dataset.key || !f.getAttribute('src')) return;
    const url = pluginPageUrl(f.dataset.key, f.dataset.token);
    if (f.getAttribute('src') !== url) f.src = url;
  });
}

/* ---------------- 背景图（IndexedDB 存原图，不进 localStorage） ---------------- */

/**
 * 为什么放 IndexedDB 而不是 localStorage：
 * 一张 1080p 的 JPEG 转成 base64 就是 2–4 MB，localStorage 上限 5 MB，
 * 而且它每次读都是同步的——`theme-boot.js` 在首屏前读一次会明显卡。
 * Blob 存 IndexedDB、渲染时 `URL.createObjectURL`，和 kun-galgame-forum 一样。
 */
const BG_DB = 'roost-ui';
const BG_STORE = 'kv';
const BG_KEY = 'background';

function bgDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('这个浏览器不支持 IndexedDB'));
    const req = indexedDB.open(BG_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BG_STORE)) req.result.createObjectStore(BG_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('打不开本地图片库'));
  });
}

async function bgGet() {
  const db = await bgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readonly');
    const req = tx.objectStore(BG_STORE).get(BG_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function bgPut(blob) {
  const db = await bgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readwrite');
    tx.objectStore(BG_STORE).put(blob, BG_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function bgDel() {
  const db = await bgDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BG_STORE, 'readwrite');
    tx.objectStore(BG_STORE).delete(BG_KEY);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 把背景图落到 CSS 变量上。
 *
 * 亮度是真的去压整张图（`filter: brightness()`），不是盖一层黑——盖黑会把
 * 图片的对比也压平，看起来灰蒙蒙；压亮度还能保留层次。
 */
function paintBackground() {
  const root = document.documentElement;
  const bg = APPEARANCE?.bg;
  if (!bg) return;
  root.style.setProperty('--bg-blur', `${bg.blur}px`);
  root.style.setProperty('--bg-bright', `${bg.bright}%`);
  root.style.setProperty('--surface-alpha', `${bg.alpha}%`);
  if (bg.on && bgObjectUrl) {
    root.style.setProperty('--bg-img', `url("${bgObjectUrl}")`);
    root.dataset.bg = 'image';
  } else {
    root.removeAttribute('data-bg');
    root.style.removeProperty('--bg-img');
  }
}

/** 启动时把图读回来（boot 只能先按 localStorage 的开关铺好半透明，这里补上图） */
async function loadBackground() {
  if (!APPEARANCE?.bg?.on) {
    paintBackground();
    return;
  }
  try {
    const blob = await bgGet();
    if (!blob) {
      // 开关在、图没了（清过缓存 / 换过浏览器）：老实关掉，别让面板悬空
      APPEARANCE.bg.on = false;
      saveAppearance();
      paintBackground();
      return;
    }
    if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
    bgObjectUrl = URL.createObjectURL(blob);
  } catch (e) {
    appearanceSay(`背景图读取失败：${e?.message || e}`, 'error');
  }
  paintBackground();
}

/* ---------------- 落地 ---------------- */

/**
 * 落地一次外观。
 *
 * 全站只有这一个写入口：页头按钮、外观页、导入，最后都走到这里。
 *
 * 深色是固定黑白：**不加 data-appearance，也不写种子**——CSS 那边
 * 派生块被 `:not([data-theme="dark"])` 挡着，双保险。
 */
function applyAppearance(input, { persist = true } = {}) {
  const next = normalizeAppearance(input);
  const root = document.documentElement;
  const native = Boolean(PRESETS.find((p) => p.id === next.preset)?.native);
  const prevTheme = root.dataset.theme;

  APPEARANCE = next;
  const theme = resolveTheme(next.mode);
  root.dataset.theme = theme;
  /**
   * 黑夜不写 data-palette：CSS 里浅色块虽然已经用 :not([data-theme="dark"])
   * 挡住了，这里再摘掉属性是第二道保险——属性不在，选择器根本不匹配。
   */
  if (theme === 'light') root.dataset.palette = next.base;
  else root.removeAttribute('data-palette');
  /**
   * 写上 preset：CSS 用它区分「内置预设」和「派生配色」——派生配色要把背景
   * 也按主色色相重新生成，预设则保持各自设计好的底色。
   */
  root.dataset.preset = next.preset;
  /**
   * native  = 四套内置（手挑底色，CSS 里定死）
   * derived = 其余（含自定义）：底色按主色色相现场生成，见 style.css
   */
  root.dataset.colorway = native ? 'native' : 'derived';

  if (theme === 'light' && !native) {
    root.dataset.appearance = 'custom';
    root.style.setProperty('--seed-light', next.seed);
    root.style.setProperty('--ink-light', next.ink);
  } else {
    root.removeAttribute('data-appearance');
    root.style.removeProperty('--seed-light');
    root.style.removeProperty('--ink-light');
  }
  // 深色下这两个变量不再参与渲染，清掉免得残留
  root.style.removeProperty('--seed-dark');
  root.style.removeProperty('--ink-dark');

  updateThemeBtn(theme);
  updatePaletteBtn();
  paintBackground();

  if (persist) saveAppearance();
  if (prevTheme && prevTheme !== theme) reloadPluginFrames();
}

function saveAppearance() {
  if (!APPEARANCE) return;
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(APPEARANCE)); } catch {}
  /**
   * 老键同时写一份：降级回旧版本时，明暗和四套底色还在。
   * 只有「明确选了明或暗」才写 THEME_KEY：跟随系统时留空，旧版本才会继续跟着系统走。
   */
  try {
    if (APPEARANCE.mode === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme || 'light');
    localStorage.setItem(PALETTE_KEY, APPEARANCE.base);
  } catch {}
}

function updateThemeBtn(t) {
  const btn = $('#btnTheme');
  if (btn) btn.title = t === 'dark' ? '切换到白天模式' : '切换到黑夜模式';
}

/** 页头按钮只报「当前是哪套」，配色细节交给外观页 */
function updatePaletteBtn() {
  const btn = $('#btnPalette');
  if (!btn || !APPEARANCE) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const name = dark
    ? '黑白（黑夜固定）'
    : (PRESETS.find((p) => p.id === APPEARANCE.preset)?.name || '自定义配色');
  btn.title = `当前配色：${name}（点击打开外观设置）`;
  btn.setAttribute('aria-label', `打开外观设置，当前配色是${name}`);
}

/* ---------------- 外观页 ---------------- */

/** 背景图区的提示。单独一个函数：这个框在页面中部，错误不能写到最底下的 #apMsg 去 */
let bgNote = '';
function bgSay(text, kind = '') {
  bgNote = String(text ?? '');
  const el = $('#apBgMsg');
  if (!el) return;
  el.textContent = bgNote;
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

function appearanceSay(text, kind = '') {
  const el = $('#apMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

/**
 * 重画外观页。
 *
 * 这一页本身就是预览：色块、边框、按钮都用当前变量渲染，改主色时整页跟着变。
 * 深色下配色区整块禁用——不是藏掉，是让人看见「深色固定黑白」这件事。
 */
function renderAppearance() {
  if (!APPEARANCE) return;
  const dark = document.documentElement.dataset.theme === 'dark';

  $$('#apMode [data-mode]').forEach((b) => {
    const on = b.dataset.mode === APPEARANCE.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });

  // 配色区在深色下整体禁用 + 说明
  const colorWrap = $('#apColors');
  if (colorWrap) {
    colorWrap.classList.toggle('ap-off', dark);
    colorWrap.querySelectorAll('button, input').forEach((el) => { el.disabled = dark; });
  }
  const darkNote = $('#apDarkNote');
  if (darkNote) darkNote.hidden = !dark;

  const presets = $('#apPresets');
  if (presets) {
    presets.innerHTML = PRESETS.map((p) => `
      <button type="button" class="ap-preset${p.id === APPEARANCE.preset ? ' on' : ''}"
              data-preset="${p.id}" aria-pressed="${p.id === APPEARANCE.preset}">
        <i style="background:${p.seed}"></i>${escapeHtml(p.name)}
      </button>`).join('');
    /**
     * 「自定义」常驻：不选中时显示彩虹点（= 自己挑），选中时显示当前主色。
     * 点它才弹取色器——取色器本身不再占一行，平时藏着。
     */
    const isCustom = APPEARANCE.preset === 'custom';
    const customDot = isHex(APPEARANCE.custom)
      ? ` style="background:${APPEARANCE.custom}"`
      : ' class="ap-rainbow"';
    presets.insertAdjacentHTML('beforeend', `
      <button type="button" class="ap-preset ap-custom${isCustom ? ' on' : ''}"
              data-preset="custom" aria-pressed="${isCustom}" title="用自己的主色">
        <i${customDot}></i>自定义
      </button>`);
  }

  const seedInput = $('#apSeed');
  if (seedInput) seedInput.value = APPEARANCE.seed;

  const hint = $('#apSeedHint');
  if (hint) {
    if (dark) {
      hint.textContent = '';
      hint.style.color = '';
    } else if (!CAN_DERIVE) {
      hint.textContent = '这个浏览器不支持相对色语法（Chrome / Edge 119+、Safari 16.4+），'
        + '自定义主色不会生效；内置预设不受影响。';
      hint.style.color = 'var(--warn-text)';
    } else {
      const ratio = contrastRatio(APPEARANCE.seed, APPEARANCE.ink);
      hint.textContent = `按钮文字对比度 ${ratio.toFixed(1)}:1`
        + (ratio >= 4.5 ? '' : '（偏低，把主色调深或调浅一点）');
      hint.style.color = ratio >= 4.5 ? '' : 'var(--warn-text)';
    }
  }

  // 背景图控件
  const sliders = [
    ['#apBgBlur', '#apBgBlurVal', APPEARANCE.bg.blur, 'px'],
    ['#apBgBright', '#apBgBrightVal', APPEARANCE.bg.bright, '%'],
    ['#apBgAlpha', '#apBgAlphaVal', APPEARANCE.bg.alpha, '%'],
  ];
  for (const [sel, labelSel, val, unit] of sliders) {
    const el = $(sel);
    if (el) el.value = String(val);
    const lb = $(labelSel);
    if (lb) lb.textContent = `${val}${unit}`;
  }
  const bgMsg = $('#apBgMsg');
  if (bgMsg) {
    bgMsg.textContent = bgNote || (APPEARANCE.bg.on ? '已启用（存在这台浏览器里）' : '未设置');
    if (!bgNote) bgMsg.style.color = '';
  }
  const clearBtn = $('#apBgClear');
  if (clearBtn) clearBtn.disabled = !APPEARANCE.bg.on;
}

function initAppearance() {
  APPEARANCE = readAppearance();
  // 先落地再画：boot 已经写过一次属性，这里补齐行内变量并纠正坏数据
  applyAppearance(APPEARANCE, { persist: false });
  renderAppearance();
  loadBackground();

  $('#apMode')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    applyAppearance({ ...APPEARANCE, mode: b.dataset.mode });
    renderAppearance();
  });

  $('#apPresets')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]');
    if (!b) return;
    if (b.dataset.preset === 'custom') {
      applyAppearance({ ...APPEARANCE, preset: 'custom', seed: APPEARANCE.custom || APPEARANCE.seed });
      renderAppearance();
      // 必须在这次点击的调用栈里触发，否则浏览器不给开取色器
      $('#apSeed')?.click();
      return;
    }
    const p = PRESETS.find((x) => x.id === b.dataset.preset);
    if (!p) return;
    applyAppearance({ ...APPEARANCE, preset: p.id, base: p.base, seed: p.seed });
    renderAppearance();
    appearanceSay('');
  });

  $('#apSeed')?.addEventListener('input', (e) => {
    const v = e.target.value;
    if (!isHex(v)) return;
    applyAppearance({ ...APPEARANCE, preset: 'custom', seed: v, custom: v });
    renderAppearance();
  });

  /* --- 背景图 --- */
  $('#apBgPick')?.addEventListener('click', () => {
    bgNote = '';           // 上一轮的报错别带进这次选择
    renderAppearance();
    $('#apBgFile')?.click();
  });

  $('#apBgFile')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许重复选同一张
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      bgSay(`「${file.name}」不是图片文件`, 'error');
      renderAppearance();
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      bgSay(`「${file.name}」有 ${mb} MB，超过 12 MB 上限——先压到 1080p 级别再试`, 'error');
      renderAppearance();
      return;
    }
    try {
      /**
       * 先让浏览器解一次：HEIC / 改过扩展名的假图片在这里就会失败。
       * 不校验的话，图存进去了却画不出来，表现得就和「没有反应」一样。
       */
      try {
        const bmp = await createImageBitmap(file);
        bmp.close?.();
      } catch {
        bgSay('这张图浏览器解不开，换 JPG / PNG / WebP 试试', 'error');
        renderAppearance();
        return;
      }
      await bgPut(file);
      if (bgObjectUrl) URL.revokeObjectURL(bgObjectUrl);
      bgObjectUrl = URL.createObjectURL(file);
      applyAppearance({ ...APPEARANCE, bg: { ...APPEARANCE.bg, on: true } });
      bgSay('已设为背景（存在这台浏览器里）', 'ok');
      renderAppearance();
    } catch (err) {
      bgSay(`存不进本地图片库：${err?.message || err}`, 'error');
      renderAppearance();
    }
  });

  $('#apBgClear')?.addEventListener('click', async () => {
    try { await bgDel(); } catch { /* 已经没有了 */ }
    if (bgObjectUrl) {
      URL.revokeObjectURL(bgObjectUrl);
      bgObjectUrl = '';
    }
    applyAppearance({ ...APPEARANCE, bg: { ...APPEARANCE.bg, on: false } });
    bgSay('背景已清除', 'ok');
    renderAppearance();
  });

  $('#apBgBlur')?.addEventListener('input', (e) => {
    applyAppearance({ ...APPEARANCE, bg: { ...APPEARANCE.bg, blur: Number(e.target.value) } });
    renderAppearance();
  });

  $('#apBgBright')?.addEventListener('input', (e) => {
    applyAppearance({ ...APPEARANCE, bg: { ...APPEARANCE.bg, bright: Number(e.target.value) } });
    renderAppearance();
  });

  $('#apBgAlpha')?.addEventListener('input', (e) => {
    applyAppearance({ ...APPEARANCE, bg: { ...APPEARANCE.bg, alpha: Number(e.target.value) } });
    renderAppearance();
  });

  $('#apExport')?.addEventListener('click', () => {
    const el = $('#apJson');
    if (!el || !APPEARANCE) return;
    el.value = JSON.stringify(APPEARANCE, null, 2);
    appearanceSay('已导出到上面，可以复制走或存成文件（背景图不包含在内）', 'ok');
  });

  $('#apImport')?.addEventListener('click', () => {
    const raw = $('#apJson')?.value?.trim() || '';
    if (!raw) {
      appearanceSay('先把 JSON 粘到上面', 'error');
      return;
    }
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      appearanceSay('不是合法 JSON：' + (e?.message || e), 'error');
      return;
    }
    if (!cfg || typeof cfg !== 'object' || (!cfg.seed && !cfg.preset)) {
      appearanceSay('这份 JSON 里没有 seed / preset，不像是外观配置', 'error');
      return;
    }
    // 导入不带背景图：图存在本地库里，导出的 JSON 里只有开关
    applyAppearance({ ...cfg, bg: { ...APPEARANCE.bg, on: APPEARANCE.bg.on } });
    renderAppearance();
    appearanceSay('已导入', 'ok');
  });

  $('#apReset')?.addEventListener('click', () => {
    applyAppearance({ v: 1, mode: 'auto', preset: 'a', base: 'a', seed: PRESETS[0].seed });
    renderAppearance();
    appearanceSay('已恢复默认：琥珀，跟随系统明暗；背景图未动（用「清除」单独删）', 'ok');
  });

  updatePaletteBtn();
}

function initTheme() {
  initAppearance();

  const btn = $('#btnTheme');
  btn?.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyAppearance({ ...APPEARANCE, mode: cur });
    renderAppearance();
  });

  /** 页头「更换主题」跳外观页：轮换四套的行为在有了外观页之后只会让人错过想要的那套 */
  $('#btnPalette')?.addEventListener('click', () => {
    activateTab('appearance');
    history.replaceState(null, '', '#appearance');
  });

  // 跟随系统：只在 mode=auto 时生效；手动选过明暗就不该被系统改回去
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener?.('change', () => {
    if (APPEARANCE?.mode !== 'auto') return;
    applyAppearance({ ...APPEARANCE }, { persist: false });
    renderAppearance();
  });
}

/* ---------------- 工具 ---------------- */
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

/**
 * 带头像的名字（权限页认人用）。
 *
 * 头像拿不到就只显示名字——**不塞默认头像**：一个通用小人像会让人以为
 * 「这就是他」，两三个人并排时反而更难认，比空着更糟。
 * `referrerpolicy` 是必须的：qlogo 的图对来源有校验，带 referer 会 403。
 */
function labelWithAvatar(name, id, avatar) {
  const url = String(avatar ?? '').trim();
  /**
   * 只认 http(s)：头像来自平台事件，理论上不会有 `data:` / `javascript:`，
   * 但这是拼进 `src` 的字符串，走白名单比"应该不会"便宜。
   */
  const ok = /^https?:\/\//i.test(url);
  const head = ok
    ? `<img class="who-av" src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : '';
  return head + labelWithId(name, id);
}

/**
 * 账本列表的头像：只认 http(s)，并把 qlogo 的 `s=640` 换成 `s=100`。
 *
 * 缩略图不是为了省服务器（图是腾讯的），是为了面板本身：一页 50 条，
 * 640px 的图每张 ~70KB，滚动时能明显感觉到卡。
 */
function ledgerAvatar(url) {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  return s.replace(/([?&]s=)\d+/, '$1100');
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

/**
 * 页面级错误边界。
 *
 * 之前任意一个 loadXxx 抛错都是静默的：面板停在「加载中…」，只留一条控制台
 * unhandled rejection，用户看不出哪里坏了。现在失败就在该页顶部亮一条可重试
 * 的错误条——就地反馈，不弹窗、不打断在别的页面上的操作。
 */
function showPageError(name, err) {
  const panel = document.getElementById(`tab-${name}`);
  const msg = (err && (err.message || err.reason?.message)) || String(err || '未知错误');
  console.error(`[webui] ${name} 加载失败`, err);
  if (!panel) return;
  let bar = panel.querySelector(':scope > .page-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'page-error';
    bar.setAttribute('role', 'alert');
    bar.innerHTML =
      '<span class="pe-msg"></span>' +
      '<button type="button" class="btn small" data-pe-retry>重试</button>' +
      '<button type="button" class="icon-btn" data-pe-close aria-label="关闭提示">✕</button>';
    bar.addEventListener('click', (e) => {
      if (e.target.closest('[data-pe-retry]')) {
        bar.remove();
        activateTab(name);
      } else if (e.target.closest('[data-pe-close]')) {
        bar.remove();
      }
    });
    panel.prepend(bar);
  }
  bar.querySelector('.pe-msg').textContent = `这个页面没加载出来：${msg}`;
}

/** 包一层：同步抛错和未处理的 Promise 都收敛到 showPageError */
function safeLoad(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((e) => showPageError(name, e));
  } catch (e) {
    showPageError(name, e);
  }
}

/* 兜底：没被 safeLoad 覆盖到的异常至少留个可查的痕迹，别让人对着白屏猜 */
window.addEventListener('error', (e) => {
  console.error('[webui] 未捕获异常', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[webui] 未处理的 Promise 拒绝', e.reason);
});

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
    safeLoad('plugins', loadPlugins);
    startPluginDashPolling();
  } else {
    stopPluginDashPolling();
  }
  if (name === 'events') safeLoad('events', loadEvents);
  if (name === 'ledger') safeLoad('ledger', loadLedger);
  /** 查询页：只在查过之后重跑一次，没查过就保持空状态，别一进来就打一次全表扫 */
  if (name === 'search') {
    /**
     * `srchView` 声明在文件中部：`activateTab` 可能在脚本执行到那儿之前就被调用
     * （hash 直接是 #search 时），同步读它会撞 TDZ。放进回调里读，那时脚本已经跑完。
     */
    safeLoad('search', () => (srchView.touched ? loadSearch(true) : undefined));
  }
  // 统计页：进来先拉一次，之后 10 秒一轮（统计本身是 1 秒批量落盘的，不用更密）
  if (name === 'stats') {
    safeLoad('stats', loadStats);
    startStatsPolling();
  } else {
    stopStatsPolling();
  }
  // 插件自定义页面：第一次点开才真正去拉 html，不点不请求；切机器人后地址会变，重新加载
  if (name.startsWith('page:')) {
    const frame = $(`#tab-${CSS.escape(name)} .plugin-page`);
    if (frame?.dataset.key) {
      const url = pluginPageUrl(frame.dataset.key, frame.dataset.token);
      if (frame.getAttribute('src') !== url) frame.src = url;
    }
  }
  if (name === 'config') safeLoad('config', loadConfig);
  /**
   * 外观页没有网络请求，只有一次重画：页头切明暗、别处导入之后回到这一页，
   * 色块和取色器要跟当前状态对齐。
   */
  if (name === 'appearance') renderAppearance();
  if (name === 'dev') safeLoad('dev', loadDev);
  if (name === 'groups') safeLoad('groups', loadGroups);
  if (name === 'reach') safeLoad('reach', loadReach);
  if (name === 'delivery') safeLoad('delivery', loadDelivery);
  if (name === 'roles') {
    safeLoad('roles', loadRoles);
    safeLoad('roles', loadPeople);
  }
  if (name === 'identity') safeLoad('identity', loadIdentity);
  if (name === 'notify') safeLoad('notify', loadNotify);
  if (name === 'onebot') safeLoad('onebot', loadOnebot);
  // 纯展示同步：侧栏 / 底栏高亮、面包屑、抽屉收起。不碰任何数据加载。
  syncNav(name);
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
    (s.counters.gated ?? 0) +
    (s.counters.ignored ?? 0);
  $('#c-err').textContent = `${s.counters.errors} / ${blocked}`;

  /**
   * E3：dry 出站截获。开着时不真发、只记下本来会发什么，点一下切换。
   * 只影响本进程内建插件；外部子进程插件走 NDJSON，不经过 outbound。
   */
  const dryEl = $('#c-dry');
  if (dryEl) {
    const on = Boolean(s.dry?.on);
    dryEl.textContent = on ? `开 · ${s.dry?.recent?.length ?? 0} 条` : '关';
    dryEl.style.cursor = 'pointer';
    dryEl.onclick = async () => {
      try {
        const r = await api('/api/dry', { method: 'POST', body: JSON.stringify({ on: !on }) });
        if (r?.ok) toast(r.on ? 'dry 模式已开：消息不会真发' : 'dry 模式已关');
        else toast(r?.error || '切换失败');
      } catch {
        toast('切换失败：连不上面板接口');
      }
    };
  }

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

  /**
   * 闸状态跟着每 2 秒的 status 一起刷。
   *
   * 不单独开一个轮询接口：暂停是紧急操作，如果面板要等用户点进某一页
   * 才去查，「原来还暂停着」就会拖很久才被发现。
   */
  renderGate(s.gate);

  const body = $('#chatBody');
  if (!s.chats?.length) {
    body.innerHTML = `<tr><td colspan="4" class="empty">暂无活跃会话${emptyAction('去发消息', 'go-send')}</td></tr>`;
  } else {
    body.innerHTML = s.chats.map((c) => `
      <tr>
        <td title="${escapeHtml(c.id)}">${labelWithId(c.name, c.id)}</td>
        <td>${c.kind === 'group' ? '群聊' : c.kind === 'c2c' ? '私聊' : c.kind}</td>
        <td class="num">${c.count}</td>
        <td>${fmtAgo(c.last)}</td>
      </tr>`).join('');
  }
  updateStatusStrip(s);
  updateMeters(s);
}

/** 上一次看到的进程实例标识，用来判断服务是不是重启过 */
let lastInstanceId = '';

async function pollStatus() {
  try {
    const d = await api('/api/status');
    /**
     * 进程重启 ⇒ 页面令牌全部重新生成、会话也全失效。
     * 已打开的插件页 iframe 手里还是旧令牌，接下来每个请求都会被判成跨站（403），
     * 用户看到的就是「切过去先红一下，等一会儿才好」。
     *
     * 这里一发现实例换了就立刻刷新令牌并重载 iframe，不必等兜底轮询。
     */
    const iid = String(d?.instanceId || '');
    if (lastInstanceId && iid && iid !== lastInstanceId) {
      refreshPageTokens();
    }
    lastInstanceId = iid;
    renderStatus(d);
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
      wrap.innerHTML = `<div class="empty">没有启用任何后台服务${emptyAction('刷新', 'refresh-services')}</div>`;
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

/* ---------------- 暂停闸 ---------------- */

/** 最近一次拿到的闸状态。按钮要靠它判断「现在点下去是开还是关」 */
let LAST_GATE = null;

/**
 * 画闸状态。
 *
 * 按钮文案跟着状态走（「暂停」/「放开」），而不是固定文案 + 一个指示灯——
 * 指示灯那种设计，用户点之前得先抬头看灯，点错了还要再点一次。
 */
function renderGate(gate) {
  LAST_GATE = gate ?? null;
  const el = $('#gateState');
  const bg = $('#btnGateGlobal');
  const bb = $('#btnGateBot');
  if (!el || !bg || !bb) return;

  const g = gate?.global ?? {};
  const b = gate?.bot ?? {};

  bg.textContent = g.paused ? '放开全局' : '全局暂停';
  bg.classList.toggle('primary', Boolean(g.paused));
  bb.textContent = b.paused ? '放开这只鸟' : '暂停这只鸟';
  bb.classList.toggle('primary', Boolean(b.paused));

  const why = [];
  if (g.paused) why.push(`全局已暂停${g.reason ? `（${g.reason}）` : ''}`);
  if (b.paused) why.push(`这只鸟已暂停${b.reason ? `（${b.reason}）` : ''}`);

  if (why.length) {
    el.innerHTML = `<b style="color:var(--warn-text)">${escapeHtml(why.join(' · '))}</b>`;
    el.title = '暂停期间消息照样进账本，恢复后能补看';
  } else {
    el.textContent = '运行中';
    el.title = '';
  }
}

async function setGate(scope, paused) {
  try {
    await api('/api/gate', { method: 'POST', body: JSON.stringify({ scope, paused }) });
    /**
     * 本地先翻转，不等下一次 status 推送。
     * status 是 2 秒一轮，点完等两秒才变，用户会以为没点上、再点一次，
     * 结果又翻回去了——这种「点了没反应」最容易被当成 bug。
     */
    if (LAST_GATE) {
      const k = scope === 'global' ? 'global' : 'bot';
      renderGate({ ...LAST_GATE, [k]: { ...(LAST_GATE[k] ?? {}), paused } });
    }
  } catch (e) {
    alert(`操作失败: ${e.message}`);
  }
}

$('#btnGateGlobal')?.addEventListener('click', () => {
  setGate('global', !LAST_GATE?.global?.paused);
});

$('#btnGateBot')?.addEventListener('click', () => {
  setGate('bot', !LAST_GATE?.bot?.paused);
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
  // 严格只认 true：老配置文件里没这个字段时保持关闭
  f.mediaPlaceholderSpace.checked = c.media?.placeholderSpace === true;

  /**
   * 自更新签名校验开关（字段名仍是 security.trust.enforce，自更新那边要读）。
   *
   * 只管「框架升级」这一条链路：插件市场从 2026-11-19 起不再做签名校验。
   * `pubkeySet: false` 时必须说清楚「开了也没用」——否则用户打开开关、
   * 以为已经受保护，实际什么都没发生，这比没有开关更糟。
   */
  const trust = c.security?.trust ?? {};
  f.trustEnforce.checked = Boolean(trust.enforce);
  const trustHint = $('#trustHint');
  if (trustHint) {
    trustHint.textContent = !trust.pubkeySet
      ? '当前框架没有内置信任公钥，这个开关即使打开也不起作用（框架自更新照常放行）。'
      : !trust.pubkeyValid
        ? '信任公钥配错了，解析不了——这个开关打开也不会生效。检查配置里的 security.trust.pubkey。'
        : '开启后，框架自更新会校验 SHA256SUMS 签名，不符或缺失时拒绝更新；插件市场不做签名校验。';
  }
}

/* ---------------- 事件订阅 intents ---------------- */

const INTENTS = [
  {
    bit: 25, group: 'chat', name: '群聊与私聊', needsApply: true,
    events: '群里 @机器人、私聊消息、机器人入群/退群、加好友/删好友',
    note: '需要在开放平台开通「群聊」能力，否则连接会被拒（关闭码 4014）',
  },
  {
    bit: 24, group: 'chat', name: '群成员变动', needsApply: true,
    events: '群成员加入 / 退出、用户申请加群（仅机器人是群管理员时能收到）',
    note: '官方 2026-08 新增的独立订阅位，和「群聊与私聊」分开勾，不勾收不到成员事件',
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
  const tick = `<span class="tick"><svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2 6.2 4.6 8.8 10 3.4" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;

  for (const group of ['chat', 'guild']) {
    const box = $(group === 'chat' ? '#intentGroupChat' : '#intentGroupGuild');
    box.innerHTML = INTENTS.filter((it) => it.group === group)
      .map(
        (it) => `
        <label class="intent-card" data-bit="${it.bit}">
          <input type="checkbox" data-bit="${it.bit}">
          <div class="card-top">
            ${tick}
            <span class="card-name">${it.name}</span>
          </div>
          <span class="card-desc">${it.events}</span>
          <div class="card-foot">
            ${it.needsApply ? '<span class="pill req">需申请</span>' : '<span class="pill free">默认可用</span>'}
            <span class="card-grp">${group === 'chat' ? '群聊' : '频道'}</span>
          </div>
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

/** 最后一次「加载 / 应用」的 intents 值。用来判断有没有未应用的改动 */
let intentsApplied = null;

/** 从数值反推勾选状态 */
function setIntents(value) {
  const v = Number(value) || 0;
  intentsApplied = v;
  const unknown = v & ~KNOWN_MASK;

  $$('#intentGroupChat input[type=checkbox], #intentGroupGuild input[type=checkbox]').forEach((cb) => {
    const bit = Number(cb.dataset.bit);
    cb.checked = Boolean(v & (1 << bit));
  });

  // 含未知位（比如官方新加的事件），自动切到高级模式，避免静默丢配置
  const adv = unknown !== 0;
  $('#intentsAdvanced').checked = adv;
  const advRow = $('#intentsAdvRow');
  if (advRow) advRow.hidden = !adv;
  $('#intentsManual').value = v;
  $('#intentsValue').textContent = v;
  renderIntentSummary(v, adv);
  renderIntentsDirty();
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
  /**
   * **不自动保存**：intents 是连接参数，改一次就要重连一次网关。
   * 自动保存会让「连勾五个」变成「重连五次」，机器人反复掉线。
   * 这里只标记未应用，由用户点「应用订阅」统一提交一次。
   */
  renderIntentsDirty();
}

/** 当前表单里的值是否还没应用 */
function intentsDirty() {
  return Number($('#cfgForm').intents.value) !== intentsApplied;
}

function renderIntentsDirty() {
  const dirty = intentsDirty();
  const btn = $('#intentsApply');
  if (btn) btn.disabled = !dirty;
  const st = $('#intentsStatus');
  if (!st) return;
  if (dirty) {
    st.textContent = '有改动未应用（会重连一次）';
    st.style.color = 'var(--warn-text)';
  } else if (st.textContent.startsWith('有改动')) {
    st.textContent = '';
    st.style.color = '';
  }
}

/**
 * 应用订阅（由「应用订阅」按钮触发）。
 *
 * 不做自动保存：intents 是**连接参数**，每次提交都会让网关重连，
 * 连着勾五个就要重连五次。改成先勾完、再点一次按钮只提交一次。
 */
async function applyIntents() {
  const tip = $('#cfgMsgTop');
  const local = $('#intentsStatus');
  const btn = $('#intentsApply');
  const v = Number($('#cfgForm').intents.value) || 0;
  if (btn) btn.disabled = true;
  if (tip) tip.textContent = '正在应用事件订阅（会重连）…';
  if (local) { local.textContent = '正在应用…'; local.style.color = 'var(--muted)'; }
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ intents: v }),
    });
    intentsApplied = v;
    if (tip) {
      tip.textContent = `已生效（intents=${v}），网关正在重连`;
      setTimeout(() => {
        if (tip.textContent.startsWith('已生效')) tip.textContent = '';
      }, 4000);
    }
    if (local) {
      local.textContent = `已生效（${v}），网关重连中`;
      local.style.color = 'var(--ok)';
      setTimeout(() => {
        if (local.textContent.startsWith('已生效')) local.textContent = '';
      }, 6000);
    }
  } catch (e) {
    if (tip) tip.textContent = '应用失败: ' + e.message;
    if (local) { local.textContent = '应用失败：' + e.message; local.style.color = 'var(--err)'; }
    if (btn) btn.disabled = false;
  }
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
  const stat = $('#intentsStat');
  if (stat) {
    stat.innerHTML = `已选 <b>${picked.length}</b> 项`
      + (needsApply.length ? ` · 其中 <b>${needsApply.length}</b> 项需申请` : '');
  }
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

  /**
   * 只用 data-intent-preset：外观页的配色块也叫 data-preset，
   * 早先这里用 `$$('[data-preset]')` 会把它们一起绑上——在外观页点个配色，
   * 就会走到 `map[undefined] ?? []` 把订阅清空并自动保存。
   */
  $$('#tab-config [data-intent-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = {
        chat: [25],
        guild: [0, 30, 1],
        all: INTENTS.map((it) => it.bit),
        none: [],
      };
      const bits = map[btn.dataset.intentPreset] ?? [];
      $('#intentsAdvanced').checked = false;
      const advRow = $('#intentsAdvRow');
      if (advRow) advRow.hidden = true;
      $$('#intentGroupChat input[type=checkbox], #intentGroupGuild input[type=checkbox]').forEach((cb) => {
        cb.checked = bits.includes(Number(cb.dataset.bit));
      });
      updateIntentsValue();
    });
  });

  $('#intentsAdvanced').addEventListener('change', (e) => {
    const on = e.target.checked;
    const advRow = $('#intentsAdvRow');
    if (advRow) advRow.hidden = !on;
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

  $('#intentsApply')?.addEventListener('click', applyIntents);

  $('#intentsManual').addEventListener('input', (e) => {
    const v = Number(e.target.value) || 0;
    $('#intentsValue').textContent = v;
    renderIntentSummary(v, true);
    // 高级模式手填也只是改配置，由「应用订阅」统一生效
    $('#cfgForm').intents.value = v;
    renderIntentsDirty();
  });
}

async function loadConfig() {
  try {
    fillForm(await api('/api/config'));
  } catch (e) {
    $('#cfgMsgTop').textContent = '读取配置失败: ' + e.message;
  }
  refreshInstances();
}

/* ---------------- 实例锁 ---------------- */

/**
 * 拉实例表并渲染。
 *
 * 为什么要有这块 UI：以前 `listInstances()` 定义了但**全仓零引用**。用户看到
 * 「AppID xxx 已有实例在运行（PID 2816）」时，既不知道 2816 是谁、也不知道
 * 上哪查，唯一出路是自己去删 `data/instances.json`——而大多数人不知道有这个文件。
 */
async function refreshInstances() {
  const body = $('#instancesBody');
  if (!body) return;
  let data;
  try {
    data = await api('/api/instances');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" class="empty">读不到实例表：${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  const list = Array.isArray(data?.instances) ? data.instances : [];
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">没有实例记录</td></tr>';
  } else {
    body.innerHTML = list
      .map((it) => {
        // 用内联色值：面板没有现成的状态类，硬造新 class 还得改 style.css
        const state = it.alive
          ? '<span style="color:var(--ok)">在跑</span>'
          : '<span style="color:var(--err)">已退出</span>';
        const self = it.self ? ' <span class="hint">本进程</span>' : '';
        const when = it.at ? new Date(it.at).toLocaleString('zh-CN') : '-';
        // 本进程那条是正在生效的互斥，清掉等于放开同进程双开
        const action = it.self
          ? '<span class="hint">—</span>'
          : `<button class="btn small" data-clear="${escapeHtml(it.appId)}">清理</button>`;
        return `<tr>
          <td class="mono">${escapeHtml(it.appId)}</td>
          <td class="mono">${it.pid || '-'}</td>
          <td>${state}${self}</td>
          <td>${escapeHtml(when)}</td>
          <td>${action}</td>
        </tr>`;
      })
      .join('');
  }
  const foot = $('#instancesFoot');
  if (foot) {
    foot.textContent = data?.file
      ? `记录文件：${data.file}${list.some((x) => !x.alive) ? '（「已退出」的记录可以直接清）' : ''}`
      : '';
  }
}

$('#btnRefreshInstances')?.addEventListener('click', () => refreshInstances());

// 清理按钮走事件委托：行是 innerHTML 拼的，逐行绑事件会在每次刷新后失效
document.addEventListener('click', async (e) => {
  const btn = e.target?.closest?.('[data-clear]');
  if (!btn) return;
  const appId = btn.dataset.clear;
  const ok = await confirmDialog({
    title: '清掉这条实例记录？',
    message: `AppID <b>${escapeHtml(appId)}</b> 的占用记录会被删除。<br><br>
      只有确认那个进程<b>已经不在跑了</b>才能清。如果它其实还活着，清掉之后两个进程会用同一个 AppID 连网关，互相踢下线。`,
    okText: '清掉',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/instances/clear', { method: 'POST', body: JSON.stringify({ appId }) });
    refreshInstances();
  } catch (err) {
    alert('清理失败：' + err.message);
  }
});

/* ---------------- 发图兼容：勾选即生效 ---------------- */

/**
 * 「保存配置」按钮在表单顶部/底部，离这块设置很远，勾完还得滚过去点一下才生效。
 * 这里跟 intents 那块不同：media 是纯配置、改了不影响连接，可以即改即存；
 * 后端 `/api/config` 是合并语义，其它配置项不会被这次请求碰。
 * 不需要防抖——勾一下就是一次，且不会像 intents 那样触发重连。
 */
$('#mediaPlaceholderSpace').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const tip = $('#mediaSpaceMsg');
  if (tip) tip.textContent = '正在应用…';
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ media: { placeholderSpace: on } }),
    });
    if (tip) {
      tip.textContent = on ? '已生效：发图会带空格' : '已生效：恢复干净图';
      setTimeout(() => {
        if (tip.textContent.startsWith('已生效')) tip.textContent = '';
      }, 4000);
    }
  } catch (err) {
    // 没保存成功就把勾选退回去，别让用户以为已经开了
    e.target.checked = !on;
    if (tip) tip.textContent = '应用失败: ' + err.message;
  }
});

/* ---------------- 改动即生效（除连接凭证 / 事件订阅） ---------------- */

/**
 * 这部分设置**不需要保存按钮**：改完就落盘。
 *
 * 为什么不和凭证一起提交：
 *   · 凭证（AppID/Secret/baseUrl/连接方式）改一半就落盘会直接断线，
 *     必须让人确认一次；
 *   · 事件订阅是连接参数，每次提交都要重连，所以单独一个「应用订阅」。
 * 其余都是纯配置，即改即存最省事。
 *
 * 只用 `change` 事件（失焦 / 勾选才触发），不用 `input`：
 * 数字框边打字边存会把 "1520" 存成 "1"、"15"、"152"，端口也能被存坏。
 */
function collectAutoPayload(f) {
  const lines = (v) => v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  return {
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
    groupManage: { invited: f.groupInvited.checked },
    media: { placeholderSpace: f.mediaPlaceholderSpace.checked },
    security: { trust: { enforce: f.trustEnforce.checked } },
  };
}

let autoSaveTimer = null;
function bindAutoSave() {
  const form = $('#cfgForm');
  if (!form) return;

  /**
   * 拦住「回车提交」：凭证区填到一半按回车就会把这半截 AppID 存下去，
   * 而保存凭证还会触发重连。其它字段都是即改即存，回车没有任何理由提交表单。
   */
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio') e.preventDefault();
  });
  const locked = (el) =>
    Boolean(el.closest('[data-cfg="creds"]')) || Boolean(el.closest('.intents-block'));

  form.addEventListener('change', (e) => {
    const el = e.target;
    if (!el?.name || locked(el)) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    // 500ms 合并连点：勾一串开关只存一次
    autoSaveTimer = setTimeout(async () => {
      autoSaveTimer = null;
      try {
        await api('/api/config', { method: 'PUT', body: JSON.stringify(collectAutoPayload(form)) });
        toast('已生效', 'ok');
      } catch (err) {
        toast('保存失败：' + (err?.message || err), 'error');
      }
    }, 500);
  });
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
    /**
     * 事件订阅有独立的「应用订阅」按钮，这里不能拿表单值去提交——
     * 否则「只改凭证」也会把待应用的订阅一起生效并重连。
     */
    intents: intentsApplied ?? Number(f.intents.value),
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
    // 发图兼容：和 groupManage 一样是每台机器人一份，勾选后立即生效
    media: {
      placeholderSpace: f.mediaPlaceholderSpace.checked,
    },
    // 全局设置（config/bot.json），和 webui 一样不写进机器人配置
    security: {
      trust: { enforce: f.trustEnforce.checked },
    },
  };

  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#cfgMsgTop').textContent = '保存中…';
  try {
    const r = await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
    // 后端在填完 AppID / AppSecret 后会把占位名换成官方昵称，这里同步显示
    const renamed = r?.name && r.name !== botById(CURRENT_BOT)?.name;
    // 换连接方式要重启才生效，后端会带 restartRequired + message，原样转达
    $('#cfgMsgTop').textContent = r?.message
      ? r.message
      : (renamed ? `已保存，机器人昵称同步为「${r.name}」` : '已保存') +
        (payload.appId ? '' : '（AppID 为空）');
    f.appSecret.value = '';
    /**
     * 这份表单**包含 intents**，所以保存成功后要把「已应用值」跟上，
     * 否则事件订阅那边会一直挂着「有改动未应用」。
     * 订阅区自己的「应用订阅」按钮仍然保留——只改订阅时才用它。
     */
    intentsApplied = Number(payload.intents) || 0;
    renderIntentsDirty();
    // 扫码换凭证的那条提示到此为止：凭证已落盘，再挂着「点保存设置」就是误导
    resetQr();
    clearCfgDirty();
    setTimeout(() => ($('#cfgMsgTop').textContent = ''), 4000);
    await loadBots();
    pollStatus();
  } catch (err) {
    $('#cfgMsgTop').textContent = '保存失败: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

// 除连接凭证 / 事件订阅外的设置：改动即存
bindAutoSave();

/* ---------------- 通知：SMTP 邮箱配置 ---------------- */

/**
 * 字段与 BetterGI「设置 → 通知」的邮件部分一致。
 * 密码和 AppSecret 一个待遇：不回显、只回 passSet、留空表示不修改、提交后立刻清空。
 */
async function loadNotify() {
  try {
    const c = await api('/api/notify');
    const f = $('#notifyForm');
    f.enabled.checked = Boolean(c.enabled);
    f.host.value = c.host || '';
    f.port.value = c.port ?? 587;
    f.user.value = c.user || '';
    f.pass.value = '';
    f.pass.placeholder = c.passSet ? '已设置，留空则不修改' : '授权码 / 密码';
    f.from.value = c.from || '';
    f.fromName.value = c.fromName || '';
    f.ownerEmail.value = c.ownerEmail || '';
    const now = $('#notifySecurityNow');
    if (now) {
      now.textContent = c.host
        ? ` 当前判定：${c.resolvedSecurity}。`
        : ' 填好服务器和端口后这里会显示实际采用的加密方式。';
    }
  } catch (e) {
    $('#notifyMsg').textContent = '读取配置失败: ' + e.message;
  }
}

$('#notifyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    enabled: f.enabled.checked,
    host: f.host.value.trim(),
    port: Number(f.port.value) || 587,
    user: f.user.value.trim(),
    pass: f.pass.value.trim(), // 空 = 保持原值
    from: f.from.value.trim(),
    fromName: f.fromName.value.trim(),
    ownerEmail: f.ownerEmail.value.trim(),
  };
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  $('#notifyMsg').textContent = '保存中…';
  try {
    await api('/api/notify', { method: 'PUT', body: JSON.stringify(payload) });
    $('#notifyMsg').textContent = '已保存，立即生效（不用重启）';
    await loadNotify();
    setTimeout(() => ($('#notifyMsg').textContent = ''), 4000);
  } catch (err) {
    $('#notifyMsg').textContent = '保存失败: ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#btnNotifyTest').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#notifyTestMsg').textContent = '正在发送…';
  try {
    const r = await api('/api/notify/test', { method: 'POST', body: '{}' });
    $('#notifyTestMsg').textContent = r?.message || '已发送，请查收主人邮箱';
  } catch (err) {
    $('#notifyTestMsg').textContent = '发送失败：' + err.message;
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

  /**
   * 先记住当前停在哪一页，再去删失效的插件面板。
   *
   * 原实现是在函数末尾才读 $('.panel.active')，但那一页可能刚被下面的
   * .panel[data-plugin-page] 清理删掉了 —— 读到 null，「插件卸载后回退概览」
   * 就永远不成立；activateTab() 不跑，syncNav() 也不跑，面包屑还停在旧页名，
   * 内容区则整个空着。这是 HEAD 就有的 bug，不是 2026-11-06 重构引入的。
   */
  const activeId = $('.panel.active')?.id?.replace(/^tab-/, '') ?? '';

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
     * 只给脚本和表单，**不给 allow-same-origin**。
     *
     * 以前这两个都开，注释自己都写着「等于没有隔离」——因为确实没有：
     * 同源意味着插件页能读 parent.document 和 localStorage，而 localStorage
     * 里存着面板访问密钥。于是「装一个插件」就等于「把面板密码交给插件作者」，
     * 而且一个纯 HTML 页面就够了，不需要执行任何后端代码。
     *
     * 现在去掉 allow-same-origin，插件页变成 opaque origin：读不到父页任何
     * 东西，调接口只能靠地址上那把只属于这个页面的令牌（?pt=）。代价是它
     * 不再自动带 Cookie，所以插件页必须用 pt 而不是 key（旧写法仍兼容）。
     */
    frame.setAttribute('sandbox', 'allow-scripts allow-forms');
    /**
     * 地址在「点开的时候」才算，不在这里定死：
     * 页面数据是跟着当前机器人的，切了机器人必须重新拼地址才能拿到对的 bot。
     */
    frame.dataset.key = p.key;
    // 页面令牌：不是面板密钥，只对这一个插件自己的接口有效
    frame.dataset.token = p.token || '';
    /**
     * **不在建标签时设 src。**
     *
     * 上一版是「建好就开始加载，点过去就是现成的」，出发点是好的，但代价是：
     * 打开面板的瞬间把所有插件页一次性拉起来（斗罗后台那种 37KB HTML + 几百行
     * 内联脚本 + 自己再拉数据），几个插件一起抢主线程，第一次打开明显卡。
     *
     * 现在改成空闲预载：`requestIdleCallback` 里补上 src，用户点过去时多半已经好了；
     * 真没载完也不怕——`activateTab` 里本来就有「地址不一致就设上」的兜底。
     * 顺带一个好处：切机器人后未打开过的页面不会拿旧 bot 的地址预载两次。
     */
    idlePreloadPage(frame);
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
  if (activeId.startsWith('page:') && !tabButton(activeId)) activateTab('overview');
}

/**
 * 插件页面 iframe 的地址：带**页面令牌**、当前机器人和主题。
 *
 * 这里刻意不带 accessKey —— iframe 是 opaque origin，插件页一行
 * `location.search` 就能读到地址上的所有参数，带 key 等于把面板密钥
 * 交给插件作者。令牌只对这一个插件的接口有效（服务端 pageTokenAllows 收口），
 * 泄露了也换不到面板权限。
 */
function pluginPageUrl(key, token) {
  const q = new URLSearchParams();
  if (token) q.set('pt', token);
  if (CURRENT_BOT) q.set('bot', CURRENT_BOT);
  // 带上主题，页面里的 CSS 变量就能跟着面板切换，插件作者不用自己适配
  q.set('theme', document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const s = q.toString();
  return `/api/pages/${encodeURIComponent(key)}/html${s ? `?${s}` : ''}`;
}

/**
 * 空闲时预载一个插件页。
 *
 * 为什么不是立刻设 src：打开面板那一瞬间所有插件页一起加载，会跟首屏的
 * 状态、插件列表抢主线程和连接，表现为「第一次打开卡一下」。
 * 放到空闲时段做，用户点过去时基本已经好了；`activateTab` 另有兜底。
 */
function idlePreloadPage(frame) {
  const run = () => {
    // 已经加载过（点开过 / 别处设过）就别打断它
    if (!frame.isConnected || frame.getAttribute('src') || !frame.dataset.key) return;
    frame.src = pluginPageUrl(frame.dataset.key, frame.dataset.token);
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 4000 });
  } else {
    // Safari 到现在还不支持 requestIdleCallback，退化成「等首屏忙完」
    setTimeout(run, 1500);
  }
}

/**
 * 跟着进程重启自动换令牌。
 *
 * 页面令牌只存在服务端内存里，进程重启就全部重新生成。而面板页如果是在重启
 * **之前**打开的，iframe 里还挂着旧令牌，插件页的所有请求都会被判成跨站
 * （403），表现为「数据空白」或者直接 `Failed to fetch` —— 用户完全看不出
 * 是重启导致的，只会觉得面板坏了。
 *
 * 这里定期问一次页面列表：令牌变了就更新 iframe 的地址并重载它。
 * 只在令牌真的变化时才重载（也就是重启过），平时不会打断用户操作。
 */
async function refreshPageTokens() {
  let list = null;
  try {
    list = await api('/api/pages');
  } catch {
    return 0;
  }
  if (!Array.isArray(list)) return 0;

  let reloaded = 0;
  for (const p of list) {
    for (const f of $$('.plugin-page')) {
      if (f.dataset.key !== p.key) continue;
      if (f.dataset.token === (p.token || '')) continue;
      f.dataset.token = p.token || '';
      // 只重载已经打开过的（没加载过的不去碰，免得白跑一次请求）
      if (f.getAttribute('src')) {
        f.src = pluginPageUrl(f.dataset.key, f.dataset.token);
        reloaded += 1;
      }
    }
  }
  return reloaded;
}

// 15 秒足够快，又不会给面板添负担；令牌不变时这里什么都不做
setInterval(() => {
  refreshPageTokens();
}, 15000);

/**
 * 切回面板时立刻补一次。
 *
 * 两个真实场景：
 *   1. 浏览器会把后台标签页的定时器降频（Chrome 最长到 1 分钟一次），
 *      所以「去改个配置再切回来」最容易撞上旧令牌
 *   2. 保存配置会触发 config-watch 热加载，插件被卸载重载 → 页面令牌
 *      跟着重新生成 → 已打开的 iframe 立刻变无效
 * 回来这一下立刻修，比等定时器体感好得多。
 */
window.addEventListener('focus', () => {
  refreshPageTokens();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshPageTokens();
});

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
  if (!items?.length) return `<div class="empty">暂无数据${emptyAction('去检查配置', 'go-config')}</div>`;
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

/** 插件卡片上的声明摘要：命令/工具/钩子数量 + 版本要求 */
function renderDecl(p) {
  const pr = p.provides || {};
  const bits = [];
  if (pr.commands?.length) bits.push(`命令 ${pr.commands.length}`);
  if (pr.tools?.length) bits.push(`工具 ${pr.tools.length}`);
  if (pr.hooks?.length) bits.push(`钩子 ${pr.hooks.length}`);
  const eng = Object.entries(p.engines || {});
  if (!bits.length && !eng.length) return '';
  const detail = [
    pr.commands?.length ? `命令：${pr.commands.join('、')}` : '',
    pr.tools?.length ? `工具：${pr.tools.join('、')}` : '',
    pr.hooks?.length ? `钩子：${pr.hooks.join('、')}` : '',
  ].filter(Boolean).join('；');
  const engText = eng.map(([k, v]) => `${k} ${v}`).join(' / ');
  return [
    bits.length
      ? `<span class="hint" title="${escapeHtml(detail)}">声明 ${escapeHtml(bits.join(' · '))}</span>`
      : '',
    eng.length
      ? `<span class="hint" title="插件声明的版本要求">${p.enginesOk === false ? '⚠ ' : ''}需 ${escapeHtml(engText)}</span>`
      : '',
  ].join('');
}

/**
 * 顶部「N 个插件有新版本」提示。
 *
 * 单独抽出来：更新检查是**异步补进来**的，画列表的时候还不知道结果。
 */
function renderUpdateTip(upd) {
  const tip = $('#pluginUpdateTip');
  if (!tip) return;
  const n = (upd.updates || []).length;
  tip.innerHTML = n
    ? `<b>${n} 个插件有新版本</b>，去「插件市场」一键更新。` +
      `<a href="javascript:void(0)" id="lnkUpdateAll">全部更新</a>`
    : '';
  const lnk = $('#lnkUpdateAll');
  if (lnk) lnk.addEventListener('click', () => updateAllFromMarket());
}

/**
 * 把「可更新」标记补到**已经画好的**卡片上——不重建卡片。
 *
 * 整块重绘会丢滚动位置、把用户正在点的按钮弄没（`refreshPluginDashboards` 同一个教训）。
 * 而更新检查要走市场索引（秒级），列表是毫秒级的，所以两件事必须分开。
 *
 * 反方向也要处理：结果里**没有**的插件说明它已经是最新，旧标记和「更新」按钮要摘掉，
 * 否则更新完还一直挂着「可更新 4.4.6」，看着像没成功。
 */
function applyUpdateMarks(upd) {
  // 先刷顶部提示：列表可能是空的（插件全卸载了），提示也得跟着清掉
  renderUpdateTip(upd);

  const wrap = $('#pluginList');
  if (!wrap || !wrap.querySelector('.plugin')) return;

  const map = new Map((upd.updates || []).map((u) => [u.id, u]));

  for (const card of wrap.querySelectorAll('.plugin')) {
    const id = card.dataset.id;
    const u = map.get(id);
    const oldBtn = card.querySelector('[data-update-one]');

    if (!u) {
      card.querySelector('.upd-tag')?.remove();
      oldBtn?.remove();
      continue;
    }

    if (oldBtn) {
      // 已经有按钮了：只同步版本号，别重建（按钮上可能正显示「更新中…」）
      oldBtn.dataset.from = u.current;
      oldBtn.dataset.to = u.latest;
      if (u.name) oldBtn.dataset.name = u.name;
      continue;
    }

    const name = card.querySelector('.name');
    if (name && !name.querySelector('.upd-tag')) {
      const tag = document.createElement('span');
      tag.className = 'upd-tag';
      tag.textContent = `可更新 ${u.latest}`;
      name.appendChild(tag);
    }

    // 按钮插在状态徽章后面，和整块重绘时的位置一致
    const badge = card.querySelector('.badge');
    if (!badge) continue;
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.dataset.updateOne = id;
    btn.dataset.from = u.current;
    btn.dataset.to = u.latest;
    btn.dataset.name = u.name || id;
    btn.textContent = '更新';
    btn.addEventListener('click', () => updateFromMarket(id, btn));
    badge.insertAdjacentElement('afterend', btn);
  }
}

async function loadPlugins() {
  const wrap = $('#pluginList');
  // 插件装了/卸了，它注册的面板页面也会变，顺带刷一下标签栏
  loadPluginPages();
  try {
    /**
     * 只等「列表 + 运行数据」——都是毫秒级。
     *
     * 「有没有新版」以前也塞在同一个 `Promise.all` 里，于是整页要陪它等一次市场索引
     * （国内直连 GitHub 常要 8~11 秒才失败切镜像），表现就是进插件页后整块空白。
     * 现在拆成两趟：这里先把卡片画出来，更新标记由 `applyUpdateMarks` 异步补。
     */
    const [list, dash] = await Promise.all([
      api('/api/plugins'),
      api('/api/plugins/dashboard').catch(() => ({})),
    ]);
    /**
     * 首屏一律按「没有新版」画：卡片上不会出现「可更新」和「更新」按钮，
     * 都由第二趟的 applyUpdateMarks 补。这样不会先画错再改，闪一下。
     */
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">还没有插件，把文件夹放进 plugins/ 即可</div>';
      // 没有插件就不可能有更新，顺手把上次留下的「N 个有新版本」清掉
      renderUpdateTip({ updates: [] });
      return;
    }
    wrap.innerHTML = list.map((p) => {
      // 插件自己上报的指标，卡片上最多露 3 个，详情在「设置 → 运行数据」
      const d = dash[p.id];
      const chips = renderDashChips(d?.metrics);

      return `
      <div class="plugin" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name || p.id)}">
        <div class="info">
          <div class="name">${
            p.icon
              ? `<img class="plugin-icon" src="${escapeHtml(p.icon)}" alt="" loading="lazy">`
              : ''
          }${escapeHtml(p.name || p.id)} <span class="hint">v${escapeHtml(p.version || '0.0.0')}</span>
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
            ${renderDecl(p)}
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
          ${
            (p.runtimeErrors && p.runtimeErrors.length)
              ? `<div class="err"><div>运行期错误（最近 ${p.runtimeErrors.length} 条，插件加载成功但每轮抛错）：</div>
                  ${p.runtimeErrors.slice().reverse().map((e) =>
                    `<details class="err-stack"><summary>${escapeHtml(
                      new Date(e.at).toLocaleString('zh-CN'),
                    )} · ${escapeHtml(e.message)}</summary><pre>${escapeHtml(e.stack || '')}</pre></details>`,
                  ).join('')}</div>`
              : ''
          }
          ${p.menuMissing ? '<div class="err">未提供指令菜单，用户看不到它能做什么</div>' : ''}
        </div>
        <span class="badge ${p.loaded ? 'on' : p.enabled ? '' : 'off'}">
          ${p.loaded ? '运行中' : p.enabled ? '未加载' : '已禁用'}
        </span>
        <button class="btn small" data-act="${p.enabled ? 'disable' : 'enable'}">
          ${p.enabled ? '禁用' : '启用'}
        </button>
        <button class="btn small" data-act="reload">重载</button>
        <button class="btn small" data-act="panel">设置</button>
        <button class="btn small danger" data-act="remove" title="删除插件代码，数据保留">卸载</button>
      </div>`;
    }).join('');

    // 顶部「N 个有新版本」提示和卡片上的「更新」按钮由 applyUpdateMarks 补，见下

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

    // 卡片上的「更新」按钮不再在这里批量绑：它由 applyUpdateMarks 创建并自带监听
  } catch (e) {
    wrap.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
  }

  /**
   * 第二趟：更新检查（可能要走市场索引，秒级）。
   *
   * 刻意不 await —— 列表已经画出来了，没必要让调用方（比如更新完成后的刷新）干等。
   * 失败就**保持现状**：不能因为一次网络抖动，把已经显示的「可更新」标记全摘掉。
   *
   * 那句「正在检查」是有必要的：冷启动第一次要真连一次市场索引，国内线路
   * 会先直连 GitHub、十几秒失败后才切镜像。这段时间里卡片上没有任何标记，
   * 看着和「全部是最新版」一模一样——那是**错的结论**，得让用户知道还在查。
   * 延迟 800ms 才显示，是因为命中缓存时只要几毫秒，闪一下反而更吵。
   */
  const PENDING_TIP = '正在检查插件更新…';
  const pendingTip = setTimeout(() => {
    const tip = $('#pluginUpdateTip');
    if (tip && !tip.textContent.trim()) tip.innerHTML = `<span class="hint">${PENDING_TIP}</span>`;
  }, 800);

  api('/api/plugins/updates')
    .then((upd) => applyUpdateMarks(upd))
    .catch(() => {
      // 查不到就把「正在检查」收掉，别让它永远挂着
      const tip = $('#pluginUpdateTip');
      if (tip && tip.textContent.trim() === PENDING_TIP) tip.innerHTML = '';
    })
    .finally(() => clearTimeout(pendingTip));
}

/* ---------------- 事件账本 ---------------- */

const LEDGER_KIND = { group: '群', c2c: '私聊', guild: '频道', dm: '私信' };
/** 当前展开的会话；`cursor` 是上一页最早那条的 seq（账本 recent 返回正序） */
let ledgerView = { chatId: '', cursor: 0 };

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function fmtWhen(ts) {
  if (!ts) return '-';
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false });
}

/** 列表里用的短格式：年份对「刚才/上周」没意义，省下来的宽度给正文 */
function fmtShort(ts) {
  if (!ts) return '-';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadLedger() {
  const body = $('#ledgerChats');
  if (!body) return;
  try {
    const st = await api('/api/ledger/stats');
    renderLedgerStats(st);
    renderLedgerChats(st);
    syncLedgerRetention(st?.retentionDays);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderLedgerStats(st) {
  const el = $('#ledgerStats');
  if (!el) return;
  const days = Number(st?.retentionDays);
  const cards = [
    ['记录条数', Number(st?.total ?? 0)],
    ['占用', fmtBytes(st?.bytes)],
    ['保留', days === 0 ? '永久' : `${days} 天`],
  ];
  /**
   * 时间范围用**短格式**：`2026/11/1 01:23:57 → 2026/11/4 21:13:33` 比卡片宽一倍，
   * 会直接溢出到框外（截图实测）。年份在「最近」这个语境里没有信息量，
   * 省下来的宽度正好放进一张卡。
   */
  const range = st?.oldestAt
    ? `${fmtShort(st.oldestAt)}<br>→ ${fmtShort(st.newestAt)}`
    : '还没有记录';
  el.innerHTML = cards
    .map(([k, v]) => `<div class="card"><div class="k">${k}</div><div class="v">${escapeHtml(String(v))}</div></div>`)
    .join('') + `<div class="card"><div class="k">时间范围</div><div class="v lg-range-v">${range}</div></div>`;
}

function renderLedgerChats(st) {
  const body = $('#ledgerChats');
  if (!body) return;
  const list = st?.byChat ?? [];
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">账本里还没有记录（或者账本关着）</td></tr>';
    return;
  }
  body.innerHTML = list
    .map((c) => {
      const id = String(c.chatId ?? '');
      const short = id.length > 14 ? `${id.slice(0, 14)}…` : id;
      /**
       * 群会话优先显示群名（后端 `/api/ledger/stats` 补过一次，没补到就是空串）。
       * 没有再退回 openid 短码——短码虽然难认，但至少能区分是哪一行。
       * 群名不加 `mono`：那是给人读的，等宽字反而更难扫。
       */
      const name = String(c.name ?? '').trim();
      return `<tr>
        <td class="lg-chat${name ? '' : ' mono'}" title="${escapeHtml(name ? `${name} · ${id}` : id)}">${escapeHtml(name || short)}</td>
        <td class="lg-kind">${escapeHtml(LEDGER_KIND[c.kind] ?? c.kind ?? '')}</td>
        <td class="num lg-num">${Number(c.rows ?? 0)}</td>
        <td class="lg-range">${escapeHtml(fmtShort(c.oldestAt))} → ${escapeHtml(fmtShort(c.newestAt))}</td>
        <td class="lg-ops">
          <button class="btn small" data-ledger-open="${escapeHtml(id)}" data-ledger-name="${escapeHtml(name)}">查看</button>
          <button class="btn small danger" data-ledger-del="${escapeHtml(id)}">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

function syncLedgerRetention(days) {
  const sel = $('#ledgerRetention');
  const input = $('#ledgerRetentionDays');
  if (!sel || !input) return;
  const d = Number(days);
  const known = ['0', '7', '30'];
  if (known.includes(String(d))) {
    sel.value = String(d);
    input.style.display = 'none';
  } else {
    sel.value = 'custom';
    input.style.display = '';
    input.value = String(d);
  }
}

async function openLedgerChat(chatId, name = '') {
  ledgerView = { chatId, cursor: 0 };
  const box = $('#ledgerRowsBox');
  if (box) box.hidden = false;
  const t = $('#ledgerRowsTitle');
  /** 有群名就写群名（加短码备查），没有就只写短码 */
  if (t) {
    const short = String(chatId).slice(0, 14);
    const label = String(name ?? '').trim();
    t.textContent = label ? `记录 · ${label}（${short}…）` : `记录 · ${short}`;
  }
  const body = $('#ledgerRows');
  if (body) body.innerHTML = '<tr><td colspan="3" class="empty">加载中…</td></tr>';
  await loadLedgerRows(true);
}

async function loadLedgerRows(reset) {
  const body = $('#ledgerRows');
  const chatId = ledgerView.chatId;
  if (!body || !chatId) return;
  try {
    const q = new URLSearchParams({ chatId, limit: '50' });
    if (!reset && ledgerView.cursor) q.set('beforeSeq', String(ledgerView.cursor));
    const d = await api(`/api/ledger?${q.toString()}`);
    const items = d?.items ?? [];
    if (reset) body.innerHTML = '';
    if (!items.length && reset) {
      body.innerHTML = '<tr><td colspan="3" class="empty">这个会话没有记录</td></tr>';
      const more = $('#ledgerMore');
      if (more) more.disabled = true;
      return;
    }
    body.insertAdjacentHTML(
      'afterbegin',
      items
        .map((x) => {
          /**
           * 出站行没有 user_name，直接在「谁」列显示发出它的插件：
           * 插件 → 插件名；框架内建（`__core`，菜单等）→ 机器人实例名（默认 main）。
           * 原来那个独立的 `[plugin]` 标记撤掉，否则同一行会重复两遍。
           * 入站的 `userName || userId` 兜底保持不变。
           */
          const actor = x.plugin && x.plugin !== '__core' ? x.plugin : (x.botId || 'main');
          const who = x.userName || x.userId || actor;
          /**
           * 发言人：群名片优先（`userName` 现在就是群内昵称），QQ 昵称放第二行。
           *
           * 两个名字一样就只留一行——不然每行都重复一遍，反而更难扫。
           * 头像用缩略图（`s=640` 换成 `s=100`），一页 50 条不然要拖几百 KB。
           * openid / QQ 号**不进界面文字**，只放 `data-*`：调试和复制要用，
           * 但账本列表是给人扫的，塞两串长 id 只会把内容挤没。
           */
          const nick = String(x.nickname ?? '').trim();
          const card = String(x.card ?? '').trim();
          const name = String(x.userName ?? '').trim() || card || nick || who;
          const sub = nick && nick !== name ? nick : '';
          const av = ledgerAvatar(x.avatar);
          return `<tr data-openid="${escapeHtml(String(x.openid ?? x.userId ?? ''))}" data-uin="${escapeHtml(String(x.uin ?? ''))}">
            <td class="lg-when">${escapeHtml(fmtWhen(x.at))}</td>
            <td class="lg-who" title="${escapeHtml(name)}">${av
            ? `<img class="who-av lg-av" src="${escapeHtml(av)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
            : ''}<span class="lg-name">${escapeHtml(name)}</span>${sub
            ? `<span class="sub lg-sub">${escapeHtml(sub)}</span>`
            : ''}</td>
            <td class="lg-content">${escapeHtml(String(x.content ?? '').slice(0, 200))}</td>
          </tr>`;
        })
        .join(''),
    );
    /** 账本返回的是**正序**（老的在前），所以「更早的一页」的游标是第一条的 seq */
    ledgerView.cursor = items.length ? Number(items[0].seq) : 0;
    const more = $('#ledgerMore');
    if (more) more.disabled = items.length < 50;
  } catch (e) {
    body.innerHTML = `<tr><td colspan="3" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

/**
 * 删除：先 dryRun 数一遍，让用户**输入那个数字**再真删。
 *
 * 为什么用 `prompt` 而不是 `confirmDialog`：这里要的不是「确定/取消」，
 * 而是「把条数打出来」。只点两下的删除对不可逆操作太轻了。
 */
async function ledgerDelete(cond) {
  try {
    const pre = await api('/api/ledger/delete', {
      method: 'POST',
      body: JSON.stringify({ ...cond, dryRun: true }),
    });
    const count = Number(pre?.count ?? 0);
    if (!count) return alert('这个条件下没有可删的记录');
    const typed = window.prompt(
      `将删除 ${count} 条记录，不可恢复。\n请输入 ${count} 确认：`,
      '',
    );
    if (typed === null) return;
    if (Number(typed) !== count) return alert('数字对不上，已取消');
    const r = await api('/api/ledger/delete', {
      method: 'POST',
      body: JSON.stringify({ ...cond, confirm: count }),
    });
    alert(r?.message || `删了 ${r?.removed ?? 0} 条`);
    await loadLedger();
    if (ledgerView.chatId) await loadLedgerRows(true);
  } catch (e) {
    alert(`删除失败: ${e.message}`);
  }
}

$('#ledgerChats')?.addEventListener('click', (e) => {
  const open = e.target.closest('[data-ledger-open]');
  if (open) {
    return openLedgerChat(open.getAttribute('data-ledger-open'), open.getAttribute('data-ledger-name') || '');
  }
  const del = e.target.closest('[data-ledger-del]');
  if (del) return ledgerDelete({ chatId: del.getAttribute('data-ledger-del') });
});

$('#ledgerMore')?.addEventListener('click', () => loadLedgerRows(false));

$('#ledgerDelChat')?.addEventListener('click', () => {
  if (!ledgerView.chatId) return;
  return ledgerDelete({ chatId: ledgerView.chatId });
});

$('#ledgerRetention')?.addEventListener('change', (e) => {
  const input = $('#ledgerRetentionDays');
  if (!input) return;
  const custom = e.target.value === 'custom';
  input.style.display = custom ? '' : 'none';
  if (custom) input.focus();
});

$('#ledgerRetentionSave')?.addEventListener('click', async () => {
  const sel = $('#ledgerRetention');
  const input = $('#ledgerRetentionDays');
  const raw = sel?.value === 'custom' ? Number(input?.value) : Number(sel?.value);
  if (!Number.isInteger(raw) || raw < 0 || raw > 36500) return alert('天数要在 0–36500 之间（0 = 永久）');
  try {
    await api('/api/ledger/retention', { method: 'PUT', body: JSON.stringify({ days: raw }) });
    alert(raw === 0 ? '已改成永久保留' : `已改成保留 ${raw} 天，超出部分会在下次清理时删掉`);
    await loadLedger();
  } catch (e) {
    alert(`保存失败: ${e.message}`);
  }
});

$('#ledgerVacuum')?.addEventListener('click', async () => {
  try {
    const r = await api('/api/ledger/vacuum', { method: 'POST', body: '{}' });
    alert(r?.message || '已排队');
  } catch (e) {
    alert(`压缩失败: ${e.message}`);
  }
});

/** 换 openid：先预览条数，再要用户输入那个数——改历史数据比删更难挽回 */
$('#ledgerRemapGo')?.addEventListener('click', async () => {
  const from = String($('#ledgerRemapFrom')?.value ?? '').trim();
  const to = String($('#ledgerRemapTo')?.value ?? '').trim();
  const scope = $('#ledgerRemapScope')?.value ?? 'both';
  if (!from || !to) return alert('旧 openid 和新 openid 都要填');
  if (from === to) return alert('新旧是同一个，不用改');
  try {
    const pre = await api('/api/ledger/remap', {
      method: 'POST',
      body: JSON.stringify({ from, to, scope, dryRun: true }),
    });
    const total = Number(pre?.total ?? 0);
    if (!total) return alert('这个 openid 下没有记录');
    const typed = window.prompt(
      `将改动 ${total} 条（会话 ${pre.chat} / 发送者 ${pre.user}），改完不可自动还原。\n请输入 ${total} 确认：`,
      '',
    );
    if (typed === null) return;
    if (Number(typed) !== total) return alert('数字对不上，已取消');
    const r = await api('/api/ledger/remap', {
      method: 'POST',
      body: JSON.stringify({ from, to, scope, confirm: total }),
    });
    alert(r?.message || '已改完');
    await loadLedger();
  } catch (e) {
    alert(`改失败: ${e.message}`);
  }
});

$('#ledgerExport')?.addEventListener('click', () => {
  const q = ledgerView.chatId ? `?chatId=${encodeURIComponent(ledgerView.chatId)}` : '';
  window.location.href = `/api/ledger/export${q}`;
});

/** JSONL 才是「导回」用的格式：一行一条，正文里的换行不用转义 */
$('#ledgerExportJson')?.addEventListener('click', () => {
  const p = new URLSearchParams({ format: 'jsonl' });
  if (ledgerView.chatId) p.set('chatId', ledgerView.chatId);
  window.location.href = `/api/ledger/export?${p.toString()}`;
});

$('#ledgerImport')?.addEventListener('click', () => $('#ledgerImportFile')?.click());

$('#ledgerImportFile')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!rows.length) {
      return alert('文件里没有可识别的记录。要的是「导出 JSON」那种一行一条的格式。');
    }
    if (!window.confirm(`将导入 ${rows.length} 行。重复的会自动跳过，继续？`)) return;
    const r = await api('/api/ledger/import', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });
    alert(r?.message || '导入完成');
    await loadLedger();
    if (ledgerView.chatId) await loadLedgerRows(true);
  } catch (err) {
    alert(`导入失败: ${err.message}`);
  } finally {
    /** 清掉，否则同一个文件选第二次不会触发 change */
    e.target.value = '';
  }
});

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
 * 「外接」页依赖卡的安装源下拉补过值没有。
 *
 * `loadMirrorBar()` 只在「插件」页跑，所以那张卡的下拉第一次显示时可能
 * 还停在 HTML 默认值上。补一次就够，之后不能反复覆盖——用户可能正在选。
 */
let NPM_CARD_BACKFILLED = false;

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
    syncProxy();
    syncNpmRegistry();
    const preset = (d.presets || []).find((p) => p.id === d.current?.id);
    $('#mirrorTip').textContent = preset?.note ?? '';
  } catch {
    sel.innerHTML = '<option value="auto">自动</option>';
  }
}

/**
 * npm 源的几组控件。
 *
 * 同一个配置有两个入口：「插件」页的下载源那一行，和「外接」页的依赖卡片
 * ——后者才是用户装不上时待着的地方，不该逼他切页去找开关。
 * 两边显示同一个值、写同一份配置，所以统一在这里遍历，别各写一套。
 */
function npmRegistryEls() {
  return [
    { sel: $('#npmRegistrySelect'), inp: $('#npmRegistryCustom') },
    { sel: $('#onebotNpmRegistry'), inp: $('#onebotNpmRegistryCustom') },
  ].filter((p) => p.sel);
}

/**
 * npm 源那一行。
 *
 * 和「下载源」分开：那个改的是 GitHub 地址，这个改的是 npm registry——
 * 装插件依赖 / 外接依赖走的是后者。留空表示「跟随系统」，
 * 也就是不覆盖用户自己 `npm config set` 过的值。
 *
 * @param {{id?: string, custom?: string}} [cur] 要显示的选择，默认取已加载的配置
 */
function syncNpmRegistry(cur = MIRRORS?.npmRegistry ?? {}) {
  const id = String(cur.id ?? 'official');
  /** 官方源 = 跟随系统（留空），这样用户清掉选择后还能吃到自己的 .npmrc */
  const value = id === 'npmmirror' ? 'npmmirror' : id === 'custom' ? 'custom' : '';

  for (const { sel, inp } of npmRegistryEls()) {
    sel.value = value;
    if (!inp) continue;
    inp.hidden = value !== 'custom';
    if (value === 'custom') inp.value = cur.custom ?? '';
  }
}

/**
 * 从接口给的「实际生效的源」倒推下拉该选哪一项。
 *
 * `deps.registry` 是 `{url, source}`（真会走的地址 + 它是从哪来的），
 * 下拉要的是 `{id, custom}`。只有 `source === 'config'` 才说明用户真在面板里
 * 选过——环境变量 / `.npmrc` 生效时下拉就该显示「跟随系统」，那正是它的语义。
 */
function npmChoiceFromRegistry(reg) {
  if (reg?.source !== 'config') return { id: 'official', custom: '' };
  const hit = (reg.presets ?? []).find((x) => x.url && x.url === reg.url);
  if (hit && hit.id !== 'custom') return { id: hit.id, custom: '' };
  return { id: 'custom', custom: reg.url ?? '' };
}

/**
 * 只存 npm 源这一个字段。
 *
 * 不借道 `saveMirror()`：那个会把下载源 / 自定义前缀 / Gitee 令牌整包发一遍，
 * 而「外接」页的依赖卡完全可能在「插件」页从没打开过的情况下被用——
 * 那时那几个下拉还是空的，整包发上去就是拿空值覆盖用户已有设置
 * （Gitee 令牌被清掉最要命，且不会报错）。
 * 服务端现在对「没传的字段」保留原值，所以只发这一个字段是安全的。
 *
 * @param {string} value `''` / `'official'` / `'npmmirror'` / 完整 URL
 * @param {HTMLElement} [fromEl] 触发的那组控件，用来决定把错误显示在哪儿
 */
async function saveNpmRegistry(value, fromEl) {
  const inCard = String(fromEl?.id ?? '').startsWith('onebot');
  try {
    const r = await api('/api/mirror', {
      method: 'PUT',
      body: JSON.stringify({ npmRegistry: value }),
    });
    MIRRORS = { ...(MIRRORS ?? {}), npmRegistry: r.npmRegistry };
    syncNpmRegistry();
    /** 依赖卡里那一行「安装源：…」是渲染出来的，得重读一次才跟得上 */
    if (inCard) await loadOnebot();
  } catch (e) {
    const out = inCard ? $('#onebotDepsCheck') : $('#mirrorTip');
    if (out) {
      out.hidden = false;
      out.textContent = `切换安装源失败：${e.message}`;
    }
  }
}

/**
 * 接上一组 npm 源控件：改一边，另一边跟着变，然后统一走 `saveNpmRegistry()`。
 *
 * 镜像只是让两处显示一致，不参与保存——保存只看用户刚动的那一个。
 */
function bindNpmRegistry(selId, inpId) {
  const sel = $(`#${selId}`);
  const inp = $(`#${inpId}`);
  if (!sel) return;

  const other = () => npmRegistryEls().find((p) => p.sel !== sel);

  sel.addEventListener('change', () => {
    if (inp) inp.hidden = sel.value !== 'custom';
    const o = other();
    if (o) {
      o.sel.value = sel.value;
      if (o.inp) {
        o.inp.hidden = sel.value !== 'custom';
        if (sel.value === 'custom' && inp?.value) o.inp.value = inp.value;
      }
    }
    /** 选「自定义」时地址还空着，后端会（正确地）拒绝——等填完再保存 */
    if (sel.value !== 'custom') saveNpmRegistry(sel.value, sel);
  });

  inp?.addEventListener('change', () => {
    const o = other();
    if (o?.inp && o.sel.value === 'custom') o.inp.value = inp.value;
    saveNpmRegistry(inp.value.trim(), sel);
  });
}

/**
 * 代理栏：`auto` / `off` 是开关，其它值是具体地址。
 *
 * 选「手动填写」时才露输入框；**不要**在切到手动时立刻保存——那时地址还是空的，
 * 后端会（正确地）拒绝。等用户填完再提交。
 */
function syncProxy() {
  const sel = $('#proxySelect');
  const inp = $('#proxyCustom');
  const tip = $('#proxyTip');
  if (!sel) return;

  const setting = String(MIRRORS?.proxy?.setting ?? 'auto');
  const isUrl = setting !== 'auto' && setting !== 'off';
  sel.value = isUrl ? 'custom' : setting;
  if (inp) {
    inp.hidden = !isUrl;
    if (isUrl) inp.value = setting;
  }

  if (tip) {
    const p = MIRRORS?.proxy;
    if (isUrl) {
      tip.textContent = `当前：${setting}（手动）`;
    } else if (p?.active) {
      const from = { system: '系统设置', env: '环境变量' }[p.source] ?? p.source;
      tip.textContent = `当前：${p.active}（${from}）`;
    } else {
      tip.textContent = '当前：直连';
    }
  }
}

/** 选了「自定义前缀」才显示前缀框，选了「Gitee」才显示令牌框 */
function syncMirrorCustom() {
  const sel = $('#mirrorSelect');
  const inp = $('#mirrorCustom');
  const tok = $('#mirrorGiteeToken');
  if (!sel) return;
  if (inp) {
    inp.hidden = sel.value !== 'custom';
    if (!inp.hidden && !inp.value) inp.value = MIRRORS?.current?.custom ?? '';
  }
  if (tok) {
    tok.hidden = sel.value !== 'gitee';
    if (!tok.hidden && !tok.value) tok.value = MIRRORS?.current?.giteeToken ?? '';
  }
}

async function saveMirror() {
  const sel = $('#mirrorSelect');
  const inp = $('#mirrorCustom');
  const tok = $('#mirrorGiteeToken');
  const psel = $('#proxySelect');
  const pinp = $('#proxyCustom');
  const tip = $('#mirrorTip');
  if (!sel) return;

  // 「手动填写」时取输入框，其余取下拉值（auto / off）
  const proxy = psel?.value === 'custom' ? (pinp?.value ?? '').trim() : (psel?.value ?? 'auto');

  /** npm 源：选「自定义」时取输入框，其余取下拉值（空 = 跟随系统） */
  const nsel = $('#npmRegistrySelect');
  const ninp = $('#npmRegistryCustom');
  const npmRegistry = nsel?.value === 'custom' ? (ninp?.value ?? '').trim() : (nsel?.value ?? '');

  try {
    const r = await api('/api/mirror', {
      method: 'PUT',
      body: JSON.stringify({
        mirror: sel.value,
        mirrorCustom: inp?.value ?? '',
        giteeToken: tok?.value ?? '',
        proxy,
        npmRegistry,
      }),
    });
    MIRRORS = { ...(MIRRORS ?? {}), current: r.current, proxy: r.proxy, npmRegistry: r.npmRegistry };
    syncProxy();
    syncNpmRegistry();
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
  buildCatChips();
}

/**
 * 分类计数 chip。
 * 下拉换成 chip 是为了让「哪个分类有内容、有几个」一眼可见——几十条插件时
 * 下拉里翻一遍才知道有没有东西。下拉本身保留，键盘和窄屏仍用它。
 */
function buildCatChips() {
  const sel = $('#marketCat');
  const filter = sel?.closest('.market-filter');
  if (!filter) return;
  let box = $('#catChips');
  if (!box) {
    box = document.createElement('div');
    box.id = 'catChips';
    box.className = 'cat-chips';
    filter.insertAdjacentElement('afterend', box);
  }
  const counts = new Map();
  for (const p of MARKET.all) {
    for (const t of new Set([...(p.tags || []), p.category].filter(Boolean))) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  // 条目多的排前面，同样多按名字排，避免每次刷新顺序乱跳
  const order = [...counts.keys()].sort(
    (a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'zh')
  );
  const chips = [
    `<button type="button" class="cat-chip${MARKET.tag ? '' : ' on'}" data-cat="">全部 <b>${MARKET.all.length}</b></button>`,
    ...order.map(
      (t) =>
        `<button type="button" class="cat-chip${MARKET.tag === t ? ' on' : ''}" data-cat="${escapeHtml(t)}">${escapeHtml(t)} <b>${counts.get(t)}</b></button>`
    ),
  ];
  box.innerHTML = chips.join('');
}

/** 只改高亮，不重建——重建会让横向滚动的 chip 条跳回开头 */
function syncCatChips() {
  $$('#catChips .cat-chip').forEach((c) => {
    c.classList.toggle('on', (c.dataset.cat || '') === (MARKET.tag || ''));
  });
}

function renderMarketRows() {
  const list = $('#marketList');
  const upd = MARKET.upd;
  const shown = MARKET.all.filter(matchMarket);
  syncCatChips();

  if (!shown.length) {
    list.innerHTML = `<div class="empty">没有匹配的插件${
      MARKET.q || MARKET.tag ? '，换个关键词或分类试试' : ''
    }${MARKET.q || MARKET.tag ? emptyAction('清除筛选', 'clear-market') : ''}</div>`;
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
            ${verifyTag(p)}
            ${p.author ? `<span class="hint">by ${escapeHtml(p.author)}</span>` : ''}
            ${p.credits ? `<span class="hint">${escapeHtml(p.credits)}</span>` : ''}
            ${p.description ? '<br>' + escapeHtml(p.description) : ''}
            ${(p.tags || []).length ? '<br><span class="hint">' + p.tags.map(escapeHtml).join(' / ') + '</span>' : ''}
            ${u ? `<br><span class="hint">本地版本 v${escapeHtml(u.current)}</span>` : ''}
          </div>
        </div>
        ${
          u
            ? `<button class="btn small primary" data-update="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name || p.id)}" data-from="${escapeHtml(u.current)}" data-to="${escapeHtml(u.latest)}">更新到 ${escapeHtml(u.latest)}</button>`
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
    /**
     * 不带 `force=1`：这份结果进页面时刚拉过一次，缓存里就是最新的。
     * 强制刷新意味着再走一趟市场索引（秒级），而我们只是要个列表文案。
     * 真要重查，后端在缓存过期时也会先返回旧值、后台刷新。
     */
    const d = await api('/api/plugins/updates');
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
    // 市场页开着才刷，关着就别白等一次索引
    if ($('#marketBox') && !$('#marketBox').hidden) await loadMarket();
  } catch (e) {
    alert('更新失败: ' + e.message);
  }
}

/**
 * 更新插件。会覆盖本地目录，必须先跟用户说清楚。
 *
 * 版本号直接用按钮上带的（`applyUpdateMarks` 写的 `data-from` / `data-to`），
 * **不再为了弹窗去 `updates?force=1` 查一次**：那一下要么整轮拉市场索引（秒级），
 * 要么命中缓存白等。用户点完按钮几秒没反应，只会以为没点上。
 */
async function updateFromMarket(id, btn) {
  const from = btn?.dataset?.from || '';
  const to = btn?.dataset?.to || '';
  const name = btn?.dataset?.name || id;

  const ok = await confirmDialog({
    title: `更新插件「${name}」`,
    message:
      `将把 <b>${escapeHtml(id)}</b> 从 ` +
      `<b>v${escapeHtml(from || '?')}</b> 更新到 <b>v${escapeHtml(to || '?')}</b>。<br><br>` +
      '<b>插件目录会被整体覆盖</b>——如果你手动改过这个插件的代码，改动会丢失。' +
      '玩家存档在 <code>data/</code> 下，不受影响。<br><br>' +
      '更新后会自动重载插件。',
    okText: '确认更新',
  });
  if (!ok) return;

  // 下载 + 解包要好几秒，点了就先给反馈，别让界面一动不动
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  try {
    const r = await api('/api/market/update', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    if (btn) btn.textContent = '已更新';
    await loadPlugins();
    // 市场页开着才刷：它=又一次索引拉取，关着就是白等
    if ($('#marketBox') && !$('#marketBox').hidden) await loadMarket();
    if (r.error) alert(r.error);
  } catch (e) {
    alert('更新失败: ' + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = label || '重试';
    }
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

// 导出：直接开下载，不用 fetch——会话在 Cookie 里，浏览器自己会带上
$('#btnExportStats')?.addEventListener('click', () => {
  const days = Number($('#statsDays')?.value) || 7;
  const q = new URLSearchParams({ days: String(days) });
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
// 分类 chip 与下拉是同一份状态：点 chip 也把下拉同步过去，键盘用户不受影响
document.addEventListener('click', (e) => {
  const chip = e.target.closest?.('.cat-chip');
  if (!chip) return;
  MARKET.tag = chip.dataset.cat || '';
  const sel = $('#marketCat');
  if (sel) sel.value = MARKET.tag;
  renderMarketRows();
});

// 下载源：换源立即保存并生效，测速只是给个参考
$('#btnMirrorTest')?.addEventListener('click', testMirrors);
$('#mirrorSelect')?.addEventListener('change', () => {
  syncMirrorCustom();
  saveMirror();
});
$('#mirrorCustom')?.addEventListener('change', saveMirror);
$('#mirrorGiteeToken')?.addEventListener('change', saveMirror);

/**
 * npm 源：选「自定义」只露出输入框（此时地址还空着，后端会正确地拒绝），
 * 其余选项立即保存。两处入口（插件页 / 外接页依赖卡）都接上，互相镜像。
 */
bindNpmRegistry('npmRegistrySelect', 'npmRegistryCustom');
bindNpmRegistry('onebotNpmRegistry', 'onebotNpmRegistryCustom');

/**
 * 代理：选「自动 / 直连」立即保存；选「手动填写」只露出输入框，等填完再保存。
 *
 * **不能在这里调 syncProxy()**：它是「按已保存的设置回填下拉」，
 * 用户刚选的值还没保存，调一下就把选择弹回去（实测：选「自动」瞬间跳回「手动」）。
 */
$('#proxySelect')?.addEventListener('change', (e) => {
  const v = e.target.value;
  const inp = $('#proxyCustom');
  if (v === 'custom') {
    if (inp) {
      inp.hidden = false;
      inp.focus?.();
    }
    return;
  }
  saveMirror();
});
$('#proxyCustom')?.addEventListener('change', saveMirror);
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

  /**
   * 两个面板分属两个进程：想调「接话策略」的人常常跑去 DSH 能力页，
   * 想调「记不记得」的人又跑来这里（调研报告 §16.4-1）。各留一行指路。
   * 认插件用 schema 里的 `decide`（ai-chat 独有）兜底，光比 id 在改名后会失效。
   */
  const isAiChat = PP.id === 'ai-chat' || Object.hasOwn(PP.schema || {}, 'decide');
  const crossHint = isAiChat
    ? '<div class="pp-hint">记忆、心情、主动搭话、扩展不在这里，在 DSH 侧栏「能力」页；'
      + '这一页只管什么时候接话、防吵、冷却和合并。</div>'
    : '';

  box.innerHTML = crossHint + presetBar + keys
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
      <tr data-id="${escapeHtml(g.groupOpenid)}" data-name="${escapeHtml(g.groupName || '')}">
        <td title="${escapeHtml(g.groupOpenid)}">${labelWithId(g.groupName, g.groupOpenid)}${
          g.memberNum ? `<span class="sub"> · ${g.memberNum} 人</span>` : ''
        }</td>
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
      const row = btn.closest('tr');
      const id = row.dataset.id;
      if (btn.dataset.act === 'plugins') {
        openGroupPlugins(id, row.dataset.name || '');
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

/* ---------------- 可达性 ---------------- */

/**
 * 能不能主动找到人。
 *
 * 这块数据的特殊之处：**三个值不是两个**。`1` 可以、`0` 不可以、`null` 未知。
 *
 * 面板上必须把「未知」和「不可以」显示得完全不一样。如果两者都是灰色、
 * 或者都写「否」，用户会以为这些人真的发不出去，然后跑去手动放开——
 * 而实际情况只是「机器人上线之前就加的好友，事件补不回来」。
 */

/** 依据的英文 key → 中文。事件里带参数（`friend_add:0`），所以按冒号前匹配 */
const REACH_EVIDENCE = {
  friend_add: '加好友事件',
  friend_del: '删好友事件',
  c2c_msg_reject: '用户关了推送',
  c2c_msg_receive: '用户开了推送',
  observed_c2c: '收到过私聊',
  group_msg_reject: '群管理员关了推送',
  group_msg_receive: '群管理员开了推送',
  'send:no-friend': '发送失败·无好友',
  'send:rejected': '发送失败·被拒收',
  manual: '人工标注',
};

function evidenceText(ev) {
  const raw = String(ev || '').trim();
  if (!raw) return '-';
  return REACH_EVIDENCE[raw.split(':')[0]] ?? raw;
}

/** 一句话结论。和后端 `reach.canC2C` 的判定顺序必须一致 */
const REACH_VERDICT = {
  ok: { text: '能发', cls: 'on' },
  'not-friend': { text: '不能：没加好友', cls: 'off' },
  'push-off': { text: '不能：关了推送', cls: 'off' },
  unknown: { text: '未知，照常尝试', cls: '' },
};

/**
 * 行内三态下拉。
 *
 * 用下拉而不是「标为好友 / 标为陌生人」两个按钮：后者没法表达「撤销标注」，
 * 而且改错了只能改到另一个错的值上。`value=""` 就是回到未知。
 */
function triSelect(field, v, yes = '是', no = '否') {
  const sel = (val, text) =>
    `<option value="${val}"${String(v ?? '') === val ? ' selected' : ''}>${text}</option>`;
  return `<select class="mini-select" data-field="${field}" title="人工标注">${
    sel('', '未知') + sel('1', yes) + sel('0', no)
  }</select>`;
}

/* ---------------- 消息查询 ---------------- */

/** 上一次查询的条件与游标（「下一页」要用） */
let srchView = { cursor: 0, terms: [], touched: false };

/**
 * 命中词高亮。
 *
 * 不能「先把整段转义、再替换词」：词里带 `<` `&` 时转义后就匹配不上了。
 * 正确做法是按原串切分，逐段转义，命中的那段包 `<mark>`。
 */
function markTerms(text, terms) {
  const src = String(text ?? '');
  const list = (Array.isArray(terms) ? terms : []).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!list.length) return escapeHtml(src);
  const re = new RegExp(
    `(${list.map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'gi',
  );
  return src
    .split(re)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('');
}

function srchCondOf() {
  return {
    q: String($('#srchQ')?.value ?? '').trim(),
    person: String($('#srchPerson')?.value ?? '').trim(),
    kind: String($('#srchKind')?.value ?? ''),
    days: String($('#srchDays')?.value ?? ''),
  };
}

async function loadSearch(reset) {
  const body = $('#srchRows');
  if (!body) return;
  const cond = srchCondOf();
  if (!cond.q && !cond.person && !cond.kind && !cond.days) {
    body.innerHTML = '<tr><td colspan="4" class="empty">输入关键词或发言人再查</td></tr>';
    return;
  }
  if (reset) {
    srchView.cursor = 0;
    body.innerHTML = '<tr><td colspan="4" class="empty">查询中…</td></tr>';
  }

  const p = new URLSearchParams({ limit: '50' });
  if (cond.q) p.set('q', cond.q);
  if (cond.person) p.set('person', cond.person);
  if (cond.kind) p.set('kind', cond.kind);
  if (cond.days) p.set('days', cond.days);
  if (!reset && srchView.cursor) p.set('beforeSeq', String(srchView.cursor));

  let d;
  try {
    d = await api(`/api/ledger/search?${p.toString()}`);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="4" class="empty">查询失败: ${escapeHtml(e.message)}</td></tr>`;
    return;
  }

  const items = d?.items ?? [];
  srchView.terms = Array.isArray(d?.terms) ? d.terms : [];
  srchView.touched = true;
  if (reset) body.innerHTML = '';

  if (!items.length) {
    /** 后端会带 `note` 解释「为什么空」（比如关键词全是疑问词被剥光了） */
    const empty = String(d?.note ?? '').trim() || '没有匹配的记录';
    if (reset) body.innerHTML = `<tr><td colspan="4" class="empty">${escapeHtml(empty)}</td></tr>`;
    const more = $('#srchMore');
    if (more) more.disabled = true;
    const hint = $('#srchMoreHint');
    if (hint) hint.textContent = '';
    return;
  }

  body.insertAdjacentHTML(
    'beforeend',
    items
      .map((x) => {
        const nick = String(x.nickname ?? '').trim();
        const card = String(x.card ?? '').trim();
        const name = String(x.userName ?? '').trim() || card || nick || String(x.userId ?? '') || '（机器人）';
        const sub = nick && nick !== name ? nick : '';
        const av = ledgerAvatar(x.avatar);
        const chatName = String(x.chatName ?? '').trim();
        const chatShort = String(x.chatId ?? '').slice(0, 10);
        return `<tr data-openid="${escapeHtml(String(x.openid ?? ''))}" data-uin="${escapeHtml(String(x.uin ?? ''))}">
          <td class="lg-when">${escapeHtml(fmtWhen(x.at))}</td>
          <td class="lg-chat" title="${escapeHtml(String(x.chatId ?? ''))}">${escapeHtml(chatName || `${chatShort}…`)}</td>
          <td class="lg-who" title="${escapeHtml(name)}">${av
          ? `<img class="who-av lg-av" src="${escapeHtml(av)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
          : ''}<span class="lg-name">${escapeHtml(name)}</span>${sub
          ? `<span class="sub lg-sub">${escapeHtml(sub)}</span>`
          : ''}</td>
          <td class="lg-content">${markTerms(String(x.content ?? '').slice(0, 300), srchView.terms)}</td>
        </tr>`;
      })
      .join(''),
  );

  /** 结果按时间倒序，游标取最后一条（最老的）的 seq，下一页接着往更早翻 */
  srchView.cursor = Number(items[items.length - 1]?.seq) || 0;

  const more = $('#srchMore');
  if (more) more.disabled = !d?.hasMore;
  const hint = $('#srchMoreHint');
  if (hint) {
    const bits = [`本页 ${items.length} 条`];
    if (d?.relaxed) bits.push('多个关键词没有同时命中的记录，已放宽为任一');
    if (d?.hasMore) bits.push('还有更早的记录，点「下一页」');
    hint.textContent = bits.join(' · ');
  }
}

$('#btnSearch')?.addEventListener('click', () => safeLoad('search', () => loadSearch(true)));
$('#btnSearchReset')?.addEventListener('click', () => {
  for (const id of ['#srchQ', '#srchPerson', '#srchKind', '#srchDays']) {
    const el = $(id);
    if (el) el.value = '';
  }
  const body = $('#srchRows');
  if (body) body.innerHTML = '<tr><td colspan="4" class="empty">还没有查询</td></tr>';
  const more = $('#srchMore');
  if (more) more.disabled = true;
  const hint = $('#srchMoreHint');
  if (hint) hint.textContent = '';
  srchView = { cursor: 0, terms: [], touched: false };
});
for (const id of ['#srchQ', '#srchPerson']) {
  $(id)?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    safeLoad('search', () => loadSearch(true));
  });
}
$('#srchMore')?.addEventListener('click', () => safeLoad('search', () => loadSearch(false)));

/* ---------------- 人物反查 ---------------- */

/**
 * 复制到剪贴板。
 *
 * 面板跑在 `127.0.0.1`，属于安全上下文，`navigator.clipboard` 通常可用；
 * 但它会因「文档没焦点」「权限被拒」偶发失败，所以留一条 `execCommand` 退路
 * （老浏览器 / 内嵌 webview 里这条反而是唯一能用的）。
 */
async function copyToClipboard(text) {
  const s = String(text ?? '');
  if (!s) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* 往下走备用方案 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 消息 / 人物两个模式互斥显示 */
function srchShowMode(which) {
  const isWho = which === 'who';
  const msg = $('#srchMsgBox');
  const who = $('#srchWhoBox');
  if (msg) msg.hidden = isWho;
  if (who) who.hidden = !isWho;
  $('#srchModeMsg')?.classList.toggle('active', !isWho);
  $('#srchModeWho')?.classList.toggle('active', isWho);
}

async function loadWho() {
  const body = $('#whoRows');
  if (!body) return;
  const q = String($('#whoQ')?.value ?? '').trim();
  if (!q) {
    body.innerHTML = '<tr><td colspan="5" class="empty">输入昵称 / QQ 号 / openid 再查</td></tr>';
    return;
  }
  body.innerHTML = '<tr><td colspan="5" class="empty">查询中…</td></tr>';

  let d;
  try {
    d = await api(`/api/people/search?q=${encodeURIComponent(q)}&limit=50`);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="5" class="empty">查询失败: ${escapeHtml(e.message)}</td></tr>`;
    return;
  }

  const items = Array.isArray(d?.items) ? d.items : [];
  const hint = $('#whoHint');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">没找到这个人</td></tr>';
    if (hint) hint.textContent = '试试只输昵称里的一两个字，或者直接粘 openid / QQ 号。';
    return;
  }

  body.innerHTML = items
    .map((p) => {
      const av = ledgerAvatar(p.avatar);
      const name = String(p.name || p.card || p.nickname || '').trim();
      /** 群名片 / QQ 昵称**和显示名不同**时才作为副行，否则整行都是重复字 */
      const sub = [p.card, p.nickname].filter(Boolean).filter((x) => x !== name);
      const uin = String(p.uin ?? '');
      const id = String(p.openid ?? '');
      return `<tr data-openid="${escapeHtml(id)}" data-uin="${escapeHtml(uin)}">
        <td>${av
        ? `<img class="who-av" src="${escapeHtml(av)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
        : '<span class="who-av who-av-none"></span>'}</td>
        <td class="lg-who">${escapeHtml(name || '（未知）')}${p.bound ? '<span class="chip-tag">已绑定</span>' : ''}${sub.length
        ? `<span class="sub lg-sub">${escapeHtml(sub.join(' · '))}</span>`
        : ''}</td>
        <td class="mono">${uin ? escapeHtml(uin) : '<span class="muted">未绑定</span>'}</td>
        <td class="mono" title="${escapeHtml(id)}">${escapeHtml(id.slice(0, 12))}…</td>
        <td><button class="btn small" data-copy="${escapeHtml(id)}">复制 id</button></td>
      </tr>`;
    })
    .join('');

  if (hint) hint.textContent = `找到 ${items.length} 个人 · 点「复制 id」可一键复制 openid`;
}

$('#srchModeMsg')?.addEventListener('click', () => srchShowMode('msg'));
$('#srchModeWho')?.addEventListener('click', () => srchShowMode('who'));
$('#btnWho')?.addEventListener('click', () => safeLoad('search', loadWho));
$('#whoQ')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  safeLoad('search', loadWho);
});
/** 复制：事件委托，`data-copy` 里放要复制的原文 */
$('#whoRows')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const ok = await copyToClipboard(btn.getAttribute('data-copy'));
  const old = btn.textContent;
  btn.textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => {
    btn.textContent = old;
  }, 1200);
});

/* ---------------- 投递账本 ---------------- */

/**
 * 状态文案。
 *
 * `unknown` 是唯一需要人动手的状态——**它不会自动重发**，
 * 所以文案要把「去核对」写清楚，而不是只显示「未知」。
 */
const DELIVERY_LABEL = {
  pending: { text: '发送中', tip: '正在发' },
  sent: { text: '已发送', tip: '确认送达' },
  audited: { text: '审核中', tip: '主动消息进了审核，既不是成功也不是失败' },
  failed: { text: '失败', tip: '确定没发出去，可以重试' },
  unknown: { text: '结果未知', tip: '超时或崩溃，不知道服务端收没收到。不会自动重发，需要人工核对' },
};

async function loadDelivery() {
  const body = $('#deliveryBody');
  if (!body) return;
  try {
    renderDelivery(await api('/api/delivery?limit=50'));
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderDelivery(d) {
  const stats = d?.stats ?? {};
  const el = $('#deliveryStats');
  if (el) {
    const by = stats.by ?? {};
    el.innerHTML = Object.keys(DELIVERY_LABEL)
      .map((k) => {
        const v = by[k] ?? 0;
        // 有值才显眼：全 0 的时候整排彩色卡片只会让人以为出事了
        const hot = k === 'unknown' && v > 0;
        return `<div class="card"><div class="k">${DELIVERY_LABEL[k].text}</div>`
          + `<div class="v"${hot ? ' style="color:var(--warn-text)"' : ''}>${v}</div></div>`;
      })
      .join('');
  }

  const body = $('#deliveryBody');
  const items = d?.items ?? [];
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">还没有记录（只有带幂等键的发送才记账）</td></tr>';
    return;
  }
  body.innerHTML = items
    .map((x) => {
      const st = DELIVERY_LABEL[x.state] ?? { text: x.state, tip: '' };
      const when = x.created_at ? new Date(Number(x.created_at)).toLocaleString('zh-CN', { hour12: false }) : '-';
      const warn = x.state === 'unknown' || x.state === 'failed';
      /**
       * 摘要空的老记录（修 `digestTextOf` 之前发的）一律是 `…(0)#da39a3ee`，
       * 一列看下来完全分不清谁是谁。显示成一句人话，原文挂在 title 上备查。
       */
      const digest = String(x.digest ?? '');
      const digestText = /^…\(0\)#/.test(digest) ? '（无正文）' : digest.slice(0, 60);
      return `<tr>
        <td>${escapeHtml(when)}</td>
        <td class="mono">${escapeHtml(String(x.chat_id ?? '').slice(0, 12))}</td>
        <td${warn ? ' style="color:var(--warn-text)"' : ''} title="${escapeHtml(st.tip)}">${escapeHtml(st.text)}</td>
        <td title="${escapeHtml(digest)}">${escapeHtml(digestText)}</td>
        <td class="num">${Number(x.attempts ?? 0)}</td>
        <td class="mono">${escapeHtml(String(x.code ?? ''))}</td>
      </tr>`;
    })
    .join('');
}

async function loadReach() {
  const ub = $('#reachUserBody');
  const gb = $('#reachGroupBody');
  if (!ub || !gb) return;
  try {
    renderReach(await api('/api/reach'));
  } catch (e) {
    ub.innerHTML = `<tr><td colspan="6" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
    gb.innerHTML = `<tr><td colspan="5" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderReach(d) {
  const ub = $('#reachUserBody');
  const gb = $('#reachGroupBody');
  if (!ub || !gb) return;

  const users = d?.users ?? [];
  const groups = d?.groups ?? [];

  ub.innerHTML = users.length
    ? users
        .map((u) => {
          const v = REACH_VERDICT[u.verdict] ?? REACH_VERDICT.unknown;
          const extra = u.lastFailCode ? ` · 失败码 ${u.lastFailCode}` : '';
          return `<tr data-openid="${escapeHtml(u.openid)}">
            <td title="${escapeHtml(u.openid)}">${labelWithAvatar(u.name, u.openid, u.avatar)}</td>
            <td>${triSelect('friend', u.friend)}</td>
            <td>${triSelect('c2cPush', u.c2cPush)}</td>
            <td><span class="badge ${v.cls}">${v.text}</span></td>
            <td title="${escapeHtml(u.evidence || '')}">${escapeHtml(evidenceText(u.evidence))}${escapeHtml(extra)}</td>
            <td>${u.updatedAt ? fmtAgo(u.updatedAt) : '-'}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="empty">还没有记录。收到私聊消息、或被加好友之后才会出现。</td></tr>';

  gb.innerHTML = groups.length
    ? groups
        .map(
          (g) => `<tr data-group="${escapeHtml(g.groupOpenid)}">
            <td title="${escapeHtml(g.groupOpenid)}">${labelWithId(g.name, g.groupOpenid)}${
              g.memberNum ? `<span class="sub"> · ${g.memberNum} 人</span>` : ''
            }</td>
            <td>${triSelect('push', g.push, '开', '关')}</td>
            <td title="${escapeHtml(g.by || '')}">${g.by ? labelWithId('', g.by) : '-'}</td>
            <td title="${escapeHtml(g.evidence || '')}">${escapeHtml(evidenceText(g.evidence))}</td>
            <td>${g.updatedAt ? fmtAgo(g.updatedAt) : '-'}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty">还没有记录。群管理员改过推送开关之后才会出现。</td></tr>';
}

/**
 * 行内标注：改下拉即提交。
 *
 * 委托绑在 tbody 上，因为 `renderReach` 每次都整个重建 innerHTML，
 * 逐行 `addEventListener` 会随着重绘丢掉。
 */
async function saveReachPatch(sel, body) {
  sel.disabled = true;
  try {
    renderReach(await api('/api/reach', { method: 'POST', body: JSON.stringify(body) }));
  } catch (e) {
    alert('标注失败: ' + e.message);
    sel.disabled = false;
  }
}

$('#reachUserBody')?.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-field]');
  if (!sel) return;
  const openid = sel.closest('tr')?.dataset.openid;
  if (!openid) return;
  // 空字符串 = 撤销标注，要显式传 null，不能传 ''（后端会当成非法值）
  saveReachPatch(sel, { openid, [sel.dataset.field]: sel.value === '' ? null : Number(sel.value) });
});

$('#reachGroupBody')?.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-field]');
  if (!sel) return;
  const groupOpenid = sel.closest('tr')?.dataset.group;
  if (!groupOpenid) return;
  saveReachPatch(sel, {
    groupOpenid,
    push: sel.value === '' ? null : Number(sel.value),
  });
});

$('#btnReloadReach')?.addEventListener('click', loadReach);

/** 列表里没有的人（比如老好友、从没私聊过）手动登记一条 */
$('#btnReachSave')?.addEventListener('click', async () => {
  const openid = $('#reachOpenidInput')?.value.trim() ?? '';
  if (!openid) return alert('先填 openid');
  const friend = $('#reachFriendSel')?.value ?? '';
  const c2cPush = $('#reachPushSel')?.value ?? '';
  if (friend === '' && c2cPush === '') return alert('好友和推送至少选一个，不然登记了也是未知');

  const btn = $('#btnReachSave');
  btn.disabled = true;
  try {
    const body = { openid };
    if (friend !== '') body.friend = Number(friend);
    if (c2cPush !== '') body.c2cPush = Number(c2cPush);
    renderReach(await api('/api/reach', { method: 'POST', body: JSON.stringify(body) }));
    $('#reachOpenidInput').value = '';
    $('#reachFriendSel').value = '';
    $('#reachPushSel').value = '';
  } catch (e) {
    alert('登记失败: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

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
 * @param {string} [name] 群名（有就显示在副标题里，没有退回短码）
 */
async function openGroupPlugins(chatId, name = '') {
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
  /**
   * 副标题写群名，短码只在没有名字时兜底。
   *
   * 这个弹窗是「只对这个群生效」的开关面板，标题写一串 openid 时用户根本
   * 无法确认自己改的是哪个群——改了错的群比不改更糟。
   */
  $('#gplugSub').textContent = name
    ? `群「${name}」：只影响这一个群（${shortId(chatId)}），其它群不受影响。`
    : `群 ${shortId(chatId)}：只影响这一个群，其它群不受影响。`;  $('#gplugGlobalHint').textContent =
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

/* ---------------- 外接页：宿主协议（上）+ OneBot v11（下） ---------------- */

/**
 * 一次切页把两半都刷出来。
 *
 * **分开取数、各自兜错**：OneBot 那半边挂了（比如依赖目录读不到），
 * 不能连累宿主协议的状态也白屏；反过来也一样。依赖卡是两边共用的，
 * 随便哪半边成功都能把它渲染出来。
 */
async function loadOnebot() {
  const body = $('#onebotDepsBody');
  try {
    renderOnebot(await api('/api/onebot'));
  } catch (e) {
    if (body) {
      body.innerHTML = `<tr><td colspan="5" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
    }
  }
  try {
    renderHost(await api('/api/host'));
  } catch (e) {
    const st = $('#hostStateHint');
    if (st) st.textContent = '读取失败';
    const hint = $('#hostConnHint');
    if (hint) hint.innerHTML = `<b>${escapeHtml(e.message)}</b>`;
  }
}

const HOST_STATE_TEXT = {
  running: '运行中',
  disabled: '未开启',
  stopped: '已停止',
  'missing-deps': '缺依赖',
  error: '启动失败',
};

/** 宿主协议那半边：配置表单 + 运行状态 + 方法表 */
function renderHost(d) {
  const cfg = d?.cfg ?? {};
  const st = d?.state ?? {};
  const cap = d?.capability ?? {};
  const set = (sel, fn) => {
    const el = $(sel);
    if (el) fn(el);
  };

  set('#hostEnabled', (el) => { el.checked = Boolean(cfg.enabled); });
  set('#hostListenHost', (el) => { el.value = cfg.host ?? '127.0.0.1'; });
  set('#hostPort', (el) => {
    const auto = !Number(cfg.port);
    el.value = auto ? '' : String(cfg.port);
    el.placeholder = auto ? `自动（当前 ${st.port || '未监听'}）` : '端口（留空=自动）';
  });
  set('#hostMaxConnections', (el) => { el.value = String(Number(cfg.maxConnections) || 4); });
  /** 后端不回显明文，输入框恒为空：「留空=不改」 */
  set('#hostToken', (el) => {
    el.value = '';
    el.type = 'password';
    el.placeholder = cfg.tokenSet
      ? 'access token（已设置，留空=不改）'
      : 'access token（至少 16 位）';
  });
  // 保存/切页签后重新渲染：明文没了，复制按钮必须跟着消失（程序赋值不触发 input 事件）
  syncTokenCopy('#hostToken', '#btnHostCopyToken');
  const scopes = Array.isArray(cfg.scopes) ? cfg.scopes : [];
  set('#hostScopeMessage', (el) => { el.checked = scopes.includes('message'); });
  set('#hostForwardAll', (el) => { el.checked = cfg.forwardAll !== false; });
  set('#hostAllowRemote', (el) => { el.checked = Boolean(cfg.allowRemote); });
  set('#hostAllowManage', (el) => { el.checked = Boolean(cfg.allowManage); });
  /**
   * 总闸关着时「申请管理权限」不可勾：勾了也不会生效，
   * 让它可点只会让人以为权限已经开了。两层关系要在控件上看得出来。
   */
  set('#hostScopeManage', (el) => {
    el.disabled = !cfg.allowManage;
    el.checked = Boolean(cfg.allowManage) && scopes.includes('manage');
  });

  const label = HOST_STATE_TEXT[st.state] ?? st.state ?? '未知';
  set('#hostStateHint', (el) => {
    el.textContent = st.state === 'running'
      ? `${label} · 端口 ${st.port} · ${st.connections ?? 0} 个连接 · seq ${st.seq ?? 0}`
      : label;
  });

  const hint = $('#hostConnHint');
  if (hint) {
    if (st.state === 'running') {
      const h = st.host ?? '127.0.0.1';
      const base = `http://${h}:${st.port}`;
      const row = (k, v) => `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <span class="hint" style="min-width:74px">${k}</span>
          <code style="word-break:break-all">${escapeHtml(v)}</code>
          <button class="btn small" data-copy="${escapeHtml(v)}">复制</button>
        </div>`;
      const granted = (st.scopes ?? []).join(' + ') || '—';
      hint.innerHTML =
        row('WebSocket', `ws://${h}:${st.port}/`) +
        row('HTTP RPC', `${base}/rpc`) +
        row('事件流', `${base}/events`) +
        (cfg.tokenSet
          ? '<div class="hint" style="margin-top:6px">令牌<b>已设置、不回显</b>'
            + '（避免本机任意进程一条 GET 就抄走）：要给新客户端配就点「生成」，'
            + '生成时会出现「复制」按钮，保存后自动消失；旧的保存后立即失效。'
            + '<b>不要拼进地址</b>，用 Authorization 头或 access_token 参数</div>'
          : '<div class="hint" style="margin-top:6px"><b>还没设 token</b>：客户端会被拒。点「生成」</div>') +
        `<div class="hint" style="margin-top:6px">生效权限：${escapeHtml(granted)}` +
        `　缓冲 ${Number(st.buffered ?? 0)} 条` +
        `　调用 成功 ${Number(st.actions?.ok ?? 0)} / 失败 ${Number(st.actions?.fail ?? 0)}</div>` +
        (st.online === false
          ? '<div class="hint" style="margin-top:6px;color:var(--err)"><b>机器人本体没上线</b>：' +
            '客户端能连上，但发消息、调官方接口会失败——先到「运行」页让它上线</div>'
          : '');
    } else if (st.state === 'missing-deps' || st.state === 'error') {
      hint.innerHTML = `<b>${escapeHtml(st.error || '没起来')}</b>` +
        '。缺依赖就到下面「依赖」卡装，装完会自动重连。';
    } else {
      hint.textContent = '开启后这里会显示连接串和运行状态。';
    }
  }

  const capBody = $('#hostCapBody');
  const methods = Array.isArray(cap.methods) ? cap.methods : [];
  if (capBody) {
    capBody.innerHTML = methods.length
      ? methods.map((m) => `<tr>
          <td class="mono">${escapeHtml(m.name ?? '')}</td>
          <td><span class="badge${m.scope === 'manage' ? ' off' : m.scope === 'message' ? '' : ' on'}">${escapeHtml(m.scope ?? '')}</span></td>
          <td class="hint">${escapeHtml(m.desc ?? '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="3" class="empty">协议还没就绪，开启后可见</td></tr>';
  }
  set('#hostCapHint', (el) => {
    el.textContent = `共 ${methods.length} 个方法 · roost-host/${cap.protocol ?? 1}` +
      ` · 已授权限 ${(cap.scopes ?? []).join('+') || '—'}`;
  });
}

function renderOnebot(d) {
  const body = $('#onebotDepsBody');
  const hint = $('#onebotDepsHint');
  if (!body) return;

  /* ---------- 配置表单 ---------- */
  const cfg = d?.cfg ?? {};
  const st = d?.state ?? {};
  if ($('#onebotEnabled')) $('#onebotEnabled').checked = Boolean(cfg.enabled);
  if ($('#onebotHost')) $('#onebotHost').value = cfg.host ?? '127.0.0.1';
  if ($('#onebotPort')) {
    /**
     * 0 表示「自动分配」，但输入框里显示一个 0 会让人以为配错了。
     * 留空 + 占位符显示实际端口，比让人去猜 0 的含义好。
     */
    const auto = !Number(cfg.port);
    $('#onebotPort').value = auto ? '' : String(cfg.port);
    $('#onebotPort').placeholder = auto
      ? `自动（当前 ${st.port || '未监听'}）`
      : '端口（留空=自动）';
  }
  const pinBtn = $('#btnOnebotPinPort');
  if (pinBtn) {
    pinBtn.hidden = !(st.state === 'running' && !Number(cfg.port) && Number(st.port) > 0);
    pinBtn.dataset.port = String(st.port ?? '');
  }
  if ($('#onebotSelfUin')) $('#onebotSelfUin').value = cfg.selfUin ?? '';
  if ($('#onebotMode')) $('#onebotMode').value = cfg.mode ?? 'exclusive';
  if ($('#onebotToken')) {
    /**
     * **不回显**：后端只给「设过没有」（`tokenSet`）。
     *
     * 以前本机请求会给明文（为了复制到客户端），但面板没设 `accessKey` 时
     * 本机任何进程一条 GET 都能抄走它——那等于把「管理权限」降维成一个
     * 可复制的凭证。要复制给客户端就点「生成」换一个新的，旧的立刻失效。
     */
    $('#onebotToken').value = '';
    $('#onebotToken').type = 'password';
    $('#onebotToken').placeholder = cfg.tokenSet
      ? 'access token（已设置，留空=不改）'
      : 'access token（至少 16 位）';
  }
  syncTokenCopy('#onebotToken', '#btnOnebotCopyToken');

  /* ---------- 状态 ---------- */
  const stateHint = $('#onebotStateHint');
  const connHint = $('#onebotConnHint');
  const STATE_TEXT = {
    running: '运行中',
    disabled: '未开启',
    stopped: '已停止',
    'missing-deps': '缺依赖',
    error: '启动失败',
  };
  if (stateHint) {
    const label = STATE_TEXT[st.state] ?? st.state ?? '未知';
    const extra =
      st.state === 'running'
        ? ` · 端口 ${st.port}${Number(cfg.port) ? '' : '（自动分配）'} · ${st.connections ?? 0} 个连接`
        : '';
    stateHint.textContent = label + extra;
  }

  if (connHint) {
    if (st.state === 'running') {
      const host = st.host ?? '127.0.0.1';
      /**
       * **地址里不带 token**。
       *
       * 客户端（aurobot / NoneBot）都有独立的「令牌」输入框，令牌塞进 URL 会
       * 被截屏、被复制到聊天里、被日志记下来，泄漏面反而更大。
       * 这里只给干净的地址；token 本身**不回显**（见下面），要用就点「生成」换一个。
       */
      const wsUrl = `ws://${host}:${st.port}/`;
      const httpUrl = `http://${host}:${st.port}`;
      const row = (label, value) => `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
          <span class="hint" style="min-width:74px">${label}</span>
          <code style="word-break:break-all">${escapeHtml(value)}</code>
          <button class="btn small" data-copy="${escapeHtml(value)}">复制</button>
        </div>`;
      const ids = st.ids ?? {};
      connHint.innerHTML =
        row('WebSocket', wsUrl) +
        row('HTTP', httpUrl) +
        (cfg.tokenSet
          ? '<div class="hint" style="margin-top:6px">令牌<b>已设置、不回显</b>（避免本机任意进程一条 GET 就抄走）：'
            + '要给新客户端配就点「生成」，生成时会出现「复制」按钮，保存后自动消失——旧的保存后立即失效</div>'
          : '<div class="hint" style="margin-top:6px"><b>还没设 token</b>：客户端会被拒。点「生成」</div>') +
        `<div class="hint" style="margin-top:6px">合成号：${Number(ids.synthUsers ?? 0)} 人 / ${Number(ids.synthGroups ?? 0)} 群` +
        `　动作：成功 ${Number(st.actions?.ok ?? 0)} / 失败 ${Number(st.actions?.fail ?? 0)}</div>` +
        (st.online === false
          ? `<div class="hint" style="margin-top:6px;color:var(--err)"><b>机器人本体没上线</b>` +
            `${st.botError ? `（${escapeHtml(st.botError)}）` : ''}：客户端能连上，但发消息会失败——先到「运行」页让它上线</div>`
          : '') +
        (st.selfOpenidBound ? '' : '<div class="hint" style="margin-top:6px"><b>机器人自己的 openid 没绑</b>：已按「过滤所有机器人消息」处理，避免自激</div>') +
        /**
         * `forwardAll` 只承诺「收到的都推」。上游没开全量群消息时，非 @ 的
         * 群聊根本到不了框架——不写清楚的话，用户会以为是 OneBot 这边丢了。
         */
        (st.upstream && st.upstream.fullGroup === false && cfg.forwardAll !== false
          ? '<div class="hint" style="margin-top:6px"><b>只收得到 @ 机器人的群消息</b>：'
            + `上游 intents=${Number(st.upstream.intents ?? 0)} 不含全量群消息（1073741824 = 2^30）。`
            + '要去 q.qq.com 给机器人开「接收所有消息」，再把 intents 加上 1073741824；'
            + '否则普通群聊不会到达框架，客户端这边自然也看不到</div>'
          : '');
    } else if (st.state === 'missing-deps' || st.state === 'error') {
      connHint.innerHTML = `<b>${escapeHtml(st.error || '没起来')}</b>`;
    } else {
      connHint.textContent = '开启后这里会显示连接串和运行状态。';
    }
  }

  /* ---------- 依赖 ---------- */
  const pkgs = d?.deps?.packages ?? {};
  const rows = Object.entries(pkgs).map(([name, p]) => {
    const ok = Boolean(p.resolvable);
    const badge = ok
      ? '<span class="badge on">已安装</span>'
      : p.required
        ? '<span class="badge off">未安装·必需</span>'
        : '<span class="badge">未安装·可选</span>';
    const action = ok
      ? `<button class="btn small" data-remove="${escapeHtml(name)}">卸载</button>`
      : `<button class="btn small primary" data-install="${escapeHtml(name)}">一键安装</button>`;
    /**
     * 系统 PATH 里那份 ffmpeg 单独提示：托管目录里没有时才提——有的话
     * 二进制路径已经显示出来了，再提一句只是噪音。提它是因为能省 62MB。
     */
    const sysHint = !ok && p.system
      ? `<div class="hint" style="color:var(--ok)">系统里已有：<code>${escapeHtml(p.system)}</code></div>`
      : '';
    return `<tr>
      <td class="mono">${escapeHtml(name)}</td>
      <td>${escapeHtml(p.desc ?? '')}<div class="hint">${escapeHtml(p.size ?? '')}</div>${sysHint}</td>
      <td>${badge}</td>
      <td class="mono">${escapeHtml(p.version || '—')}</td>
      <td>${action}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('') || '<tr><td colspan="5" class="empty">没有依赖声明</td></tr>';

  if (!hint) return;
  /**
   * 「这次安装实际会走哪个源」。
   *
   * 下拉框只显示用户存的选择（跟随系统 / npmmirror / 官方 / 自定义）；
   * 选了「跟随系统」时真正生效的可能是环境变量或 `.npmrc`，用户看不到。
   * 装不上要换源的时候，得先知道自己现在在哪个源上。
   */
  const reg = d?.deps?.registry ?? {};
  const REG_FROM = {
    explicit: '本次请求指定',
    config: '面板设置',
    env: '环境变量 npm_config_registry',
    npmrc: '.npmrc',
    default: '默认',
  };
  const regName =
    (reg.presets ?? []).find((x) => x.url && x.url === reg.url)?.name ?? reg.url ?? '—';
  const regLine =
    `安装源：<code>${escapeHtml(regName)}</code>` +
    (reg.source && reg.source !== 'default' ? `（来自${REG_FROM[reg.source] ?? reg.source}）` : '');

  /**
   * 下拉框补一次值。
   *
   * `syncNpmRegistry()` 平时由「插件」页的 `loadMirrorBar()` 驱动；用户直接
   * 进「外接」页时它没跑过，下拉会停在默认的「跟随系统」，而实际可能早就
   * 选了 npmmirror。以接口返回的实际源为准补一次——**只补一次**，
   * 之后不再覆盖用户正在改的选择。
   */
  if (!NPM_CARD_BACKFILLED && reg.url) {
    NPM_CARD_BACKFILLED = true;
    syncNpmRegistry(npmChoiceFromRegistry(reg));
  }

  if (d?.deps?.ready) {
    hint.innerHTML =
      `依赖已就绪，装在 <code>${escapeHtml(d?.deps?.dir ?? '')}</code>` +
      '（宿主协议与 OneBot 共用这一份）' +
      `<br>${regLine}`;
  } else {
    const missing = (d?.deps?.missing ?? []).join('、') || '—';
    hint.innerHTML =
      `还缺：<b>${escapeHtml(missing)}</b>。装不上时可以手动执行：` +
      `<code>${escapeHtml(d?.manual ?? '')}</code>` +
      `<br>${regLine}　装不上先换个源再试`;
  }

  /* ---------- 能力矩阵 ---------- */
  const capBody = $('#onebotCapBody');
  const capHint = $('#onebotCapHint');
  const cap = d?.capability;
  if (capBody && Array.isArray(cap?.list)) {
    const LEVEL = {
      support: ['badge on', '支持'],
      degrade: ['badge', '降级'],
      unsupported: ['badge off', '不支持'],
    };
    capBody.innerHTML = cap.list
      .map((c) => {
        const [cls, text] = LEVEL[c.level] ?? ['badge', c.level];
        const why = c.why || c.note || '';
        return `<tr>
          <td class="mono">${escapeHtml(c.name)}</td>
          <td><span class="${cls}">${text}</span></td>
          <td class="hint">${escapeHtml(why)}</td>
        </tr>`;
      })
      .join('');
  }
  if (capHint && cap?.summary) {
    capHint.textContent =
      `共 ${cap.list.length} 项：支持 ${cap.summary.support} · 降级 ${cap.summary.degrade}` +
      ` · 不支持 ${cap.summary.unsupported}`;
  }
}

async function onebotDepsAction(kind, name, btn) {
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = kind === 'install' ? '安装中…' : '卸载中…';
  }
  /** 装/卸之后上一次的检查结论就不作数了，先撤掉，别让人对着旧结果判断 */
  const check = $('#onebotDepsCheck');
  if (check) check.hidden = true;
  try {
    await api(`/api/ext/deps/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ packages: [name] }),
    });
  } catch (e) {
    const hint = $('#onebotDepsHint');
    if (hint) hint.innerHTML = `失败：${escapeHtml(e.message)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
    await loadOnebot();
  }
}

/**
 * 手动检查：**只验不装**。
 *
 * 面板上那排「已安装」是文件系统层面的判断——`require.resolve` 过了就算过。
 * 但文件被杀毒隔离、平台子包放错架构（x64 机器装了 ia32）、下到一半断电，
 * 这几种全都照样显示「已安装」，直到用户发第一条语音才炸。
 *
 * 后端这条路径会真 `require` 一次、真跑一次 `ffmpeg -version`，专门抓这种
 * 半坏状态。ffmpeg 是可选依赖，所以「没装」不算故障，只有「找到了但跑不起来」
 * 才算。
 */
async function onebotDepsVerify(btn) {
  const out = $('#onebotDepsCheck');
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检查中…';
  }
  if (out) {
    out.hidden = false;
    out.textContent = '正在检查（会真加载模块、跑一次 ffmpeg -version）…';
  }
  try {
    const r = await api('/api/ext/deps/verify', { method: 'POST', body: JSON.stringify({}) });

    const ff = r.ffmpeg ?? {};
    const ffText = ff.ok
      ? `ffmpeg 可用（${ff.source === 'system' ? '系统 PATH' : '托管目录'}：`
        + `<code>${escapeHtml(ff.path)}</code>）`
      : ff.path
        ? `<b>ffmpeg 找到了但跑不起来</b>：${escapeHtml(ff.error || '')}`
        : 'ffmpeg 没装（可选，发 mp3/ogg 语音才需要）';

    const stat = [
      (r.checked ?? []).length ? `已验 ${(r.checked ?? []).length} 项` : '',
      (r.missing ?? []).length ? `未安装 ${(r.missing ?? []).length} 项` : '',
    ].filter(Boolean).join(' · ');

    /** 「找到了但跑不起来」是真故障；「没装」只是没装 */
    const broken = !r.ok || Boolean(ff.path && !ff.ok);
    if (out) {
      out.innerHTML = broken
        ? `<span class="badge off">有问题</span> ${escapeHtml((r.errors ?? []).join('；') || '见下')}`
          + `<br>${ffText}`
        : `<span class="badge on">通过</span> ${escapeHtml(stat)}<br>${ffText}`;
    }
  } catch (e) {
    if (out) out.innerHTML = `检查失败：${escapeHtml(e.message)}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

$('#btnOnebotCheckDeps')?.addEventListener('click', (e) => onebotDepsVerify(e.currentTarget));
$('#btnOnebotReloadDeps')?.addEventListener('click', loadOnebot);
$('#btnOnebotReload')?.addEventListener('click', loadOnebot);

/**
 * 能力表展开/收起。
 *
 * 之前用原生 `<details>` + `list-style:none`，箭头被隐藏后整块看着像纯文本，
 * 点了没反应——不是没实现，是**看不出来能点**。换成显式按钮，行为一眼可见。
 */
$('#btnOnebotCapToggle')?.addEventListener('click', () => {
  const wrap = $('#onebotCapWrap');
  const btn = $('#btnOnebotCapToggle');
  if (!wrap || !btn) return;
  wrap.hidden = !wrap.hidden;
  btn.textContent = wrap.hidden ? '展开' : '收起';
});

/** 连接串一键复制：外接页上下两半都有连接串，共用一份逻辑 */
function bindCopyHint(selector) {
  $(selector)?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy ?? '';
    const old = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '已复制';
    } catch {
      // 剪贴板被拒：选中那段 code，让用户 Ctrl+C
      const code = btn.parentElement?.querySelector('code');
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      btn.textContent = '按 Ctrl+C';
    }
    setTimeout(() => {
      btn.textContent = old;
    }, 1400);
  });
}
bindCopyHint('#onebotConnHint');
bindCopyHint('#hostConnHint');

const onebotTokenInput = () => $('#onebotToken');

/**
 * 「复制」按钮只在**输入框里真的有明文**时存在。
 *
 * 后端不回显（面板没设 accessKey 时，本机任意进程一条 GET 就能抄走），
 * 所以输入框平时恒为空，常驻一个「复制」只会是永远点不动的死按钮。
 * 点「生成」是唯一拿到明文的时刻：那一刻按钮出现，用户复制、保存；
 * 保存后 `loadOnebot()` 重新渲染把输入框清空，按钮随之消失。
 * 显隐由输入框内容驱动，不另存状态，就不会出现「按钮还在但没东西可复制」。
 */
function syncTokenCopy(inputId, btnId) {
  const input = $(inputId);
  const btn = $(btnId);
  if (input && btn) btn.hidden = !input.value;
}

/** 一组 token 输入框的复制按钮：点击复制，写不进剪贴板就退化成 Ctrl+C */
function bindTokenCopy(inputId, btnId, hintId) {
  const input = $(inputId);
  const btn = $(btnId);
  if (!input || !btn) return;
  input.addEventListener('input', () => syncTokenCopy(inputId, btnId));
  btn.addEventListener('click', async () => {
    const val = input.value;
    if (!val) return;
    const hint = $(hintId);
    try {
      await navigator.clipboard.writeText(val);
      if (hint) hint.innerHTML = 'token 已复制到剪贴板，<b>填到客户端</b>后记得点「保存并应用」。';
    } catch {
      // 非安全上下文 / 权限被拒：明文已经在输入框里，选中让用户自己按 Ctrl+C
      input.type = 'text';
      input.select();
      if (hint) hint.innerHTML = '浏览器不允许写剪贴板，已选中，<b>按 Ctrl+C 复制</b>。';
    }
  });
  syncTokenCopy(inputId, btnId);
}

bindTokenCopy('#onebotToken', '#btnOnebotCopyToken', '#onebotConnHint');
bindTokenCopy('#hostToken', '#btnHostCopyToken', '#hostConnHint');

/** 生成 token：48 位十六进制，够长且没有 URL 特殊字符 */
$('#btnOnebotGenToken')?.addEventListener('click', () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const input = onebotTokenInput();
  const hint = $('#onebotConnHint');
  if (input) {
    input.value = token;
    input.type = 'text';   // 刚生成的一定要看得见
    input.select();        // 剪贴板不可用时，供用户按 Ctrl+C
  }
  syncTokenCopy('#onebotToken', '#btnOnebotCopyToken');
  if (hint) {
    hint.innerHTML = '已生成，<b>点「复制」</b>填到客户端，再点「保存并应用」；旧 token 保存后立即失效。';
  }
});

/** 清除：等于把门拆了，必须同时关掉监听（后端也会这么做） */
$('#btnOnebotClearToken')?.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清除 access token',
    message: '清除后兼容模式会<b>自动关闭</b>，已连接的客户端会断开。要重新用就再生成一个。',
    okText: '清除',
    danger: true,
  });
  if (!ok) return;
  const hint = $('#onebotConnHint');
  try {
    await api('/api/onebot', { method: 'PUT', body: JSON.stringify({ token: null }) });
    await loadOnebot();
    if (hint) hint.innerHTML = 'token 已清除，兼容模式已关闭。';
  } catch (e) {
    if (hint) hint.innerHTML = `<b>${escapeHtml(e.message)}</b>`;
  }
});

$('#btnOnebotSave')?.addEventListener('click', async () => {
  const btn = $('#btnOnebotSave');
  const hint = $('#onebotConnHint');
  const body = {
    enabled: Boolean($('#onebotEnabled')?.checked),
    host: ($('#onebotHost')?.value ?? '').trim() || '127.0.0.1',
    port: Number($('#onebotPort')?.value) || 0,
    selfUin: ($('#onebotSelfUin')?.value ?? '').trim(),
    mode: $('#onebotMode')?.value ?? 'exclusive',
  };
  const token = ($('#onebotToken')?.value ?? '').trim();
  if (token) body.token = token;

  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/onebot', { method: 'PUT', body: JSON.stringify(body) });
    await loadOnebot();
    if (r?.warning && hint) hint.innerHTML = `<b>${escapeHtml(r.warning)}</b>`;
  } catch (e) {
    if (hint) hint.innerHTML = `<b>${escapeHtml(e.message)}</b>`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

/**
 * 「固定为当前端口」：自动分配是按 botId 哈希算的，本来就稳定，
 * 但有人就是想要一个写死的端口（反代、防火墙放行）。点一下写回配置即可。
 */
$('#btnOnebotPinPort')?.addEventListener('click', async () => {
  const btn = $('#btnOnebotPinPort');
  const hint = $('#onebotConnHint');
  const port = Number(btn?.dataset.port) || 0;
  if (!port) return;
  if (btn) btn.disabled = true;
  try {
    await api('/api/onebot', { method: 'PUT', body: JSON.stringify({ port }) });
    await loadOnebot();
    if (hint) hint.innerHTML = `端口已固定为 <b>${port}</b>`;
  } catch (e) {
    if (hint) hint.innerHTML = `<b>${escapeHtml(e.message)}</b>`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('#onebotDepsBody')?.addEventListener('click', (e) => {
  const ins = e.target.closest('[data-install]');
  const rem = e.target.closest('[data-remove]');
  if (ins) onebotDepsAction('install', ins.dataset.install, ins);
  else if (rem) onebotDepsAction('remove', rem.dataset.remove, rem);
});

/* ---------------- 宿主协议：表单与按钮 ---------------- */

const hostTokenInput = () => $('#hostToken');

/** 同 OneBot：生成时明文显示 + 选中，复制按钮随之出现 */
$('#btnHostGenToken')?.addEventListener('click', () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const input = hostTokenInput();
  const hint = $('#hostConnHint');
  if (input) {
    input.value = token;
    input.type = 'text';
    input.select();
  }
  syncTokenCopy('#hostToken', '#btnHostCopyToken');
  if (hint) {
    hint.innerHTML = '已生成，<b>点「复制」</b>填到客户端，再点「保存并应用」；旧 token 保存后立即失效。';
  }
});

$('#btnHostClearToken')?.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清除宿主协议 token',
    message: '清除后宿主协议会<b>自动关闭</b>，已连接的客户端会断开。要重新用就再生成一个。',
    okText: '清除',
    danger: true,
  });
  if (!ok) return;
  const hint = $('#hostConnHint');
  try {
    await api('/api/host', { method: 'PUT', body: JSON.stringify({ token: null }) });
    await loadOnebot();
    if (hint) hint.innerHTML = 'token 已清除，宿主协议已关闭。';
  } catch (e) {
    if (hint) hint.innerHTML = `<b>${escapeHtml(e.message)}</b>`;
  }
});

/**
 * 总闸与 scope 联动：打开总闸就顺手勾上 manage scope，关掉就取消。
 * 让用户勾两次才能开一个权限，只会造成「明明开了却还是 403」的困惑。
 */
$('#hostAllowManage')?.addEventListener('change', () => {
  const on = Boolean($('#hostAllowManage')?.checked);
  const scope = $('#hostScopeManage');
  if (!scope) return;
  scope.disabled = !on;
  scope.checked = on;
});

$('#btnHostCapToggle')?.addEventListener('click', () => {
  const wrap = $('#hostCapWrap');
  const btn = $('#btnHostCapToggle');
  if (!wrap || !btn) return;
  wrap.hidden = !wrap.hidden;
  btn.textContent = wrap.hidden ? '展开' : '收起';
});

$('#btnHostReload')?.addEventListener('click', loadOnebot);

$('#btnHostSave')?.addEventListener('click', async () => {
  const btn = $('#btnHostSave');
  const hint = $('#hostConnHint');
  const scopes = ['read'];
  if ($('#hostScopeMessage')?.checked) scopes.push('message');
  if ($('#hostScopeManage')?.checked && $('#hostAllowManage')?.checked) scopes.push('manage');
  const body = {
    enabled: Boolean($('#hostEnabled')?.checked),
    host: ($('#hostListenHost')?.value ?? '').trim() || '127.0.0.1',
    port: Number($('#hostPort')?.value) || 0,
    scopes,
    allowManage: Boolean($('#hostAllowManage')?.checked),
    forwardAll: Boolean($('#hostForwardAll')?.checked),
    allowRemote: Boolean($('#hostAllowRemote')?.checked),
    maxConnections: Number($('#hostMaxConnections')?.value) || 4,
  };
  const token = (hostTokenInput()?.value ?? '').trim();
  if (token) body.token = token;

  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/host', { method: 'PUT', body: JSON.stringify(body) });
    await loadOnebot();
    if (r?.warning && hint) hint.innerHTML = `<b>${escapeHtml(r.warning)}</b>`;
  } catch (e) {
    if (hint) hint.innerHTML = `<b>${escapeHtml(e.message)}</b>`;
  } finally {
    if (btn) btn.disabled = false;
  }
});

/* ---------------- 身份（QQ号 / 群号 ↔ openid） ---------------- */

/**
 * 为什么这一页存在：openid 是「每个 AppID 一套」的，换机器人就全变；
 * 号码不会变，但官方没有任何查询接口。只能人工指认一次。
 *
 * 页面数据来自三处，缺一样管理员就认不出「这是谁」：
 *   identity.json  已绑的号码（跨机器人共享）
 *   stats.db       这人活跃吗、说了多少条
 *   events 账本    最近说过什么（认人最快的一条线索）
 * 后两者关掉时对应列留空，页面照常能用——**不能白屏**。
 */
async function loadIdentity() {
  const ub = $('#identUserBody');
  const gb = $('#identGroupBody');
  try {
    const d = await api('/api/identity');
    renderIdentity(d);
  } catch (e) {
    const msg = `<tr><td colspan="5" class="empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
    if (ub) ub.innerHTML = msg;
    if (gb) gb.innerHTML = '<tr><td colspan="3" class="empty">加载失败</td></tr>';
  }
}

/** 这只鸟下「当前生效」的那条 claim：按 lastSeenAt 取最新，相等时后追加的优先 */
function currentClaim(rec, botId) {
  let best = null;
  for (const c of rec?.claims ?? []) {
    if (c.state !== 'active' || String(c.botId ?? '') !== String(botId ?? '')) continue;
    if (!best || (c.lastSeenAt || 0) >= (best.lastSeenAt || 0)) best = c;
  }
  return best;
}

function renderIdentity(d) {
  const botId = d?.bot ?? '';
  const users = d?.unresolved?.users ?? [];
  const groups = d?.unresolved?.groups ?? [];

  /* ---- 未识别的人 ---- */
  const ub = $('#identUserBody');
  if (ub) {
    ub.innerHTML = users.length
      ? users
          .map((u) => {
            const said = (u.recent ?? []).at(-1);
            const where = (u.chats ?? [])
              .slice(0, 2)
              .map((c) => escapeHtml(c.name || shortId(c.chatId)))
              .join('、');
            const tail = [
              where ? `<b>${where}</b>` : '',
              said ? escapeHtml(String(said.content ?? '').slice(0, 40)) : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return `<tr data-openid="${escapeHtml(u.userId)}">
              <td title="${escapeHtml(u.userId)}">${labelWithId(u.name, u.userId)}</td>
              <td>${u.lastSeen ? fmtAgo(u.lastSeen) : '-'}</td>
              <td>${u.messages || 0}</td>
              <td>${tail || '<span class="hint">还没有记录</span>'}</td>
              <td>
                <input class="ident-uin" placeholder="QQ号" inputmode="numeric" style="width:96px">
                <button class="btn small primary ident-bind">绑定</button>
                <div class="hint ident-err" hidden></div>
              </td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="5" class="empty">都认出来了。新来的人说过话之后会出现在这里。</td></tr>';
  }

  /* ---- 未识别的群 ---- */
  const gb = $('#identGroupBody');
  if (gb) {
    gb.innerHTML = groups.length
      ? groups
          .map(
            (g) => `<tr data-group="${escapeHtml(g.groupOpenid)}">
              <td title="${escapeHtml(g.groupOpenid)}">${labelWithId(g.name, g.groupOpenid)}</td>
              <td>${g.lastActiveAt ? fmtAgo(g.lastActiveAt) : '-'}</td>
              <td>
                <input class="ident-uin" placeholder="群号" inputmode="numeric" style="width:96px">
                <button class="btn small primary ident-bind">绑定</button>
                <div class="hint ident-err" hidden></div>
              </td>
            </tr>`,
          )
          .join('')
      : '<tr><td colspan="3" class="empty">都认出来了。</td></tr>';
  }

  /* ---- 已绑定 ---- */
  const bb = $('#identBoundBody');
  if (bb) {
    const all = [...(d?.users ?? []), ...(d?.groups ?? [])];
    bb.innerHTML = all.length
      ? all
          .map((rec) => {
            const isGroup = rec.kind === 'group';
            const uin = isGroup ? rec.groupUin : rec.uin;
            const mine = currentClaim(rec, botId);
            const active = (rec.claims ?? []).filter((c) => c.state === 'active');
            const last = active.reduce((a, c) => Math.max(a, c.lastSeenAt || 0), 0);
            const off = rec.status === 'disabled' ? ' <span class="badge off">已停用</span>' : '';
            return `<tr data-kind="${rec.kind}" data-uin="${escapeHtml(uin)}">
              <td>${isGroup ? '群' : '人'}${off}</td>
              <td class="mono">${escapeHtml(uin)}</td>
              <td class="mono" title="${escapeHtml(mine?.openid ?? '')}">${
                mine ? escapeHtml(shortId(mine.openid)) : '<span class="badge off">这只鸟没绑</span>'
              }</td>
              <td>${active.length} 条</td>
              <td>${last ? fmtAgo(last) : '-'}</td>
              <td><button class="btn small danger ident-unbind">解绑</button></td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="6" class="empty">还没有绑定。从上面两张表里认一个，填上号码就行。</td></tr>';
  }

  const hint = $('#identBoundHint');
  if (hint) {
    const n = (d?.users?.length ?? 0) + (d?.groups?.length ?? 0);
    hint.textContent = `跨机器人共享（${n} 条）。解绑只影响当前这只鸟，旧记录留痕不删。`;
  }
}

/** 绑定：409 时问一句要不要改绑（force） */
async function identBind({ kind, uin, openid, btn }) {
  const errBox = btn.parentElement.querySelector('.ident-err');
  const showErr = (m) => {
    if (!errBox) return;
    errBox.hidden = false;
    errBox.textContent = m;
  };
  if (!/^\d{5,12}$/.test(uin)) {
    showErr('号码要 5–12 位数字');
    return;
  }
  btn.disabled = true;
  if (errBox) errBox.hidden = true;
  try {
    await api('/api/identity/bind', {
      method: 'POST',
      body: JSON.stringify({ kind, uin, openid }),
    });
    await loadIdentity();
    return;
  } catch (e) {
    const msg = String(e.message ?? '');
    /**
     * 409 = 这个 openid 已经绑到别的号码上了。
     * 这不是错误，是「管理员改主意了」——问一句，确认后带 force 重发，
     * 旧号码那条 claim 会被标成失效（留痕不删）。
     */
    if (msg.includes('已经绑到')) {
      const ok = await confirmDialog({
        title: '这个 openid 已经有主了',
        message:
          `${escapeHtml(msg)}<br><br>` +
          `继续的话，旧号码上这条 openid 会被标成失效（<b>记录保留</b>），` +
          `然后绑到 <b>${escapeHtml(uin)}</b>。`,
        okText: '改绑',
        danger: true,
      });
      if (ok) {
        try {
          await api('/api/identity/bind', {
            method: 'POST',
            body: JSON.stringify({ kind, uin, openid, force: true }),
          });
          await loadIdentity();
          return;
        } catch (e2) {
          showErr(String(e2.message ?? '改绑失败'));
        }
      }
    } else {
      showErr(msg || '绑定失败');
    }
    btn.disabled = false;
  }
}

$('#btnIdentReload')?.addEventListener('click', loadIdentity);

/** 两张「未识别」表用同一套委托：表格每次整块重建，逐行绑事件会丢 */
for (const id of ['#identUserBody', '#identGroupBody']) {
  $(id)?.addEventListener('click', (e) => {
    const btn = e.target.closest('.ident-bind');
    if (!btn) return;
    const tr = btn.closest('tr');
    const input = tr.querySelector('.ident-uin');
    const isGroup = tr.hasAttribute('data-group');
    identBind({
      kind: isGroup ? 'group' : 'user',
      uin: String(input?.value ?? '').trim(),
      openid: isGroup ? tr.dataset.group : tr.dataset.openid,
      btn,
    });
  });
  // 回车即绑定：填个号码还要去点按钮太别扭
  $(id)?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('.ident-uin');
    if (!input) return;
    input.closest('tr')?.querySelector('.ident-bind')?.click();
  });
}

$('#identBoundBody')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.ident-unbind');
  if (!btn) return;
  const tr = btn.closest('tr');
  const kind = tr.dataset.kind;
  const uin = tr.dataset.uin;
  const ok = await confirmDialog({
    title: '解绑',
    message:
      `把 <b>${escapeHtml(uin)}</b> 在当前这只鸟上的绑定解掉？<br><br>` +
      `只是这条不再生效，<b>记录和旧 openid 都留着</b>——别的时候换回来还能用。`,
    okText: '解绑',
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  try {
    await api('/api/identity/unbind', {
      method: 'POST',
      body: JSON.stringify({ kind, uin }),
    });
    await loadIdentity();
  } catch (err) {
    btn.disabled = false;
    btn.parentElement.innerHTML = `<span class="hint">${escapeHtml(err.message ?? '解绑失败')}</span>`;
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

/**
 * 插件分级标签。
 *
 * 分级是**我们的判断**（写在插件仓的 verified.json 里），不是插件自述；
 * 签名是另一回事——它是「这份索引没被改过」的全体属性，所有签名插件
 * 都落同一个状态，所以不能做成档位。
 */
function verifyTag(p) {
  const map = {
    official: ['官方维护', 'vt-official', '跟着框架一起发布，代码在同一个仓库里'],
    reviewed: ['已复核', 'vt-reviewed', '我们看过代码、试过能跑，但不由我们维护'],
    self: ['作者自证', 'vt-self', '作者声明的内容，我们没有核对'],
  };
  const [label, cls, tip] = map[p.verified] || ['未验证', 'vt-none', '没有分级信息'];
  return `<span class="verify-tag ${cls}" title="${escapeHtml(tip)}">${label}</span>`;
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
  // 不再拼 key：SSE 也是普通同源请求，Cookie 会自动带上。
  // 以前把密钥拼在 EventSource 的地址上，每次重连都往反代 access log 写一次。
  const sp = new URLSearchParams();
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

/* ============================================================
   响应式导航外观（2026-11-06 重构新增）
   ------------------------------------------------------------
   这一整段只做「壳」：高亮、面包屑、抽屉开合、表格标签、theme-color。
   不调用任何数据加载函数，不改任何 API、轮询或 iframe 逻辑。
   ============================================================ */

/**
 * 页签切换后同步各处导航状态。
 * 由 activateTab() 末尾调用；切机器人 / hashchange 走的也是 activateTab，
 * 所以不需要额外注册第二套监听。
 */
function syncNav(name) {
  const nav = $('#mainNav');
  if (!nav) return;
  const btn = $$('[data-tab]').find(
    (b) => b.dataset.tab === name && b.classList.contains('tab-item'),
  );
  const crumb = $('#navCrumb');
  if (crumb) {
    crumb.textContent = btn ? btn.textContent.trim()
      : (name.startsWith('page:') ? '插件页面' : '概览');
  }
  // 停在非高频页时，底栏「更多」给个提示态，免得用户以为没有当前页
  const more = $('#navMore');
  if (more) more.classList.toggle('has-active', Boolean(btn) && !btn.hasAttribute('data-primary'));
  // 切到某个页签时把它所在的折叠组展开，否则用户看不到自己选中了哪一页
  const group = btn?.closest('.tab-group');
  if (group?.classList.contains('group-collapsed')) setGroupCollapsed(group, false);
  // 选完页就把抽屉 / 平板展开态收起来
  nav.classList.remove('drawer-open', 'expanded');
  const toggle = $('#navToggle');
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
  if (more) more.setAttribute('aria-expanded', 'false');
}

/* 侧栏偏好：纯外观状态，存 localStorage，不参与任何业务数据 */
const NAV_COMPACT_KEY = 'roost_nav_compact';
const NAV_GROUPS_KEY = 'roost_nav_groups';

/** 折叠 / 展开一个分组，并记住选择 */
function setGroupCollapsed(group, on) {
  if (!group) return;
  group.classList.toggle('group-collapsed', on);
  const key = group.dataset.group;
  if (!key) return;
  let list = [];
  try { list = JSON.parse(localStorage.getItem(NAV_GROUPS_KEY) || '[]'); } catch {}
  if (!Array.isArray(list)) list = [];
  const next = on ? [...new Set([...list, key])] : list.filter((x) => x !== key);
  try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next)); } catch {}
}

/** 恢复上次的收起 / 折叠状态；当前页所在组强制展开 */
function applyNavPrefs() {
  try {
    if (localStorage.getItem(NAV_COMPACT_KEY) === '1') {
      document.body.classList.add('nav-compact');
    }
    const list = JSON.parse(localStorage.getItem(NAV_GROUPS_KEY) || '[]');
    if (Array.isArray(list)) {
      $$('.app-nav .tab-group').forEach((g) => {
        if (list.includes(g.dataset.group)) g.classList.add('group-collapsed');
      });
    }
  } catch {}
  const active = $('.app-nav .tab-item.active')?.closest('.tab-group');
  if (active) setGroupCollapsed(active, false);
}

/**
 * 给表格单元格补 data-label，供窄屏卡片化的 td::before 使用。
 *
 * 12 张表的行几乎全是 JS 动态渲染的（app.js 里 80 多处 <td 模板），
 * 逐处改模板既伤业务代码又容易漏。这里用 MutationObserver 在 tbody
 * 内容变化时按 thead 的列序自动贴标签，纯展示、零业务侵入。
 * 空状态行（colspan）不贴，避免卡片上出现一个没有值的字段。
 */
function initTableLabels() {
  const labelsFor = (table) =>
    [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());

  const decorate = (tbody) => {
    const table = tbody.closest('table');
    if (!table) return;
    const labels = labelsFor(table);
    for (const tr of tbody.rows) {
      Array.from(tr.cells).forEach((td, i) => {
        if (td.hasAttribute('colspan') || !labels[i]) return;
        if (!td.dataset.label) td.dataset.label = labels[i];
      });
    }
  };

  const bodies = $$('table tbody');
  bodies.forEach(decorate);
  if (typeof MutationObserver === 'undefined') return;

  const mo = new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target;
      if (!t) continue;
      if (t.tagName === 'TBODY') decorate(t);
      else if (t.closest) {
        const tb = t.closest('tbody');
        if (tb) decorate(tb);
      }
    }
  });
  // subtree: 业务若往已有 <tr> 里追加 <td>（不是整块 innerHTML 替换）也要补标签
  bodies.forEach((tb) => mo.observe(tb, { childList: true, subtree: true }));
}

/** 手机浏览器地址栏跟随当前页面底色，纯展示，不碰主题 */
function initThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  /**
   * 直接读算出来的 `--bg`，不再维护「配色 → 两个颜色」的表。
   *
   * 表的问题是新加一套配色就得记得补一行，忘一次手机地址栏就是旧颜色；
   * 读计算值则连自定义主色、换底色都自动正确。rAF 是为了等这一帧的
   * 样式重算结束——属性刚改完时取计算值，读到的可能还是上一帧。
   */
  const apply = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta.setAttribute('content', bg);
  };
  apply();
  if (typeof MutationObserver === 'undefined') return;
  new MutationObserver(() => requestAnimationFrame(apply)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-palette', 'data-appearance'],
  });
}

(function initNavChrome() {
  const nav = $('#mainNav');
  if (!nav) return;
  const toggle = $('#navToggle');
  const more = $('#navMore');
  const close = $('#navClose');

  const setOpen = (on) => {
    // 只挂当前档位对应的 class：同时挂两个，用户拖动窗口跨断点时会残留另一个形态
    const isPhone = window.matchMedia('(max-width: 720px)').matches;
    nav.classList.toggle('drawer-open', on && isPhone);
    nav.classList.toggle('expanded', on && !isPhone);
    if (toggle) toggle.setAttribute('aria-expanded', String(on));
    if (more) more.setAttribute('aria-expanded', String(on));
  };

  toggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.matchMedia('(max-width: 720px)').matches) {
      // 手机：打开全量抽屉
      setOpen(!nav.classList.contains('drawer-open'));
    } else if (window.matchMedia('(min-width: 721px) and (max-width: 1023px)').matches) {
      // 平板：展开 / 收回 60px 图标条
      setOpen(!nav.classList.contains('expanded'));
    } else {
      // 桌面：收起 / 展开侧栏，记住选择
      const compact = !document.body.classList.contains('nav-compact');
      document.body.classList.toggle('nav-compact', compact);
      try { localStorage.setItem(NAV_COMPACT_KEY, compact ? '1' : '0'); } catch {}
      toggle.setAttribute('aria-expanded', String(!compact));
      toggle.title = compact ? '展开侧栏' : '收起侧栏';
    }
  });

  // 分组标题点击 = 折叠 / 展开下级菜单（snowluma 那种手风琴）
  $$('.app-nav .tab-parent').forEach((p) => {
    p.addEventListener('click', (e) => {
      e.stopPropagation();
      const g = p.closest('.tab-group');
      if (!g) return;
      // 收起态下点分组图标 = 「我想看这一组」，直接展开侧栏并展开该组
      if (document.body.classList.contains('nav-compact')
        && window.matchMedia('(min-width: 1024px)').matches) {
        document.body.classList.remove('nav-compact');
        try { localStorage.setItem(NAV_COMPACT_KEY, '0'); } catch {}
        setGroupCollapsed(g, false);
        return;
      }
      setGroupCollapsed(g, !g.classList.contains('group-collapsed'));
    });
  });

  more?.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(true);
  });
  close?.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  // 初始化：先恢复偏好，再补一次外观同步（无 hash 时 activateTab 不会被调用）
  applyNavPrefs();
  if (toggle) {
    toggle.title = document.body.classList.contains('nav-compact') ? '展开侧栏' : '收起侧栏';
  }
  syncNav(location.hash.slice(1) || 'overview');
  initTableLabels();
  initThemeColor();
})();

/* ---------------- P1 · 界面优化第二批（只增不减） ---------------- */
/*
 * 新增能力：配置页目录 / 未保存标记 / 空态引导 / 页面搜索 / 列显隐 / 底部状态条。
 * 约定：新 DOM 全部动态生成，不写进 index.html；不删任何原有 id、按钮、页面；
 * 不新增 CSS 变量、不动服务端。原有交互一个都不改道。
 */

/* ---- 空态：给「暂无数据」补一个可点的下一步动作 ---- */
function emptyAction(label, act) {
  return `<div class="empty-act"><button type="button" class="btn small" data-empty-act="${escapeHtml(act)}">${escapeHtml(label)}</button></div>`;
}

const EMPTY_ACTIONS = {
  'go-send': () => {
    const el = $('#sendTarget');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
  },
  'refresh-services': () => loadServices(),
  'clear-market': () => {
    const q = $('#marketSearch');
    const cat = $('#marketCat');
    if (q) { q.value = ''; MARKET.q = ''; }
    if (cat) { cat.value = ''; MARKET.tag = ''; }
    renderMarketRows();
  },
  'go-config': () => {
    activateTab('config');
    history.replaceState(null, '', '#config');
  },
};

document.addEventListener('click', (e) => {
  const btn = e.target?.closest?.('[data-empty-act]');
  if (!btn) return;
  EMPTY_ACTIONS[btn.dataset.emptyAct]?.();
});

/* ---- 配置页：锚点目录 + 凭证区未保存标记 ----
   只有「连接凭证」会出现未保存状态（其余区块都是改动即存），
   所以标记就落在区块自己身上（.is-dirty 的黄边），不再额外挂文字。
   底部保存条删掉之后，原来插在那里的 #cfgDirtyMark 已经没有容身之处。 */
function clearCfgDirty() {
  $$('#cfgForm > .box.is-dirty').forEach((b) => b.classList.remove('is-dirty'));
  $('#cfgForm')?.classList.remove('is-dirty');
}

function markCfgDirty(box) {
  if (box) box.classList.add('is-dirty');
}

function initConfigNav() {
  const form = $('#cfgForm');
  if (!form) return;
  const boxes = [...form.children].filter((el) => el.classList.contains('box'));

  const toc = document.createElement('div');
  toc.className = 'cfg-toc';
  const tocLabel = document.createElement('span');
  tocLabel.className = 'cfg-toc-label';
  tocLabel.textContent = '本页：';
  toc.appendChild(tocLabel);
  boxes.forEach((box, i) => {
    const title = box.querySelector('.box-hd h3')?.textContent?.trim() || `第 ${i + 1} 组`;
    if (!box.id) box.id = `cfgBox${i + 1}`;
    const a = document.createElement('a');
    a.href = `#${box.id}`;
    a.textContent = title;
    // 用 scrollIntoView 而不是改 hash：别把锚点写进深链
    a.addEventListener('click', (e) => {
      e.preventDefault();
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    toc.appendChild(a);
  });
  form.parentNode.insertBefore(toc, form);

  /**
   * 只有「连接凭证」需要标记未保存：其余区块都改完就落盘了，
   * 再给它们加黄边等于骗人。事件订阅有自己的「有改动未应用」。
   */
  const onEdit = (e) => {
    const el = e.target;
    if (!el?.closest) return;
    // 事件订阅块装在凭证 box 里，但它有自己的「有改动未应用」，别再给凭证挂黄边
    if (el.closest('.intents-block')) return;
    const box = el.closest('.box');
    if (box && box.parentElement === form && box.dataset.cfg === 'creds') markCfgDirty(box);
  };
  form.addEventListener('input', onEdit);
  form.addEventListener('change', onEdit);

  // 统一标记，别让「改了就生效」和「要点保存」靠散落的文字区分
  const badge = () => {
    const b = document.createElement('span');
    b.className = 'instant-badge';
    b.textContent = '改动即生效';
    return b;
  };
  /**
   * 只给「改动即存」的区块挂徽标。
   * 事件订阅**不能挂**：它要点「应用订阅」才生效（每次应用都会重连网关），
   * 挂上去等于告诉用户勾完就算数。
   */
  // 除凭证区之外，每个区块标题都挂一个，省得用户找保存按钮
  $$('#cfgForm > .box').forEach((box) => {
    if (box.dataset.cfg === 'creds') return;
    const hd = box.querySelector('.box-hd h3');
    if (hd && !hd.querySelector('.instant-badge')) hd.appendChild(badge());
  });
}

/* ---- Ctrl+K 页面搜索 / Ctrl+S 保存配置 ---- */
function initCommandPalette() {
  const mask = document.createElement('div');
  mask.className = 'cmd-mask';
  mask.id = 'cmdMask';
  mask.hidden = true;
  mask.innerHTML =
    '<div class="cmd-palette" role="dialog" aria-label="页面搜索">' +
    '<input class="cmd-input" id="cmdInput" placeholder="搜索页面…" autocomplete="off">' +
    '<ul class="cmd-list" id="cmdList"></ul>' +
    '<div class="cmd-foot"><span>↑↓ 选择</span><span>Enter 打开</span>' +
    '<span>Esc 关闭</span><span>Ctrl+S 保存当前配置</span></div>' +
    '</div>';
  document.body.appendChild(mask);
  const input = mask.querySelector('#cmdInput');
  const list = mask.querySelector('#cmdList');
  let shown = [];
  let idx = 0;

  const entries = () => {
    const seen = new Set();
    return $$('.tab[data-tab], .tab-item[data-tab]')
      .map((b) => ({
        name: b.dataset.tab,
        label:
          (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim() ||
          b.dataset.tab,
      }))
      .filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
  };
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    shown = entries().filter(
      (e) => e.label.toLowerCase().includes(q) || e.name.toLowerCase().includes(q),
    );
    idx = 0;
    list.innerHTML = shown.length
      ? shown
          .map(
            (e, i) =>
              `<li class="cmd-item${i === 0 ? ' cmd-active' : ''}" data-name="${escapeHtml(e.name)}">` +
              `<span>${escapeHtml(e.label)}</span><span class="cmd-key">${escapeHtml(e.name)}</span></li>`,
          )
          .join('')
      : '<li class="cmd-empty">没有匹配的页面</li>';
  };
  const move = (d) => {
    if (!shown.length) return;
    idx = (idx + d + shown.length) % shown.length;
    [...list.querySelectorAll('.cmd-item')].forEach((li, i) =>
      li.classList.toggle('cmd-active', i === idx),
    );
    list.querySelector('.cmd-active')?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => { mask.hidden = true; };
  const open = () => { mask.hidden = false; input.value = ''; paint(); input.focus(); };
  const pick = (i) => {
    const e = shown[i];
    if (!e) return;
    close();
    activateTab(e.name);
    history.replaceState(null, '', `#${e.name}`);
  };

  input.addEventListener('input', paint);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(idx); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.cmd-item');
    if (li) pick(shown.findIndex((x) => x.name === li.dataset.name));
  });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'k') { e.preventDefault(); mask.hidden ? open() : close(); return; }
    if (k === 's') {
      const panel = $('#tab-config');
      if (!panel || !panel.classList.contains('active')) return;
      e.preventDefault();
      $('#cfgForm')?.requestSubmit();
    }
  });
}

/* ---- 宽表的列显隐（默认全显示，行内操作列永远保留） ---- */
function initColumnToggle() {
  const tables = $$('main table').filter((t) => {
    const n = t.querySelectorAll('thead th').length;
    return n >= 5 && n <= 12;
  });
  tables.forEach((table) => {
    const heads = [...table.querySelectorAll('thead th')];
    const host = table.closest('.table-wrap') || table.parentElement;
    const bar = document.createElement('div');
    bar.className = 'col-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn col-btn';
    btn.textContent = '列显隐 ▾';
    const pop = document.createElement('div');
    pop.className = 'col-pop';
    pop.hidden = true;
    bar.append(btn, pop);
    host.parentNode.insertBefore(bar, host);

    const hidden = new Set();
    const apply = () => {
      table.querySelectorAll('tr').forEach((tr) => {
        // P2 的分组标题行只有一列，别按列索引误隐藏
        if (tr.dataset.groupHead) return;
        [...tr.children].forEach((cell, i) => {
          if (i < heads.length) cell.classList.toggle('col-hidden', hidden.has(i));
        });
      });
    };
    const head = document.createElement('div');
    head.className = 'col-pop-head';
    head.innerHTML =
      '<span>显示哪些列</span><button type="button" class="btn small" data-col-all>全部显示</button>';
    pop.appendChild(head);
    heads.forEach((th, i) => {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.col = String(i);
      // 末列通常是行内操作，禁止隐藏 = 功能永远可达
      if (i === heads.length - 1) cb.disabled = true;
      const txt = document.createElement('span');
      txt.textContent = (th.textContent || '').trim() || `第 ${i + 1} 列`;
      lab.append(cb, txt);
      pop.appendChild(lab);
    });
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; });
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.addEventListener('change', (e) => {
      const cb = e.target;
      if (!cb.dataset?.col) return;
      const i = Number(cb.dataset.col);
      if (i === heads.length - 1) { cb.checked = true; return; }
      if (cb.checked) hidden.delete(i); else hidden.add(i);
      apply();
    });
    head.querySelector('[data-col-all]')?.addEventListener('click', () => {
      hidden.clear();
      pop.querySelectorAll('input[data-col]').forEach((cb) => { cb.checked = true; });
      apply();
    });
    document.addEventListener('click', () => { if (!pop.hidden) pop.hidden = true; });
    // 动态重绘表格后重新套用；只观察 childList，改 class 不会自触发
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(apply).observe(table, { childList: true, subtree: true });
    }
  });
}

/* ---- 底部状态条：只做新增展示，顶栏 7 个元素一个都不搬 ---- */
function initStatusStrip() {
  if ($('#statusStrip')) return;
  const strip = document.createElement('div');
  strip.className = 'status-strip';
  strip.id = 'statusStrip';
  strip.innerHTML =
    '<span>栖 Roost</span>' +
    '<span id="ssVersion">版本 -</span>' +
    '<span id="ssMem">内存 -</span>' +
    '<span id="ssMsg">收发 -</span>' +
    '<span id="ssConn">状态 -</span>';
  document.body.appendChild(strip);
  document.body.classList.add('has-status-strip');
}

function updateStatusStrip(s) {
  if (!s || !$('#statusStrip')) return;
  const put = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  put('#ssVersion', `版本 ${s.version || '-'}`);
  put('#ssMem', `内存 ${s.memoryMB ?? '-'} MB`);
  put('#ssMsg', `收 ${s.counters?.recv ?? '-'} / 发 ${s.counters?.sent ?? '-'}`);
  put(
    '#ssConn',
    `状态 ${s.state === 'online' ? '在线' : s.state === 'starting' ? '连接中' : '离线'}`,
  );
}

(function initP1() {
  initStatusStrip();
  initConfigNav();
  initCommandPalette();
  initColumnToggle();
})();

/* ---------------- P2 · 真实数据进度条 / 加载态 / 表格工具 ---------------- */
/*
 * 仍然只增不减：新 DOM 全部动态生成，不写进 index.html；不删 id / 按钮 / 页面，
 * 不新增 CSS 变量，不动服务端。进度条一律用「本会话真实观测值」做基准，
 * 不假设官方 token 有效期或机器内存总量，避免画出编造的百分比。
 */

/* ---- 状态卡迷你条 + 连接心跳 ---- */
let credPeak = 0;
let memPeak = 0;
const statusTrail = [];

function paintMiniBar(valueEl, ratio, kind, note) {
  const card = valueEl?.closest('.card');
  if (!card) return;
  let bar = card.querySelector('.mini-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'mini-bar';
    bar.appendChild(document.createElement('i'));
    card.appendChild(bar);
    const n = document.createElement('div');
    n.className = 'mini-bar-note';
    card.appendChild(n);
  }
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  bar.querySelector('i').style.width = `${pct}%`;
  bar.classList.toggle('warn', kind === 'warn');
  bar.classList.toggle('danger', kind === 'danger');
  const n = card.querySelector('.mini-bar-note');
  if (n) n.textContent = note;
}

function renderHeartbeat() {
  let box = $('#hbBox');
  if (!box) {
    const cards = $('#tab-overview > .cards');
    if (!cards) return;
    box = document.createElement('div');
    box.className = 'box hb-box';
    box.id = 'hbBox';
    box.innerHTML =
      '<div class="hb-head"><b>连接心跳</b>' +
      '<span class="hint">最近 24 次状态推送 · 绿=在线 / 红=离线 / 灰=连接中或未知</span></div>' +
      '<div class="heartbeat" id="hbTrail"></div>';
    cards.parentNode.insertBefore(box, cards.nextSibling);
  }
  const trail = $('#hbTrail');
  if (!trail) return;
  trail.replaceChildren();
  for (let i = 0; i < 24; i++) {
    const d = document.createElement('span');
    d.className = `hb ${statusTrail[i] || 'unknown'}`;
    trail.appendChild(d);
  }
}

function updateMeters(s) {
  if (!s) return;
  // 凭证：以本会话见过的最大剩余秒数为基准，不写死官方有效期
  const cred = Number(s.credentialExpiresIn) || 0;
  credPeak = Math.max(credPeak, cred);
  const credEl = $('#c-cred');
  if (credEl) {
    const r = credPeak ? cred / credPeak : 0;
    paintMiniBar(
      credEl,
      r,
      r < 0.15 ? 'danger' : r < 0.35 ? 'warn' : '',
      credPeak ? `相对本次会话峰值 ${Math.round(credPeak / 60)} 分` : '等待凭证数据',
    );
  }
  // 内存：同样以会话峰值为基准，不假设机器内存总量
  const mem = Number(s.memoryMB) || 0;
  memPeak = Math.max(memPeak, mem);
  const memEl = $('#c-mem');
  if (memEl) {
    paintMiniBar(
      memEl,
      memPeak ? mem / memPeak : 0,
      '',
      memPeak ? `本次会话峰值 ${memPeak} MB` : '等待内存数据',
    );
  }
  statusTrail.push(s.state === 'online' ? 'ok' : s.state === 'starting' ? 'unknown' : 'down');
  if (statusTrail.length > 24) statusTrail.shift();
  renderHeartbeat();
}

/* ---- 体检三态条：只观察现有 DOM，不包装原加载函数 ---- */
function initDoctorMeter() {
  const list = $('#doctorList');
  const hd = $('#doctorBox .box-hd');
  if (!list || !hd || $('#doctorMeter')) return;
  const meter = document.createElement('div');
  meter.className = 'doctor-meter';
  meter.id = 'doctorMeter';
  meter.innerHTML = '<i class="dm-ok"></i><i class="dm-warn"></i><i class="dm-err"></i>';
  hd.appendChild(meter);
  const paint = () => {
    const items = [...list.querySelectorAll('.doctor-item')];
    const n = items.length || 1;
    const count = (c) => items.filter((x) => x.classList.contains(c)).length;
    const set = (cls, v) => {
      const el = meter.querySelector(`.dm-${cls}`);
      if (el) el.style.width = `${(v / n) * 100}%`;
    };
    set('ok', count('ok'));
    set('warn', count('warn'));
    set('err', count('error'));
    meter.title = `体检：${count('ok')} 正常 / ${count('warn')} 提醒 / ${count('error')} 异常`;
  };
  paint();
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(paint).observe(list, { childList: true });
  }
}

/* ---- 加载态：保留原「加载中…」文案，补三行骨架 ---- */
function markLoading(el) {
  if (!el?.classList || el.classList.contains('loading')) return;
  const t = (el.textContent || '').trim();
  if (!/加载中|正在读取|读取中|检查中/.test(t)) return;
  el.classList.add('loading');
  const lines = document.createElement('div');
  lines.className = 'loading-lines';
  lines.innerHTML = '<i></i><i></i><i></i>';
  el.appendChild(lines);
}
function upgradeLoading(root) {
  if (!root) return;
  root.querySelectorAll?.('.empty').forEach(markLoading);
  if (root.classList?.contains('empty')) markLoading(root);
}
function initLoadingSkeleton() {
  upgradeLoading(document);
  if (typeof MutationObserver === 'undefined') return;
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) upgradeLoading(n);
      // 有些空态是复用节点改文字，不是替换 innerHTML。
      // 限定只在 .empty 自身的文字变化时才扫，避免日志逐行 append 时全量遍历
      if (m.type === 'characterData' && m.target.parentElement?.classList?.contains('empty')) {
        upgradeLoading(m.target.parentElement);
      }
    }
  }).observe(document.querySelector('main') || document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

/* ---- 实时日志：偏离底部时给一个「滚动到底」圆钮 ---- */
function initScrollBottom() {
  const view = $('#logView');
  if (!view) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'scroll-bottom';
  btn.id = 'scrollBottom';
  btn.textContent = '↓';
  btn.title = '滚动到最新日志';
  btn.setAttribute('aria-label', '滚动到最新日志');
  btn.hidden = true;
  document.body.appendChild(btn);
  const sync = () => {
    const onLogPage = $('#tab-logs')?.classList.contains('active');
    const far = view.scrollHeight - view.scrollTop - view.clientHeight > 120;
    btn.hidden = !(onLogPage && far && $('#autoScroll')?.checked);
  };
  view.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('hashchange', () => setTimeout(sync, 60));
  document.addEventListener('click', (e) => {
    if (e.target?.closest?.('[data-tab]')) setTimeout(sync, 60);
  });
  btn.addEventListener('click', () => { view.scrollTop = view.scrollHeight; sync(); });
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(sync).observe(view, { childList: true });
  }
}

/* ---- 表格：分组折叠 / 行点选批量 / 表尾计数 / 导出所选 ---- */
function initTableTools() {
  const tables = $$('main table').filter(
    (t) => t.tBodies[0] && t.querySelectorAll('thead th').length >= 3,
  );
  tables.forEach((table) => {
    const heads = [...table.querySelectorAll('thead th')];
    const body = table.tBodies[0];
    const beforeEl = table.closest('.table-wrap') || table;
    const parent = beforeEl.parentNode;

    const tools = document.createElement('div');
    tools.className = 'table-tools';
    const gBtn = document.createElement('button');
    gBtn.type = 'button';
    gBtn.className = 'btn';
    gBtn.textContent = '按首列分组';
    const sBtn = document.createElement('button');
    sBtn.type = 'button';
    sBtn.className = 'btn';
    sBtn.textContent = '批量选择';
    tools.append(gBtn, sBtn);

    const foot = document.createElement('div');
    foot.className = 'table-foot';
    const count = document.createElement('span');
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn';
    exportBtn.textContent = '导出所选 CSV';
    exportBtn.disabled = true;
    foot.append(count, exportBtn);

    parent.insertBefore(tools, beforeEl);
    parent.insertBefore(foot, beforeEl.nextSibling);

    let grouped = false;
    let selectable = false;
    let suppress = false;
    const selected = new Set();
    const dataRows = () =>
      [...body.querySelectorAll('tr')].filter((tr) => !tr.dataset.groupHead);
    const realRows = () =>
      dataRows().filter(
        (tr) => !(tr.children.length === 1 && tr.querySelector('.empty')),
      );
    const paintCount = () => {
      count.textContent = `共 ${realRows().length} 行${selectable ? ` · 已选 ${selected.size}` : ''}`;
      exportBtn.disabled = !(selectable && selected.size > 0);
    };
    const hold = () => {
      suppress = true;
      setTimeout(() => { suppress = false; }, 0);
    };

    const clearGroups = () => {
      hold();
      body.querySelectorAll('tr[data-group-head]').forEach((tr) => tr.remove());
      dataRows().forEach((tr) => { tr.style.display = ''; delete tr.dataset.rowOf; });
    };
    const buildGroups = () => {
      clearGroups();
      const rows = dataRows();
      const groups = new Map();
      rows.forEach((tr) => {
        const key = (tr.children[0]?.textContent || '').trim() || '（空）';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tr);
      });
      // 首列几乎每行都不同（openid / 时间戳）时分组只会添乱，直接放弃
      if (rows.length < 4 || groups.size > Math.ceil(rows.length / 2)) {
        grouped = false;
        gBtn.classList.remove('on');
        toast('这张表首列取值太分散，不适合按首列分组');
        return;
      }
      hold();
      [...groups.entries()].reverse().forEach(([key, list]) => {
        const head = document.createElement('tr');
        head.dataset.groupHead = '1';
        const td = document.createElement('td');
        td.colSpan = heads.length;
        td.textContent = `▾ ${key}（${list.length}）`;
        head.appendChild(td);
        body.insertBefore(head, list[0]);
        list.forEach((tr) => { tr.dataset.rowOf = key; });
        head.addEventListener('click', () => {
          const collapsed = head.dataset.collapsed === '1';
          head.dataset.collapsed = collapsed ? '0' : '1';
          td.textContent = `${collapsed ? '▾' : '▸'} ${key}（${list.length}）`;
          list.forEach((tr) => { tr.style.display = collapsed ? '' : 'none'; });
        });
      });
      grouped = true;
      gBtn.classList.add('on');
    };

    gBtn.addEventListener('click', () => {
      if (grouped) { clearGroups(); grouped = false; gBtn.classList.remove('on'); }
      else buildGroups();
      paintCount();
    });
    sBtn.addEventListener('click', () => {
      selectable = !selectable;
      sBtn.classList.toggle('on', selectable);
      table.classList.toggle('table-selectable', selectable);
      if (!selectable) {
        selected.clear();
        body.querySelectorAll('.row-selected').forEach((tr) => tr.classList.remove('row-selected'));
      }
      paintCount();
    });
    body.addEventListener('click', (e) => {
      if (!selectable || e.target.closest('a,button,input')) return;
      const tr = e.target.closest('tr');
      if (!tr || tr.dataset.groupHead || !body.contains(tr)) return;
      if (selected.has(tr)) selected.delete(tr); else selected.add(tr);
      tr.classList.toggle('row-selected', selected.has(tr));
      paintCount();
    });
    exportBtn.addEventListener('click', () => {
      const rows = [...selected].filter((tr) => tr.isConnected && !tr.dataset.groupHead);
      if (!rows.length) return;
      const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const lines = [heads.map((th) => (th.textContent || '').trim())]
        .concat(rows.map((tr) => [...tr.children].map((td) => (td.textContent || '').trim())))
        .map((r) => r.map(esc).join(','))
        .join('\r\n');
      const blob = new Blob(['\ufeff' + lines], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `roost-table-${Date.now()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    paintCount();
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(() => {
        if (suppress) return;
        // 表格被重绘：分组标题行会随 innerHTML 一起消失，这里只重置状态
        grouped = false;
        gBtn.classList.remove('on');
        selected.clear();
        body.querySelectorAll('.row-selected').forEach((tr) => tr.classList.remove('row-selected'));
        paintCount();
      }).observe(body, { childList: true });
    }
  });
}

(function initP2() {
  initDoctorMeter();
  initLoadingSkeleton();
  initScrollBottom();
  initTableTools();
})();

/* ---------------- P1#8 · 插件卡片次要操作按需折叠 ---------------- */
/*
 * 盘点过 15 张表：只有「插件列表」行内是 4 个按钮（启用/重载/设置/卸载），
 * 其余表都是 1–2 个，收成菜单反而多一次点击。所以这里只处理插件卡片，
 * 而且**默认全部展开**：用户点「收起」才只留第一个按钮，再点恢复。
 * 按钮 DOM、class、data-act 与原有事件绑定一个都不动，只是切 hidden。
 */
function initPluginMore() {
  const list = $('#pluginList');
  if (!list) return;

  const paint = (card, toggle) => {
    const on = card.dataset.collapsed === '1';
    [...card.querySelectorAll(':scope > .btn')]
      .filter((b) => !b.classList.contains('plugin-more'))
      .forEach((b, i) => { b.hidden = on && i > 0; });
    toggle.textContent = on ? '⋯ 更多' : '收起';
    toggle.title = on ? '展开全部操作' : '收起次要操作，只保留第一个按钮';
    toggle.setAttribute('aria-expanded', String(!on));
  };

  const decorate = (card) => {
    let toggle = card.querySelector(':scope > .plugin-more');
    if (!toggle) {
      const acts = [...card.querySelectorAll(':scope > .btn')];
      if (acts.length < 3) return;
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn small plugin-more';
      toggle.setAttribute('aria-expanded', 'true');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        card.dataset.collapsed = card.dataset.collapsed === '1' ? '0' : '1';
        paint(card, toggle);
      });
      card.appendChild(toggle);
    }
    // 卡片可能被 applyUpdateMarks 追加了「更新」按钮，每次都按当前 DOM 重算
    paint(card, toggle);
  };

  const scan = () => $$('#pluginList .plugin').forEach(decorate);
  scan();
  if (typeof MutationObserver !== 'undefined') {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; scan(); });
    }).observe(list, { childList: true, subtree: true });
  }
}

(function initP18() {
  initPluginMore();
})();

/* ---------------- 开放平台（开发者后台） ----------------
 *
 * 和「配置」页的区别要说在前面：那边改的是**本机运行时**（AppID / 密钥 / intents），
 * 这边改的是**开放平台后台里的机器人资料与回调**。两条链的凭据完全不同：
 * 本页用的是开发者票据（账号级），机器人 token 碰不到这些字段。
 */

let DEV_CURRENT = '';
/**
 * 本机这只鸟：`{ id, name, appid }`，由后端按 `?bot=` 算好递下来。
 *
 * 面板只改它。账号级票据 + 一个账号下好几只机器人，允许在页面里随便挑
 * 就等于「一点就把线上那只能改坏」，所以这里不是「默认选中」，是**唯一目标**。
 */
let DEV_BOUND = null;
/** 当前是否已登录开放平台（勾选逻辑要据此决定「写不写盘」） */
let DEV_LOGGED_IN = false;
/** 当前机器人的详情（`loadDevBot` 拿回来的那份），改配置时用来比对「有没有变」 */
let DEV_BOT = null;
/** 体验白名单：测试用户 + 白名单群（每次切换机器人重读） */
let DEV_SCOPE = { users: [], groups: [], limits: {} };
/** 选好但还没保存的头像（dataURL，已缩到 256px） */
let DEV_AVATAR_DATA = '';

/** 扫码进行中的三个状态：面板据此禁用按钮、开着轮询 */
const DEV_SCAN_ACTIVE = ['starting', 'waiting', 'verifying'];
let devScanTimer = null;
/** 上次处理过的自动续期时间戳：轮询里靠它只重载一次列表 */
let DEV_AUTO_AT = 0;

function devSay(text, kind = '') {
  const el = $('#devLoginMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

function devScanSay(text, kind = '') {
  const el = $('#devScanMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

/**
 * 配置区的提示位。
 *
 * 不能复用 `devLoginMsg`——它在「备选：手动粘贴」折叠区里，用户保存配置时
 * 那段多半是收起来的，消息写进去等于没提示。
 */
function devEditSay(text, kind = '') {
  const el = $('#devEditMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

/** 头像那一行的提示位（上传进度 / 失败原因都写这里，别混进 devEditMsg） */
function devAvatarSay(text, kind = '') {
  const el = $('#devAvatarMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

/**
 * 把选中的图片裁成正方形并缩到 `size`，输出 **PNG**。
 *
 * 为什么是正方形：官方「修改机器人资料」里选了图之后要裁剪成正方形，
 * 我们提前裁好，省得平台上被居中切掉半个脑袋。
 * 为什么是 PNG：官方原话「建议使用 png 格式图片，以保持最佳效果」；
 * 而且 PNG 有 alpha，不会像 JPEG 那样把透明底压成黑边。
 * 为什么是 512：弹窗建议 144×144、创建页要求 240×240 以上，取 512
 * 既够清晰又远小于 2 MB 的上限。
 */
function devShrinkImage(dataUrl, size = 512) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      try {
        const side = Math.min(im.width || 0, im.height || 0);
        if (!side) throw new Error('读不到图片尺寸');
        // 居中裁一块正方形，再缩到目标尺寸
        const sx = Math.round((im.width - side) / 2);
        const sy = Math.round((im.height - side) / 2);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(im, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/png'));
      } catch (e) {
        reject(e);
      }
    };
    im.onerror = () => reject(new Error('这张图浏览器解不开'));
    im.src = dataUrl;
  });
}

/**
 * 扫码进度渲染。
 *
 * 状态机在后端（`src/dev/browser.js`），前端只照着 `scan.state` 画，
 * 不自己推——否则两边的判断迟早对不上（比如后端超时了前端还在转圈）。
 */
function devPaintScan(scan) {
  const btn = $('#devScanBtn');
  const cancelBtn = $('#devScanCancelBtn');
  if (!btn) return;

  const active = DEV_SCAN_ACTIVE.includes(scan?.state);
  btn.disabled = active;
  if (cancelBtn) cancelBtn.hidden = !active;

  if (scan?.state === 'starting') {
    btn.textContent = '正在打开浏览器…';
    devScanSay(scan.message || '正在启动浏览器…');
    return;
  }
  if (active) {
    btn.textContent = '等待扫码…';
    devScanSay(scan.message || '等待扫码…');
    return;
  }

  btn.textContent = scan?.state === 'ok' && scan?.alive ? '重新扫码' : '扫码登录';
  if (scan?.state === 'ok') devScanSay(scan.message || '登录成功', 'ok');
  else if (scan?.state === 'expired') devScanSay(scan.message || '等待超时，请重新发起扫码', 'error');
  else if (scan?.state === 'error') devScanSay(scan.message || '扫码启动失败', 'error');
  else if (scan?.state === 'canceled') devScanSay(scan.message || '已取消', 'error');
  // idle：保留 HTML 里的默认说明，不要用空字符串盖掉
}

/**
 * 「记住登录」两个勾（扫码区、备选区）永远同进退。
 *
 * 勾选状态以**用户的选择**为准（存在 localStorage），不再拿「本机有没有
 * dev-session.json」当唯一真相——那会把两件事混成一件：磁盘上有没有票，和
 * 用户想不想记住。踩过的坑：取消勾选后票据文件被删掉，前端一看 `loggedIn`
 * 是 false 就按「未登录默认勾上」把它画回勾选，用户刚取消的选择当场被覆盖，
 * 提示却还写着「已取消」。
 *
 * `remembered` 只在**没有存过偏好**时用来做初值（比如换了个浏览器）。
 */
const DEV_REMEMBER_KEY = 'roost.devRemember';

function devRememberPref() {
  try {
    const v = localStorage.getItem(DEV_REMEMBER_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null; // 隐私模式下 localStorage 会抛，按「没存过」处理
  }
}

function devSetRememberPref(on) {
  try {
    localStorage.setItem(DEV_REMEMBER_KEY, on ? '1' : '0');
  } catch { /* 存不了就只在这次页面里有效，不影响功能 */ }
}

function devPaintRemember(on) {
  for (const sel of ['#devScanRemember', '#devRemember']) {
    const box = $(sel);
    if (box) box.checked = Boolean(on);
  }
}

/** 「记住登录」那一行的提示位 */
function devRememberSay(text, kind = '') {
  const el = $('#devRememberMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

/**
 * 自动续期的状态行。
 *
 * 这条存在的唯一理由：续期会**真的弹一个浏览器窗口**。不说清楚，
 * 用户看到窗口自己冒出来只会以为出问题了。
 *
 * `loggedIn` 一起传进来：**没登录过就不谈换票**。续期的前提是「本机留着
 * 长期登录态」，前提不成立时它本来就不该跑，面板也不该在上面写换票的事。
 *
 * `updatedAt` 是当前票据的到手时间：**比失败还新的票 = 那条失败已经翻篇了**。
 * 后端在你登录成功时也会清掉这条记录，这里再兜一刀是为了老版本后端 / 老页面
 * 混跑时不把一句过期的结论一直挂在「已登录」下面。
 */
function devPaintAuto(a, loggedIn = true, updatedAt = 0) {
  const el = $('#devAutoMsg');
  if (!el) return;
  /** 「什么事都没发生」时的那句话，下面好几个分支要回到它 */
  const idleText = '票据过期时会在后台自动换新票（无头浏览器，不弹窗），拿到后自动关闭。';
  el.style.color = '';
  if (a?.enabled === false) {
    el.textContent = '自动续期已关闭（ROOST_DEV_AUTO_RELOGIN=0）：票据过期后要手动扫码。';
    return;
  }
  const last = a?.last;
  if (!loggedIn) {
    el.textContent = '还没登录：登录成功之后才会自动续期，现在不用管换票。';
    return;
  }
  if (last?.reason === 'running') {
    el.textContent = '票据过期了，正在后台换新票（不弹窗，拿到就关）…';
    return;
  }
  /**
   * 「让路」不是「失败」：人正在扫码，续期这一轮本来就不该插手（两边抢同一个
   * profile，窗口会互相关掉）。以前这里按失败画成红字 + 「5 分钟内不会再尝试」，
   * 于是刚点完扫码就看到「自动换票没成功」——纯粹自己吓自己。
   *
   * 扫码收尾后这条就过期了（人已经登上了），直接回到默认说明，不留旧结论。
   * `no-login`（本机没有 profile，换不了票）要留着说，那是需要人动手的。
   */
  if (last?.skipped) {
    if (last.reason === 'scan-busy' && a?.scanBusy === false) {
      el.textContent = idleText;
      return;
    }
    const t0 = new Date(last.at).toLocaleTimeString('zh-CN');
    el.textContent = `${t0} ${last.message || '正在扫码登录，自动换票先让路（扫完就有新票）'}。`;
    return;
  }
  /**
   * 换票成功但平台还没放开——这条必须写清楚「不用重新扫码」。
   * 否则用户看到「平台还在忙」还是会去点扫码，一扫又把窗口和限频拖回来。
   */
  if (a?.warmupPending) {
    el.textContent = '票据已换新（不用重新扫码），等平台放开后自动补一次，大约 65 秒。';
    return;
  }
  if (a?.warmup?.ok === true && a?.warmup?.at) {
    const t2 = new Date(a.warmup.at).toLocaleTimeString('zh-CN');
    el.textContent = `${t2} 平台已放开，补拉成功${a.warmup.botCount == null ? '' : `（${a.warmup.botCount} 只机器人）`}。`;
    return;
  }
  if (!last?.at) {
    el.textContent = idleText;
    return;
  }
  /**
   * 失败结论过期了：**手里这张票比那次失败还新**。
   *
   * 典型场面：扫码过程中自动换票被钩起来、跑满 25 秒只拿到半份票，留一条红字；
   * 几秒后人真的扫上了，票也换了一份，面板上却还挂着「自动换票没成功……3 分钟内
   * 不会再尝试」。人看到的是「已登录」和「登录失败」同时存在，只能反复点扫码。
   * 票已经换了，这条结论就不成立了，回到默认说明。
   */
  if (!last.ok && updatedAt && Number(last.at) < Number(updatedAt)) {
    el.textContent = idleText;
    return;
  }
  const t = new Date(last.at).toLocaleTimeString('zh-CN');
  if (last.ok) {
    el.textContent = `${t} 票据过期，已自动换新${last.message ? `（${last.message}）` : ''}。`;
  } else {
    el.style.color = 'var(--err)';
    const cool = Number(a?.retryInMs) > 0 ? `（${Math.ceil(a.retryInMs / 60_000)} 分钟内不会再自动尝试）` : '';
    el.textContent = `${t} 自动换票没成功：${last.message || last.reason}。点「扫码登录」手动补一次${cool}。`;
  }
}

function devPaintStatus(st) {
  const el = $('#devLoginState');
  if (!el) return;
  devPaintScan(st?.scan);
  devPaintAuto(st?.autoRelogin, Boolean(st?.loggedIn), Number(st?.updatedAt) || 0);
  /**
   * 勾选状态：**用户选过就按用户的**（localStorage），没选过才看磁盘。
   *
   * 这里绝不能按登录态去覆盖：取消勾选后 `loggedIn` 可能同时变 false（比如
   * 用户先退出登录再取消），覆盖回去就会「点了取消还是勾着」。
   */
  DEV_LOGGED_IN = Boolean(st?.loggedIn);
  const pref = devRememberPref();
  if (pref !== null) {
    devPaintRemember(pref);
  } else if (st?.loggedIn && typeof st?.remembered === 'boolean') {
    devPaintRemember(st.remembered);
  } else {
    // 第一次来、又没登录：默认勾上（这是「默认记住登录」的落点）
    devPaintRemember(true);
  }

  if (!st?.loggedIn) {
    el.textContent = '未登录：点「扫码登录」，或展开下面的备选区手动粘贴。';
    $('#devBotsBox').hidden = true;
    $('#devEditBox').hidden = true;
    return;
  }
  const when = st.updatedAt ? new Date(st.updatedAt).toLocaleString('zh-CN') : '未知';
  /**
   * 通道状态露出来是为了排查：默认请求走框架自己发，只有显式开了
   * `ROOST_DEV_PAGE_TRANSPORT=1` 才借扫码窗口的页面上下文。
   */
  const channel = st.scan?.alive ? ' · 扫码窗口已开（可直接看机器人页）' : ' · 扫码窗口已关，接口不受影响';
  /**
   * 限频冷却得说出来。平台回 `10000` 之后我们主动停手 60 秒，
   * 面板上如果只写「已登录」，用户点任何按钮都失败却不知道为什么。
   */
  const cool = Number(st.cooldownMs) > 0 ? ` · 平台限频，约 ${Math.ceil(st.cooldownMs / 1000)} 秒后自动恢复` : '';
  el.textContent = `已登录 · 票据更新于 ${when}${st.remembered ? ' · 已记住' : ' · 仅本次进程'}${channel}${cool}`;
}

function devStopScanWatch() {
  if (devScanTimer) {
    clearTimeout(devScanTimer);
    devScanTimer = null;
  }
}

/**
 * 轮询扫码状态。
 *
 * 用 setTimeout 串行而不是 setInterval：每次请求回来再排下一次，
 * 后端慢的时候不会堆一堆并发请求上去。
 */
async function devScanWatch() {
  devStopScanWatch();
  let st;
  try {
    st = await api('/api/dev/login/scan');
  } catch (e) {
    devScanSay('查询扫码状态失败：' + errText(e), 'error');
    return;
  }
  devPaintStatus(st);

  /**
   * 自动续期成功了就把列表重读一遍：换票意味着可能换了账号，
   * 不刷新的话面板还挂着上一个人的机器人。
   */
  const autoAt = Number(st?.autoRelogin?.last?.at) || 0;
  if (autoAt > DEV_AUTO_AT && st?.autoRelogin?.last?.ok) {
    DEV_AUTO_AT = autoAt;
    await loadDevBots();
    return;
  }

  if (DEV_SCAN_ACTIVE.includes(st?.scan?.state)) {
    devScanTimer = setTimeout(devScanWatch, 1200);
    return;
  }
  if (st?.scan?.state === 'ok') await loadDevBots();
}

async function loadDev() {
  let st;
  try {
    st = await api('/api/dev/status');
  } catch (e) {
    devScanSay('读取登录状态失败：' + errText(e), 'error');
    return;
  }
  // 没登录也要先把「本机是哪只鸟」画出来：扫码前用户得先确认改的是谁
  if (st?.bound) {
    DEV_BOUND = st.bound;
    paintDevBound();
  }
  devPaintStatus(st);
  /**
   * 老状态自愈：**用户明确取消过「记住」，但机器上还留着票据 / 扫码 profile**。
   *
   * 以前取消只删票据文件，扫码用的浏览器 profile 还在，于是后台续期照样能自动
   * 登录——用户看到「我明明没让它记住，怎么每次打开还在登录」。后端已经改成
   * 取消时连 profile 一起清，但**修复之前**取消过的人不会自己变干净，所以这里
   * 按用户的选择补一刀（幂等，且只在偏好明确为 false 时做）。
   */
  if (devRememberPref() === false && (st?.remembered === true || st?.profile === true)) {
    try {
      const out = await api('/api/dev/remember', {
        method: 'POST',
        body: JSON.stringify({ remember: false }),
      });
      if (typeof out?.remembered === 'boolean') devPaintRemember(out.remembered);
      devPaintStatus(out);
      /**
       * 后端顺带作废了那张已过期的票（`droppedExpired`）时要把话说全：
       * 用户以为只是「不保存」，实际内存里那份也用不了了，得重新扫码。
       */
      devScanSay(
        out?.droppedExpired
          ? '已按你的选择清掉本机登录记录，那张已过期的票也一并作废（后台不会再自动登录）'
          : '已按你的选择清掉本机登录记录（后台不会再自动登录）',
        'ok',
      );
      /** 用清理后的真实状态继续往下走，否则后面还会拿着旧状态去拉机器人列表（bound 保留） */
      st = { ...st, ...out };
    } catch {
      /* 后台清理失败不影响当前会话 */
    }
  }
  // 回显手填的浏览器路径，用户不用记得自己上次填了什么
  const bp = $('#devBrowserPath');
  if (bp && document.activeElement !== bp) bp.value = String(st?.browserPath || '');
  if (DEV_SCAN_ACTIVE.includes(st?.scan?.state)) devScanWatch();
  if (!st?.loggedIn) return;
  await loadDevBots();
}

/** 「当前机器人」这一块的提示位（登错号、账号里没这只，都写这里） */
function devBoundSay(text, kind = '') {
  const el = $('#devBoundMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

/** 把「本机这只鸟」画出来：扫码前就要能看到改的是谁，不能等登录完才显示 */
function paintDevBound() {
  const name = DEV_BOUND?.name || '';
  const appid = DEV_BOUND?.appid || '';
  const inline = $('#devBoundInline');
  if (inline) inline.textContent = appid ? `${name}，AppID ${appid}` : `${name || '当前机器人'}（还没填 AppID）`;
  const n = $('#devBoundName');
  if (n) n.textContent = name || '没找到当前机器人';
  const a = $('#devBoundAppid');
  if (a) a.textContent = appid ? `AppID ${appid} · 这个页面只会改它` : '本机配置里没有 AppID';
}

/**
 * 「能不能干活」的全部判断都交给后端 `/api/dev/session?verify=1`。
 *
 * 以前是「列表 + 本地选中」两段各判一半，出现过的坑是：账号里一只都没有，
 * 面板依旧显示「已登录」并让用户去改——点下去才 11001。现在六个状态由后端
 * 给（`ready` / `account-empty` / `bot-missing` / `no-appid` / `busy` /
 * `expired`），前端只负责照着渲染，不在两处各推一遍。
 */
/**
 * 「等平台放开」时的一次性自动刷新。
 *
 * 只排一次，不做轮询：这时候平台本来就不接受请求，轮询除了加深限频没好处。
 * 真按后端给的 `retryAfterMs` 醒过来一次就够。
 */
let devWakeTimer = null;
/** 自动唤醒已经试过几次：防止「一直没放开」时每 66 秒无限重来 */
let devWakeCount = 0;
function scheduleDevWake(ms) {
  if (devWakeTimer) clearTimeout(devWakeTimer);
  devWakeTimer = setTimeout(() => {
    devWakeTimer = null;
    loadDevBots();
  }, Math.max(1000, Number(ms) || 66_000));
}

async function loadDevBots() {
  let st;
  try {
    st = await api('/api/dev/session?verify=1');
  } catch (e) {
    devEditSay('检查登录状态失败：' + errText(e), 'error');
    return;
  }
  DEV_BOUND = st?.bound || DEV_BOUND;
  paintDevBound();
  $('#devBotsBox').hidden = false;
  $('#devBotCount').textContent = st?.botCount == null ? '' : `账号下共 ${st.botCount} 只`;

  if (st?.state === 'ready') {
    if (devWakeTimer) { clearTimeout(devWakeTimer); devWakeTimer = null; }
    devWakeCount = 0;
    devBoundSay(st.message || '可以改。', 'ok');
    DEV_CURRENT = String(st.bot?.appid || DEV_BOUND?.appid || '');
    await loadDevBot(DEV_CURRENT);
    return;
  }

  /**
   * 「票已经换好、平台还没放开」——**不是失败**，是等一会。
   *
   * 换票成功之后不再连打（连打只会把平台恢复时间往后推），后端已经排了一次
   * 65 秒后的补拉。这里只做两件事：把话说清楚（不用重新扫码），并照着同一个
   * 时间自己醒来刷新一次。
   */
  if (st?.state === 'renewed-wait') {
    $('#devEditBox').hidden = true;
    $('#devScopeBox').hidden = true;
    DEV_SCOPE = { users: [], groups: [], limits: {} };
    DEV_BOT = null;
    const wait = Math.ceil(Number(st?.retryAfterMs || 65_000) / 1000);
    /**
     * 自动刷新最多 3 次。平台真长时间不放开的（极少见）如果一直排下去，就变成
     * 每 66 秒打一次接口的循环，反而更难恢复。到次数就把动作交给用户。
     */
    if (devWakeCount >= 3) {
      devBoundSay('票据已换新，但平台一直没放开。过一会再来看，或点「扫码登录」重新登一次。', 'error');
      devEditSay('');
      return;
    }
    devWakeCount += 1;
    devBoundSay(`票据已换新（不用重新扫码），平台还没放开；约 ${wait} 秒后自动刷新（第 ${devWakeCount} 次）。`, '');
    devEditSay('');
    scheduleDevWake(wait * 1000 + 1500);
    return;
  }

  /**
   * 每种「不能改」都写清为什么 + 下一步。`hint` 是后端码表给的，
   * 前端不重复维护一份文案（改口径只改一处）。
   */
  $('#devEditBox').hidden = true;
  // 白名单同样收起来：账号里没这只鸟的时候，列出名单只会让人以为「能改」
  $('#devScopeBox').hidden = true;
  DEV_SCOPE = { users: [], groups: [], limits: {} };
  DEV_BOT = null;
  const tail = st?.hint ? ` ${st.hint}` : '';
  const text = `${st?.message || '现在不能改'}。${tail}`;
  devBoundSay(text, 'error');
  devEditSay('');
}

async function loadDevBot(appid) {
  if (!appid) return;
  let bot;
  try {
    ({ bot } = await api('/api/dev/bot?appid=' + encodeURIComponent(appid)));
  } catch (e) {
    devEditSay('读机器人配置失败：' + errText(e), 'error');
    return;
  }
  DEV_BOT = bot;
  $('#devEditBox').hidden = false;
  $('#devEditHint').textContent = `appid ${bot.appid}`;
  /**
   * 顺手把扫码窗口切到这个机器人的设置页。
   *
   * 管理端是「列表 → 点进详情」两层，只停在列表上时用户还得自己找一遍；
   * 面板选了谁，窗口就跟到谁，两边不至于看串。失败无所谓——窗口不在
   * （例如走的是粘贴 Cookie）就只是个 `opened:false`。
   */
  api('/api/dev/focus', { method: 'POST', body: JSON.stringify({ appid: bot.appid }) }).catch(() => {});
  $('#devName').value = bot.base?.name ?? '';
  $('#devDesc').value = bot.base?.desc ?? '';
  $('#devWebhook').value = bot.connect?.webhookUrl ?? '';
  $('#devIps').value = (bot.ipWhitelist ?? []).join('\n');

  /**
   * 头像：预览当前那张，并把「待选的」清掉。
   *
   * 清 `DEV_AVATAR_DATA` 很重要——不清的话，用户换完头像再点一次「保存头像」，
   * 会拿上一张已经用过的图再传一次，白耗一次平台的修改次数。
   */
  DEV_AVATAR_DATA = '';
  const avSrc = $('#devAvatarSrc');
  if (avSrc) avSrc.value = '';
  const avImg = $('#devAvatarImg');
  const avSrcRaw = String(bot.base?.avatar || '').trim();
  /**
   * 只有真·图片地址才塞进 `src`。
   *
   * 平台回的 `bot_avatar` 绝大多数时候是图床 URL，但也见过只给一个
   * `avatar_id` 的情况——那种塞进 `src` 只会得到 `http://host/<id>` 这种
   * 必然 404 的地址，界面留一个裂图标，比明说「预览不了」更糟。
   */
  const viewable = /^(https?:|data:|blob:)/i.test(avSrcRaw);
  if (avImg) {
    if (viewable) {
      avImg.src = avSrcRaw;
      avImg.dataset.empty = '0';
      avImg.title = avSrcRaw;
    } else {
      avImg.removeAttribute('src');
      avImg.dataset.empty = '1';
      avImg.title = avSrcRaw ? `avatar_id ${avSrcRaw}` : '平台侧还没有头像';
    }
  }
  if (!avSrcRaw) devAvatarSay('平台侧还没有头像');
  else if (!viewable) devAvatarSay(`平台只回了 avatar_id（${avSrcRaw}），不是图片地址，这里预览不了；换过一张图就会显示`, '');
  else devAvatarSay('');
  $('#devBotMeta').textContent = [
    bot.developer?.adminName ? `管理员 ${bot.developer.adminName}` : '',
    bot.connect?.mode === 3 ? '当前 WebSocket' : bot.connect?.mode ? '当前 Webhook' : '',
    bot.base?.modifyRemain != null ? `资料可改 ${bot.base.modifyRemain} 次` : '',
  ].filter(Boolean).join(' · ');
  devEditSay('');
  // 白名单和资料是两个接口，串行拉：这一只的资料先画出来，名单晚一点不影响
  await loadDevScope(bot.appid);
}

function devScopeSay(text, kind = '') {
  const el = $('#devScopeMsg');
  if (!el) return;
  el.textContent = String(text ?? '');
  el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
}

/**
 * 白名单两块的渲染。
 *
 * 「不在群内」单独标出来，是因为它不是失败：官方允许先把群号加进白名单，
 * 机器人再被拉进群。不标的话用户会以为加错了，反复删了再加。
 */
function devPaintScope() {
  const box = $('#devScopeBox');
  if (!box) return;

  const users = Array.isArray(DEV_SCOPE.users) ? DEV_SCOPE.users : [];
  const groups = Array.isArray(DEV_SCOPE.groups) ? DEV_SCOPE.groups : [];
  const maxGroups = Number(DEV_SCOPE.limits?.groups) || 20;

  const uList = $('#devUserList');
  if (uList) {
    uList.innerHTML = users.length
      ? users.map((u) => `
        <div class="dev-scope-item">
          <div class="dev-scope-item-main">
            <span class="dev-scope-item-name">${escapeHtml(u.name || '（平台没给昵称）')}</span>
            <span class="dev-scope-item-id">${escapeHtml(u.uin)}</span>
          </div>
          <button type="button" class="btn small" data-scope-remove="users" data-id="${escapeHtml(u.uin)}">移除</button>
        </div>`).join('')
      : '<div class="dev-scope-empty">还没有测试用户。发布前只有名单里的人能私聊调试。</div>';
  }

  const gList = $('#devGroupList');
  if (gList) {
    gList.innerHTML = groups.length
      ? groups.map((g) => `
        <div class="dev-scope-item">
          <div class="dev-scope-item-main">
            <span class="dev-scope-item-name" title="${escapeHtml(g.name || g.groupId)}">${escapeHtml(g.name || '未知群名')}</span>
            <span class="dev-scope-item-id">${escapeHtml(g.groupId)}</span>
            ${g.inGroup === false ? '<span class="dev-scope-item-warn">机器人不在这个群</span>' : ''}
          </div>
          <button type="button" class="btn small" data-scope-remove="groups" data-id="${escapeHtml(g.groupId)}">移除</button>
        </div>`).join('')
      : '<div class="dev-scope-empty">还没有白名单群。</div>';
  }

  $('#devUserCount').textContent = `${users.length} 个`;
  $('#devGroupCount').textContent = `${groups.length} / ${maxGroups}`;
  $('#devScopeHint').textContent = `appid ${DEV_SCOPE.appid || DEV_CURRENT || ''}`;
}

async function loadDevScope(appid) {
  const id = String(appid || '').trim();
  if (!id) return;
  const box = $('#devScopeBox');
  try {
    const out = await api('/api/dev/scope?appid=' + encodeURIComponent(id));
    DEV_SCOPE = { users: out.users || [], groups: out.groups || [], limits: out.limits || {}, appid: out.appid || id };
    if (box) box.hidden = false;
    devScopeSay('');
    devPaintScope();
  } catch (e) {
    // 读不到名单不影响改资料，所以不隐藏整页，只在这里说清楚
    DEV_SCOPE = { users: [], groups: [], limits: {}, appid: id };
    if (box) box.hidden = false;
    devPaintScope();
    devScopeSay('读白名单失败：' + errText(e), 'error');
  }
}

/**
 * 加 / 删一条。
 *
 * 不弹二次确认：删的是「名单里一个人/一个群」，不是删机器人。平台那边
 * 加回来也只是填一次号码，代价远小于每次都被 confirm 打断。
 */
async function devScopeChange(kind, action, ids, label) {
  if (!DEV_CURRENT) return;
  const who = DEV_BOT?.base?.name || DEV_CURRENT;
  devScopeSay(action === 1 ? `正在添加${label}…` : `正在移除${label} ${ids.join('、')}…`);
  try {
    await api('/api/dev/scope', {
      method: 'POST',
      body: JSON.stringify({ appid: DEV_CURRENT, kind, action, ids }),
    });
    // 回读平台侧真实状态，不用本地数组「猜」成功
    await loadDevScope(DEV_CURRENT);
    devScopeSay(`${action === 1 ? '已添加' : '已移除'}：${ids.join('、')}（${who}）`, 'ok');
    return true;
  } catch (e) {
    devScopeSay(`${action === 1 ? '添加' : '移除'}失败：` + errText(e), 'error');
    return false;
  }
}

async function devSave(patch, what) {
  if (!DEV_CURRENT) return;
  // 报「改哪只」时带上名字：账号下好几只时，只说 appid 用户对不上号
  const who = DEV_BOT?.base?.name || DEV_CURRENT;
  if (!window.confirm(`确认修改「${who}」（AppID ${DEV_CURRENT}）的${what}？`)) return;
  try {
    const out = await api('/api/dev/bot', {
      method: 'POST',
      body: JSON.stringify({ appid: DEV_CURRENT, patch }),
    });
    // 先回读再报成功：loadDevBot 会清空提示位，顺序反了用户就看不到「已保存」
    await loadDevBot(DEV_CURRENT);
    devEditSay(`已保存：${(out.parts || []).join(' / ')}`, 'ok');
  } catch (e) {
    devEditSay('保存失败：' + errText(e), 'error');
  }
}

(function initDev() {
  /* ---------------- 记住登录（勾/取消立刻生效） ----------------
   *
   * 以前这个勾只在「点扫码登录 / 点导入」那一刻被读一次，已经登录的情况下
   * 勾它什么都不会发生，刷新页面又空回去——用户看到的现象就是「少了个保存
   * 按钮」。现在它自己就是个开关：勾上 = 把内存里的票据写盘，取消 = 删盘
   * （登录态仍在，只是重启要重登），两边都不需要重新登录。
   */
  const devSetRemember = async (on) => {
    const want = Boolean(on);

    /**
     * 没登录时这里没有任何票可以写盘或删——以前照样发请求，必然回
     * `401 NOT_LOGGED_IN`，然后把勾弹回去，用户观感是「勾不动」。
     * 现在只记下意图：下次登录时按它决定要不要保存。
     */
    if (!DEV_LOGGED_IN) {
      devSetRememberPref(want);
      devPaintRemember(want);
      devRememberSay(
        want ? '已记住：下次登录会保存票据，重启不用重扫' : '已取消：下次登录不保存，重启要重新扫码',
        'ok',
      );
      return;
    }

    devRememberSay(want ? '正在写入本机…' : '正在删除本机票据…');
    try {
      const out = await api('/api/dev/remember', {
        method: 'POST',
        body: JSON.stringify({ remember: want }),
      });
      /**
       * 以**后端实际结果**为准记住这次选择：勾上但写盘失败时，不能显示成
       * 「已记住」。同时把偏好落下来，刷新/退出登录都不会把它冲掉。
       */
      const actual = typeof out?.remembered === 'boolean' ? out.remembered : want;
      devSetRememberPref(actual);
      devPaintRemember(actual);
      devPaintStatus(out);
      /**
       * `droppedExpired`：这张票本来就已被平台判过期，后端在取消「记住」时
       * 一并作废了。必须说出来——否则用户会以为「我只是取消保存」，
       * 下次要改机器人时才发现得重新扫码。
       */
      devRememberSay(
        out?.droppedExpired
          ? '已取消：本机票据已删，那张已被判过期的票也一并作废——需要时重新扫码登录'
          : out?.remembered
            ? '已记住：重启框架不用重扫（票据存在 data/dev-session.json，权限 0600）'
            : '已取消：票据只在这次进程里有效，重启要重新扫码',
        'ok',
      );
    } catch (e) {
      // 失败要把勾弹回去，不能让界面显示一个没生效的状态
      devSetRememberPref(!want);
      devPaintRemember(!want);
      devRememberSay('改不了：' + errText(e), 'error');
    }
  };

  $('#devScanRemember')?.addEventListener('change', (e) => devSetRemember(e.target.checked));
  $('#devRemember')?.addEventListener('change', (e) => devSetRemember(e.target.checked));

  /* ---------------- 扫码（主路径） ---------------- */

  $('#devScanBtn')?.addEventListener('click', async () => {
    const btn = $('#devScanBtn');
    devStopScanWatch();
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在打开浏览器…';
    }
    devScanSay('正在启动浏览器…');
    try {
      /**
       * 这个请求会**同步等到窗口就绪**才返回（通常 1–3 秒），
       * 所以按钮在期间保持禁用，避免用户连点开出多个窗口。
       */
      const st = await api('/api/dev/login/scan', {
        method: 'POST',
        body: JSON.stringify({ remember: Boolean($('#devScanRemember')?.checked) }),
      });
      devPaintStatus(st);
      if (DEV_SCAN_ACTIVE.includes(st?.scan?.state)) devScanWatch();
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '扫码登录';
      }
      devScanSay('启动扫码失败：' + errText(e), 'error');
    }
  });

  $('#devScanCancelBtn')?.addEventListener('click', async () => {
    devStopScanWatch();
    try {
      devPaintStatus(await api('/api/dev/login/scan/cancel', { method: 'POST' }));
    } catch (e) {
      devScanSay('取消失败：' + errText(e), 'error');
    }
  });

  /* ---------------- 手动检查登录状态（自动检测漏了时的兜底） ----------------
   *
   * 自动检测再稳也有漏的时候：轮询正在退避、页面登录慢半拍、票刚种上又被页面
   * 刷掉、或者用户扫完顺手把窗口关了。以前唯一的自救办法是「再扫一次码」，
   * 扫多了窗口和限频反而更难恢复。这个按钮只做一件小事：立刻核一次。
   */
  $('#devRecheckBtn')?.addEventListener('click', async () => {
    const btn = $('#devRecheckBtn');
    const label = btn?.textContent || '检查登录状态';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '检查中…';
    }
    try {
      const out = await api('/api/dev/login/recheck', { method: 'POST' });
      devPaintStatus(out);
      const r = out?.recheck || {};
      if (r.ok) {
        devScanSay(r.message || '已确认登录', 'ok');
        await loadDevBots();
      } else {
        devScanSay(r.message || '没检测到登录态', 'error');
      }
    } catch (e) {
      devScanSay('检查失败：' + errText(e), 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  });

  /* ---------------- 备选：手动粘贴 ---------------- */

  $('#devImportBtn')?.addEventListener('click', async () => {
    const input = $('#devCookieInput')?.value?.trim() || '';
    if (!input) {
      devSay('先粘贴 Cookie 或 cURL', 'error');
      return;
    }
    devSay('正在验证票据…');
    try {
      const out = await api('/api/dev/login/import', {
        method: 'POST',
        body: JSON.stringify({ input, remember: Boolean($('#devRemember')?.checked) }),
      });
      devSay(`登录成功，账号下读到 ${out.botCount} 个机器人`, 'ok');
      $('#devCookieInput').value = '';
      devPaintStatus(out);
      await loadDevBots();
    } catch (e) {
      devSay('导入失败：' + errText(e), 'error');
    }
  });

  $('#devLogoutBtn')?.addEventListener('click', async () => {
    if (!window.confirm('退出后本机保存的票据会被删除，确认？')) return;
    devStopScanWatch();
    await api('/api/dev/logout', { method: 'POST' }).catch(() => {});
    DEV_CURRENT = '';
    DEV_BOT = null;
    devSay('已退出', 'ok');
    devScanSay('已退出。需要重新登录时点「扫码登录」。', 'ok');
    // 票据文件已被删；勾保持用户之前的选择，别在这里替他改主意
    const keep = devRememberPref() !== false;
    devRememberSay(
      keep
        ? '已退出：本机保存的票据已删除，下次登录仍会记住'
        : '已退出：本机保存的票据已删除，下次登录也不保存',
      'ok',
    );
    devPaintStatus({ loggedIn: false });
  });

  $('#devOpenDashBtn')?.addEventListener('click', () => {
    window.open('https://q.qq.com/qqbot/dashboard/', '_blank', 'noopener');
  });

  /* ---------------- 手填浏览器路径 ---------------- */

  const devBrowserSay = (text, kind = '') => {
    const el = $('#devBrowserMsg');
    if (!el) return;
    el.textContent = String(text ?? '');
    el.style.color = kind === 'error' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : '';
  };

  const devSaveBrowserPath = async (path) => {
    try {
      const out = await api('/api/dev/browser', {
        method: 'POST',
        body: JSON.stringify({ path }),
      });
      const saved = String(out?.browserPath || '');
      const input = $('#devBrowserPath');
      if (input) input.value = saved;
      devBrowserSay(saved ? `已保存：${saved}` : '已改回自动探测（Edge → Chrome → Chromium → Brave → Vivaldi）', 'ok');
    } catch (e) {
      devBrowserSay('保存失败：' + errText(e), 'error');
    }
  };

  $('#devBrowserSave')?.addEventListener('click', () => {
    const p = $('#devBrowserPath')?.value?.trim() || '';
    if (!p) {
      devBrowserSay('先填一个可执行文件路径', 'error');
      return;
    }
    devSaveBrowserPath(p);
  });

  $('#devBrowserClear')?.addEventListener('click', () => devSaveBrowserPath(''));

  /* ---------------- 配置：一框一存 ----------------
   *
   * 平台把「资料 / 连接 / 白名单」分开计次数，合并提交会出现「一半成功」，
   * 用户也说不清是哪条没生效。所以每个输入框配自己的按钮，只发自己那一项。
   */
  const devBotNow = () => DEV_BOT?.base || {};

  $('#devSaveName')?.addEventListener('click', () => {
    if (!DEV_CURRENT) return;
    const name = ($('#devName')?.value || '').trim();
    if (!name) {
      devEditSay('昵称不能是空的', 'error');
      return;
    }
    if (name === (devBotNow().name || '')) {
      devEditSay('昵称没变，不用保存', 'error');
      return;
    }
    devSave({ base: { name } }, '昵称');
  });

  $('#devSaveDesc')?.addEventListener('click', () => {
    if (!DEV_CURRENT) return;
    const desc = ($('#devDesc')?.value || '').trim();
    if (desc === (devBotNow().desc || '')) {
      devEditSay('简介没变，不用保存', 'error');
      return;
    }
    devSave({ base: { desc } }, '简介');
  });

  /* ---------------- 头像 ---------------- */

  /**
   * 头像拉不下来（图床 403、地址过期、被策略拦）时别留一个裂图标：
   * 退回灰圈占位，并说清是「预览失败」而不是「没有头像」——两者下一步完全不同。
   */
  $('#devAvatarImg')?.addEventListener('error', () => {
    const img = $('#devAvatarImg');
    if (!img || img.dataset.empty === '1') return;
    img.dataset.empty = '1';
    img.removeAttribute('src');
    devAvatarSay('这张头像预览不出来（图床拒绝或地址已过期），不影响换新图', 'error');
  });

  $('#devAvatarPick')?.addEventListener('click', () => $('#devAvatarFile')?.click());

  $('#devAvatarFile')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // 源图只要求浏览器能解开；真正的格式/大小限制在裁完之后的 PNG 上
    if (!/^image\//i.test(file.type)) {
      devAvatarSay('要选图片文件', 'error');
      return;
    }
    if (file.size > 16 * 1024 * 1024) {
      devAvatarSay('这张图超过 16 MB，先自己压一下', 'error');
      return;
    }
    devAvatarSay('正在读图…');
    const raw = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (!raw) {
      devAvatarSay('读这个文件失败，换一张试试', 'error');
      return;
    }
    let small;
    try {
      small = await devShrinkImage(raw, 512);
    } catch (err) {
      devAvatarSay('处理这张图失败：' + err.message, 'error');
      return;
    }
    /**
     * 官方上限 2 MB。512 的 PNG 正常只有几百 KB，但极端图（大片噪点）
     * 也会顶上去——这里量的是 base64 解码后的字节数，不是字符串长度。
     */
    const bytes = Math.round((small.length - small.indexOf(',') - 1) * 0.75);
    if (bytes > 2 * 1024 * 1024) {
      devAvatarSay(`裁完还有 ${(bytes / 1024 / 1024).toFixed(1)} MB，超过官方的 2 MB 上限，换张简单的图`, 'error');
      return;
    }
    DEV_AVATAR_DATA = small;
    const img = $('#devAvatarImg');
    if (img) {
      img.src = small;
      img.dataset.empty = '0';
    }
    const src = $('#devAvatarSrc');
    if (src) src.value = '';
    devAvatarSay(`已选 ${file.name} → 正方形 ${Math.round(bytes / 1024)} KB PNG（上传前会再用这个尺寸），点「保存头像」`, 'ok');
  });

  $('#devSaveAvatar')?.addEventListener('click', async () => {
    if (!DEV_CURRENT) return;
    const raw = String($('#devAvatarSrc')?.value || '').trim();
    const body = { appid: DEV_CURRENT };
    if (raw) {
      // 填了 http(s) 就当图片来源；否则当成官方页面给的 avatar_id 直接用
      if (/^https?:\/\//i.test(raw)) body.url = raw;
      else body.avatarId = raw;
    } else if (DEV_AVATAR_DATA) {
      body.dataUrl = DEV_AVATAR_DATA;
    } else {
      devAvatarSay('先选一张本地图片，或填图片地址 / avatar_id', 'error');
      return;
    }
    if (!window.confirm(`确认给 ${DEV_CURRENT} 换头像？平台侧会立即生效。`)) return;
    devAvatarSay('正在上传…');
    try {
      const out = await api('/api/dev/avatar', { method: 'POST', body: JSON.stringify(body) });
      await loadDevBot(DEV_CURRENT);
      devEditSay(`头像已更新（${out.uploaded ? '上传并套用' : '按 avatar_id 套用'}）`, 'ok');
    } catch (e) {
      devAvatarSay('换头像失败：' + errText(e), 'error');
    }
  });

  /* ---------------- 连接 / 白名单 ---------------- */

  $('#devSaveWebhook')?.addEventListener('click', () => {
    if (!DEV_CURRENT) return;
    const url = ($('#devWebhook')?.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      devEditSay('Webhook 要填 http(s) 地址', 'error');
      return;
    }
    devSave({ connect: { action: 1, webhookUrl: url } }, 'Webhook');
  });

  $('#devSaveConnect')?.addEventListener('click', () => {
    if (!DEV_CURRENT) return;
    const action = Number($('#devConnectAction')?.value) || 1;
    const patch = { connect: { action } };
    if (action === 1) {
      const url = ($('#devWebhook')?.value || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        devEditSay('「保存 Webhook」需要先在上面填一个 http(s) 地址', 'error');
        return;
      }
      patch.connect.webhookUrl = url;
    }
    devSave(patch, action === 1 ? 'Webhook' : action === 2 ? 'Webhook 校验' : '连接方式');
  });

  $('#devSaveIps')?.addEventListener('click', () => {
    if (!DEV_CURRENT) return;
    const addresses = ($('#devIps')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const bad = addresses.find((ip) => !/^[0-9a-fA-F:.]+$/.test(ip));
    if (bad) {
      devEditSay(`这行不像 IP：${bad}（只支持 IPv4 / IPv6，一行一个）`, 'error');
      return;
    }
    devSave({ ip: { mode: 'replace', addresses } }, 'IP 白名单');
  });

  /* ---------------- 白名单：测试用户 / 白名单群 ----------------
   *
   * 和上面那些「保存」按钮不同，这里是**加一条立刻发一次**。平台侧本来就是
   * 单条增删的接口，凑一批再提交没有任何好处，反而会出现「三条里错一条」
   * 却不知道是哪条。
   */
  const devAddScope = async (kind) => {
    if (!DEV_CURRENT) return;
    const isUser = kind === 'users';
    const input = isUser ? $('#devUserInput') : $('#devGroupInput');
    const raw = String(input?.value || '').trim();
    if (!raw) {
      devScopeSay(isUser ? '先填一个 QQ 号' : '先填一个群号', 'error');
      return;
    }
    // 本机先挡一次：官方校验是 QQ 号 5~11 位、群号 5~10 位纯数字
    const ok = isUser ? /^\d{5,11}$/.test(raw) : /^\d{5,10}$/.test(raw);
    if (!ok) {
      devScopeSay(isUser ? `QQ 号要 5~11 位纯数字，这个不对：${raw}` : `群号要 5~10 位纯数字，这个不对：${raw}`, 'error');
      return;
    }
    const list = isUser ? DEV_SCOPE.users : DEV_SCOPE.groups;
    const dup = isUser
      ? list.some((u) => u.uin === raw)
      : list.some((g) => g.groupId === raw);
    if (dup) {
      devScopeSay(`已经在白名单里了：${raw}`, 'error');
      return;
    }
    const done = await devScopeChange(kind, 1, [raw], isUser ? '测试用户' : '白名单群');
    // 成功才清空：失败时把号码留着，用户改一下就能重试
    if (done && input) input.value = '';
  };

  $('#devAddUser')?.addEventListener('click', () => devAddScope('users'));
  $('#devAddGroup')?.addEventListener('click', () => devAddScope('groups'));
  // 回车就加，省一次点按钮；不拦的话会触发页面里的其他默认行为
  for (const [sel, kind] of [['#devUserInput', 'users'], ['#devGroupInput', 'groups']]) {
    $(sel)?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      devAddScope(kind);
    });
  }

  /**
   * 移除按钮用事件委托：列表是每次回读后重画的，逐个绑会越绑越多，
   * 而且新渲染出来的行压根绑不上（这是列表类 UI 最容易踩的坑）。
   */
  for (const sel of ['#devUserList', '#devGroupList']) {
    $(sel)?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-scope-remove]');
      if (!btn) return;
      const kind = btn.dataset.scopeRemove;
      const id = btn.dataset.id || '';
      if (!id) return;
      devScopeChange(kind, 2, [id], kind === 'users' ? '测试用户' : '白名单群');
    });
  }

  /* ---------------- 开发页的状态自检（每 4 秒） ----------------
   *
   * 为什么需要：自动续期、扫码成功都发生在**后端**，而页面原来只在
   * 「点了扫码」或「点了保存」时才去读状态。于是出现过「日志说票已到手、
   * 页面还停在『登录已过期』」——用户只能靠手动刷新页面才发现其实好了。
   *
   * 这条轮询只打本地 `/api/dev/status`（不联网、不碰平台），代价可以忽略。
   * 只在开发页可见时才跑，切到别的页签就完全停手。
   */
  let lastLoggedIn = null;
  let lastAutoAt = 0;
  /** 上一次处理过的「65 秒补拉」时间戳 */
  let lastWarmAt = 0;
  const devTabVisible = () => {
    const el = $('#tab-dev');
    return Boolean(el && !el.hidden && el.classList.contains('active'));
  };

  setInterval(async () => {
    if (document.hidden || !devTabVisible()) return;
    let st;
    try {
      st = await api('/api/dev/status');
    } catch {
      return; // 本地接口偶发失败，下一轮再说，别在界面上刷错误
    }
    devPaintStatus(st);

    const logged = Boolean(st?.loggedIn);
    const autoAt = Number(st?.autoRelogin?.last?.at) || 0;
    const autoOk = Boolean(st?.autoRelogin?.last?.ok) && autoAt > lastAutoAt;
    /**
     * 只在「登录态变了」或「刚续期成功」时重读机器人详情：
     * 无条件重读会把用户正在编辑的昵称/简介覆盖掉。
     */
    /**
     * 补拉完成（`warmup.at` 变了）：说明平台已经放开，立刻把数据拉回来。
     * 这条是「65 秒后自己好」的落点——用户什么都不用点。
     */
    const warmAt = Number(st?.autoRelogin?.warmup?.at) || 0;
    const warmDone = warmAt > lastWarmAt;
    if (warmDone) lastWarmAt = warmAt;

    if ((lastLoggedIn === false && logged) || autoOk || warmDone) {
      lastLoggedIn = logged;
      if (autoOk) lastAutoAt = autoAt;
      await loadDevBots();
      return;
    }
    lastLoggedIn = logged;
  }, 4000)?.unref?.();
})();
