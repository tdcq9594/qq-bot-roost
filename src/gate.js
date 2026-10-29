/**
 * 暂停闸
 * ======
 *
 * 一句话：**任何一只鸟、任何一个会话，都能在不改配置、不重启的前提下闭嘴，
 * 而且面板说得出「为什么不能说」。**
 *
 * 为什么需要它：以前 `grep -rn "paused" src/` 零命中。一只鸟配错了
 * （人格写飞、模型抽风、群选错了），重启之后立刻对几个群开口，**没有刹车**。
 * 唯一能止住的办法是关进程——那连别的鸟一起停了。
 *
 * 三级闸取「与」：任一道关着就不说话。
 *
 *   global（进程级）→ bot（每只鸟）→ chat（每个会话）
 *                                  ↘ silence（静默：带 until，到期自动解除）
 *
 * ## 为什么按鸟拆文件
 *
 * 一个进程里可能同时跑好几只鸟，它们共用一个 `gate.json` 的话，
 * `.tmp` + `rename` 只能保证「不会写坏」，**不能保证不丢更新**——
 * 两只鸟同时改，后写的把先写的覆盖掉，表现是「点了暂停没生效」。
 *
 * 所以：`data/gate/global.json` 放全局闸，`data/gate/<botId>.json` 放这只鸟的
 * bot/chat/silence。跨鸟只有全局那一个文件，而且它是低频写，进程内串行化就够。
 *
 * ## 为什么不放在 dsh-roost
 *
 * 闸要拦在 pipeline 里。dsh-roost 停了 bot 还在收消息，闸必须比 dsh-roost 活得久。
 */

import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './fsutil.js';

/** 空状态。每次读盘都从它展开，字段少一个也不会 undefined */
const EMPTY = () => ({
  paused: false,
  at: 0,
  by: '',
  reason: '',
  chats: {},
  silence: {},
});

/**
 * @param {object} o
 * @param {string} o.dir     闸文件目录（`data/gate`）
 * @param {string} o.botId   这只鸟的 id
 * @param {(m:string)=>void} [o.log]
 */
export function createGate({ dir, botId, log = () => {} }) {
  const globalFile = path.join(dir, 'global.json');
  const botFile = path.join(dir, `${botId}.json`);

  let global = EMPTY();
  let bot = EMPTY();
  let opened = false;
  /** 第一次读盘时文件存不存在，`pauseOnStart` 要用 */
  let botExisted = false;
  let globalExisted = false;

  /**
   * 写盘串行化。
   *
   * 同一只鸟的两个会话几乎不会同时改闸，但面板连点、插件批量改群闸
   * 是可能并发的。串行化保证「读-改-写」不会互相覆盖。
   */
  let chain = Promise.resolve();

  /**
   * 读盘。
   *
   * @returns {Promise<{botExisted:boolean, globalExisted:boolean}>}
   *   `botExisted=false` 表示这只鸟从来没写过闸文件（首次运行），
   *   `gate.pauseOnStart` 靠它判断「要不要自动暂停」——
   *   每次启动都暂停会让日常重启很难受，用户第一反应是「坏了」。
   */
  async function open() {
    if (opened) return { botExisted, globalExisted };
    const [g, b] = await Promise.all([
      readJsonSafe(globalFile, (m) => log(`全局闸：${m}`)),
      readJsonSafe(botFile, (m) => log(`闸状态：${m}`)),
    ]);
    botExisted = b !== null;
    globalExisted = g !== null;
    global = { ...EMPTY(), ...(g ?? {}) };
    bot = { ...EMPTY(), ...(b ?? {}) };
    opened = true;
    return { botExisted, globalExisted };
  }

  function saveGlobal() {
    const snap = { ...global };
    chain = chain.then(() => writeJsonAtomic(globalFile, snap)).catch((e) => {
      log(`全局闸写盘失败：${e.message}`);
    });
    return chain;
  }

  function saveBot() {
    const snap = { ...bot };
    chain = chain.then(() => writeJsonAtomic(botFile, snap)).catch((e) => {
      log(`闸状态写盘失败：${e.message}`);
    });
    return chain;
  }

  /** 把 meta 归一成落盘字段，`by` 用来说明是谁改的（面板 / 插件 id / 命令行） */
  const metaOf = (m = {}) => ({
    at: Date.now(),
    by: String(m.by ?? '').slice(0, 40),
    reason: String(m.reason ?? '').slice(0, 200),
  });

  /**
   * 这只鸟现在能不能对 `chatId` 说话。
   *
   * **只回答闸的部分**。网关在线、额度、插件启停由 `bot.canSpeak()` 汇总——
   * 那些状态不在闸的职责里，混进来会让这个模块变成「什么都知道一点」。
   *
   * @param {string} chatId
   * @param {number} [now]
   * @returns {{ok:boolean, reasons:{code:string,text:string,until?:number}[]}}
   */
  function check(chatId, now = Date.now()) {
    const reasons = [];

    if (global.paused) {
      reasons.push({
        code: 'gate:global',
        text: `全局暂停${global.reason ? `（${global.reason}）` : ''}`,
      });
    }
    if (bot.paused) {
      reasons.push({
        code: 'gate:bot',
        text: `这只鸟暂停${bot.reason ? `（${bot.reason}）` : ''}`,
      });
    }
    if (chatId) {
      const c = bot.chats?.[chatId];
      if (c?.paused) {
        reasons.push({
          code: 'gate:chat',
          text: `这个会话暂停${c.reason ? `（${c.reason}）` : ''}`,
        });
      }
      const until = Number(bot.silence?.[chatId] ?? 0);
      if (until > now) {
        const mins = Math.ceil((until - now) / 60_000);
        reasons.push({
          code: 'gate:silence',
          text: `静默中，还剩 ${mins} 分钟`,
          until,
        });
      }
    }

    return { ok: reasons.length === 0, reasons };
  }

  /* ---------------- 改闸 ---------------- */

  /**
   * 改全局闸。
   *
   * @param {boolean} paused
   * @param {{by?:string, reason?:string}} [meta]
   * @param {{persist?:boolean}} [opts]
   *   `persist: false` 只改内存不写盘 —— 给 `--paused` 启动参数用。
   *   那是个**一次性的启动意图**（「这次先别说话」），不是「永久暂停」；
   *   写进文件的话，下次不带参数启动却发现还在暂停，人会以为坏了。
   */
  async function setGlobal(paused, meta, { persist = true } = {}) {
    await open();
    global = { ...global, paused: Boolean(paused), ...metaOf(meta) };
    if (persist) await saveGlobal();
    return { ...global };
  }

  async function setBot(paused, meta) {
    await open();
    bot = { ...bot, paused: Boolean(paused), ...metaOf(meta) };
    await saveBot();
    return { ...bot };
  }

  async function setChat(chatId, paused, meta) {
    await open();
    if (!chatId) throw new Error('缺 chatId');
    const chats = { ...(bot.chats ?? {}) };
    if (paused) chats[chatId] = { paused: true, ...metaOf(meta) };
    else delete chats[chatId];
    bot = { ...bot, chats };
    await saveBot();
    return { chatId, paused: Boolean(paused) };
  }

  /**
   * 静默一段时间。
   *
   * `until` 存绝对时间戳而不是「剩余毫秒」：进程重启后剩余时间还得重新算，
   * 而「到几点解除」是事实，重启也成立。
   *
   * @param {string} chatId
   * @param {number} ms 静默多久；`<= 0` 表示解除
   */
  async function setSilence(chatId, ms, meta) {
    await open();
    if (!chatId) throw new Error('缺 chatId');
    const silence = { ...(bot.silence ?? {}) };
    if (ms > 0) silence[chatId] = Date.now() + ms;
    else delete silence[chatId];
    bot = { ...bot, silence };
    await saveBot();
    return { chatId, until: silence[chatId] ?? 0, ...metaOf(meta) };
  }

  /**
   * 重读全局闸。
   *
   * 每只鸟各有一个 gate 实例，各自缓存着一份 `global.json` 的内容。
   * 面板改全局闸时只写了一个文件，其他鸟内存里还是旧值——不加这一步，
   * 「全局暂停」要等重启才对其他鸟生效，等于没做。
   *
   * 只重读全局那一个文件：bot 文件是本实例独有的，重读会把排队中的
   * 改动冲掉。
   */
  async function reloadGlobal() {
    const g = await readJsonSafe(globalFile, (m) => log(`全局闸：${m}`));
    global = { ...EMPTY(), ...(g ?? {}) };
    return { ...global };
  }

  /**
   * 清掉所有已到期的静默。
   *
   * `check()` 里已经按时间判断过了，这里只是别让 `silence` 表无限长——
   * 每静默一次留一条，挂机半年就是几百条无用记录。
   */
  async function prune(now = Date.now()) {
    await open();
    const silence = bot.silence ?? {};
    const alive = Object.entries(silence).filter(([, until]) => Number(until) > now);
    if (alive.length === Object.keys(silence).length) return 0;
    bot = { ...bot, silence: Object.fromEntries(alive) };
    await saveBot();
    return Object.keys(silence).length - alive.length;
  }

  /**
   * 同步快照（不读盘）。
   *
   * `snapshot()` 要 await，而 `/api/status` 是个同步函数、每 2 秒被调一次。
   * 闸在 `init()` 里已经 open 过，内存里就是最新的，没必要每次再读盘。
   */
  function peek() {
    return {
      global: { paused: global.paused, at: global.at, by: global.by, reason: global.reason },
      bot: { paused: bot.paused, at: bot.at, by: bot.by, reason: bot.reason },
    };
  }

  /** 面板用的完整快照（含每会话的闸，方便一次画完） */
  async function snapshot(now = Date.now()) {
    await open();
    return {
      global: { paused: global.paused, at: global.at, by: global.by, reason: global.reason },
      bot: { paused: bot.paused, at: bot.at, by: bot.by, reason: bot.reason },
      chats: Object.entries(bot.chats ?? {}).map(([chatId, v]) => ({
        chatId,
        paused: true,
        at: v.at ?? 0,
        by: v.by ?? '',
        reason: v.reason ?? '',
      })),
      silence: Object.entries(bot.silence ?? {})
        .filter(([, until]) => Number(until) > now)
        .map(([chatId, until]) => ({ chatId, until })),
    };
  }

  /** 退出前把排队的写盘任务等完 */
  async function flush() {
    await chain.catch(() => {});
  }

  return {
    open,
    check,
    peek,
    snapshot,
    reloadGlobal,
    setGlobal,
    setBot,
    setChat,
    setSilence,
    prune,
    flush,
    get dir() {
      return dir;
    },
  };
}

/**
 * 管道中间件：闸关着就不往下走。
 *
 * **必须排在账本之后**。`bot.js` 里 `ledger.append()` 在 `pipeline.run()` 之前，
 * 所以暂停期间的消息照样入账——恢复之后 AI 能看见「你不在的时候群里聊了什么」。
 * 顺序反过来的话，暂停就等于丢消息，而官方没有历史消息接口，丢了补不回来。
 *
 * 拦下时**不回任何话**：静默才是目的，回一句「我暂停了」等于没闭嘴。
 */
export function gateMiddleware(gate, { metrics = null } = {}) {
  return async (ctx, next) => {
    const chatId = ctx.msg?.chatId ?? '';
    const v = gate.check(chatId);
    if (!v.ok) {
      metrics?.bump('gated');
      ctx.halt('gate');
      return;
    }
    return next();
  };
}
