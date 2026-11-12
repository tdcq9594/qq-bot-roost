/**
 * 宿主协议的统一发送出口
 * ====================
 *
 * **协议侧发消息必须走 `R.outbound`，不能直连 `R.api`。**
 *
 * ai-chat 在 `index.js` 的 `/r/send` 上专门写过这条警告，原因一样：
 * `R.api.sendGroup()` 只是「打一次官方接口」，而 `R.outbound.send()` 才是框架的
 * 出站调度器，它额外负责：
 *
 *   · 离线判断（没连上就别打接口）
 *   · 每秒限速 / 每分钟主动消息条数上限
 *   · 主动消息日额度（默认 1000 条/天）
 *   · 被动回复窗口检查（群 5 分钟 / 单聊 60 分钟），快过期就降级为主动消息
 *   · 被动回复次数上限（群 5 次 / 单聊 4 次，撞 40034128 之前本地拦）
 *   · 审核识别（304023 → `pending`，不是失败）
 *   · 投递账本（`delivery.get` 的前置：不走 outbound 就永远查不到终态）
 *   · `dry` 演练模式
 *
 * 之前的实现四条发送路径（msg.send / media.send / media.image.send / msg.stream）
 * 全是 `api.sendGroup(...)` 直发，上面这些一条都不参与——主动搭话等于裸奔，
 * 审核之后也没人知道结果。这里统一收口。
 *
 * ## 为什么保留直连兜底
 *
 * `R.outbound` 在机器人连上之前是 `null`（bot.js 先赋 null，等连接建立才 new）。
 * 启动早期收到发送请求时只能直发，但**必须打日志**——静默绕过会让额度账本
 * 变成半真，比不支持更糟。
 */

/** 账本里这条消息的归属。固定值，不接受协议参数覆盖（避免伪造发送方） */
export const HOST_PLUGIN = 'host';

/**
 * 被动回复窗口判断只看 `receivedAt`（outbound.js 里 `age = receivedAt ? ... : 0`）。
 *
 * 不传就等于「刚收到」，窗口检查永远不触发，过期消息会被当成新鲜消息发出去，
 * 最后由官方返回 40034xxx 报错收拾。所以客户端没给时，按 eventId 去事件账本
 * 反查一次收到时间——`events` 表的主键就是 eventId，`get()` 拿得到 `at`。
 *
 * @param {object} R    BotRuntime
 * @param {object} p    协议参数
 * @returns {number} 毫秒时间戳；拿不到返回 0（交给 outbound 按「不判断」处理）
 */
export function receivedAtOf(R, p) {
  const direct = Number(p?.receivedAt) || 0;
  if (direct > 0) return direct;
  const eid = String(p?.eventId ?? '').trim();
  if (!eid) return 0;
  try {
    const row = R?.ledger?.get?.(eid);
    if (row?.at) return Number(row.at);
  } catch {
    /* 账本没开 / 查不到：当成不知道，别因为反查失败拦住发送 */
  }
  return 0;
}

/**
 * 发一条消息（文本或富媒体），统一走 outbound。
 *
 * @param {object} p
 * @param {object} p.R           BotRuntime
 * @param {(m:string)=>void} [p.log]
 * @param {'group'|'c2c'} p.kind
 * @param {string} p.chatId
 * @param {object} p.payload     交给 api.js 的报文（驼峰字段：msgId / msgSeq / media …）
 * @param {number} [p.receivedAt] 这条消息的接收时间，用于被动窗口判断
 * @param {string} [p.requestId]  投递账本幂等键（跨重启有效，比 clientMsgId 强）
 * @param {number} [p.fileType]   1 图 / 2 视频 / 3 语音 / 4 文件，只用于账本占位
 * @returns {Promise<{id:string, pending:boolean, requestId:string, reused:boolean, raw:any}>}
 */
export async function sendOut({
  R,
  log = () => {},
  kind,
  chatId,
  payload,
  receivedAt = 0,
  requestId = '',
  fileType = null,
}) {
  const k = kind === 'group' ? 'group' : 'c2c';
  const target = String(chatId ?? '');
  const body = payload && typeof payload === 'object' ? payload : {};
  const rid = String(requestId ?? '').trim();

  const ob = R?.outbound;
  if (ob && typeof ob.send === 'function') {
    const r = await ob.send({
      kind: k,
      target,
      /** 限速 / 额度都是按 `kind:chatId` 记账的，和框架其他地方保持同一口径 */
      chatKey: `${k}:${target}`,
      payload: body,
      ...(receivedAt ? { receivedAt: Number(receivedAt) } : {}),
      ...(rid ? { requestId: rid } : {}),
      ...(fileType != null ? { fileType: Number(fileType) } : {}),
      plugin: HOST_PLUGIN,
    });
    return {
      id: String(r?.id ?? ''),
      pending: Boolean(r?.pending),
      requestId: String(r?.requestId ?? rid ?? ''),
      reused: Boolean(r?.reused),
      raw: r?.raw ?? r ?? null,
    };
  }

  /**
   * 兜底直发。只在机器人启动早期（outbound 还没 new 出来）走到，
   * 打日志是因为这条路径**不参与限速和额度**，事后排查要看得到。
   */
  log(`外接协议：outbound 未就绪，这条消息直连官方接口（不限速、不记额度、不进投递账本）`);
  const api = R?.api;
  if (!api) throw new Error('官方接口未就绪');
  const r = k === 'group' ? await api.sendGroup(target, body) : await api.sendC2C(target, body);
  return {
    id: String(r?.id ?? r?.msgId ?? ''),
    pending: Number(r?.code) === 304023,
    requestId: rid,
    reused: false,
    raw: r ?? null,
  };
}
