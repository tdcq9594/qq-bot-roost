/**
 * 事件账本：把「发生过什么」原样记下来
 * ====================================
 *
 * ── 为什么需要它 ──
 *
 * 官方**没有任何历史消息接口**（`src/endpoints.js` 的 17 个 GET 里没有）。
 * 一旦这条消息没被记下来，它就永久消失了。而在此之前我们只存了
 * 「谁在哪天发了多少条」（`stats.db`），正文从来没落过盘——
 * 于是所有「记忆」的原料都是模型当时抽的二手摘要，上限被原料决定。
 *
 * 这份账本是**唯一的历史来源**。
 *
 * ── 三个不能省的列 ──
 *
 * `time_basis`：官方给的 `timestamp` 有时缺、有时不可信（补录、迁移）。
 *   三态 `message` / `observation` / `unknown`。
 *   **`unknown` 的事件不参与时间邻文**——拿不可靠的时间拼上下文，
 *   拼出来的是「看着合理但是错的」对话，比没有更糟。
 *
 * `dedupe`：官方原文「为确保消息可达，**相同 msg_id 可能重复推送**」。
 *   所以去重不能靠「我记得刚见过」，得有唯一约束兜底。
 *
 * `msg_idx` / `ref_msg_idx`：引用边的唯一来源。以前以为解不出，其实
 *   非机器人消息从 `message_scene.ext.msg_idx` 取、自己发的从发送响应
 *   `ext_info.ref_idx` 取。
 *
 * ── 保留策略：7 天滚动删 ──
 *
 * 全量存正文是隐私问题，所以不留永久。**证据由 B 侧（journal）自己留快照**，
 * 账本可以无脑滚动删——它不需要知道谁引用了它。
 * （原设计想让「被引用的永久保留」，但 A 侧根本看不到 B 侧的引用，
 * 那条路走不通。）
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { probeSqlite, openDatabase } from './storage/db.js';
import { migrateEvents } from './storage/events-schema.js';
import { SENSITIVE_KEY } from './runtime.js';

const log = createLogger('ledger');

/** 每次滚动删最多删多少行。分批是为了不长时间锁库，收消息会卡 */
const PRUNE_BATCH = 5000;

/** 自动清理间隔 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 报文脱敏：只删凭证，不截断。
 *
 * 和 `runtime.js` 的 `sanitizePayload` 的区别就在这：
 * 那个是给日志/接口看的，整个 `ext` 都扔、字符串截到 400 字；
 * 账本要留着 `msg_idx`，也不能把长消息截断——截了就不是原文了。
 *
 * @param {unknown} value
 * @param {number} [depth]
 */
function cleanPayload(value, depth = 0) {
  // 深度上限防环形引用和畸形报文，正常 QQ 事件撑死 6 层
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((v) => cleanPayload(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***' : cleanPayload(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 单条 payload 上限。合并转发的聊天记录能有几十 KB，正常远到不了这里；
 * 设上限是为了防畸形/超大报文把库撑爆（一条几 MB 的行会拖慢所有查询）。
 * 超了截断并留标记——`content` 是单独一列，正文不受影响。
 */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * 时间戳归一成毫秒。
 *
 * QQ 的 `timestamp` 有的场景是**秒**、有的是 ISO 字符串、有的干脆没有。
 * 返回 `{ at, basis }`：拿不准就退回本地收到时间，并标记 `observation`。
 */
export function resolveTime(raw, receivedAt = Date.now()) {
  const t = raw?.timestamp;
  if (t === undefined || t === null || t === '') return { at: receivedAt, basis: 'observation' };

  if (typeof t === 'number' || /^\d+$/.test(String(t))) {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return { at: receivedAt, basis: 'observation' };
    // 10 位是秒，13 位是毫秒。1e11 ≈ 1973 年（毫秒），所以小于它只能是秒
    const ms = n < 1e11 ? n * 1000 : n;
    // 离谱的未来时间当不可信（时钟错乱、字段被塞了别的东西）
    if (ms > Date.now() + 24 * 3600 * 1000) return { at: receivedAt, basis: 'observation' };
    return { at: ms, basis: 'message' };
  }

  const parsed = Date.parse(String(t));
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= Date.now() + 24 * 3600 * 1000) {
    return { at: parsed, basis: 'message' };
  }
  return { at: receivedAt, basis: 'observation' };
}

/** 内容指纹：没有 msg_id 时用它兜底去重 */
function digestOf(msg) {
  const s = `${msg.chatId ?? ''}\u0000${msg.userId ?? ''}\u0000${msg.content ?? ''}`;
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

export class EventLedger {
  /**
   * @param {object} p
   * @param {string} p.file    events.db 路径
   * @param {string} p.botId
   * @param {boolean} [p.enabled]
   * @param {number} [p.retentionDays] 保留天数。**0 = 永久不删**；缺省按 0 处理
   */
  constructor({ file, botId = '', enabled = true, retentionDays = 0 }) {
    this.file = file;
    this.botId = botId;
    this.enabled = enabled !== false;
    /**
     * `0` 是**合法值**（永久），不能像以前那样 `|| 7` 把它吃掉。
     *
     * 这里必须和 `config.js` 的默认值、`bot.js` 的 `?? 0` 三处一致。
     * 任何一处留 `7`，表现都是「面板显示永久、实际按 7 天删」——不报错、查不出来。
     */
    const n = Number(retentionDays);
    this.retentionDays = n === 0 ? 0 : Math.max(1, Number.isFinite(n) ? n : 0);

    this.db = null;
    this.available = false;
    this.closed = false;
    this.pruneTimer = null;
    /** 只在第一次出错时提醒，别刷屏 */
    this.warned = false;
    /** 待压缩标记（面板点「压缩」后置位，定时清理时消费） */
    this.needVacuum = false;
  }

  /** 打开库并建表。失败只警告——账本是增强功能，不能因此让机器人起不来 */
  open() {
    if (!this.enabled) {
      log.info('事件账本已关闭（ledger.enabled = false）');
      return false;
    }
    if (!probeSqlite()) {
      log.warn('当前 Node 不支持 node:sqlite，事件账本不可用（其它功能正常）');
      return false;
    }
    try {
      this.db = openDatabase(this.file);
      migrateEvents(this.db);
      this.available = true;
      /** 上次进程退出前点过「压缩」但没跑到，这里接上 */
      this.needVacuum = fs.existsSync(this.vacuumMark());
    } catch (e) {
      log.warn(`事件账本打不开（${this.file}）：${e.message}`);
      this.db = null;
      this.available = false;
      return false;
    }

    // 启动先清一次：进程可能停了很久，攒下的一堆过期数据要立刻走
    this.prune().catch((e) => log.warn('账本清理失败:', e.message));
    this.pruneTimer = setInterval(() => {
      this.prune().catch((e) => log.warn('账本清理失败:', e.message));
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
    return true;
  }

  /**
   * 记一条消息。
   *
   * **必须在 pipeline 之前调**：被去重 / 白名单 / 限流 / 暂停拦下的消息
   * 也是「发生过的事实」，账本要记的是事实，不是处理结果。
   *
   * @param {object} msg  `buildMessage()` 的产物
   * @param {object} [opts]
   * @param {'message'|'observation'|'unknown'} [opts.timeBasis]
   *   强制指定时间基准。**只有导入 / 补录 / 迁移才该用**——
   *   正常收消息时自动判（`resolveTime`），判不准会退回 `observation`，
   *   而 `unknown` 是「连本地收到时间都不可信」（批量导入一批几年前的聊天记录，
   *   这时候的 `Date.now()` 是导入时间，不是说话时间）。
   *   `unknown` 的事件**不参与时间邻文**，这是故意的。
   * @returns {{seq:number, id:string}|null} 重复消息返回 null
   */
  append(msg, { timeBasis } = {}) {
    if (!this.available || this.closed || !msg) return null;

    const receivedAt = Date.now();
    const resolved = resolveTime(msg.raw, receivedAt);
    const basis = ['message', 'observation', 'unknown'].includes(timeBasis) ? timeBasis : resolved.basis;
    /**
     * 显式指定基准时 `at` 用本地收到时间。
     *
     * 这对 `unknown` 有个副作用，但方向是对的：导入的三年老聊天记录 `at` 是导入时间，
     * 于是它会跟着往后留满一个保留期，而不是进来就被滚动删掉。
     * 宁可多留一周让人处理，也不能让「刚导进来就没了」。
     */
    const at = basis === resolved.basis ? resolved.at : receivedAt;
    const msgId = String(msg.id ?? '').trim();
    // 有 msg_id 就用它（官方重推同一条时 msg_id 相同）；
    // 没有就退化成「会话+人+正文」的指纹，同一个人在同一会话里重复发同一句话
    // 会被误判成重复——这是已知代价，但比丢消息好
    const dedupe = msgId
      ? `${this.botId}:${msgId}`
      : `${this.botId}:${msg.chatId ?? ''}:${at}:${digestOf(msg)}`;

    const id = crypto.randomUUID();
    const payload = (() => {
      try {
        let s = JSON.stringify(cleanPayload(msg.raw));
        if (Buffer.byteLength(s, 'utf8') > MAX_PAYLOAD_BYTES) {
          // 截断会切坏 UTF-8 序列，JSON.parse 时才发现就晚了。
          // 干脆换成一条合法的标记对象，读的时候拿到 {} 语义（contentOf 返回空串），
          // 正文从 `quoted` / 消息本身还能还原，不会静默给出半截乱码。
          s = JSON.stringify({ _truncated: true, _bytes: Buffer.byteLength(s, 'utf8') });
        }
        return s;
      } catch {
        return '{}';
      }
    })();

    try {
      const r = this.db
        .prepare(
          `INSERT OR IGNORE INTO events
            (id, bot_id, kind, chat_id, msg_id, user_id, user_name, content,
             at, observed_at, time_basis, dedupe,
             msg_idx, ref_msg_idx, union_openid, quoted, payload, trace, plugin)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          this.botId,
          String(msg.kind ?? ''),
          String(msg.chatId ?? ''),
          msgId || null,
          String(msg.userId ?? '') || null,
          String(msg.userName ?? '') || null,
          String(msg.content ?? ''),
          at,
          receivedAt,
          basis,
          dedupe,
          String(msg.msgIdx ?? '') || null,
          String(msg.refMsgIdx ?? '') || null,
          String(msg.raw?.author?.union_openid ?? '') || null,
          String(msg.quoted ?? '') || null,
          payload,
          // 链路 id：来自 buildMessage（见 src/trace.js）。老调用方没有就给空串
          String(msg.traceId ?? ''),
          /**
           * 谁说的（v3）。入站一律空串；出站由 `outbound` 带插件 id，
           * 多插件合并时是逗号分隔（`echo,ai-chat`）。
           */
          String(msg.plugin ?? ''),
        );
      // changes === 0 说明撞了 dedupe 唯一约束 = 官方重推的同一条消息
      if (!r?.changes) {
        /**
         * 重推时**仍然返回已有那条的 id**。
         *
         * 官方明说「相同 msg_id 可能重复推送」。调用方（dsh-roost 写记忆）
         * 拿不到 eventId 就没法给出处——而这条消息事实上就在账本里，
         * 只是不是这次写的。
         */
        const old = this.db.prepare('SELECT seq, id FROM events WHERE dedupe = ?').get(dedupe);
        return old ? { seq: Number(old.seq), id: String(old.id), duplicate: true } : null;
      }
      const seq = Number(r.lastInsertRowid);

      // 引用边：先记下「它引用了谁」，能不能对上目标另说（resolved 由 resolveRefs 补）
      const refIdx = String(msg.refMsgIdx ?? '').trim();
      if (refIdx) {
        this.db
          .prepare('INSERT INTO event_refs (from_id, to_id, to_msg_id, kind, resolved) VALUES (?,?,?,?,0)')
          .run(id, null, refIdx, 'quote');
      }
      return { seq, id };
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        log.warn('账本写入失败（后续同类错误不再提示）:', e.message);
      }
      return null;
    }
  }

  /**
   * 把「引用了某个 msg_idx」的边对到具体事件上。
   *
   * 官方文档里 `ref_msg_idx` 出现过 `TMP_…` 前缀，和 `REFIDX_…` 不是同一命名空间，
   * **能不能对上要实测**。对不上就保持 `resolved=0`，退化成「只知道引用了谁、不知道是哪条」，
   * 不抛错也不丢数据。
   *
   * @returns {number} 本次解析成功的条数
   */
  resolveRefs(limit = 500) {
    if (!this.available || this.closed) return 0;
    try {
      const rows = this.db
        .prepare('SELECT rowid, from_id, to_msg_id FROM event_refs WHERE resolved = 0 LIMIT ?')
        .all(limit);
      if (!rows.length) return 0;

      const upd = this.db.prepare('UPDATE event_refs SET to_id = ?, resolved = 1 WHERE rowid = ?');
      let n = 0;
      for (const r of rows) {
        const hit = this.db
          .prepare('SELECT id FROM events WHERE bot_id = ? AND msg_idx = ? LIMIT 1')
          .get(this.botId, r.to_msg_id);
        if (hit?.id) {
          upd.run(hit.id, r.rowid);
          n += 1;
        }
      }
      return n;
    } catch (e) {
      log.warn('引用边解析失败:', e.message);
      return 0;
    }
  }

  /**
   * 滚动删。按 `seq` 分批，一次 ≤5000 行。
   *
   * 删之前先解析一遍引用边——过期的边留着也没意义，
   * 顺手让「最近 7 天内的引用」尽量对上。
   *
   * @returns {Promise<number>} 删掉的行数
   */
  async prune() {
    if (!this.available || this.closed) return 0;
    /**
     * **先解析引用边，再决定删不删。**
     *
     * `resolveRefs()` 是全仓唯一的引用边解析入口（另一个调用点在测试里），
     * 把它挪到 `retentionDays` 的 guard 后面，永久模式下引用边就永远不解析，
     * `stats().unresolvedRefs` 会单调涨到全量。
     */
    this.resolveRefs();

    /** 0 = 永久：只解析引用，不删任何行 */
    if (!this.retentionDays) {
      this.runVacuumIfAsked();
      return 0;
    }

    const cutoff = Date.now() - this.retentionDays * 24 * 3600 * 1000;
    let total = 0;
    for (;;) {
      const r = this.db
        .prepare(
          `DELETE FROM events WHERE seq IN (
             SELECT seq FROM events WHERE at < ? ORDER BY seq LIMIT ?
           )`,
        )
        .run(cutoff, PRUNE_BATCH);
      const n = Number(r?.changes ?? 0);
      total += n;
      if (n < PRUNE_BATCH) break;
    }
    if (total) {
      // 孤儿引用边一起清掉，不然表会慢慢涨
      this.db.exec('DELETE FROM event_refs WHERE from_id NOT IN (SELECT id FROM events)');
      log.info(`账本清理：删了 ${total} 条（保留 ${this.retentionDays} 天）`);
    }
    /**
     * 压缩只在**这里**做，不在 HTTP 请求里做：`DatabaseSync` 是同步 API，
     * VACUUM 锁几秒会把所有机器人的收消息一起卡住（见 `host.js:4188` 的同款裁定）。
     */
    this.runVacuumIfAsked();
    return total;
  }

  /**
   * 取某条消息前后各 N 条。
   *
   * **锚点必须是 time_basis != 'unknown'**，否则返回空——时间不可靠的锚点
   * 拼出来的上下文是错的。这条限制在 SQL 里用索引兜，不在 JS 里过滤。
   *
   * @param {object} p
   * @param {string} p.chatId
   * @param {number} [p.anchorSeq]
   * @param {number} [p.before] 往前几条，默认 2
   * @param {number} [p.after]  往后几条，默认 2
   * @param {number} [p.maxGapMs] 前后最多跨多久，默认 10 分钟。相邻不等于同一话题
   */
  timeline({ chatId, anchorSeq, before = 2, after = 2, maxGapMs = 10 * 60 * 1000 } = {}) {
    if (!this.available || this.closed || !chatId) return [];
    const anchor = this.db
      .prepare(
        `SELECT * FROM events
          WHERE bot_id = ? AND chat_id = ? AND seq = ? AND time_basis != 'unknown'`,
      )
      .get(this.botId, String(chatId), Number(anchorSeq) || 0);
    if (!anchor) return [];

    const cols = `seq, id, kind, chat_id, msg_id, user_id, user_name, content, at, time_basis, msg_idx, ref_msg_idx, quoted`;
    const prev = this.db
      .prepare(
        `SELECT ${cols} FROM events
          WHERE bot_id = ? AND chat_id = ? AND time_basis != 'unknown'
            AND at >= ? AND seq < ?
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(this.botId, String(chatId), anchor.at - maxGapMs, anchor.seq, before);
    const next = this.db
      .prepare(
        `SELECT ${cols} FROM events
          WHERE bot_id = ? AND chat_id = ? AND time_basis != 'unknown'
            AND at <= ? AND seq > ?
          ORDER BY seq ASC LIMIT ?`,
      )
      .all(this.botId, String(chatId), anchor.at + maxGapMs, anchor.seq, after);

    return [...prev.reverse(), { ...anchor, hit: true }, ...next].map((r) => ({
      seq: r.seq,
      id: r.id,
      kind: r.kind,
      chatId: r.chat_id,
      msgId: r.msg_id,
      userId: r.user_id,
      userName: r.user_name,
      at: r.at,
      timeBasis: r.time_basis,
      msgIdx: r.msg_idx,
      refMsgIdx: r.ref_msg_idx,
      quoted: r.quoted,
      content: contentOf(r),
      role: r.hit ? 'hit' : 'neighbor',
    }));
  }

  /** 按 id 取一条（含正文） */
  get(id) {
    if (!this.available || this.closed) return null;
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(String(id ?? '')) ?? null;
  }

  /** 某会话最近的若干条，按时间正序返回 */
  recent({ chatId, limit = 50, beforeSeq } = {}) {
    if (!this.available || this.closed || !chatId) return [];
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const rows = beforeSeq
      ? this.db
          .prepare(
            `SELECT seq, id, kind, chat_id, user_id, user_name, content, at, time_basis, msg_idx, quoted, trace, plugin, bot_id
               FROM events WHERE bot_id = ? AND chat_id = ? AND seq < ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(this.botId, String(chatId), Number(beforeSeq), lim)
      : this.db
          .prepare(
            `SELECT seq, id, kind, chat_id, user_id, user_name, content, at, time_basis, msg_idx, quoted, trace, plugin, bot_id
               FROM events WHERE bot_id = ? AND chat_id = ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(this.botId, String(chatId), lim);
    return rows.reverse().map(mapRow);
  }

  /**
   * 某会话的最近 N 条**带原始报文**的历史。
   *
   * 和 `recent()` 的区别：这个把 `payload` 也取出来，用于「模拟历史消息接口」——
   * OneBot 的 `get_group_msg_history` 要还原消息段（图片、语音、引用），
   * 只靠 `content` 会把图片全丢掉。
   *
   * 只给内部用（OneBot 兼容层），面板仍然走 `recent()`——那边不需要 payload，
   * 少传一份大字段。
   *
   * @param {object} p
   * @param {string} p.chatId
   * @param {number} [p.limit]
   * @param {number} [p.beforeSeq]
   */
  history({ chatId, limit = 20, beforeSeq } = {}) {
    if (!this.available || this.closed || !chatId) return [];
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const rows = beforeSeq
      ? this.db
          .prepare(
            `SELECT seq, id, kind, chat_id, user_id, user_name, content, at, msg_idx, quoted, payload
               FROM events WHERE bot_id = ? AND chat_id = ? AND seq < ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(this.botId, String(chatId), Number(beforeSeq), lim)
      : this.db
          .prepare(
            `SELECT seq, id, kind, chat_id, user_id, user_name, content, at, msg_idx, quoted, payload
               FROM events WHERE bot_id = ? AND chat_id = ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(this.botId, String(chatId), lim);

    return rows.reverse().map((r) => {
      let payload = null;
      try {
        payload = JSON.parse(r.payload ?? '{}');
      } catch {
        payload = null;
      }
      return { ...mapRow(r), payload };
    });
  }

  /**
   * 某个人说过的话（跨会话）。
   *
   * 面板「身份」页要用它：管理员看到一串 openid 时，得先知道「这人是谁、
   * 在哪个群说过什么」才能确认该绑哪个 QQ号。只有 stats 的计数不够——
   * 计数长得都差不多，一句原文立刻就能认出来。
   *
   * 走 `events_user` 索引 `(bot_id, user_id, at)`，不需要新建索引。
   *
   * @param {object} p
   * @param {string} p.userId  openid
   * @param {number} [p.limit] 默认 20，上限 200
   * @returns {Array<object>} 按时间正序（最后一条是最近的）
   */
  byUser({ userId, limit = 20 } = {}) {
    if (!this.available || this.closed || !userId) return [];
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT seq, id, kind, chat_id, user_id, user_name, content, at, time_basis, msg_idx, quoted, trace, plugin, bot_id
           FROM events WHERE bot_id = ? AND user_id = ?
          ORDER BY at DESC, seq DESC LIMIT ?`,
      )
      .all(this.botId, String(userId), lim);
    return rows.reverse().map(mapRow);
  }

  /** 面板用：总量、时间范围、保留策略 */
  stats() {
    if (!this.available || this.closed) {
      return { available: false, total: 0, retentionDays: this.retentionDays };
    }
    const row = this.db
      .prepare('SELECT COUNT(*) AS n, MIN(at) AS oldest, MAX(at) AS newest, MAX(seq) AS seqMax FROM events')
      .get();
    const refs = this.db.prepare('SELECT COUNT(*) AS n FROM event_refs WHERE resolved = 0').get();
    /**
     * 面板要的「占多少、都有谁」。
     *
     * **`total` / `seqMax` 不能改名**：`test/selftest.mjs` 有 5 处断言在吃它们，
     * `web/server.js:2268` 的兜底也是 `{available:false,total:0}`。
     * 这里只加字段，不换结构。
     */
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
      const wal = `${this.file}-wal`;
      if (fs.existsSync(wal)) bytes += fs.statSync(wal).size;
    } catch {}
    let byChat = [];
    try {
      byChat = this.db
        .prepare(
          `SELECT chat_id, kind, COUNT(*) AS n, MIN(at) AS oldest, MAX(at) AS newest
             FROM events GROUP BY chat_id, kind ORDER BY newest DESC LIMIT 50`,
        )
        .all()
        .map((r) => ({
          chatId: String(r.chat_id ?? ''),
          kind: String(r.kind ?? ''),
          rows: Number(r.n ?? 0),
          oldestAt: Number(r.oldest ?? 0),
          newestAt: Number(r.newest ?? 0),
        }));
    } catch {}
    return {
      available: true,
      total: Number(row?.n ?? 0),
      rows: Number(row?.n ?? 0),
      oldestAt: Number(row?.oldest ?? 0),
      newestAt: Number(row?.newest ?? 0),
      seqMax: Number(row?.seqMax ?? 0),
      unresolvedRefs: Number(refs?.n ?? 0),
      retentionDays: this.retentionDays,
      bytes,
      file: this.file,
      byChat,
    };
  }

  /** 待压缩标记的路径。同目录一个空文件，跨进程有效（照 journal 的做法） */
  vacuumMark() {
    return `${this.file}.vacuum`;
  }

  /**
   * 请求压缩：**只写标记，不在这里 VACUUM**。
   *
   * `DatabaseSync` 是同步 API，VACUUM 锁几秒会把整个进程卡住——所有机器人的
   * 收消息一起停。所以由定时清理（`prune`）顺手消费，面板点完立刻返回。
   */
  requestVacuum() {
    try {
      fs.mkdirSync(path.dirname(this.vacuumMark()), { recursive: true });
      fs.writeFileSync(this.vacuumMark(), String(Date.now()), 'utf8');
      this.needVacuum = true;
      return true;
    } catch (e) {
      log.warn(`压缩标记没写进去：${e.message}`);
      return false;
    }
  }

  /** 有标记就压一次。返回是否真的压了 */
  runVacuumIfAsked() {
    if (!this.available || this.closed || !this.db) return false;
    const mark = this.vacuumMark();
    if (!this.needVacuum && !fs.existsSync(mark)) return false;
    this.needVacuum = false;
    try {
      fs.unlinkSync(mark);
    } catch {}
    try {
      this.db.exec('VACUUM');
      /**
       * `PRAGMA wal_checkpoint` **返回一行结果**，用 `exec` 拿不到，
       * 必须 `prepare().get()`。压完顺手把 WAL 截断，否则文件大小不减。
       */
      try {
        this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      } catch {}
      log.info('账本已压缩');
      return true;
    } catch (e) {
      log.warn(`账本压缩失败：${e.message}`);
      return false;
    }
  }

  /**
   * 手动删记录（面板用）。三种口径互斥，至少要给一个。
   *
   * @param {object} p
   * @param {string} [p.chatId]   限定会话
   * @param {number} [p.before]   删这个时间点之前的
   * @param {number} [p.keepLast] 只保留最近 N 条（**必须同时给 chatId**）
   * @param {string[]} [p.ids]    按 id 精确删
   * @returns {{removed:number, error?:string}}
   */
  remove({ chatId = '', before = 0, keepLast = 0, ids = [] } = {}) {
    if (!this.available || this.closed || !this.db) return { removed: 0, error: '账本没开' };
    const chat = String(chatId || '');
    const ts = Number(before) || 0;
    const keep = Number(keepLast) || 0;
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 500);

    if (!chat && !ts && !keep && !list.length) return { removed: 0, error: '没给删除条件' };
    if (keep && !chat) return { removed: 0, error: '「只保留最近 N 条」必须指定会话' };

    let removed = 0;
    try {
      if (list.length) {
        const marks = list.map(() => '?').join(',');
        removed += Number(
          this.db.prepare(`DELETE FROM events WHERE id IN (${marks})`).run(...list).changes ?? 0,
        );
      }
      if (keep && chat) {
        /**
         * 用 `seq` 而不是 `at` 定「最近 N 条」：同一毫秒可能有多条，
         * 按时间排会留下谁说不清，按自增序号才是确定的。
         */
        removed += Number(
          this.db
            .prepare(
              `DELETE FROM events
                WHERE chat_id = ? AND seq < (
                  SELECT MIN(seq) FROM (
                    SELECT seq FROM events WHERE chat_id = ? ORDER BY seq DESC LIMIT ?
                  )
                )`,
            )
            .run(chat, chat, keep).changes ?? 0,
        );
      } else if (ts) {
        removed += Number(
          this.db
            .prepare(
              `DELETE FROM events WHERE at < ?${chat ? ' AND chat_id = ?' : ''}`,
            )
            .run(...(chat ? [ts, chat] : [ts])).changes ?? 0,
        );
      }
      if (removed) {
        this.db.exec('DELETE FROM event_refs WHERE from_id NOT IN (SELECT id FROM events)');
        this.requestVacuum();
        log.info(`账本手动删除 ${removed} 条${chat ? `（会话 ${chat.slice(0, 8)}）` : ''}`);
      }
      return { removed };
    } catch (e) {
      log.warn(`账本删除失败：${e.message}`);
      return { removed, error: e.message };
    }
  }

  /**
   * 删除前的预览：**只数不删**。
   *
   * 面板的确认框要求用户输入「将删除 N 条」里的 N，这个 N 必须来自服务端——
   * 前端自己算的数和真正删掉的可能不一样（期间有新消息进来），
   * 拿前端的数去校验等于没校验。
   */
  countFor({ chatId = '', before = 0, keepLast = 0 } = {}) {
    if (!this.available || this.closed || !this.db) return 0;
    const chat = String(chatId || '');
    const ts = Number(before) || 0;
    const keep = Number(keepLast) || 0;
    try {
      if (keep && chat) {
        return Number(
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM events
                WHERE chat_id = ? AND seq < (
                  SELECT MIN(seq) FROM (
                    SELECT seq FROM events WHERE chat_id = ? ORDER BY seq DESC LIMIT ?
                  )
                )`,
            )
            .get(chat, chat, keep)?.n ?? 0,
        );
      }
      if (ts) {
        const sql = `SELECT COUNT(*) AS n FROM events WHERE at < ?${chat ? ' AND chat_id = ?' : ''}`;
        return Number(this.db.prepare(sql).get(...(chat ? [ts, chat] : [ts]))?.n ?? 0);
      }
      if (chat) {
        return Number(this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE chat_id = ?').get(chat)?.n ?? 0);
      }
      return Number(this.db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * 批量导入（面板用）。
   *
   * **走 `append()`，不自己拼 SQL**：去重、索引、`event_refs` 清理全复用同一套逻辑。
   * 这样「导回去」和「正常收到」写出来的行没有区别，以后改 schema 也不用改两处。
   *
   * 幂等靠两层：
   *   · 有 `msgId` → dedupe = `botId:msgId`，和原来那条一模一样；
   *   · 没有 `msgId` → dedupe 里带 `at`，同一份文件导两次也只会进一次。
   *
   * @param {Array<object>} rows 每行 `{at, kind, chatId, msgId, userId, userName, content, plugin}`
   * @returns {{added:number, skipped:number, bad:number, error?:string}}
   */
  importRows(rows, { max = 5000 } = {}) {
    if (!this.available || this.closed) return { added: 0, skipped: 0, bad: 0, error: '账本没开' };
    const list = Array.isArray(rows) ? rows.slice(0, max) : [];
    let added = 0;
    let skipped = 0;
    let bad = 0;
    for (const r of list) {
      const at = Number(r?.at);
      const chatId = String(r?.chatId ?? '').trim();
      /**
       * 时间必须能解析成有效毫秒。`resolveTime` 会把解析不出来的当「本地收到时间」，
       * 那样导进来的历史会全部堆到"现在"，时间线彻底失真——所以这里直接拒。
       */
      if (!chatId || !Number.isFinite(at) || at <= 0) {
        bad += 1;
        continue;
      }
      try {
        const got = this.append({
          /** 有 msgId 就用它做去重键；没有就走指纹 */
          id: String(r?.msgId ?? ''),
          kind: String(r?.kind ?? 'group'),
          chatId,
          userId: String(r?.userId ?? ''),
          userName: String(r?.userName ?? ''),
          content: String(r?.content ?? ''),
          plugin: String(r?.plugin ?? ''),
          /**
           * `append()` 只从 `raw.timestamp` 推 `at`（传 `at` 无效）。
           * 给 ISO 字符串，`resolveTime` 会解析成 `basis: 'message'`——
           * 正是「这条消息官方给了时间」的语义。
           */
          raw: { timestamp: new Date(at).toISOString() },
        });
        if (!got) bad += 1;
        else if (got.duplicate) skipped += 1;
        else added += 1;
      } catch {
        bad += 1;
      }
    }
    if (added) {
      this.db.exec('DELETE FROM event_refs WHERE from_id NOT IN (SELECT id FROM events)');
      log.info(`账本导入 ${added} 条（跳过重复 ${skipped}，无效 ${bad}）`);
    }
    return { added, skipped, bad };
  }

  /**
   * 换 openid：把账本里旧 openid 的记录改成新的。
   *
   * 场景：换了 AppID / 重新绑定之后，同一个人的 openid 变了。
   * 旧记录还挂在旧 openid 下，按新 openid 查就是空的——「记忆看起来丢了」。
   *
   * **为什么必须由人指定 from → to**：`identity.js` 的 `bind` 有意不撤销旧 claim
   * （旧 openid 是读旧记忆唯一的线索），所以一个号码下面可能同时有多条 active 的
   * openid，代码无法判断哪条才是"新"的。自动猜必然猜错。
   *
   * `dedupe` **不动**：它里面也含 chatId，但它是唯一键，批量改可能撞车。
   * 代价是这批老消息以后不会被当成重复——它们本来就是历史，不会重推。
   */
  remapOpenid({ from = '', to = '', scope = 'both', dryRun = false } = {}) {
    if (!this.available || this.closed || !this.db) return { chat: 0, user: 0, error: '账本没开' };
    const a = String(from || '').trim();
    const b = String(to || '').trim();
    const sc = scope === 'chat' || scope === 'user' ? scope : 'both';
    if (!a || !b) return { chat: 0, user: 0, error: '要给旧 openid 和新 openid' };
    if (a === b) return { chat: 0, user: 0, error: '新旧是同一个，不用改' };

    const count = (sql) => Number(this.db.prepare(sql).get(a)?.n ?? 0);
    try {
      const out = { chat: 0, user: 0 };
      if (sc !== 'user') out.chat = count('SELECT COUNT(*) AS n FROM events WHERE chat_id = ?');
      if (sc !== 'chat') out.user = count('SELECT COUNT(*) AS n FROM events WHERE user_id = ?');
      if (dryRun) return out;
      if (sc !== 'user') this.db.prepare('UPDATE events SET chat_id = ? WHERE chat_id = ?').run(b, a);
      if (sc !== 'chat') this.db.prepare('UPDATE events SET user_id = ? WHERE user_id = ?').run(b, a);
      if (out.chat || out.user) {
        this.requestVacuum();
        log.info(`账本换 openid：会话 ${out.chat} 条、发送者 ${out.user} 条（${a.slice(0, 8)} → ${b.slice(0, 8)}）`);
      }
      return out;
    } catch (e) {
      log.warn(`账本换 openid 失败：${e.message}`);
      return { chat: 0, user: 0, error: e.message };
    }
  }

  /** 导出用：按条件取行（给 server 拼 CSV） */
  exportRows({ chatId = '', before = 0, limit = 5000 } = {}) {
    if (!this.available || this.closed || !this.db) return [];
    const lim = Math.min(Math.max(Number(limit) || 5000, 1), 50000);
    const chat = String(chatId || '');
    const ts = Number(before) || 0;
    try {
      const where = [];
      const args = [];
      if (chat) { where.push('chat_id = ?'); args.push(chat); }
      if (ts) { where.push('at < ?'); args.push(ts); }
      const sql = `SELECT seq, id, kind, chat_id, msg_id, user_id, user_name, content, at, time_basis, plugin, bot_id
                     FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                    ORDER BY seq ASC LIMIT ?`;
      return this.db.prepare(sql).all(...args, lim);
    } catch (e) {
      log.warn(`账本导出失败：${e.message}`);
      return [];
    }
  }

  close() {
    this.closed = true;
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    try {
      this.db?.close();
    } catch {
      /* 关不上就算了，进程要退了 */
    }
    this.db = null;
    this.available = false;
  }
}

/** 从行里取正文。优先独立列；老数据（只有 payload）退回解析，解析失败给空串 */
function contentOf(row) {
  if (typeof row?.content === 'string' && row.content) return row.content;
  try {
    return String(JSON.parse(row?.payload ?? '{}')?.content ?? '');
  } catch {
    return '';
  }
}

/**
 * events 行 → 对外的对象。
 *
 * 抽出来是因为 `recent()` 和 `byUser()` 查的是同一张表、同一个返回形状，
 * 各写一遍迟早会漏字段（`trace` 就是后加的，漏了没人发现）。
 */
function mapRow(r) {
  return {
    seq: r.seq,
    id: r.id,
    kind: r.kind,
    chatId: r.chat_id,
    /** 哪个机器人实例（运行副本当前是 main）。出站行没有 user_name，靠它显示「谁」 */
    botId: r.bot_id ?? '',
    userId: r.user_id,
    userName: r.user_name,
    at: r.at,
    timeBasis: r.time_basis,
    msgIdx: r.msg_idx,
    quoted: r.quoted,
    // 链路 id：调用方拿它去查「这条消息后来发生了什么」
    trace: r.trace ?? '',
    /**
     * 谁说的（v3）：出站是插件 id，多插件合并时逗号分隔；入站是空串。
     * 别默认成 `''` 就当成"入站"——老库里的出站行也是空串。
     */
    plugin: r.plugin ?? '',
    content: contentOf(r),
  };
}

/**
 * @param {object} p
 * @param {string} p.file
 * @param {string} p.botId
 * @param {boolean} [p.enabled]
 * @param {number} [p.retentionDays]
 */
export function createLedger({ file, botId, enabled, retentionDays }) {
  return new EventLedger({ file, botId, enabled, retentionDays });
}

/** 目录存在性检查，测试和面板诊断用 */
export function ledgerExists(file) {
  try {
    return fs.existsSync(path.resolve(file));
  } catch {
    return false;
  }
}
