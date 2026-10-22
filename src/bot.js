import { createLogger, attachLogFile } from './logger.js';
import { TokenManager } from './token.js';
import { QQApi } from './api.js';
import { Gateway } from './gateway.js';
import { Registry } from './plugin/context.js';
import { PluginManager } from './plugin/loader.js';
import { GroupStore } from './groups.js';
import { RoleStore, LEVEL, NO_PERM, levelName, parseLevel, parseScope, scopeOf } from './roles.js';
import { Outbound } from './outbound.js';
import { SessionManager } from './session.js';
import { createDefaultPipeline } from './pipeline.js';
import { buildMessage, isMessageEvent } from './message.js';
import { EVENTS, isKnownEvent } from './events.js';
import { runtime as globalRuntime } from './runtime.js';
import { claimInstance, releaseInstance } from './instance.js';
import { botPaths, DIRS, rel } from './paths.js';

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
   * @param {(runtime:BotRuntime)=>void} [p.registerCore] 注册内核命令的回调
   * @param {()=>object} [p.makeMockApi] mock 模式下造 API 的函数
   */
  constructor({ cfg, globalCfg, mock = false, registerCore = null, makeMockApi = null }) {
    this.cfg = cfg;
    this.globalCfg = globalCfg;
    this.mock = mock;
    this.id = cfg.id;
    this.name = cfg.name || cfg.id;
    this.paths = botPaths(this.id);
    this.log = createLogger(`bot:${this.id}`);

    this.registerCore = registerCore;
    this.makeMockApi = makeMockApi;

    this.claim = { code: '' };
    this.tokens = null;
    this.api = null;
    this.gateway = null;
    this.registry = new Registry();
    this.groups = new GroupStore(this.paths.groups);
    this.roles = new RoleStore(this.paths.roles);
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
      botName: this.mock ? `${this.name}（mock）` : globalRuntime.botName,
      counters: { ...globalRuntime.counters },
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
      this.api = new QQApi({ tokenManager: this.tokens, baseUrl: cfg.baseUrl });
    }

    this.outbound = new Outbound({
      api: this.api,
      cfg,
      isOnline: () => this.mock || this.online,
      quotaFile: this.paths.quota,
    });

    this.session = new SessionManager({
      stickyMs: Math.max(0, (cfg.session?.stickySec ?? 180) * 1000),
      waitTimeoutMs: Math.max(1000, (cfg.session?.promptTimeoutSec ?? 120) * 1000),
    });

    this.pipeline = createDefaultPipeline(cfg, {
      isSticky: (chatId) => this.session.isSticky(chatId),
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
      isOwner: (uid) => cfg.owners.includes(uid),
    });

    if (this.registerCore) {
      this.registerCore(this);
    }

    // 按配置过滤要加载的插件
    await this.plugins.scan({ filter: pluginFilterOf(cfg.plugins) });
  }

  /* ---------------- 启动 / 停止 ---------------- */

  async start() {
    const { cfg } = this;
    this.state = 'starting';
    this.startedAt = Date.now();

    if (!this.mock) {
      if (!cfg.appId || !cfg.appSecret) {
        this.state = 'error';
        this.lastError = '缺少 AppID / AppSecret';
        this.log.error(this.lastError);
        return;
      }

      // 同一个 AppID 不能有两个实例连网关
      const claimed = await claimInstance({ appId: cfg.appId });
      if (!claimed.ok) {
        this.state = 'error';
        this.lastError = `AppID ${cfg.appId} 已有实例在运行（PID ${claimed.conflict.pid}）`;
        this.log.error(this.lastError);
        return;
      }

      this.gateway = new Gateway({
        api: this.api,
        tokens: this.tokens,
        intents: cfg.intents,
        onDispatch: (event, d, p) => this.dispatch(event, d, p),
      });

      try {
        await this.gateway.start();
        this.state = 'online';
      } catch (e) {
        this.state = 'error';
        this.lastError = e.message;
        this.log.error(`连接失败: ${e.message}`);
      }
      return;
    }

    // mock 模式：不连网关，直接算在线
    this.state = 'online';
    this.log.info('mock 模式已就绪');
  }

  async stop() {
    try {
      this.gateway?.stop();
    } catch {}
    this.session?.clear();
    await this.plugins?.shutdown().catch(() => {});
    await this.outbound?.flush().catch(() => {});
    await this.groups?.flush().catch(() => {});
    await this.roles?.flush().catch(() => {});
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

    globalRuntime.lastEventAt = Date.now();
    globalRuntime.messageEvent = eventName;
    globalRuntime.bumpEvent(eventName);

    /* ---- 非消息事件 ---- */
    if (!isMessageEvent(eventName)) {
      if (!isKnownEvent(eventName)) {
        this.log.warn(`收到未登记的事件 ${eventName}，已转交插件。建议在 src/events.js 补登记`);
      }

      if (eventName === 'GROUP_ADD_ROBOT') {
        const gid = d?.group_openid;
        const inviter = d?.op_member_openid || '';
        await groups.onAdded(gid, inviter);
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

      const meta = EVENTS[eventName] ?? null;
      for (const l of registry.listeners.get(eventName) ?? []) {
        try {
          await l.handler(d, {
            event: eventName,
            intent: meta?.intent ?? null,
            desc: meta?.desc ?? '',
            api: this.api,
            bot: this,
          });
        } catch (e) {
          globalRuntime.bump('errors');
          this.log.error(`监听器 ${l.pluginId} 处理 ${eventName} 出错:`, e.stack || e.message);
        }
      }
      return;
    }

    /* ---- 消息事件 ---- */
    const msg = buildMessage(eventName, d, { api: this.api, cfg, outbound, session });
    try {
      globalRuntime.bump('recv');
      globalRuntime.touchChat(msg.chatId, msg.kind);
      if (msg.kind === 'group' && msg.groupId) await groups.touch(msg.groupId);

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

      if (msg.isCommand && commandEntry) {
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
        globalRuntime.bump('commands');
        try {
          await commandEntry.handler(msg, { args: msg.args, raw: msg.content, bot: this });
        } catch (e) {
          globalRuntime.bump('errors');
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
        for (const l of registry.listeners.get(evt) ?? []) {
          try {
            const ret = await l.handler(msg);
            if (ret === true || msg.replied) handled = true;
          } catch (e) {
            globalRuntime.bump('errors');
            this.log.error(`监听器 ${l.pluginId} 处理 ${evt} 出错:`, e.stack || e.message);
          }
        }
      }
      if (!handled) globalRuntime.bump('ignored');
    } finally {
      // 本次处理里所有插件攒下的回复，合并成一条发出去
      await msg.flushReplies?.();
    }
  }

  logIncoming(msg) {
    const ml = this.cfg.messageLog ?? {};
    if (ml.enabled === false) return;
    if ((ml.muteKinds ?? []).includes(msg.kind)) return;
    const content = msg.content.length > 120 ? msg.content.slice(0, 120) + '…' : msg.content;
    const who = msg.userName
      ? `${msg.userName}(${msg.userId.slice(0, 8)})`
      : msg.userId.slice(0, 8) || '-';
    const where = msg.groupId ? msg.groupId.slice(0, 10) : '-';
    this.log.info(`收到 ${msg.kind} 会话:${where} 来自:${who} 内容:${content || '(空)'}`);
  }
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
