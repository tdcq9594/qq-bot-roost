/**
 * 插件测试夹具
 * ============
 *
 * 目的：写插件时不用开机器人、不用开面板、不用连 QQ，就能跑一个命令看回复。
 *
 *   import { runCommand } from '../src/plugin/testkit.js';
 *   const plugin = (await import('./index.js')).default;
 *   const out = await runCommand(plugin, 'roll', { content: '/roll 6' });
 *   console.log(out.replies);   // ['🎲 4 / 6 ...']
 *
 * 它造的是**假 ctx 和假 msg**，只实现插件真正会用到的那部分能力。
 * 真跑一遍完整内核太重，也没必要——这里要的是「这段逻辑对不对」。
 */

import os from 'node:os';
import path from 'node:path';

/** 假的存储：全放内存，跑完就没了 */
function memoryStorage() {
  const map = new Map();
  return {
    async get(k, d) {
      return map.has(k) ? map.get(k) : d;
    },
    async set(k, v) {
      map.set(k, v);
    },
    async delete(k) {
      return map.delete(k);
    },
    async has(k) {
      return map.has(k);
    },
    async all() {
      return Object.fromEntries(map);
    },
    async keys() {
      return [...map.keys()];
    },
    async clear() {
      map.clear();
    },
    /** 和真实存储一致的原子读改写；fn 返回 null/undefined 表示放弃写入 */
    async update(k, fn, fallback = undefined) {
      const cur = map.has(k) ? map.get(k) : fallback;
      const next = await fn(cur);
      if (next === null || next === undefined) return cur;
      map.set(k, next);
      return next;
    },
    __map: map,
  };
}

/** 假的 logger：默认不打印，需要时传 quiet: false */
function fakeLogger(quiet) {
  const noop = () => {};
  if (quiet) return { debug: noop, info: noop, warn: noop, error: noop };
  return {
    debug: (...a) => console.debug('[debug]', ...a),
    info: (...a) => console.log('[info]', ...a),
    warn: (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
  };
}

/**
 * 造一个够用的 ctx。
 * @param {object} [opts]
 */
export function makeCtx({ id = 'test', config = {}, quiet = true, dataDir = null } = {}) {
  const commands = new Map();
  const menus = [];
  const listeners = new Map();
  const scheduled = [];

  const ctx = {
    id,
    name: id,
    version: '0.0.0',
    prefix: '/',
    config: { ...config },
    state: {},
    storage: memoryStorage(),
    // 插件要落文件（图片缓存之类）时用；不传就给个临时目录
    dataDir: dataDir ?? path.join(os.tmpdir(), `roost-plugin-${id}-${process.pid}`),
    logger: fakeLogger(quiet),
    md: {
      cmdInput: (cmd, text) => `<qqbot-cmd-input cmd="${cmd}" show="${text}" />`,
      cmdEnter: (cmd) => `<qqbot-cmd-enter cmd="${cmd}" />`,
      esc: (s) => String(s ?? ''),
    },
    api: new Proxy(
      {},
      {
        // 没实现的 api 方法调用时给个明确错误，而不是 undefined is not a function
        get: (_, name) => async () => {
          throw new Error(`测试夹具没有实现 ctx.api.${String(name)}，需要的话自己 stub`);
        },
      },
    ),

    command(pattern, meta, handler) {
      // 模式里的第一个词就是命令名，和内核的解析保持一致
      const name = String(pattern).trim().split(/\s+/)[0];
      commands.set(name, handler);
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    menu(title, items) {
      menus.push({ title, items });
    },
    schedule(name, everyMs, fn) {
      scheduled.push({ name, everyMs, fn });
    },
    onTeardown(fn) {
      scheduled.push({ name: 'teardown', everyMs: 0, fn });
    },

    // 权限：测试里默认「有权限」，需要测拒绝时传 can: () => false
    CORE_LEVELS: { OWNER: 0, ADMIN: 1, GROUP_ADMIN: 2, HELPER: 3 },
    levelBase: 10,
    levelRange: { base: 10, end: 19 },
    level: (offset = 0) => 10 + offset,
    defineLevels(map) {
      const out = {};
      let i = 0;
      for (const k of Object.keys(map)) out[k] = 10 + (map[k] ?? i++);
      return out;
    },
    isOwner: () => false,
    levelOf: async () => 9999,
    can: async () => true,
    scopeOf: (msg) => (msg?.groupId ? `group:${msg.groupId}` : `user:${msg?.userId ?? ''}`),
    isGroupAdmin: async () => false,
    getGroup: async () => null,

    // 其余能力给空实现，插件调用时不会炸
    prompt: async () => null,
    wait: async () => null,
    cancelWait: () => {},
    push: async () => null,
    quotaLeft: async () => 999,
    isSticky: () => false,
    use: () => {},
    setDashboard: (d) => d,
    getDashboard: () => null,
    async setConfig(patch) {
      Object.assign(ctx.config, patch);
      return ctx.config;
    },
    registerPage: () => null,
    dispose: () => {},

    /* 夹具内部用 */
    __commands: commands,
    __menus: menus,
    __listeners: listeners,
    __scheduled: scheduled,
  };

  return ctx;
}

/**
 * 造一条假消息，回复会被收集到 replies 里。
 * @param {object} [p]
 */
/**
 * 造一条假消息。
 *
 * `mentioned` / `sticky` 是可选的：大部分插件不关心「是不是 @ 来的」，
 * 但 AI 对话这类「必须 @ 才回」的插件要靠它区分。
 * 默认 false 保持和以前一样的行为。
 */
export function makeMsg({
  content = '',
  userId = 'u1',
  userName = '测试用户',
  groupId = 'g1',
  kind = 'group',
  mentioned = false,
  sticky = false,
  mentions = null,
  raw = null,
} = {}) {
  const replies = [];
  /** markdown 消息单独记一份，好断言「走的是富文本还是纯文本」 */
  const markdowns = [];
  const prefix = '/';
  const isCommand = content.startsWith(prefix);
  const body = isCommand ? content.slice(prefix.length).trim() : content;
  const parts = body.split(/\s+/).filter(Boolean);

  const msg = {
    id: `test-${Date.now()}`,
    kind,
    event: 'GROUP_AT_MESSAGE_CREATE',
    groupId: kind === 'group' ? groupId : '',
    userId,
    userName,
    chatId: groupId || userId,
    content,
    command: isCommand ? parts[0] ?? '' : '',
    args: isCommand ? parts.slice(1) : parts,
    isCommand,
    mentioned,
    // 和 message.js 保持一致：@ 了、是命令、或还在免 @ 窗口里，都算「在跟我说话」
    addressed: mentioned || isCommand || sticky,
    sticky,
    mentions: mentions ?? [],
    raw: raw ?? (kind === 'group' ? { author: { member_role: 'member' } } : {}),
    receivedAt: Date.now(),
    replied: false,
    replies,
    markdowns,

    async reply(text) {
      msg.replied = true;
      replies.push(String(text));
      return { id: 'x' };
    },
    async replyNow(text) {
      return msg.reply(text);
    },
    async push(text) {
      return msg.reply(text);
    },
    async flushReplies() {
      return null;
    },
    async replyMarkdown(md) {
      msg.replied = true;
      const content = md?.content ?? '';
      replies.push(content);
      markdowns.push({ ...md, content });
      return { id: 'x' };
    },
    async replyMenu(title, groups) {
      msg.replied = true;
      replies.push(`${title}\n${JSON.stringify(groups)}`);
      return { id: 'x' };
    },
    async replyCard(card) {
      msg.replied = true;
      replies.push(card?.markdown?.content ?? '[card]');
      return { id: 'x' };
    },
    async replyImage(src, opts = {}) {
      msg.replied = true;
      // opts.text 走的是 msg_type=7 的 content（图文同一条消息）。
      // 记在同一条回复里，测试才能断言「没分两条发」。
      replies.push(opts?.text ? `[image] ${src} :: ${opts.text}` : `[image] ${src}`);
      return { id: 'x' };
    },
    async replyVideo(src) {
      return msg.replyImage(src);
    },
    async replyVoice(src) {
      return msg.replyImage(src);
    },
    async replyFile(src) {
      return msg.replyImage(src);
    },
    async replyImageBuffer() {
      msg.replied = true;
      replies.push('[image buffer]');
      return { id: 'x' };
    },
    replyStream() {
      return {
        push: async (t) => msg.reply(t),
        end: async (t) => (t === undefined ? null : msg.reply(t)),
      };
    },
  };

  return msg;
}

/**
 * 跑一个命令。
 *
 * @param {object} plugin 插件默认导出
 * @param {string} command 命令名（不带前缀）
 * @param {object} [opts] content / userId / groupId / config / ctx
 * @returns {Promise<{replies:string[], msg:object, ctx:object, handled:boolean}>}
 */
export async function runCommand(plugin, command, opts = {}) {
  const ctx = opts.ctx ?? makeCtx({ id: plugin?.id ?? 'test', config: opts.config ?? {} });
  // 用标记而不是「命令表为空」判断：有的插件只注册菜单，命令表本来就是空的
  if (!ctx.__setup) {
    ctx.__setup = true;
    await plugin.setup(ctx);
  }

  const handler = ctx.__commands.get(command);
  if (!handler) {
    const names = [...ctx.__commands.keys()].join(', ') || '（一个都没有）';
    throw new Error(`插件 ${plugin?.id} 没有注册命令「${command}」。已注册：${names}`);
  }

  const msg = makeMsg({
    content: opts.content ?? `/${command}`,
    userId: opts.userId,
    groupId: opts.groupId,
    kind: opts.kind,
    mentioned: opts.mentioned,
    mentions: opts.mentions,
    raw: opts.raw,
  });

  await handler(msg, { args: msg.args, raw: msg.content });
  await msg.flushReplies();

  return { replies: msg.replies, msg, ctx, handled: msg.replied };
}

/** 跑一次被动监听（'message' 事件），返回有没有人接 */
export async function runListeners(plugin, msg, ctx = null) {
  const c = ctx ?? makeCtx({ id: plugin?.id ?? 'test' });
  if (!c.__setup) {
    c.__setup = true;
    await plugin.setup(c);
  }
  const list = c.__listeners.get('message') ?? [];
  for (const l of list) {
    const r = await l(msg);
    if (r === true) return true;
  }
  return false;
}
