/**
 * 框架插件 ↔ DSH 扩展：反向调用桥
 * ================================
 *
 * 直连协议（roost-host/1）里 DSH 是客户端、框架是服务端，所以「扩展调框架
 * 插件工具」天然走得通（`tool.*`）；反过来「框架插件调扩展」需要一条回程。
 *
 * 不新开端口、不给 DSH 发令牌：复用协议已有的两条通道——
 *
 *   框架 --SSE 事件 `ext.call.request`--> DSH
 *   框架 <--HTTP RPC `ext.call.reply`-- DSH
 *
 * 这一层只管「请求 → 等回执」的配对，是纯逻辑，不碰网络：
 *
 *   · 每个请求一个 id，带超时（DSH 没连上 / 扩展卡住都要能失败，不能挂死）；
 *   · 回执只能认自己发出去的 id，杜绝别的客户端伪造结果；
 *   · 能力清单由 DSH 连上后上报（`ext.register`），框架不主动扫盘。
 *
 * 为什么扩展能力不投影成 `tool.*`：`tool.*` 的 scope 是 `message`，谁拿到
 * 协议令牌都能调；而扩展动作可能带写操作（发消息、评论），应当只在框架
 * 插件明确调用时才发生，且由 DSH 自己按 `ui.actions` 白名单把着。
 */

import { HostError } from './methods.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PENDING = 32;
const MAX_PAYLOAD_KEYS = 40;

export function createExtBridge({ pushEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  /** requestId -> { resolve, reject, timer, at } */
  const pending = new Map();
  /** DSH 上报的扩展能力清单：{ extId, actions:[{id,label}] }[] */
  let catalog = [];
  let catalogAt = 0;
  let seq = 0;

  function fail(p, e) {
    clearTimeout(p.timer);
    pending.delete(p.id);
    p.reject(e);
  }

  /**
   * 发起一次反向调用。
   *
   * @returns {Promise<any>} DSH 回执里的 result
   */
  async function call({ extId = '', action = '', payload = null, chat = '' } = {}) {
    const id = String(extId ?? '').trim();
    const act = String(action ?? '').trim();
    if (!id || !act) throw new HostError('BAD_PARAMS', '要给 extId 与 action', 400);
    if (pending.size >= MAX_PENDING) {
      throw new HostError('BUSY', `同时最多 ${MAX_PENDING} 个扩展调用，稍后再试`, 429);
    }

    const requestId = `exc-${Date.now().toString(36)}-${++seq}`;
    /** payload 只收一层对象，超量的键直接截断，避免把整份配置塞进事件流 */
    let args = null;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      args = Object.fromEntries(Object.entries(payload).slice(0, MAX_PAYLOAD_KEYS));
    }

    const promise = new Promise((resolve, reject) => {
      /**
       * **不要 unref**：这个定时器是请求生命周期本身的一部分。unref 之后
       * 若进程里暂时没有别的活跃 handle（例如框架正在停机、或单测环境），
       * 超时永远不触发，调用方会永久挂在 await 上。停机路径由
       * `HostBridge.#stopNow()` 调 `clear()` 统一解掉，不会拖住退出。
       */
      const timer = setTimeout(() => {
        const p = pending.get(requestId);
        if (p) fail(p, new HostError('TIMEOUT', `扩展 ${id}.${act} 没在 ${timeoutMs}ms 内回执`, 504));
      }, timeoutMs);
      pending.set(requestId, { id: requestId, resolve, reject, timer, at: Date.now() });
    });

    try {
      pushEvent('ext.call.request', {
        requestId, extId: id, action: act, payload: args,
        /** 调用方所在会话，DSH 侧要按它派生扩展的上下文；可为空 */
        chat: String(chat ?? '').slice(0, 120),
      });
    } catch (e) {
      const p = pending.get(requestId);
      if (p) fail(p, new HostError('INTERNAL', `推不出扩展调用事件：${e?.message ?? e}`, 500));
    }
    return await promise;
  }

  /** DSH 通过 RPC 回执。认不出 id 一律拒绝，别让旧回执解掉新请求 */
  function reply({ requestId = '', ok = true, result = null, error = '' } = {}) {
    const key = String(requestId ?? '').trim();
    const p = pending.get(key);
    if (!p) throw new HostError('NOT_FOUND', '没有这个待回执的扩展调用（可能已超时）', 404);
    clearTimeout(p.timer);
    pending.delete(key);
    if (ok === false) {
      p.reject(new HostError('EXT_FAILED', String(error ?? '扩展调用失败').slice(0, 300), 502));
      return { ok: true, settled: key, failed: true };
    }
    p.resolve(result ?? null);
    return { ok: true, settled: key };
  }

  /** DSH 连上 / 扩展装卸后上报能力清单 */
  function register({ extensions = [] } = {}) {
    const list = Array.isArray(extensions) ? extensions : [];
    catalog = list
      .filter((e) => e && typeof e.id === 'string' && e.id)
      .map((e) => ({
        extId: e.id.slice(0, 64),
        actions: (Array.isArray(e.actions) ? e.actions : [])
          .filter((a) => a && typeof a.id === 'string' && a.id)
          .slice(0, 60)
          .map((a) => ({ id: a.id.slice(0, 80), label: String(a.label ?? a.id).slice(0, 120) })),
      }));
    catalogAt = Date.now();
    log(`扩展能力清单已更新：${catalog.length} 个扩展 / ${catalog.reduce((n, e) => n + e.actions.length, 0)} 个动作`);
    return { ok: true, count: catalog.length };
  }

  return {
    call,
    reply,
    register,
    list: () => ({
      extensions: catalog.map((e) => ({ extId: e.extId, actions: e.actions.map((a) => ({ ...a })) })),
      updatedAt: catalogAt,
      pending: pending.size,
    }),
    /** 断线时把还在等的请求全部解掉，别让框架插件永远挂在 await 上 */
    clear: (why = '链路断开') => {
      for (const p of [...pending.values()]) {
        fail(p, new HostError('DISCONNECTED', `${why}，扩展调用已取消`, 503));
      }
    },
    pendingCount: () => pending.size,
  };
}
