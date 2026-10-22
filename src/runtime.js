/**
 * 全局运行时状态，供 WebUI 读取。
 * 所有字段都是普通值，不做持久化，进程重启即归零。
 */
export const runtime = {
  startedAt: Date.now(),
  connected: false,
  botName: '',
  botId: '',
  gatewayUrl: '',
  sessionId: '',
  lastHeartbeatAt: 0,
  lastEventAt: 0,
  reconnectCount: 0,
  messageEvent: '',

  counters: {
    recv: 0, // 收到的消息事件
    sent: 0, // 成功发出的消息
    commands: 0, // 命中的命令
    errors: 0, // 处理/发送错误
    dedup: 0, // 被去重拦掉
    limited: 0, // 被限流拦掉
    rejected: 0, // 被白名单拦掉
    ignored: 0, // 收到但没有任何插件回应，静默丢弃
  },

  /** 每个群/用户的消息计数，最多保留 200 个键 */
  perChat: new Map(),

  /** 各类事件收到多少次。全为 0 说明平台压根没推事件过来 */
  eventCounts: new Map(),

  /** 最近一条原始事件，排查字段结构用 */
  lastRaw: null,

  bumpEvent(name) {
    if (!name) return;
    this.eventCounts.set(name, (this.eventCounts.get(name) ?? 0) + 1);
  },

  bump(key, n = 1) {
    this.counters[key] = (this.counters[key] ?? 0) + n;
  },

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
  },

  get uptimeMs() {
    return Date.now() - this.startedAt;
  },

  snapshot({ credentialExpiresIn = 0, plugins = [], cfg = {} } = {}) {
    return {
      connected: this.connected,
      botName: this.botName,
      botId: this.botId,
      gatewayUrl: this.gatewayUrl,
      sessionId: this.sessionId,
      uptimeMs: this.uptimeMs,
      startedAt: this.startedAt,
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
        error: p.error,
      })),
      intents: cfg.intents ?? 0,
      prefix: cfg.commandPrefix ?? '/',
      node: process.version,
      platform: process.platform,
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    };
  },
};
