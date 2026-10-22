import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { DIRS } from './paths.js';

const log = createLogger('outbound');

/**
 * 出站消息调度器。
 *
 * QQ 官方接口的硬限制都在这里统一处理，插件和内核都不用关心：
 *
 *   1. 被动回复只有 5 分钟有效期，超时必失败 → 快过期时降级为主动消息
 *   2. 同一会话每秒最多 5 条 → 本地令牌队列，超出的排队等
 *   3. 主动消息每日额度很少且要审核 → 本地记账，用完直接拒绝并说明原因
 *   4. 必须 WebSocket 在线才能发 → 离线时直接拒绝，不浪费一次网络请求
 *   5. 主动消息返回 304023 表示「已进入审核」 → 这不是失败，不能当错误处理
 *
 * 插件只管调 msg.reply()，剩下的交给这里。
 */

/** 官方给的有效期是 5 分钟，留 15 秒给网络和服务端时钟差 */
const PASSIVE_WINDOW_MS = 5 * 60 * 1000;
const PASSIVE_SAFE_MS = PASSIVE_WINDOW_MS - 15_000;

/** 主动消息进入审核的返回码，属于正常结果 */
const CODE_AUDIT = 304023;

/** 带错误码的发送异常，方便调用方分辨该提示用户什么 */
export class SendError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'SendError';
    this.code = code; // offline | expired | quota | api
    this.detail = detail;
  }
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

export class Outbound {
  /**
   * @param {object} opts
   * @param {object} opts.api            QQApi 实例
   * @param {object} opts.cfg            全局配置
   * @param {() => boolean} opts.isOnline 机器人是否已连上网关
   */
  constructor({ api, cfg, isOnline = () => true, quotaFile }) {
    this.api = api;
    this.cfg = cfg;
    this.isOnline = isOnline;

    const o = cfg.outbound ?? {};
    // 官方是 5 条/秒，默认压到 4 条，给其他来源留一点余量
    this.perSec = Math.max(1, o.perSec ?? 4);
    // 主动消息每日每会话额度。官方对频道是 20，群聊按同量保守估计，可配
    this.dailyActive = Math.max(0, o.dailyActive ?? 20);
    this.downgrade = o.downgradeToActive !== false;

    // 额度账本按机器人分开，不同机器人的额度互不影响
    this.quota = new QuotaLedger(quotaFile ?? path.join(DIRS.data, 'quota.json'));
    /** chatKey -> { chain: Promise, history: number[] } */
    this.queues = new Map();

    this.stats = {
      passive: 0,
      active: 0,
      degraded: 0, // 被动超窗降级为主动的次数
      expired: 0, // 因超窗被拒绝的次数
      quotaBlocked: 0, // 因额度用完被拒绝的次数
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
  async send({ kind, target, chatKey, payload, receivedAt }) {
    if (kind !== 'group' && kind !== 'c2c') {
      throw new SendError(`不支持的会话类型: ${kind}`, 'api');
    }
    if (!this.isOnline()) {
      this.stats.offline += 1;
      throw new SendError('机器人当前没有连上 QQ，消息发不出去', 'offline');
    }

    const body = { ...payload };
    // 约定：payload 用 api.js 的驼峰字段（msgId / msgSeq），由 api.js 转成 msg_id / msg_seq
    const wantPassive = Boolean(body.msgId);
    let active = !wantPassive;
    let degraded = false;

    // 1) 被动窗口检查：快过期就别发请求了，直接按主动消息处理
    if (wantPassive) {
      const age = receivedAt ? Date.now() - receivedAt : 0;
      if (age > PASSIVE_SAFE_MS) {
        if (!this.downgrade) {
          this.stats.expired += 1;
          throw new SendError(
            `这条消息已经过去 ${Math.round(age / 1000)} 秒，超过 QQ 的 5 分钟被动回复窗口，回复发不出去了`,
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
      if (active) {
        const used = await this.quota.used(chatKey);
        if (used >= this.dailyActive) {
          this.stats.quotaBlocked += 1;
          throw new SendError(
            `今天这个会话的主动消息额度已用完（${this.dailyActive} 条/天），QQ 不再允许主动推送。\n` +
              `等用户 @ 一次机器人，就能继续用被动回复。`,
            'quota',
          );
        }
        await this.quota.consume(chatKey);
      }

      try {
        const r = await this.#post(kind, target, body);
        if (active) this.stats.active += 1;
        else this.stats.passive += 1;
        if (r?.pending) this.stats.audit += 1;
        return { ...r, degraded };
      } catch (e) {
        // 被动回复被服务端判定过期（本地时钟差或排队等太久），再降级试一次
        const canRetry =
          wantPassive && !active && this.downgrade && this.#looksExpired(e);
        if (!canRetry) throw e;

        const used = await this.quota.used(chatKey);
        if (used >= this.dailyActive) {
          this.stats.expired += 1;
          throw new SendError(
            'QQ 判定这条被动回复已过期，且今天的主动消息额度已用完，无法补救',
            'expired',
          );
        }
        await this.quota.consume(chatKey);
        const fallback = { ...body };
        delete fallback.msgId;
        delete fallback.msgSeq;
        log.warn(`被动回复被拒（${e.message}），改发主动消息 · ${chatKey}`);
        const r = await this.#post(kind, target, fallback);
        this.stats.degraded += 1;
        this.stats.active += 1;
        if (r?.pending) this.stats.audit += 1;
        return { ...r, degraded: true };
      }
    });
  }

  /* ---------------- 内部 ---------------- */

  async #post(kind, target, body) {
    const r = kind === 'group'
      ? await this.api.sendGroup(target, body)
      : await this.api.sendC2C(target, body);

    // 主动消息需要审核，接口会用业务码返回「审核中」，这不是失败
    if (r && typeof r === 'object' && Number(r.code) === CODE_AUDIT) {
      return { pending: true, id: r.id ?? '', raw: r };
    }
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
      activeUsedToday: total,
      activeByChat: used,
    };
  }

  async flush() {
    await this.quota.flush();
  }
}

/** 把 SendError 翻译成给用户看的话；非 SendError 返回 null */
export function userFacingSendError(e) {
  if (e instanceof SendError) return e.message;
  return null;
}
