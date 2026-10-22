import { createLogger } from './logger.js';
import { FILE_TYPE } from './api.js';

const log = createLogger('message');

/** 事件名 → 消息来源类型 */
const MESSAGE_EVENTS = {
  // 官方文档写的是 GROUP_AT_MESSAGE_CREATE，但平台实际会下发 GROUP_MESSAGE_CREATE
  // （可能是新版事件名 / 全量群消息权限），两者载荷结构一致，都要认
  GROUP_AT_MESSAGE_CREATE: 'group',
  GROUP_MESSAGE_CREATE: 'group',
  C2C_MESSAGE_CREATE: 'c2c',
  AT_MESSAGE_CREATE: 'guild',
  DIRECT_MESSAGE_CREATE: 'dm',
};

export function isMessageEvent(name) {
  return name in MESSAGE_EVENTS;
}

/** 去掉频道消息里的 @机器人 前缀，如 "<@!123456> /help" */
function stripMention(content) {
  return String(content ?? '').replace(/^\s*<@!?\d+>\s*/, '').trim();
}

/** 正文里是否 @ 了机器人（新版群消息事件可能是全量消息，需要自己判断） */
function hasMention(raw) {
  return /<@!?\d+>/.test(String(raw ?? ''));
}

/**
 * 把官方事件体统一成好用的 Message 对象，插件只跟它打交道。
 */
export function buildMessage(eventName, d, { api, cfg }) {
  const kind = MESSAGE_EVENTS[eventName] ?? 'unknown';

  let groupId = '';
  let userId = '';
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
  const mentioned = hasMention(d.content);

  const msg = {
    id: d.id ?? '',
    kind,
    event: eventName,
    groupId,
    userId,
    chatId: groupId || userId,
    content,
    raw: d,
    mentioned,
    isCommand,
    command: '',
    args: [],
    at: Number(d.timestamp) || Date.now(),
  };

  if (isCommand) {
    const body = content.slice(prefix.length).trim();
    const [cmd, ...rest] = body.split(/\s+/);
    msg.command = (cmd || '').toLowerCase();
    msg.args = rest;
  }

  // 底层发送：group 走群接口，c2c 走单聊接口
  const send = (opts, passive) => {
    const body = passive ? { msgId: msg.id, ...opts } : { ...opts };
    if (kind === 'group') return api.sendGroup(groupId, body);
    if (kind === 'c2c') return api.sendC2C(userId, body);
    return Promise.resolve(null);
  };

  /** 被动回复（带 msg_id，5 分钟内有效，msg_seq 自动递增） */
  msg.reply = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    return send({ content: String(text), ...opts }, true);
  };

  /** 主动推送（不带 msg_id，有频次限制） */
  msg.push = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    return send({ content: String(text), ...opts }, false);
  };

  /** Markdown 消息（可带按钮 keyboard） */
  msg.replyMarkdown = (markdown, keyboard) =>
    send({ markdown, keyboard }, true).catch((e) => {
      log.error('发送 Markdown 失败:', e.message);
      return null;
    });

  /** 发富媒体：上传后以 msg_type=7 发送 */
  const replyMedia = async (fileType, source, { local = false } = {}) => {
    if (!source) return null;
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

  return msg;
}
