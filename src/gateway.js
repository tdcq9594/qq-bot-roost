import { createLogger } from './logger.js';
import { BotMetrics } from './runtime.js';

const log = createLogger('gateway');

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

/** 常见的关闭码，直接给出可操作的提示 */
const CLOSE_HINTS = {
  4004: '鉴权失败，检查 AppID / AppSecret 是否正确',
  4010: '连接地址不合法',
  4011: '机器人尚未上线或未开通该能力',
  4012: '版本号不合法',
  4013: 'intents 参数无效，检查 config/bot.json 的 intents',
  4014: 'intents 无权限：到 q.qq.com 管理端申请「群聊」能力，或把 intents 改成 33554432',
  4914: '机器人已下架',
  4915: '机器人已被封禁',
};

/**
 * 这些关闭码重连多少次都没用——是配置/资质问题，得人去改。
 * 撞上就停，并把失败传出去，别让启动流程永远卡住。
 */
const FATAL_CLOSE_CODES = new Set(Object.keys(CLOSE_HINTS).map(Number));

/**
 * WebSocket 网关客户端。
 *
 * 流程（对应官方文档 api-v2 / 事件订阅）：
 *   1. GET /gateway/bot 拿到 wss 地址
 *   2. 连接后服务端下发 op10 Hello（含 heartbeat_interval）
 *   3. 发送 op2 Identify（token="QQBot xxx"）→ 收到 READY（含 session_id）
 *   4. 按周期发 op1 心跳，服务端回 op11
 *   5. 断线后若 session 未失效，发 op6 Resume 补发漏掉的事件
 */
export class Gateway {
  constructor({ api, tokens, intents, onDispatch, shard = [0, 1], metrics = null }) {
    this.api = api;
    this.tokens = tokens;
    this.intents = intents;
    this.shard = shard;
    this.onDispatch = onDispatch;
    // 连接态写进该机器人自己的指标；没传就建个空的兜底，避免 LHS 赋值报错
    this.metrics = metrics ?? new BotMetrics();

    this.ws = null;
    this.sessionId = '';
    this.lastSeq = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.attempt = 0;
    this.stopped = false;
    this.ready = false;
    this.heartbeatInterval = 45000;
    this.lastAckAt = 0;
    this.connecting = false;
    /** 已经为哪条 ws 安排过重连，防止 error + close 双触发建出两条连接 */
    this.retryScheduledFor = null;

    this.readyResolve = null;
    this.readyReject = null;
    /**
     * 撞上「永久性错误」后就别再重连了。
     *
     * 以前对所有 close 码一视同仁：AppSecret 写错（4004）、intents 没权限（4014）
     * 会每 30 秒重连一次，日志刷屏，而 readyPromise 永远不 resolve 也不 reject，
     * 启动流程就卡在 `await gateway.start()` 上——面板和定时任务全都不执行。
     */
    this.fatal = false;
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // 没人 await 时也别变成 unhandledRejection
    this.readyPromise.catch(() => {});
  }

  async start() {
    this.stopped = false;
    this.fatal = false;
    await this.#connect();
    return this.readyPromise;
  }

  /**
   * 供 WebUI 使用：断开后立刻重连。
   * 注意 stop() 会把 stopped 置 true，这里必须重新置 false，否则 #connect 会直接返回。
   */
  async restart() {
    const old = this.ws;
    this.stop(); // stopped=true，此时旧连接的 close 事件会被忽略

    // 等旧连接真正关闭再继续，否则 close 回调会再安排一次重连，建出两条连接
    if (old) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 800);
        try {
          old.addEventListener(
            'close',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    } else {
      await new Promise((r) => setTimeout(r, 300));
    }

    this.stopped = false;
    this.sessionId = '';
    this.lastSeq = null;
    this.lastAckAt = 0;
    this.attempt = 0;
    await this.#connect();
  }

  stop() {
    this.stopped = true;
    this.#clearTimers();
    try {
      this.ws?.close(1000, 'client shutdown');
    } catch {}
    this.ws = null;
    // 还有地方在 await start() 的话，让它能返回，别把关机流程卡死
    this.readyResolve?.(this);
  }

  #clearTimers() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  async #connect() {
    if (this.stopped) return;
    // 防止重连定时器和手动重连撞在一起，建出两条连接
    if (this.connecting) {
      log.debug('已有连接在进行中，跳过本次');
      return;
    }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      log.debug('已有活跃连接，跳过本次');
      return;
    }
    this.connecting = true;
    let url;
    try {
      const gw = await this.api.getGateway();
      url = gw?.url;
      if (!url) throw new Error('网关接口未返回 url');
      this.metrics.gatewayUrl = url;
      log.info(`网关地址: ${url}`);
    } catch (e) {
      this.connecting = false;
      log.error('获取网关地址失败:', e.message);
      return this.#scheduleReconnect();
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    /**
     * 连接超时兜底：握手阶段卡住（网络半开、DNS 慢）时 open / error / close
     * 可能都不来，不设超时就会永远停在「上线中」。
     */
    const connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== 1) {
        log.warn('WebSocket 连接超时（20 秒未建立）');
        this.#failAndRetry(ws, 'connect timeout');
      }
    }, 20000);

    ws.addEventListener('open', () => {
      clearTimeout(connectTimer);
      this.connecting = false;
      log.debug('WebSocket 已连接');
    });

    ws.addEventListener('message', (ev) => {
      let payload;
      try {
        payload = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return log.warn('收到无法解析的下行数据');
      }
      this.#handle(payload).catch((e) => log.error('处理下行消息出错:', e.message));
    });

    ws.addEventListener('error', (ev) => {
      const err = ev?.error;
      const detail = err
        ? [err.code, err.message || err.errno || err.name].filter(Boolean).join(' ')
        : ev?.message || '未知错误';
      /**
       * 握手失败时 Node 的 WebSocket 会**连发两次 error**
       * （"network error or non-101" 和 "closed before established"），
       * 只记第一条，否则日志里每个失败都是双份。
       */
      if (this.retryScheduledFor !== ws) {
        log.warn(`WebSocket 错误: ${detail}`);
      }
      clearTimeout(connectTimer);
      /**
       * 关键：握手失败时**只发 error、不发 close**（Node 内置 WebSocket 的行为）。
       * 不在这里兜底，`connecting` 会永远停在 true，
       * 后续每次重连都被 `#connect` 开头的 guard 挡掉，表现就是「一直上线中」。
       */
      this.#failAndRetry(ws, detail);
    });

    ws.addEventListener('close', (ev) => {
      clearTimeout(connectTimer);
      this.#clearTimers();
      this.ready = false;
      this.connecting = false;
      if (this.ws === ws) this.ws = null;
      this.metrics.connected = false;
      if (this.stopped) return;
      this.metrics.reconnectCount += 1;
      if (ev.code === 4902) {
        // resume 被拒（会话已被别的连接用掉），清掉本地会话，下次走全新鉴权
        this.sessionId = '';
        this.lastSeq = null;
      }
      const hint = CLOSE_HINTS[ev.code];
      log.warn(`WebSocket 关闭 code=${ev.code} reason=${ev.reason || '-'}`);
      if (hint) log.error(`原因: ${hint}`);

      if (FATAL_CLOSE_CODES.has(ev.code)) {
        this.fatal = true;
        const msg = `连接被平台拒绝（code=${ev.code}）${hint ? `：${hint}` : ''}`;
        log.error(`${msg}。这类错误重连没用，已停止重连，请按上面的提示改配置`);
        this.readyReject?.(new Error(msg));
        return;
      }

      this.#scheduleReconnect();
    });
  }

  /**
   * 连接失败后的统一收尾：复位 connecting、丢弃这条 ws、安排重连。
   *
   * 幂等——error 和 close 可能先后都来，靠 `retryScheduledFor` 保证只安排一次，
   * 否则会出现两条连接互相踢（4902）。
   */
  #failAndRetry(ws, why = '') {
    if (this.stopped) return;
    if (this.ws !== ws) return;
    if (this.retryScheduledFor === ws) return;
    this.retryScheduledFor = ws;

    this.connecting = false;
    this.ready = false;
    this.metrics.connected = false;
    this.#clearTimers();
    try {
      ws.close();
    } catch {}
    if (this.ws === ws) this.ws = null;
    if (why) log.debug(`连接失败收尾（${why}）`);
    this.#scheduleReconnect();
  }

  async #handle(p) {
    log.debug(`<< op=${p.op}${p.t ? ' t=' + p.t : ''}${p.s !== undefined ? ' s=' + p.s : ''}`);
    switch (p.op) {
      case OP.HELLO: {
        const interval = p.d?.heartbeat_interval ?? 45000;
        log.debug(`Hello，心跳间隔 ${interval}ms`);
        this.#startHeartbeat(interval);
        if (this.sessionId && this.lastSeq !== null) {
          this.#send({ op: OP.RESUME, d: { token: await this.#authToken(), session_id: this.sessionId, seq: this.lastSeq } });
          log.info('尝试 Resume 恢复会话');
        } else {
          await this.#identify();
        }
        break;
      }
      case OP.HEARTBEAT: {
        // 服务端要求立即心跳
        this.#send({ op: OP.HEARTBEAT, d: this.lastSeq });
        break;
      }
      case OP.HEARTBEAT_ACK:
        this.lastAckAt = Date.now();
        break;
      case OP.RECONNECT: {
        log.warn('服务端要求重连');
        this.ws?.close(4000, 'server reconnect');
        break;
      }
      case OP.INVALID_SESSION: {
        log.warn('会话失效，重新鉴权');
        this.sessionId = '';
        this.lastSeq = null;
        await this.#identify();
        break;
      }
      case OP.DISPATCH: {
        const t = p.t;
        /**
         * seq 去重。
         *
         * resume 时服务端会把 lastSeq 之后（含边界）的事件重放一遍，
         * 同一条命令于是执行两次——签到领两份奖励、掷骰子记两次。
         * READY / RESUMED 是连接生命周期事件，必须放过，否则重连后卡在 starting。
         */
        const lifecycle = t === 'READY' || t === 'RESUMED';
        if (typeof p.s === 'number') {
          if (!lifecycle && this.lastSeq !== null && p.s <= this.lastSeq) {
            log.debug(`跳过重复事件 t=${t} s=${p.s}（已处理到 ${this.lastSeq}）`);
            this.metrics.bump('dedup');
            break;
          }
          this.lastSeq = p.s;
        }
        if (t === 'READY') {
          this.sessionId = p.d?.session_id ?? '';
          this.attempt = 0;
          this.ready = true;
          const name = p.d?.user?.username ?? '未知';
          this.metrics.connected = true;
          this.metrics.botName = name;
          this.metrics.platformId = p.d?.user?.id ?? '';
          this.metrics.sessionId = this.sessionId;
          log.info(`已就绪，机器人: ${name}`);
          this.readyResolve?.(this);
        } else if (t === 'RESUMED') {
          this.ready = true;
          this.attempt = 0;
          this.metrics.connected = true;
          log.info('会话已恢复');
          this.readyResolve?.(this);
        } else {
          try {
            // onDispatch 是 async 的，try/catch 只能接住同步抛错；
            // 返回的 Promise 必须自己挂 catch，否则 rejection 没人管 → 进程退出
            const r = this.onDispatch?.(t, p.d, p);
            if (r && typeof r.catch === 'function') {
              r.catch((e) => log.error(`事件 ${t} 处理异常:`, e?.stack || e?.message || e));
            }
          } catch (e) {
            log.error(`事件 ${t} 处理异常:`, e.stack || e.message);
          }
        }
        break;
      }
      default:
        log.debug(`未处理的 op=${p.op}`);
    }
  }

  async #authToken() {
    return `QQBot ${await this.tokens.get()}`;
  }

  async #identify() {
    /**
     * 全新会话的 seq 从 1 重新开始。
     * 不清掉 lastSeq 的话，上一段连接攒到 500，新会话前 500 个事件
     * 会被上面的去重逻辑全当成「重复」丢掉。
     */
    this.lastSeq = null;
    this.#send({
      op: OP.IDENTIFY,
      d: {
        token: await this.#authToken(),
        intents: this.intents,
        shard: this.shard,
        properties: { $os: process.platform, $browser: 'douluo-bot', $device: 'douluo-bot' },
      },
    });
    log.info(`已发送 Identify，intents=${this.intents}`);
  }

  #startHeartbeat(interval) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatInterval = interval;
    this.lastAckAt = Date.now();

    this.heartbeatTimer = setInterval(() => {
      // 连续两个多周期没有 ACK，说明连接已经假死，主动断开触发重连
      if (this.lastAckAt && Date.now() - this.lastAckAt > interval * 2.5) {
        log.warn('心跳长时间无响应，主动断开重连');
        this.lastAckAt = 0;
        try {
          this.ws?.close(4001, 'heartbeat timeout');
        } catch {}
        return;
      }
      this.#send({ op: OP.HEARTBEAT, d: this.lastSeq });
      this.metrics.lastHeartbeatAt = Date.now();
    }, interval);
  }

  #send(obj) {
    if (this.ws?.readyState === 1) {
      log.debug(`>> op=${obj.op}`);
      this.ws.send(JSON.stringify(obj));
    } else {
      log.warn(`发送 op=${obj.op} 失败：连接未就绪（readyState=${this.ws?.readyState}）`);
    }
  }

  #scheduleReconnect() {
    if (this.stopped) return;
    // 撞过永久性错误就别再试了，重连只会刷日志
    if (this.fatal) return;
    // 已经有重连排队了就不再叠加，否则 error + close 会各排一个
    if (this.reconnectTimer) {
      log.debug('已有重连排队，跳过');
      return;
    }
    // 指数退避，上限 30s
    // 加 jitter：多机器人/多实例同时断线时避免锁步重连一起打满网关
    const base = Math.min(1000 * 2 ** this.attempt++, 30000);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    log.info(`${(delay / 1000).toFixed(0)}s 后重连（第 ${this.attempt} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect().catch((e) => log.error('重连失败:', e.message));
    }, delay);
  }
}
