/**
 * SQLite 连接
 * ===========
 *
 * 用 Node 22 内置的 `node:sqlite`，**不引第三方包**——零依赖是项目的底线，
 * 不能因为要统计就破掉。
 *
 * 用 `createRequire` 而不是 `import 'node:sqlite'`：静态 import 在低版本 Node 上
 * 会直接让整个进程起不来；这里要的是「没有 SQLite 也能跑，只是没统计」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let mod = null;
let probed = false;

/**
 * 探测 `node:sqlite` 是否可用。
 * @returns {{DatabaseSync: Function}|null}
 */
export function probeSqlite() {
  if (probed) return mod;
  probed = true;
  try {
    mod = require('node:sqlite');
    if (typeof mod?.DatabaseSync !== 'function') mod = null;
  } catch {
    mod = null;
  }
  return mod;
}

/**
 * 打开一个数据库并设好 pragma。
 *
 * - WAL：读写不互相阻塞，面板查询统计时不会卡住收消息
 * - synchronous=NORMAL：WAL 下够安全，比 FULL 快一个数量级
 * - busy_timeout：多机器人各开各的库，偶尔仍会撞锁，等 3 秒比直接报错好
 *
 * @param {string} file
 */
export function openDatabase(file) {
  const sqlite = probeSqlite();
  if (!sqlite) throw new Error('当前 Node 不支持 node:sqlite（需要 22.5 以上）');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}
