/**
 * 链路追踪 id
 * ===========
 *
 * 一条消息要穿过四段：QQ 事件 → Roost 内核 → ai-chat 插件 → dsh-roost → 模型。
 * 出问题时现在只能翻四个日志文件对时间戳——用户说「刚才那条没回」，
 * 根本不知道该看哪一段。
 *
 * 这里生成一个短 id，进站时打上，每段日志都带着它，面板也能按它串起来。
 *
 * 为什么不是 UUID：要能在日志里一眼扫到、能手打、能贴进群里问。
 * 时间前缀（36 进制）让同一秒内的 id 也有序，后面 6 位十六进制够区分。
 * 碰撞概率：同一毫秒内 1/1677 万，对一个群聊机器人足够。
 */
import crypto from 'node:crypto';

/**
 * @returns {string} 形如 `m3k9x2a1f3c4`
 */
export function newTraceId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** 日志前缀：统一成 `[trace:xxxx]`，方便 grep */
export function traceTag(id) {
  const t = String(id ?? '').trim();
  return t ? `[trace:${t}]` : '';
}
