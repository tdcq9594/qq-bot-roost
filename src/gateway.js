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
 * 会话已失效的关闭码：清掉本地 session，下次走全新 IDENTIFY。
 *
 * 官方明确定义（bot.q.qq.com/wiki/develop/api-v2/openapi/wss）：
 *   4006 SESSION_NO_LONGER_VALID — 会话不再有效
 *   4007 INVALID_SEQ             — seq 无效
 *   4902                         — 同一 AppID 被另一条连接顶掉
 *
 * 不清的话会带着旧 session_id 去 RESUME，被服务端再拒一次（又 close 4006/4007），
 * 表现为「一直重连但始终不上线」。注意**不能**把它们加进 CLOSE_HINTS：
 * FATAL_CLOSE_CODES 是从 CLOSE_HINTS 的 key 派生的，加进去就变成「停止重连」了。
 * 与 botrs close.rs 的 cannot_resume_close_code 同口径。
 */
const SESSION_INVALID_CLOSE_CODES = new Set([4006, 4007, 4902]);

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
    /**
     * 建连代数。`stop()` 每调一次就 +1，`#connect()` 在 await 前后各对一次。
     *
     * 只靠 `stopped` 标志不够：`restart()` 会在 stop 之后把 stopped 改回 false，
     * 这时**上一轮还在 await 的 #connect 会以为没事了**，继续建第二条连接。
     * 加个代数就分得清「谁是我这一轮的」。
     */
    this.epoch = 0;
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
    // 面板上残留的旧会话也要清，否则重启后到 READY 之间显示的是已废的 id
    this.#clearSession();
    this.lastAckAt = 0;
    this.attempt = 0;
    await this.#connect();
  }

  stop() {
    this.stopped = true;
    /** 作废所有在飞的 `#connect()`，并把 connecting 复位，别让 restart() 被卡住 */
    this.epoch += 1;
    this.connecting = false;
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

  /**
   * 会话失效时统一清理本地会话状态。
   *
   * metrics.sessionId 也要清：它会在 READY 时写入并上面板（runtime.js:160），
   * 只清 this.sessionId 的话，面板会一直显示一个已经作废的会话 id，
   * 排查「为什么一直 RESUME 失败」时会被误导。
   */
  #clearSession() {
    this.sessionId = '';
    this.lastSeq = null;
    this.metrics.sessionId = '';
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
    /** 这一轮建连的代号；stop()/restart() 会让它过期（见构造函数里的说明） */
    const epoch = this.epoch;
    /** 网关响应要留到下面的配额预检用，不能关在 try 块里 */
    let gw;
    let url;
    try {
      gw = await this.api.getGateway();
      url = gw?.url;
      if (!url) throw new Error('网关接口未返回 url');
      this.metrics.gatewayUrl = url;
      log.info(`网关地址: ${url}`);
    } catch (e) {
      this.connecting = false;
      log.error('获取网关地址失败:', e.message);
      return this.#scheduleReconnect();
    }

    /**
     * 取地址是异步的（最长 15 秒），这期间可能已经被 stop()：
     * 下线、删除机器人、面板重启都会走到。这里必须复查一次，否则会在停机后
     * 建出一条**僵尸连接**——它能连上就会发 Identify，把线上那条会话踢成
     * 4902（本文件开头那段「两条连接互相踢」说的就是它），而且 `connecting`
     * 会永久停在 true。
     */
    if (this.stopped || epoch !== this.epoch) {
      this.connecting = false;
      log.debug('停机中，放弃建立连接');
      return;
    }

    /**
     * 会话创建配额预检（官方 GET /gateway/bot 的 session_start_limit）。
     *
     * 只挡「需要全新 IDENTIFY」的场景：有 sessionId + seq 时走 RESUME，
     * 不创建新 Session、不消耗配额，不能被误挡——否则断线重连永远回不来。
     * remaining<=0 时盲发 IDENTIFY 只会被服务端拒（还白白消耗一次失败计数），
     * 不如按官方 reset_after 等到配额重置再连。
     *
     * 多分片场景（shards>1）本框架单连接用不上；这里按「至少要有 1 个」判断。
     * 字段缺失（旧接口/沙箱）一律放行，不让预检变成新的启动阻塞点。
     */
    const needIdentify = !(this.sessionId && this.lastSeq !== null);
    const limit = gw?.session_start_limit;
    if (needIdentify && limit && Number.isFinite(limit.remaining) && limit.remaining <= 0) {
      this.connecting = false;
      log.warn(
        `会话创建配额已耗尽（remaining=${limit.remaining}/total=${limit.total ?? '?'}），` +
          `跳过本次 IDENTIFY 等配额重置`,
      );
      return this.#scheduleReconnect(limit.reset_after);
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
      if (SESSION_INVALID_CLOSE_CODES.has(ev.code)) {
        // 会话失效（被顶掉 / 不再有效 / seq 无效）：清掉本地会话，下次走全新鉴权。
        // 不清就会带着旧 session_id 反复 RESUME 被拒，表现为一直重连却不上线。
        this.#clearSession();
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
        this.#clearSession();
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
        /**
         * 交互事件回执（WS 分支）。
         *
         * HTTP 分支在 webhook.js 做了「两层确认」：reply `{op:12,code:0}` +
         * `PUT /interactions/{id}`。WS 没有 HTTP 响应可回，只剩下第二层，
         * 以前整个仓库只有 webhook 会调 putInteraction，于是 WS 模式下
         * 回调型按钮点下去客户端一直转圈。
         *
         * 只有 type 11（消息按钮）/ 12（快捷菜单）需要回执；13/14/16/18/19
         * 官方明确不用，乱回同一 id 会被判非法。口径与 webhook.js 保持一致。
         *
         * 放在 seq 去重之后：resume 重放的同一 interaction_id 不会重复 PUT。
         * 这一步是纯加法——现有按钮都是 `action.type: 2` 指令型，不产生 interaction。
         */
        if (t === 'INTERACTION_CREATE') {
          const id = p.d?.id;
          const tt = Number(p.d?.type ?? p.d?.data?.type ?? 0);
          if (id && (tt === 11 || tt === 12)) {
            try {
              /** api.js:1093 返回 Promise，fire-and-forget，别 await 阻塞分发 */
              const r = this.api?.putInteraction?.(id, 0);
              if (r && typeof r.catch === 'function') r.catch(() => {});
            } catch {
              /* 回执失败不影响分发 */
            }
          }
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

  /**
   * @param {number|null} quotaWaitMs 会话配额耗尽时按官方 reset_after 等待；
   *   传了就用它（且不推高 attempt，避免后续每次断线退避越来越长），不传走普通指数退避。
   */
  #scheduleReconnect(quotaWaitMs = null) {
    if (this.stopped) return;
    // 撞过永久性错误就别再试了，重连只会刷日志
    if (this.fatal) return;
    // 已经有重连排队了就不再叠加，否则 error + close 会各排一个
    if (this.reconnectTimer) {
      log.debug('已有重连排队，跳过');
      return;
    }
    let delay;
    // 调用方只在「配额耗尽」时传参（哪怕 reset_after 非法也传 null），
    // 所以用「是否走过配额路径」决定分支，不能拿参数有效性当判断——
    // 否则 reset_after=0/undefined 会落进下面的指数退避，平白把 attempt 推高。
    const quotaMode = arguments.length > 0;
    if (quotaMode) {
      // reset_after 单位是 ms，官方给的是「计数重置还需多久」。
      // 非法/缺失时用 30s 兜底；setTimeout 上限约 24.8 天，
      // 这里再收一道到 24h，避免异常值溢出成立即触发。
      const safe = Number.isFinite(quotaWaitMs) && quotaWaitMs > 0 ? quotaWaitMs : 30_000;
      delay = Math.min(safe, 24 * 3600_000 - 1);
      log.info(`会话配额耗尽，${(delay / 1000).toFixed(0)}s 后配额重置再重连`);
    } else {
      // 指数退避，上限 30s
      // 加 jitter：多机器人/多实例同时断线时避免锁步重连一起打满网关
      const base = Math.min(1000 * 2 ** this.attempt++, 30000);
      delay = Math.round(base * (0.5 + Math.random() * 0.5));
      log.info(`${(delay / 1000).toFixed(0)}s 后重连（第 ${this.attempt} 次）`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect().catch((e) => log.error('重连失败:', e.message));
    }, delay);
  }
}
