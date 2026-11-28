/**
 * 宿主协议 v1：框架侧桥接
 * ========================
 *
 * 挂在每只鸟上（`runtime.host`），一只鸟一个端口。
 * 生命周期与 `OneBotBridge` 同构：只构造不启动，等 api / plugins / identity
 * 都就绪再 `start()`；任何失败都只是「这一层不可用」，**不影响机器人本体**。
 *
 * 与内核的接口：
 *   onMessage(msg)         每条入站消息（原生结构，不翻译）
 *   onEvent(name, d)       非消息事件
 *   snapshot()/capability() 面板用
 *
 * **`ws` 是可选依赖**：协议有两条等价通道——`GET /ws`（双向帧）和
 * `GET /events`（SSE，只推）+ `POST /rpc`。只读 SSE 的客户端（例如
 * dsh-roost，它坚持零依赖、用 Node 自带 fetch 读 SSE）**完全不需要 ws**。
 * 所以缺 ws 时照样监听，只是不开 `/ws`；`snapshot().transports` 会如实说明。
 * 用户从 tar 包升级、没跑过 npm install 也不会因此起不来。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../paths.js';
import { createLogger } from '../logger.js';
import * as deps from '../ext-deps.js';
import { createHostServer } from './server.js';
import { createMethods, effectiveScopes, HostError, HOST_PROTOCOL } from './methods.js';
import { createExtBridge } from './ext-bridge.js';
import { serializeMessage, serializeNotice } from './serialize.js';

const log = createLogger('host');

/**
 * rpc 失败的统一序列化。
 *
 * 抽成纯函数是为了能单测：这里出过一次真事故——`api.js` 把官方业务码放在
 * `err.qqCode` 上（11253 没权限 / 503004 发帖太频 / 304018 没连上网关），
 * 而这里只序列化 `code` + `message`，**业务码在跨进程那一步被丢掉**。
 * 后果是宿主只能看到「HTTP 400 PUT …: 中文描述」，没法区分「去开放平台勾权限」
 * 和「等十分钟再发」，只能把原文甩给用户。
 *
 * 没有业务码时**不加这个字段**：老客户端读到 undefined 等同于「没有」。
 *
 * @param {Error & { code?: string, http?: number, qqCode?: number }} e
 * @returns {{ code: string, http: number, error: { code: string, message: string, qqCode?: number } }}
 */
export function serializeRpcError(e) {
  const code = e instanceof HostError ? e.code : 'INTERNAL';
  const http = Number(e?.http) || (code === 'NO_SCOPE' ? 403 : code === 'NOT_FOUND' ? 404
    : code === 'NOT_READY' ? 503 : code === 'INTERNAL' ? 500 : 400);
  const qqCode = Number(e?.qqCode);
  return {
    code,
    http,
    error: {
      code,
      message: String(e?.message ?? e),
      ...(Number.isFinite(qqCode) && qqCode > 0 ? { qqCode } : {}),
    },
  };
}

/**
 * 与 OneBot 的 6700–6799 分开，方便面板上两个出口各写各的端口。
 *
 * 但 Windows 开了 Hyper-V / WSL 后常把 6501–7100 整段列为保留端口，
 * 6800–6899 会整段 bind 失败，报的是 EACCES 而不是 EADDRINUSE。
 * 所以自动端口在某段全失败时退到备用段；显式端口仍只在附近顺延，
 * 不跨到备用段（跨段才会让对端彻底找不到）。
 */
const PORT_BASE = 6800;
const PORT_SPAN = 100;
const PORT_TRIES = 20;
const FALLBACK_BASE = 18300;
const HEARTBEAT_MS = 25_000;

/** 只有这两种 bind 错误值得换端口再试；别的错误换端口也没用 */
const BIND_RETRY_CODES = new Set(['EADDRINUSE', 'EACCES']);

export function shouldRetryBind(e) {
  return BIND_RETRY_CODES.has(String(e?.code ?? ''));
}

/** EACCES 必须说人话：让用户去「依赖」卡找不存在的依赖是最糟的提示 */
export function describeBindError(e, port) {
  const code = String(e?.code ?? '');
  if (code === 'EACCES') {
    return `端口 ${port} 被系统保留或没有权限监听（Windows 开了 Hyper-V / WSL 时常见），请到「外接」换一个端口`;
  }
  if (code === 'EADDRINUSE') return `端口 ${port} 被占用，顺延后仍起不来`;
  return `端口 ${port} 起不来：${e?.message ?? '未知原因'}`;
}

function portOf(botId) {
  const h = crypto.createHash('sha1').update(String(botId)).digest();
  return PORT_BASE + (h.readUInt16BE(0) % PORT_SPAN);
}

/** 自动端口先按原公式试，整段不可用时才退到备用段；显式端口只试自己那一段 */
function* candidatePorts(wanted, auto) {
  for (let i = 0; i < PORT_TRIES; i++) yield wanted + i;
  if (auto) for (let i = 0; i < PORT_TRIES; i++) yield FALLBACK_BASE + i;
}

export class HostBridge {
  /**
   * @param {object} p
   * @param {object} p.runtime BotRuntime
   * @param {object} p.cfg     该机器人的 `host` 配置
   * @param {string} p.botId
   * @param {Function} [p.createServer] 可注入的监听工厂，只为把端口失败路径钉进单测
   */
  constructor({ runtime, cfg, botId, createServer = createHostServer }) {
    this.runtime = runtime;
    this.cfg = cfg ?? {};
    this.botId = botId;
    this.createServer = createServer;
    this.server = null;
    this.methods = null;
    this.state = 'stopped';
    this.error = '';
    this.port = 0;
    this.version = '';
    this.seq = 0;
    this.buffer = [];
    this.lastEventAt = 0;
    this.startedAt = 0;
    this.counters = { ok: 0, fail: 0 };
    this.scopes = effectiveScopes(this.cfg);
    /**
     * 方法表构造时就建好，不放在 #startNow 里。
     * 面板在协议「未开启」时也要能看到完整能力清单，否则用户得先开监听
     * 才知道这个协议能干什么；createMethods 只捕获 runtime 引用，
     * 里面的 R.api / R.plugins 都是调用时现读，早建不会拿到过期对象。
     */
    /**
     * 外接客户端注册过来的命令装在伪插件上（宿主本体 `__<自报名>`、扩展 `__ext:<id>`）。
     * 记下来是为了重注册 / 断线时整组摘掉——命令表是全局命名空间，
     * 留一条僵尸命令就会一直抢别人的同名命令。
     */
    this.extCommandPlugins = new Set();
    /**
     * 反向调用桥：框架插件调 DSH 扩展。事件走协议自己的 SSE 流，
     * 回执走 RPC，所以不新开监听、不给 DSH 发第二套令牌。
     *
     * `installCommands` 让客户端上报的聊天命令真进 registry（1.2.0 起）；
     * 桥自己保持纯逻辑，不 import Registry，好单测。
     */
    this.extBridge = createExtBridge({
      pushEvent: (event, data) => this.#push(event, data),
      log: (m) => log.info(`[ext-bridge] ${m}`),
      installCommands: (list) => this.#installExtCommands(list),
    });
    this.methods = createMethods({
      runtime: this.runtime,
      getState: () => this.#state(),
      log: (m) => log.info(m),
      extBridge: this.extBridge,
    });
    /** 插件工具集签名：变了就往事件流推一条 capabilities.changed */
    this.toolSig = this.methods?.toolSignature?.() ?? '';
    this.heartbeat = null;
    /** start/stop/reconfigure 串行化：面板连点保存不能起两个监听 */
    this.chain = Promise.resolve();
  }

  #enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * 把外接客户端上报的命令装进 registry。
   *
   * 每次调用都是「整组重建」：先按伪插件 id 清空，再按清单重装。这样扩展
   * 卸载、改命令名、断线都不会留下僵尸命令；也天然幂等（DSH 重连会重复上报）。
   *
   * @returns {Array<{name:string, plugin?:string, reason:string}>} 重名被拒的条目
   */
  #installExtCommands(list) {
    const registry = this.runtime?.registry;
    if (!registry) return [];
    for (const pid of this.extCommandPlugins) registry.clearPlugin(pid);
    this.extCommandPlugins.clear();

    const rejected = [];
    const prefix = String(this.runtime?.cfg?.commandPrefix ?? '/');
    for (const c of Array.isArray(list) ? list : []) {
      /**
       * 客户端写的 usage 是按它自己以为的前缀拼的（多半是 `/`）。本框架改了
       * 前缀时这里跟着换，否则菜单里显示 `/model`、实际要发 `!model`。
       */
      const rawUsage = c.usage || `${prefix}${c.name}`;
      const usage = prefix === '/' ? rawUsage : rawUsage.replace(/^\//, prefix);
      const meta = {
        desc: c.desc,
        usage,
        pattern: c.name,
        admin: c.admin,
        globalAdmin: c.globalAdmin,
        ownerOnly: c.ownerOnly,
        /** 客户端可以要求「能直呼但不进菜单」，与插件命令的 hidden 同义 */
        hidden: c.hidden,
        plugin: c.pluginName,
        pluginId: c.pluginId,
        /** 宿主命令进「指令」组，扩展命令单独一组，免得把内核菜单挤乱 */
        section: c.target === 'host' ? '指令' : '扩展',
      };
      const handler = (msg) => this.#runExtCommand(c, msg);
      /** 别名单独注册成隐藏命令：菜单里只显示主名，名字仍可直呼 */
      for (const name of [c.name, ...c.aliases]) {
        try {
          registry.addCommand(c.pluginId, name, name === c.name ? meta : { ...meta, hidden: true }, handler);
        } catch (e) {
          rejected.push({ name, plugin: c.pluginName, reason: String(e?.message ?? e).slice(0, 120) });
        }
      }
      this.extCommandPlugins.add(c.pluginId);
    }
    if (rejected.length) {
      log.warn(
        `外接命令有 ${rejected.length} 条没装上：${rejected.map((r) => `${r.name}（${r.reason}）`).join('；')}`,
      );
    }
    return rejected;
  }

  /**
   * 命令命中：转发给外接客户端，等它回执。
   *
   * 回执带 `reply` 就由框架发（`msg.reply` 自带引用与限频），不带说明客户端
   * 自己发过了。失败一律回一句人话——群里「发了命令没反应」比报错更难查。
   */
  async #runExtCommand(c, msg) {
    const payload = serializeMessage(msg, {
      groupName: this.runtime?.groupNames?.get?.(msg.groupId)?.name ?? '',
    });
    try {
      const r = await this.extBridge.command({ target: c.target, extId: c.extId, name: c.name, msg: payload });
      const text = String(r?.reply ?? '').trim();
      if (text) await msg.reply(text);
    } catch (e) {
      log.warn(`外接命令 /${c.name} 失败：${e?.message ?? e}`);
      await msg.reply(`「${c.pluginName}」没接住这个命令：${e?.message ?? e}`).catch(() => {});
    }
  }

  start() {
    return this.#enqueue(() => this.#startNow());
  }

  stop() {
    return this.#enqueue(() => this.#stopNow());
  }

  /** 配置热更新：先停再起（端口 / 开关 / scope 都可能变） */
  reconfigure(next) {
    this.cfg = next ?? {};
    this.scopes = effectiveScopes(this.cfg);
    return this.#enqueue(() => this.#startNow());
  }

  async #version() {
    if (this.version) return this.version;
    try {
      const p = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
      this.version = String(p.version ?? '');
    } catch {
      this.version = '';
    }
    return this.version;
  }

  async #startNow() {
    await this.#stopNow();
    this.error = '';
    /** 每轮重置：上一轮有 ws 不代表这一轮还加载得到 */
    this.wsMissing = true;
    this.scopes = effectiveScopes(this.cfg);

    if (!this.cfg.enabled) {
      this.state = 'disabled';
      return this;
    }

    /**
     * `ws` 是**可选**依赖（和 OneBot 兼容层共用同一份按需安装）。
     * 缺了不影响 HTTP / SSE 通道，只是没有 `/ws`——所以这里不拦启动。
     */
    /** 空 token 拒绝监听：不监听比「不校验」安全得多 */
    if (!String(this.cfg.token ?? '').trim()) {
      this.state = 'error';
      this.error = '没设 access token（面板「外接」页点『生成』）';
      return this;
    }

    const listenHost = String(this.cfg.host || '127.0.0.1');
    const loop = ['127.0.0.1', 'localhost', '::1'].includes(listenHost.toLowerCase());
    if (!loop && !this.cfg.allowRemote) {
      this.state = 'error';
      this.error = `监听 ${listenHost} 会把能管理框架的接口摆到局域网上，请显式打开 allowRemote`;
      return this;
    }

    /**
     * `deps.load('ws')` 内部吞错返回 null（不抛），所以以前的 try/catch 是死代码，
     * 缺 ws 时一行日志都没有。现在 load() 自己会 warn，这里读它的失败原因，
     * 让面板能显示「为什么 WS 没起来」。
     */
    const m = await deps.load('ws');
    const wsMod = m?.WebSocketServer ? m : null;
    /** 没 ws 也要记住原因，面板据此显示「只有 SSE」而不是「坏了」 */
    this.wsMissing = !wsMod;
    /** 顺序要对：先定 wsMissing，再据此取加载失败原因（否则恒为空） */
    this.wsLoadError = this.wsMissing ? deps.loadError('ws') : '';

    await this.#version();
    /** 端口写在构造参数里，被占只能重建实例；每次只建一个，别让失败的实例堆着计时器 */
    const make = (p) => this.createServer({
      host: listenHost,
      port: p,
      token: String(this.cfg.token ?? ''),
      ws: wsMod,
      maxConnections: Number(this.cfg.maxConnections) || 4,
      attach: (_sink, info) => this.#attach(info),
      onRpc: (frame, ctx) => this.#rpc(frame, ctx),
      health: () => ({
        state: this.state,
        connections: this.server?.connections ?? 0,
        seq: this.seq,
      }),
    });

    const wanted = Number(this.cfg.port) || portOf(this.botId);
    const auto = !Number(this.cfg.port);
    let lastErr = null;
    let lastPort = wanted;
    for (const p of candidatePorts(wanted, auto)) {
      lastPort = p;
      const attempt = make(p);
      try {
        this.port = await attempt.start();
        this.server = attempt;
        break;
      } catch (e) {
        lastErr = e;
        await attempt.stop().catch(() => {});
        if (!shouldRetryBind(e)) break;
      }
    }

    if (!this.server) {
      this.state = 'error';
      this.error = describeBindError(lastErr, lastPort);
      log.error(this.error);
      return this;
    }

    this.state = 'running';
    this.startedAt = Date.now();
    /**
     * 缺 ws 时服务确实在跑（HTTP + SSE），不能报 error 状态；但也不能
     * error='' 装作一切正常——把「WS 未启用」的原因摆出来，面板/接口可见。
     */
    if (this.wsMissing) {
      this.error = `WS 通道未启用（仅 HTTP + SSE）：${this.wsLoadError || '缺 ws 依赖，请到面板「外接 → 依赖」一键安装'}`;
    }
    this.heartbeat = setInterval(() => {
      /** 不进缓冲、不增 seq：它只是保活，重连补拉不该把它算成事件 */
      this.server?.broadcast({ type: 'heartbeat', at: Date.now(), seq: this.seq });
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();

    log.info(
      `宿主协议已监听 ${listenHost}:${this.port}` +
        `（roost-host/1，scope: ${[...this.scopes].join('+')}）`,
    );
    return this;
  }

  async #stopNow() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.server) {
      await this.server.stop().catch((e) => log.warn(`关监听失败：${e.message}`));
      this.server = null;
    }
    /** 监听关了就没人能回执了，把还在等的扩展调用全部解掉，别挂死插件 */
    this.extBridge?.clear?.('外接协议已停止');
    if (this.state === 'running') this.state = 'stopped';
    this.port = 0;
    return this;
  }

  /* ---------------- 帧 ---------------- */

  #state() {
    return {
      seq: this.seq,
      connections: this.server?.connections ?? 0,
      startedAt: this.startedAt,
      version: this.version,
      counters: { ...this.counters },
    };
  }

  /**
   * 同步生成 welcome + 补拉。必须是同步的：JS 单线程下这一步中间不会插入
   * broadcast，补拉和实时推送才不会重复或漏。
   */
  #attach(info) {
    const since = Number(info?.since) || 0;
    return {
      welcome: {
        protocol: HOST_PROTOCOL,
        app: 'roost-host',
        version: this.version,
        bot: {
          id: this.runtime.id,
          name: this.runtime.name,
          appId: String(this.runtime.cfg?.appId ?? ''),
          state: this.runtime.state,
          online: Boolean(this.runtime.online),
        },
        seq: this.seq,
        scopes: [...this.scopes],
        dynamicTools: true,
        features: this.methods?.names() ?? [],
      },
      frames: this.replaySince(since),
    };
  }

  /**
   * 差太多就明说，不让丢消息变成静默。
   * 不做成 #private：补拉边界（缓冲过期 / 恰好接上）是必须能被测试钉死的契约，
   * 私有方法只能靠「起一个真服务」间接验，太脆。
   */
  replaySince(since) {
    if (!Number.isFinite(since) || since <= 0) return [];
    const oldest = this.buffer.length ? this.buffer[0].seq : this.seq + 1;
    if (since < oldest - 1) {
      return [{
        type: 'gap', since, seq: this.seq, oldest,
        message: '缓冲里已经没有那么早的事件了，请自行重开会话',
      }];
    }
    return this.buffer
      .filter((e) => e.seq > since)
      .map((e) => ({ type: 'event', ...e }));
  }

  /** 统一的 RPC 分发：HTTP /rpc 与 WS req 走同一条路 */
  async #rpc(frame, ctx) {
    const id = frame?.id ?? '';
    try {
      if (this.state !== 'running' || !this.methods) {
        throw new HostError('NOT_READY', '宿主协议还没就绪', 503);
      }
      const data = await this.methods.call(frame.method, frame.params ?? {}, {
        scopes: this.scopes,
        client: ctx?.via ?? '',
      });
      this.counters.ok += 1;
      /**
       * 插件启停 / 热重载会让工具集变化。客户端不该把 `features` 当静态清单：
       * 变了就推一条事件，让它重新拉 `system.capabilities`。
       */
      const sig = this.methods.toolSignature?.() ?? '';
      if (sig !== this.toolSig) {
        this.toolSig = sig;
        this.#push('capabilities.changed', {
          features: this.methods.names(),
          tools: this.methods.describe().filter((m) => m.name.startsWith('tool.')),
        });
      }
      return { id, ok: true, data: data ?? null, http: 200 };
    } catch (e) {
      this.counters.fail += 1;
      const s = serializeRpcError(e);
      return { id, ok: false, http: s.http, error: s.error };
    }
  }

  #push(event, data) {
    const seq = ++this.seq;
    const item = { seq, event, data, at: Date.now() };
    const ttl = Number(this.cfg.historyTtlMs) || 3_600_000;
    const limit = Math.min(Math.max(Number(this.cfg.historyLimit) || 200, 0), 1000);
    const cut = Date.now() - ttl;
    while (this.buffer.length && (this.buffer[0].at < cut || this.buffer.length >= limit)) {
      this.buffer.shift();
    }
    this.buffer.push(item);
    this.server?.broadcast({ type: 'event', ...item });
    this.lastEventAt = item.at;
  }

  /* ---------------- 内核回调 ---------------- */

  onMessage(msg) {
    if (this.state !== 'running' || !msg?.chatId) return;
    /** 全量模式下平台会回推自己发的消息，不滤掉会自激循环 */
    if (msg.raw?.author?.bot === true) return;
    if (this.cfg.forwardAll === false && !msg.addressed) return;
    const groupName = msg.kind === 'group'
      ? (this.runtime.groupNames?.get?.(msg.groupId)?.name ?? '')
      : '';
    const data = serializeMessage(msg, { groupName });
    if (!data) return;
    try {
      this.#push('message', data);
    } catch (e) {
      log.warn(`事件序列化失败（已跳过）：${e.message}`);
    }
  }

  onEvent(eventName, d) {
    if (this.state !== 'running') return;
    try {
      this.#push('notice', serializeNotice(eventName, d));
    } catch (e) {
      log.warn(`通知序列化失败（${eventName}）：${e.message}`);
    }
  }

  /* ---------------- 面板 ---------------- */

  capability() {
    return {
      protocol: HOST_PROTOCOL,
      scopes: [...this.scopes],
      methods: this.methods?.describe() ?? [],
    };
  }

  snapshot() {
    return {
      state: this.state,
      error: this.error,
      /**
       * 实际开出来的通道。`ws:false` 只表示没有双向帧，
       * `/rpc` + `/events` 仍在——客户端不该据此判定「协议不可用」。
       */
      transports: { http: true, sse: true, ws: Boolean(this.wsMissing === false) },
      host: this.cfg.host || '127.0.0.1',
      port: this.port || 0,
      connections: this.server?.connections ?? 0,
      seq: this.seq,
      buffered: this.buffer.length,
      lastEventAt: this.lastEventAt,
      actions: { ...this.counters },
      scopes: [...this.scopes],
      online: Boolean(this.runtime.online),
      mode: 'parallel',
    };
  }
}
