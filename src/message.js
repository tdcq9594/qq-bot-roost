import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { FILE_TYPE, MEDIA_SOFT_LIMIT, MEDIA_HARD_LIMIT, DIRECT_UPLOAD_LIMIT } from './api.js';
import { messageKindOf, EVENTS } from './events.js';
import { renderMenuMd, mdToPlain } from './markdown.js';
import {
  parseReplyNodes,
  decideReplyMode,
  renderReplyMarkdown,
  renderFallback,
  hasLocalImageNode,
  hintForReason,
  classifyUploadFailure,
} from './reply-auto.js';
import { newTraceId } from './trace.js';

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
 * 图文卡片（`msg_type=8`）的官方硬约束，发之前先查一遍。
 *
 * 为什么要自己查：官方对参数不合规只回一个 `304061 消息内容无效`，
 * **不说是哪个字段**。四个字段里有一个超长或写成了 http，日志里就只有
 * 这么一句话，排查全靠逐个试。在这里提前拦下，日志能直接写
 * 「description 要 1–200 字（当前 231）」。
 *
 * 长度按字符算（`.length`）：中文一个字算一位，跟官方「1–50 字符」对齐。
 * emoji 会占 2 位——这只会让判断偏严，不会放过超长的内容。
 *
 * @returns {string} 不合格的原因；空串表示通过
 */
function tuwenProblem({ title, description, url, picUrl } = {}) {
  const len = (v) => String(v ?? '').length;
  if (!len(title)) return 'title 不能为空';
  if (len(title) > 50) return `title 要 1–50 字（当前 ${len(title)}）`;
  if (!len(description)) return 'description 不能为空';
  if (len(description) > 200) return `description 要 1–200 字（当前 ${len(description)}）`;
  for (const [name, v] of [['url', url], ['picUrl', picUrl]]) {
    if (!len(v)) return `${name} 不能为空`;
    /** 官方：必须是 https；http 会被拒，而且报的同样是 304061 */
    if (!/^https:\/\//i.test(String(v))) return `${name} 必须是 https 开头`;
    if (len(v) > 1024) return `${name} 超过 1024 字符（当前 ${len(v)}）`;
  }
  return '';
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
 *
 * @param {object} [p.identity] 身份对照表（`IdentityStore`）。没传就是没启用绑定，
 *   所有 `uin` / `*Aliases` 字段一律空，老行为不变。
 */
export function buildMessage(eventName, d, { api, cfg, outbound, session, traceId, identity }) {
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

  /**
   * 身份对照：openid 换机器人就变，QQ号 / 群号不变。
   *
   * 这里只**查表**，不做任何自动匹配——认人只能靠管理员在面板「身份」页绑一次。
   * 未绑定一律给空串、不抛错：内核每条消息都要过这里，抛错会把消息吞掉。
   * 插件要「没绑就提示管理员」，用 `ctx.identity.requireOpenid()`，那条路才抛。
   *
   * `userAliases` / `groupAliases` 是读旧记忆的备用键：号码本身 + 这个号码名下
   * 所有 openid（含别的机器人的）。**人和群必须分成两组**——合成一个数组，
   * 群会话就会读到私聊记忆，这种串场很难在事后发现。
   *
   * 只在群聊 / 单聊算：频道（guild/dm）的 `channel_id`、`guild_id` 不是 openid，
   * 拿它去对照 QQ号没有意义。
   */
  const idOn = Boolean(identity) && (kind === 'group' || kind === 'c2c');
  const idUser = idOn ? identity.resolveUser(cfg?.id, userId) : null;
  const idGroup = idOn && kind === 'group' ? identity.resolveGroup(cfg?.id, groupId) : null;
  // 记一次「见过」（内部有 60 秒节流，不会每条消息都写盘）
  if (idUser) identity.touch({ kind: 'user', uin: idUser.uin, botId: cfg?.id, scope: `${kind}:${chatId}` });
  if (idGroup) identity.touch({ kind: 'group', uin: idGroup.uin, botId: cfg?.id, scope: `group:${chatId}` });

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
    /**
     * 链路 id：这一条消息从进站到回话的唯一标识。
     *
     * 生成点必须在内核——它先看到原始事件；插件只是路过，
     * 让插件生成会出现「同一条消息被两个插件各生成一个 id」。
     */
    traceId: String(traceId || newTraceId()),
    /**
     * 内核拿到这条事件的时间。四段耗时的第一段靠它算：
     * 官方事件到达 → 插件真正拿到，中间是内核的分发排队。
     */
    receivedAt,
    kind,
    event: eventName,
    // 事件元信息（属于哪个 intent、中文说明），来自 src/events.js
    eventMeta: EVENTS[eventName] ?? null,
    groupId,
    userId,
    userName,
    chatId,

    /* ---------------- 身份（QQ号 / 群号 ↔ openid） ---------------- */

    /**
     * QQ号。面板绑过才有，否则空串。
     *
     * **给 AI 看的时候号码优先、openid 兜底**：openid 换机器人就变，
     * 号码不变。有号码时按号码认人，没有才退回 openid。
     */
    uin: idUser?.uin ?? '',
    /** 群号，同上 */
    groupUin: idGroup?.uin ?? '',
    /** 跨机器人稳定的身份 id：人 `u:<QQ号>`、群 `g:<群号>` */
    identityId: idUser?.identityId ?? '',
    groupIdentityId: idGroup?.identityId ?? '',
    /** 读旧记忆的备用键：号码 + 该号码名下所有 openid（不含当前 chatId） */
    userAliases: idUser ? identity.aliasesOf('user', idUser.uin, userId) : [],
    groupAliases: idGroup ? identity.aliasesOf('group', idGroup.uin, groupId) : [],

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
    /**
     * `requestId` **不是官方字段**，要从 body 里摘出来单独传给 outbound——
     * 混进去会被 api.js 当成未知参数一路带到接口上。
     *
     * 它是投递账本的幂等键（阶段 5）：同一个 id 再调一次只发一条。
     * 没有它就退回原来的「发一次算一次」。
     */
    /**
     * `plugin` 同理要摘出来：它只用于账本归属（v3），
     * 混进 body 会被 `api.js` 的白名单丢掉（不会 400），
     * 但会让 payload 里多一个谁也看不懂的字段。
     */
    /**
     * `fileType` 也摘出来：它只用于账本给「（图片）/（语音）/（文件）」占位，
     * 混进 body 会被 api 当未知参数带出去。
     */
    const { requestId, plugin, fileType, ...rest } = opts ?? {};
    /**
     * 出站归属统一在这里注入 —— **一处覆盖所有发送路径**。
     *
     * 以前只在 `flushReplies` 拼 `plugins`，于是 `replyMarkdown` /
     * `replyMedia` / `replyImageBuffer` 这些绕过攒批的路径全部漏掉，
     * 真机 549 行里 `plugin` 非空 0 条就是这么来的。
     * `msg.pluginId` 由 bot.js 在分发前设置；`bot.js:1035` 是串行 await，
     * 异步回话时它不会被后续监听器覆盖。
     */
    const sender = String(plugin ?? msg.pluginId ?? '');
    const body = passive ? { msgId: msg.id, ...rest } : { ...rest };
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
      ...(requestId ? { requestId: String(requestId) } : {}),
      ...(sender ? { plugin: sender } : {}),
      ...(fileType ? { fileType: Number(fileType) } : {}),
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
    /**
     * 带插件归属（v3）。
     *
     * `msg.reply` 那条路走 `flushReplies`，会从 `replyBuf` 里拼出 `plugins`；
     * 但 `replyNow`（多段直发）**绕过合并**，直接调 `send`。真机实测两条出站
     * 记录的 `plugin` 都是空，就是这么漏的。这里从 `msg.pluginId` 补上——
     * 它由 `bot.js` 在调监听器之前设好，闭包里拿得到。
     */
    return send({
      content: String(text),
      ...opts,
      ...(msg.pluginId ? { plugin: String(msg.pluginId) } : {}),
    }, true);
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
     * 这条合并消息里出现了哪些插件（去重、逗号分隔）。
     *
     * 一个群的一轮里可能有「回声」和「AI 对话」都回了，合并成一条发出去，
     * 正文里有 `【回声】` 这种标题，但那是文本、查不了。账本要的是可过滤的列。
     */
    const plugins = [...new Set(items.map((i) => i.pluginId).filter(Boolean))].join(',');

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
        last = await send({ content: c, ...opts, ...(plugins ? { plugin: plugins } : {}) }, true);
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

  /**
   * Markdown 消息（可带按钮 keyboard）。Markdown 是独立消息类型，先把攒的文本发掉。
   *
   * `opts.requestId`：投递账本的幂等键。以前这条路完全绕开账本——
   * 插件给了 id 也只对纯文本生效，markdown 那条永远记不上，重发就会重复。
   * 第三个参数是可选的，老调用方不传，行为不变。
   */
  msg.replyMarkdown = async (markdown, keyboard, opts = {}) => {
    await msg.flushReplies();
    try {
      return await send({ markdown, keyboard, ...(opts?.requestId ? { requestId: opts.requestId } : {}) }, true);
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
      /**
       * 含**本地图片**的 Markdown 不能降级成纯文本。
       *
       * `mdToPlain` 的链接规则会把 `![笑](C:/stickers/笑.png)` 展开成
       * `!笑（C:/stickers/笑.png）` —— 本地绝对路径直接漏给用户；换成
       * `qqbot-media://` 引用也一样会变成一长串明文，而且图片本身消失。
       * 宁可整条失败并记日志，也不能「说成功但图没了」。
       *
       * 但**公网图不在此列**：降级最多露出一条 URL，旧版本本来就会这样兜底。
       * 早期实现用「有没有图片语法」判断，连半截的图片语法都算含图，
       * 把纯文字菜单的兜底一起关掉了，用户点菜单什么都不发生。
       */
      if (hasLocalImageNode(typeof markdown === 'string' ? markdown : markdown?.content)) {
        log.error(`含本地图片的 Markdown 被拒（${e.message}），不做纯文本降级（会泄漏路径 / 吞掉图片）`);
        return null;
      }
      const plain = mdToPlain(markdown);
      if (!plain) {
        log.error(`Markdown 被拒（${e.message}），且降不出纯文本`);
        return null;
      }
      /**
       * 这条重发**不带 keyboard**：按钮里的指令本来也会出现在正文里
       * （ctx.menu 渲染时带上），信息不丢。
       *
       * 口径要说准：不是「纯文本出口不支持 keyboard」——项目里没有验证过
       * 首次发送 `msg_type=0 + keyboard` 会怎样，官方只是把按钮定位成
       * 「在 markdown 消息的基础上」挂到消息底部。这里的依据是：markdown
       * 刚被 4xx 拒过，同一条消息再挂按钮上去很可能又被拒一次，白烧一次重发。
       * `replyAuto` 的全新纯文字出口不受此限，带按钮时会升成 markdown。
       */
      log.warn(`Markdown 被拒（${e.message}），降级为纯文本重发`);
      /**
       * 降级重发**沿用同一个 requestId**：对用户来说这仍然是「一条消息」，
       * 账本里就该只有一行。上一步抛错时已经结算成 `failed`（可重试），
       * 所以这里 claim 会放行并复用同一行，最终状态是 `sent`。
       * 万一是 `unknown`，claim 会抛错——那正是我们要的「不重复发」。
       */
      return send({ content: plain, ...(opts?.requestId ? { requestId: opts.requestId } : {}) }, true).catch((e2) => {
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
   * **ark 这条路现在基本用不上**：官方「消息类型」页把结构化卡片在单聊和
   * 群聊都标成「发 ❌ / 收 ✅」，也就是只能收不能发（频道曾是唯一支持发送的
   * 场景）。真实插件里也没有人调它——ark 在本项目主要是**接收侧**在用
   * （解析别人发来的卡片）。参数保留是为了老代码不报错，新代码要发卡片
   * 请用 `replyTuwen()`（`msg_type=8`，2026-10-28 官方新出的图文卡片）。
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
   * 发**图文卡片**（`msg_type=8`，官方 2026-10-28 新增，群聊 / 单聊都支持）。
   *
   * 一张可点的卡片：标题 + 一句描述 + 跳转链接 + 封面图。四个字段都是必填。
   *
   *   await msg.replyTuwen({
   *     title: 'iPhone 17 Pro 正式发布',
   *     description: '全新 A20 芯片 / 钛金属机身 / 支持卫星通信',
   *     url: 'https://news.qq.com/rain/a/20261014A05XYZ00',
   *     picUrl: 'https://inews.gtimg.com/newsapp_bt/0/xxx/1000.jpg',
   *   });
   *
   * **和 `replyCard()` 不是一回事**，虽然名字都带 card：那个发的是
   * markdown + 按钮 + ark 的组合，ark 属于旧版结构化模板，官方现在
   * 群聊 / 单聊都标「发 ❌」；这个发的是卡片消息类型本身，是新东西。
   * 另起一个方法而不是塞进 `replyCard`，是因为两者的「同时给了怎么办」
   * 逻辑不一样——那边要丢一个，这边没有并列的字段。
   *
   * 没有任何降级：卡片渲染不出来就是失败，不像 markdown 能退成纯文本
   * （退成纯文本等于把图和链接都丢掉，发出去反而更奇怪）。
   *
   * @param {{title:string, description:string, url:string, picUrl:string}} card
   * @returns {Promise<object|null>} 发送结果；参数不合格时是 null
   */
  msg.replyTuwen = async (card = {}) => {
    const bad = tuwenProblem(card);
    if (bad) {
      log.error(`图文卡片没发：${bad}`);
      return null;
    }
    await msg.flushReplies();
    return send({
      /**
       * `msgType` 显式带上，和 `replyImage` 传 7 是同一个理由：真正决定
       * `msg_type` 的是 `buildSendPayload` 里 `card` 那一支，但中间还有
       * 出站记账要读这个字段，不传它账本里这条消息就是「未知类型」。
       */
      msgType: 8,
      card: {
        type: 'tuwen',
        content: {
          title: String(card.title),
          description: String(card.description),
          url: String(card.url),
          pic_url: String(card.picUrl),
        },
      },
    }, true).catch((e) => {
      log.error('发送图文卡片失败:', e.message);
      return null;
    });
  };

  /**
   * 发富媒体：上传后以 msg_type=7 发送。
   *
   * 富媒体在官方接口里只能是独立消息（msg_type=7），但这条消息自带
   * `content` 文本字段：传了 `text` 就和图走**同一条**，不用先发一句话
   * 再发一张图（那是两条消息，群里看着是两截）。
   *
   * 不传 text 时**不带 content 字段**。官方对 `msg_type=7` 的 content
   * 没有语义要求（只有 `msg_type=0` 时它才是全文），客户端拿到
   * 「富媒体 + 空正文」就是一张干净的图。以前这里塞了个空格占位，
   * 理由是「官方不接受空 content」——那说的是传 `''`，跟不传不是一回事，
   * 结果客户端按图文混排渲染，图外面多出一圈文字区（v1.0.6 修掉）。
   *
   * 面板「配置 → 发图兼容」把这个空格做成了可选开关：打开后由 api 层在
   * 最终报文里补回占位空格（老客户端 / 旧插件需要时），这里依旧不带 content。
   *
   * 发送前会先把攒着的文本 flush 掉，免得「缓冲中的回复」被这条
   * 富媒体消息挤成顺序错乱的两条。
   */
  const replyMedia = async (fileType, source, { local = false, text = '', requestId, onError } = {}) => {
    if (!source) return null;
    await msg.flushReplies();
    try {
      const scene = kind === 'group' ? 'group' : 'c2c';
      const target = kind === 'group' ? groupId : userId;
      if (scene !== 'group' && scene !== 'c2c') return null;

      /**
       * 本地文件先看清两件事：**要不要降级**、**走直传还是分片**。
       *
       * ① 软限制（图 20MB / 视频 30MB / 语音 20MB）——官方语义是
       *    「超过软限制降级为文件类型上传」，所以把 `file_type` 改成 4。
       * ② 直传上限 5MB——**这才是 413 的真正来源**。一张 24.4MB 的图
       *    base64 之后 32.5MB，网关直接回 `413 Request Entity Too Large`。
       *    所以超过 5MB 一律走分片（`uploadLocalFileSharded`），
       *    降级判断照旧生效（分片时 file_type 也按软限算）。
       *
       * 硬限制 200MB 是官方的绝对上限，到了这里连分片也救不了。
       */
      let effectiveType = fileType;
      let size = 0;
      if (local) {
        const st = await fs.stat(source);
        size = st.size;
        if (size > MEDIA_HARD_LIMIT) {
          throw new Error(
            `${source} 有 ${(size / 1024 / 1024).toFixed(1)}MB，超过官方 200MB 硬限制`,
          );
        }
        const soft = MEDIA_SOFT_LIMIT[fileType];
        if (soft && size > soft) {
          effectiveType = FILE_TYPE.FILE;
          log.info(`媒体 ${(size / 1024 / 1024).toFixed(1)}MB 超过 ${Math.round(soft / 1024 / 1024)}MB 软限制，降级按文件发送`);
        }
      }

      /**
       * 三选一：
       *   远程 URL → 平台自己去下载
       *   本地小文件（≤5MB）→ 直传 base64
       *   本地大文件（>5MB）→ 分片上传
       */
      let up;
      if (!local) {
        up = await api.uploadMedia(scene, target, { fileType: effectiveType, url: source });
      } else if (size > DIRECT_UPLOAD_LIMIT) {
        log.info(`媒体 ${(size / 1024 / 1024).toFixed(1)}MB 超过直传上限，走分片上传`);
        up = await api.uploadLocalFileSharded(scene, target, source, effectiveType, {
          /**
           * 这里必须包一层：`log` 是 `createLogger()` 返回的**对象**，
           * 而 `uploadLocalFileSharded` 要的是「一个打印函数」。
           * 直接传 `{ log }` 会在分片开始前炸 `logFn is not a function`
           * （2026-10-30 实际踩过，prepare 成功了、图却没发出去）。
           */
          log: (m) => log.info(m),
        });
      } else {
        up = await api.uploadLocalFile(scene, target, source, effectiveType);
      }
      if (!up?.file_info) throw new Error('未返回 file_info');

      /**
       * **没话要说就别带 content。**
       *
       * 官方字段表里 `msg_type=7` 是「富媒体(media)」，`content` 只在
       * `msg_type=0` 时才是全文，在 7 里没有语义。以前这里塞一个空格占位，
       * 客户端收到「富媒体 + 非空 content」就按图文排版——图被挤进卡片一侧，
       * 群里看到的是「一张图 + 一块空文字框」，而不是一张干净的图。
       */
      return await send({
        msgType: 7,
        ...(text ? { content: String(text) } : {}),
        media: { file_info: up.file_info },
        /** 有效类型（可能因超过软限被降级成 FILE），账本占位按它来 */
        fileType: effectiveType,
        /** 供 replyAuto 降级后的独立图各自绑定幂等键；老调用方不传，行为不变 */
        ...(requestId ? { requestId: String(requestId) } : {}),
      }, true);
    } catch (e) {
      log.error(`发送富媒体(type=${fileType}) 失败:`, e.message);
      /** 同样只给新入口：让调用方区分「明确失败」与「返回 null 但可能已送达」 */
      if (typeof onError === 'function') {
        try { onError(e); } catch { /* 诊断回调不许把主流程带崩 */ }
      }
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
   * 通用图文自动出口 `msg.replyAuto()`（**新增入口，任何插件都能用；老调用方完全不受影响**）。
   *
   * 调用方不必是 AI 插件：把正文写成标准 markdown（图片用 `![alt](路径)`），
   * 框架就按节点顺序自动选出口，不用声明消息类型：
   *
   *   · 纯文字                  → msg_type=0
   *   · markdown / 公网图        → msg_type=2，原样引用
   *   · 只有一张图 / 图在前 / 图在末尾 → 原路 msg_type=7(+content)，**不预上传**
   *   · 文字 → 图 → 文字        → msg_type=2，本地图换 qqbot-media://，**唯一触发预上传**
   *
   * **模型侧用什么语法不归这里管**：AI 插件（ai-chat）把模型写的标记
   * （`<<image: 路径>>` / `<<image-alone: 路径>>`）先转成上面这套形态：
   * `<<image:>>` → `![](路径)` 交给本出口；`<<image-alone:>>` → 自己走
   * `msg.replyImage()` 单独发。框架保持「只认 markdown」，不把模型协议
   * 焊进通用能力里。
   *
   * 典型用法（任意插件）：
   *
   *   await msg.replyAuto(`抽到了！\n![卡面](${absPath})\n要不要再来一次？`, {
   *     keyboard: ctx.menu(),
   *   });
   *
   * **框架不校验图片路径**：调用方是可信的插件代码，模型输出的可信度由调用方把关。
   * 预上传「自产自销、发完即删」：`try/finally` 只删本次上传的 image_id，
   * 不碰素材库里其它插件的素材。上传不可用（大图 / 格式 / 配额 / 网络）时，
   * 整条降级为「含原位提示的文本 1 条 + 独立图紧跟」，共 2 条，不拆三段。
   *
   * 按钮（keyboard）：官方把它定位成「在 markdown 消息的基础上」挂到消息底部。
   * 纯文字带按钮会**升成 markdown 出口**（不多发一条、不预上传）；富媒体
   * `msg_type=7` 出口不带按钮并记日志；降级纯文本是「markdown 刚被 4xx 拒过」
   * 后的重发，也不再挂按钮，避免同一条消息被拒两次。
   *
   * @param {string} content 插件给出的正文（标准 markdown，可含本地/公网图片）
   * @param {object} [opts]
   * @param {string} [opts.requestId] 投递账本幂等键；降级后派生出各自独立的键
   * @param {object} [opts.keyboard] 按钮组（见上方口径）
   * @param {number} [opts.maxMedia=3] 单条最多允许的独立图数量
   * @param {object} [opts.hints] 按 reason 覆盖降级提示文案
   * @param {(info:object)=>void} [opts.onResult] 诊断回调（真实发送结果记这里）
   */
  msg.replyAuto = async (content, opts = {}) => {
    // 先把攒着的文本发掉，否则缓冲里的回复会被富媒体/markdown 挤成顺序错乱的两条
    await msg.flushReplies();
    const raw = String(content ?? '');
    if (!raw) return null;

    const nodes = parseReplyNodes(raw);
    const plan = decideReplyMode(nodes);
    const rid = opts.requestId ? String(opts.requestId) : '';
    const keyboard = opts.keyboard ?? null;
    const hints = opts.hints ?? {};
    const maxMedia = Math.max(1, Number(opts.maxMedia) || 3);
    const report = (info) => {
      if (typeof opts.onResult !== 'function') return;
      try { opts.onResult(info); } catch { /* 诊断回调不许把发送流程带崩 */ }
    };

    /* 1) 纯文字 / 无本地图的 markdown（含公网图，原样引用，平台自动转存） */
    if (plan.mode === 'plain' || (plan.mode === 'markdown' && plan.local.length === 0)) {
      /**
       * 官方「消息按钮」文档把按钮定位成「在 markdown 消息的基础上」挂到消息底部。
       * 纯文本（msg_type=0）没有这个基础，所以带按钮时直接**升成 markdown 出口**：
       * 不预上传、不多发一条，按钮也不用丢。
       * 注意别把这条理解成「实测过 msg_type=0 + keyboard 会被拒」——项目里
       * 唯一的依据是 replyMarkdown 降级重发那一处，那是消息刚被 4xx 拒过的场景。
       */
      const asMarkdown = plan.mode === 'markdown' || !!keyboard;
      const payload = asMarkdown ? { markdown: { content: raw } } : { content: raw };
      if (keyboard) payload.keyboard = keyboard;
      try {
        return await send({ ...payload, ...(rid ? { requestId: rid } : {}) }, true);
      } catch (e) {
        log.error(`replyAuto 发送失败(${plan.mode}):`, e.message);
        return null;
      }
    }

    /* 2) 独立图 / 图在前 / 图在末尾 —— 原路，一次预上传都不做 */
    if (plan.mode === 'media' || plan.mode === 'media-text') {
      if (keyboard) log.warn('replyAuto 富媒体(msg_type=7)出口按官方口径不挂载 keyboard，按钮已跳过');
      // 框架不做路径白名单：调用方是插件代码，给什么路径就发什么图
      const resolved = plan.local.map((n) => ({ ...n, path: path.resolve(n.src) }));
      if (!resolved.length) return null;
      const count = Math.min(resolved.length, maxMedia);
      let last = null;
      for (let i = 0; i < count; i++) {
        last = await msg.replyImage(resolved[i].path, {
          local: true,
          /**
           * `msg_type=7` 的 content 是**纯文本**，不渲染 markdown。
           * 图在前 / 图在末尾走这条原路时，正文里的 `# 标题` / `**加粗**`
           * 会原样露给用户，所以先过一遍 mdToPlain。
           */
          text: i === 0 ? mdToPlain(plan.text) : '',
          ...(rid ? { requestId: `${rid}:img${i}` } : {}),
        });
      }
      if (resolved.length > count) {
        log.warn(`replyAuto 图片数 ${resolved.length} 超过 maxMedia=${maxMedia}，已截断 ${resolved.length - count} 张`);
      }
      report({ mode: plan.mode, images: resolved.length, sent: count });
      return last;
    }

    /* 3) markdown 出口：按需预上传（框架不校验路径） */
    const valid = plan.local.map((n) => ({ ...n, resolvedPath: path.resolve(n.src) }));
    let failure = null;

    const replacements = new Map();
    const uploads = [];
    const byPath = new Map(); // 同一条消息里同图复用一个上传结果
    if (!failure) {
      for (const n of valid) {
        if (byPath.has(n.resolvedPath)) {
          replacements.set(n.src, byPath.get(n.resolvedPath));
          continue;
        }
        try {
          const up = await api.uploadMarkdownImage(n.resolvedPath);
          uploads.push(up);
          byPath.set(n.resolvedPath, up.url);
          replacements.set(n.src, up.url);
        } catch (e) {
          failure = { reason: classifyUploadFailure(e), error: e, path: n.resolvedPath };
          log.warn(`replyAuto 预上传失败（${failure.reason}），整条降级：${e.message}`);
          break;
        }
      }
      // 一条消息不能混 msg_type：只要有一张本地图没换成引用，就会明文漏出路径
      if (!failure && valid.some((n) => !replacements.has(n.src))) {
        failure = { reason: 'internal' };
      }
    }

    try {
      if (!failure) {
        const md = renderReplyMarkdown(nodes, replacements);
        try {
          const r = await send({
            markdown: { content: md },
            ...(keyboard ? { keyboard } : {}),
            ...(rid ? { requestId: rid } : {}),
          }, true);
          report({ mode: 'markdown', uploads: uploads.length });
          return r;
        } catch (e) {
          /**
           * 硬边界：POST /messages 已发出之后的超时 / 5xx / 普通拒绝一律不降级。
           * 可能已经送达，再补文本+独立图就是重复发送；账本按 unknown 处理、不重发。
           */
          log.error(`replyAuto markdown 发送失败，不降级（可能已送达）:`, e.message);
          report({ mode: 'markdown', phase: 'send', error: String(e?.message ?? '') });
          return null;
        }
      }
    } finally {
      // 发完即删：成功、失败、异常都清，只删本次自己创建的 image_id
      for (const up of uploads) {
        try { await api.deleteMediaImage(up.imageId); }
        catch (e2) { log.warn(`replyAuto 清理素材失败 image_id=${up.imageId}: ${e2.message}`); }
      }
    }

    /* 4) 降级：文本（图片位置换成提示）先发，独立图紧跟，共 2 条 */
    const reason = failure.reason;
    const hint = hintForReason(reason, hints);
    const fb = renderFallback(nodes, () => hint);
    const fbBase = rid || newTraceId();
    if (fb.content) {
      /**
       * 降级文本是「markdown 刚被 4xx 拒过」之后的重发，纯文本那一条不再挂
       * 按钮（理由同 replyMarkdown 的降级）。若降级文本里还留着公网图，
       * `renderFallback` 会返回 msgType=2，那仍是 markdown，按钮照挂。
       */
      if (keyboard && fb.msgType !== 2) {
        log.warn('replyAuto 降级纯文本是 markdown 被拒后的重发，按钮已跳过（避免再被拒一次）');
      }
      const payload = fb.msgType === 2
        ? { markdown: { content: fb.content }, ...(keyboard ? { keyboard } : {}) }
        : { content: fb.content };
      try {
        await send({ ...payload, requestId: `${fbBase}:fallback-text` }, true);
      } catch (e) {
        log.error('replyAuto 降级文本发送失败:', e.message);
      }
    }

    /**
     * 降级时要从补发队列里**剔除**的原因：这些是「这张图本身用不了」，
     * 换一条消息再发一次必然还失败，只会白跑一次请求 + 一条失败日志。
     *
     *   · `outside`    —— 文件不存在 / 无权限，`replyImage` 连读都读不到
     *   · `bad_format` —— 文件头不是受支持的图片，QQ 直接回
     *                     `400 富媒体文件格式不支持`（2026-11-07 真机实测）
     *
     * 其余原因一律保留补发：`oversize` 能走分片上传（11MB 实测成功）、
     * `quota` 是暂时性的、`network` 多是瞬时抖动、`internal` 属未归类异常，
     * 换个通道还有机会成。降级文案写的是「下面会单独发这张图」，
     * 能发就得真发。
     */
    const DEAD_REASONS = new Set(['outside', 'bad_format']);
    const sendable = DEAD_REASONS.has(failure.reason)
      ? valid.filter((n) => n.resolvedPath !== failure.path)
      : valid;
    const toSend = sendable.slice(0, maxMedia);
    for (let i = 0; i < toSend.length; i++) {
      const errs = [];
      const sent = await msg.replyImage(toSend[i].resolvedPath, {
        local: true,
        requestId: `${fbBase}:fallback-img${i}`,
        onError: (e) => errs.push(e),
      });
      // 真实结果只进日志/回调：文案在图片发出之前就已经发出去了，不能事后改口
      const state = sent ? 'sent' : errs.length ? 'failed' : 'unknown';
      log.info(`replyAuto 降级独立图 ${i + 1}/${toSend.length}: ${state}（原因 ${reason}）`);
      report({ mode: 'fallback', reason, image: i, state });
    }
    if (sendable.length > toSend.length) {
      log.warn(`replyAuto 降级图片数 ${sendable.length} 超过 maxMedia=${maxMedia}，已截断 ${sendable.length - toSend.length} 张`);
    }
    report({ mode: 'fallback', reason, uploads: uploads.length, images: toSend.length });
    return null;
  };

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
      /** 同上：不带 content。buffer 分支没有「附一句话」的入口，所以永远不该有 */
      return await send({
        msgType: 7, media: { file_info: up.file_info }, fileType,
      }, true);
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
      /**
       * 群聊没有流式接口，退化成一条 markdown。
       *
       * 以前 push() 和 end() 各调一次 replyMarkdown，于是「分两段说」在群里
       * 会发两条独立消息、账本记两笔；而流式契约里 end() 传的是**最终全量正文**，
       * push() 只是中间态，真按两条发出去用户看到的是半截内容。
       * 现在 push() 只缓存、end() 发一次最终全文，与单聊 end() 补记一笔的口径对齐。
       * 调用方按契约必须调 end()；只 push() 不 end() 时不再单独发一条。
       */
      const pieces = [];
      let ended = false;
      let endResult = null;
      return {
        push: async (text) => {
          const t = String(text ?? '');
          if (t) pieces.push(t);
          return null;
        },
        end: async (text) => {
          if (ended) return endResult;
          const final = String(text ?? '') || pieces.join('');
          ended = true;
          endResult = await msg.replyMarkdown({ content: final });
          return endResult;
        },
      };
    }

    let index = 0;
    /** end() 可能被重复调用，出站账本只记一笔 */
    let recorded = false;
    /** 重复 end() 也不该再打一次接口；成功后才置位，失败仍可重试 */
    let ended = false;
    let endResult = null;
    let streamId = opts.streamMsgId || '';
    const target = userId;
    /**
     * **一条流式消息只占一个 `msg_seq`**，所有分片共用。
     *
     * 这一步必须在首片之前做：流式接口不走 `#payload`，不主动占号的话
     * 服务端按默认 1 算，而我们后续的普通回复也从 1 开始递增，
     * 两边一撞就是 `40054005 消息被去重`（用户看到「发了但没出现」）。
     */
    const seq = typeof api.takeSeq === 'function' ? api.takeSeq(msg.id) : 1;

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
          msgSeq: seq,
          isWakeup: opts.isWakeup,
        });
        if (r?.id && !streamId) streamId = r.id;
        return r;
      },
      /** 结束流。contentRaw 传最终全量正文 */
      async end(contentRaw) {
        /** 重复调用回首次结果：不打接口、不自增 index、不重复记账 */
        if (ended) return endResult;
        const r = await api.sendStreamMessage(target, {
          contentRaw,
          index: index++,
          state: 10,
          mode: 'replace',
          streamMsgId: streamId || undefined,
          msgId: msg.id,
          msgSeq: seq,
          isWakeup: opts.isWakeup,
        });
        /** 接口成功后才封口：发送失败时允许重试，别把重试永久挡死 */
        ended = true;
        endResult = r;
        /**
         * 流式回复直连 api，**不经过 outbound.send** —— 那边两个记账出口
         * 都覆盖不到，单聊长回复会整条不进账本、「谁」列依旧是空的。
         * 成功后补记一笔最终全文；recorded 防 end() 重复调用造成双记。
         * 群聊在开头就退化成 replyMarkdown，那条路已经走 send()，不会到这。
         */
        if (!recorded) {
          recorded = true;
          try {
            outbound?.recordDirect?.({
              kind,
              target,
              content: String(contentRaw ?? ''),
              plugin: String(opts.plugin ?? msg.pluginId ?? ''),
              id: String(r?.id ?? streamId ?? ''),
            });
          } catch (e) {
            log.warn(`流式回复没记进账本（不影响发送）：${e.message}`);
          }
        }
        return r;
      },
    };
  };

  return msg;
}
