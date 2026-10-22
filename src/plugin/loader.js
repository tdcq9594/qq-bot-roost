import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger, attachLogFile, detachLogFile } from '../logger.js';
import { createContext } from './context.js';
import { SubprocessPlugin } from './subprocess.js';
import { rel } from '../paths.js';
import { allocateLevels } from '../levels.js';
import { PluginConfig } from './config.js';
import { ensurePluginDeps } from './deps.js';

const log = createLogger('plugins');

/**
 * 插件管理器
 *
 * 两种插件并存：
 *   1. 内建插件 —— 目录下有 index.js，用 ESM 直接 import 到主进程（最快）
 *   2. 外部插件 —— 目录下有 plugin.json，启动为独立子进程，可用任意语言
 *
 * 外部插件通过 stdin/stdout 的 NDJSON 通信，协议见 src/plugin/protocol.js。
 * 启用状态存在 data/plugins.json，删掉文件夹即等于卸载。
 */
export class PluginManager {
  constructor({ pluginsDir, paths, registry, api, cfg, groups, roles, outbound, session, pipeline, isOwner }) {
    this.dir = pluginsDir;
    // 该机器人的全套路径（配置/数据/日志），多机器人下互不干扰
    this.paths = paths;
    this.registry = registry;
    this.api = api;
    this.cfg = cfg;
    this.groups = groups;
    this.roles = roles;
    this.outbound = outbound;
    this.session = session;
    this.pipeline = pipeline;
    this.isOwner = isOwner;
    this.loaded = new Map(); // id -> { meta, ctx?, host?, dir, kind, menuMissing }
    this.state = {}; // id -> enabled
    this.errors = new Map(); // id -> 错误信息
    this.allocations = new Map(); // id -> { base, end, index }
  }

  async #readState() {
    try {
      this.state = JSON.parse(await fs.readFile(this.paths.pluginState, 'utf8'));
    } catch {
      this.state = {};
    }
  }

  async #writeState() {
    await fs.mkdir(path.dirname(this.paths.pluginState), { recursive: true });
    await fs.writeFile(this.paths.pluginState, JSON.stringify(this.state, null, 2), 'utf8');
  }

  /* ---------------- 扫描与加载 ---------------- */

  /**
   * 扫描并加载插件。
   * @param {object} [opts]
   * @param {(id:string)=>boolean} [opts.filter] 插件过滤：返回 false 的不加载。
   *        每个机器人可以用不同的 filter，实现「不同机器人启用不同插件」。
   *        只影响启动扫描，手动 /reload 单个插件不受它限制。
   */
  async scan({ filter = () => true } = {}) {
    await this.#readState();
    this.filter = filter;
    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      log.warn(`插件目录不存在: ${this.dir}`);
      return;
    }

    const allIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // 号段分配必须基于**全部**插件，否则不同机器人看到的等级号段会不一致
    this.allocations = allocateLevels(allIds);

    const ids = allIds.filter((id) => filter(id));
    const skipped = allIds.filter((id) => !filter(id));
    if (skipped.length) log.info(`本机器人未启用: ${skipped.join('、')}`);

    if (allIds.length) {
      log.info(
        '等级号段分配 ' +
          [...this.allocations.entries()].map(([id, a]) => `${id}:${a.base}-${a.end}`).join('  '),
      );
    }

    for (const id of ids) {
      if (this.state[id] === false) {
        log.info(`跳过已禁用插件: ${id}`);
        continue;
      }
      await this.load(id);
    }
    log.info(`插件加载完成，共 ${this.loaded.size} 个`);
  }

  /**
   * 重新扫描插件目录：加载新放进来的，卸载已经被删掉的。
   * 面板的「刷新」按钮用它，不用重启进程。
   * @returns {Promise<{added:string[], removed:string[]}>}
   */
  async rescan({ filter = null } = {}) {
    await this.#readState();
    if (filter) this.filter = filter;
    const use = this.filter ?? (() => true);

    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      return { added: [], removed: [] };
    }

    const allIds = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    // 号段要按全量重算，否则新插件拿不到号段
    this.allocations = allocateLevels(allIds);

    const added = [];
    const removed = [];

    for (const id of allIds) {
      if (this.loaded.has(id)) continue;
      if (!use(id)) continue;
      if (this.state[id] === false) continue;
      try {
        await this.load(id);
        added.push(id);
      } catch (e) {
        this.errors.set(id, e.message);
        log.error(`加载插件 ${id} 失败: ${e.message}`);
      }
    }

    for (const id of [...this.loaded.keys()]) {
      if (allIds.includes(id)) continue;
      try {
        await this.unload(id);
        removed.push(id);
      } catch {}
    }

    if (added.length) log.info(`新加载插件: ${added.join('、')}`);
    if (removed.length) log.info(`插件目录已消失，已卸载: ${removed.join('、')}`);
    return { added, removed };
  }

  async #detectKind(dir) {
    try {
      await fs.access(path.join(dir, 'plugin.json'));
      return 'external';
    } catch {}
    for (const f of ['index.js', 'index.mjs', 'main.js']) {
      try {
        await fs.access(path.join(dir, f));
        return 'internal';
      } catch {}
    }
    return null;
  }

  async load(id) {
    const dir = path.join(this.dir, id);

    if (!this.allocations.has(id)) {
      try {
        const dirs = await fs.readdir(this.dir, { withFileTypes: true });
        const next = allocateLevels(dirs.filter((e) => e.isDirectory()).map((e) => e.name));
        for (const [pid, alloc] of next) {
          const prev = this.allocations.get(pid);
          if (prev && prev.base !== alloc.base) {
            log.warn(
              `插件 ${pid} 的等级号段从 ${prev.base}-${prev.end} 变为 ${alloc.base}-${alloc.end}，` +
                `已配置的该插件权限可能需要重新设置。建议重启一次让号段稳定。`,
            );
          }
        }
        this.allocations = next;
      } catch {}
    }

    const kind = await this.#detectKind(dir);
    if (!kind) {
      log.warn(`插件 ${id} 既没有 plugin.json 也没有 index.js，跳过`);
      return false;
    }

    try {
      return kind === 'external'
        ? await this.#loadExternal(id, dir)
        : await this.#loadInternal(id, dir);
    } catch (e) {
      this.errors.set(id, e.message);
      log.error(`插件 ${id} 加载失败: ${e.message}`);
      return false;
    }
  }

  /* ---------------- 内建插件（ESM） ---------------- */

  async #loadInternal(id, dir) {
    let entryFile = null;
    for (const c of ['index.js', 'index.mjs', 'main.js']) {
      try {
        await fs.access(path.join(dir, c));
        entryFile = path.join(dir, c);
        break;
      } catch {}
    }

    // 加时间戳绕过 ESM 缓存，实现热重载
    const url = `${pathToFileURL(entryFile).href}?t=${Date.now()}`;
    const mod = await import(url);
    const meta = mod.default ?? mod.plugin;
    if (!meta || typeof meta.setup !== 'function') {
      throw new Error('默认导出必须是 { id, setup(ctx) } 形式的对象');
    }
    // 统一以目录名为插件 id：loaded / errors / allocations / registry 四处都按它索引，
    // 允许自报 id 会导致「加载成功但错误记录残留」这类问题。
    if (meta.id && meta.id !== id) {
      log.warn(`插件目录 ${id} 里声明的 id 是 ${meta.id}，与目录名不一致，以目录名为准`);
    }
    meta.id = id;

    // 每个插件一份自己的日志文件：logs/bots/<机器人>/plugins/<id>.log
    if (this.cfg.logs?.enabled !== false) {
      await attachLogFile(`plugin:${this.paths.id}/${meta.id}`, this.paths.pluginLog(meta.id), {
        maxBytes: this.cfg.logs?.maxBytes,
      });
    }

    // 每个插件一份自己的配置文件：config/bots/<机器人>/plugins/<id>.json
    const configStore = new PluginConfig({
      id: meta.id,
      defaults: meta.config ?? {},
      file: this.paths.pluginConfig(meta.id),
      log,
    });
    const config = await configStore.load();

    this.registry.clearPlugin(meta.id);
    const ctx = createContext({
      meta,
      paths: this.paths,
      registry: this.registry,
      api: this.api,
      cfg: this.cfg,
      config,
      configStore,
      groups: this.groups,
      roles: this.roles,
      levels: this.allocations.get(id) ?? null,
      outbound: this.outbound,
      session: this.session,
      pipeline: this.pipeline,
      isOwner: this.isOwner,
    });

    await meta.setup(ctx);

    const menuMissing = !this.registry.hasMenu(meta.id);
    if (menuMissing) {
      log.warn(
        `插件 ${meta.id} 没有提供任何指令菜单：既没注册命令，也没调用 ctx.menu()。` +
          `请在 setup 里补上，否则用户看不到它能做什么。`,
      );
    }

    this.loaded.set(meta.id, { meta, ctx, dir, kind: 'internal', menuMissing });
    this.errors.delete(meta.id);
    log.info(`已加载内建插件 ${meta.id} (${meta.name ?? ''})`);
    return true;
  }

  /* ---------------- 外部插件（子进程，任意语言） ---------------- */

  async #loadExternal(id, dir) {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    if (raw.id && raw.id !== id) {
      log.warn(`插件目录 ${id} 的 plugin.json 声明 id 为 ${raw.id}，与目录名不一致，以目录名为准`);
    }
    const meta = {
      id, // 以目录名为准，保证各处索引一致
      name: raw.name ?? id,
      version: raw.version ?? '0.0.0',
      description: raw.description ?? '',
    };

    // 每个插件一份自己的日志文件：logs/bots/<机器人>/plugins/<id>.log
    if (this.cfg.logs?.enabled !== false) {
      await attachLogFile(`plugin:${this.paths.id}/${id}`, this.paths.pluginLog(id), {
        maxBytes: this.cfg.logs?.maxBytes,
      });
    }

    // 开箱即用：缺依赖就装进插件目录里的隔离环境，装不上直接报清楚原因
    const deps = await ensurePluginDeps({
      dir,
      manifest: raw,
      log,
      enabled: this.cfg.plugins?.autoInstallDeps !== false,
    });
    for (const w of deps.warnings) log.warn(`插件 ${id}: ${w}`);
    if (deps.installed.length) log.info(`插件 ${id} 已自动安装：${deps.installed.join('、')}`);

    // 每个插件一份自己的配置文件：config/bots/<机器人>/plugins/<id>.json
    const configStore = new PluginConfig({
      id,
      defaults: raw.config ?? {},
      file: this.paths.pluginConfig(id),
      log,
    });
    const config = await configStore.load();

    this.registry.clearPlugin(meta.id);

    const host = new SubprocessPlugin({
      dir,
      manifest: { ...raw, id: meta.id, config },
      botId: this.paths.id,
      // 外部插件没有 storage 协议，给它一个专属目录自己存
      dataDir: this.paths.pluginDataDirFor(meta.id),
      // 有 venv 就用 venv 里的解释器，没有就用探测到的系统解释器
      pythonPath: deps.python ?? null,
      allocation: this.allocations.get(id) ?? null,
      cfg: this.cfg,
      roles: this.roles,
      isOwner: this.isOwner,
    });

    await host.start(); // 失败会抛错，由 load() 捕获

    const prefix = this.cfg.commandPrefix || '/';
    for (const c of host.commands) {
      const pattern = String(c.pattern ?? c.name ?? '').trim();
      const name = pattern.split(/\s+/)[0];
      if (!name) continue;
      this.registry.addCommand(
        meta.id,
        name,
        {
          desc: c.desc ?? '',
          usage: c.usage ?? `${prefix}${pattern}`,
          pattern,
          admin: Boolean(c.admin),
          globalAdmin: Boolean(c.globalAdmin),
          plugin: meta.name,
        },
        async (msg) => {
          await host.handle(msg);
        },
      );
    }

    // 非命令消息：插件声明了 listen 才转发，避免无谓的进程通信
    if (host.listen.includes('message')) {
      this.registry.addListener(meta.id, 'message', async (msg) => {
        await host.handle(msg);
      });
    }

    for (const sec of host.menus) {
      this.registry.addMenuSection(meta.id, meta, sec.title, sec.items ?? []);
    }
    if (host.levels.length) {
      this.registry.addMenuSection(
        meta.id,
        meta,
        '权限等级',
        host.levels.map((l) => ({ text: String(l.level), desc: l.name ?? '' })),
      );
    }

    const menuMissing = !this.registry.hasMenu(meta.id);
    if (menuMissing) {
      log.warn(`外部插件 ${meta.id} 的 ready 里没有 commands / menus，用户看不到它能做什么`);
    }

    this.loaded.set(meta.id, { meta, host, dir, kind: 'external', menuMissing });
    this.errors.delete(meta.id);
    log.info(
      `已加载外部插件 ${meta.id} (${meta.name}) · ${host.status.runtime} · pid ${host.status.pid} · ${host.commands.length} 条命令`,
    );
    return true;
  }

  /* ---------------- 卸载与重载 ---------------- */

  async unload(id) {
    const item = this.loaded.get(id);
    if (!item) return false;

    if (item.kind === 'external') {
      try {
        await item.host.stop();
      } catch (e) {
        log.warn(`插件 ${id} 停止进程出错: ${e.message}`);
      }
    } else {
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
    }

    this.registry.clearPlugin(id);
    // 插件注册的中间件也要一起摘掉，否则卸载后它还挡着别人的消息
    this.pipeline?.removeByPlugin?.(id);
    // 关掉它的日志文件句柄，免得句柄泄漏
    detachLogFile(`plugin:${this.paths.id}/${id}`);
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

  /** 退出前调用：停掉所有外部插件进程，否则子进程会挂住主进程 */
  async shutdown() {
    const entries = [...this.loaded.entries()];
    for (const [id, item] of entries) {
      if (item.kind !== 'external') continue;
      try {
        await item.host.stop();
        log.debug(`已停止外部插件 ${id}`);
      } catch (e) {
        log.warn(`停止外部插件 ${id} 失败: ${e.message}`);
      }
    }
  }

  list() {
    const ids = new Set([...this.loaded.keys(), ...Object.keys(this.state)]);
    return [...ids].map((id) => {
      const item = this.loaded.get(id);
      const ext = item?.kind === 'external' ? item.host.status : null;
      return {
        id,
        name: item?.meta?.name ?? id,
        version: item?.meta?.version ?? '',
        description: item?.meta?.description ?? '',
        enabled: this.isEnabled(id),
        loaded: Boolean(item),
        kind: item?.kind ?? 'internal',
        runtime: ext?.runtime ?? 'node',
        processState: ext?.state ?? null,
        pid: ext?.pid ?? null,
        menuMissing: Boolean(item?.menuMissing),
        error: this.errors.get(id) ?? ext?.error ?? '',
      };
    });
  }
}
