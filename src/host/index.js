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
import * as deps from '../onebot/deps.js';
import { createHostServer } from './server.js';
import { createMethods, effectiveScopes, HostError, HOST_PROTOCOL } from './methods.js';
import { serializeMessage, serializeNotice } from './serialize.js';

const log = createLogger('host');

/** 与 OneBot 的 6700–6799 分开，方便面板上两个出口各写各的端口 */
const PORT_BASE = 6800;
const PORT_SPAN = 100;
const PORT_TRIES = 20;
const HEARTBEAT_MS = 25_000;

function portOf(botId) {
  const h = crypto.createHash('sha1').update(String(botId)).digest();
  return PORT_BASE + (h.readUInt16BE(0) % PORT_SPAN);
}

export class HostBridge {
  /**
   * @param {object} p
   * @param {object} p.runtime BotRuntime
   * @param {object} p.cfg     该机器人的 `host` 配置
   * @param {string} p.botId
   */
  constructor({ runtime, cfg, botId }) {
    this.runtime = runtime;
    this.cfg = cfg ?? {};
    this.botId = botId;
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
    this.methods = createMethods({
      runtime: this.runtime,
      getState: () => this.#state(),
      log: (m) => log.info(m),
    });
    this.heartbeat = null;
    /** start/stop/reconfigure 串行化：面板连点保存不能起两个监听 */
    this.chain = Promise.resolve();
  }

  #enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
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

    let wsMod = null;
    try {
      const m = await deps.load('ws');
      if (m?.WebSocketServer) wsMod = m;
    } catch (e) {
      log.warn(`ws 加载失败，只开 HTTP + SSE：${e.message}`);
    }
    /** 没 ws 也要记住原因，面板据此显示「只有 SSE」而不是「坏了」 */
    this.wsMissing = !wsMod;

    await this.#version();
    /** 端口写在构造参数里，被占只能重建实例；每次只建一个，别让失败的实例堆着计时器 */
    const make = (p) => createHostServer({
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
    let lastErr = null;
    for (let i = 0; i < PORT_TRIES; i++) {
      const p = wanted + i;
      const attempt = make(p);
      try {
        this.port = await attempt.start();
        this.server = attempt;
        break;
      } catch (e) {
        lastErr = e;
        await attempt.stop().catch(() => {});
        if (e?.code !== 'EADDRINUSE') break;
      }
    }

    if (!this.server) {
      this.state = 'error';
      this.error = `端口 ${wanted} 起不来：${lastErr?.message ?? '未知原因'}`;
      log.error(this.error);
      return this;
    }

    this.state = 'running';
    this.startedAt = Date.now();
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
      return { id, ok: true, data: data ?? null, http: 200 };
    } catch (e) {
      this.counters.fail += 1;
      const code = e instanceof HostError ? e.code : 'INTERNAL';
      const http = Number(e?.http) || (code === 'NO_SCOPE' ? 403 : code === 'NOT_FOUND' ? 404
        : code === 'NOT_READY' ? 503 : code === 'INTERNAL' ? 500 : 400);
      return {
        id, ok: false, http,
        error: { code, message: String(e?.message ?? e) },
      };
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
