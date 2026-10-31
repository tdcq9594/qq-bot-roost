/**
 * 事件账本的表结构
 * ==================
 *
 * 和 `schema.js`（统计库）分开：两套表在**两个文件**里，各有各的 `user_version`。
 * 混在一份里的话，加账本表就得动统计库的版本号，升级路径互相牵连。
 *
 * ── 为什么不复用 `messages` 表 ──
 *
 * `messages` 是「计数」，只记谁在哪天发了多少条，**刻意不存正文**。
 * 账本是「发生过什么」，必须存正文——这两件事的隐私承诺相反，
 * 合表等于把统计库那句「不存消息正文」变成假话。
 */

export const EVENTS_SCHEMA_VERSION = 2;

const V1 = `
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT    NOT NULL UNIQUE,
  bot_id       TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  chat_id      TEXT    NOT NULL,
  msg_id       TEXT,
  user_id      TEXT,
  user_name    TEXT,
  -- 正文单独一列，不是「payload 里反正有」。
  -- 两个原因：① payload 有大小上限，截断时正文不能跟着丢；
  --          ② 将来要做全文检索（FTS/LIKE）必须有独立列，藏在 JSON 里查不了。
  content      TEXT    NOT NULL DEFAULT '',
  at           INTEGER NOT NULL,
  observed_at  INTEGER NOT NULL,
  time_basis   TEXT    NOT NULL,
  dedupe       TEXT    NOT NULL UNIQUE,
  msg_idx      TEXT,
  ref_msg_idx  TEXT,
  union_openid TEXT,
  quoted       TEXT,
  payload      TEXT    NOT NULL
);

-- 邻文查询：按会话 + 时间取前后几条。
-- 把 time_basis 放进索引的 WHERE，是为了**不让 unknown 进索引**——
-- 时间不可靠的事件拼出来的上下文看着合理但是错的，比没有更糟。
CREATE INDEX IF NOT EXISTS events_timeline
  ON events(bot_id, chat_id, at, seq) WHERE time_basis != 'unknown';

CREATE INDEX IF NOT EXISTS events_user ON events(bot_id, user_id, at);
CREATE INDEX IF NOT EXISTS events_at   ON events(at);

CREATE TABLE IF NOT EXISTS event_refs (
  from_id   TEXT    NOT NULL,
  to_id     TEXT,
  to_msg_id TEXT,
  kind      TEXT    NOT NULL,
  resolved  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS refs_from ON event_refs(from_id);
CREATE INDEX IF NOT EXISTS refs_to   ON event_refs(to_id) WHERE resolved = 1;
`;

/**
 * v2：链路 id。
 *
 * 一条消息从进站到回话的唯一标识（见 `src/trace.js`）。加它的理由很具体：
 * 用户说"刚才那条没回"，现在只能翻四个日志文件对时间戳；有了这一列，
 * 拿 traceId 一条 SQL 就能找到那次请求对应的原文。
 *
 * 老库补空串——空串表示"这条早于 traceId 上线"，不是"查不到"。
 */
const V2 = `
ALTER TABLE events ADD COLUMN trace TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS events_trace ON events(bot_id, trace) WHERE trace != '';
`;

/** 表里有没有这一列（迁移要幂等，重复 ALTER 会抛） */
function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}

/**
 * @param {object} db DatabaseSync
 */
export function migrateEvents(db) {
  const cur = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (cur >= EVENTS_SCHEMA_VERSION) return { from: cur, to: cur };
  if (cur < 1) db.exec(V1);
  /**
   * 幂等：老库里如果已经手工加过这一列，`ALTER` 会抛 duplicate column。
   * 版本号可能因为半途失败停在 1，所以这里必须按「列在不在」判断，不能只看版本。
   */
  if (!hasColumn(db, 'events', 'trace')) db.exec(V2);
  db.exec(`PRAGMA user_version = ${EVENTS_SCHEMA_VERSION}`);
  return { from: cur, to: EVENTS_SCHEMA_VERSION };
}
