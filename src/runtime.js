/**
 * 敏感字段名。**导出给事件账本用**——账本要存原始报文，
 * 但它和日志的取舍不同：日志里整个 `ext` 都可以扔（没人靠日志排查 msg_idx），
 * 账本必须保留 `msg_idx` / `ref_msg_idx`（引用边全靠它），只能删 `auth_token`。
 * 所以共用这份名单，各写各的遍历。
 */
export const SENSITIVE_KEY = /^(auth_token|token|access_token|secret|client_secret|cookie|password)$/i;

/**
 * 事件报文脱敏。
 * 群消息的 message_scene.ext 里带 auth_token，属于敏感凭证，
 * 不能进日志、更不能通过 /api/status 暴露出去。
 */
function redact(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '***';
      } else if (k === 'ext') {
        out[k] = ['(已隐藏)'];
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/auth_token=[^&"\s]*/g, 'auth_token=***')
      .replace(/msg_idx=[^&"\s]*/g, 'msg_idx=***')
      .slice(0, 400);
  }
  return value;
}

export function sanitizePayload(d) {
  try {
    return JSON.stringify(redact(d));
  } catch {
    return '<无法序列化>';
  }
}

/**
 * 单个机器人的运行时指标。
 *
 * **为什么必须 per-bot**：以前这些字段全挂在进程级单例 `runtime` 上，
 * 多机器人并存时 N 个 Gateway 的 READY 互相覆盖连接态、N 个 dispatch
 * 把计数汇进同一本账——面板上「哪个 bot 在线」「哪个群在沸腾」全成了
 * last-writer-wins 的串台值。现在每个 BotRuntime 各持一份，互不干扰。
 *
 * 所有字段都是普通值，不做持久化，进程重启即归零。
 */
export class BotMetrics {
  constructor(botId = '') {
    this.botId = botId;
    // 连接态（由该 bot 自己的 Gateway 写入）
    this.connected = false;
    this.botName = '';
    this.platformId = '';
    this.gatewayUrl = '';
    this.sessionId = '';
    this.lastHeartbeatAt = 0;
    // 活跃度
    this.lastEventAt = 0;
    this.reconnectCount = 0;
    this.messageEvent = '';
    this.lastRaw = null;

    this.counters = {
      recv: 0, // 收到的消息事件
      sent: 0, // 成功发出的消息
      commands: 0, // 命中的命令
      errors: 0, // 处理/发送错误
      dedup: 0, // 被去重拦掉
      limited: 0, // 被限流拦掉
      rejected: 0, // 被白名单拦掉
      ignored: 0, // 收到但没有任何插件回应，静默丢弃
    };

    /** 每个群/用户的消息计数，最多保留 200 个键 */
    this.perChat = new Map();

    /** 各类事件收到多少次。全为 0 说明平台压根没推事件过来 */
    this.eventCounts = new Map();

    /** 各类事件最后一次收到的时间，面板显示「多久以前」用 */
    this.eventLastAt = new Map();
  }

  bumpEvent(name) {
    if (!name) return;
    this.eventCounts.set(name, (this.eventCounts.get(name) ?? 0) + 1);
    this.eventLastAt.set(name, Date.now());
  }

  bump(key, n = 1) {
    this.counters[key] = (this.counters[key] ?? 0) + n;
  }

  touchChat(id, kind) {
    if (!id) return;
    const cur = this.perChat.get(id) ?? { id, kind, count: 0, last: 0 };
    cur.count += 1;
    cur.last = Date.now();
    this.perChat.set(id, cur);
    if (this.perChat.size > 200) {
      // 丢掉最久未活跃的
      let oldestKey = null;
      let oldest = Infinity;
      for (const [k, v] of this.perChat) {
        if (v.last < oldest) {
          oldest = v.last;
          oldestKey = k;
        }
      }
      if (oldestKey) this.perChat.delete(oldestKey);
    }
  }

  snapshot({
    credentialExpiresIn = 0,
    plugins = [],
    cfg = {},
    botName = null,
    state = null,
    version = '',
    startedAt = 0,
    uptimeMs = 0,
  } = {}) {
    return {
      connected: this.connected,
      // 机器人实例自己的状态（online / offline / starting …），面板的上下线按钮用
      state,
      botName: botName ?? this.botName,
      botId: this.botId,
      gatewayUrl: this.gatewayUrl,
      sessionId: this.sessionId,
      uptimeMs,
      startedAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastEventAt: this.lastEventAt,
      reconnectCount: this.reconnectCount,
      counters: { ...this.counters },
      chats: [...this.perChat.values()].sort((a, b) => b.count - a.count).slice(0, 20),
      lastRaw: this.lastRaw,
      events: [...this.eventCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      credentialExpiresIn,
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        enabled: p.enabled,
        loaded: p.loaded,
        kind: p.kind,
        runtime: p.runtime,
        processState: p.processState,
        pid: p.pid,
        error: p.error,
      })),
      intents: cfg.intents ?? 0,
      prefix: cfg.commandPrefix ?? '/',
      // 框架版本，面板「框架版本」直接显示
      version,
      node: process.version,
      platform: process.platform,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    };
  }
}

/**
 * 进程级运行时状态（真正全局的那部分）。
 * 连接态/指标已下沉到每个 BotMetrics，这里只留进程生命周期相关。
 */
export const runtime = {
  startedAt: Date.now(),
  get uptimeMs() {
    return Date.now() - this.startedAt;
  },
};
