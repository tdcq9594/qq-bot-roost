/**
 * 投递账本
 * ========
 *
 * 一句话：**发出的每一条消息都有据可查，且永远不会因为「不确定」而被重发。**
 *
 * ── 为什么需要 ──
 *
 * 现在「我说过 X」靠**调用顺序**保证——必须挂在发送成功之后。
 * 这在 `msg_seq` 群 1–5 / 单聊 1–4 的约束下很脆：一次超时重发就撞上限流，
 * 还会把「我说过」写进记忆，形成自洽幻觉（她坚称自己说过一句没人看见的话）。
 *
 * 改造后靠**状态查询**：顺序会被并发打乱，状态不会。
 *
 * ── 状态机 ──
 *
 *                     ┌──────── 304023 ────────→ audited（等审核事件结算）
 *                     │
 *   created → pending ┼──────── 有 msg_id ──────→ sent
 *                     │
 *                     ├── 超窗/配额/离线/限流 ──→ failed（可重试）
 *                     │
 *                     └── 超时/5xx/连接重置 ───→ unknown（**永不自动重发**）
 *
 * 三个非显然的点：
 *
 * 1. **`audited` 不是成功也不是失败。** 官方文档里的 `pending` 指「结果未确定」，
 *    而账本里的 `pending` 指「尚未发出」——两个 `pending` 会打架，所以这里叫 `audited`。
 *    审核期间**不能回写「我说过」**，否则审核不通过就变成她坚称说过一句没人看见的话。
 *
 * 2. **`unknown` 必须存在。** 网络超时后我们**无法知道**服务端是否收到。
 *    原则是「未知结果必须人工核对，绝不自动重发」——官方配额下重发的代价更高
 *    （撞限流 + 重复消息）。
 *
 * 3. **`pending` 会在崩溃后残留。** 启动时扫一遍全部转 `unknown`。
 *    不做这一步，重启后这些记录永远卡在「正在发送」。
 */

import { createHash } from 'node:crypto';

export const DELIVERY_STATE = {
  PENDING: 'pending',
  SENT: 'sent',
  AUDITED: 'audited',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
};

const ALL_STATES = new Set(Object.values(DELIVERY_STATE));

/**
 * 摘要：前 120 字 + 总长 + sha1 前 8 位。
 *
 * **不存全文**——沿用 `schema.js` 的原则「只存聚合结果，不存消息正文」。
 * 全文只在事件账本里（且受 7 天保留策略约束）。
 * 摘要的用途是「人工核对时认出是哪一条」，不是「重发时照抄」。
 *
 * @param {string} text
 * @returns {string}
 */
export function digestOf(text) {
  const s = String(text ?? '');
  const sha = createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 8);
  return `${s.slice(0, 120)}…(${s.length})#${sha}`;
}

/**
 * @param {object} o
 * @param {object} o.db      StatsStore 的 DatabaseSync（库不可用时为 null）
 * @param {string} o.botId
 * @param {(m:string)=>void} [o.log]
 */
export function createDeliveryLedger({ db, botId, log = () => {} }) {
  const ready = () => Boolean(db);

  /**
   * 认领一次发送。
   *
   * 这是整个账本的入口：**同一个 requestId 调多少次，都只有第一次会真的发**。
   *
   * @param {object} p
   * @param {string} p.requestId 幂等键，由调用方给（`qq_send` 生成）
   * @param {'group'|'c2c'} p.kind
   * @param {string} p.chatId
   * @param {string} [p.replyTo]  被动回复时的 msg_id
   * @param {number} [p.msgSeq]
   * @param {string} p.digest
   * @returns {{action:'send'|'reuse'|'unknown'|'wait', row?:object}}
   *   - `send`    没发过 / 上次 failed，可以发
   *   - `reuse`   已经 sent/audited，直接返回上次结果
   *   - `unknown` 上次结果未知，**不能重发**
   *   - `wait`    正在发送中（并发调用）
   */
  function claim({ requestId, kind, chatId, replyTo, msgSeq, digest }) {
    if (!ready()) return { action: 'send' };
    const id = String(requestId ?? '').trim();
    if (!id) return { action: 'send' };

    try {
      const row = db.prepare('SELECT * FROM deliveries WHERE request_id = ?').get(id);
      if (!row) {
        db.prepare(
          `INSERT INTO deliveries
             (request_id, bot_id, kind, chat_id, reply_to, msg_seq, digest, state, attempts, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          id,
          botId,
          String(kind ?? ''),
          String(chatId ?? ''),
          replyTo ?? null,
          msgSeq ?? null,
          String(digest ?? ''),
          DELIVERY_STATE.PENDING,
          0,
          Date.now(),
        );
        return { action: 'send' };
      }

      if (row.state === DELIVERY_STATE.SENT || row.state === DELIVERY_STATE.AUDITED) {
        return { action: 'reuse', row };
      }
      if (row.state === DELIVERY_STATE.UNKNOWN) return { action: 'unknown', row };
      if (row.state === DELIVERY_STATE.PENDING) return { action: 'wait', row };

      // failed：允许重试，复用同一行（不新建，否则同一个 requestId 会散成好几条）
      db.prepare(
        'UPDATE deliveries SET state = ?, attempts = attempts + 1, code = NULL, settled_at = NULL WHERE request_id = ?',
      ).run(DELIVERY_STATE.PENDING, id);
      return { action: 'send', row };
    } catch (e) {
      /**
       * 账本坏了不能把消息也堵死。
       * 记账是增强，发送是主链路——这里退回「照发」，并留一条日志。
       */
      log(`投递账本认领失败（照常发送）：${e.message}`);
      return { action: 'send' };
    }
  }

  /**
   * 结算。
   *
   * @param {string} requestId
   * @param {string} state `sent` / `audited` / `failed` / `unknown`
   * @param {{msgId?:string, code?:string}} [extra]
   */
  function settle(requestId, state, { msgId, code } = {}) {
    if (!ready()) return false;
    const id = String(requestId ?? '').trim();
    if (!id) return false;
    if (!ALL_STATES.has(state) || state === DELIVERY_STATE.PENDING) {
      log(`投递账本结算状态不合法：${state}`);
      return false;
    }
    try {
      const r = db
        .prepare(
          'UPDATE deliveries SET state = ?, msg_id = ?, code = ?, settled_at = ? WHERE request_id = ?',
        )
        .run(state, msgId ?? null, code ?? null, Date.now(), id);
      /**
       * 返回**是否真的更新了一行**。
       *
       * 结算一个不存在的 requestId 会静默 0 行——以前这里无条件 `return true`，
       * 调用方以为结算成功，实际那条记录还是 pending，重启后又被转成 unknown。
       */
      return Number(r?.changes ?? 0) > 0;
    } catch (e) {
      log(`投递账本结算失败：${e.message}`);
      return false;
    }
  }

  /**
   * 崩溃恢复：把所有 `pending` 转 `unknown`。
   *
   * 只在**启动时**调。那时没有任何发送在跑，所以 `pending` 一定是上次崩了
   * 留下的——那些消息我们不知道发没发出去，只能标未知，等人核对。
   *
   * @returns {number} 转了多少条
   */
  function recoverPending() {
    if (!ready()) return 0;
    try {
      const r = db
        .prepare(
          `UPDATE deliveries SET state = ?, code = 'crash', settled_at = ? WHERE state = ?`,
        )
        .run(DELIVERY_STATE.UNKNOWN, Date.now(), DELIVERY_STATE.PENDING);
      const n = Number(r?.changes ?? 0);
      if (n > 0) log(`${n} 条投递记录在崩溃前没结算，已标为未知（不会自动重发）`);
      return n;
    } catch (e) {
      log(`投递账本恢复失败：${e.message}`);
      return 0;
    }
  }

  /** 查一条（面板 / 跨进程桥 3 用） */
  function get(requestId) {
    if (!ready()) return null;
    try {
      return db.prepare('SELECT * FROM deliveries WHERE request_id = ?').get(String(requestId ?? '')) ?? null;
    } catch {
      return null;
    }
  }

  /** 最近若干条，面板用 */
  function recent({ limit = 50, state = '' } = {}) {
    if (!ready()) return [];
    try {
      const n = Math.min(200, Math.max(1, Number(limit) || 50));
      return state
        ? db.prepare('SELECT * FROM deliveries WHERE state = ? ORDER BY created_at DESC LIMIT ?').all(state, n)
        : db.prepare('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT ?').all(n);
    } catch {
      return [];
    }
  }

  /** 统计：每种状态多少条。面板卡片用 */
  function stats() {
    if (!ready()) return { available: false };
    try {
      const rows = db.prepare('SELECT state, COUNT(*) AS c FROM deliveries GROUP BY state').all();
      const by = Object.fromEntries(rows.map((r) => [r.state, Number(r.c)]));
      return { available: true, by, total: Object.values(by).reduce((a, b) => a + b, 0) };
    } catch {
      return { available: false };
    }
  }

  /**
   * 审核事件结算（`MESSAGE_AUDIT_PASS` / `MESSAGE_AUDIT_REJECT`）。
   *
   * 官方在审核有结果时推事件，事件里带的是 `msg_id`（不是我们给的 requestId），
   * 所以按 `msg_id` 反查。
   *
   * @param {string} msgId
   * @param {boolean} passed
   * @returns {boolean} 有没有找到并结算
   */
  function settleByMsgId(msgId, passed) {
    if (!ready()) return false;
    const id = String(msgId ?? '').trim();
    if (!id) return false;
    try {
      const r = db
        .prepare(
          `UPDATE deliveries SET state = ?, code = ?, settled_at = ?
            WHERE msg_id = ? AND state = ?`,
        )
        .run(
          passed ? DELIVERY_STATE.SENT : DELIVERY_STATE.FAILED,
          passed ? null : 'audit-reject',
          Date.now(),
          id,
          DELIVERY_STATE.AUDITED,
        );
      return Number(r?.changes ?? 0) > 0;
    } catch (e) {
      log(`审核结算失败：${e.message}`);
      return false;
    }
  }

  /**
   * 一条逻辑消息可能对应好几行。
   *
   * 为什么：被动回复超过 1800 字时，发送层会切成几块各发一次，
   * 每块一个幂等键（`${base}#1`、`${base}#2`…，见 ai-chat 的 `sendReply`）。
   * 这是必须的——共用一个 id 的话第 2 块起会被 `claim` 判成 `reuse` 直接丢掉。
   *
   * 但「这条消息到底送没送到」问的是**整条**，不是某一块。所以这里把
   * base 和它的所有分块聚合成一个状态。
   *
   * 聚合规则按「坏消息优先」：只要有一块 `unknown`，整条就是 `unknown`
   * （**绝不能重发**——重发会把已经出去的那块再发一遍）；有一块 `failed`
   * 就是 `failed`（可重试，重试只会补没发出去的那块，因为 id 是确定的）；
   * 还在飞就是 `pending`；等审核是 `audited`；全成功才是 `sent`。
   *
   * @param {string} requestId base id
   * @returns {null | {state:string, parts:number, msgId:string, code:string,
   *   attempts:number, at:number, rows:object[]}}
   */
  function family(requestId) {
    if (!ready()) return null;
    const base = String(requestId ?? '').trim();
    if (!base) return null;
    /**
     * `LIKE` 里的 `%` `_` 要转义，否则 base 里带这两个字符会误匹配到别人的行。
     * requestId 是我们自己生成的（`qs-…` / `sp-…`），正常不会有，
     * 但这里是公共入口，不能靠上游自觉。
     */
    const esc = base.replace(/[\\%_]/g, (m) => `\\${m}`);
    try {
      const rows = db
        .prepare(`SELECT * FROM deliveries WHERE request_id = ? OR request_id LIKE ? ESCAPE '\\' ORDER BY request_id`)
        .all(base, `${esc}#%`);
      if (!rows.length) return null;

      const rank = {
        [DELIVERY_STATE.SENT]: 0,
        [DELIVERY_STATE.AUDITED]: 1,
        [DELIVERY_STATE.PENDING]: 2,
        [DELIVERY_STATE.FAILED]: 3,
        [DELIVERY_STATE.UNKNOWN]: 4,
      };
      let worst = rows[0];
      for (const r of rows) if ((rank[r.state] ?? 0) > (rank[worst.state] ?? 0)) worst = r;

      /** 报最坏那块的 msg_id / code，人核对时想知道的是「哪块出问题了」 */
      const at = rows.reduce((m, r) => Math.max(m, Number(r.settled_at || r.created_at || 0)), 0);
      return {
        state: worst.state,
        parts: rows.length,
        msgId: worst.msg_id || '',
        code: worst.code || '',
        attempts: rows.reduce((m, r) => Math.max(m, Number(r.attempts || 0)), 0),
        at,
        rows,
      };
    } catch (e) {
      log(`投递账本家族查询失败：${e.message}`);
      return null;
    }
  }

  return { claim, settle, settleByMsgId, recoverPending, get, family, recent, stats };
}
