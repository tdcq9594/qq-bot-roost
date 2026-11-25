/**
 * 一条入站消息要不要交给协议层（OneBot / 宿主）。
 *
 * 两类通道的语义不同，不能共用一条判据：
 *
 *   · **观测**（账本 / metrics / message-bus / 日志）——记的是「到达过什么」。
 *     官方重推的每一份都该留下痕迹，排查时才看得到「同一条来了三次」。
 *   · **触发**（OneBot / 宿主协议）——收一条就处理一条。同一份消息交两次，
 *     下游就会回两次；AI 宿主还会把两份拼进同一轮上下文。
 *
 * 2026-11-26 用户反馈「模型一次收到三条相同的『你是谁』」就是后者：
 * QQ 官方为保证可达会重推相同 `msg_id` 的消息，`ledger.append()` 已经用
 * dedupe 唯一约束识别出来并返回 `duplicate: true`，但转发处以前不看这个标记，
 * 每条重推都再 `host.onMessage()` 一次，最终在 dsh-roost 的合并窗口里拼成一批。
 *
 * 纯函数：`bot.js` 的 dispatch 要构造账本 / 管线 / 群名缓存一堆依赖，
 * 把判断抽出来才能单独钉住。
 *
 * @param {object} o
 * @param {boolean} o.hasContent   正文 / 附件 / 卡片 / 元素有任意一样（空消息不推）
 * @param {boolean} o.silent       静默消息（@ 别的机器人 / 只回@模式的裸命令）
 * @param {boolean} o.forwardSilent `plugins.forwardSilentToProtocol`，默认 true
 * @param {boolean} o.duplicate    账本判定为官方重推
 */
export function shouldForwardInbound({ hasContent, silent, forwardSilent, duplicate } = {}) {
  if (!hasContent) return false;
  /** 静默消息按用户开关决定要不要给协议层（issue #38），默认照旧全交 */
  if (silent && !forwardSilent) return false;
  /** 官方重推：协议层只该被触发一次 */
  return duplicate !== true;
}

/**
 * 账本说的 `duplicate` 是不是**官方重推**。
 *
 * `ledger.append()` 的 dedupe 有两套键：
 *   · 有 `msg.id`（QQ 官方消息 id）→ `botId:msgId`，重推必然同一个 id，可信；
 *   · 没有 id → 退化成 `botId:chatId:at:digest` 指纹，**同一秒连发两句一样的
 *     话也会撞**。那种情况只是账本合并了一行，不能连协议层一起吞——
 *     用户真的问了两遍，等的是两次回答。
 *
 * 所以只有拿到官方 id 才认重推。拿不到就放行（dsh-roost 那边也会因为
 * 没有 eventId / msgId 而 fail-open）。**宁可重复，不可吞真消息。**
 *
 * @param {{duplicate?: boolean}|null|undefined} rec `ledger.append()` 的返回值
 * @param {string} msgId `msg.id`（QQ 官方消息 id，可能为空）
 */
export function isOfficialDuplicate(rec, msgId) {
  return rec?.duplicate === true && String(msgId ?? '').trim() !== '';
}
