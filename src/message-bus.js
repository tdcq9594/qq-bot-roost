/**
 * 消息总线：把「收到一条消息」从机器人运行时传给面板 / 外部订阅者。
 *
 * 为什么单独一个文件：`main.js` 负责建运行时，`web/server.js` 负责推 SSE，
 * 两边直接互相 import 会成环。中间垫一层最省事。
 *
 * 谁会订阅：
 *   - 面板的 SSE 通道（`event: message`）
 *   - 将来接 DSH 之类的 AI 宿主（dsh-roost 插件就是靠这个通道收消息）
 *
 * **只推规范化后的字段，绝不推 raw**：官方事件体里有 `auth_token`，
 * 泄漏出去等于把会话凭据给了订阅者。
 */

/** @type {Set<(payload:object)=>void>} */
const listeners = new Set();

/**
 * 订阅消息。返回取消订阅的函数。
 * @param {(payload:object)=>void} fn
 */
export function onMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 当前订阅者数量（面板上显示「有没有人在听」用） */
export function messageListenerCount() {
  return listeners.size;
}

/**
 * 发一条消息给所有订阅者。
 * 单个订阅者抛错不影响别人——订阅者可能是插件写的，不能让它拖垮收消息。
 *
 * @param {string} botId
 * @param {object} msg buildMessage 的产物
 */
export function emitMessage(botId, msg) {
  if (!listeners.size) return;
  const payload = serializeMessage(botId, msg);
  for (const fn of listeners) {
    try {
      fn(payload);
    } catch {
      // 订阅者自己的问题，忽略
    }
  }
}

/** 附件：只留白名单字段，`raw` 里可能有原始事件片段 */
function safeAttachments(list) {
  return (Array.isArray(list) ? list : []).map((a) => ({
    type: a.type,
    url: a.url,
    filename: a.filename,
    size: a.size,
    width: a.width,
    height: a.height,
    contentType: a.contentType,
    wavUrl: a.wavUrl,
    asrText: a.asrText,
  }));
}

/** 卡片：结构化字段，去掉 raw */
function safeArk(a) {
  if (!a) return null;
  return { type: a.type, name: a.name, prompt: a.prompt, title: a.title, desc: a.desc, url: a.url, fields: a.fields };
}

/** 消息元素：递归去掉 raw，只留用得上的 */
function safeElements(list, depth = 0) {
  if (depth > 3) return [];
  return (Array.isArray(list) ? list : []).map((el) => ({
    type: el.type,
    messageType: el.messageType,
    msgIdx: el.msgIdx,
    author: el.author,
    content: el.content,
    attachments: safeAttachments(el.attachments),
    ark: safeArk(el.ark),
    children: safeElements(el.children, depth + 1),
  }));
}

/**
 * 规范化后的消息 → 订阅者能安全消费的形状。
 *
 * 字段名跟 `dsh-roost/docs/接入说明.md` 里约定的契约一致，改这里要同步改那边。
 *
 * @param {string} botId
 * @param {object} msg
 */
export function serializeMessage(botId, msg) {
  return {
    botId,
    kind: msg.kind,
    chatId: msg.chatId,
    groupId: msg.groupId,
    userId: msg.userId,
    userName: msg.userName,
    content: msg.content,
    mentioned: Boolean(msg.mentioned),
    addressed: Boolean(msg.addressed),
    isCommand: Boolean(msg.isCommand),
    /** 被动回复用（5 分钟窗口，同一条最多 5 次） */
    msgId: msg.id,
    /** 引用回复用（message_reference.message_id） */
    msgIdx: msg.msgIdx,
    /** 这条消息引用了谁 */
    refMsgIdx: msg.refMsgIdx,
    /** 被引用的原文 */
    quoted: msg.quoted,
    attachments: safeAttachments(msg.attachments),
    ark: safeArk(msg.ark),
    elements: safeElements(msg.elements),
    at: msg.at,
  };
}
