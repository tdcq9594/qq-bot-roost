/**
 * QQ 官方接口的完整事件表。
 *
 * 来源：官方文档「事件订阅与通知」+「WSS 消息体」。
 * 这里把 42 个事件全部登记下来，目的是：
 *   1. 内核能识别每一个事件，不靠「未知事件」兜底
 *   2. 插件能查到有哪些事件可监听、属于哪个 intent、需要什么权限
 *   3. 面板能显示订阅覆盖率和各事件的接收计数
 *
 * 新增事件时只改这个文件，message.js / dispatcher / 面板都会跟着走。
 */

/** intents 位定义 */
export const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
};

/** intent 的中文名与权限要求，面板和文档都用它 */
export const INTENT_META = {
  GUILDS: { name: '频道基础', bit: 0, need: '默认可用' },
  GUILD_MEMBERS: { name: '频道成员', bit: 1, need: '默认可用' },
  GUILD_MESSAGES: { name: '频道全量消息', bit: 9, need: '需申请，仅私域' },
  GUILD_MESSAGE_REACTIONS: { name: '表情表态', bit: 10, need: '需申请' },
  DIRECT_MESSAGE: { name: '频道私信', bit: 12, need: '需申请' },
  GROUP_AND_C2C_EVENT: { name: '群聊与私聊', bit: 25, need: '需开通群聊能力' },
  INTERACTION: { name: '互动事件', bit: 26, need: '需申请' },
  MESSAGE_AUDIT: { name: '消息审核', bit: 27, need: '需申请' },
  FORUMS_EVENT: { name: '论坛事件', bit: 28, need: '需申请，仅私域' },
  AUDIO_ACTION: { name: '音频动作', bit: 29, need: '需申请' },
  PUBLIC_GUILD_MESSAGES: { name: '频道 @消息', bit: 30, need: '默认可用' },
};

/**
 * 事件登记表。
 *
 * 字段：
 *   intent  — 属于哪个订阅位
 *   group   — 面板分组用
 *   desc    — 一句话说明
 *   message — 若有值，表示这是个「消息事件」，内核会把它规范化成 Message 对象。
 *             值为会话类型：group / c2c / guild / dm
 *   doc     — 官方文档是否明确列出（false 表示平台实际会下发但文档没写）
 */
export const EVENTS = {
  /* ---------------- 频道基础 ---------------- */
  GUILD_CREATE: { intent: 'GUILDS', group: '频道', desc: '机器人加入新频道' },
  GUILD_UPDATE: { intent: 'GUILDS', group: '频道', desc: '频道资料变更' },
  GUILD_DELETE: { intent: 'GUILDS', group: '频道', desc: '机器人退出频道' },
  CHANNEL_CREATE: { intent: 'GUILDS', group: '频道', desc: '子频道被创建' },
  CHANNEL_UPDATE: { intent: 'GUILDS', group: '频道', desc: '子频道被更新' },
  CHANNEL_DELETE: { intent: 'GUILDS', group: '频道', desc: '子频道被删除' },

  /* ---------------- 频道成员 ---------------- */
  GUILD_MEMBER_ADD: { intent: 'GUILD_MEMBERS', group: '成员', desc: '成员加入频道' },
  GUILD_MEMBER_UPDATE: { intent: 'GUILD_MEMBERS', group: '成员', desc: '成员资料变更' },
  GUILD_MEMBER_REMOVE: { intent: 'GUILD_MEMBERS', group: '成员', desc: '成员被移除' },

  /* ---------------- 频道消息 ---------------- */
  MESSAGE_CREATE: {
    intent: 'GUILD_MESSAGES',
    group: '消息',
    desc: '频道内全部消息（不只是 @机器人），需私域权限',
    message: 'guild',
  },
  MESSAGE_DELETE: { intent: 'GUILD_MESSAGES', group: '消息', desc: '频道消息被删除' },

  /* ---------------- 表情表态 ---------------- */
  MESSAGE_REACTION_ADD: { intent: 'GUILD_MESSAGE_REACTIONS', group: '表情', desc: '消息被添加表情表态' },
  MESSAGE_REACTION_REMOVE: { intent: 'GUILD_MESSAGE_REACTIONS', group: '表情', desc: '消息的表情表态被移除' },

  /* ---------------- 频道私信 ---------------- */
  DIRECT_MESSAGE_CREATE: {
    intent: 'DIRECT_MESSAGE',
    group: '私信',
    desc: '收到用户发给机器人的私信',
    message: 'dm',
  },
  DIRECT_MESSAGE_DELETE: { intent: 'DIRECT_MESSAGE', group: '私信', desc: '私信被删除' },

  /* ---------------- 群聊与私聊（主力场景） ---------------- */
  GROUP_AT_MESSAGE_CREATE: {
    intent: 'GROUP_AND_C2C_EVENT',
    group: '群聊',
    desc: '群里 @机器人 发的消息',
    message: 'group',
  },
  GROUP_MESSAGE_CREATE: {
    intent: 'GROUP_AND_C2C_EVENT',
    group: '群聊',
    desc: '群里 @机器人 发的消息（平台实际下发的事件名，文档未列出）',
    message: 'group',
    doc: false,
  },
  C2C_MESSAGE_CREATE: {
    intent: 'GROUP_AND_C2C_EVENT',
    group: '私聊',
    desc: '用户单聊发消息给机器人',
    message: 'c2c',
  },
  GROUP_ADD_ROBOT: { intent: 'GROUP_AND_C2C_EVENT', group: '群聊', desc: '机器人被添加到群' },
  GROUP_DEL_ROBOT: { intent: 'GROUP_AND_C2C_EVENT', group: '群聊', desc: '机器人被移出群' },
  GROUP_MSG_REJECT: { intent: 'GROUP_AND_C2C_EVENT', group: '群聊', desc: '群管理员关闭主动消息推送' },
  GROUP_MSG_RECEIVE: { intent: 'GROUP_AND_C2C_EVENT', group: '群聊', desc: '群管理员开启主动消息推送' },
  FRIEND_ADD: { intent: 'GROUP_AND_C2C_EVENT', group: '私聊', desc: '用户添加机器人' },
  FRIEND_DEL: { intent: 'GROUP_AND_C2C_EVENT', group: '私聊', desc: '用户删除机器人' },
  C2C_MSG_REJECT: { intent: 'GROUP_AND_C2C_EVENT', group: '私聊', desc: '用户关闭主动消息推送' },
  C2C_MSG_RECEIVE: { intent: 'GROUP_AND_C2C_EVENT', group: '私聊', desc: '用户开启主动消息推送' },

  /* ---------------- 互动 ---------------- */
  INTERACTION_CREATE: { intent: 'INTERACTION', group: '互动', desc: '按钮等互动组件被点击' },

  /* ---------------- 消息审核 ---------------- */
  MESSAGE_AUDIT_PASS: { intent: 'MESSAGE_AUDIT', group: '审核', desc: '主动消息审核通过' },
  MESSAGE_AUDIT_REJECT: { intent: 'MESSAGE_AUDIT', group: '审核', desc: '主动消息审核不通过' },

  /* ---------------- 论坛 ---------------- */
  FORUM_THREAD_CREATE: { intent: 'FORUMS_EVENT', group: '论坛', desc: '用户创建主题' },
  FORUM_THREAD_UPDATE: { intent: 'FORUMS_EVENT', group: '论坛', desc: '用户更新主题' },
  FORUM_THREAD_DELETE: { intent: 'FORUMS_EVENT', group: '论坛', desc: '用户删除主题' },
  FORUM_POST_CREATE: { intent: 'FORUMS_EVENT', group: '论坛', desc: '用户创建帖子' },
  FORUM_POST_DELETE: { intent: 'FORUMS_EVENT', group: '论坛', desc: '用户删除帖子' },
  FORUM_REPLY_CREATE: { intent: 'FORUMS_EVENT', group: '论坛', desc: '用户回复评论' },
  FORUM_REPLY_DELETE: { intent: 'FORUMS_EVENT', group: '论坛', desc: '用户删除评论' },
  FORUM_PUBLISH_AUDIT_RESULT: { intent: 'FORUMS_EVENT', group: '论坛', desc: '帖子审核结果' },

  /* ---------------- 音频 ---------------- */
  AUDIO_START: { intent: 'AUDIO_ACTION', group: '音频', desc: '音频开始播放' },
  AUDIO_FINISH: { intent: 'AUDIO_ACTION', group: '音频', desc: '音频播放结束' },
  AUDIO_ON_MIC: { intent: 'AUDIO_ACTION', group: '音频', desc: '上麦' },
  AUDIO_OFF_MIC: { intent: 'AUDIO_ACTION', group: '音频', desc: '下麦' },

  /* ---------------- 频道 @消息（公域） ---------------- */
  AT_MESSAGE_CREATE: {
    intent: 'PUBLIC_GUILD_MESSAGES',
    group: '消息',
    desc: '频道里 @机器人 的消息',
    message: 'guild',
  },
  PUBLIC_MESSAGE_DELETE: {
    intent: 'PUBLIC_GUILD_MESSAGES',
    group: '消息',
    desc: '频道消息被删除（公域可见）',
  },
};

/** 所有事件名，按登记顺序 */
export const EVENT_NAMES = Object.keys(EVENTS);

/** 这是不是内核认识的事件 */
export function isKnownEvent(name) {
  return Object.hasOwn(EVENTS, name);
}

/** 事件是否需要规范化成 Message */
export function messageKindOf(name) {
  return EVENTS[name]?.message ?? null;
}

/** 事件属于哪个 intent */
export function intentOf(name) {
  return EVENTS[name]?.intent ?? null;
}

/** 某 intent 位对应的所有事件 */
export function eventsOfIntent(intentName) {
  return EVENT_NAMES.filter((n) => EVENTS[n].intent === intentName);
}

/**
 * 把 intents 掩码翻译成人类可读的订阅摘要。
 * @returns {{enabled:string[], disabled:string[], unknownBits:number[]}}
 */
export function describeIntents(mask) {
  const enabled = [];
  const disabled = [];
  for (const [name, meta] of Object.entries(INTENT_META)) {
    if (mask & (1 << meta.bit)) enabled.push(name);
    else disabled.push(name);
  }
  const known = Object.values(INTENT_META).reduce((a, m) => a | (1 << m.bit), 0);
  const unknownBits = [];
  for (let b = 0; b < 32; b++) {
    const bit = 1 << b;
    if (mask & bit && !(known & bit)) unknownBits.push(b);
  }
  return { enabled, disabled, unknownBits };
}

/** 按分组汇总，面板画表用 */
export function groupEvents() {
  const out = new Map();
  for (const [name, meta] of Object.entries(EVENTS)) {
    if (!out.has(meta.group)) out.set(meta.group, []);
    out.get(meta.group).push({ name, ...meta });
  }
  return out;
}
