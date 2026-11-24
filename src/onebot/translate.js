/**
 * 官方事件 → OneBot v11 事件
 * ==========================
 *
 * 只做「能忠实映射」的部分。官方群聊/单聊**没有**撤回事件、拍一拍、群文件事件，
 * 这些一律不产生（见设计稿 §4），别在这里造一个看起来像的事件糊过去。
 *
 * 时间统一用秒（OneBot 约定），`self_id` 用配置里的机器人 QQ 号。
 */

/** 取第一个非空字段：官方各事件的 openid 字段名不统一 */
function pick(...vals) {
  for (const v of vals) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

/** 官方入站表情标签：`<faceType=1,faceId="187",ext="…">` */
const FACE_TAG_RE = /<faceType=(\d+),faceId="(\d+)"(?:,ext="([^"]*)")?\s*\/?>/g;
/** `normalizeInbound()` 翻出来的人话标记：`【表情: 幽灵】` */
const FACE_MARK_RE = /【表情\s*[:：]\s*[^】]{1,24}】/g;

/** 正文里翻出来的人话标记要删掉，否则客户端会同时显示 `[幽灵]` 和 `【表情: 幽灵】` */
function stripFaceMarks(text) {
  return String(text ?? '').replace(FACE_MARK_RE, '');
}

/** CQ 码里的字段值要转义，尤其 json 段的 data 自带逗号和方括号 */
function cqEscape(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/,/g, '&#44;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;');
}

function cq(type, fields = {}) {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${cqEscape(v)}`)
    .join(',');
  return body ? `[CQ:${type},${body}]` : `[CQ:${type}]`;
}

/**
 * ARK 卡片 → OneBot `json` 段。
 *
 * snowluma 的 `json` 段 `data.data` 是一段 structmsg JSON；aurabot 的
 * `cardText()` 读的是 `meta.detail_1 / news / music` 的 `title/desc/jumpUrl`
 * 和顶层 `prompt`。官方 ark_data 的字段名是 `fields.title / desc / jump_url`，
 * 所以在这里拼一层，别让客户端只看到「[卡片消息]」四个字。
 */
function arkSegment(ark) {
  if (!ark || typeof ark !== 'object') return null;
  const f = ark.fields && typeof ark.fields === 'object' ? ark.fields : {};
  const title = String(ark.title ?? f.title ?? '');
  const desc = String(ark.desc ?? f.desc ?? '');
  const url = String(ark.url ?? f.jump_url ?? '');
  const prompt = String(ark.prompt ?? ark.name ?? '');
  const kind = `${ark.type ?? ''} ${ark.name ?? ''}`;
  const isLocation = /map|location|位置/i.test(kind);
  const data = isLocation
    ? { app: 'com.tencent.map', meta: { Location: { title, address: desc || url } } }
    : {
        app: 'com.tencent.structmsg',
        desc: '分享',
        view: 'news',
        prompt,
        meta: {
          detail_1: {
            title,
            desc,
            jumpUrl: url,
            url,
            tag: String(ark.name ?? f.tag ?? ''),
          },
        },
      };
  return { type: 'json', data: { data: JSON.stringify(data) } };
}

/** 官方附件 → 段。以前静默丢掉的 other（表情包/未知附件）现在按 file 发 */
function attachmentSegments(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'image') {
      out.push({ type: 'image', data: { file: a.url, url: a.url, summary: '[图片]' } });
    } else if (a.type === 'voice') {
      // 官方直接给了 WAV（SILK 转好的），不用自己转码
      out.push({ type: 'record', data: { file: a.wavUrl || a.url, url: a.wavUrl || a.url } });
    } else if (a.type === 'video') {
      out.push({ type: 'video', data: { file: a.url, url: a.url } });
    } else if (a.type === 'file') {
      out.push({ type: 'file', data: { file: a.url, url: a.url, name: a.filename } });
    } else {
      /** 商城表情：snowluma 把它翻成 image 段 + emoji_id，客户端按表情包渲染 */
      const emojiId = String(a.raw?.emoji_id ?? a.raw?.emojiId ?? '');
      if (emojiId) {
        const dir = emojiId.slice(0, 2);
        out.push({
          type: 'image',
          data: {
            file: `${dir}-${emojiId}.gif`,
            url: `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${emojiId}/raw300.gif`,
            summary: String(a.filename ?? ''),
            emoji_id: emojiId,
            emoji_package_id: Number(a.raw?.emojiPackageId ?? a.raw?.emoji_package_id ?? 0),
          },
        });
      } else {
        out.push({
          type: 'file',
          data: { file: a.url, url: a.url, name: String(a.filename || a.contentType || '附件') },
        });
      }
    }
  }
  return out;
}

/**
 * 一个 `msg_elements` 子元素的载荷（正文 / 卡片 / 子元素 / 附件）。
 * `dedupe=true` 时跳过已经包含在顶层 `msg.content` 里的文字，避免整条消息说两遍。
 */
function elementPayloadSegments(el, ctx, depth, dedupe) {
  const out = [];
  const content = String(el?.content ?? '');
  if (content && !(dedupe && ctx.fullText.includes(content))) {
    out.push({ type: 'text', data: { text: content } });
  }
  if (el?.ark) {
    const seg = arkSegment(el.ark);
    const key = seg?.data?.data;
    if (seg && !ctx.seenArk.has(key)) {
      ctx.seenArk.add(key);
      out.push(seg);
    }
  }
  for (const child of Array.isArray(el?.children) ? el.children : []) {
    if (depth < 3) out.push(...elementSegments(child, ctx, depth + 1, dedupe));
  }
  out.push(...attachmentSegments(el?.attachments));
  return out;
}

/** 合并转发里的一个节点：用 snowluma 的转发节点形状（客户端读 message / sender） */
function forwardNode(el, ctx, depth, index) {
  const childCtx = { ...ctx, fullText: '', replyEmitted: false, seenArk: new Set() };
  const segs = elementSegments(el, childCtx, depth + 1, false);
  const author = el?.author ?? {};
  const uin = author.id ? Number(ctx.ids.user(author.id)) || 0 : 0;
  const nickname = String(author.nickname || author.name || '');
  return {
    self_id: Number(ctx.selfUin) || 0,
    user_id: uin,
    time: Number(el?.raw?.timestamp) || Math.floor(Date.now() / 1000),
    message_id: 0,
    message_seq: index + 1,
    real_id: 0,
    message_type: ctx.isGroup ? 'group' : 'private',
    sender: { user_id: uin, nickname, card: String(author.card ?? '') },
    raw_message: rawMessageOf(segs),
    font: 0,
    sub_type: ctx.isGroup ? 'normal' : 'friend',
    message: segs,
    message_format: 'array',
    post_type: 'message',
  };
}

/** 消息元素 → 段；chatRecord 在这里落成 forward 段 + 转发节点存储 */
function elementSegments(el, ctx, depth = 0, dedupe = false) {
  if (!el || depth > 3) return [];
  if (el.type === 'chatRecord') {
    /** 没有转发存储（测试桩 / 老 ids）时降级成文字，别发一个客户端拉不到内容的 id */
    if (depth >= 3 || typeof ctx.ids?.bindForward !== 'function') {
      return [{ type: 'text', data: { text: '[合并转发]' } }];
    }
    const children = el.children?.length ? el.children : [el];
    const nodes = children.slice(0, 200).map((child, i) => forwardNode(child, ctx, depth, i));
    const id = ctx.ids.bindForward(nodes);
    return [{ type: 'forward', data: { id: String(id) } }];
  }
  if (el.type === 'quote') {
    const out = [];
    const qid = ctx.replyEmitted ? 0 : ctx.ids?.messageIdOfIdx?.(el.msgIdx);
    if (qid) {
      out.push({ type: 'reply', data: { id: String(qid) } });
      ctx.replyEmitted = true;
    }
    const quoted = String(el.content ?? '');
    if (quoted && !(dedupe && ctx.fullText.includes(quoted))) {
      out.push({ type: 'text', data: { text: `[引用: ${quoted}]` } });
    }
    return out;
  }
  return elementPayloadSegments(el, ctx, depth, dedupe);
}

/**
 * 把 `msg` 拆成 OneBot 消息段。
 *
 * @param {object} msg buildMessage 的产物
 * @param {import('./ids.js').OneBotIds} ids
 * @param {number} [selfUin] 机器人自己的 QQ 号：被 @ 时要用它造 at 段
 * @param {number} [depth] 内部用：合并转发嵌套层数（防畸形数据把栈打穿）
 */
export function segmentsOf(msg, ids, selfUin = 0, depth = 0) {
  const segs = [];

  /**
   * **被 @ 的是机器人自己**：必须单独发一个 at 段。
   *
   * `msg.mentions` 里已经把机器人过滤掉了（插件点名单选人时不该选到它），
   * 早先这里就按「被动回复本身已经指向它，多一个 @ 是噪音」不发段——
   * 但 OneBot 客户端判断「有没有人叫我」**只看 at 段里的 qq 是不是自己**
   * （aurabot 的 `parseMessageEvent`：`d.qq === self`）。
   *
   * 不发段的后果（2026-11-13 实测）：@ 她的群消息被当成普通群消息，
   * 掉进「话题相关度」那道闸里，`相关度 0.00 → 不回`——用户看到的就是
   * 「@ 了也没人理」。
   */
  if (msg.mentioned && Number(selfUin)) {
    segs.push({ type: 'at', data: { qq: String(selfUin), name: '' } });
  }

  // 引用：官方给的是 msgIdx（REFIDX_…），换成我们发出去的 message_id
  const quotedId = ids.messageIdOfIdx(msg.refMsgIdx);
  if (quotedId) segs.push({ type: 'reply', data: { id: String(quotedId) } });

  // 被 @ 的**其他人**（不含机器人自己；`mentions` 里已经过滤过 bot）
  for (const m of Array.isArray(msg.mentions) ? msg.mentions : []) {
    const qq = ids.user(m.id);
    if (qq) segs.push({ type: 'at', data: { qq: String(qq), name: String(m.name ?? '') } });
  }

  /** 正文文字：有官方表情标签时同步发 face 段，并把人话标记从正文里剥掉 */
  const rawContent = String(msg.raw?.content ?? '');
  const faces = [];
  if (rawContent.includes('<faceType')) {
    for (const m of rawContent.matchAll(FACE_TAG_RE)) faces.push(Number(m[2]) || 0);
  }
  for (const id of faces.filter(Boolean)) segs.push({ type: 'face', data: { id: String(id) } });
  const text = faces.length ? stripFaceMarks(msg.content) : msg.content;
  if (text) segs.push({ type: 'text', data: { text: String(text) } });

  const ctx = {
    ids,
    selfUin,
    isGroup: msg.kind === 'group',
    fullText: String(text ?? ''),
    replyEmitted: Boolean(quotedId),
    seenArk: new Set(),
  };

  /** ARK 卡片 + msg_elements（聊天记录 / 引用 / 结构化卡片） */
  if (msg.ark) {
    const seg = arkSegment(msg.ark);
    if (seg) {
      ctx.seenArk.add(seg.data.data);
      segs.push(seg);
    }
  }
  for (const el of Array.isArray(msg.elements) ? msg.elements : []) {
    if (depth < 3) segs.push(...elementSegments(el, ctx, depth, true));
  }

  segs.push(...attachmentSegments(msg.attachments));

  return segs;
}

/** CQ 码形式的纯文本（客户端不解析段时用；段类型与 snowluma 的 OneBot 输出对齐） */
export function rawMessageOf(segs) {
  return segs
    .map((s) => {
      const d = s.data ?? {};
      if (s.type === 'text') return String(d.text ?? '');
      if (s.type === 'at') return cq('at', { qq: d.qq, name: d.name });
      if (s.type === 'image') return cq('image', { file: d.file, emoji_id: d.emoji_id });
      if (s.type === 'record') return cq('record', { file: d.file });
      if (s.type === 'video') return cq('video', { file: d.file });
      if (s.type === 'file') return cq('file', { file: d.file, name: d.name });
      if (s.type === 'face') return cq('face', { id: d.id });
      if (s.type === 'reply') return cq('reply', { id: d.id });
      if (s.type === 'json') return cq('json', { data: d.data });
      if (s.type === 'forward') return cq('forward', { id: d.id });
      return '';
    })
    .join('');
}

/**
 * 消息事件。
 *
 * @param {object} p
 * @param {object} p.msg      buildMessage 产物
 * @param {import('./ids.js').OneBotIds} p.ids
 * @param {number} p.selfUin
 * @param {number} [p.selfOpenid] 机器人自己的 openid（用于过滤自己发的消息）
 */
export function toMessageEvent({ msg, ids, selfUin }) {
  const isGroup = msg.kind === 'group';
  const segs = segmentsOf(msg, ids, selfUin);
  const at = msg.raw?.author ?? {};

  return {
    time: Math.floor((Number(msg.receivedAt) || Date.now()) / 1000),
    self_id: Number(selfUin) || 0,
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: ids.bindMessage(msg),
    ...(isGroup ? { group_id: ids.group(msg.groupId) } : {}),
    user_id: ids.user(msg.userId),
    message: segs,
    raw_message: rawMessageOf(segs),
    font: 0,
    sender: {
      user_id: ids.user(msg.userId),
      /**
       * 2026-11-16 起官方事件给了两个名字：QQ 昵称（`username`）和群内昵称
       * （`member_nickname`）。OneBot 的 `nickname` / `card` 正好一一对应，
       * 以前两个字段填同一个值，客户端改群名片永远对不上。
       */
      nickname: String(msg.userNickname || msg.userName || ''),
      card: String(msg.userCard ?? ''),
      role: isGroup ? String(at.member_role || 'member') : 'member',
    },
    anonymous: null,
  };
}

/**
 * 非消息事件 → OneBot notice / request。
 *
 * @returns {object|null} 认不出来返回 null（不推）
 */
export function toNotice(eventName, d, { ids, selfUin }) {
  const base = {
    time: Math.floor(Number(d?.timestamp) || Date.now() / 1000),
    self_id: Number(selfUin) || 0,
    post_type: 'notice',
  };
  const groupOpenid = pick(d?.group_openid);
  const groupId = groupOpenid ? ids.group(groupOpenid) : 0;

  switch (eventName) {
    case 'GROUP_MEMBER_ADD':
      return {
        ...base,
        notice_type: 'group_increase',
        sub_type: 'approve',
        group_id: groupId,
        user_id: ids.user(pick(d?.member_openid, d?.user_openid)),
        operator_id: 0,
      };
    case 'GROUP_MEMBER_REMOVE':
      // 官方不区分主动退群 / 被踢，统一 leave——别猜
      return {
        ...base,
        notice_type: 'group_decrease',
        sub_type: 'leave',
        group_id: groupId,
        user_id: ids.user(pick(d?.member_openid, d?.user_openid)),
        operator_id: 0,
      };
    case 'GROUP_ADD_ROBOT':
      return {
        ...base,
        notice_type: 'notify',
        sub_type: 'bot_group_add',
        group_id: groupId,
        user_id: ids.user(pick(d?.op_member_openid)),
      };
    case 'GROUP_DEL_ROBOT':
      return {
        ...base,
        notice_type: 'notify',
        sub_type: 'bot_group_remove',
        group_id: groupId,
        user_id: 0,
      };
    case 'FRIEND_ADD':
      return { ...base, notice_type: 'friend_add', user_id: ids.user(pick(d?.openid, d?.user_openid)) };
    case 'FRIEND_DEL':
      return { ...base, notice_type: 'friend_remove', user_id: ids.user(pick(d?.openid, d?.user_openid)) };
    default:
      return null;
  }
}

/** 自己撤回后补的那条 `group_recall`（官方没有撤回事件，只能自己补） */
export function recallNotice({ ids, selfUin, groupId, userId, messageId }) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(selfUin) || 0,
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: Number(groupId) || 0,
    user_id: Number(userId) || 0,
    operator_id: Number(selfUin) || 0,
    message_id: Number(messageId) || 0,
  };
}

/** 连接时的 lifecycle（每个客户端连上各推一次） */
export function lifecycleEvent(selfUin, subType = 'connect') {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(selfUin) || 0,
    post_type: 'meta_event',
    meta_event_type: 'lifecycle',
    sub_type: subType,
  };
}

/** 心跳：25s 一次，`status.online` 让客户端知道网关还活着 */
export function heartbeatEvent(selfUin, interval = 25000) {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(selfUin) || 0,
    post_type: 'meta_event',
    meta_event_type: 'heartbeat',
    status: { online: true, good: true },
    interval,
  };
}
