import { createLogger } from './logger.js';

const log = createLogger('pipeline');

/** 中间件主动拦消息时抛的哨兵，用它区分「拦下」和「崩了」 */
const HALT = Symbol('roost.halt');

/**
 * 中间件管道（洋葱模型）。
 *
 * 借鉴 Koishi 的 middleware 与 NoneBot 的 matcher 思路：
 * 一条消息从入口到插件之间要过一串中间件，每个中间件可以选择
 *   - 调用 next() 放行
 *   - 直接返回（不调 next），消息就此终止
 *   - 修改 ctx 上的字段再放行
 *
 * 好处是去重、白名单、限流、冷却、会话粘性这些横切逻辑
 * 不再是写死在分发函数里的一坨 if，插件也能注册自己的中间件。
 */

export class Pipeline {
  constructor({ metrics = null } = {}) {
    /** 该机器人自己的指标，中间件出错计数写这里 */
    this.metrics = metrics;
    /** @type {{name:string, fn:Function, pluginId:string|null}[]} */
    this.items = [];
  }

  /**
   * 注册中间件。
   * @param {string} name 名称，重名会覆盖（方便热重载插件时替换）
   * @param {(ctx:object, next:Function)=>Promise<void>} fn
   * @param {{pluginId?:string, before?:string, after?:string}} [opts]
   */
  use(name, fn, opts = {}) {
    if (typeof fn !== 'function') throw new Error(`中间件 ${name} 必须是函数`);
    this.remove(name);

    const item = { name, fn, pluginId: opts.pluginId ?? null };
    if (opts.before) {
      const i = this.items.findIndex((x) => x.name === opts.before);
      if (i >= 0) {
        this.items.splice(i, 0, item);
        return this;
      }
    }
    if (opts.after) {
      const i = this.items.findIndex((x) => x.name === opts.after);
      if (i >= 0) {
        this.items.splice(i + 1, 0, item);
        return this;
      }
    }
    this.items.push(item);
    return this;
  }

  remove(name) {
    const i = this.items.findIndex((x) => x.name === name);
    if (i >= 0) this.items.splice(i, 1);
    return this;
  }

  /** 插件卸载时清掉它注册的所有中间件 */
  removeByPlugin(pluginId) {
    this.items = this.items.filter((x) => x.pluginId !== pluginId);
  }

  /**
   * 跑完整条链。返回 true 表示消息被放行到底，false 表示中途被拦下。
   * @param {object} ctx 至少要包含 msg
   */
  async run(ctx) {
    let halted = false;

    /**
     * 内置中间件都是 `ctx.halt('dedup')` 这样拦消息的，但调用方只传了
     * `{ msg, cfg, commandEntry }`——ctx 上根本没有 halt。于是拦截分支抛
     * TypeError，被下面的 catch 当成「中间件自己崩了」吞掉并继续 dispatch，
     * 结果是**去重/白名单/限流/冷却全部形同不存在**，还每条消息白记一次 error。
     *
     * 这里把 halt 注入进去，用哨兵异常把调用栈干净地展开。
     */
    const scope = Object.assign(ctx, {
      halt: () => {
        halted = true;
        throw HALT;
      },
    });

    const dispatch = async (idx) => {
      const item = this.items[idx];
      if (!item) return;
      let called = false;
      const next = async () => {
        if (called) throw new Error(`中间件 ${item.name} 重复调用了 next()`);
        called = true;
        await dispatch(idx + 1);
      };
      try {
        await item.fn(scope, next);
        if (!called) halted = true;
      } catch (e) {
        // 主动拦截：正常流程，不打日志、不算错误
        if (e === HALT) return;
        this.metrics?.bump('errors');
        log.error(`中间件 ${item.name} 出错，跳过该中间件继续:`, e.message);
        // 中间件自己崩了不该把消息吞掉，继续往下走
        if (!called) await dispatch(idx + 1);
      }
    };

    await dispatch(0);
    return !halted;
  }

  names() {
    return this.items.map((x) => x.name);
  }
}

/* ------------------------------------------------------------------ */
/* 内置中间件                                                          */
/* ------------------------------------------------------------------ */

/** 去重：同一条消息可能因断线重连被重复投递 */
export function dedupMiddleware(cfg, { metrics = null } = {}) {
  const seen = new Map();

  return async (ctx, next) => {
    const msg = ctx.msg;
    const win = (cfg.dedupWindowSec ?? 0) * 1000;
    if (win <= 0 || !msg.id) return next();

    const now = Date.now();
    const hit = seen.get(msg.id);
    if (hit && now - hit < win) {
      metrics?.bump('dedup');
      ctx.halt('dedup');
      return;
    }
    seen.set(msg.id, now);

    if (seen.size > 1000) {
      for (const [k, t] of seen) {
        if (now - t > win) seen.delete(k);
        else break;
      }
    }
    return next();
  };
}

/** 白名单：只响应名单内的群 / 用户 */
export function whitelistMiddleware(cfg, { metrics = null } = {}) {
  return async (ctx, next) => {
    const wl = cfg.whitelist ?? {};
    if (!wl.enabled) return next();

    const msg = ctx.msg;
    const okGroup = msg.kind === 'group' && (wl.groups ?? []).includes(msg.groupId);
    const okUser = (wl.users ?? []).includes(msg.userId);
    if (!okGroup && !okUser) {
      metrics?.bump('rejected');
      log.debug(`白名单拦截: kind=${msg.kind} group=${msg.groupId} user=${msg.userId}`);
      ctx.halt('whitelist');
      return;
    }
    return next();
  };
}

/**
 * 限流：每个会话每分钟上限。
 * 只对「@机器人」「带前缀」或「处在免@窗口内」的消息生效——
 * 普通闲聊先交给插件判断，不该因为群友聊天把额度耗光。
 */
export function ratelimitMiddleware(cfg, { isSticky = () => false, metrics = null } = {}) {
  const rate = new Map();

  return async (ctx, next) => {
    const rl = cfg.rateLimit ?? {};
    const msg = ctx.msg;
    const addressed = msg.mentioned || msg.isCommand || isSticky(msg.chatId);
    if (!rl.enabled || !msg.chatId || !addressed) return next();

    const limit = Math.max(1, rl.perChatPerMinute ?? 30);
    const now = Date.now();
    const rec = rate.get(msg.chatId) ?? { count: 0, start: now };
    if (now - rec.start > 60_000) {
      rec.count = 0;
      rec.start = now;
    }
    rec.count += 1;
    rate.set(msg.chatId, rec);

    if (rate.size > 500) {
      for (const [k, v] of rate) {
        if (now - v.start > 60_000) rate.delete(k);
      }
    }

    if (rec.count > limit) {
      metrics?.bump('limited');
      // 只在刚好越界时提醒一次，避免刷屏
      if (rec.count === limit + 1) {
        msg.reply(`本会话每分钟最多 ${limit} 条，请稍后再试。`).catch(() => {});
      }
      ctx.halt('ratelimit');
      return;
    }
    return next();
  };
}

/**
 * 命令冷却：同一个命令在同一个会话里，N 秒内只响应一次。
 * 插件注册命令时可以声明 cooldown 秒数，没声明就跳过。
 */
export function cooldownMiddleware() {
  const last = new Map(); // `${chatId}|${command}` -> ts

  return async (ctx, next) => {
    const msg = ctx.msg;
    const entry = ctx.commandEntry;
    const cd = Number(entry?.cooldown ?? 0);
    if (!entry || cd <= 0 || !msg.chatId) return next();

    const key = `${msg.chatId}|${entry.name}`;
    const now = Date.now();
    const prev = last.get(key) ?? 0;
    if (now - prev < cd * 1000) {
      const left = Math.ceil((cd * 1000 - (now - prev)) / 1000);
      ctx.halt('cooldown');
      // 冷却提示做成可关，免得群里刷屏
      if (ctx.cfg?.cooldownHint !== false) {
        msg.reply(`这个命令 ${left} 秒后才能再用`).catch(() => {});
      }
      return;
    }
    last.set(key, now);

    if (last.size > 2000) {
      for (const [k, t] of last) {
        if (now - t > cd * 1000) last.delete(k);
      }
    }
    return next();
  };
}

/** 按配置组装默认管道 */
export function createDefaultPipeline(cfg, { isSticky, metrics = null } = {}) {
  const p = new Pipeline({ metrics });
  p.use('dedup', dedupMiddleware(cfg, { metrics }));
  p.use('whitelist', whitelistMiddleware(cfg, { metrics }));
  p.use('ratelimit', ratelimitMiddleware(cfg, { isSticky, metrics }));
  p.use('cooldown', cooldownMiddleware());
  return p;
}
