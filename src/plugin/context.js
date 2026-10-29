import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { scopeOf, LEVEL, NO_PERM, levelName } from '../roles.js';
import { md, renderMenuMd } from '../markdown.js';
import { normalizeDashboard } from './dashboard.js';
import { createToolCaller } from './tools.js';


/**
 * 给插件的账本视图：**只有读方法**。
 *
 * 为什么包一层而不是直接给 `ledger` 实例：`append()` 一暴露，插件就能往账本里
 * 塞一条「用户没说过的话」，而账本的价值恰恰在于「它是原始事实」。
 * 包一层之后插件想存自己的东西只能走 `ctx.storage`，边界清楚。
 *
 * 用 `Object.freeze` 而不是私有字段：这层是防误用，不是防恶意代码
 * （插件本来就在同进程里跑，真想绕过谁也拦不住）。所以选最轻的方式。
 */
function readOnlyLedger(ledger) {
  return Object.freeze({
    /** 某会话最近 N 条（正序）。`beforeSeq` 用于翻页 */
    recent: (opts) => ledger.recent(opts),
    /** 以某条为锚点取前后邻文，`unknown` 时间的锚点返回空 */
    timeline: (opts) => ledger.timeline(opts),
    /** 按事件 id 取一条完整记录（含原始 payload 之外的字段） */
    get: (id) => ledger.get(id),
    /** 总量、时间范围、未解析引用数、保留天数 */
    stats: () => ledger.stats(),
  });
}

/**
 * 给插件的闸视图：只能动**会话级**，动不了全局和这只鸟。
 *
 * 为什么这样切：`setGlobal` 是「把整个进程停掉」，`setBot` 是「把这只鸟停掉」，
 * 两个都是运维动作，出了事要从面板确认（那儿有原因、有「谁改的」）。
 * 插件能停的只有自己正在处理的这个会话——那本来就是它职责范围内的事。
 *
 * `by` 记成 `plugin:<id>`，面板上一眼能看出是哪个插件停的。
 */
function readOnlyGate(gate, pluginId) {
  const by = `plugin:${pluginId}`;
  return Object.freeze({
    /** 能不能对某个会话说话（含原因） */
    check: (chatId) => gate.check(chatId),
    /** 这只鸟的闸状态（同步，不读盘） */
    peek: () => gate.peek(),
    /** 静默一段时间（毫秒）；`<= 0` 表示解除 */
    silence: (chatId, ms) => gate.setSilence(chatId, ms, { by }),
    /** 暂停 / 恢复一个会话 */
    pauseChat: (chatId, paused) => gate.setChat(chatId, paused, { by }),
  });
}

/**
 * 全局注册表：所有插件注册的命令、事件监听、AI 工具都放这里。
 * 重载插件时按 pluginId 精确清除，互不影响。
 */
export class Registry {
  constructor() {
    this.commands = new Map(); // name -> { pluginId, desc, usage, admin, handler }
    this.listeners = new Map(); // eventName -> [{ pluginId, handler }]
    // pluginId -> { id, title, desc, sections: [{ title, items: [{ text, desc, isCommand }] }] }
    this.menus = new Map();
    /**
     * AI 可调用工具：name -> entry。
     *
     * 为什么按工具名而不是按插件索引：模型只认工具名，调用时也只给名字，
     * 按名直查是 O(1)；重名必须当场报错，否则模型会调到一个「不知道谁的」
     * 同名工具，出问题极难排查。
     */
    this.tools = new Map();
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
    for (const [name, entry] of this.tools) {
      if (entry.pluginId === id) this.tools.delete(name);
    }
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

    /**
     * 命令自动进菜单。分组默认是「指令」，可以用 `meta.section` 指定。
     *
     * 内核的十几个命令全靠这个分到「基础 / 管理 / 其它」三组——
     * 不然 `/help` 主菜单会把它们全部平铺出来，二十多行，
     * 在手机上要滑两屏才看得完。
     */
    this.addMenuSection(
      pluginId,
      { name: meta.plugin },
      meta.section ?? '指令',
      [{ cmd: meta.pattern ?? key, desc: meta.desc ?? '', admin: meta.admin, globalAdmin: meta.globalAdmin }],
    );
  }

  addListener(pluginId, event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push({ pluginId, handler });
  }

  /**
   * 注册一个 AI 可调用的工具。
   *
   * @param {string} pluginId
   * @param {object} meta { name, description, parameters, ownerOnly, admin, timeoutMs, hidden }
   * @param {(args:object, callCtx:object)=>any} handler
   */
  addTool(pluginId, meta, handler) {
    const name = String(meta?.name ?? '').trim();
    if (!name) throw new Error('工具缺少 name');
    if (this.tools.has(name)) {
      const owner = this.tools.get(name).pluginId;
      throw new Error(
        owner === pluginId
          ? `工具 "${name}" 在本插件里重复注册`
          : `工具 "${name}" 已被插件 ${owner} 注册`,
      );
    }
    this.tools.set(name, {
      pluginId,
      pluginName: meta?.pluginName ?? pluginId,
      name,
      description: String(meta?.description ?? '').trim(),
      parameters: meta?.parameters ?? { type: 'object', properties: {} },
      handler,
      ownerOnly: Boolean(meta?.ownerOnly),
      admin: Boolean(meta?.admin),
      timeoutMs: Number(meta?.timeoutMs) > 0 ? Number(meta.timeoutMs) : 0,
      hidden: Boolean(meta?.hidden),
    });
    return this.tools.get(name);
  }

  removeTool(pluginId, name) {
    const e = this.tools.get(name);
    if (e && e.pluginId === pluginId) this.tools.delete(name);
  }

  getTool(name) {
    return this.tools.get(String(name ?? '').trim()) ?? null;
  }

  /**
   * 可对外暴露的工具描述（**不含 handler**）。
   *
   * 为什么不返回 entry 本体：这些描述会原样交给模型服务商，
   * 带上函数引用既没法序列化，也等于把内部实现递出去。
   */
  listTools({ includeHidden = false } = {}) {
    const out = [];
    for (const e of this.tools.values()) {
      if (e.hidden && !includeHidden) continue;
      out.push({
        name: e.name,
        description: e.description,
        parameters: e.parameters,
        pluginId: e.pluginId,
        pluginName: e.pluginName,
        ownerOnly: e.ownerOnly,
        admin: e.admin,
      });
    }
    return out;
  }
}

/** 每个插件一个简单的 JSON 键值存储，游戏存档之类可以直接用 */
export class PluginStorage {
  /** @param {string} file 该插件在该机器人下的存档文件 */
  constructor(file) {
    this.file = file;
    this.data = null;
    this.dirty = false;
    this.timer = null;
    /** key -> 该 key 的更新队列尾，保证 update() 串行 */
    this.locks = new Map();
    this.loading = null;
  }

  async #load() {
    if (this.data) return this.data;
    // 并发保护：多个命令同时进来时，只读一次文件。
    // 不加这个的话，每个调用都会 await readFile 然后各自赋值 this.data，
    // 后赋值的覆盖前面的，写到不同对象上 → 丢数据。
    if (!this.loading) {
      this.loading = (async () => {
        try {
          this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
        } catch {
          this.data = {};
        }
      })();
    }
    await this.loading;
    return this.data;
  }

  async get(key, fallback = undefined) {
    const d = await this.#load();
    return key in d ? d[key] : fallback;
  }

  /**
   * 原子更新：对同一个 key 的「读-改-写」串行执行，避免并发覆盖。
   *
   * 为什么需要：直接 get → 改 → set 在并发下会丢更新。
   * 比如玩家连发 /签到 和 /喂食，两条命令都读到同一份旧数据，
   * 后写入的会把前一条的结果盖掉。用 update 就不会。
   *
   *   await ctx.storage.update('user:123', (p) => {
   *     p.points += 10;        // 直接改传入的对象，或返回新对象
   *     return p;              // 返回 undefined 表示不写入
   *   });
   *
   * @param {string} key
   * @param {(cur:any)=>any} fn 拿到当前值，返回新值；返回 undefined 则不写入
   * @param {any} [fallback] key 不存在时传给 fn 的初始值
   */
  async update(key, fn, fallback = undefined) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const task = prev.then(async () => {
      const d = await this.#load();
      const cur = key in d ? d[key] : fallback;
      const val = await fn(cur);
      // undefined / null 都表示「这次不写入」，保持原值
      if (val !== undefined && val !== null) {
        d[key] = val;
        this.#scheduleSave();
      }
      return d[key];
    });
    // 排队用的一条链：前一个失败也不能卡住后面的，所以吞掉错误
    const tail = task.catch(() => {});
    this.locks.set(key, tail);
    // 队列跑完就清掉，避免 key 多了内存堆积
    tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return task;
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
export function createContext({ meta, paths, registry, api, cfg, config, configStore, groups, roles, levels, outbound, session, pipeline, reach, ledger, gate, isOwner, pages = null, routes = null, state = null }) {
  const id = meta.id;
  // 日志 tag 带机器人 id，多机器人下同名插件的日志不会串
  const logger = createLogger(`plugin:${paths?.id ?? '-'}:${id}`);
  const disposers = [];

  // 先占位，保证即使插件没注册任何命令，菜单里也有它的条目
  registry.ensureMenu(id, meta);

  // 面板「运行数据」：插件用 ctx.setDashboard() 推的最后一份
  let dashboardCache = null;

  /**
   * 工具调用器。`can` 依赖 ctx 自己（要按会话算权限等级），所以这里传的是
   * 延迟求值的闭包——箭头函数体在真正调用时才碰 ctx，那时它早就建好了。
   */
  const callTool = createToolCaller({
    registry,
    isOwner,
    can: (m, need) => ctx.can(m, need),
    scopeOf,
    log: (m) => logger.debug(m),
  });

  const ctx = {
    id,
    name: meta.name ?? id,
    version: meta.version ?? '0.0.0',
    // 已与默认值合并的用户配置，来自 config/bots/<机器人id>/plugins/<id>.json
    config: config ?? meta.config ?? {},
    /**
     * 插件自己的内存状态，**跨热重载保留**。
     *
     * 模块顶层变量在重载时会重建（ESM 的行为，不是 bug），
     * 想留的东西挂到 ctx.state 上就行；要真正持久化还是用 ctx.storage。
     *
     *   ctx.state.cache ??= {};
     */
    state: state ?? {},
    api,
    logger,
    /**
     * 可达性：`ctx.reach.canC2C(openid)` / `ctx.reach.canGroupPush(groupOpenid)`。
     *
     * 返回 `{ verdict: 'yes'|'no'|'unknown', reason? }`。
     * **`unknown` 不能当 `no` 用**——未知是「不知道」，不是「不行」。
     */
    reach,
    /**
     * 事件账本（**只读**）：`ctx.ledger.recent({chatId})` / `.timeline({chatId, anchorSeq})` / `.get(id)`。
     *
     * 官方没有历史消息接口，这是唯一能翻到「刚才群里说了什么」的地方。
     * 只给读，不给写：账本记的是「发生过的事实」，插件往里写就等于伪造历史。
     * 插件要存自己的东西用 `ctx.storage`。
     *
     * 注意保留期（默认 7 天），超出范围查不到是正常的，不是 bug。
     */
    ledger: ledger ? readOnlyLedger(ledger) : null,
    /**
     * 暂停闸：`ctx.gate.silence(chatId, ms)` / `.pauseChat(chatId, true)` / `.check(chatId)`。
     *
     * **不给 `setGlobal` / `setBot`**：那是「把整个进程停掉」和「把这只鸟停掉」，
     * 属于运维动作，只能从面板做。插件能停的只有自己正在处理的这个会话。
     *
     * 静默是给「她自己决定安静一会儿」用的（`<<silence:2h>>`），
     * 所以一定要能带时长，`ms <= 0` 表示解除。
     */
    gate: gate ? readOnlyGate(gate, id) : null,
    storage: new PluginStorage(paths.pluginData(id)),

    /**
     * 插件自己的文件目录：data/bots/<机器人>/plugins/<插件id>/
     *
     * 存档走 storage（一个 JSON），但图片缓存、生成的图片这类**文件**
     * 需要一个真实目录。以前插件只能自己猜 cwd，装到别的机器人下就串了。
     */
    dataDir: paths.pluginDataDirFor(id),
    /**
     * Markdown 与消息内交互标签的构造工具。
     *   ctx.md.cmdInput('/签到', '签到')  → 点了把 /签到 插进输入框（群聊可用）
     *   ctx.md.cmdEnter('/签到')         → 点了直接发（群聊不支持）
     *   ctx.md.esc(用户输入)              → 转义，防止破坏排版
     * 配合 msg.replyMarkdown({content}) 或 msg.replyMenu(title, groups) 使用。
     */
    md,
    prefix: cfg.commandPrefix || '/',

    /**
     * 往面板的「运行数据」推一份指标，面板每几秒拉一次就会更新。
     *   ctx.setDashboard({
     *     metrics: [
     *       { label: '已回复', value: counters.reply, unit: '条' },
     *       { label: '平均耗时', value: 320, unit: 'ms' },
     *     ],
     *     note: '模型：xxx',
     *   });
     * 想每次现算，也可以在插件导出里写 dashboard() 函数，二选一。
     */
    setDashboard(data) {
      dashboardCache = normalizeDashboard(data);
      return dashboardCache;
    },

    /** 框架内部用：取插件推的最后一份运行数据 */
    getDashboard() {
      return dashboardCache;
    },

    /**
     * 往面板注册一个自己的页面。
     *
     *   ctx.registerPage({
     *     key: 'board',            // 只在本插件内唯一
     *     label: '战绩榜',          // 面板标签上显示的名字
     *     html: '<h1>...</h1>',    // 一段完整或片段 HTML 都行
     *   });
     *
     * 页面在 iframe 里渲染：CSS 不会漏到面板上，也不会反过来影响面板。
     * 插件卸载或重载时页面自动消失，不用自己清理。
     *
     * @returns {string|null} 完整 key（`插件id:key`），环境不支持时返回 null
     */
    registerPage(page) {
      if (!pages) {
        logger.warn('当前环境不支持注册面板页面');
        return null;
      }
      return pages.register(id, page);
    },

    /**
     * 注册一个面板接口（REST），给自己注册的页面取数据用。
     *
     *   ctx.registerRoute('GET', '/players', async ({ query, json }) => {
     *     return json(200, await repo.list({ q: query.q }));
     *   });
     *   ctx.registerRoute('PATCH', '/players/:openid', async ({ params, body }) => {
     *     await repo.update(params.openid, body);
     *     return { ok: true };            // 直接返回对象 = 200 JSON
     *   });
     *
     * 实际地址是 `/api/plugins/<插件id>/r<你写的路径>`，
     * 鉴权、CSRF、同源校验全部复用面板那一套，插件拿不到裸 req/res。
     *
     * 处理函数拿到的是纯数据，返回三种东西：
     *   - 普通对象 → 200 + JSON
     *   - `json(code, data)` 的返回值 → 用你指定的状态码
     *   - undefined / null → 204 空响应
     *
     * 支持的方法：GET / POST / PUT / PATCH / DELETE，路径可含 `:param`。
     *
     * @returns {string|null} `METHOD /path`，环境不支持时返回 null
     */
    registerRoute(method, pattern, handler) {
      if (!routes) {
        logger.warn(`当前环境不支持插件路由，已忽略 ${method} ${pattern}`);
        return null;
      }
      return routes.add(id, method, pattern, handler);
    },

    /**
     * 改自己的配置并立刻落盘（只改传入的键，其余保留）。
     *   await ctx.setConfig({ welcome: '欢迎' });
     */
    async setConfig(patch) {
      if (!configStore) throw new Error('当前环境不支持写插件配置');
      const next = await configStore.set(patch);
      // 原地更新，插件里已经拿到的 ctx.config 引用也跟着变
      if (this.config && typeof this.config === 'object') {
        for (const k of Object.keys(this.config)) delete this.config[k];
        Object.assign(this.config, next);
        return this.config;
      }
      this.config = next;
      return next;
    },

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
        // 合并多插件回复时要靠 id 分组，name 只用来显示
        pluginId: id,
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
     * 注册一个 **AI 可调用**的工具（跨插件）。
     *
     * 命令是给人打的，工具是给模型调的：模型只看到名字、说明和参数 schema，
     * 自己决定什么时候调。别的插件（尤其 AI 插件）用 `ctx.tools()` 拿到清单、
     * `ctx.callTool()` 执行，于是「AI 能查斗罗玩家数据」这种事不用 AI 插件
     * 认识斗罗插件——两边只认这张表。
     *
     *   ctx.registerTool({
     *     name: 'douluo_status',
     *     description: '查一个斗罗玩家的等级、魂环、金币',
     *     parameters: {
     *       type: 'object',
     *       properties: { uin: { type: 'string', description: '玩家 QQ 号' } },
     *       required: ['uin'],
     *     },
     *     async execute({ uin }, call) {
     *       const p = await load(uin);
     *       return `${uin}：${p.level} 级，${p.gold} 金币`;
     *     },
     *   });
     *
     * `call` 里有 `{ msg, chatId, userId, userName, kind, scope, callTool }`，
     * 需要按人区分的工具从 `call.userId` 取，别自己去翻全局。
     *
     * 名字**全局唯一**（跨插件也不能重）：模型只认名字，重名会调到一个
     * 「不知道谁的」同名工具，出了问题极难查。
     *
     * @param {object} tool
     * @param {string} tool.name         全局唯一，建议带插件前缀
     * @param {string} [tool.description] 给模型看的说明，写「做什么」别写「怎么实现」
     * @param {object} [tool.parameters]  JSON Schema（OpenAI function calling 同款）
     * @param {boolean} [tool.ownerOnly]  只有机器人主人能调
     * @param {boolean} [tool.admin]      需要当前会话管理员
     * @param {number} [tool.timeoutMs]   超时，默认 15s
     * @param {boolean} [tool.hidden]     不出现在 ctx.tools() 里，只能显式调用
     * @param {(args:object, call:object)=>any} tool.execute
     * @returns {() => void} 注销函数（插件卸载时会自动调用，不用手动收）
     */
    registerTool(tool) {
      if (!tool || typeof tool.execute !== 'function') {
        throw new Error('registerTool 需要 { name, execute }');
      }
      registry.addTool(
        id,
        { ...tool, pluginName: meta.name ?? id },
        // 包一层：把 execute 抛出的同步异常也变成 rejection，
        // 否则 callTool 里的 try/finally 接不住同步 throw
        (args, call) => Promise.resolve().then(() => tool.execute(args, call)),
      );
      const off = () => registry.removeTool(id, tool.name);
      disposers.push(off);
      return off;
    },

    /**
     * 列出所有插件暴露的 AI 工具（**不含执行函数**，可以直接序列化给模型）。
     *
     * 为什么不带 handler：这份清单会原样进请求体发给服务商，
     * 带上函数引用既没法 JSON 化，也等于把内部实现递出去。
     *
     * @param {{includeHidden?:boolean}} [opts]
     */
    tools(opts) {
      return registry.listTools(opts);
    },

    /**
     * 执行一个工具。权限、超时、重入在这里统一兜住，调用方只管处理结果。
     *
     *   const list = ctx.tools();
     *   const out = await ctx.callTool('douluo_status', { uin }, { msg });
     *
     * 失败一律 **throw**（不是返回空）：调用方多半是 AI 插件，它要把
     * 「工具报错了」这句话回填给模型，让模型自己圆回来。
     */
    callTool(name, args, opts) {
      return callTool(name, args, opts);
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

    /* ---------------- 多轮对话与主动发送 ---------------- */

    /**
     * 问一句、等回答。文字游戏的多轮交互全靠它。
     *
     *   const ans = await ctx.prompt(msg, '用哪个技能？\n1 蓝银缠绕 2 昊天锤');
     *   if (!ans) return;                 // 超时，prompt 已经提示过了
     *   if (ans.content === '1') { ... }
     *
     * @param {object} msg   触发本次交互的消息
     * @param {string} [text] 要发给用户的提示，省略则只等待
     * @param {object} [opts]
     * @param {'user'|'chat'} [opts.from] 只认这个人，还是这个会话里谁都算
     * @param {number} [opts.timeoutMs]
     * @param {string|false} [opts.onTimeout] 超时提示语，false 表示不提示
     * @returns {Promise<object|null>} 用户的下一条消息，超时为 null
     */
    async prompt(msg, text, opts = {}) {
      if (!session) throw new Error('当前环境不支持多轮对话');
      if (text) await msg.reply(text);
      // 提示语是攒着的，必须立刻发出去，否则用户看不到问题、只能等到超时
      await msg.flushReplies?.();

      const timeoutMs =
        opts.timeoutMs ?? Math.max(1000, (cfg.session?.promptTimeoutSec ?? 120) * 1000);
      const answer = await session.wait({
        chatId: msg.chatId,
        userId: msg.userId,
        from: opts.from ?? 'user',
        timeoutMs,
      });

      if (!answer && opts.onTimeout !== false) {
        const hint =
          typeof opts.onTimeout === 'string' ? opts.onTimeout : '等太久没收到回复，这次先取消了。';
        // 用户可能已经离开，发不出去也无所谓
        await msg.reply(hint).catch(() => {});
      }
      return answer;
    },

    /** 只等待，不主动发提示（用于「上一条已经问过了」的场景） */
    wait(msg, opts = {}) {
      if (!session) throw new Error('当前环境不支持多轮对话');
      return session.wait({
        chatId: msg.chatId,
        userId: msg.userId,
        from: opts.from ?? 'user',
        timeoutMs: opts.timeoutMs ?? Math.max(1000, (cfg.session?.promptTimeoutSec ?? 120) * 1000),
      });
    },

    /** 取消某人当前的等待 */
    cancelWait(msg) {
      session?.cancel(msg.chatId, msg.userId);
    },

    /**
     * 主动推送一条消息（不依赖用户触发）。
     * 注意：受每日额度限制，额度用完会抛错，定时任务请自行 catch。
     *
     *   await ctx.push(groupOpenid, '今天的魂兽森林刷新了')
     */
    push(chatId, text, { kind = 'group' } = {}) {
      if (!outbound) throw new Error('当前环境不支持主动推送');
      return outbound.send({
        kind,
        target: chatId,
        chatKey: `${kind}:${chatId}`,
        payload: { content: String(text ?? '') },
      });
    },

    /** 这个会话还剩多少条主动消息额度 */
    async quotaLeft(chatId, kind = 'group') {
      if (!outbound) return 0;
      const used = (await outbound.quotaSnapshot())[`${kind}:${chatId}`] ?? 0;
      return Math.max(0, outbound.dailyActive - used);
    },

    /** 该会话是否处在免@窗口内（用户刚 @ 过，接下来不用每句都 @） */
    isSticky(chatId) {
      return Boolean(session?.isSticky(chatId));
    },

    /**
     * 注册一个中间件。在命令/消息到达本插件之前执行，
     * 不调用 next() 就能把消息拦下来。
     *
     *   ctx.use('反垃圾', async (ctx, next) => {
     *     if (ctx.msg.content.includes('广告')) return;
     *     await next();
     *   });
     */
    use(name, fn) {
      if (!pipeline) throw new Error('当前环境不支持中间件');
      pipeline.use(`${id}:${name}`, fn, { pluginId: id });
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

      // 同一条消息里插件可能反复问权限，算一次就缓存到消息对象上
      const cacheKey = `__lvl_${id}`;
      if (msg && msg[cacheKey] !== undefined) return msg[cacheKey];

      const [chat, feature] = await Promise.all([
        roles.effective(scopeOf(msg), msg?.userId, { owners: cfg.owners }),
        roles.effective(`feature:${id}`, msg?.userId, { owners: cfg.owners }),
      ]);
      const v = Math.min(chat, feature);
      if (msg) msg[cacheKey] = v;
      return v;
    },

    /**
     * 当前消息发送者是否达到某等级，默认要求管理员（数字越小越高）。
     *   ctx.can(msg)                 → 需要 1 级管理员
     *   ctx.can(msg, 'manager')      → 需要 2 级群管
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

    /**
     * 某人是否是指定群的管理员及以上。
     * 统一看 roles 的 group 作用域（群档案里不再存权限）。
     */
    async isGroupAdmin(groupOpenid, userId) {
      if (!roles) return false;
      const lv = await roles.effective(`group:${groupOpenid}`, userId, { owners: cfg.owners });
      return lv <= LEVEL.admin;
    },

    /** 读取群档案（邀请者、群主、是否启用等，不含权限） */
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
