import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { createLogger } from './logger.js';
import { NO_PERM as LEVELS_NO_PERM, describeLevel, PLUGIN_START } from './levels.js';

const log = createLogger('roles');
const FILE = path.join(DATA_DIR, 'roles.json');

/**
 * 权限模型
 * ========
 * 两个维度，分开看：
 *
 *   作用域 scope —— 「在哪管」
 *     global              全局
 *     group:<群openid>    某个群
 *     channel:<频道id>    某个频道
 *     user:<用户openid>   某人的私聊
 *     feature:<插件id>    某个功能（插件）的管理权
 *
 *   等级 level —— 「能管谁」，**数字越小权限越高**
 *     0    主人（只来自 config.json 的 owners，不可通过命令授予）
 *     1    管理员
 *     2    群管
 *     3    助手
 *     4 - 9    内核预留
 *     10 - 998 插件区（主程序按插件 id 动态分配号段）
 *     9999     无权限（普通成员）
 *
 * 有效等级 = min(全局等级, 当前作用域等级)   ← 越小越高，所以取更小的那个
 * 例：某人是全局 1，在任何一个群里都是 1；
 *     某人只是 A 群的 2，在 B 群就是 99（无权限）。
 */
export const LEVEL = {
  owner: 0,
  admin: 1,
  manager: 2,
  helper: 3,
};

/** 无任何权限时的等级值 */
export const NO_PERM = LEVELS_NO_PERM;

/** 允许通过命令授予的最大等级号（插件区上限） */
export const MAX_ASSIGNABLE = 998;

/** 名字 → 等级 */
const LEVEL_ALIAS = {
  owner: 0,
  admin: 1,
  manager: 2,
  helper: 3,
  主人: 0,
  管理员: 1,
  群管: 2,
  协管: 2, // 旧叫法，兼容
  助手: 3,
};

export function parseLevel(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s in LEVEL_ALIAS) return LEVEL_ALIAS[s];
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > MAX_ASSIGNABLE) return null;
  return n;
}

export function levelName(n) {
  if (n === undefined || n === null) return '普通成员';
  return describeLevel(n);
}

/** 等级是否达到要求（数字越小越高） */
export function atLeast(level, need) {
  return level <= need;
}

/** 从消息推断当前作用域 */
export function scopeOf(msg) {
  if (!msg) return 'global';
  if (msg.kind === 'group') return `group:${msg.groupId}`;
  if (msg.kind === 'guild' || msg.kind === 'dm') return `channel:${msg.groupId}`;
  if (msg.kind === 'c2c') return `user:${msg.userId}`;
  return 'global';
}

/** 解析作用域写法：here / global / group:xxx / feature:xxx ... */
export function parseScope(input, msg) {
  const s = String(input ?? '').trim();
  if (!s || s === 'here' || s === '本群' || s === '当前') return scopeOf(msg);
  if (s === 'global' || s === '全局') return 'global';
  if (/^(group|channel|user|feature):.+/.test(s)) return s;
  return null;
}

/** 旧版本用的是 100/80/60/40，读取时转成新的 0/1/2/3 */
const LEGACY_MAP = { 100: 0, 80: 1, 60: 2, 40: 3 };

export class RoleStore {
  constructor() {
    this.data = null; // { "<scope>": { "<openid>": level } }
    this.dirty = false;
    this.timer = null;
    // 有效等级缓存：`${scope}\u0000${openid}` -> level
    // 权限很少变，但每条消息都要查好几次，缓存后基本零成本
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0 };
  }

  /** 缓存命中情况，用于 /stats 观测 */
  cacheStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: total ? Math.round((this.stats.hits / total) * 100) : 0,
    };
  }

  async #load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    } catch {
      this.data = {};
    }

    // 兼容旧数据：把 100/80/60/40 迁移成 0/1/2/3
    let migrated = false;
    for (const members of Object.values(this.data)) {
      for (const [oid, lv] of Object.entries(members)) {
        if (lv >= 40 && LEGACY_MAP[lv] !== undefined) {
          members[oid] = LEGACY_MAP[lv];
          migrated = true;
        }
      }
    }
    if (migrated) {
      log.info('已把旧版权限等级迁移为「0 最高」格式');
      this.cache.clear();
      this.#scheduleSave();
    }
    return this.data;
  }

  #scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 300);
    this.timer.unref?.();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(this.data, null, 2), 'utf8');
  }

  async all() {
    return await this.#load();
  }

  /** 某作用域下的全部成员 { openid: level } */
  async scopeMembers(scope) {
    const d = await this.#load();
    return { ...(d[scope] ?? {}) };
  }

  /** 某人某作用域的等级（不含全局继承），没有则 NO_PERM */
  async levelIn(scope, openid) {
    const d = await this.#load();
    return d[scope]?.[openid] ?? NO_PERM;
  }

  /** 有效等级 = min(全局, 当前作用域)，越小权限越高 */
  async effective(scope, openid, { owners = [] } = {}) {
    if (!openid) return NO_PERM;
    // 主人优先，不查缓存（owners 可能在运行中变化）
    if (owners.includes(openid)) return LEVEL.owner;

    const key = `${scope}\u0000${openid}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.hits += 1;
      return cached;
    }
    this.stats.misses += 1;

    const d = await this.#load();
    const g = d.global?.[openid] ?? NO_PERM;
    const s = scope === 'global' ? NO_PERM : d[scope]?.[openid] ?? NO_PERM;
    const v = Math.min(g, s);
    this.cache.set(key, v);
    return v;
  }

  async set(scope, openid, level) {
    if (!scope || !openid) return false;
    const d = await this.#load();
    if (!d[scope]) d[scope] = {};
    d[scope][openid] = level;
    this.cache.clear(); // 写操作很少，直接全清最省心
    this.#scheduleSave();
    log.info(`设置权限 ${scope} ${openid} = ${levelName(level)}(${level})`);
    return true;
  }

  async remove(scope, openid) {
    const d = await this.#load();
    if (!d[scope]?.[openid]) return false;
    delete d[scope][openid];
    if (!Object.keys(d[scope]).length) delete d[scope];
    this.cache.clear();
    this.#scheduleSave();
    return true;
  }

  /** 某人所在的所有作用域，用于 /admin me */
  async scopesOf(openid) {
    const d = await this.#load();
    const out = [];
    for (const [scope, members] of Object.entries(d)) {
      if (members[openid] !== undefined) out.push({ scope, level: members[openid] });
    }
    // 数字小的权限高，升序排前面
    return out.sort((a, b) => a.level - b.level);
  }

  /** 列出所有已配置的作用域及其人数 */
  async listScopes() {
    const d = await this.#load();
    return Object.entries(d)
      .map(([scope, members]) => ({ scope, count: Object.keys(members).length }))
      .filter((x) => x.count > 0)
      .sort((a, b) => a.scope.localeCompare(b.scope));
  }
}
