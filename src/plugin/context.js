import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import { scopeOf, LEVEL, NO_PERM, levelName } from '../roles.js';

/**
 * 全局注册表：所有插件注册的命令和事件监听都放这里。
 * 重载插件时按 pluginId 精确清除，互不影响。
 */
export class Registry {
  constructor() {
    this.commands = new Map(); // name -> { pluginId, desc, usage, admin, handler }
    this.listeners = new Map(); // eventName -> [{ pluginId, handler }]
    // pluginId -> { id, title, desc, sections: [{ title, items: [{ text, desc, isCommand }] }] }
    this.menus = new Map();
  }

  clearPlugin(id) {
    for (const [name, entry] of this.commands) {
      if (entry.pluginId === id) this.commands.delete(name);
    }
    for (const [event, list] of this.listeners) {
      const kept = list.filter((l) => l.pluginId !== id);
      if (kept.length) this.listeners.set(event, kept);
      else this.listeners.delete(event);
    }
    this.menus.delete(id);
  }

  /** 取（或建）某插件的菜单 */
  ensureMenu(pluginId, meta = {}) {
    if (!this.menus.has(pluginId)) {
      this.menus.set(pluginId, {
        id: pluginId,
        title: meta.name ?? pluginId,
        desc: meta.description ?? '',
        version: meta.version ?? '',
        sections: [],
      });
    }
    const m = this.menus.get(pluginId);
    // 元信息可能后到，补一下
    if (meta.name) m.title = meta.name;
    if (meta.description) m.desc = meta.description;
    if (meta.version) m.version = meta.version;
    return m;
  }

  /** 往某插件的菜单里加一组条目 */
  addMenuSection(pluginId, meta, title, items) {
    const menu = this.ensureMenu(pluginId, meta);
    const name = title || '其它';
    let sec = menu.sections.find((x) => x.title === name);
    if (!sec) {
      sec = { title: name, items: [] };
      menu.sections.push(sec);
    }
    for (const it of items) {
      const text = typeof it === 'string' ? it : it.text ?? it.cmd ?? '';
      if (!text) continue;
      sec.items.push({
        text,
        desc: (typeof it === 'object' && it.desc) || '',
        isCommand: Boolean(typeof it === 'object' && it.cmd) || false,
        admin: Boolean(typeof it === 'object' && it.admin),
        globalAdmin: Boolean(typeof it === 'object' && it.globalAdmin),
      });
    }
    return sec;
  }

  /** 该插件是否提供了菜单（有命令也算） */
  hasMenu(pluginId) {
    const m = this.menus.get(pluginId);
    return Boolean(m && m.sections.some((s) => s.items.length));
  }

  addCommand(pluginId, name, meta, handler) {
    const key = name.toLowerCase();
    if (this.commands.has(key)) {
      const owner = this.commands.get(key).pluginId;
      throw new Error(`命令 "${name}" 已被插件 ${owner} 注册`);
    }
    this.commands.set(key, { pluginId, name: key, ...meta, handler });

    // 命令自动进菜单的「指令」分组，插件不用重复声明
    this.addMenuSection(
      pluginId,
      { name: meta.plugin },
      '指令',
      [{ cmd: meta.pattern ?? key, desc: meta.desc ?? '', admin: meta.admin, globalAdmin: meta.globalAdmin }],
    );
  }

  addListener(pluginId, event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push({ pluginId, handler });
  }
}

/** 每个插件一个简单的 JSON 键值存储，游戏存档之类可以直接用 */
class PluginStorage {
  constructor(pluginId) {
    this.file = path.join(DATA_DIR, 'plugins', `${pluginId}.json`);
    this.data = null;
    this.dirty = false;
    this.timer = null;
  }

  async #load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    return this.data;
  }

  async get(key, fallback = undefined) {
    const d = await this.#load();
    return key in d ? d[key] : fallback;
  }

  async set(key, value) {
    const d = await this.#load();
    d[key] = value;
    this.#scheduleSave();
  }

  async delete(key) {
    const d = await this.#load();
    delete d[key];
    this.#scheduleSave();
  }

  async all() {
    return { ...(await this.#load()) };
  }

  #scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.dirty) return;
      this.dirty = false;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    }, 300);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

/**
 * 插件上下文：插件能用的全部能力都在这里，不暴露内部实现。
 */
export function createContext({ meta, registry, api, cfg, groups, roles, levels, isOwner }) {
  const id = meta.id;
  const logger = createLogger(`plugin:${id}`);
  const disposers = [];

  // 先占位，保证即使插件没注册任何命令，菜单里也有它的条目
  registry.ensureMenu(id, meta);

  const ctx = {
    id,
    name: meta.name ?? id,
    version: meta.version ?? '0.0.0',
    config: meta.config ?? {},
    api,
    logger,
    storage: new PluginStorage(id),
    prefix: cfg.commandPrefix || '/',

    /* ---------------- 权限等级 ---------------- */

    /** 内核保留等级（只读，插件不能改语义） */
    CORE_LEVELS: LEVEL,

    /** 本插件分到的号段起点，例如 10 / 20 / 30 */
    levelBase: levels?.base ?? 10,

    /** 本插件可用号段 { base, end } */
    levelRange: levels ? { base: levels.base, end: levels.end } : { base: 10, end: 19 },

    /**
     * 取本插件号段内的等级值。
     *   ctx.level(0) → 号段最高权限（数字最小）
     *   ctx.level(3) → 号段内第 4 档
     */
    level(offset = 0) {
      const base = levels?.base ?? 10;
      const end = levels?.end ?? 19;
      return Math.min(base + Math.max(0, offset), end);
    },

    /**
     * 一次性定义本插件的等级，并自动写进菜单，方便用户知道怎么授权。
     *   const L = ctx.defineLevels({ 管理员: 0, 成员: 2 });
     *   → { 管理员: 10, 成员: 12 }
     */
    defineLevels(map) {
      const out = {};
      for (const [name, offset] of Object.entries(map ?? {})) {
        out[name] = this.level(offset);
      }
      registry.addMenuSection(
        id,
        meta,
        '权限等级',
        Object.entries(out).map(([name, lv]) => ({ text: `${lv}`, desc: name })),
      );
      return out;
    },

    /**
     * 注册命令。命令名取第一个词，后面的是用法提示，仅用于帮助展示与必填校验。
     *   ctx.command('echo <内容...>', { desc: '回声' }, async (msg, { args }) => { ... })
     */
    command(name, meta2, handler) {
      if (typeof meta2 === 'function') {
        handler = meta2;
        meta2 = {};
      }
      registry.addCommand(id, String(name).trim().split(/\s+/)[0], {
        desc: meta2?.desc ?? '',
        usage: meta2?.usage ?? `${cfg.commandPrefix}${name}`,
        pattern: String(name).trim(),
        admin: Boolean(meta2?.admin),
        plugin: meta.name ?? id,
      }, handler);
    },

    /**
     * 追加菜单分组。命令会自动进「指令」组，这里用来补充非命令玩法，
     * 比如游戏里的「攻击」「背包」，或者关键词触发。
     *
     *   ctx.menu('玩法', [
     *     { text: '攻击', desc: '对当前目标发起攻击' },
     *     { text: '直接说「掷骰子」', desc: '不用加前缀也能触发' },
     *   ])
     */
    menu(title, items) {
      registry.addMenuSection(id, meta, title, items ?? []);
    },

    /** 监听原始事件（GROUP_AT_MESSAGE_CREATE 等），或 'message' 统一入口 */
    on(event, handler) {
      registry.addListener(id, event, handler);
    },

    /**
     * 定时任务。返回停止函数；插件卸载时会自动清理，不会残留。
     *   ctx.schedule('daily-reset', 60_000, () => { ... })
     */
    schedule(name, everyMs, fn) {
      if (typeof name === 'function') {
        fn = name;
        everyMs = 60_000;
        name = 'task';
      }
      const timer = setInterval(() => {
        Promise.resolve()
          .then(fn)
          .catch((e) => logger.error(`定时任务 ${name} 出错:`, e.message));
      }, Math.max(1000, everyMs));
      timer.unref?.();
      disposers.push(() => clearInterval(timer));
      return () => clearInterval(timer);
    },

    /** 注册卸载时要执行的回调（关连接、清定时器等） */
    onTeardown(fn) {
      if (typeof fn === 'function') disposers.push(fn);
    },

    /** 当前消息的发送者是否为机器人主人（全局） */
    isOwner(userId) {
      return isOwner(userId);
    },

    /**
     * 当前消息发送者的权限等级（数字，越小越高）。
     *
     * 取三者的最优（数字最小）：
     *   全局 global、当前会话（group:/channel:）、本插件 feature:<id>
     * 这样「群主」和「只被授予本插件权限的人」都能通过本插件的检查，
     * 而无关的人拿到的还是 NO_PERM。
     */
    async levelOf(msg, scope) {
      if (!roles) return isOwner(msg?.userId) ? LEVEL.owner : NO_PERM;
      if (scope) return roles.effective(scope, msg?.userId, { owners: cfg.owners });
      const chat = await roles.effective(scopeOf(msg), msg?.userId, { owners: cfg.owners });
      const feature = await roles.effective(`feature:${id}`, msg?.userId, { owners: cfg.owners });
      return Math.min(chat, feature);
    },

    /**
     * 当前消息发送者是否达到某等级，默认要求管理员（数字越小越高）。
     *   ctx.can(msg)                 → 需要 1 级管理员
     *   ctx.can(msg, 'manager')      → 需要 2 级协管
     *   ctx.can(msg, L.管理员)        → 需要本插件的某个等级
     */
    async can(msg, need = 'admin') {
      const want = typeof need === 'number' ? need : LEVEL[need] ?? LEVEL.admin;
      return (await this.levelOf(msg)) <= want;
    },

    /** 当前作用域（group:xxx / channel:xxx / user:xxx / global） */
    scopeOf(msg) {
      return scopeOf(msg);
    },

    /** 等级数字转名字 */
    levelName,

    /** 某人是否是指定群的管理者（默认是邀请机器人入群的人） */
    async isGroupAdmin(groupOpenid, userId) {
      return groups ? groups.isAdmin(groupOpenid, userId) : false;
    },

    /** 读取群档案（邀请者、管理者、是否启用等） */
    async getGroup(groupOpenid) {
      return groups ? groups.get(groupOpenid) : null;
    },

    /** 内部：卸载时统一清理 */
    dispose() {
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch (e) {
          logger.warn('清理资源出错:', e.message);
        }
      }
      this.storage.flush().catch(() => {});
    },
  };

  return ctx;
}
