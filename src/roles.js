import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { createLogger } from './logger.js';

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
 *   等级 level —— 「能管谁」
 *     100 owner    主人（只来自 config.json 的 owners，不可通过命令授予）
 *      80 admin    管理员：可管理本作用域内的 manager / helper
 *      60 manager  协管：可管理本作用域内的 helper
 *      40 helper   助手：只能使用被授权的功能，不能管人
 *
 * 有效等级 = max(全局等级, 当前作用域等级)
 * 例：某人是全局 admin(80)，在任何一个群里都是 80；
 *     某人只是 A 群的 manager(60)，在 B 群就是 0。
 */
export const LEVEL = {
  owner: 100,
  admin: 80,
  manager: 60,
  helper: 40,
};

export const LEVEL_NAME = {
  100: '主人',
  80: '管理员',
  60: '协管',
  40: '助手',
  0: '普通成员',
};

/** 命令里可以写的等级别名 */
const LEVEL_ALIAS = {
  owner: 100,
  admin: 80,
  manager: 60,
  helper: 40,
  主人: 100,
  管理员: 80,
  协管: 60,
  助手: 40,
};

export function parseLevel(input) {
  if (input === undefined || input === null || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (s in LEVEL_ALIAS) return LEVEL_ALIAS[s];
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

export function levelName(n) {
  return LEVEL_NAME[n] ?? (n > 0 ? `${n}级` : '普通成员');
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

export class RoleStore {
  constructor() {
    this.data = null; // { "<scope>": { "<openid>": level } }
    this.dirty = false;
    this.timer = null;
  }

  async #load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    } catch {
      this.data = {};
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

  /** 某人某作用域的等级（不含全局继承） */
  async levelIn(scope, openid) {
    const d = await this.#load();
    return d[scope]?.[openid] ?? 0;
  }

  /** 有效等级 = max(全局, 当前作用域) */
  async effective(scope, openid, { owners = [] } = {}) {
    if (!openid) return 0;
    if (owners.includes(openid)) return LEVEL.owner;
    const d = await this.#load();
    const g = d.global?.[openid] ?? 0;
    const s = scope === 'global' ? 0 : d[scope]?.[openid] ?? 0;
    return Math.max(g, s);
  }

  async set(scope, openid, level) {
    if (!scope || !openid) return false;
    const d = await this.#load();
    if (!d[scope]) d[scope] = {};
    d[scope][openid] = level;
    this.#scheduleSave();
    log.info(`设置权限 ${scope} ${openid} = ${levelName(level)}`);
    return true;
  }

  async remove(scope, openid) {
    const d = await this.#load();
    if (!d[scope]?.[openid]) return false;
    delete d[scope][openid];
    if (!Object.keys(d[scope]).length) delete d[scope];
    this.#scheduleSave();
    return true;
  }

  /** 某人所在的所有作用域，用于 /admin me */
  async scopesOf(openid) {
    const d = await this.#load();
    const out = [];
    for (const [scope, members] of Object.entries(d)) {
      if (members[openid]) out.push({ scope, level: members[openid] });
    }
    return out.sort((a, b) => b.level - a.level);
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
