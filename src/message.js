import { createLogger } from './logger.js';
import { FILE_TYPE } from './api.js';
import { messageKindOf, EVENTS } from './events.js';
import { renderMenuMd } from './markdown.js';

const log = createLogger('message');

/**
 * 事件 → 会话类型 的映射来自 src/events.js 的登记表，
 * 那里维护了官方全部 42 个事件，只有标了 message 的才会规范化成 Message。
 */
export function isMessageEvent(name) {
  return Boolean(messageKindOf(name));
}

/**
 * @ 的格式：<@2409AB55F21D2ACFED13223632472280>
 * ID 可能是十进制，也可能是十六进制大写串，所以不能只匹配 \d+。
 */
const MENTION_RE = /<@!?[0-9A-Za-z]+>/g;
const MENTION_TEST = /<@!?[0-9A-Za-z]+>/;

/** 去掉正文里的 @xxx，保留其余内容 */
function stripMention(content) {
  return String(content ?? '')
    .replace(MENTION_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 正文里是否 @ 了机器人。
 * 优先用官方给的 mentions 数组（带 is_you 标记，最准），
 * 没有该字段时退回正则匹配。
 */
function detectMention(d) {
  if (Array.isArray(d?.mentions) && d.mentions.length) {
    return d.mentions.some((m) => m && (m.is_you || m.bot));
  }
  return MENTION_TEST.test(String(d?.content ?? ''));
}

/**
 * 把官方事件体统一成好用的 Message 对象，插件只跟它打交道。
 */
export function buildMessage(eventName, d, { api, cfg, outbound, session }) {
  const kind = messageKindOf(eventName) ?? 'unknown';

  let groupId = '';
  let userId = '';
  const userName = d.author?.username ?? '';
  if (kind === 'group') {
    groupId = d.group_openid ?? '';
    userId = d.author?.member_openid ?? d.author?.id ?? '';
  } else if (kind === 'c2c') {
    userId = d.author?.user_openid ?? d.author?.id ?? '';
  } else if (kind === 'guild') {
    groupId = d.channel_id ?? '';
    userId = d.author?.id ?? '';
  } else if (kind === 'dm') {
    groupId = d.guild_id ?? '';
    userId = d.author?.id ?? '';
  }

  const content = stripMention(d.content);
  const prefix = cfg.commandPrefix || '/';
  const isCommand = content.startsWith(prefix);
  const mentioned = detectMention(d);
  const chatId = groupId || userId;
  const receivedAt = Date.now();

  // 没 @ 也不算命令，但可能处在免@窗口内 —— 此时同样算「在跟机器人说话」
  const sticky = Boolean(session?.isSticky(chatId));
  const addressed = mentioned || isCommand || sticky;

  const msg = {
    id: d.id ?? '',
    kind,
    event: eventName,
    // 事件元信息（属于哪个 intent、中文说明），来自 src/events.js
    eventMeta: EVENTS[eventName] ?? null,
    groupId,
    userId,
    userName,
    chatId,
    content,
    raw: d,
    mentioned,
    /**
     * 本条消息 @ 了谁（不含机器人自己）。
     * 官方在 d.mentions 里给的是 [{ id / member_openid / user_openid, is_you, bot }]，
     * 各事件字段名不统一，这里统一成 [{ id, isBot }]，做 PvP、点名类玩法直接用。
     */
    mentions: (Array.isArray(d?.mentions) ? d.mentions : [])
      .map((m) => ({
        id: m?.id ?? m?.member_openid ?? m?.user_openid ?? '',
        isBot: Boolean(m?.is_you || m?.bot),
      }))
      .filter((m) => m.id && !m.isBot),
    sticky,
    addressed,
    isCommand,
    receivedAt, // 被动回复窗口从这里开始算，出站调度器要用
    replied: false, // 任何发送动作都会置为 true，供内核判断「有没有插件回应」
    command: '',
    args: [],
    at: Number(d.timestamp) || receivedAt,
  };

  if (isCommand) {
    const body = content.slice(prefix.length).trim();
    const [cmd, ...rest] = body.split(/\s+/);
    msg.command = (cmd || '').toLowerCase();
    msg.args = rest;
  }

  // 底层发送：group 走群接口，c2c 走单聊接口。
  // 一律经过 outbound，由它处理 5 分钟窗口、每秒限速、主动消息额度。
  const send = (opts, passive) => {
    if (kind !== 'group' && kind !== 'c2c') return Promise.resolve(null);
    const body = passive ? { msgId: msg.id, ...opts } : { ...opts };
    msg.replied = true;

    if (!outbound) {
      // 兜底：没有调度器（例如早期调用方）就直接发
      return kind === 'group' ? api.sendGroup(groupId, body) : api.sendC2C(userId, body);
    }
    return outbound.send({
      kind,
      target: kind === 'group' ? groupId : userId,
      chatKey: `${kind}:${chatId}`,
      payload: body,
      receivedAt,
    });
  };

  /* ---------------- 回复合并 ---------------- */

  // 一次消息处理中可能有多个插件都要回复（命令 + 监听器 + 被动触发），
  // 逐条发出去会刷屏。所以先攒起来，处理完统一发一条。
  const replyBuf = [];
  const MAX_CHUNK = 1500; // 单条上限，超了按行切成多条

  /**
   * 被动回复（带 msg_id，5 分钟内有效）。
   * **不会立刻发出**，而是攒到本次处理结束，由 flushReplies() 合并成一条。
   * 想立刻发用 msg.replyNow()。
   */
  msg.reply = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    replyBuf.push({ text: String(text), opts });
    msg.replied = true; // 立刻标记，内核据此判断「这条消息有人管」
    return Promise.resolve(null);
  };

  /** 绕过合并，立刻发一条 */
  msg.replyNow = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    return send({ content: String(text), ...opts }, true);
  };

  /**
   * 把攒下的回复合并成一条发出去。由内核在本次处理结束时调用。
   * 同一段文本内的 opts 只取第一条的（合并后就是一条消息，没法各带各的）。
   */
  msg.flushReplies = async () => {
    if (!replyBuf.length) return null;
    const items = replyBuf.splice(0, replyBuf.length);
    const opts = items[0].opts ?? {};
    const merged = items.map((x) => x.text).join('\n');

    // 超长按行切，避免一条消息塞不下被平台拒
    const chunks = [];
    let cur = '';
    for (const line of merged.split('\n')) {
      if (cur && (cur.length + 1 + line.length) > MAX_CHUNK) {
        chunks.push(cur);
        cur = line;
      } else {
        cur = cur ? `${cur}\n${line}` : line;
      }
    }
    if (cur) chunks.push(cur);

    let last = null;
    for (const c of chunks) last = await send({ content: c, ...opts }, true);
    return last;
  };

  /** 主动推送（不带 msg_id，有频次限制） */
  msg.push = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    return send({ content: String(text), ...opts }, false);
  };

  /** Markdown 消息（可带按钮 keyboard）。Markdown 是独立消息类型，先把攒的文本发掉 */
  msg.replyMarkdown = async (markdown, keyboard) => {
    await msg.flushReplies();
    return send({ markdown, keyboard }, true).catch((e) => {
      log.error('发送 Markdown 失败:', e.message);
      return null;
    });
  };

  /**
   * 发一条带**可点击指令**的菜单（markdown 消息）。
   *
   * 群聊用 `<qqbot-cmd-input>`（点了把指令插进输入框，用户自己按发送），
   * 单聊 / 频道用 `<qqbot-cmd-enter>`（点了直接发）。
   * 这两种标签只能在 markdown 消息里生效，普通文本里会显示成原始标签。
   *
   * @param {string} title 大标题
   * @param {Array<{title:string, items:Array<{text:string, desc?:string, cmd?:string}>}>} groups
   * @param {object} [opts] { keyboard } 需要真按钮时传
   */
  msg.replyMenu = async (title, groups, opts = {}) => {
    const content = renderMenuMd(title, groups, { kind });
    return msg.replyMarkdown({ content }, opts.keyboard);
  };

  /**
   * 发一条**模板消息**：markdown 正文 + 按钮 + ark 结构化模板一次带出去。
   *
   * 为什么不直接用 replyMarkdown：这三样属于同一条消息的不同部分，
   * 分三次发会变成三条独立消息，用户看到的是三块碎片。
   *
   *   await msg.replyCard({
   *     markdown: { content: '## 今日运势\n> 大吉' },
   *     keyboard: { content: { rows: [...] } },
   *   });
   *
   * ark 和 markdown 同时给时以 markdown 为准（官方不支持一条消息两种富文本）。
   *
   * @param {{markdown?:object, keyboard?:object, ark?:object}} card
   */
  msg.replyCard = async (card = {}) => {
    const { markdown, keyboard } = card;
    let { ark } = card;
    if (!markdown && !ark) return null;
    /**
     * 一条消息只能有一种富文本：两个都给时**以 markdown 为准**，ark 丢掉。
     * 必须在这里丢，不能靠下层——api 的 #payload 是先写 markdown 后写 ark，
     * 两个都传进去 msg_type 会被改成 3（ark 赢），和这里说的正好相反。
     */
    if (markdown && ark) {
      log.warn('replyCard 同时给了 markdown 和 ark，已忽略 ark（一条消息只支持一种富文本）');
      ark = undefined;
    }
    await msg.flushReplies();
    return send({ markdown, keyboard, ark }, true).catch((e) => {
      log.error('发送模板消息失败:', e.message);
      return null;
    });
  };

  /** 发富媒体：上传后以 msg_type=7 发送。图片是独立消息，先把攒的文本发掉 */  const replyMedia = async (fileType, source, { local = false } = {}) => {
    if (!source) return null;
    await msg.flushReplies();
    try {
      const scene = kind === 'group' ? 'group' : 'c2c';
      const target = kind === 'group' ? groupId : userId;
      if (scene !== 'group' && scene !== 'c2c') return null;

      const up = local
        ? await api.uploadLocalFile(scene, target, source, fileType)
        : await api.uploadMedia(scene, target, { fileType, url: source });
      if (!up?.file_info) throw new Error('未返回 file_info');

      return await send({ msgType: 7, content: ' ', media: { file_info: up.file_info } }, true);
    } catch (e) {
      log.error(`发送富媒体(type=${fileType}) 失败:`, e.message);
      return null;
    }
  };

  msg.replyImage = (src, opts) => replyMedia(FILE_TYPE.IMAGE, src, opts);
  msg.replyVideo = (src, opts) => replyMedia(FILE_TYPE.VIDEO, src, opts);
  msg.replyVoice = (src, opts) => replyMedia(FILE_TYPE.VOICE, src, opts);
  msg.replyFile = (src, opts) => replyMedia(FILE_TYPE.FILE, src, opts);

  /**
   * 发一张内存里的图片（Buffer）。
   *
   * 渲染类插件用得上：画完直接发，不用先落盘再读回来，
   * 也不用自己拼 base64 和 file_info。
   */
  msg.replyImageBuffer = async (buf, { fileType = FILE_TYPE.IMAGE } = {}) => {
    if (!buf?.length) return null;
    await msg.flushReplies();
    try {
      const scene = kind === 'group' ? 'group' : 'c2c';
      const target = kind === 'group' ? groupId : userId;
      if (scene !== 'group' && scene !== 'c2c') return null;

      const up = await api.uploadMedia(scene, target, {
        fileType,
        fileData: Buffer.from(buf).toString('base64'),
        reuse: false, // base64 本来就不进缓存
      });
      if (!up?.file_info) throw new Error('未返回 file_info');
      return await send({ msgType: 7, content: ' ', media: { file_info: up.file_info } }, true);
    } catch (e) {
      log.error('发送图片 Buffer 失败:', e.message);
      return null;
    }
  };

  /**
   * 流式回复（**仅单聊**，官方没有群聊的流式接口）。
   *
   * 适合 AI 打字机效果：一边生成一边往下发，不用等整段生成完。
   * 返回一个对象，用法：
   *
   *   const s = msg.replyStream();
   *   await s.push('正在想');        // 第一片，index 自动递增
   *   await s.push('正在想……');
   *   await s.end('这是完整答案');    // 最后一片，input_state=10
   *
   * 内部自动维护 index 和 stream_msg_id，插件不用管。
   * 走的是「replace」模式——每次传全量正文，服务端会算差量，
   * 所以内容必须以上次已下发的前缀开头，不能中途改写前面的话。
   */
  msg.replyStream = (opts = {}) => {
    if (kind !== 'c2c') {
      // 群聊没有流式接口，退化成普通 markdown 回复，别让插件崩
      return {
        push: async (text) => msg.replyMarkdown({ content: String(text ?? '') }),
        end: async (text) => msg.replyMarkdown({ content: String(text ?? '') }),
      };
    }

    let index = 0;
    let streamId = opts.streamMsgId || '';
    const target = userId;

    return {
      /** 发一片。返回服务端生成的 stream_msg_id（第一片才有） */
      async push(contentRaw) {
        const r = await api.sendStreamMessage(target, {
          contentRaw,
          index: index++,
          state: 1,
          mode: 'replace',
          streamMsgId: streamId || undefined,
          msgId: msg.id,
          isWakeup: opts.isWakeup,
        });
        if (r?.id && !streamId) streamId = r.id;
        return r;
      },
      /** 结束流。contentRaw 传最终全量正文 */
      async end(contentRaw) {
        return api.sendStreamMessage(target, {
          contentRaw,
          index: index++,
          state: 10,
          mode: 'replace',
          streamMsgId: streamId || undefined,
          msgId: msg.id,
          isWakeup: opts.isWakeup,
        });
      },
    };
  };

  return msg;
}
