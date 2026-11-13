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

/**
 * 把 `msg` 拆成 OneBot 消息段。
 *
 * @param {object} msg buildMessage 的产物
 * @param {import('./ids.js').OneBotIds} ids
 * @param {number} [selfUin] 机器人自己的 QQ 号：被 @ 时要用它造 at 段
 */
export function segmentsOf(msg, ids, selfUin = 0) {
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

  if (msg.content) segs.push({ type: 'text', data: { text: String(msg.content) } });

  for (const a of Array.isArray(msg.attachments) ? msg.attachments : []) {
    if (a.type === 'image') {
      segs.push({ type: 'image', data: { file: a.url, url: a.url, summary: '[图片]' } });
    } else if (a.type === 'voice') {
      // 官方直接给了 WAV（SILK 转好的），不用自己转码
      segs.push({ type: 'record', data: { file: a.wavUrl || a.url, url: a.wavUrl || a.url } });
    } else if (a.type === 'video') {
      segs.push({ type: 'video', data: { file: a.url, url: a.url } });
    } else if (a.type === 'file') {
      segs.push({ type: 'file', data: { file: a.url, url: a.url, name: a.filename } });
    }
  }

  return segs;
}

/** CQ 码形式的纯文本（客户端不解析段时用；只做 text/at/image 三种最常见的） */
export function rawMessageOf(segs) {
  return segs
    .map((s) => {
      if (s.type === 'text') return String(s.data.text ?? '');
      if (s.type === 'at') return `[CQ:at,qq=${s.data.qq}]`;
      if (s.type === 'image') return '[CQ:image,file=' + String(s.data.file ?? '') + ']';
      if (s.type === 'record') return '[CQ:record,file=' + String(s.data.file ?? '') + ']';
      if (s.type === 'reply') return `[CQ:reply,id=${s.data.id}]`;
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
      nickname: String(msg.userName ?? ''),
      // 官方没有群名片，回落昵称（能力表里标了）
      card: String(msg.userName ?? ''),
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
