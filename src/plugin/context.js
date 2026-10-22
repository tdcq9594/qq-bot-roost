import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { DATA_DIR } from '../config.js';

/**
 * 全局注册表：所有插件注册的命令和事件监听都放这里。
 * 重载插件时按 pluginId 精确清除，互不影响。
 */
export class Registry {
  constructor() {
    this.commands = new Map(); // name -> { pluginId, desc, usage, admin, handler }
    this.listeners = new Map(); // eventName -> [{ pluginId, handler }]
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
  }

  addCommand(pluginId, name, meta, handler) {
    const key = name.toLowerCase();
    if (this.commands.has(key)) {
      const owner = this.commands.get(key).pluginId;
      throw new Error(`命令 "${name}" 已被插件 ${owner} 注册`);
    }
    this.commands.set(key, { pluginId, name: key, ...meta, handler });
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
export function createContext({ meta, registry, api, cfg, groups, isOwner }) {
  const id = meta.id;
  const logger = createLogger(`plugin:${id}`);
  const disposers = [];

  const ctx = {
    id,
    name: meta.name ?? id,
    version: meta.version ?? '0.0.0',
    config: meta.config ?? {},
    api,
    logger,
    storage: new PluginStorage(id),
    prefix: cfg.commandPrefix || '/',

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
