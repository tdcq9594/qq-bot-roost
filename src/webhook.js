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
import fs from 'node:fs';
/**
 * 这里**必须具名导入** `join` / `dirname`，不能 `import path from 'node:path'`。
 * constructor 有个参数就叫 `path`（回调路径），会把模块级的 `path` 遮蔽掉，
 * 于是 `path.join(...)` 变成「字符串.join」→ `TypeError: path.join is not a function`，
 * 整个 Webhook 服务直接起不来。这个坑是靠实测抓到的，不是看代码能看出来的。
 */
import { join, dirname } from 'node:path';
import { createLogger } from './logger.js';
import { DIRS } from './paths.js';
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
    /**
     * 回调验证（op=13）的状态，按 appId 记：`{ okAt: 时间戳, hits: [最近一分钟的尝试] }`。
     *
     * 为什么需要它，见 #handle 里 op=13 那段长注释。简单说：这个接口会用
     * AppSecret 给「任意提交内容」签名，而事件验签用的是同一把密钥、同一种
     * 拼接方式 —— 放开了就等于对外提供签名服务。
     */
    this.verifyState = new Map();
    this.verifyFile = join(DIRS.data, 'webhook-verified.json');
    this.#loadVerifyState();
  }

  /** 读回落盘的回调验证记录：重启不该让平台被迫重新验证一次 */
  #loadVerifyState() {
    try {
      const obj = JSON.parse(fs.readFileSync(this.verifyFile, 'utf8'));
      for (const [id, at] of Object.entries(obj)) {
        const t = Number(at);
        if (Number.isFinite(t) && t > 0) this.verifyState.set(id, { okAt: t, hits: [] });
      }
    } catch (e) {
      // 文件不存在是正常的（第一次跑），其它错误才值得说一句
      if (e.code !== 'ENOENT') log.warn(`回调验证记录读不出来（忽略）：${e.message}`);
    }
  }

  #saveVerifyState() {
    try {
      fs.mkdirSync(dirname(this.verifyFile), { recursive: true });
      const obj = {};
      for (const [id, s] of this.verifyState) if (s.okAt) obj[id] = s.okAt;
      const tmp = `${this.verifyFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, this.verifyFile); // 原子替换，避免写一半断电
    } catch (e) {
      log.warn(`回调验证记录写不进去（不影响运行）：${e.message}`);
    }
  }

  /**
   * 重置某个机器人的回调验证状态。
   *
   * 用途：平台那边改了回调地址 / 换了域名，需要重新走一次 op=13 验证。
   * 面板可以挂一个「重新验证回调」按钮调它，也可以直接删
   * `data/webhook-verified.json` 里对应的那条。
   *
   * @returns {boolean} 是否真的重置了（原来有记录才返回 true）
   */
  resetVerify(appId) {
    const id = String(appId ?? '').trim();
    if (!id) return false;
    const s = this.verifyState.get(id);
    if (!s) return false;
    this.verifyState.set(id, { okAt: 0, hits: [] });
    this.#saveVerifyState();
    log.info(`[${id}] 已重置回调验证状态，等待平台重新验证`);
    return true;
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
      /**
       * ⚠️ 整段 Webhook 里最危险的就是这里，改之前把这段读完。
       *
       * op=13 的签名内容是 `${event_ts}${plain_token}`，事件验签是
       * `${timestamp}${rawBody}` —— **同一把密钥、同一种拼接、没有域分离**。
       * 而 op=13 在验签之前、也不需要任何认证，只要 appId 在册就回签。
       *
       * 于是它可以被当成「任意内容签名服务」：把要伪造的事件体当 plain_token
       * 提交，拿回来的签名直接能过事件验签 —— 冒充任意 openid 触发管理命令。
       * 也就是说 `verifySignature: true` 在攻击者面前是形同虚设的。
       *
       * 签名内容由官方协议规定，应用层改不了（改了平台就不认）。所以只能
       * 收紧「谁能调、能调几次」：
       *
       *   1. **plain_token 形态校验**：事件体必然是 JSON，一定含 { } " \ 或空白；
       *      合法 token 是平台生成的随机串。这条零成本、不影响正常流程，是主防线。
       *   2. **24 小时内只回签一次**：平台只在配置回调地址时验证。
       *      不做成「永久一次」是因为换域名/端口要重新验证，永久锁死会让用户
       *      卡在「回调地址验证失败」上，反而制造新的排查成本。
       *   3. **每分钟最多 3 次尝试**，把爆破与滥用压到没有价值。
       */
      const st = this.verifyState.get(appId) ?? { okAt: 0, hits: [] };
      const now = Date.now();
      st.hits = st.hits.filter((t) => now - t < 60_000);

      if (st.okAt && now - st.okAt < 24 * 3600_000) {
        this.counters.rejected += 1;
        log.warn(
          `[${appId}] 拒绝重复的 op=13：该 appId 24 小时内已通过验证。` +
            `如果确实要重新验证（换回调地址等），调 resetVerify() 或删掉 ` +
            `data/webhook-verified.json 里这一条`,
        );
        return this.#json(res, 403, { error: 'already verified' });
      }
      if (st.hits.length >= 3) {
        this.counters.rejected += 1;
        log.warn(`[${appId}] op=13 尝试过频（每分钟上限 3 次），已限速`);
        return this.#json(res, 429, { error: 'too many validation attempts' });
      }
      st.hits.push(now);
      this.verifyState.set(appId, st);

      const tok = String(payload?.d?.plain_token ?? '');
      if (!tok || tok.length > 128 || /[\s{}"\\]/.test(tok)) {
        this.counters.rejected += 1;
        log.warn(
          `[${appId}] op=13 的 plain_token 形态异常，已拒绝（疑似把事件体当 token 提交）`,
        );
        return this.#json(res, 400, { error: 'invalid validation' });
      }

      const signed = verifyRequest(bot.secret, payload);
      if (!signed) {
        this.counters.rejected += 1;
        log.warn(`[${appId}] 回调验证缺少 plain_token / event_ts`);
        return this.#json(res, 400, { error: 'invalid validation' });
      }
      st.okAt = now;
      this.verifyState.set(appId, st);
      this.#saveVerifyState();
      this.counters.verify += 1;
      log.info(`[${appId}] Webhook 回调验证通过（24 小时内不再重复回签）`);
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
