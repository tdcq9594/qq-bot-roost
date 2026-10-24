import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger, attachLogFile, detachLogFile } from '../logger.js';
import { createContext } from './context.js';
import { SubprocessPlugin } from './subprocess.js';
import { rel } from '../paths.js';
import { allocateLevels } from '../levels.js';
import { PluginConfig, schemaOf } from './config.js';
import { normalizeDashboard } from './dashboard.js';
import { readPluginVersion } from './market.js';
import { ensurePluginDeps } from './deps.js';
import { satisfies, frameworkVersion } from '../semver.js';
import { PageRegistry } from './pages.js';

const log = createLogger('plugins');

/**
 * 插件管理器
 *
 * 两种插件并存：
 *   1. 内建插件 —— 目录下有 index.js，用 ESM 直接 import 到主进程（最快）
 *   2. 外部插件 —— 目录下有 plugin.json，启动为独立子进程，可用任意语言
 *
 * 外部插件通过 stdin/stdout 的 NDJSON 通信，协议见 src/plugin/protocol.js。
 * 启用状态存在 data/bots/<机器人id>/plugins.json，删掉文件夹即等于卸载。
 */
export class PluginManager {
  constructor({ pluginsDir, paths, registry, api, cfg, goBin, groups, roles, outbound, session, pipeline, isOwner, ignoreCompat }) {
    this.dir = pluginsDir;
    // 该机器人的全套路径（配置/数据/日志），多机器人下互不干扰
    this.paths = paths;
    // 全局配置里的 go 可执行文件路径（机器人配置里没有这一项）
    this.goBin = goBin;
    this.registry = registry;
    this.api = api;
    this.cfg = cfg;
    this.groups = groups;
    this.roles = roles;
    this.outbound = outbound;
    this.session = session;
    this.pipeline = pipeline;
    this.isOwner = isOwner;
    /** 跳过插件声明的 frameworkVersion 校验（作者本地调试用） */
    this.ignoreCompat = Boolean(ignoreCompat);
    this.loaded = new Map(); // id -> { meta, ctx?, host?, dir, kind, menuMissing }
    /** 插件注册的面板页面（每机器人一份，互不干扰） */
    this.pages = new PageRegistry();
    /** 磁盘上实际存在的插件目录，含未启用的 */
    this.diskIds = new Set();
    this.state = {}; // id -> enabled
    this.errors = new Map(); // id -> 一句话错误（面板卡片上用）
    /**
     * id -> 完整堆栈。
     *
     * 只给 message 的话，「Cannot read properties of undefined」这种错误
     * 完全看不出是哪一行，插件作者只能靠猜。面板上展开就能看到调用栈。
     */
    this.errorStacks = new Map();
    /**
     * id -> 插件自己的内存状态对象。
     *
     * 热重载会重建模块，模块顶层变量全丢——插件作者第一反应是「框架有 bug」。
     * ctx.state 由框架持有，重载时原样递回去，写小缓存、计数器就不用落盘了。
     * 卸载时清掉（那是真的不要了）。
     */
    this.stateStore = new Map();
    this.allocations = new Map(); // id -> { base, end, index }
    /**
     * 插件元信息缓存：id -> { name, version, description, kind, runtime }
     * 插件被禁用 / 卸载后 loaded 里就没有了，但面板还要显示它的名字和版本，
     * 所以这里单独留一份，不随 unload 清除。
     */
    this.meta = new Map();
    // 面板「运行数据」的短缓存：id -> { at, data }
    // 面板会轮询，插件函数不能每次都真跑一遍
    this.dashCache = new Map();
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
    // 记下磁盘上到底有哪些，list() 要据此显示「装了但未启用」的插件
    this.diskIds = new Set(allIds);
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
        // 禁用中：不加载，但要读一下元信息，否则面板会显示成「版本 0 / 内建」
        await this.#peekMeta(id);
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
    this.diskIds = new Set(allIds);
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
        this.errorStacks.set(id, e.stack || e.message);
        log.error(`加载插件 ${id} 失败: ${e.stack || e.message}`);
      }
    }

    for (const id of [...this.loaded.keys()]) {
      if (allIds.includes(id)) continue;
      try {
        await this.unload(id);
        // 目录没了就把它留下的元信息、错误记录、开关状态一起清掉。
        // 不清的话 list() 会继续把这个不存在的插件列出来（meta 里还有它），
        // 面板上就出现一个「已禁用、v0.0.0」的幽灵条目。
        await this.forget(id);
        removed.push(id);
      } catch {}
    }

    if (added.length) log.info(`新加载插件: ${added.join('、')}`);
    if (removed.length) log.info(`插件目录已消失，已卸载: ${removed.join('、')}`);

    /**
     * 把加载失败的也带出去。
     *
     * 原来只返回 added/removed，前端看到空 added 只能提示「没有发现新插件」——
     * 但真实情况可能是「发现了，加载失败」。两种完全不同的事，
     * 却给用户同一句话，只能靠翻日志才知道怎么回事。
     */
    const errors = [];
    for (const [id, msg] of this.errors) {
      if (allIds.includes(id)) errors.push({ id, error: msg });
    }

    return { added, removed, errors };
  }

  /**
   * 校验插件声明的框架版本要求。
   *
   * 为什么要在**加载前**拦：插件用到了新版本才有的 ctx 方法，
   * 装到旧框架上会在运行到那一行时才炸，报错还指向插件内部，
   * 作者和用户都看不出真正原因是「框架太旧」。
   *
   * 两种写法都认：plugin.json 里的 frameworkVersion，
   * 或内建插件默认导出里的 frameworkVersion。
   */
  #assertCompatible(id, meta) {
    const need = meta?.frameworkVersion ?? meta?.requires?.framework;
    if (!need || this.ignoreCompat) return;
    const cur = frameworkVersion();
    if (satisfies(cur, need)) return;
    throw new Error(
      `要求框架 ${need}，当前是 ${cur}。升级框架后再启用，` +
        '或者把插件里的 frameworkVersion 改成兼容的范围',
    );
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
      this.errorStacks.set(id, e.stack || e.message);
      log.error(`插件 ${id} 加载失败: ${e.stack || e.message}`);
      /**
       * 失败时把已经建起来的东西收干净。
       *
       * 外部插件的子进程如果已经起来了但注册阶段失败，它不在 loaded 里，
       * shutdown() 遍历不到它，它却还活着；内建插件可能已经注册了半套命令，
       * 指向一个马上要被丢掉的 ctx。不清理就是「幽灵进程 + 半生效命令」。
       */
      try {
        const partial = this.loaded.get(id);
        if (partial?.host) await partial.host.stop().catch(() => {});
        if (partial) {
          this.loaded.delete(id);
          this.registry.clearPlugin(id);
          this.pipeline?.removeByPlugin?.(id);
          this.pages?.clearPlugin(id);
        } else {
          // 还没进 loaded：至少把注册表里可能残留的入口摘掉
          this.registry.clearPlugin(id);
        }
      } catch (cleanupErr) {
        log.warn(`清理未加载成功的插件 ${id} 时出错：${cleanupErr.message}`);
      }
      return false;
    }
  }

  /** 取（或新建）插件的内存状态对象。热重载时同一个对象会被递回去 */
  #stateOf(id) {
    let s = this.stateStore.get(id);
    if (!s) {
      s = {};
      this.stateStore.set(id, s);
    }
    return s;
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

    /**
     * 内建插件也可能有自己的 npm 依赖（比如渲染插件要 @napi-rs/canvas）。
     * 以前只有外部插件会装依赖，内建插件只能让用户手动 `npm i --prefix`，
     * 踩坑的人不少。这里复用同一套安装逻辑：有 package.json 就装到插件目录，
     * 没有就什么都不做（绝大多数内建插件是零依赖的）。
     */
    if (await fs.access(path.join(dir, 'package.json')).then(() => true).catch(() => false)) {
      await ensurePluginDeps({
        dir,
        manifest: {},
        log,
        enabled: this.cfg?.plugins?.autoInstallDeps !== false,
      });
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
    // 版本兼容在 setup 之前拦——跑起来才发现「ctx.xxx 不是函数」就太晚了
    this.#assertCompatible(id, meta);

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
      // 同一个对象跨重载复用，见 stateStore 的注释
      state: this.#stateOf(id),
      outbound: this.outbound,
      session: this.session,
      pipeline: this.pipeline,
      isOwner: this.isOwner,
      pages: this.pages,
    });

    await meta.setup(ctx);

    const menuMissing = !this.registry.hasMenu(meta.id);
    if (menuMissing) {
      log.warn(
        `插件 ${meta.id} 没有提供任何指令菜单：既没注册命令，也没调用 ctx.menu()。` +
          `请在 setup 里补上，否则用户看不到它能做什么。`,
      );
    }

    this.loaded.set(meta.id, { meta, ctx, dir, kind: 'internal', menuMissing, configStore });
    this.#cacheMeta(meta.id, meta, 'internal', 'node');
    // 加载成功就把上次的报错和堆栈一起清掉，否则修好之后面板还挂着旧红字
    this.errors.delete(meta.id);
    this.errorStacks.delete(meta.id);
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
      // 面板和市场卡片用的补充信息，全部可选
      shortDesc: raw.shortDesc ?? '',
      icon: raw.icon ?? '',
      repo: raw.repo ?? '',
      supportPlatforms: Array.isArray(raw.supportPlatforms) ? raw.supportPlatforms : [],
      frameworkVersion: raw.frameworkVersion ?? raw.requires?.framework ?? '',
    };

    this.#assertCompatible(id, meta);

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
      goPath: this.goBin,
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

    this.loaded.set(meta.id, { meta, host, dir, kind: 'external', menuMissing, configStore });
    this.#cacheMeta(meta.id, meta, 'external', raw.runtime || 'python');
    this.errors.delete(meta.id);
    this.errorStacks.delete(meta.id);
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
    // 面板页面同样要清，否则标签还在但点开是空白
    this.pages?.clearPlugin(id);
    // 关掉它的日志文件句柄，免得句柄泄漏
    detachLogFile(`plugin:${this.paths.id}/${id}`);
    this.loaded.delete(id);
    this.dashCache.delete(id);
    log.info(`已卸载插件 ${id}`);
    return true;
  }

  async reload(id) {
    await this.unload(id);
    return this.load(id);
  }

  /**
   * 忘掉一个插件留下的所有痕迹。
   *
   * 卸载时用。只删目录不够——state 里还留着它的开关记录（可能是 false），
   * 重装之后会被这条旧记录挡住不加载，用户会以为装坏了。
   */
  async forget(id) {
    let dirty = false;
    if (this.state && id in this.state) {
      delete this.state[id];
      dirty = true;
    }
    this.errors.delete(id);
    this.errorStacks.delete(id);
    this.stateStore.delete(id);
    this.meta.delete(id);
    this.diskIds.delete(id);
    if (dirty) await this.#writeState().catch(() => {});
  }

  async setEnabled(id, enabled) {
    this.state[id] = enabled;
    await this.#writeState();
    if (enabled) return this.load(id);
    return this.unload(id);
  }

  /**
   * 「启用」是**两层**共同决定的：
   *   1. 机器人配置的过滤器（include / exclude / all）—— 决定这个机器人要不要这个插件
   *   2. 面板上的开关（state）—— 决定装了的插件要不要跑
   *
   * 只看第 2 层会骗人：配置里被 include 名单排除的插件，
   * 面板会显示「已启用」，实际根本没加载，用户点来点去都莫名其妙。
   */
  isEnabled(id) {
    if (this.filter && !this.filter(id)) return false;
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

  /** 记下元信息，供禁用后仍能在面板正确显示 */
  #cacheMeta(id, meta, kind, runtime) {
    this.meta.set(id, {
      name: meta?.name || id,
      version: meta?.version || '',
      description: meta?.description || '',
      // 下面这几项都是可选的，插件不写就是空
      shortDesc: meta?.shortDesc || '',
      icon: meta?.icon || '',
      repo: meta?.repo || '',
      supportPlatforms: Array.isArray(meta?.supportPlatforms) ? meta.supportPlatforms : [],
      frameworkVersion: meta?.frameworkVersion || meta?.requires?.framework || '',
      kind,
      runtime,
    });
  }

  /**
   * 只在需要显示时读一下元信息，不真正加载插件。
   * 用于「禁用中」的插件——它们没进 loaded，但面板要显示名字、版本和类型。
   */
  async #peekMeta(id) {
    if (this.meta.has(id)) return;
    const dir = path.join(this.dir, id);

    // 外部插件：plugin.json 就是元信息
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
      this.#cacheMeta(id, raw, 'external', raw.runtime || 'python');
      return;
    } catch {
      /* 不是外部插件，继续看内建 */
    }

    /**
     * 内建插件：**不 import**。
     *
     * 以前为了读 name/version 会 import 一次模块——但 ESM 的顶层代码
     * 是立刻执行的：定时器、网络请求、写文件全都会跑起来。
     * 用户点「禁用」本来是想止损，结果插件照样在后台活动。
     * 拿不到版本号就显示空，比偷偷执行代码强。
     */
    for (const f of ['index.js', 'index.mjs', 'main.js']) {
      const p = path.join(dir, f);
      const exists = await fs.access(p).then(() => true, () => false);
      if (!exists) continue;
      this.#cacheMeta(id, { id, name: id, version: '' }, 'internal', 'node');
      return;
    }
  }

  /* ---------------- 面板：配置与数据 ---------------- */

  /**
   * 面板「插件设置」要的全部东西：配置 schema、当前值、插件存档。
   * @param {string} id
   */
  async panelOf(id) {
    const item = this.loaded.get(id);
    if (!item) return null;

    const store = item.configStore;
    const config = store ? await store.load() : {};
    const schema = store ? schemaOf(store.rawDefaults ?? {}) : {};
    const storage = item.ctx?.storage ?? null;
    const data = storage ? await storage.all() : {};

    return {
      id,
      name: item.meta?.name ?? id,
      kind: item.kind,
      config,
      schema,
      /**
       * 「快速填入」的预设，插件在 meta 上声明：
       *   configPresets: [{ name:'DeepSeek', values:{ baseUrl:'…', model:'…' } }]
       *
       * 放在 meta 而不是 config 里，是因为它跨字段（一次填好几个），
       * 也不该被存进用户配置——用户选了哪个由填进去的值本身体现。
       */
      presets: Array.isArray(item.meta?.configPresets) ? item.meta.configPresets : [],
      data,
      // 存档键里哪些像玩家数据，给面板分组用
      dataKeys: Object.keys(data),
      // 插件自定义的运行指标（可能为 null）
      dashboard: await this.dashboardOf(id),
    };
  }

  /**
   * 面板「运行数据」：插件想在面板上显示什么就显示什么。
   *
   * 三种来源，按优先级：
   *   1. 插件导出里声明 dashboard（对象或函数，函数每次现算）
   *   2. 插件运行中用 ctx.setDashboard() 推的最后一份
   *   3. 外部插件发 {"t":"dashboard"} 协议消息推的
   *
   * 1 秒内重复拉取直接返回上次结果——面板在轮询，不能让插件函数被打爆。
   */
  async dashboardOf(id) {
    const item = this.loaded.get(id);
    if (!item) return null;

    const hit = this.dashCache.get(id);
    if (hit && Date.now() - hit.at < 1000) return hit.data;

    let raw = null;
    try {
      const d = item.meta?.dashboard;
      raw = typeof d === 'function' ? await d(item.ctx) : d ?? null;
    } catch (e) {
      log.warn(`插件 ${id} 的 dashboard() 出错: ${e.message}`);
    }

    // 回退要看「洗完之后有没有内容」，不能看 raw 是否 truthy：
    // 插件写了 dashboard: {} 或 dashboard() 返回 null 时，raw 仍是真值，
    // 但 normalize 出来是 null，此时该继续用 ctx.setDashboard 推的那份。
    let data = normalizeDashboard(raw);
    if (!data) {
      data = normalizeDashboard(item.ctx?.getDashboard?.() ?? item.host?.dashboard ?? null);
    }

    this.dashCache.set(id, { at: Date.now(), data });
    return data;
  }

  /** 一次拿全部已加载插件的运行数据，面板一次请求就够 */
  async dashboards() {
    const out = {};
    for (const id of this.loaded.keys()) {
      const d = await this.dashboardOf(id);
      if (d) out[id] = d;
    }
    return out;
  }

  /**
   * 本地已装插件的版本号 { id: version }，给插件市场比对新版用。
   *
   * **以磁盘为准**，不是内存里的 meta：用户可能手动换过 plugins/ 下的文件
   * （覆盖安装、从别处拷贝），这时内存里的 version 是旧的，按它判断会漏报。
   * 只有磁盘读不到（文件损坏、语法错误）才回退到内存 meta。
   */
  async localVersions() {
    const out = {};
    let dirs = [];
    try {
      dirs = await fs.readdir(this.dir);
    } catch {
      dirs = [];
    }

    for (const name of dirs) {
      const dir = path.join(this.dir, name);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const v = await readPluginVersion(dir);
      if (v) out[name] = v;
    }

    // 磁盘读不到的，用内存里的 meta 兜底
    for (const [id, item] of this.loaded) {
      if (!out[id] && item.meta?.version) out[id] = String(item.meta.version);
    }
    return out;
  }

  /** 改插件配置（面板用）。改完插件立刻能读到新值 */
  async setConfig(id, patch) {
    const item = this.loaded.get(id);
    if (!item?.configStore) throw new Error('插件没加载，改不了配置');
    const next = await item.configStore.set(patch);
    // ctx.config 和 configStore.data 是同一个对象时不用动，保险起见重新指一次
    if (item.ctx && next) item.ctx.config = next;
    return next ?? (await item.configStore.load());
  }

  /**
   * 恢复插件的出厂配置。
   *
   * 删文件重新生成，连插件升级后遗留的旧键一起清掉。
   * 面板调用前必须让用户确认——API Key 这类值会被一起清空。
   */
  async resetConfig(id) {
    const item = this.loaded.get(id);
    if (!item?.configStore) throw new Error('插件没加载，改不了配置');
    const next = await item.configStore.reset();
    // 插件读的是 ctx.config，不重新指的话它还在用旧值，得重启才生效
    if (item.ctx) item.ctx.config = next;
    log.info(`插件 ${id} 的配置已恢复默认`);
    return next;
  }

  /** 改一条插件存档（面板用） */
  async setData(id, key, value) {
    const st = this.loaded.get(id)?.ctx?.storage;
    if (!st) throw new Error('插件没加载，改不了数据');
    if (!key) throw new Error('缺少数据键');
    await st.set(key, value);
    await st.flush();
    return { key, value };
  }

  /** 删一条插件存档（面板用） */
  async deleteData(id, key) {
    const st = this.loaded.get(id)?.ctx?.storage;
    if (!st) throw new Error('插件没加载，改不了数据');
    if (!key) throw new Error('缺少数据键');
    await st.delete(key);
    await st.flush();
    return { key };
  }

  list() {
    // 只列「已加载」和「磁盘上确实存在」的。
    // 不能把 state 里的历史键也算进来——插件删了之后状态文件里还留着它的开关记录，
    // 否则面板会一直显示一个装不存在的插件，还标成「内建 · v0.0.0」。
    //
    // diskIds 是「装了但没启用」的那批（include 模式下常见），
    // 也要列出来——否则用户在面板里根本看不到它，也就没法启用。
    const ids = new Set([...this.loaded.keys(), ...this.meta.keys(), ...this.diskIds]);
    return [...ids].map((id) => {
      const item = this.loaded.get(id);
      const cached = this.meta.get(id) ?? null;
      const ext = item?.kind === 'external' ? item.host.status : null;
      return {
        id,
        name: item?.meta?.name ?? cached?.name ?? id,
        version: item?.meta?.version ?? cached?.version ?? '',
        description: item?.meta?.description ?? cached?.description ?? '',
        // 卡片上的一行简介优先用 shortDesc，没写就退回 description
        shortDesc: item?.meta?.shortDesc ?? cached?.shortDesc ?? '',
        icon: item?.meta?.icon ?? cached?.icon ?? '',
        repo: item?.meta?.repo ?? cached?.repo ?? '',
        supportPlatforms: item?.meta?.supportPlatforms ?? cached?.supportPlatforms ?? [],
        frameworkVersion: item?.meta?.frameworkVersion ?? cached?.frameworkVersion ?? '',
        enabled: this.isEnabled(id),
        loaded: Boolean(item),
        // 未加载时用缓存里的类型，别一律当成 internal
        kind: item?.kind ?? cached?.kind ?? 'internal',
        runtime: ext?.runtime ?? cached?.runtime ?? 'node',
        processState: ext?.state ?? null,
        pid: ext?.pid ?? null,
        menuMissing: Boolean(item?.menuMissing),
        error: this.errors.get(id) ?? ext?.error ?? '',
        errorStack: this.errorStacks.get(id) ?? '',
      };
    });
  }
}
