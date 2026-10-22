import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../logger.js';
import { createContext } from './context.js';
import { DATA_DIR } from '../config.js';

const log = createLogger('plugins');
const STATE_FILE = path.join(DATA_DIR, 'plugins.json');

/**
 * 插件管理器。
 *
 * 约定：一个插件 = plugins/ 下的一个文件夹，内含 index.js，默认导出：
 *   export default {
 *     id: 'echo', name: '回声', version: '1.0.0', description: '...',
 *     setup(ctx) { ... }   // 在这里注册命令/监听
 *   }
 *
 * 启用状态存在 data/plugins.json，删掉文件夹即等于卸载。
 */
export class PluginManager {
  constructor({ pluginsDir, registry, api, cfg, groups, isOwner }) {
    this.dir = pluginsDir;
    this.registry = registry;
    this.api = api;
    this.cfg = cfg;
    this.isOwner = isOwner;
    this.groups = groups;
    this.loaded = new Map(); // id -> { meta, ctx, dir }
    this.state = {}; // id -> enabled
    this.errors = new Map(); // id -> 错误信息
  }

  async #readState() {
    try {
      this.state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    } catch {
      this.state = {};
    }
  }

  async #writeState() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
  }

  /** 扫描目录，加载所有启用的插件 */
  async scan() {
    await this.#readState();
    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      log.warn(`插件目录不存在: ${this.dir}`);
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const id = ent.name;
      if (this.state[id] === false) {
        log.info(`跳过已禁用插件: ${id}`);
        continue;
      }
      await this.load(id);
    }
    log.info(`插件加载完成，共 ${this.loaded.size} 个`);
  }

  async load(id) {
    const dir = path.join(this.dir, id);
    const candidates = ['index.js', 'index.mjs', 'main.js'];
    let entryFile = null;
    for (const c of candidates) {
      try {
        await fs.access(path.join(dir, c));
        entryFile = path.join(dir, c);
        break;
      } catch {}
    }
    if (!entryFile) {
      log.warn(`插件 ${id} 缺少 index.js，跳过`);
      return false;
    }

    try {
      // 加时间戳绕过 ESM 缓存，实现热重载
      const url = `${pathToFileURL(entryFile).href}?t=${Date.now()}`;
      const mod = await import(url);
      const meta = mod.default ?? mod.plugin;
      if (!meta || typeof meta.setup !== 'function') {
        throw new Error('默认导出必须是 { id, setup(ctx) } 形式的对象');
      }
      meta.id = meta.id ?? id;

      this.registry.clearPlugin(meta.id);
      const ctx = createContext({
        meta,
        registry: this.registry,
        api: this.api,
        cfg: this.cfg,
        groups: this.groups,
        isOwner: this.isOwner,
      });

      await meta.setup(ctx);

      // 规范要求：每个插件都要能给出自己的指令列表
      const menuMissing = !this.registry.hasMenu(meta.id);
      if (menuMissing) {
        log.warn(
          `插件 ${meta.id} 没有提供任何指令菜单：既没注册命令，也没调用 ctx.menu()。` +
            `请在 setup 里补上，否则用户看不到它能做什么。`,
        );
      }

      this.loaded.set(meta.id, { meta, ctx, dir, menuMissing });
      this.errors.delete(meta.id);
      log.info(`已加载插件 ${meta.id} (${meta.name ?? ''})`);
      return true;
    } catch (e) {
      this.errors.set(id, e.message);
      log.error(`插件 ${id} 加载失败: ${e.message}`);
      return false;
    }
  }

  async unload(id) {
    const item = this.loaded.get(id);
    if (!item) return false;
    try {
      await item.meta.teardown?.(item.ctx);
    } catch (e) {
      log.warn(`插件 ${id} teardown 出错: ${e.message}`);
    }
    try {
      item.ctx.dispose?.();
    } catch (e) {
      log.warn(`插件 ${id} 资源清理出错: ${e.message}`);
    }
    this.registry.clearPlugin(id);
    this.loaded.delete(id);
    log.info(`已卸载插件 ${id}`);
    return true;
  }

  async reload(id) {
    await this.unload(id);
    return this.load(id);
  }

  async setEnabled(id, enabled) {
    this.state[id] = enabled;
    await this.#writeState();
    if (enabled) return this.load(id);
    return this.unload(id);
  }

  isEnabled(id) {
    return this.state[id] !== false;
  }

  list() {
    const ids = new Set([...this.loaded.keys(), ...Object.keys(this.state)]);
    return [...ids].map((id) => {
      const item = this.loaded.get(id);
      return {
        id,
        name: item?.meta?.name ?? id,
        version: item?.meta?.version ?? '',
        description: item?.meta?.description ?? '',
        enabled: this.isEnabled(id),
        loaded: Boolean(item),
        menuMissing: Boolean(item?.menuMissing),
        error: this.errors.get(id) ?? '',
      };
    });
  }
}
