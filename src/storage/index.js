/**
 * 统计存储
 * ========
 *
 * 记录「谁在什么时候、在哪个会话、发了多少条、用了什么命令」，供面板出图。
 *
 * 三条原则：
 *   1. **不存消息正文**。只记数量、时间、用户/会话 id，正文属于用户隐私。
 *   2. **写入不能拖慢收消息**。`record()` 只往内存数组里塞一条，真正的 SQL
 *      由 1 秒一次的 flush 批量提交（一个事务写完）。
 *   3. **没 SQLite 也要能跑**。Node 低于 22.5 或没编译 sqlite 时，
 *      `available` 为 false，所有查询返回空结构，框架其它功能不受影响。
 */
import { createLogger } from '../logger.js';
import { probeSqlite, openDatabase } from './db.js';
import { migrate } from './schema.js';

const log = createLogger('stats');

/** 本地时区的 YYYY-MM-DD */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class StatsStore {
  /**
   * @param {object} p
   * @param {string} p.file  数据库路径
   * @param {boolean} [p.enabled]
   * @param {number} [p.retentionDays] 明细保留天数，默认 90
   */
  constructor({ file, enabled = true, retentionDays = 90 }) {
    this.file = file;
    this.enabled = enabled !== false;
    this.retentionDays = Math.max(1, Number(retentionDays) || 90);

    this.db = null;
    this.available = false;
    /** 待写入的消息，flush 时一次性提交 */
    this.buf = [];
    this.flushTimer = null;
    this.closed = false;
    /** 只在第一次出错时提醒，避免刷屏 */
    this.warned = false;
  }

  /** 打开库并建表。失败只警告，不抛——统计是增强功能 */
  open() {
    if (!this.enabled) {
      log.info('统计已关闭（stats.enabled = false）');
      return false;
    }
    if (!probeSqlite()) {
      log.warn('当前 Node 不支持 node:sqlite，统计功能不可用（其它功能正常）');
      return false;
    }
    try {
      this.db = openDatabase(this.file);
      const r = migrate(this.db);
      if (r.from !== r.to) log.info(`统计库已迁移: v${r.from} → v${r.to}`);
      this.available = true;
      this.#scheduleFlush();
      return true;
    } catch (e) {
      log.warn(`统计库打开失败，统计功能不可用: ${e.message}`);
      this.db = null;
      this.available = false;
      return false;
    }
  }

  #scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      try {
        this.flush();
      } catch {
        /* flush 内部已经记日志 */
      }
    }, 1000);
    this.flushTimer.unref?.();
  }

  /**
   * 记一条消息。**只进内存缓冲**，不碰磁盘。
   *
   * @param {object} m
   * @param {string} m.scope   group / c2c / channel
   * @param {string} m.chatId
   * @param {string} m.userId
   * @param {boolean} [m.isCommand]
   * @param {string} [m.command]
   * @param {number} [m.ts]
   */
  record({ scope, chatId, userId, isCommand = false, command = null, ts = Date.now() }) {
    if (!this.available) return;
    if (!scope || !chatId || !userId) return;
    this.buf.push({
      ts,
      day: dayKey(ts),
      hour: new Date(ts).getHours(),
      scope,
      chatId,
      userId,
      isCommand: isCommand ? 1 : 0,
      command: isCommand ? String(command ?? '') : null,
    });
    // 积压太多就先落盘，别让内存一直涨（比如补发历史消息时）
    if (this.buf.length >= 200) {
      try {
        this.flush();
      } catch {
        /* 已在 flush 里处理 */
      }
    }
  }

  /** 把缓冲写进库。一个事务提交，失败不影响调用方 */
  flush() {
    if (!this.available || !this.buf.length) return 0;
    const rows = this.buf;
    this.buf = [];

    try {
      const insMsg = this.db.prepare(
        `INSERT INTO messages (ts, day, hour, scope, chat_id, user_id, is_command, command)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insDaily = this.db.prepare(
        `INSERT INTO daily (day, scope, chat_id, messages, commands) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(day, scope, chat_id) DO UPDATE SET
           messages = messages + 1,
           commands = commands + excluded.commands`,
      );
      const insMember = this.db.prepare(
        `INSERT INTO members (scope, user_id, first_seen, last_seen, messages, commands)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(scope, user_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           messages  = messages + 1,
           commands  = commands + excluded.commands`,
      );
      const insCmd = this.db.prepare(
        `INSERT INTO commands (day, name, count) VALUES (?, ?, 1)
         ON CONFLICT(day, name) DO UPDATE SET count = count + 1`,
      );

      this.db.exec('BEGIN');
      try {
        for (const r of rows) {
          insMsg.run(r.ts, r.day, r.hour, r.scope, r.chatId, r.userId, r.isCommand, r.command);
          insDaily.run(r.day, r.scope, r.chatId, r.isCommand);
          insMember.run(r.scope, r.userId, r.ts, r.ts, r.isCommand);
          if (r.isCommand && r.command) insCmd.run(r.day, r.command);
        }
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      return rows.length;
    } catch (e) {
      /**
       * 失败就把这批放回缓冲，下一轮再试。
       * 以前是先把 buf 清空再进 try：一次写失败直接丢一批（最多 200 条），
       * 而且只 warn 一次，统计就这么静默少了一块。
       */
      this.buf = rows.concat(this.buf);
      this.failedFlushes = (this.failedFlushes ?? 0) + 1;
      if (this.failedFlushes <= 3) {
        log.warn(`统计写入失败（第 ${this.failedFlushes} 次，数据已放回缓冲）: ${e.message}`);
      }
      return 0;
    }
  }

  /**
   * 面板概览。
   * @param {number} [days] 最近多少天（含今天），默认 7
   */
  overview(days = 7) {
    const empty = {
      available: false,
      total: 0,
      today: { messages: 0, commands: 0, users: 0 },
      series: [],
      topCommands: [],
      topChats: [],
      members: { total: 0, active: 0 },
      retentionDays: this.retentionDays,
    };
    if (!this.available) return empty;

    this.flush(); // 面板看到的数据应该包含刚发生的
    const span = Math.max(1, Math.min(365, Number(days) || 7));
    const from = new Date();
    from.setDate(from.getDate() - (span - 1));
    const fromDay = dayKey(from.getTime());
    const today = dayKey();

    const one = (sql, ...args) => this.db.prepare(sql).get(...args) ?? {};
    const all = (sql, ...args) => this.db.prepare(sql).all(...args) ?? [];

    const total = Number(one('SELECT COUNT(*) AS c FROM messages').c ?? 0);
    const t = one(
      `SELECT COUNT(*) AS m, COALESCE(SUM(is_command), 0) AS c, COUNT(DISTINCT user_id) AS u
         FROM messages WHERE day = ?`,
      today,
    );

    const rows = all(
      `SELECT day, SUM(messages) AS m, SUM(commands) AS c
         FROM daily WHERE day >= ? GROUP BY day ORDER BY day`,
      fromDay,
    );
    const map = new Map(rows.map((r) => [r.day, { messages: Number(r.m), commands: Number(r.c) }]));

    // 补零：没有消息的那天也要出现在折线上，否则看起来像「那天不存在」
    const series = [];
    for (let i = 0; i < span; i++) {
      const d = new Date(from);
      d.setDate(from.getDate() + i);
      const key = dayKey(d.getTime());
      series.push({ day: key, ...(map.get(key) ?? { messages: 0, commands: 0 }) });
    }

    const topCommands = all(
      `SELECT name, SUM(count) AS c FROM commands WHERE day >= ?
         GROUP BY name ORDER BY c DESC LIMIT 8`,
      fromDay,
    ).map((r) => ({ name: r.name, count: Number(r.c) }));

    const topChats = all(
      `SELECT scope, chat_id, SUM(messages) AS m, SUM(commands) AS c
         FROM daily WHERE day >= ? GROUP BY scope, chat_id ORDER BY m DESC LIMIT 8`,
      fromDay,
    ).map((r) => ({ scope: r.scope, chatId: r.chat_id, messages: Number(r.m), commands: Number(r.c) }));

    const weekAgo = Date.now() - 7 * 86400_000;

    return {
      available: true,
      total,
      today: {
        messages: Number(t.m ?? 0),
        commands: Number(t.c ?? 0),
        users: Number(t.u ?? 0),
      },
      series,
      topCommands,
      topChats,
      members: {
        total: Number(one('SELECT COUNT(*) AS c FROM members').c ?? 0),
        active: Number(one('SELECT COUNT(*) AS c FROM members WHERE last_seen >= ?', weekAgo).c ?? 0),
      },
      retentionDays: this.retentionDays,
    };
  }

  /** 最近的消息记录（不含正文，只有时间/会话/是否命令） */
  recent(limit = 50) {
    if (!this.available) return [];
    this.flush();
    return this.db
      .prepare(
        `SELECT ts, scope, chat_id, user_id, is_command, command
           FROM messages ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, Number(limit) || 50)))
      .map((r) => ({
        ts: Number(r.ts),
        scope: r.scope,
        chatId: r.chat_id,
        userId: r.user_id,
        isCommand: Boolean(r.is_command),
        command: r.command ?? '',
      }));
  }

  /**
   * 说过话的人（面板「身份」页的待绑定候选）。
   *
   * 数据源是 `members`——累计口径、不随 retention 清，正好当「这个人存在过」的名单。
   * 没有它就只能从 `messages` 里 `SELECT DISTINCT`，而那张表 90 天就滚掉了，
   * 半年没说话的老人会从名单里消失，管理员也就没法给他绑定了。
   *
   * @param {number} [limit] 默认 200，上限 1000
   */
  people(limit = 200) {
    if (!this.available) return [];
    this.flush();
    return this.db
      .prepare(
        `SELECT user_id, MIN(first_seen) AS f, MAX(last_seen) AS l,
                COALESCE(SUM(messages), 0) AS m, COALESCE(SUM(commands), 0) AS c
           FROM members GROUP BY user_id ORDER BY l DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map((r) => ({
        userId: r.user_id,
        firstSeen: Number(r.f) || 0,
        lastSeen: Number(r.l) || 0,
        messages: Number(r.m) || 0,
        commands: Number(r.c) || 0,
      }));
  }

  /**
   * 某个人的明细（面板「身份」页用）。
   *
   * 管理员在面板上看到一串 openid 时，唯一的判断依据是「这人活跃吗、
   * 在哪个群说话、说了什么」。没有这些，绑定就变成了猜。
   *
   * 两个数据源，口径不一样，**必须分开看**：
   *   - `members` 是**累计**的（不随 retention 清），给总量和首次/最近时间
   *   - `messages` 只留 `retentionDays` 天，给「在哪些群说过话」的分布
   * 所以 `chats[].messages` 加起来可能小于 `messages`，这不是 bug。
   *
   * @param {object} p
   * @param {string} p.userId
   * @param {number} [p.limit] 最多返回几个会话，默认 20
   */
  userDetail({ userId, limit = 20 } = {}) {
    const empty = { available: false, found: false, firstSeen: 0, lastSeen: 0, messages: 0, commands: 0, chats: [] };
    if (!this.available || !userId) return empty;
    this.flush();

    const uid = String(userId);
    const m =
      this.db
        .prepare(
          `SELECT MIN(first_seen) AS f, MAX(last_seen) AS l,
                  COALESCE(SUM(messages), 0) AS m, COALESCE(SUM(commands), 0) AS c
             FROM members WHERE user_id = ?`,
        )
        .get(uid) ?? {};

    const chats = this.db
      .prepare(
        `SELECT scope, chat_id, COUNT(*) AS m, COALESCE(SUM(is_command), 0) AS c
           FROM messages WHERE user_id = ?
          GROUP BY scope, chat_id ORDER BY m DESC LIMIT ?`,
      )
      .all(uid, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((r) => ({
        scope: r.scope,
        chatId: r.chat_id,
        messages: Number(r.m) || 0,
        commands: Number(r.c) || 0,
      }));

    return {
      available: true,
      found: Boolean(m.f) || chats.length > 0,
      firstSeen: Number(m.f) || 0,
      lastSeen: Number(m.l) || 0,
      messages: Number(m.m) || 0,
      commands: Number(m.c) || 0,
      chats,
    };
  }

  /**
   * 导出用：按天 + 按会话 + 按命令三张汇总表。
   *
   * 导出的是**汇总**，不是逐条明细——明细里有 openid 和时间戳，
   * 拿去做表格分析用不上那么细，还会把隐私带出去。
   *
   * @param {number} days 最近多少天
   */
  exportSummary(days = 30) {
    if (!this.available) return { daily: [], chats: [], commands: [] };
    this.flush();

    const from = dayKey(Date.now() - Math.max(1, days) * 86400_000);

    const daily = this.db
      .prepare(
        `SELECT day, SUM(messages) AS messages, SUM(commands) AS commands,
                COUNT(DISTINCT chat_id) AS chats
           FROM daily WHERE day >= ? GROUP BY day ORDER BY day`,
      )
      .all(from)
      .map((r) => ({
        day: r.day,
        messages: Number(r.messages) || 0,
        commands: Number(r.commands) || 0,
        chats: Number(r.chats) || 0,
      }));

    const chats = this.db
      .prepare(
        `SELECT scope, chat_id, SUM(messages) AS messages, SUM(commands) AS commands
           FROM daily WHERE day >= ? GROUP BY scope, chat_id
          ORDER BY messages DESC`,
      )
      .all(from)
      .map((r) => ({
        scope: r.scope,
        chatId: r.chat_id,
        messages: Number(r.messages) || 0,
        commands: Number(r.commands) || 0,
      }));

    const commands = this.db
      .prepare(
        `SELECT name, SUM(count) AS count FROM commands
          WHERE day >= ? GROUP BY name ORDER BY count DESC`,
      )
      .all(from)
      .map((r) => ({ name: r.name, count: Number(r.count) || 0 }));

    return { daily, chats, commands };
  }

  /** 按保留天数清掉过期明细。members 不清——人走了档案还在，有用 */
  prune(now = Date.now()) {
    if (!this.available) return { messages: 0, daily: 0, commands: 0 };
    const cutoff = now - this.retentionDays * 86400_000;
    const cutoffDay = dayKey(cutoff);
    const del = (sql, ...args) => {
      const r = this.db.prepare(sql).run(...args);
      return Number(r.changes ?? 0);
    };
    try {
      return {
        messages: del('DELETE FROM messages WHERE ts < ?', cutoff),
        daily: del('DELETE FROM daily WHERE day < ?', cutoffDay),
        commands: del('DELETE FROM commands WHERE day < ?', cutoffDay),
      };
    } catch (e) {
      log.warn(`清理统计失败: ${e.message}`);
      return { messages: 0, daily: 0, commands: 0 };
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    try {
      this.flush();
    } catch {
      /* 退出阶段，忽略 */
    }
    try {
      this.db?.close();
    } catch {
      /* 已经关了 */
    }
    this.db = null;
    this.available = false;
  }
}
