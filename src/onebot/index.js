/**
 * OneBot v11 兼容层（对外协议，后端仍是官方接口）
 * ==============================================
 *
 * 生命周期：
 *
 *   runtime.start() ──> bridge.start()
 *                          ├─ 缺 ws 依赖 → state='missing-deps'，不监听（不抛）
 *                          ├─ 没开开关   → state='disabled'
 *                          └─ 正常       → 监听、推送事件、接 action
 *
 * 和内核的接口只有三个：
 *   `onMessage(msg)`      每条入站消息（含全量群消息）
 *   `onEvent(name, d)`    非消息事件（入群、加好友…）
 *   `exclusive`           告诉 bot.js「这条别进插件管线了」
 *
 * 事件只推给客户端，**不参与插件管线**（exclusive 模式）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, DIRS } from '../paths.js';
import { createLogger } from '../logger.js';
import * as deps from './deps.js';
import { OneBotIds } from './ids.js';
import { createActions } from './actions.js';
import { buildCapability, summarize } from './capability.js';
import { createOneBotServer } from './ws-server.js';
import { toMessageEvent, toNotice, lifecycleEvent, heartbeatEvent } from './translate.js';

const log = createLogger('onebot');

/** 自动分配端口的基准与范围：6700–6799 */
const PORT_BASE = 6700;
const PORT_SPAN = 100;
/** 端口被占时最多顺延几次 */
const PORT_TRIES = 20;
/** 心跳间隔（与 translate 里的 interval 一致） */
const HEARTBEAT_MS = 25_000;

/** botId → 稳定端口（加一只鸟不会让别的鸟换端口） */
function portOf(botId) {
  const h = crypto.createHash('sha1').update(String(botId)).digest();
  return PORT_BASE + (h.readUInt16BE(0) % PORT_SPAN);
}

export class OneBotBridge {
  /**
   * @param {object} p
   * @param {object} p.runtime BotRuntime
   * @param {object} p.cfg     该机器人的 `onebot` 配置
   * @param {string} p.botId
   * @param {object} p.identity IdentityStore
   */
  constructor({ runtime, cfg, botId, identity }) {
    this.runtime = runtime;
    this.cfg = cfg ?? {};
    this.botId = botId;
    this.identity = identity;
    this.ids = null;
    this.server = null;
    this.actions = null;
    this.heartbeat = null;
    this.state = 'stopped';
    this.error = '';
    this.port = 0;
    this.lastEventAt = 0;
    this.counters = { ok: 0, fail: 0 };
    this.selfUin = 0;
    this.selfOpenid = '';
    this.silkOk = false;
    /** chatId(openid) → {msgId, at}：被动回复窗口用 */
    this.lastInbound = new Map();
    this.pkgVersion = '';
    /** start/stop 串行化：连点两次「保存」不能起两个监听 */
    this.chain = Promise.resolve();
  }

  /**
   * 串行执行：所有 start / stop / reconfigure 排队。
   *
   * 不做这一步的后果很具体：面板连点保存 → 两次 reconfigure 并发 →
   * 两个 `start()` 各自 `stop()` 再监听，后一个撞 EADDRINUSE 顺延到 6701
   * 并覆盖 `this.server`，**旧监听没人关**、心跳 interval 也漏一个。
   * 表现是「端口漂移 + 客户端连不上 + 关不掉」。
   */
  #enqueue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  start() {
    return this.#enqueue(() => this.#startNow());
  }

  stop() {
    return this.#enqueue(() => this.#stopNow());
  }

  /** 配置热更新：先停再起（端口/开关都可能变） */
  reconfigure(next) {
    this.cfg = next ?? {};
    return this.#enqueue(() => this.#startNow());
  }

  /** bot.js 用它决定「这条消息还要不要进插件管线」 */
  get exclusive() {
    return Boolean(this.cfg.enabled) && this.cfg.mode === 'exclusive' && this.state === 'running';
  }

  async #version() {
    if (this.pkgVersion) return this.pkgVersion;
    try {
      const p = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
      this.pkgVersion = String(p.version ?? '');
    } catch {
      this.pkgVersion = '';
    }
    return this.pkgVersion;
  }

  /** 已装且可用？不可用返回原因 */
  async #requireWs() {
    const st = await deps.status();
    if (!st.packages.ws?.resolvable) return '缺依赖 ws';
    return '';
  }

  async #startNow() {
    await this.#stopNow();
    this.error = '';

    if (!this.cfg.enabled) {
      this.state = 'disabled';
      return this;
    }

    const missing = await this.#requireWs();
    if (missing) {
      this.state = 'missing-deps';
      this.error = `${missing}：到面板「兼容」页点『一键安装 ws』`;
      log.info(`兼容模式未就绪：${this.error}`);
      return this;
    }

    this.selfUin = Number(this.cfg.selfUin) || 0;
    if (!this.selfUin) {
      this.state = 'error';
      this.error = '没填机器人 QQ 号（selfUin）';
      return this;
    }
    /**
     * 没 token 不监听。`ws-server` 里空 token 是「不校验」，
     * 在这里拦一道，免得配置被手改成空串就变成一个人人可连的后门。
     */
    if (!String(this.cfg.token ?? '').trim()) {
      this.state = 'error';
      this.error = '没设 access token（面板「兼容」页点『生成』）';
      return this;
    }
    this.selfOpenid = this.identity?.openidOf?.(this.botId, String(this.selfUin)) ?? '';

    this.ids = new OneBotIds({
      file: path.join(DIRS.data, 'bots', this.botId, 'onebot-ids.json'),
      botId: this.botId,
      identity: this.identity,
    });
    await this.ids.load();
    await this.#version();

    // 依赖装好才加载：`ws` 在 `data/deps/onebot/node_modules`，ESM 静态 import 找不到它
    const wsMod = await deps.load('ws');
    if (!wsMod?.WebSocketServer) {
      this.state = 'missing-deps';
      this.error = 'ws 加载失败（面板「兼容」页可重装）';
      return this;
    }
    const depState = await deps.status();
    const silkOk = Boolean(depState.packages['silk-wasm']?.resolvable);
    const silkMod = silkOk ? await deps.load('silk-wasm') : null;
    this.silkOk = Boolean(silkMod);

    this.actions = createActions({
      /**
       * **传真的 runtime，不要 `{...runtime}`**。
       *
       * `online` / `groupName()` 都在原型上，展开会丢掉——表现是
       * 「永远判定离线」「群名永远是空」，而且不会报错。
       */
      runtime: this.runtime,
      version: this.pkgVersion,
      ids: this.ids,
      selfUin: this.selfUin,
      botName: this.runtime.cfg?.name ?? '',
      getPassive: (chatId) => this.#passive(chatId),
      emit: (evt) => this.server?.broadcast(evt),
      // `voice: 'reject'` 是「装了也不发」，面板上那个开关得真生效
      silkReady: () => Boolean(silkMod) && this.cfg.voice !== 'reject',
      silk: silkMod,
      historyLimit: Math.min(Math.max(Number(this.cfg.historyCache) || 0, 0), 200),
    });

    const wanted = Number(this.cfg.port) || portOf(this.botId);
    let lastErr = null;
    for (let i = 0; i < PORT_TRIES; i++) {
      const p = wanted + i;
      const srv = createOneBotServer({
        host: this.cfg.host || '127.0.0.1',
        port: p,
        token: String(this.cfg.token ?? ''),
        http: this.cfg.http !== false,
        ws: wsMod,
        maxConnections: Number(this.cfg.maxConnections) || 4,
        onAction: async (action, params) => {
          try {
            const r = await this.actions(action, params);
            this.counters.ok += 1;
            return r;
          } catch (e) {
            this.counters.fail += 1;
            throw e;
          }
        },
        onConnect: (ws) => {
          try {
            ws.send(JSON.stringify(lifecycleEvent(this.selfUin, 'connect')));
          } catch {
            // 连接刚断，忽略
          }
        },
      });
      try {
        this.port = await srv.start();
        this.server = srv;
        break;
      } catch (e) {
        lastErr = e;
        await srv.stop().catch(() => {});
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
    this.heartbeat = setInterval(() => {
      if (!this.server) return;
      this.server.broadcast(heartbeatEvent(this.selfUin, HEARTBEAT_MS));
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();

    log.info(
      `兼容模式已监听 ${this.cfg.host || '127.0.0.1'}:${this.port}` +
        `（${this.cfg.mode}${this.cfg.http !== false ? ' + HTTP' : ''}）`,
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
    if (this.ids) await this.ids.flush().catch(() => {});
    if (this.state === 'running') this.state = 'stopped';
    // 端口已经没了，别再让面板显示一个「正在监听」的数字
    this.port = 0;
    return this;
  }

  /** 被动回复窗口：取该会话最近一条入站消息（窗口与次数由 outbound 判，这里只给数据） */
  #passive(chatId) {
    const hit = this.lastInbound.get(chatId);
    if (!hit) return null;
    return { msgId: hit.msgId, at: hit.at };
  }

  /** 这条消息是不是机器人自己发的（全量模式下平台可能回推） */
  #isSelf(msg) {
    if (this.selfOpenid && msg.userId === this.selfOpenid) return true;
    // 认不出自己时保守一点：过滤所有 bot，避免自激循环
    if (!this.selfOpenid && msg.raw?.author?.bot === true) return true;
    return false;
  }

  /** bot.js 在每条入站消息上调用 */
  onMessage(msg) {
    if (this.state !== 'running' || !this.ids) return;
    if (!msg?.chatId) return;
    if (this.#isSelf(msg)) return;
    // 全量模式下 `forwardAll=false` 只推「跟机器人有关」的
    if (this.cfg.forwardAll === false && !msg.addressed) return;
    /**
     * `unboundPolicy: 'block'`：没绑 QQ 号的人/群直接不推。
     *
     * 默认是 `warn`（给合成号 + 面板告警），因为「路人说话」不该凭空消失；
     * `block` 是给强一致场景的选项——宁可客户端看不见，也不要看到一串
     * 永远对不上真人的 13 位号。
     */
    if (this.cfg.unboundPolicy === 'block') {
      const uin = this.identity?.uinOf?.(msg.userId) ?? '';
      const guin = msg.kind === 'group' ? (this.identity?.groupUinOf?.(msg.groupId) ?? '') : 'x';
      if (!uin || !guin) return;
    }

    this.lastInbound.set(msg.chatId, { msgId: msg.id, at: msg.receivedAt || Date.now() });
    if (this.lastInbound.size > 500) {
      const first = this.lastInbound.keys().next().value;
      this.lastInbound.delete(first);
    }

    try {
      const evt = toMessageEvent({ msg, ids: this.ids, selfUin: this.selfUin });
      this.server?.broadcast(evt);
      this.lastEventAt = Date.now();
    } catch (e) {
      log.warn(`事件翻译失败（已跳过）：${e.message}`);
    }
  }

  /** bot.js 在非消息事件上调用 */
  onEvent(eventName, d) {
    if (this.state !== 'running' || !this.ids) return;
    try {
      const evt = toNotice(eventName, d, { ids: this.ids, selfUin: this.selfUin });
      if (!evt) return;
      this.server?.broadcast(evt);
      this.lastEventAt = Date.now();
    } catch (e) {
      log.warn(`通知翻译失败（${eventName}）：${e.message}`);
    }
  }

  /** 面板用：能力表（支持 / 降级 / 不支持 + 原因） */
  capability() {
    const list = buildCapability({
      implemented: this.actions?.names ?? [],
      hasSilk: this.silkOk,
    });
    return { list, summary: summarize(list) };
  }

  /** 面板用 */
  snapshot() {
    return {
      state: this.state,
      error: this.error,
      host: this.cfg.host || '127.0.0.1',
      port: this.port || 0,
      connections: this.server?.connections ?? 0,
      lastEventAt: this.lastEventAt,
      actions: { ...this.counters },
      ids: this.ids?.stats?.() ?? { synthUsers: 0, synthGroups: 0, msgs: 0 },
      selfOpenidBound: Boolean(this.selfOpenid),
      exclusive: this.exclusive,
      /** 机器人本体有没有上线：没上线时客户端能连上但发不出去，必须显式告诉面板 */
      online: Boolean(this.runtime.online),
      botError: String(this.runtime.lastError ?? ''),
    };
  }
}
