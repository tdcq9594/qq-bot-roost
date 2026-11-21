/**
 * 统计库的表结构与迁移
 * ====================
 *
 * 迁移用 `PRAGMA user_version` 记版本号，一条 SQL 一个版本往上叠。
 * 不引 ORM、不引 migration 工具——表就这几张，手写更清楚。
 *
 * 设计取舍：
 *   - **只存聚合结果，不存消息正文**。统计要的是「多少条、谁发的、哪天」，
 *     正文属于用户隐私，落库只会让人不敢用。
 *   - `messages` 存明细（能查最近发生了什么、能算去重人数），
 *     `daily` 存按天汇总（画折线扫一行就够，不用全表 group by）。
 *   - `members` 是「最后活跃时间」档案，和 groups.json 不重复：
 *     那个存群，这个存人。
 */

export const SCHEMA_VERSION = 3;

const V1 = `
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,           -- 毫秒时间戳
  day        TEXT    NOT NULL,           -- YYYY-MM-DD（本地时区）
  hour       INTEGER NOT NULL,           -- 0-23
  scope      TEXT    NOT NULL,           -- group / c2c / channel
  chat_id    TEXT    NOT NULL,           -- 群 openid 或用户 openid
  user_id    TEXT    NOT NULL,
  is_command INTEGER NOT NULL DEFAULT 0, -- 1 = 是命令
  command    TEXT                        -- 命令名，非命令为 NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_ts  ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_messages_day ON messages(day);

CREATE TABLE IF NOT EXISTS daily (
  day      TEXT    NOT NULL,
  scope    TEXT    NOT NULL,
  chat_id  TEXT    NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  commands INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);

CREATE TABLE IF NOT EXISTS members (
  scope      TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  messages   INTEGER NOT NULL DEFAULT 0,
  commands   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_last ON members(last_seen);

CREATE TABLE IF NOT EXISTS commands (
  day   TEXT    NOT NULL,
  name  TEXT    NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);
`;

/**
 * v2：投递账本（阶段 5）。
 *
 * 为什么放在统计库而不是事件账本库：deliveries **不含正文**（只有 `digest` 摘要），
 * 和 `stats` 同一个隐私口径（「只存聚合结果」），生命周期也一样（bot 侧、跟着机器人走）。
 * events 库是 7 天滚动删的全文库，投递记录要活得更久。
 *
 * `digest` 不存全文，沿用 `schema.js` 的原则。全文只在事件账本里。
 */
const V2 = `
CREATE TABLE IF NOT EXISTS deliveries (
  request_id  TEXT PRIMARY KEY,   -- 幂等键，由调用方给（qq_send 生成）
  bot_id      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,   -- group / c2c
  chat_id     TEXT    NOT NULL,
  reply_to    TEXT,               -- 被动回复时的 msg_id
  msg_seq     INTEGER,            -- 群 1..5 / 单聊 1..4，官方硬限制
  digest      TEXT    NOT NULL,   -- 前 120 字 + 总长 + sha1 前 8 位
  state       TEXT    NOT NULL,   -- pending/sent/audited/failed/unknown
  msg_id      TEXT,
  code        TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  settled_at  INTEGER
);
CREATE INDEX IF NOT EXISTS deliveries_chat ON deliveries(bot_id, chat_id, created_at);
CREATE INDEX IF NOT EXISTS deliveries_open ON deliveries(state) WHERE state IN ('pending','unknown');
`;

/**
 * v3：这条是从哪个口子发出去的。
 *
 * 和事件账本的 `events.source` 同一套取值（plugin / host / onebot / api）。
 * 为什么投递账本也要：面板「投递」页以前只能看到「发给了谁、成没成」，
 * 分不出「这是 OneBot 客户端要发的」还是「ai-chat 回的话」——出问题时
 * 不知道该去查哪一层。空串表示早于本版，不代表任何具体来源。
 */
const V3 = `
ALTER TABLE deliveries ADD COLUMN source TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS deliveries_source ON deliveries(bot_id, source) WHERE source != '';
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
 * 把库升到最新结构。
 * @param {object} db DatabaseSync
 */
export function migrate(db) {
  const cur = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (cur >= SCHEMA_VERSION) return { from: cur, to: cur };

  // 以后加表就往这里追加：if (cur < 3) { ... }
  if (cur < 1) db.exec(V1);
  if (cur < 2) db.exec(V2);
  /**
   * `hasColumn` 这里也要判一次：v2 的库被人手工补过列、版本号却还是 2 时，
   * 只看版本会撞 `duplicate column name: source`，而异常会被上层吞成一条
   * warn —— 表现是「投递账本静默不可用」。
   */
  if (cur < 3 && !hasColumn(db, 'deliveries', 'source')) db.exec(V3);

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { from: cur, to: SCHEMA_VERSION };
}
