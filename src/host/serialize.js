/**
 * 事件序列化：内核 Message → 宿主协议事件
 * ======================================
 *
 * **不做 OneBot 翻译**，字段保持框架里的名字和含义。
 * 特别是 openid / uin：没绑就是空串，绝不造一个「看起来像 QQ 号」的合成号——
 * 客户端拿合成号去查记忆，查不到还不会报错，只会「像换了个人」。
 *
 * `msg.raw`（平台原始事件体）不进事件流：它带一堆内部字段、体积不可控，
 * 需要时用 `msg.get` 按 id 查账本。这里只留正文原文 `rawContent`。
 */

/**
 * @param {object} msg  `buildMessage()` 的产物
 * @param {object} [opt]
 * @param {string} [opt.groupName] 群名缓存里查到的名字，查不到就空
 */
export function serializeMessage(msg, { groupName = '' } = {}) {
  if (!msg || typeof msg !== 'object') return null;
  return {
    at: Number(msg.receivedAt) || Date.now(),
    chat: {
      kind: msg.kind ?? 'unknown',
      chatId: msg.chatId ?? '',
      groupId: msg.groupId ?? '',
      /**
       * 频道维度（群/单聊为空串）。`groupId` 在 guild 场景是 channel_id、
       * 在 dm 场景是私信会话 id，语义会混，所以另给两个明确字段：
       * guildId 是真正的频道 ID，channelId 是子频道 ID。
       */
      guildId: msg.guildId ?? '',
      channelId: msg.channelId ?? '',
      groupUin: msg.groupUin ?? '',
      groupIdentityId: msg.groupIdentityId ?? '',
      groupAliases: Array.isArray(msg.groupAliases) ? msg.groupAliases : [],
      /**
       * 官方 2026-11-16 新加的跨应用群标识，**只透传**。它换不出对方机器人的
       * openid，发消息只认 `groupId`；跨机器人关联走 identity 的群号绑定。
       */
      unionGroupId: msg.unionGroupId ?? '',
      name: groupName,
    },
    sender: {
      openid: msg.userId ?? '',
      uin: msg.uin ?? '',
      identityId: msg.identityId ?? '',
      aliases: Array.isArray(msg.userAliases) ? msg.userAliases : [],
      /**
       * 显示名（群聊取群内昵称）。`nickname` / `card` 两个原始值也带上：
       * 客户端要「群名片」和「QQ 昵称」分开显示时，用 name 是分不出来的。
       */
      name: msg.userName ?? '',
      nickname: msg.userNickname ?? '',
      card: msg.userCard ?? '',
      /** 头像原图 URL；官方没给就是空串（别拼默认头像，那是猜） */
      avatar: msg.userAvatar ?? '',
      /** 跨应用统一用户 id，绑了 3 方应用才有 */
      unionOpenid: msg.unionUserId ?? '',
      isBot: msg.raw?.author?.bot === true,
    },
    msgId: msg.id ?? '',
    /**
     * 事件账本里的 id。**和 `msgId` 不是一回事**：msgId 用来被动回复，
     * eventId 用来回查原文（`ledger.context` / `msg.get` 的入参都是它，
     * `events` 表的主键就是 eventId）。
     *
     * 不开账本时是空串——那时也确实没有东西可回查，不是丢数据。
     */
    eventId: msg.eventId ?? '',
    traceId: msg.traceId ?? '',
    event: msg.event ?? '',
    eventMeta: msg.eventMeta ?? null,
    content: msg.content ?? '',
    /** 未剥 @、未 trim 的原文，客户端想自己解析时用它 */
    rawContent: String(msg.raw?.content ?? ''),
    addressed: Boolean(msg.addressed),
    mentioned: Boolean(msg.mentioned),
    isCommand: Boolean(msg.isCommand),
    command: msg.command ?? '',
    args: Array.isArray(msg.args) ? msg.args : [],
    mentions: Array.isArray(msg.mentions) ? msg.mentions : [],
    allMentions: Array.isArray(msg.allMentions) ? msg.allMentions : [],
    attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
    scene: msg.scene ?? null,
    ark: msg.ark ?? null,
    elements: msg.elements ?? null,
    /**
     * 被引用的原文。**不能只给 `replyTo`**：那个是 message_id，客户端拿它
     * 拼不出「引用了哪句话」，只能看到一个 id。引用回复的正文在这里。
     *
     * 拿不到时是空串（QQ 有些场景不回推被引用的内容），不是错误。
     */
    quoted: msg.quoted ?? '',
    replyTo: msg.raw?.message_reference?.message_id ?? null,
  };
}

/** 非消息事件（入群、退群、加好友…）原样带 out，不猜结构 */
export function serializeNotice(event, data) {
  return { at: Date.now(), event: String(event ?? ''), data: data ?? null };
}
