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

export const EVENTS_SCHEMA_VERSION = 3;

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

/**
 * v3：谁说的。
 *
 * 出站记录（AI 或别的插件发的消息）要能标出**是哪个插件说的**——
 * ai-chat 读账本时要能分清「这句是我说的」还是「回声说的」。
 *
 * 为什么是逗号分隔的字符串而不是 JSON 数组：一条出站消息可能由多个插件
 * 合并而成（`message.js` 的 `flushReplies` 会把 `【回声】…【AI 对话】…` 拼成一条），
 * 所以值可能是 `echo,ai-chat`。逗号串能直接 `LIKE '%ai-chat%'` 过滤，
 * 也不用为此引 JSON1 函数。
 *
 * 空串的两种含义：入站消息（不是插件发的）、或早于本版（没记）。
 */
const V3 = `
ALTER TABLE events ADD COLUMN plugin TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS events_plugin ON events(plugin) WHERE plugin != '';
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
  /**
   * 同样按「列在不在」判，不看版本号：测试里会用 `DROP COLUMN trace`
   * + 把 user_version 改回 1 的方式造老库，那种库里可能已经有 plugin 列。
   * 只看版本号会撞 `duplicate column name: plugin`，而 `open()` 会把异常
   * 吞成一条 warn —— 表现是「账本静默不可用」，最难查。
   */
  if (!hasColumn(db, 'events', 'plugin')) db.exec(V3);
  db.exec(`PRAGMA user_version = ${EVENTS_SCHEMA_VERSION}`);
  return { from: cur, to: EVENTS_SCHEMA_VERSION };
}
