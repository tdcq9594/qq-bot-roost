import { createLogger } from './logger.js';

const log = createLogger('message');

/** 事件名 → 消息来源类型 */
const MESSAGE_EVENTS = {
  GROUP_AT_MESSAGE_CREATE: 'group',
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

/**
 * 把官方事件体统一成一个好用的 Message 对象，插件只跟它打交道。
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

  const msg = {
    id: d.id ?? '',
    kind,
    event: eventName,
    groupId,
    userId,
    content,
    raw: d,
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

  // 统一的回复入口。被动回复必须在 5 分钟内，且同一 msg_id 的 msg_seq 要递增（api 层已处理）
  msg.reply = (text, opts = {}) => {
    if (text === undefined || text === null || text === '') return Promise.resolve(null);
    const body = { content: String(text), msgId: msg.id, ...opts };
    if (kind === 'group') return api.sendGroup(groupId, body);
    if (kind === 'c2c') return api.sendC2C(userId, body);
    return Promise.resolve(null); // 频道消息暂不走 v2 接口
  };

  // 主动推送：不带 msg_id，属于主动消息（有频次限制）
  msg.push = (text, opts = {}) => {
    const body = { content: String(text), ...opts };
    if (kind === 'group') return api.sendGroup(groupId, body);
    if (kind === 'c2c') return api.sendC2C(userId, body);
    return Promise.resolve(null);
  };

  /** 发图片：先上传拿到 file_info，再以 msg_type=7 发送 */
  msg.replyImage = async (imageUrl) => {
    try {
      if (kind === 'group') {
        const up = await api.postGroupFile(groupId, { fileType: 1, url: imageUrl, srvSendMsg: false });
        return api.sendGroup(groupId, {
          msgId: msg.id,
          msgType: 7,
          content: ' ',
          media: { file_info: up?.file_info },
        });
      }
      if (kind === 'c2c') {
        const up = await api.postC2CFile(userId, { fileType: 1, url: imageUrl, srvSendMsg: false });
        return api.sendC2C(userId, {
          msgId: msg.id,
          msgType: 7,
          content: ' ',
          media: { file_info: up?.file_info },
        });
      }
    } catch (e) {
      log.error('发送图片失败:', e.message);
    }
    return null;
  };

  return msg;
}
