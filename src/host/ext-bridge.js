/**
 * 框架插件 ↔ DSH 扩展：反向调用桥
 * ================================
 *
 * 直连协议（roost-host/1）里 DSH 是客户端、框架是服务端，所以「扩展调框架
 * 插件工具」天然走得通（`tool.*`）；反过来「框架插件调扩展」需要一条回程。
 *
 * 不新开端口、不给 DSH 发令牌：复用协议已有的两条通道——
 *
 *   框架 --SSE 事件 `ext.call.request`--> DSH
 *   框架 <--HTTP RPC `ext.call.reply`-- DSH
 *
 * 这一层只管「请求 → 等回执」的配对，是纯逻辑，不碰网络：
 *
 *   · 每个请求一个 id，带超时（DSH 没连上 / 扩展卡住都要能失败，不能挂死）；
 *   · 回执只能认自己发出去的 id，杜绝别的客户端伪造结果；
 *   · 能力清单由 DSH 连上后上报（`ext.register`），框架不主动扫盘。
 *
 * 为什么扩展能力不投影成 `tool.*`：`tool.*` 的 scope 是 `message`，谁拿到
 * 协议令牌都能调；而扩展动作可能带写操作（发消息、评论），应当只在框架
 * 插件明确调用时才发生，且由 DSH 自己按 `ui.actions` 白名单把着。
 *
 * ── 命令（1.2.0 起）─────────────────────────────────────────────────
 *
 * 同一份 `ext.register` 还可以上报 `commands`：外接客户端（宿主本体）和它装的
 * 扩展，都能在框架侧**注册聊天命令**，命令名与其他插件命令一样进 `/help`。
 * 触发时框架推 `ext.command.request`，客户端用 RPC `ext.command.reply` 回执：
 *
 *   · 回执带 `reply` → 框架替它发（走 `msg.reply`，带引用，限频/窗口都受管）；
 *   · 不回 `reply` → 认为客户端自己用 `msg.send` 发过了，框架不再补一句。
 *
 * 注册是**幂等重建**：每次 register 先按伪插件 id 清空旧命令再装新的，
 * 所以「扩展卸了但命令还在」不会发生。重名不覆盖——`addCommand` 抛错就
 * 跳过，并把这批冲突放进回执的 `rejected`，客户端记日志即可。
 */

import { HostError } from './methods.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PENDING = 32;
const MAX_PAYLOAD_KEYS = 40;
/** 命令回执正文上限：QQ 单条本来也放不下更多，截断比报错友好 */
const MAX_REPLY_CHARS = 2000;
/** 一次上报的命令总数上限（宿主 + 全部扩展），防客户端刷清单 */
const MAX_COMMANDS = 60;
/** 每条命令的别名上限 */
const MAX_ALIASES = 4;
/** 命令名：字母（含中文）/数字/下划线/连字符，最长 16；与原生命令表口径一致 */
const CMD_NAME_RE = /^[\p{L}\p{N}_-]{1,16}$/u;

/**
 * 宿主本体在命令表里的内部 id。
 *
 * 以前写死 `__host`，它会一路漏进 `/help 插件` 的列表里，用户看到的是
 * 「__host DSH」——一个谁也认不出的内部代号。改成按对方**自报的名字**
 * 生成（`host.name`，默认 `dsh-roost`），对内唯一、对外只显示名字。
 *
 * 保留 `__` 前缀有两个用处：分群「只启用列表」的插件开关对它放行
 * （见 `bot.js` 的 `pluginAllowedIn`），`/help 插件` 也能一眼把它筛掉。
 *
 * 后续要接别的程序时，各自在 `host.name` 里报不同的名字就各占一个命名空间，
 * 不用再抢 `__host` 这个固定 id；真正的多连接并行还需要协议层给每条连接
 * 一个身份（`ext.register` 目前是一条连接一次全量上报）。
 */
function virtualPluginId(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `__${slug || 'dsh'}`;
}

/**
 * 把客户端上报的命令条目洗成内部结构。
 *
 * target = 'host' 表示宿主本体（伪插件 `__<host.name>`），'ext' 表示某个扩展
 * （伪插件 `__ext:<id>`）。名字不合法直接丢——命令表是全局命名空间，
 * 不能让一个畸形条目把别的插件注册流程带崩。
 */
function normalizeCommands(list, { target, extId = '', pluginName }) {
  const out = [];
  const name = String(pluginName ?? '').trim() || (target === 'host' ? 'dsh-roost' : extId);
  const pluginId = target === 'host' ? virtualPluginId(name) : `__ext:${extId}`;
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue;
    const cmd = String(c.name ?? '').trim().toLowerCase();
    if (!CMD_NAME_RE.test(cmd)) continue;
    const aliases = (Array.isArray(c.aliases) ? c.aliases : [])
      .map((a) => String(a ?? '').trim().toLowerCase())
      .filter((a) => a && a !== cmd && CMD_NAME_RE.test(a))
      .slice(0, MAX_ALIASES);
    out.push({
      target,
      extId,
      pluginId,
      pluginName: name.slice(0, 40),
      name: cmd,
      aliases,
      desc: String(c.desc ?? '').slice(0, 60),
      usage: String(c.usage ?? '').slice(0, 120),
      admin: c.admin === true,
      globalAdmin: c.globalAdmin === true,
      ownerOnly: c.ownerOnly === true,
      hidden: c.hidden === true,
    });
  }
  return out;
}

export function createExtBridge({
  pushEvent = () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
  /**
   * 把命令装进 registry 并返回冲突列表。桥本身不碰 registry（纯逻辑好测），
   * 由 HostBridge 注入；不注入时命令只进清单、不生效（例如单测里没有 runtime）。
   */
  installCommands = null,
} = {}) {
  /** requestId -> { resolve, reject, timer, at } —— 扩展调用与命令共用一张表 */
  const pending = new Map();
  /** DSH 上报的扩展能力清单：{ extId, name, actions:[{id,label}] }[] */
  let catalog = [];
  /** 当前生效的命令（内部结构），list() 会给副本 */
  let commands = [];
  let catalogAt = 0;
  let seq = 0;

  function fail(p, e) {
    clearTimeout(p.timer);
    pending.delete(p.id);
    p.reject(e);
  }

  /** 发一条要求回执的请求，超时/断线都能失败 */
  function request(event, data, prefix, timeoutMessage) {
    if (pending.size >= MAX_PENDING) {
      throw new HostError('BUSY', `同时最多 ${MAX_PENDING} 个外接请求，稍后再试`, 429);
    }
    const requestId = `${prefix}-${Date.now().toString(36)}-${++seq}`;
    const promise = new Promise((resolve, reject) => {
      /**
       * **不要 unref**：这个定时器是请求生命周期本身的一部分。unref 之后
       * 若进程里暂时没有别的活跃 handle（例如框架正在停机、或单测环境），
       * 超时永远不触发，调用方会永久挂在 await 上。停机路径由
       * `HostBridge.#stopNow()` 调 `clear()` 统一解掉，不会拖住退出。
       */
      const timer = setTimeout(() => {
        const p = pending.get(requestId);
        if (p) fail(p, new HostError('TIMEOUT', timeoutMessage(requestId), 504));
      }, timeoutMs);
      pending.set(requestId, { id: requestId, resolve, reject, timer, at: Date.now() });
    });

    try {
      pushEvent(event, { requestId, ...data });
    } catch (e) {
      const p = pending.get(requestId);
      if (p) fail(p, new HostError('INTERNAL', `推不出事件 ${event}：${e?.message ?? e}`, 500));
    }
    return promise;
  }

  /**
   * 发起一次反向调用。
   *
   * @returns {Promise<any>} DSH 回执里的 result
   */
  async function call({ extId = '', action = '', payload = null, chat = '' } = {}) {
    const id = String(extId ?? '').trim();
    const act = String(action ?? '').trim();
    if (!id || !act) throw new HostError('BAD_PARAMS', '要给 extId 与 action', 400);
    /** payload 只收一层对象，超量的键直接截断，避免把整份配置塞进事件流 */
    let args = null;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      args = Object.fromEntries(Object.entries(payload).slice(0, MAX_PAYLOAD_KEYS));
    }
    return await request(
      'ext.call.request',
      {
        extId: id,
        action: act,
        payload: args,
        /** 调用方所在会话，DSH 侧要按它派生扩展的上下文；可为空 */
        chat: String(chat ?? '').slice(0, 120),
      },
      'exc',
      () => `扩展 ${id}.${act} 没在 ${timeoutMs}ms 内回执`,
    );
  }

  /**
   * 触发一条外接命令。
   *
   * `msg` 已经由 HostBridge 序列化好（复用 `host/serialize.js`），桥只负责
   * 转发与等回执，不认消息结构。回执形状 `{ reply }`：有正文就由调用方发。
   */
  async function command({ target = 'host', extId = '', name = '', msg = null } = {}) {
    const kind = target === 'ext' ? 'ext' : 'host';
    const id = kind === 'ext' ? String(extId ?? '').trim() : '';
    const nm = String(name ?? '').trim().toLowerCase();
    if (kind === 'ext' && !id) throw new HostError('BAD_PARAMS', '扩展命令要给 extId', 400);
    if (!CMD_NAME_RE.test(nm)) throw new HostError('BAD_PARAMS', `命令名不合法：${nm}`, 400);
    return await request(
      'ext.command.request',
      {
        target: kind,
        extId: id,
        name: nm,
        msg: msg && typeof msg === 'object' ? msg : null,
      },
      'cmd',
      () => `命令 /${nm} 没在 ${timeoutMs}ms 内回执`,
    );
  }

  /** DSH 通过 RPC 回执。认不出 id 一律拒绝，别让旧回执解掉新请求 */
  function reply({ requestId = '', ok = true, result = null, error = '' } = {}) {
    const key = String(requestId ?? '').trim();
    const p = pending.get(key);
    if (!p) throw new HostError('NOT_FOUND', '没有这个待回执的扩展调用（可能已超时）', 404);
    clearTimeout(p.timer);
    pending.delete(key);
    if (ok === false) {
      p.reject(new HostError('EXT_FAILED', String(error ?? '扩展调用失败').slice(0, 300), 502));
      return { ok: true, settled: key, failed: true };
    }
    p.resolve(result ?? null);
    return { ok: true, settled: key };
  }

  /**
   * 命令回执。与 `reply` 共用 pending 表，只是语义更窄：
   * 结果是 `{ reply }`，正文超长直接截断（QQ 单条塞不下，报错没意义）。
   */
  function replyCommand({ requestId = '', ok = true, reply: text = '', error = '' } = {}) {
    const key = String(requestId ?? '').trim();
    const p = pending.get(key);
    if (!p) throw new HostError('NOT_FOUND', '没有这个待回执的命令（可能已超时）', 404);
    clearTimeout(p.timer);
    pending.delete(key);
    if (ok === false) {
      p.reject(new HostError('EXT_FAILED', String(error ?? '扩展命令执行失败').slice(0, 300), 502));
      return { ok: true, settled: key, failed: true };
    }
    const body = String(text ?? '').slice(0, MAX_REPLY_CHARS);
    p.resolve(body ? { reply: body } : null);
    return { ok: true, settled: key };
  }

  /** DSH 连上 / 扩展装卸后上报能力清单与命令 */
  function register({ extensions = [], host = null } = {}) {
    const list = Array.isArray(extensions) ? extensions : [];
    catalog = list
      .filter((e) => e && typeof e.id === 'string' && e.id)
      .map((e) => ({
        extId: e.id.slice(0, 64),
        name: String(e.name ?? '').slice(0, 40),
        actions: (Array.isArray(e.actions) ? e.actions : [])
          .filter((a) => a && typeof a.id === 'string' && a.id)
          .slice(0, 60)
          .map((a) => ({ id: a.id.slice(0, 80), label: String(a.label ?? a.id).slice(0, 120) })),
      }));

    /**
     * 命令清单：扩展的按扩展归属，宿主的归它自报的那个名字（`__<name>`）。
     * 总数超上限就整批丢（不静默截一半），并让客户端在 `rejected` 里看到原因。
     */
    const normalized = [];
    for (const e of catalog) {
      const src = list.find((x) => x && x.id === e.extId);
      normalized.push(
        ...normalizeCommands(src?.commands, { target: 'ext', extId: e.extId, pluginName: e.name || e.extId }),
      );
    }
    if (host && typeof host === 'object') {
      normalized.push(...normalizeCommands(host.commands, { target: 'host', pluginName: String(host.name ?? 'dsh-roost') }));
    }

    let rejected = [];
    if (normalized.length > MAX_COMMANDS) {
      rejected.push({ name: '*', reason: `命令总数 ${normalized.length} 超过上限 ${MAX_COMMANDS}` });
      commands = [];
    } else {
      commands = normalized;
    }
    if (installCommands) {
      try {
        const conflicts = installCommands(commands) ?? [];
        rejected = rejected.concat(conflicts);
      } catch (e) {
        log(`安装外接命令失败：${e?.message ?? e}`);
        rejected.push({ name: '*', reason: `安装失败：${e?.message ?? e}` });
      }
    }

    catalogAt = Date.now();
    log(
      `外接清单已更新：${catalog.length} 个扩展 / ${catalog.reduce((n, e) => n + e.actions.length, 0)} 个动作 / ` +
        `${commands.length} 条命令${rejected.length ? `，${rejected.length} 条被拒` : ''}`,
    );
    return { ok: true, count: catalog.length, commands: commands.length, rejected };
  }

  return {
    call,
    command,
    reply,
    replyCommand,
    register,
    list: () => ({
      extensions: catalog.map((e) => ({
        extId: e.extId,
        name: e.name,
        actions: e.actions.map((a) => ({ ...a })),
        commands: commands
          .filter((c) => c.pluginId === `__ext:${e.extId}`)
          .map((c) => ({ name: c.name, aliases: [...c.aliases], desc: c.desc })),
      })),
      host: {
        commands: commands
          .filter((c) => c.target === 'host')
          .map((c) => ({ name: c.name, aliases: [...c.aliases], desc: c.desc })),
      },
      updatedAt: catalogAt,
      pending: pending.size,
    }),
    /** 断线时把还在等的请求全部解掉，别让框架插件永远挂在 await 上 */
    clear: (why = '链路断开') => {
      for (const p of [...pending.values()]) {
        fail(p, new HostError('DISCONNECTED', `${why}，扩展调用已取消`, 503));
      }
      /** 命令跟着连接走：客户端没连上，这些命令点了也没人接，必须摘掉 */
      if (commands.length && installCommands) {
        commands = [];
        try {
          installCommands([]);
        } catch (e) {
          log(`摘除外接命令失败：${e?.message ?? e}`);
        }
      }
    },
    pendingCount: () => pending.size,
  };
}
