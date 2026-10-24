import { createLogger } from './logger.js';

const log = createLogger('session');

/**
 * 会话管理：多轮对话 + 免@粘性。
 *
 * 解决官方接口下最难用的两个体验问题：
 *
 *   1. 「必须 @ 才能触发」
 *      官方已全量开放免@唤醒，但仍受群设置影响。这里做一层兜底：
 *      用户 @ 过一次后，N 分钟内该会话的消息都视为「在跟机器人说话」，
 *      插件可以用 msg.addressed 判断，不必每句都 @。
 *
 *   2. 「问一句、答一句」的多轮交互
 *      ctx.prompt() 发出提示后挂起，等这个人（或这个会话）的下一条消息，
 *      拿到就直接返回给插件，不再走命令分发。
 *      文字游戏全靠这个：先问「用哪个技能」，再收答案。
 *
 * 等待是按 (会话, 用户) 精确匹配的，不会串台。
 */

export class SessionManager {
  /**
   * @param {object} opts
   * @param {number} opts.stickyMs      免@窗口时长，0 表示关闭
   * @param {number} opts.waitTimeoutMs 多轮等待的默认超时
   */
  constructor({ stickyMs = 180_000, waitTimeoutMs = 120_000 } = {}) {
    this.stickyMs = stickyMs;
    this.waitTimeoutMs = waitTimeoutMs;

    /** `${chatId}|${userId}` 或 `chat:${chatId}` -> entry */
    this.waits = new Map();
    /** chatId -> 过期时间戳 */
    this.sticky = new Map();

    this.stats = { prompts: 0, answered: 0, timeouts: 0, replaced: 0 };
  }

  /* ---------------- 免@粘性 ---------------- */

  /** 收到 @ 或命令时调用，开启该会话的免@窗口 */
  markAddressed(chatId, ms = this.stickyMs) {
    if (!chatId || ms <= 0) return;
    this.sticky.set(chatId, Date.now() + ms);
    if (this.sticky.size > 500) {
      const now = Date.now();
      for (const [k, until] of this.sticky) {
        if (now > until) this.sticky.delete(k);
      }
    }
  }

  /** 该会话当前是否处于免@窗口内 */
  isSticky(chatId) {
    if (!chatId) return false;
    const until = this.sticky.get(chatId);
    if (!until) return false;
    if (Date.now() > until) {
      this.sticky.delete(chatId);
      return false;
    }
    return true;
  }

  /** 免@窗口剩余秒数，给 /status 显示用 */
  stickyRemain(chatId) {
    const until = this.sticky.get(chatId);
    if (!until) return 0;
    return Math.max(0, Math.round((until - Date.now()) / 1000));
  }

  /* ---------------- 多轮等待 ---------------- */

  /**
   * 等待下一条消息。
   * @param {object} p
   * @param {string} p.chatId
   * @param {string} p.userId
   * @param {'user'|'chat'} [p.from] user=只认这个人，chat=这个会话里谁都算
   * @param {number} [p.timeoutMs]
   * @returns {Promise<object|null>} 超时返回 null
   */
  wait({ chatId, userId, from = 'user', timeoutMs = this.waitTimeoutMs }) {
    const key = from === 'chat' ? `chat:${chatId}` : `${chatId}|${userId}`;

    // 同一个人重复发起等待：旧的作废，避免回答被上一条提示吃掉
    const prev = this.waits.get(key);
    if (prev) {
      this.stats.replaced += 1;
      prev.cancel();
    }

    this.stats.prompts += 1;
    /**
     * 等待期间续一下免@窗口，否则用户回话还得再 @ 一次。
     *
     * 但**不能**用 max(stickyMs, timeoutMs)：timeoutMs 可能是 5 分钟，
     * 那等于让整个群在这 5 分钟里都被当成「在跟机器人说话」，
     * 群里任何一个人开口都会被塞给插件。窗口上限就是配置的 stickyMs。
     */
    this.markAddressed(chatId, this.stickyMs);

    const self = this;
    return new Promise((resolve) => {
      const entry = {
        key,
        chatId,
        userId,
        from,
        resolve,
        cancel() {
          clearTimeout(timer);
          if (self.waits.get(key) === entry) self.waits.delete(key);
          resolve(null);
        },
      };
      const timer = setTimeout(() => {
        if (self.waits.get(key) === entry) self.waits.delete(key);
        self.stats.timeouts += 1;
        resolve(null);
      }, Math.max(1000, timeoutMs));
      // 这里不能 unref：超时回调必须真的触发，否则插件永远等不到结果。
      // 退出时由 session.clear() 统一取消，不会拖住进程。

      self.waits.set(key, entry);
    });
  }

  /**
   * 投递一条消息给等待者。返回 true 表示被消费，调用方应停止后续分发。
   * 优先匹配「指定用户」，再匹配「整个会话」。
   */
  deliver(msg) {
    if (!this.waits.size) return false;

    const userKey = `${msg.chatId}|${msg.userId}`;
    const hit = this.waits.get(userKey) ?? this.waits.get(`chat:${msg.chatId}`);
    if (!hit) return false;

    this.waits.delete(hit.key);
    this.stats.answered += 1;
    log.debug(`会话等待命中: ${hit.key}`);
    hit.resolve(msg);
    return true;
  }

  /** 某人当前是否在等待中 */
  isWaiting(chatId, userId) {
    return this.waits.has(`${chatId}|${userId}`) || this.waits.has(`chat:${chatId}`);
  }

  /** 取消某人的等待（比如插件主动中断流程） */
  cancel(chatId, userId) {
    const key = `${chatId}|${userId}`;
    const e = this.waits.get(key);
    if (e) e.cancel();
  }

  clear() {
    for (const e of [...this.waits.values()]) e.cancel();
    this.waits.clear();
    this.sticky.clear();
  }

  snapshot() {
    return {
      ...this.stats,
      pending: this.waits.size,
      stickyChats: this.sticky.size,
    };
  }
}
