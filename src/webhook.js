/**
 * Webhook 接收服务
 * =================
 *
 * 官方支持两种收事件方式：WebSocket 长连接、Webhook HTTP 回调。
 * 这个模块实现后者。
 *
 * 为什么要有 Webhook：
 *   - **不用一直挂着长连接**，Serverless / 容器按需唤醒更省资源
 *   - 公网部署时不用额外开 WebSocket 端口，走 80/443 就行
 *   - 平台侧超时会重推，天然带重试
 *
 * 多机器人共用一个端口，靠 `X-Bot-Appid` 头（或 `?appid=` 参数）区分。
 * 这点和官方示例一致——一个回调地址服务多个机器人，省得每个机器人开一个端口。
 */
import http from 'node:http';
import { createLogger } from './logger.js';
import { verifyRequest, verifyEventSignature } from './sign.js';

const log = createLogger('webhook');

/** 请求体上限。官方事件报文不大，1MB 足够，防止被灌爆内存 */
const MAX_BODY = 1024 * 1024;

export class WebhookServer {
  /**
   * @param {{host?:string, port?:number, path?:string}} opts
   */
  constructor({ host = '0.0.0.0', port = 15208, path = '/webhook', verifySignature = true } = {}) {
    this.host = host;
    this.port = port;
    this.path = path.startsWith('/') ? path : `/${path}`;
    /**
     * 是否校验事件的 Ed25519 签名。
     *
     * 默认开。关掉只应出现在「验签总是失败、但又急着收消息」的排查场景，
     * 关掉之后任何知道回调地址 + appId 的人都能伪造事件。
     */
    this.verifySignature = verifySignature !== false;
    /** @type {Map<string, {secret:string, onEvent:Function, onError?:Function}>} */
    this.bots = new Map();
    this.server = null;
    this.running = false;
    /** 收到过多少事件，面板显示用 */
    this.counters = { received: 0, rejected: 0, verify: 0 };
  }

  /**
   * 注册一个机器人的回调处理。
   * @param {string} appId
   * @param {{secret:string, onEvent:(event:string, d:any, payload:any)=>void, onError?:(e:Error)=>void}} handler
   */
  register(appId, handler) {
    const id = String(appId ?? '').trim();
    if (!id) throw new Error('appId 不能为空');
    if (!handler?.secret) throw new Error('缺少 AppSecret，无法校验签名');
    this.bots.set(id, handler);
    log.info(`已注册 Webhook 回调: ${id}`);
  }

  unregister(appId) {
    if (this.bots.delete(String(appId ?? '').trim())) {
      log.info(`已注销 Webhook 回调: ${appId}`);
    }
  }

  async start() {
    if (this.running) return this.port;

    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((e) => {
        log.error(`Webhook 处理异常: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"internal"}');
        }
      });
    });

    // 端口被占就顺延，和面板一样的策略
    const maxTries = 10;
    for (let i = 0; i < maxTries; i++) {
      const tryPort = this.port + i;
      try {
        await new Promise((resolve, reject) => {
          const onErr = (e) => {
            this.server?.off('error', onErr);
            reject(e);
          };
          this.server.once('error', onErr);
          this.server.listen(tryPort, this.host, () => {
            this.server?.off('error', onErr);
            resolve();
          });
        });
        this.port = tryPort;
        this.running = true;
        log.info(`Webhook 已监听 http://${this.host}:${this.port}${this.path}`);
        return this.port;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        log.warn(`端口 ${tryPort} 被占用，尝试 ${tryPort + 1}`);
      }
    }
    throw new Error(`Webhook 端口连续 ${maxTries} 次被占用`);
  }

  async stop() {
    this.running = false;
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    log.info('Webhook 已停止');
  }

  /** 面板展示用 */
  info() {
    return {
      running: this.running,
      host: this.host,
      port: this.port,
      path: this.path,
      url: this.running ? `http://${this.host}:${this.port}${this.path}` : '',
      bots: [...this.bots.keys()],
      counters: { ...this.counters },
    };
  }

  /* ---------------- 内部 ---------------- */

  async #handle(req, res) {
    // 只接受 POST；健康检查给 GET
    if (req.method === 'GET') {
      return this.#json(res, 200, { ok: true, service: 'roost-webhook', bots: this.bots.size });
    }
    if (req.method !== 'POST') {
      return this.#json(res, 405, { error: 'method not allowed' });
    }

    // 路径校验（允许末尾多斜杠）
    const pathname = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
    if (pathname !== this.path.replace(/\/+$/, '')) {
      return this.#json(res, 404, { error: 'not found' });
    }

    const url = new URL(req.url || '/', 'http://localhost');
    const appId =
      String(req.headers['x-bot-appid'] ?? '').trim() || String(url.searchParams.get('appid') ?? '').trim();
    if (!appId) {
      this.counters.rejected += 1;
      return this.#json(res, 400, { error: 'missing appid' });
    }

    const bot = this.bots.get(appId);
    if (!bot) {
      this.counters.rejected += 1;
      return this.#json(res, 404, { error: `unknown bot: ${appId}` });
    }

    const raw = await readBody(req);
    if (raw === null) {
      this.counters.rejected += 1;
      return this.#json(res, 413, { error: 'body too large' });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.counters.rejected += 1;
      return this.#json(res, 400, { error: 'invalid JSON' });
    }

    // op=13：平台验证回调地址，用 AppSecret 签名后原样返回
    if (payload?.op === 13) {
      const signed = verifyRequest(bot.secret, payload);
      if (!signed) {
        this.counters.rejected += 1;
        log.warn(`[${appId}] 回调验证缺少 plain_token / event_ts`);
        return this.#json(res, 400, { error: 'invalid validation' });
      }
      this.counters.verify += 1;
      log.info(`[${appId}] Webhook 回调验证通过`);
      return this.#json(res, 200, signed);
    }

    /**
     * 普通事件必须验签。
     *
     * 以前只有 op=13 回签、事件分支直接分发：知道回调 URL 和 appId
     * （日志、面板、证书透明度记录里都能拿到）就能伪造任意事件，
     * 包括冒充 owner 的 openid 去触发管理命令。
     */
    if (this.verifySignature) {
      const r = verifyEventSignature(
        bot.secret,
        req.headers['x-signature-timestamp'],
        raw,
        req.headers['x-signature-ed25519'],
      );
      if (!r.ok) {
        this.counters.rejected += 1;
        log.warn(`[${appId}] 事件验签失败（${r.reason}），已拒绝`);
        return this.#json(res, 401, { error: 'invalid signature' });
      }
    }

    this.counters.received += 1;
    const eventName = String(payload?.t ?? '');
    const d = payload?.d ?? {};
    // 交互事件（按钮点击）必须回 op=12 ACK，否则客户端一直转圈
    const isInteraction = eventName === 'INTERACTION_CREATE';

    // 先回 ACK 再分发：普通事件立刻 200，避免平台等超时重推
    if (!isInteraction) {
      this.#json(res, 200, {});
    }

    // 异步分发，不阻塞响应
    queueMicrotask(() => {
      try {
        // onEvent 是 async 的，同步 try 接不住它的 rejection，得自己挂 catch
        const r = bot.onEvent?.(eventName, d, payload);
        if (r && typeof r.catch === 'function') {
          r.catch((e) => {
            log.error(`[${appId}] 事件处理失败 (${eventName}): ${e?.stack || e?.message || e}`);
            bot.onError?.(e);
          });
        }
      } catch (e) {
        log.error(`[${appId}] 事件分发失败 (${eventName}): ${e.message}`);
        bot.onError?.(e);
      }
    });

    if (isInteraction) {
      /**
       * 按钮点击要**两层**确认，少一层客户端就一直转圈：
       *   1. HTTP ACK `{op:12, code:0}` —— 告诉平台「我收到了」
       *   2. `PUT /interactions/{id}` —— 告诉客户端「这次点击处理完了」
       *
       * 以前只做了第 1 层（下面那行注释以为 putInteraction 插件会自己调，
       * 实际上没人调），所以按钮点下去会一直转。
       *
       * **只有 type 11（消息按钮）和 12（快捷菜单）需要回执**，
       * 其他类型（消息反馈 13、清空会话 14、切模型 16、授权 18/19）官方明确不用回。
       * 所以这里按 type 收紧——乱回可能被判非法，而且同一 id 只能回一次。
       */
      const t = Number(d?.type ?? d?.data?.type ?? 0);
      if (t === 11 || t === 12) {
        try {
          const r = bot.api?.putInteraction?.(d?.id, 0);
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {
          /* 回执失败不影响主流程 */
        }
      }
      return this.#json(res, 200, { op: 12, code: 0 });
    }
  }

  #json(res, status, body) {
    if (res.headersSent) return;
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }
}

/** 读请求体，超限返回 null */
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}
