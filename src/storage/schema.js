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

export const SCHEMA_VERSION = 1;

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
 * 把库升到最新结构。
 * @param {object} db DatabaseSync
 */
export function migrate(db) {
  const cur = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (cur >= SCHEMA_VERSION) return { from: cur, to: cur };

  // 以后加表就往这里追加：if (cur < 2) { ... }
  if (cur < 1) db.exec(V1);

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { from: cur, to: SCHEMA_VERSION };
}
