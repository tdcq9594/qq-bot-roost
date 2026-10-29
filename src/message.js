import { createLogger } from './logger.js';
import { FILE_TYPE } from './api.js';
import { messageKindOf, EVENTS } from './events.js';
import { renderMenuMd, mdToPlain } from './markdown.js';

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
const MENTION_RE = /<@!?([0-9A-Za-z]+)>/g;
const MENTION_TEST = /<@!?[0-9A-Za-z]+>/;

/**
 * 去掉正文里的 @xxx，保留其余内容。
 *
 * 两种形态都要处理：
 *   1. 官方文档说的 `<@openid>` / `<@!openid>` —— 正则剥掉
 *   2. **实测中遇到的 `@昵称 ` 纯文本前缀** —— 有些客户端/协议端把 @ 发成
 *      一段普通文字（内容里就是 `@天道酬勤 /kun 菜单`），不剥的话
 *      这条消息永远不以命令前缀开头，`/kun 签到` 根本进不了命令分发。
 *
 * 第 2 种只剥**开头**那一个，且要求后面跟着空白——避免把正文里的
 * `@某人` 误伤（`你好 @张三` 不动）。
 */
function stripMention(content) {
  return String(content ?? '')
    .replace(MENTION_RE, ' ')
    .replace(/^@[^\s@]+\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从正文里捞 @ 的 openid。
 *
 * 官方文档说：消息里 @ 某成员时，content 里会写成 `<@member_openid>`。
 * 也就是说**「@ 了谁」这个信息本来就在正文里**——只是 `stripMention()`
 * 为了让命令解析能正常跑（`<@xxx> /ping` 开头不是 `/`，会被判成非命令），
 * 把它连同其余 @ 一起删掉了。
 *
 * 所以这里在删除**之前**先捞一份出来，和 `d.mentions` 合并。
 * 这样即使官方某个事件类型不返回 mentions 字段，插件照样能知道 @ 了谁。
 *
 * `<@all>` 是 @全体，不是具体的人，跳过。
 */
function mentionsFromContent(content) {
  const out = [];
  for (const m of String(content ?? '').matchAll(MENTION_RE)) {
    const id = m[1];
    if (!id || id.toLowerCase() === 'all') continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
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
 * 附件归一化。
 *
 * 官方事件里的 `attachments[]` 是图片 / 语音 / 视频 / 文件**唯一**的载体——
 * `content` 里只有文字。以前完全没解析，等于图片和语音全丢。
 *
 * 语音特别值钱，官方直接给了两样东西，不用自己造：
 *   - `asr_refer_text`  语音的 ASR 参考结果（不用自己跑识别）
 *   - `voice_wav_url`   SILK 转好的 WAV 地址（不用自己转码）
 *
 * @param {any[]} list 事件里的 attachments 数组
 * @returns {Array<object>}
 */
export function parseAttachments(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    const ct = String(a.content_type ?? '');
    const type = ct === 'voice'
      ? 'voice'
      : ct.startsWith('image/')
        ? 'image'
        : ct.startsWith('video/')
          ? 'video'
          : ct === 'file'
            ? 'file'
            : 'other';
    out.push({
      type,
      url: String(a.url ?? ''),
      filename: String(a.filename ?? ''),
      size: Number(a.size) || 0,
      width: Number(a.width) || 0,
      height: Number(a.height) || 0,
      contentType: ct,
      /** 语音专用：SILK 转好的 WAV 地址，可直接喂给 ASR */
      wavUrl: String(a.voice_wav_url ?? ''),
      /** 语音专用：官方给的 ASR 参考结果 */
      asrText: String(a.asr_refer_text ?? ''),
      raw: a,
    });
  }
  return out;
}

/**
 * `message_scene` 归一化。
 *
 * `ext` 是 `["msg_idx=REFIDX_x", "ref_msg_idx=TMP_x", "auth_token=x"]` 这种
 * key=value 字符串数组。其中：
 *   - `msg_idx`      **本条消息**的引用索引 → 回复时塞进 `message_reference.message_id`
 *   - `ref_msg_idx`  本条消息**引用了谁** → 想顺着引用链往上找时用
 *
 * 以前这两个值全丢了，所以「引用回复」根本做不了。
 */
export function parseMessageScene(d) {
  const ext = d?.message_scene?.ext;
  const map = {};
  for (const item of Array.isArray(ext) ? ext : []) {
    const s = String(item ?? '');
    const i = s.indexOf('=');
    if (i > 0) map[s.slice(0, i)] = s.slice(i + 1);
  }
  return {
    source: String(d?.message_scene?.source ?? ''),
    msgIdx: map.msg_idx ?? '',
    refMsgIdx: map.ref_msg_idx ?? '',
    authToken: map.auth_token ?? '',
  };
}

/** ARK 卡片（B 站分享、小程序、位置卡…）结构化 */
function parseArk(a) {
  if (!a || typeof a !== 'object') return null;
  const f = a.fields && typeof a.fields === 'object' ? a.fields : {};
  return {
    type: String(a.ark_type ?? ''),
    name: String(a.ark_name ?? ''),
    prompt: String(a.prompt ?? ''),
    title: String(f.title ?? ''),
    desc: String(f.desc ?? ''),
    url: String(f.jump_url ?? ''),
    fields: f,
    raw: a,
  };
}

/**
 * `msg_elements` 归一化（递归）。
 *
 * message_type：0 普通文本 / 3 结构化卡片 / 101 并行消息 /
 *               **102 聊天记录（合并转发）** / **103 引用消息**
 *
 * 102 就是「合并转发」——以前我们说官方没有合并转发，其实是官方推了、
 * 我们没解析。103 是引用，`content` 里是那段被引用的原文。
 */
export function parseElements(list, depth = 0) {
  const out = [];
  if (depth > 3) return out; // 官方嵌套不会很深，防畸形数据把栈打穿
  for (const el of Array.isArray(list) ? list : []) {
    if (!el || typeof el !== 'object') continue;
    const mt = Number(el.message_type);
    const type =
      mt === 0 ? 'text'
        : mt === 3 ? 'ark'
          : mt === 101 ? 'parallel'
            : mt === 102 ? 'chatRecord'
              : mt === 103 ? 'quote'
                : 'other';
    const author = el.author && typeof el.author === 'object' ? el.author : null;
    out.push({
      type,
      messageType: mt,
      msgIdx: String(el.msg_idx ?? ''),
      author: author
        ? {
          id: String(author.member_openid ?? author.user_openid ?? author.id ?? ''),
          name: String(author.username ?? ''),
          isBot: Boolean(author.bot),
        }
        : null,
      content: String(el.content ?? ''),
      attachments: parseAttachments(el.attachments),
      ark: parseArk(el.ark_data),
      children: parseElements(el.msg_elements, depth + 1),
      raw: el,
    });
  }
  return out;
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

  /**
   * 官方事件里以前被整个丢掉的载荷。
   * 不解析的话，图片 / 语音 / 卡片 / 引用 / 合并转发在插件眼里只剩一段文字。
   */
  const attachments = parseAttachments(d?.attachments);
  const scene = parseMessageScene(d);
  const ark = parseArk(d?.ark_data);
  const elements = parseElements(d?.msg_elements);

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
     *
     * 两个来源合并：
     *   1. `d.mentions`——字段名各事件不统一，可能是 id / member_openid / user_openid，
     *      而且带 `is_you` / `bot` 标记，能准确排除机器人自己
     *   2. **正文里的 `<@openid>`**——官方文档明确说 @ 成员时 content 里就是这个格式。
     *      以前 `stripMention()` 把它删了，于是「@ 了谁」这个信息白白丢掉，
     *      插件只能让用户手填 openid。现在删之前先捞一份。
     *
     * 合并时 declared 优先：它知道谁是机器人，正文里认不出来。
     */
    mentions: (() => {
      const declared = (Array.isArray(d?.mentions) ? d.mentions : [])
        .map((m) => ({
          id: m?.id ?? m?.member_openid ?? m?.user_openid ?? '',
          isBot: Boolean(m?.is_you || m?.bot),
          // 昵称带上：禁言/踢人成功时能回「已禁言 张三」，比一串 openid 好认
          name: String(m?.username ?? '').trim(),
        }))
        .filter((m) => m.id);
      const fromText = mentionsFromContent(d?.content).map((id) => ({ id, isBot: false, name: '' }));

      const seen = new Set();
      const out = [];
      for (const m of [...declared, ...fromText]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (!m.isBot) out.push(m);
      }
      return out;
    })(),

    /**
     * 同上，但**不排除机器人自己**。
     *
     * 插件用 `mentions`（点名单选人的时候不该把机器人算进去），
     * 日志和排查用这个——`@机器人 /禁言 1m` 里被 @ 的机器人恰好是
     * mentions 过滤掉的那个，日志里只剩 `<@2409AB55…>`，看不出 @ 了谁。
     */
    allMentions: (() => {
      const declared = (Array.isArray(d?.mentions) ? d.mentions : [])
        .map((m) => ({
          id: m?.id ?? m?.member_openid ?? m?.user_openid ?? '',
          isBot: Boolean(m?.is_you || m?.bot),
          name: String(m?.username ?? '').trim(),
        }))
        .filter((m) => m.id);
      const fromText = mentionsFromContent(d?.content).map((id) => ({ id, isBot: false, name: '' }));

      const seen = new Set();
      const out = [];
      for (const m of [...declared, ...fromText]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push(m);
      }
      return out;
    })(),

    /* ---------------- 官方载荷（2026-10-26 补齐） ---------------- */

    /** 附件全量：图片 / 语音 / 视频 / 文件 */
    attachments,
    /** 只取图片，插件最常用（喂视觉模型） */
    images: attachments.filter((a) => a.type === 'image'),
    /** 只取语音；`asrText` 是官方 ASR 结果，`wavUrl` 是转好的 WAV */
    voices: attachments.filter((a) => a.type === 'voice'),
    /** 其余附件（视频 / 文件 / 未知） */
    files: attachments.filter((a) => a.type === 'video' || a.type === 'file' || a.type === 'other'),
    /** { source, msgIdx, refMsgIdx, authToken } */
    scene,
    /** 本条消息的引用索引 → 回复时当 message_reference 用 */
    msgIdx: scene.msgIdx,
    /** 本条消息引用了谁 */
    refMsgIdx: scene.refMsgIdx,
    /** 卡片消息（B 站分享 / 小程序 / 位置卡…），没有就是 null */
    ark,
    /** 消息元素：102 聊天记录（合并转发）、103 引用、101 并行 */
    elements,
    /** 这条消息本身如果是「引用某条」，这里是被引用的原文（拿不到就是空串） */
    quoted: elements.find((e) => e.type === 'quote')?.content ?? '',

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
  // 一律经过 outbound，由它处理被动窗口（群聊 5 分钟 / 单聊 60 分钟）、每秒限速、主动消息额度。
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

  /**
   * 消息认领。
   *
   * 有的插件是「关键词触发」的（回声、养鲲、群管），它们处理过一条消息之后，
   * 别的插件不该再对同一条消息说话——否则群里会看到两个人同时回答。
   *
   * 认领之后，**没声明 `seeClaimed` 的插件就收不到这条消息了**。
   * 顺序由插件的 `priority` 决定（高的先跑），所以「AI 对话」这类
   * 什么都想接的插件把 priority 调低，让专门的插件先认领。
   *
   *   // 插件里
   *   if (matched) { msg.claim(); ... }
   *
   * 也可以直接 `return true`——内核会替你认领。
   */
  msg.claimedBy = '';
  msg.claim = () => {
    if (!msg.claimedBy) msg.claimedBy = msg.pluginId || 'unknown';
    return true;
  };

  // 一次消息处理中可能有多个插件都要回复（命令 + 监听器 + 被动触发），
  // 逐条发出去会刷屏。所以先攒起来，处理完统一发一条。
  const replyBuf = [];
  const MAX_CHUNK = 1500; // 单条上限，超了按行切成多条

  /**
   * 被动回复（带 msg_id，群聊 5 分钟内、单聊 60 分钟内有效）。
   * **不会立刻发出**，而是攒到本次处理结束，由 flushReplies() 合并成一条。
   * 想立刻发用 msg.replyNow()。
   */
  msg.reply = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    /**
     * 记下是谁在回。
     *
     * 同一条消息可能有好几个插件都想回（比如「回声」接关键词、
     * 「AI 对话」接提问）。这些回复会攒起来合并成一条发出去，
     * 合并时得让人看出哪句是谁说的——不然群里看到一坨混在一起的文字，
     * 根本分不清是哪个功能在说话。
     *
     * 这两个字段由 bot.js 在调用插件前设上，插件自己不用管。
     */
    replyBuf.push({
      text: String(text),
      opts,
      pluginId: msg.pluginId ?? '',
      pluginName: msg.pluginName ?? '',
    });
    msg.replied = true; // 立刻标记，内核据此判断「这条消息有人管」
    return Promise.resolve(null);
  };

  /** 绕过合并，立刻发一条 */
  msg.replyNow = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    return send({ content: String(text), ...opts }, true);
  };

  /**
   * 引用回复：以「引用某条消息」的样式发出去（官方 `message_reference`）。
   *
   * 跟 `reply()` 不是一回事：
   *   - `reply()` 是**被动回复**，靠 msg_id，群聊 5 分钟 / 5 次，单聊 60 分钟 / 4 次
   *   - 这个是**引用**，靠 `REFIDX`，视觉上带"回复某某"的引用块
   *
   * 默认引用当前这条消息（用它的 `msg_idx`）。想引用别的传 `refIdx`。
   * 拿不到引用索引时自动退化成普通回复，不会因为缺字段发不出去。
   */
  msg.replyQuote = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    const { refIdx, ...rest } = opts;
    const ref = String(refIdx || msg.msgIdx || '');
    if (!ref) return msg.replyNow(text, rest);
    return send({ content: String(text), messageReference: { message_id: ref }, ...rest }, true);
  };

  /**
   * 把攒下的回复合并成一条发出去。由内核在本次处理结束时调用。
   * 同一段文本内的 opts 只取第一条的（合并后就是一条消息，没法各带各的）。
   */
  msg.flushReplies = async () => {
    if (!replyBuf.length) return null;
    const items = replyBuf.splice(0, replyBuf.length);
    const opts = items[0].opts ?? {};

    /**
     * 合并策略：**多个插件都回了才加标题**。
     *
     *   【回声】          ← 只有出现两个及以上插件时才有这行
     *   你好呀
     *
     *   【AI 对话】
     *   你好，我是 AI
     *
     * 只有一个插件回时不加——那种情况下加标题纯属噪音，
     * 而且会把现有插件的输出格式全改掉。
     *
     * 同一个插件的多段回复并进它自己那一块，不重复加标题。
     */
    const groups = new Map(); // pluginId -> { name, texts[] }
    for (const it of items) {
      const key = it.pluginId || '';
      if (!groups.has(key)) groups.set(key, { name: it.pluginName || '', texts: [] });
      groups.get(key).texts.push(it.text);
    }

    let merged;
    if (groups.size > 1) {
      merged = [...groups.values()]
        .map((g) => {
          const body = g.texts.join('\n');
          // 拿不到插件名（匿名回复）就只放正文，别留个空标题
          return g.name ? `【${g.name}】\n${body}` : body;
        })
        .join('\n\n');
    } else {
      merged = items.map((x) => x.text).join('\n');
    }

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
    for (const c of chunks) {
      /**
       * 单条发失败不能把整轮处理带崩。
       *
       * 调用方（bot.js 的 finally）是 `await msg.flushReplies()`，这里一抛就变成
       * 未捕获 rejection；掉线瞬间、被动窗口过期、主动额度用尽都会走到这条路。
       * 结果是**一个群的一条消息发不出去，所有机器人一起退出**。
       */
      try {
        last = await send({ content: c, ...opts }, true);
      } catch (e) {
        log.warn(`回复发送失败（${chunks.length > 1 ? '分段 ' : ''}已跳过）：${e.message}`);
      }
    }
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
    try {
      return await send({ markdown, keyboard }, true);
    } catch (e) {
      /**
       * Markdown 是**独立消息类型**，没有纯文本兜底：平台不放行（没权限、
       * 内容被判不合规）就整条发不出去。而所有 `ctx.menu()` 出来的菜单都是
       * markdown——不降级的话，用户点菜单看到的是「什么都没发生」。
       *
       * 只在「服务端明确拒了」时降级（4xx）。理由：
       *   · 5xx / 网络错误 有可能已经送达，重发会变成两条；
       *   · 429 是限流，换纯文本一样被限，白烧一次；
       *   · offline / expired / quota 换纯文本也发不出去，expired/quota 还会多扣额度。
       */
      const status = Number(e?.status) || 0;
      const rejected = (status >= 400 && status < 500 && status !== 429) || e?.code === 'api';
      if (!rejected) {
        log.error('发送 Markdown 失败:', e.message);
        return null;
      }
      const plain = mdToPlain(markdown);
      if (!plain) {
        log.error(`Markdown 被拒（${e.message}），且降不出纯文本`);
        return null;
      }
      /**
       * 不带 keyboard：按钮挂在纯文本上平台不认，带上会连累整条消息再被拒一次。
       * 按钮里的指令本来也会出现在正文里（ctx.menu 渲染时带上），信息不丢。
       */
      log.warn(`Markdown 被拒（${e.message}），降级为纯文本重发`);
      return send({ content: plain }, true).catch((e2) => {
        log.error('降级纯文本也没发出去:', e2.message);
        return null;
      });
    }
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

  /**
   * 发富媒体：上传后以 msg_type=7 发送。
   *
   * 富媒体在官方接口里只能是独立消息（msg_type=7），但这条消息自带
   * `content` 文本字段：传了 `text` 就和图走**同一条**，不用先发一句话
   * 再发一张图（那是两条消息，群里看着是两截）。不传 text 时保持老
   * 行为——content 给一个空格（官方不接受空 content）。
   *
   * 发送前会先把攒着的文本 flush 掉，免得「缓冲中的回复」被这条
   * 富媒体消息挤成顺序错乱的两条。
   */
  const replyMedia = async (fileType, source, { local = false, text = '' } = {}) => {
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

      const content = text ? String(text) : ' ';
      return await send({ msgType: 7, content, media: { file_info: up.file_info } }, true);
    } catch (e) {
      log.error(`发送富媒体(type=${fileType}) 失败:`, e.message);
      return null;
    }
  };

  /**
   * 发图片。`opts.text` 会作为这条富媒体消息的正文，和图同一条发出：
   *
   *   await msg.replyImage(file, { local: true, text: '横图 2290×1200' });
   *
   * 不传 text 就只发图（老行为）。
   */
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
