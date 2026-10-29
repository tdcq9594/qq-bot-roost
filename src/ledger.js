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
   * @param {number} [p.retentionDays] 保留天数，默认 7
   */
  constructor({ file, botId = '', enabled = true, retentionDays = 7 }) {
    this.file = file;
    this.botId = botId;
    this.enabled = enabled !== false;
    this.retentionDays = Math.max(1, Number(retentionDays) || 7);

    this.db = null;
    this.available = false;
    this.closed = false;
    this.pruneTimer = null;
    /** 只在第一次出错时提醒，别刷屏 */
    this.warned = false;
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
             msg_idx, ref_msg_idx, union_openid, quoted, payload)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        );
      // changes === 0 说明撞了 dedupe 唯一约束 = 官方重推的同一条消息
      if (!r?.changes) return null;
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
    this.resolveRefs();

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
            `SELECT seq, id, kind, chat_id, user_id, user_name, content, at, time_basis, msg_idx, quoted
               FROM events WHERE bot_id = ? AND chat_id = ? AND seq < ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(this.botId, String(chatId), Number(beforeSeq), lim)
      : this.db
          .prepare(
            `SELECT seq, id, kind, chat_id, user_id, user_name, content, at, time_basis, msg_idx, quoted
               FROM events WHERE bot_id = ? AND chat_id = ?
              ORDER BY seq DESC LIMIT ?`,
          )
          .all(this.botId, String(chatId), lim);
    return rows.reverse().map((r) => ({
      seq: r.seq,
      id: r.id,
      kind: r.kind,
      chatId: r.chat_id,
      userId: r.user_id,
      userName: r.user_name,
      at: r.at,
      timeBasis: r.time_basis,
      msgIdx: r.msg_idx,
      quoted: r.quoted,
      content: contentOf(r),
    }));
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
    return {
      available: true,
      total: Number(row?.n ?? 0),
      oldestAt: Number(row?.oldest ?? 0),
      newestAt: Number(row?.newest ?? 0),
      seqMax: Number(row?.seqMax ?? 0),
      unresolvedRefs: Number(refs?.n ?? 0),
      retentionDays: this.retentionDays,
    };
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
