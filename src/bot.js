import { createLogger, attachLogFile } from './logger.js';
import { TokenManager } from './token.js';
import { QQApi } from './api.js';
import { Gateway } from './gateway.js';
import { Registry } from './plugin/context.js';
import { PluginManager } from './plugin/loader.js';
import { orderListeners, skipBecauseClaimed } from './plugin/dispatch.js';
import { GroupStore } from './groups.js';
import { RoleStore, LEVEL, NO_PERM, levelName, parseLevel, parseScope, scopeOf } from './roles.js';
import { Outbound } from './outbound.js';
import { SessionManager } from './session.js';
import { createDefaultPipeline } from './pipeline.js';
import { buildMessage, isMessageEvent } from './message.js';
import { EVENTS, isKnownEvent } from './events.js';
import { BotMetrics } from './runtime.js';
import { claimInstance, releaseInstance } from './instance.js';
import { botPaths, DIRS, rel } from './paths.js';
import { StatsStore } from './storage/index.js';
import { createReach } from './reach.js';

/**
 * 一个机器人的完整运行时。
 *
 * 多机器人 = 多个 BotRuntime 实例并存。每个实例独占：
 *   凭证 / HTTP API / WebSocket / 命令表 / 权限 / 群档案 / 额度账本 / 会话 / 插件管理器
 *
 * 共享的只有：插件**代码**目录、全局日志、面板服务。
 *
 * 为什么必须这么隔离：openid 是每个机器人独立的，共享权限或存档等于全部对不上。
 */
export class BotRuntime {
  /**
   * @param {object} p
   * @param {object} p.cfg       该机器人的配置
   * @param {object} p.globalCfg 全局配置
   * @param {object} p.guards    前置拦截用的配置（从 cfg 派生）
   * @param {boolean} p.mock     是否 mock 模式
   * @param {object} [p.webhook]  全局 WebhookServer，webhook 模式下注册到这里
   * @param {(runtime:BotRuntime)=>void} [p.registerCore] 注册内核命令的回调
   * @param {()=>object} [p.makeMockApi] mock 模式下造 API 的函数
   */
  constructor({ cfg, globalCfg, mock = false, webhook = null, registerCore = null, makeMockApi = null, onMessage = null }) {
    this.cfg = cfg;
    this.globalCfg = globalCfg;
    this.mock = mock;
    this.webhook = webhook;
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    /** 该机器人独占的运行时指标（连接态 + 计数），多机器人互不干扰 */
    this.metrics = new BotMetrics(this.id);
    this.paths = botPaths(this.id);
    this.log = createLogger(`bot:${this.id}`);

    this.registerCore = registerCore;
    this.makeMockApi = makeMockApi;
    /**
     * 收到消息时的外部回调（面板 SSE、AI 宿主订阅）。
     * 传的是**规范化后的 Message**，不是原始事件体——原始体里有 auth_token。
     */
    this.onMessage = onMessage;

    this.claim = { code: '' };
    this.tokens = null;
    this.api = null;
    this.gateway = null;
    this.registry = new Registry();
    this.groups = new GroupStore(this.paths.groups);

    /**
     * 最近说过话的人：openid -> { openid, name, chatId, scope, at }
     *
     * **只放内存，不落盘。** 用途只有一个：面板「权限」页让人点一下就能加权限，
     * 不用去日志里翻 openid——openid 是每个机器人独立的长串，用户根本记不住。
     * 重启后清空，重新说句话就又有了。
     */
    this.recentPeople = new Map();
    /**
     * 群名缓存：groupOpenid -> { name, at }
     *
     * **官方事件里没有群名**（实测 GROUP_AT_MESSAGE_CREATE 的字段只有
     * author/content/group_id/group_openid/id/message_scene/message_type/timestamp），
     * 而面板上只显示 `577C4A90…` 这种截断的 openid，用户根本认不出是哪个群。
     *
     * 所以在入群 / 首次收到消息时异步拉一次 `getGroupInfo` 补上，
     * 之后面板直接读缓存。**不落盘**：群名会变，存下来反而是错的；
     * 拉不到就退回显示 openid，不影响任何功能。
     */
    this.groupNames = new Map();
    this.roles = new RoleStore(this.paths.roles);
    /**
     * 可达性：谁能私聊、哪个群能主动推。
     *
     * 官方没有查好友的接口，只能靠 6 个事件维护（FRIEND_ADD/DEL、
     * C2C_MSG_REJECT/RECEIVE、GROUP_MSG_REJECT/RECEIVE）。
     * 插件可以通过 `bot.reach` 直接问，不用自己监听一遍。
     */
    this.reach = createReach({ file: this.paths.reach });
    this.outbound = null;
    this.session = null;
    this.pipeline = null;
    this.plugins = null;

    this.state = 'idle'; // idle | starting | online | offline | stopped | error
    this.lastError = '';
    this.startedAt = 0;
  }

  get online() {
    return this.state === 'online';
  }

  /** 该机器人的状态摘要，面板用 */
  get status() {
    return {
      id: this.id,
      name: this.name,
      state: this.state,
      online: this.online,
      appId: this.cfg.appId,
      intents: this.cfg.intents,
      plugins: this.plugins ? this.plugins.list() : [],
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      error: this.lastError,
      botName: this.mock ? `${this.name}（mock）` : this.metrics.botName,
      counters: { ...this.metrics.counters },
    };
  }

  /* ---------------- 初始化 ---------------- */

  /**
   * 建好所有组件但不连网关。
   * @returns {Promise<void>}
   */
  async init() {
    const { cfg } = this;

    // 每个机器人一个日志文件
    if (this.globalCfg.logs?.enabled !== false) {
      await attachLogFile(`bot:${this.id}`, this.paths.log, {
        maxBytes: this.globalCfg.logs?.maxBytes,
      });
    }

    if (this.mock) {
      this.api = this.makeMockApi ? this.makeMockApi(this) : null;
    } else {
      this.tokens = new TokenManager(cfg);
      this.api = new QQApi({ tokenManager: this.tokens, baseUrl: cfg.baseUrl, metrics: this.metrics });
    }

    this.outbound = new Outbound({
      api: this.api,
      cfg,
      isOnline: () => this.mock || this.online,
      quotaFile: this.paths.quota,
    });

    // 群管内邀开关：api 层有自己的副本，配置变了由面板接口同步过来。
    // mock 的 api 也实现了同名方法，一起同步，方便本地验证插件的群管逻辑
    this.api.setGroupInvited?.(cfg.groupManage?.invited);

    this.session = new SessionManager({
      stickyMs: Math.max(0, (cfg.session?.stickySec ?? 180) * 1000),
      waitTimeoutMs: Math.max(1000, (cfg.session?.promptTimeoutSec ?? 120) * 1000),
    });

    this.pipeline = createDefaultPipeline(cfg, {
      isSticky: (chatId) => this.session.isSticky(chatId),
      metrics: this.metrics,
    });

    /**
     * 统计库：每个机器人一份 stats.db。
     * 没装 SQLite 或版本太低时 available=false，record() 直接返回，不影响收消息。
     */
    this.stats = new StatsStore({
      file: this.paths.stats,
      enabled: cfg.stats?.enabled !== false,
      retentionDays: cfg.stats?.retentionDays ?? 90,
    });

    this.plugins = new PluginManager({
      pluginsDir: DIRS.plugins,
      paths: this.paths,
      registry: this.registry,
      api: this.api,
      cfg,
      goBin: this.globalCfg.plugins?.goBin || null,
      groups: this.groups,
      roles: this.roles,
      outbound: this.outbound,
      session: this.session,
      pipeline: this.pipeline,
      reach: this.reach,
      isOwner: (uid) => cfg.owners.includes(uid),
      // 插件声明了 frameworkVersion 就做兼容校验；作者本地调试可以关掉
      ignoreCompat: this.globalCfg.plugins?.ignoreFrameworkVersion === true,
    });

    if (this.registerCore) {
      this.registerCore(this);
    }

    // 统计库要在插件之前打开：插件上报的运行数据也算统计的一部分
    this.stats.open();

    // 按配置过滤要加载的插件
    await this.plugins.scan({ filter: pluginFilterOf(cfg.plugins) });
  }

  /* ---------------- 启动 / 停止 ---------------- */

  async start() {
    this.startedAt = Date.now();
    return this.goOnline();
  }

  /**
   * 上线：连网关。已经在线就什么都不做。
   * 面板的「上线」按钮走这里，和 start() 的区别只是不重置 startedAt。
   */
  async goOnline() {
    if (this.state === 'online' || this.state === 'starting') return this.state;
    const { cfg } = this;
    this.state = 'starting';
    this.lastError = '';

    // mock 模式：不连网关，直接算在线
    if (this.mock) {
      this.state = 'online';
      this.log.info('mock 模式已就绪');
      return this.state;
    }

    if (!cfg.appId || !cfg.appSecret) {
      this.state = 'error';
      this.lastError = '缺少 AppID / AppSecret';
      this.log.error(this.lastError);
      return this.state;
    }

    // Webhook 模式：不连网关，把回调注册到全局 Webhook 服务即可。
    // 发消息仍然走 HTTP API，所以后续所有发送逻辑不受影响。
    if (cfg.connection?.mode === 'webhook') {
      const wh = this.webhook;
      if (!wh) {
        this.state = 'error';
        this.lastError = '配置选了 webhook 模式，但 Webhook 服务没启动（检查全局配置 webhook.enabled）';
        this.log.error(this.lastError);
        return this.state;
      }
      try {
        wh.register(cfg.appId, {
          secret: cfg.appSecret,
          onEvent: (event, d, payload) => this.dispatch(event, d, payload),
          onError: (e) => this.log.error(`Webhook 事件处理失败: ${e.message}`),
        });
        this.state = 'online';
        if (!this.startedAt) this.startedAt = Date.now();
        this.log.info(`已上线（Webhook 模式，回调 ${wh.path}）`);
      } catch (e) {
        this.state = 'error';
        this.lastError = e.message;
        this.log.error(`Webhook 注册失败: ${e.message}`);
      }
      return this.state;
    }

    // 同一个 AppID 不能有两个实例连网关
    const claimed = await claimInstance({ appId: cfg.appId });
    if (!claimed.ok) {
      this.state = 'error';
      this.lastError = `AppID ${cfg.appId} 已有实例在运行（PID ${claimed.conflict.pid}）`;
      this.log.error(this.lastError);
      return this.state;
    }

    this.gateway = new Gateway({
      api: this.api,
      tokens: this.tokens,
      intents: cfg.intents,
      metrics: this.metrics,
      onDispatch: (event, d, p) => this.dispatch(event, d, p),
    });

    try {
      await this.gateway.start();
      this.state = 'online';
      if (!this.startedAt) this.startedAt = Date.now();
      this.log.info('已上线');
    } catch (e) {
      this.state = 'error';
      this.lastError = e.message;
      this.log.error(`连接失败: ${e.message}`);
    }
    return this.state;
  }

  /**
   * 下线：断开网关，但**不卸载插件、不清存档**。
   * 和 stop() 的区别是这里可以随时再 goOnline() 回来。
   */
  async goOffline() {
    if (this.state === 'offline') return this.state;
    try {
      this.gateway?.stop();
    } catch {}
    this.gateway = null;
    // webhook 模式没有长连接，注销回调才算真的下线
    try {
      this.webhook?.unregister(this.cfg.appId);
    } catch {}
    if (!this.mock) await releaseInstance(this.cfg.appId).catch(() => {});
    this.state = 'offline';
    this.log.info('已下线（插件与存档保留）');
    return this.state;
  }

  /**
   * 记下「这个人刚说过话」，给面板权限页用。
   * 只留最近 200 个，超了按最后发言时间淘汰——内存里的一点索引，不值得落盘。
   */
  #rememberPerson(msg) {
    if (!msg?.userId) return;
    const prev = this.recentPeople.get(msg.userId);
    this.recentPeople.set(msg.userId, {
      openid: msg.userId,
      // 有的场景拿不到昵称（频道事件），保留上一次的
      name: msg.userName || prev?.name || '',
      scope: msg.kind,
      chatId: msg.chatId,
      at: Date.now(),
    });

    if (this.recentPeople.size > 200) {
      const keep = [...this.recentPeople.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, 200);
      this.recentPeople = new Map(keep.map((p) => [p.openid, p]));
    }
  }

  /** 面板「权限」页的候选人列表，最近的排前面 */
  listRecentPeople(limit = 40) {
    return [...this.recentPeople.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  /** 查群名，没有就 undefined（面板自己退回显示 openid） */
  groupName(groupOpenid) {
    if (!groupOpenid) return undefined;
    return this.groupNames.get(groupOpenid)?.name || undefined;
  }

  /**
   * 用 6 个事件维护可达性。
   *
   * 官方**没有查好友列表的接口**（sitemap 里 `friend` 只有两个事件页），
   * 所以「接入之前就存在的关系」永远是未知的，只能维护「接入之后的变化」。
   * 三态语义与判定顺序见 `src/reach.js` 头注释。
   */
  async #noteReach(eventName, d) {
    const openid = d?.openid ?? '';
    switch (eventName) {
      case 'FRIEND_ADD':
        await this.reach.noteFriendAdd({
          openid,
          unionOpenid: d?.author?.union_openid ?? '',
          scene: d?.scene ?? 0,
        });
        break;
      case 'FRIEND_DEL':
        await this.reach.noteFriendDel({ openid });
        break;
      case 'C2C_MSG_REJECT':
        await this.reach.noteC2cPush({ openid, on: false });
        break;
      case 'C2C_MSG_RECEIVE':
        await this.reach.noteC2cPush({ openid, on: true });
        break;
      case 'GROUP_MSG_REJECT':
        await this.reach.noteGroupPush({
          groupOpenid: d?.group_openid,
          on: false,
          by: d?.op_member_openid,
        });
        break;
      case 'GROUP_MSG_RECEIVE':
        await this.reach.noteGroupPush({
          groupOpenid: d?.group_openid,
          on: true,
          by: d?.op_member_openid,
        });
        break;
      default:
        break;
    }
  }

  /**
   * 补一个群的名字（给面板调的公开入口，内部走带缓存的那份）。
   * 不会抛异常，调用方不用 try/catch。
   */
  ensureGroupNameCached(groupOpenid) {
    this.#ensureGroupName(groupOpenid).catch(() => {});
  }

  /**
   * 批量补群名，最多等 `timeoutMs`。
   *
   * 面板要的是「打开就能认出是哪个群」，让用户先看一串 `577C4A90…`
   * 再自己刷新一次很别扭；但也不能为了几个群名把面板卡住（接口有频控，
   * 群多了还会串行超时）。所以给一个总超时，到点有多少用多少。
   *
   * @param {string[]} ids
   * @param {{timeoutMs?:number}} [opts]
   */
  async fetchGroupNames(ids = [], { timeoutMs = 2500 } = {}) {
    const todo = [...new Set(ids.filter((id) => id && !this.groupName(id)))];
    if (!todo.length) return;

    const work = Promise.allSettled(todo.map((id) => this.#ensureGroupName(id)));
    let timer;
    const cap = new Promise((r) => {
      timer = setTimeout(r, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([work, cap]);
    clearTimeout(timer);
  }

  /**
   * 补一个群的名字。
   *
   * 带 10 分钟缓存：群名不会总变，但每个群每次启动查一次就够，
   * 没必要每条消息都打接口（`getGroupInfo` 是公开接口，但也有频控）。
   *
   * **拉不到也要记一笔空名字**（负缓存）。否则面板每刷新一次就重打一遍
   * 接口——机器人没权限查、群已解散这类情况会一直失败，变成持续的空转。
   *
   * **永远不抛异常**——它是在消息处理链路里被调的，为了一个显示用的名字
   * 把消息搞丢是不可能的。
   */
  async #ensureGroupName(groupOpenid) {
    if (!groupOpenid) return;
    const hit = this.groupNames.get(groupOpenid);
    if (hit && Date.now() - hit.at < 10 * 60_000) return;

    try {
      const info = await this.api.getGroupInfo(groupOpenid);
      const name = String(info?.group_name ?? info?.name ?? '').trim();
      this.groupNames.set(groupOpenid, { name, at: Date.now() });
    } catch {
      // 拉不到就算了：openid 也能认，只是没那么好认
      this.groupNames.set(groupOpenid, { name: '', at: Date.now() });
    }
  }

  async stop() {
    try {
      this.gateway?.stop();
    } catch {}
    try {
      this.webhook?.unregister(this.cfg.appId);
    } catch {}
    this.session?.clear();
    await this.plugins?.shutdown().catch(() => {});
    await this.outbound?.flush().catch(() => {});
    await this.groups?.flush().catch(() => {});
    await this.roles?.flush().catch(() => {});
    await this.reach?.flush().catch(() => {});
    this.stats?.close();
    if (!this.mock) await releaseInstance(this.cfg.appId).catch(() => {});
    this.state = 'stopped';
  }

  /* ---------------- 事件分发 ---------------- */

  /**
   * 这个方法和单机器人时的逻辑一致，只是绑到了某个实例上。
   * 所有事件都会转交给插件，未知事件也不例外。
   */
  async dispatch(eventName, d) {
    const { cfg, registry, roles, groups, session, pipeline, outbound } = this;

    this.metrics.lastEventAt = Date.now();
    this.metrics.messageEvent = eventName;
    this.metrics.bumpEvent(eventName);

    /* ---- 非消息事件 ---- */
    if (!isMessageEvent(eventName)) {
      if (!isKnownEvent(eventName)) {
        this.log.warn(`收到未登记的事件 ${eventName}，已转交插件。建议在 src/events.js 补登记`);
      }

      if (eventName === 'GROUP_ADD_ROBOT') {
        const gid = d?.group_openid;
        const inviter = d?.op_member_openid || '';
        await groups.onAdded(gid, inviter);
        // 顺便把群名拉下来，面板上就不用显示一串 openid 了
        this.#ensureGroupName(gid).catch(() => {});
        if (inviter && gid) {
          const gScope = `group:${gid}`;
          if ((await roles.levelIn(gScope, inviter)) >= NO_PERM) {
            await roles.set(gScope, inviter, LEVEL.admin);
            this.log.info(`邀请人 ${inviter} 已设为 ${gScope} 的管理员`);
          }
        }
      } else if (eventName === 'GROUP_DEL_ROBOT') {
        await groups.onRemoved(d?.group_openid);
      }

      // 可达性：官方没有查询接口，只能靠这 6 个事件维护（见 src/reach.js）
      // 放在插件监听器之前，插件读到的就是最新状态
      await this.#noteReach(eventName, d).catch((e) => {
        this.log.warn(`可达性更新失败: ${e.message}`);
      });

      const meta = EVENTS[eventName] ?? null;
      for (const l of registry.listeners.get(eventName) ?? []) {
        // 事件里的群：有 group_openid 就按群开关过滤，没有（如私聊事件）就放行
        if (d?.group_openid && !pluginAllowedIn(cfg.plugins, d.group_openid, l.pluginId)) continue;
        try {
          await l.handler(d, {
            event: eventName,
            intent: meta?.intent ?? null,
            desc: meta?.desc ?? '',
            api: this.api,
            bot: this,
          });
        } catch (e) {
          this.metrics.bump('errors');
          this.log.error(`监听器 ${l.pluginId} 处理 ${eventName} 出错:`, e.stack || e.message);
        }
      }
      return;
    }

    /* ---- 消息事件 ---- */
    const msg = buildMessage(eventName, d, { api: this.api, cfg, outbound, session });

    // 收到私聊 = 好友关系存在的强证据。不置 c2cPush：他能发不等于他允许机器人主动推
    if (msg.kind === 'c2c' && msg.userId) {
      this.reach
        .noteC2cObserved({ openid: msg.userId, unionOpenid: d?.author?.union_openid })
        .catch(() => {});
    }

    /**
     * 先播出去，再做业务处理。
     *
     * 放在 pipeline 之前是有意的：外部订阅者（AI 宿主）关心的是「群里说了什么」，
     * 不管这条消息有没有被去重/白名单/限流拦下——拦下是**本框架的**处理策略，
     * 不该影响订阅者看到的事实。
     * 回调抛错必须吞掉：订阅者是外挂代码，不能让它把收消息搞崩。
     */
    try {
      this.onMessage?.(msg);
    } catch (e) {
      this.log.warn(`消息广播失败: ${e.message}`);
    }
    try {
      this.metrics.bump('recv');
      this.metrics.touchChat(msg.chatId, msg.kind);
      if (msg.kind === 'group' && msg.groupId) await groups.touch(msg.groupId);
      /**
       * 在这个群第一次说话时顺手把群名拉下来（内部有 10 分钟缓存，
       * 只有第一次真的会打接口），面板上就不用显示一串 openid 了。
       * 不 await：这是显示用的信息，不值得让消息多等一次网络往返。
       */
      if (msg.kind === 'group' && msg.groupId) this.ensureGroupNameCached(msg.groupId);

      if (msg.kind === 'group' && msg.raw?.author?.member_role === 'owner') {
        await groups.setOwner(msg.groupId, msg.userId);
        const gScope = `group:${msg.groupId}`;
        if ((await roles.levelIn(gScope, msg.userId)) >= NO_PERM) {
          await roles.set(gScope, msg.userId, LEVEL.admin);
          this.log.info(`群主 ${msg.userId} 自动获得 ${gScope} 的管理员权限`);
        }
      }

      this.logIncoming(msg);

      if (msg.mentioned || msg.isCommand) session.markAddressed(msg.chatId);

      const commandEntry = msg.isCommand ? registry.commands.get(msg.command) ?? null : null;
      const passed = await pipeline.run({ msg, cfg, commandEntry });
      if (!passed) return;

      /**
       * 统计：只记「谁、在哪、什么时候、是不是命令」，**不记正文**。
       *
       * 放在 pipeline 之后是有意的：被去重 / 白名单 / 限流拦下的消息不计入，
       * 统计出来的是「实际处理量」。QQ 偶尔会重推同一条消息，
       * 计进去会让数字虚高，用户还以为是自己的群突然热闹了。
       * （想看得更全可以看概览页的「收到消息」，那个是 pipeline 之前计数的。）
       *
       * record() 只进内存缓冲，1 秒批量落盘，不会拖慢回复。
       */
      this.stats?.record({
        scope: msg.kind,
        chatId: msg.chatId,
        userId: msg.userId,
        isCommand: msg.isCommand,
        command: msg.command,
      });

      this.#rememberPerson(msg);

      if (msg.isCommand && commandEntry) {
        /**
         * 分群插件开关：这个群没启用这个插件就不执行。
         *
         * 回复与否**看人**：
         *   - 普通成员一个字都不回——机器人在多个群里，被禁用的命令如果
         *     在群里回一句提示，等于把这个开关变成了噪音源，从他们视角
         *     这个功能就该不存在。
         *   - 管理员/主人必须回一句——否则「本群把这个插件关了」和
         *     「机器人坏了」在他眼里完全一样，只能去翻配置文件才知道原因。
         *     这是「找不到在哪开关插件」的一半来源：开关生效得太安静。
         */
        if (!pluginAllowedIn(cfg.plugins, msg.chatId, commandEntry.pluginId)) {
          this.metrics.bump('ignored');
          try {
            const lv = await roles.effective(scopeOf(msg), msg.userId, { owners: cfg.owners });
            if (lv <= LEVEL.admin) {
              const P = cfg.commandPrefix || '/';
              await msg
                .reply(
                  `本群已关闭插件「${commandEntry.pluginId}」。\n` +
                    `恢复：${P}群插件 开 ${commandEntry.pluginId}`,
                )
                .catch(() => {});
            }
          } catch {
            /* 权限查不出来就当普通成员处理 */
          }
          return;
        }
        const scope = scopeOf(msg);
        if (commandEntry.admin || commandEntry.globalAdmin) {
          const lv = await roles.effective(scope, msg.userId, { owners: cfg.owners });
          if (commandEntry.admin && lv > LEVEL.admin) {
            return msg
              .reply(
                `需要管理员权限才能用这个命令（你当前是${levelName(lv)}）。\n` +
                  `发 ${cfg.commandPrefix || '/'}admin me 查看自己的权限。`,
              )
              .catch(() => {});
          }
          if (commandEntry.globalAdmin) {
            const gl = cfg.owners.includes(msg.userId)
              ? LEVEL.owner
              : await roles.levelIn('global', msg.userId);
            if (gl > LEVEL.admin) {
              return msg.reply('这个命令影响全局，需要「全局管理员」权限。').catch(() => {});
            }
          }
        }
        const required = (commandEntry.pattern?.match(/<[^>]+>/g) ?? []).length;
        if (msg.args.length < required) {
          return msg.reply(`参数不够\n用法: ${commandEntry.usage}`).catch(() => {});
        }
        this.metrics.bump('commands');
        /**
         * 标上「现在是哪个插件在回」，合并回复时要用它加标题。
         *
         * 命令是排他的（同一个命令名只属于一个插件），本来不会冲突；
         * 但命令和监听器可能都往这条消息里回，所以一样要标。
         */
        msg.pluginId = commandEntry.pluginId ?? '';
        msg.pluginName = commandEntry.plugin ?? '';
        try {
          await commandEntry.handler(msg, { args: msg.args, raw: msg.content, bot: this });
        } catch (e) {
          this.metrics.bump('errors');
          if (e?.code === 'offline' || e?.code === 'expired' || e?.code === 'quota') {
            this.log.warn(`命令 ${commandEntry.name} 回复失败: ${e.message}`);
            return;
          }
          this.log.error(
            `命令 ${commandEntry.name}（插件 ${commandEntry.pluginId}）执行出错:`,
            e.stack || e.message,
          );
          await msg.reply(`执行出错: ${e.message}`).catch(() => {});
        }
        return;
      }

      if (session.deliver(msg)) return;

      if (msg.isCommand) {
        const P = cfg.commandPrefix || '/';
        return msg.reply(`没有这个命令：${P}${msg.command}\n发 ${P}help 查看全部命令`).catch(() => {});
      }

      let handled = false;
      for (const evt of ['message', eventName]) {
        /**
         * 按插件优先级排序：**高的先跑**，同优先级保持注册顺序。
         *
         * 为什么需要：`msg.claim()` 是「这条我接了，别人别管」，
         * 而谁先跑决定了谁能认领。专门干某件事的插件（关键词、群管）
         * 应该先跑；像「AI 对话」这种什么都想接的，priority 调低排最后，
         * 别人认领了它就不吭声。
         */
        const ordered = orderListeners(registry.listeners.get(evt), (id) => this.plugins?.loaded?.get(id)?.meta);

        for (const l of ordered) {
          // 分群开关对被动触发同样生效，否则「禁用了还在回关键词」
          if (!pluginAllowedIn(cfg.plugins, msg.chatId, l.pluginId)) continue;

          /**
           * 这条已经被别的插件认领了。
           *
           * 默认跳过——避免「两个插件同时回答一句」。
           * 确实需要看的插件可以在 meta 里声明 `seeClaimed: true`，
           * 它照样能收到，并且能通过 `msg.claimedBy` 知道是谁接的。
           */
          if (skipBecauseClaimed(msg, l.pluginId, this.plugins?.loaded?.get(l.pluginId)?.meta)) continue;

          /**
           * 标上当前插件，让 msg.reply 知道这句是谁说的。
           *
           * 没被认领时**不是排他分发**：所有 listener 都会被调用，
           * 各自往 replyBuf 里攒，最后合并成一条发出，按插件分组加标题。
           */
          msg.pluginId = l.pluginId ?? '';
          msg.pluginName = this.plugins?.loaded?.get(l.pluginId)?.meta?.name ?? l.pluginId ?? '';
          try {
            const ret = await l.handler(msg);
            // 返回 true 等于认领：这条我处理了，后面的别管
            if (ret === true) msg.claim();
            if (ret === true || msg.replied) handled = true;
          } catch (e) {
            this.metrics.bump('errors');
            this.log.error(`监听器 ${l.pluginId} 处理 ${evt} 出错:`, e.stack || e.message);
          }
        }
      }
      if (!handled) this.metrics.bump('ignored');
    } finally {
      // 本次处理里所有插件攒下的回复，合并成一条发出去
      await msg.flushReplies?.();
    }
  }

  logIncoming(msg) {
    const ml = this.cfg.messageLog ?? {};
    if (ml.enabled === false) return;
    if ((ml.muteKinds ?? []).includes(msg.kind)) return;

    /**
     * 把正文里的 `<@openid>` 换回 `@昵称` 再打。
     *
     * 官方在 content 里把 @ 写成 `<@member_openid>`，而 `msg.content` 为了能
     * 解析命令已经把 @ 全删掉了——直接打出来是「/禁言 1m」，看不出这条消息
     * @ 了谁。排查群管、点名类问题时这点很关键。
     *
     * 原始正文在 `msg.raw.content`；昵称从 `msg.allMentions` 拿（官方在 mentions
     * 里给了 username）。这里必须用 allMentions 而不是 mentions——后者把机器人
     * 自己过滤掉了，而 `@机器人 /禁言 1m` 里被 @ 的机器人恰恰是最常出现的那个。
     * 认不出昵称就退到 openid 前 8 位，总比一串尖括号好读。
     */
    let text = String(msg.raw?.content ?? msg.content ?? '');
    for (const m of msg.allMentions ?? msg.mentions ?? []) {
      if (!m.id) continue;
      const shown = m.name || `${m.id.slice(0, 8)}…`;
      text = text.split(`<@${m.id}>`).join(`@${shown}`);
    }
    if (text.length > 120) text = `${text.slice(0, 120)}…`;

    const who = msg.userName
      ? `${msg.userName}(${msg.userId.slice(0, 8)})`
      : msg.userId.slice(0, 8) || '-';
    const where = msg.groupId ? msg.groupId.slice(0, 10) : '-';
    this.log.info(`收到 ${msg.kind} 会话:${where} 来自:${who} 内容:${describeForLog(msg, text)}`);
  }
}

/**
 * 日志里怎么显示这条消息。
 *
 * 官方接口里**纯图片 / 纯语音消息的 `content` 是空串**，内容全在 `attachments`。
 * 之前直接打 `text || '(空)'`，日志里就只有「内容:(空)」——
 * 看不出用户到底发了图还是发了语音，排查时全靠猜。
 *
 * 现在按附件类型给出人话：`[图片消息]`、`[语音消息: 转写内容]`、`[视频消息]`…
 * 文本和附件都有时一起显示（图文消息很常见）。
 */
export function describeForLog(msg, text = '') {
  const parts = [];
  const said = String(text ?? '').trim();
  if (said) parts.push(said);

  const atts = Array.isArray(msg?.attachments) ? msg.attachments : [];
  const count = (type) => atts.filter((a) => a?.type === type).length;

  const imgs = count('image');
  if (imgs) parts.push(imgs > 1 ? `[图片消息×${imgs}]` : '[图片消息]');

  for (const v of atts.filter((a) => a?.type === 'voice')) {
    // 官方 ASR 是白给的，有就带上——排查「它到底听没听清」全靠这个
    parts.push(v?.asrText ? `[语音消息: ${String(v.asrText).trim()}]` : '[语音消息]');
  }

  const vids = count('video');
  if (vids) parts.push(vids > 1 ? `[视频消息×${vids}]` : '[视频消息]');

  for (const f of atts.filter((a) => a?.type === 'file')) {
    parts.push(`[文件消息: ${f?.filename || '未命名'}]`);
  }

  return parts.join(' ') || '(空)';
}

/**
 * 把插件启用配置翻译成过滤函数。
 *   all     → 全部
 *   include → 只留名单内的
 *   exclude → 去掉名单内的
 */
export function pluginFilterOf(spec) {
  const mode = spec?.mode ?? 'include';
  const list = new Set(spec?.list ?? []);
  if (mode === 'all') return () => true;
  if (mode === 'exclude') return (id) => !list.has(id);
  return (id) => list.has(id); // include
}

/**
 * 这个会话里能不能用某个插件（分群开关）。
 *
 * 全局配置 `plugins.mode/list` 决定**加载**哪些插件——那是进程级的，
 * 装了就是装了。但一个机器人常在好几个群里，有的群想要骰子、有的群嫌吵，
 * 所以再加一层**按会话的覆盖**：
 *
 *   cfg.plugins.groups = {
 *     "<群 openid>": { mode: "include", list: ["dice", "kun"] }
 *   }
 *
 * 语义：配了的会话用自己那份，没配的跟着全局走。
 * 面板上「恢复跟随全局」= 把这个键删掉。
 *
 * 键是 `chatId`，群聊就是群 openid，私聊是用户 openid——同一套逻辑。
 *
 * 内核命令（pluginId = `__core`）永远放行：否则群里连 /help 都没了，
 * 用户还没法用面板，等于把自己锁在门外。
 *
 * @param {object} spec   cfg.plugins
 * @param {string} chatId 会话 id
 * @param {string} pluginId 插件 id
 * @returns {boolean}
 */
export function pluginAllowedIn(spec, chatId, pluginId) {
  if (!pluginId || pluginId === '__core') return true;
  const own = spec?.groups?.[chatId];
  if (!own) return true; // 这个会话没单独配，跟着全局
  const mode = own.mode ?? 'include';
  const list = new Set(own.list ?? []);
  if (mode === 'all') return true;
  if (mode === 'exclude') return !list.has(pluginId);
  return list.has(pluginId); // include
}
