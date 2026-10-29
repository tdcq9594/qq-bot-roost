import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { DELIVERY_STATE, digestOf } from './delivery.js';
import { DIRS } from './paths.js';

const log = createLogger('outbound');

/**
 * 出站消息调度器。
 *
 * QQ 官方接口的硬限制都在这里统一处理，插件和内核都不用关心：
 *
 *   1. 被动回复只有 5 分钟有效期，超时必失败 → 快过期时降级为主动消息
 *   2. 同一条消息最多被动回复 5 次（msg_seq 1–5）→ 用满后同样降级
 *   3. 同一会话每秒最多 5 条 → 本地令牌队列，超出的排队等
 *   4. 主动消息有两个维度：单关系 20/分钟 + 每群 1000/天 → 本地记账，用完直接拒绝
 *   5. 必须 WebSocket 在线才能发 → 离线时直接拒绝，不浪费一次网络请求
 *   6. 主动消息返回 304023 表示「已进入审核」 → 这不是失败，不能当错误处理
 *
 * 插件只管调 msg.reply()，剩下的交给这里。
 */

/**
 * 被动回复窗口。**两个接口不一样，别再用一个值。**
 *
 *   群聊 `/v2/groups/{group_openid}/messages`：5 分钟、最多 5 次
 *   单聊 `/v2/users/{user_openid}/messages`：**60 分钟、最多 4 次**
 *
 * 以前两者共用「5 分钟 / 5 次」（群聊的口径），单聊的后果是：
 *   · 5 分钟后就降级成主动消息，白吃「每个好友 1000 条/天」的额度，
 *     而被动回复本来不占主动额度；
 *   · 第 5 次回复会被服务端拒（40034128）。
 *
 * 各留 15 秒给网络和服务端时钟差。
 */
const PASSIVE_WINDOW_MS = {
  group: 5 * 60 * 1000,
  c2c: 60 * 60 * 1000,
};
const PASSIVE_SAFE_MS = {
  group: PASSIVE_WINDOW_MS.group - 15_000,
  c2c: PASSIVE_WINDOW_MS.c2c - 15_000,
};

/**
 * 同一条消息最多回复次数：群聊 5、单聊 4。
 * 超过会返回 40034128「被动回复时间或次数超限」。
 */
const PASSIVE_MAX_REPLIES = {
  group: 5,
  c2c: 4,
};

/** 主动消息进入审核的返回码，属于正常结果 */
const CODE_AUDIT = 304023;

/**
 * 把出站 payload 压成一行人能看懂的文字，用于日志。
 *
 * 排查时最常遇到的问题是「机器人到底回没回、回了什么」——发送侧以前
 * 一行日志都没有，只能去翻 QQ 客户端对着猜。现在打出来。
 *
 * @param {object} payload api.js 驼峰字段的 payload
 * @returns {string}
 */
function briefOf(payload) {
  const b = payload ?? {};
  const parts = [];
  if (typeof b.content === 'string' && b.content.trim()) parts.push(b.content.trim());
  if (b.markdown?.content) {
    parts.push(`[markdown] ${String(b.markdown.content).replace(/\s+/g, ' ').trim()}`);
  }
  if (b.ark) parts.push('[ark 卡片]');
  if (b.media) {
    // fileType 是数字（1 图 / 2 视频 / 3 语音 / 4 文件），直接打数字没人看得懂
    const name = { 1: '图片', 2: '视频', 3: '语音', 4: '文件' }[b.media.fileType];
    parts.push(name ? `[${name}消息]` : '[媒体消息]');
  }
  if (b.keyboard) parts.push('[按钮键盘]');
  if (b.image) parts.push('[图片]');
  if (b.file_uuid) parts.push('[文件]');

  let text = parts.join(' | ');
  if (text.length > 120) text = `${text.slice(0, 120)}…`;
  return text;
}

/** 带错误码的发送异常，方便调用方分辨该提示用户什么 */
export class SendError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'SendError';
    /**
     * 五种，按「多久能好」排序：
     *   offline  连不上 QQ —— 等它上线
     *   expired  被动窗口过了 —— 等用户再说一句
     *   quota    今天这个会话的主动额度用完了 —— 等跨天
     *   rate     这一分钟发得太密 —— 等一分钟
     *   api      接口报错 —— 看具体错误码
     */
    this.code = code; // offline | expired | quota | rate | api
    this.detail = detail;
  }
}

/**
 * 这次失败是「确定没发出去」还是「不知道发没发出去」。
 *
 * 只有 `api` 这一类可能不确定：超时、5xx、连接重置——请求发出去了但响应没回来。
 * 其余四种（`offline` / `expired` / `quota` / `rate`）都是**本地判定**，
 * 消息一定没发出去，记 `failed` 可以放心重试。
 *
 * 判错的代价不对称：把「确定失败」误判成 unknown，用户要人工核对（麻烦但安全）；
 * 把 unknown 误判成「确定失败」，就会重发一条可能已经发出去的消息（重复打扰）。
 * 所以这里宁可保守——拿不准就当 unknown。
 */
function uncertainOf(e) {
  if (e?.code !== 'api') return false;
  const s = String(e?.detail ?? e?.message ?? '');
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|aborted|\b5\d\d\b/i.test(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本地日期键，按用户所在时区算，不用 UTC 免得跨天错位 */
export function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 主动消息额度账本。
 * 按「日期 → 会话 → 已用条数」记账，落盘到 data/quota.json，重启不清零。
 */
class QuotaLedger {
  constructor(file) {
    this.file = file;
    this.data = null; // { '2026-10-22': { 'group:xxx': 3 } }
    this.dirty = false;
    this.timer = null;
  }

  async #load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.data = {};
    }
    // 只保留最近 3 天，避免文件无限增长
    const keys = Object.keys(this.data).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 3))) delete this.data[k];
    return this.data;
  }

  async used(chatKey) {
    const d = await this.#load();
    return d[dateKey()]?.[chatKey] ?? 0;
  }

  async consume(chatKey, n = 1) {
    const d = await this.#load();
    const day = dateKey();
    d[day] ??= {};
    d[day][chatKey] = (d[day][chatKey] ?? 0) + n;
    this.#scheduleSave();
    return d[day][chatKey];
  }

  /**
   * 退还额度。发送失败时用——「先扣后发」不退还的话，一次网络抖动就白扣一条。
   */
  async refund(chatKey, n = 1) {
    const d = await this.#load();
    const day = dateKey();
    if (!d[day]?.[chatKey]) return 0;
    d[day][chatKey] = Math.max(0, d[day][chatKey] - n);
    this.#scheduleSave();
    return d[day][chatKey];
  }

  async snapshot() {
    const d = await this.#load();
    return { ...(d[dateKey()] ?? {}) };
  }

  #scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => log.warn('额度账本写盘失败:', e.message));
    }, 500);
    this.timer.unref?.();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.data) return;
    this.dirty = false;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) {
      log.warn('额度账本写盘失败:', e.message);
    }
  }
}

/**
 * 从出站报文里挑出「人看得懂的那部分」，喂给 `digestOf`。
 *
 * 报文不止一种形状，只认顶层 `content` 会漏掉一大半：
 *
 *   · 纯文本   `{ content }`
 *   · markdown `{ markdown: { content } }` ← ai-chat 默认就走这条
 *   · 卡片     `{ markdown, keyboard, ark }`
 *   · 富媒体   `{ msgType: 7, media }`，正文只有一个占位空格
 *
 * 漏掉的后果不是发不出去（账本的状态机不看摘要），而是摘要列全变成
 * `…(0)#da39a3ee`——所有记录长得一模一样，「人工核对」这条路等于堵死，
 * 真出现 `unknown` 的时候只能靠猜。
 */
export function digestTextOf(payload) {
  const p = payload ?? {};
  const md = p.markdown;
  const text = p.content ?? p.text ?? (typeof md === 'string' ? md : md?.content);
  if (typeof text === 'string' && text.trim()) return text;
  /**
   * 没有正文的报文给个占位。一串空摘要里冒出 `[媒体]` / `[卡片]`，
   * 至少能分辨「这条本来就没有文字」，而不是「摘要功能又坏了」。
   */
  if (p.media) return '[媒体]';
  if (p.ark) return '[卡片]';
  return '';
}

export class Outbound {
  /**
   * @param {object} opts
   * @param {object} opts.api            QQApi 实例
   * @param {object} opts.cfg            全局配置
   * @param {() => boolean} opts.isOnline 机器人是否已连上网关
   */
  constructor({ api, cfg, isOnline = () => true, quotaFile, delivery = null }) {
    this.api = api;
    /** 投递账本（阶段 5）。没有它就退回原来的「发一次算一次」 */
    this.delivery = delivery;
    this.cfg = cfg;
    this.isOnline = isOnline;

    const o = cfg.outbound ?? {};
    // 官方是 5 条/秒，默认压到 4 条，给其他来源留一点余量
    this.perSec = Math.max(1, o.perSec ?? 4);
    /**
     * 主动消息额度。官方文档（`autogen/api/.../messages.post`）写的是两个维度：
     *
     *   - 单关系（接收方）：20/qpm，且**每个群 1 天最多接收 1000 条**
     *   - Bot（发送方）：认证 60/qpm，未认证 30/qpm
     *
     * 这里以前按「20 条/天」记账（把频道的口径套到了群聊），少算了 50 倍，
     * 主动推送被白白拦掉。现在按官方数值：1000/天 + 20/分钟。
     */
    this.dailyActive = Math.max(0, o.dailyActive ?? 1000);
    this.activePerMin = Math.max(0, o.activePerMinute ?? 20);
    this.downgrade = o.downgradeToActive !== false;

    /** msgId -> 已用被动回复次数。官方：同一条消息最多 5 次 */
    this.passiveCount = new Map();
    /** chatKey -> 最近 60 秒的主动发送时间戳 */
    this.activeLog = new Map();

    // 额度账本按机器人分开，不同机器人的额度互不影响
    this.quota = new QuotaLedger(quotaFile ?? path.join(DIRS.data, 'quota.json'));
    /** chatKey -> { chain: Promise, history: number[] } */
    this.queues = new Map();

    this.stats = {
      passive: 0,
      active: 0,
      degraded: 0, // 被动超窗降级为主动的次数
      expired: 0, // 因超窗被拒绝的次数
      quotaBlocked: 0, // 因日额度用完被拒绝的次数（等跨天才好）
      rateBlocked: 0, // 因分钟限流被拒绝的次数（等一分钟就好）
      throttled: 0, // 因限速排队过的次数
      audit: 0, // 进入审核的主动消息
      offline: 0,
    };
  }

  /* ---------------- 对外主入口 ---------------- */

  /**
   * 发送一条消息。payload 里带 msg_id 就是被动回复，不带就是主动推送。
   *
   * @param {object} p
   * @param {'group'|'c2c'} p.kind
   * @param {string} p.target      群 openid 或用户 openid
   * @param {string} p.chatKey     记账与限速用的会话键，如 group:xxx
   * @param {object} p.payload     发给接口的报文
   * @param {number} [p.receivedAt] 触发本次回复的消息接收时间
   * @returns {Promise<{id?:string, pending?:boolean, degraded?:boolean}>}
   */
  /**
   * 发送。**有 `requestId` 就走投递账本，没有就照旧发一次。**
   *
   * 为什么不是「所有发送都记账」：`requestId` 由调用方生成，只有它知道
   * 「一段话」的语义边界（`qq_send` 每调一次是一段独立消息）。插件直接
   * `msg.reply()` 那种没有 id，按原行为走——被动回复本身有 `msg_seq` 兜底。
   *
   * 账本是**增强**不是主链路：`claim` 失败一律退回「照发」，不能让记账把消息堵死。
   */
  async send(opts) {
    const requestId = String(opts?.requestId ?? '').trim();
    if (!requestId || !this.delivery) return this.#sendOnce(opts);

    const c = this.delivery.claim({
      requestId,
      kind: opts.kind,
      chatId: opts.target,
      replyTo: opts.payload?.msgId,
      msgSeq: opts.payload?.msgSeq,
      digest: digestOf(digestTextOf(opts.payload)),
    });

    if (c.action === 'reuse') {
      // 已经发过：直接回上次的结果，**不再打接口**
      return {
        id: c.row?.msg_id || '',
        reused: true,
        pending: c.row?.state === DELIVERY_STATE.AUDITED,
        requestId,
      };
    }
    if (c.action === 'unknown') {
      /**
       * 上次结果未知，**绝不自动重发**。
       *
       * 官方配额下重发的代价是双份：可能重复发一条，还会撞上限流。
       * 宁可让人去面板核对一次。
       */
      throw new SendError(
        '这条消息上次的发送结果未知（超时或进程崩溃），不会自动重发。请到面板「投递」页核对',
        'unknown',
      );
    }
    if (c.action === 'wait') {
      throw new SendError('这条消息正在发送中，别重复调用', 'pending');
    }

    try {
      const r = await this.#sendOnce(opts);
      this.delivery.settle(
        requestId,
        r?.pending ? DELIVERY_STATE.AUDITED : DELIVERY_STATE.SENT,
        { msgId: r?.id },
      );
      return { ...r, requestId };
    } catch (e) {
      /**
       * 失败也要结算，否则这一行永远卡在 `pending`。
       *
       * `unknown` 只给「不知道发没发出去」的情况（超时 / 5xx / 连接重置）。
       * `offline` / `expired` / `quota` / `rate` 是**确定没发出去**，记 `failed` 允许重试。
       */
      this.delivery.settle(requestId, uncertainOf(e) ? DELIVERY_STATE.UNKNOWN : DELIVERY_STATE.FAILED, {
        code: e?.code || 'error',
      });
      throw e;
    }
  }

  async #sendOnce({ kind, target, chatKey, payload, receivedAt }) {
    if (kind !== 'group' && kind !== 'c2c') {
      throw new SendError(`不支持的会话类型: ${kind}`, 'api');
    }
    if (!this.isOnline()) {
      this.stats.offline += 1;
      /**
       * 错误消息要**带上下一步怎么办**。
       *
       * 只解释原因（「没连上」）时，调用方只能自己猜是重试还是放弃；
       * 写明「等它上线」，它就知道这类错误不该重试。
       */
      throw new SendError(
        '机器人当前没有连上 QQ，消息发不出去。等它重新上线再试（面板「运行」页能看状态）。',
        'offline',
      );
    }

    const body = { ...payload };
    // 约定：payload 用 api.js 的驼峰字段（msgId / msgSeq），由 api.js 转成 msg_id / msg_seq
    const wantPassive = Boolean(body.msgId);
    let active = !wantPassive;
    let degraded = false;

    // 1) 被动窗口检查：快过期就别发请求了，直接按主动消息处理
    if (wantPassive) {
      const age = receivedAt ? Date.now() - receivedAt : 0;
      const safeMs = PASSIVE_SAFE_MS[kind];
      if (age > safeMs) {
        if (!this.downgrade) {
          this.stats.expired += 1;
          throw new SendError(
            `这条消息已经过去 ${Math.round(age / 1000)} 秒，超过 QQ 的 ${Math.round(safeMs / 1000)} 秒被动回复窗口，回复发不出去了`,
            'expired',
          );
        }
        delete body.msgId;
        delete body.msgSeq;
        active = true;
        degraded = true;
        this.stats.degraded += 1;
        log.warn(
          `被动窗口已过（${Math.round(age / 1000)}s），降级为主动消息 · ${chatKey}`,
        );
      }
    }

    // 2) 排队 + 限速 + 额度扣减 + 实际发送
    //    额度的「查」和「扣」都放在队列里，避免两个并发推送同时通过检查后超额
    return this.#enqueue(chatKey, async () => {
      // 2a) 被动回复次数上限：群聊 5 次、单聊 4 次
      //     同一条消息被多个插件连着回、或用户一句话触发多轮时很容易撞上，
      //     本地先拦，省得服务端返回 40034128 再兜底
      let passiveNow = wantPassive && !active;
      if (passiveNow) {
        const maxReplies = PASSIVE_MAX_REPLIES[kind];
        const used = this.passiveCount.get(body.msgId) ?? 0;
        if (used >= maxReplies) {
          if (!this.downgrade) {
            this.stats.expired += 1;
            throw new SendError(
              `同一条消息最多回复 ${maxReplies} 次（QQ 官方限制），这条已经回满了。\n` +
                `等用户再说一句，就能继续用被动回复。`,
              'expired',
            );
          }
          delete body.msgId;
          delete body.msgSeq;
          passiveNow = false;
          active = true;
          degraded = true;
          this.stats.degraded += 1;
          log.warn(
            `同一条消息已回复 ${used} 次，达到官方上限，降级为主动消息 · ${chatKey}`,
          );
        } else {
          this.passiveCount.set(body.msgId, used + 1);
          this.#prunePassiveCount();
        }
      }

      // 2b) 主动消息额度：日额度 + 分钟额度，两个都要过
      if (active) {
        const used = await this.quota.used(chatKey);
        if (used >= this.dailyActive) {
          this.stats.quotaBlocked += 1;
          throw new SendError(
            `这个会话今天的主动消息额度已用完（${this.dailyActive} 条/天），QQ 不再允许主动推送。\n` +
              `等用户 @ 一次机器人，就能继续用被动回复。`,
            'quota',
          );
        }
        /**
         * 分钟限流单独一个 code（`rate`），**不能和日额度共用 `quota`**。
         *
         * 两者的「多久能好」差三个数量级：日额度要等跨天，分钟限流等一分钟。
         * 以前都叫 `quota`，调用方只能按最坏情况处理——dsh-roost 的主动搭话
         * 会把「发得太密」当成「今天说满了」，直接放弃一整天。
         * 反过来按最好情况处理，就是每分钟重试一次空转到跨天。
         */
        if (!this.#allowActiveThisMinute(chatKey)) {
          this.stats.rateBlocked += 1;
          throw new SendError(
            `这个会话的主动消息发得太密（官方限制 ${this.activePerMin} 条/分钟），**等 1 分钟**就好。`,
            'rate',
          );
        }
        await this.quota.consume(chatKey);
      }

      try {
        const r = await this.#post(kind, target, body, active ? '主动' : '被动');
        if (active) this.stats.active += 1;
        else this.stats.passive += 1;
        if (r?.pending) this.stats.audit += 1;
        return { ...r, degraded };
      } catch (e) {
        // 被动回复没发出去，把这次占用的次数退回去，不然 5 次额度会白白烧掉
        if (passiveNow) {
          const n = this.passiveCount.get(body.msgId) ?? 0;
          if (n > 0) this.passiveCount.set(body.msgId, n - 1);
        }
        // 主动消息是「先扣后发」，发失败要把额度退回去
        if (active) await this.quota.refund(chatKey).catch(() => {});
        // 被动回复被服务端判定过期（本地时钟差或排队等太久），再降级试一次
        const canRetry =
          wantPassive && !active && this.downgrade && this.#looksExpired(e);
        if (!canRetry) throw e;

        const used = await this.quota.used(chatKey);
        if (used >= this.dailyActive || !this.#allowActiveThisMinute(chatKey)) {
          this.stats.expired += 1;
          throw new SendError(
            'QQ 判定这条被动回复已过期，且主动消息额度不够补救',
            'expired',
          );
        }
        await this.quota.consume(chatKey);
        const fallback = { ...body };
        delete fallback.msgId;
        delete fallback.msgSeq;
        log.warn(`被动回复被拒（${e.message}），改发主动消息 · ${chatKey}`);
        const r = await this.#post(kind, target, fallback, '降级主动');
        this.stats.degraded += 1;
        this.stats.active += 1;
        if (r?.pending) this.stats.audit += 1;
        return { ...r, degraded: true };
      }
    });
  }

  /* ---------------- 内部 ---------------- */

  async #post(kind, target, body, how = '') {
    const r = kind === 'group'
      ? await this.api.sendGroup(target, body)
      : await this.api.sendC2C(target, body);

    // 发出去了什么。放在这里而不是调用处：三个调用点（正常 / 降级 / 审核中）
    // 都要打，写在一处不会漏
    const where = String(target ?? '').slice(0, 10) || '-';
    const what = briefOf(body) || '(空)';

    // 主动消息需要审核，接口会用业务码返回「审核中」，这不是失败
    if (r && typeof r === 'object' && Number(r.code) === CODE_AUDIT) {
      log.info(`发出 ${kind} →${where}（${how}·审核中）：${what}`);
      return { pending: true, id: r.id ?? '', raw: r };
    }
    log.info(`发出 ${kind} →${where}${how ? `（${how}）` : ''}：${what}`);
    return { id: r?.id ?? '', raw: r };
  }

  /** 从异常里判断是不是「被动窗口过期」这类可降级的错误 */
  #looksExpired(e) {
    const text = `${e?.message ?? ''} ${JSON.stringify(e?.body ?? {})}`.toLowerCase();
    return (
      text.includes('msg_id') ||
      text.includes('expire') ||
      text.includes('过期') ||
      text.includes('超时') ||
      text.includes('40034')
    );
  }

  /**
   * 最近 60 秒这个会话发了几条。
   *
   * 只读，不占坑——`#allowActiveThisMinute` 会顺手把当前时刻压进队列，
   * 诊断用的时候不能有这个副作用（面板刷一次就少一次额度就离谱了）。
   */
  rateUsed(chatKey, now = Date.now()) {
    return (this.activeLog.get(chatKey) ?? []).filter((t) => now - t < 60_000).length;
  }

  /**
   * 主动消息分钟级限流。官方单关系维度是 20/qpm，
   * 日额度够但一分钟内猛发照样会被服务端 40034100 拦下，本地先挡。
   * @returns {boolean} 这一分钟还允许发吗（允许时顺便占一个坑）
   */
  #allowActiveThisMinute(chatKey) {
    if (this.activePerMin <= 0) return true;
    const now = Date.now();
    const list = (this.activeLog.get(chatKey) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= this.activePerMin) {
      this.activeLog.set(chatKey, list);
      return false;
    }
    list.push(now);
    this.activeLog.set(chatKey, list);
    // 会话数很多时别让这张表无限长
    if (this.activeLog.size > 500) {
      const oldest = this.activeLog.keys().next().value;
      if (oldest !== undefined) this.activeLog.delete(oldest);
    }
    return true;
  }

  /** 被动次数表不能无限长，超了丢最旧的（和 api.js 的 seqMap 一个套路） */
  #prunePassiveCount() {
    if (this.passiveCount.size <= 2000) return;
    const oldest = this.passiveCount.keys().next().value;
    if (oldest !== undefined) this.passiveCount.delete(oldest);
  }

  /**
   * 同一会话串行执行，并保证 1 秒内不超过 perSec 条。
   * 不同会话之间互不影响，可以并行。
   */
  #enqueue(chatKey, task) {
    let q = this.queues.get(chatKey);
    if (!q) {
      q = { chain: Promise.resolve(), history: [] };
      this.queues.set(chatKey, q);
    }
    const run = q.chain.then(async () => {
      await this.#throttle(q);
      return task();
    });
    // 链不能因为某次失败就断掉
    q.chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #throttle(q) {
    for (;;) {
      const now = Date.now();
      q.history = q.history.filter((t) => now - t < 1000);
      if (q.history.length < this.perSec) {
        q.history.push(now);
        return;
      }
      this.stats.throttled += 1;
      const wait = 1000 - (now - q.history[0]) + 10;
      if (wait > 0) await sleep(wait);
    }
  }

  /* ---------------- 状态 ---------------- */

  async quotaSnapshot() {
    return this.quota.snapshot();
  }

  /** 给 /status 和面板用的一行摘要 */
  async summary() {
    const used = await this.quota.snapshot();
    const total = Object.values(used).reduce((a, b) => a + b, 0);
    return {
      ...this.stats,
      perSec: this.perSec,
      dailyActive: this.dailyActive,
      activePerMinute: this.activePerMin,
      activeUsedToday: total,
      activeByChat: used,
    };
  }

  async flush() {
    await this.quota.flush();

    /**
     * 等排队中的发送发完再退出。
     *
     * 以前只刷额度账本、完全不看 `this.queues`：重启/更新/关机时，
     * 用户看到命令执行了，回复却永远没发出去，额度还照扣。
     * 最多等 5 秒，超时就明确说丢了几条。
     */
    const chains = [...this.queues.values()].map((q) => q.chain);
    if (chains.length) {
      let timedOut = false;
      const timeout = new Promise((resolve) => {
        const t = setTimeout(() => {
          timedOut = true;
          resolve();
        }, 5000);
        t.unref?.();
      });
      await Promise.race([Promise.allSettled(chains), timeout]);
      if (timedOut) {
        log.warn(`退出前还有 ${this.queues.size} 个会话的发送任务没排完，已放弃等待`);
      }
    }
  }
}

/** 把 SendError 翻译成给用户看的话；非 SendError 返回 null */
export function userFacingSendError(e) {
  if (e instanceof SendError) return e.message;
  return null;
}
