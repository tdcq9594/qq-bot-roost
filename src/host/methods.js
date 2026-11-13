/**
 * 宿主协议 v1 的方法表
 * =====================
 *
 * 和 OneBot 兼容层的 `actions.js` 不同，这里**不翻译**任何数据：
 * 方法名就是框架的对象与方法，事件就是内核的 `Message`。
 *
 * 「能调用框架全部协议 API」靠 `qq.call` 反射 `QQApi.prototype` 实现，
 * 不靠手写几十个包装——`src/api.js` 以后加方法，这里自动可用。
 *
 * 每个方法声明一个 scope。`call()` 在进方法体之前先校验，
 * 不把权限判断散落到各个方法里。
 */

import { saveBotConfig } from '../config.js';
import { recentLogs } from '../logger.js';
import { createToolCaller } from '../plugin/tools.js';
import { OFFICIAL_ENDPOINTS, riskOf } from '../endpoints.js';
import { registerMedia } from './media.js';
import { registerOps } from './ops.js';
import { sendOut, receivedAtOf } from './dispatch.js';

export const HOST_PROTOCOL = 1;

/** 带 code 的错误：协议层要把它变成 res.error，不能只给一句 message */
export class HostError extends Error {
  constructor(code, message, http = 400) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.http = http;
  }
}

const bad = (msg) => new HostError('BAD_PARAMS', msg, 400);
const notFound = (msg) => new HostError('NOT_FOUND', msg, 404);
const notReady = (msg) => new HostError('NOT_READY', msg, 503);

const str = (v, d = '') => (v === undefined || v === null ? d : String(v));

/**
 * 一个 token 实际能用的 scope。
 *
 * `allowManage` 是总闸：false 时哪怕配置里写了 manage 也删掉。
 *
 * **scope 怎么分（2026-11-13 定）**：`manage` 只留给**改框架自己的重要状态**——
 * 也就是「能改权限」或「能以宿主身份执行代码」的那些：
 *   - `config.set`（含 owners / whitelist，绑错等于给错人权限）
 *   - `identity.bind` / `identity.unbind`（身份表就是权限的依据）
 *   - `plugin.config.set`（插件密钥）
 *   - `plugin.tool.call`（以宿主身份调插件工具，绕过 AI 权限）
 * 其余**运维动作**一律 `message`：发消息、群管（禁言/踢人/审批）、暂停闸、
 * 插件启停与热重载。理由：这些是「对外做事」或「临时刹车」，不改权限也不会
 * 悄悄提权；让用户为了暂停一下去开总闸，只会逼他把总闸常开。
 */
export function effectiveScopes(cfg = {}) {
  const out = new Set(['read']);
  const want = Array.isArray(cfg.scopes) ? cfg.scopes : ['read', 'message'];
  for (const s of want) {
    if (s === 'message' || s === 'manage') out.add(s);
  }
  if (!cfg.allowManage) out.delete('manage');
  return out;
}

/**
 * `config.set` 只收运行时设置。
 *
 * 不收 `appId` / `appSecret` / `baseUrl` / `connection`：改这些要么要重连
 * 网关、要么涉及密钥，面板那条路径有一整套校验和重连逻辑，在这里另写一份
 * 必然分叉。`host.token` 更不能收——协议改自己的令牌等于能把自己锁在门外。
 */
const CONFIG_KEYS = new Set([
  'name', 'commandPrefix', 'owners', 'whitelist', 'rateLimit',
  'dedupWindowSec', 'messageLog', 'groupManage', 'media',
]);

/** 只读配置时脱敏：键名命中就打码，不管它藏在第几层 */
const SECRET_KEY = /(secret|token|password|apikey|accesskey|credential|cookie)/i;
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = SECRET_KEY.test(k) ? (x ? '********' : x) : redact(x);
  }
  return out;
}

/** Object.prototype 上的方法不许被 `qq.call` 反射出来 */
const QQ_DENY = new Set([
  'constructor', '__proto__', '__defineGetter__', '__defineSetter__',
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
  'toLocaleString', 'toString', 'valueOf',
]);

/** 官方端点标 `internal:true` 的方法：面板不许调，协议也不许绕过去 */
const QQ_INTERNAL_APIS = new Set(
  OFFICIAL_ENDPOINTS.filter((e) => e.internal && e.api).map((e) => e.api),
);

/**
 * `qq.call` 额外拒绝的方法。分三类：
 *  - 路径型上传：宿主在另一台机器，传框架本机路径等于让它读任意文件，
 *    跨进程请走 media.upload / media.markdownImage（它们也做 scene / 预检）。
 *  - 改了框架状态却不落盘：setGroupInvited / setMediaPlaceholderSpace 走 config.set。
 *  - takeSeq：抢被动回复序号，会让框架自己的回复撞 40054005。
 */
const QQ_BLOCKED_APIS = new Set([
  ...QQ_INTERNAL_APIS,
  'uploadLocalFile', 'uploadLocalFileSharded', 'uploadMarkdownImage',
  'setGroupInvited', 'setMediaPlaceholderSpace', 'takeSeq',
]);

/** api 方法名 → 最严风险档（未登记端点的辅助方法按 write 处理） */
const QQ_RISK = (() => {
  const order = { read: 0, write: 1, danger: 2 };
  const m = new Map();
  for (const e of OFFICIAL_ENDPOINTS) {
    if (!e.api) continue;
    const r = riskOf(e);
    if (!m.has(e.api) || order[r] > order[m.get(e.api)]) m.set(e.api, r);
  }
  return m;
})();

/** read 类接口（getMe / getGroupInfo 等）不再要求打开 allowManage 总闸 */
const scopeForQq = (name) => {
  const r = QQ_RISK.get(name) ?? 'write';
  return r === 'read' ? 'read' : r === 'danger' ? 'manage' : 'message';
};

/**
 * @param {object} p
 * @param {object} p.runtime     BotRuntime（传真的，别展开：方法在原型上）
 * @param {()=>object} p.getState 协议层自己的状态快照
 * @param {(m:string)=>void} [p.log]
 */
export function createMethods({ runtime: R, getState, log = () => {} }) {
  const table = new Map();
  const def = (name, scope, desc, run) => table.set(name, { name, scope, desc, run });

  /**
   * 插件注册的工具投影成一等协议方法的前缀。
   *
   * 工具名本身全局唯一（重名插件加载时就会报错），加上前缀后也不可能和
   * 内置的 70 个方法撞名。**这张表不缓存**：插件热重载 / 启停之后，下一次
   * `names()` / `describe()` / `call()` 立刻反映真实状态，卸载的工具调用会
   * 返回 404，而不是打到一个已经不存在的闭包上。
   */
  const TOOL_PREFIX = 'tool.';

  /** 被动回复 / 主动消息的幂等键：5 分钟内同一个 key 返回同一结果，不重复发 */
  const sent = new Map();
  const IDEMPOTENT_MS = 5 * 60 * 1000;
  const sweepSent = () => {
    const now = Date.now();
    for (const [k, v] of sent) if (now - v.at > IDEMPOTENT_MS) sent.delete(k);
  };

  /**
   * 流式消息的所有分片必须共用**同一个 msg_seq**，否则会和框架自己的普通回复
   * 撞 40054005（见 api.js sendStreamMessage 的注释）。协议层替宿主占号并记住，
   * 也顺带解释了为什么 `takeSeq` 不对 qq.call 开放。
   * key 可以是 msgId / eventId / streamId / 服务端返回的 stream_msg_id。
   */
  const streamSeqs = new Map();
  const STREAM_TTL_MS = 10 * 60 * 1000;
  const sweepStreams = () => {
    const now = Date.now();
    for (const [k, v] of streamSeqs) if (now - v.at > STREAM_TTL_MS) streamSeqs.delete(k);
  };
  const streamKeyOf = (p) => str(p.streamId) || str(p.msgId) || str(p.eventId) || str(p.streamMsgId);

  const qqNames = () => {
    const api = R.api;
    if (!api) return [];
    const proto = Object.getPrototypeOf(api);
    if (!proto || proto === Object.prototype) return [];
    const out = [];
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (QQ_DENY.has(k) || k.startsWith('_') || k.startsWith('#')) continue;
      let fn;
      try {
        fn = api[k];
      } catch {
        continue;
      }
      if (typeof fn === 'function') out.push(k);
    }
    return out.sort();
  };

  const plugins = () => R.plugins ?? null;

  /* ---------------- 系统 ---------------- */

  def('system.hello', 'read', '协议版本、机器人身份、当前 seq 与方法清单', async (_p, ctx) => {
    const st = getState();
    return {
      protocol: HOST_PROTOCOL,
      app: 'roost-host',
      version: st.version,
      bot: {
        id: R.id,
        name: R.name,
        appId: str(R.cfg?.appId),
        state: R.state,
        online: Boolean(R.online),
      },
      seq: st.seq,
      scopes: [...(ctx.scopes ?? [])],
      /** `dynamicTools:true` 告诉老客户端：features 里可能多出 tool.* 方法 */
      dynamicTools: true,
      features: names(),
    };
  });

  def('system.ping', 'read', '探活', async () => ({ pong: Date.now() }));

  def('system.capabilities', 'read', '完整方法表与每个方法所需的 scope', async () => describe());

  /* ---------------- 运行时 ---------------- */

  def('runtime.status', 'read', '机器人状态与协议层状态', async () => ({
    ...(R.status ?? {}),
    host: getState(),
  }));

  def('runtime.logs', 'read', '最近日志', async (p) => ({
    lines: recentLogs(Math.max(1, Math.min(500, Number(p.limit) || 200)), str(p.level, 'debug')),
  }));

  def('gate.get', 'read', '三级暂停闸快照', async () => {
    if (!R.gate) throw notReady('暂停闸未就绪');
    return await R.gate.snapshot();
  });

  def('gate.set', 'message', '设置全局 / 本鸟 / 单会话的暂停闸', async (p) => {
    if (!R.gate) throw notReady('暂停闸未就绪');
    const scope = str(p.scope, 'bot');
    const paused = typeof p.paused === 'boolean' ? p.paused : true;
    const meta = { by: 'host', reason: str(p.reason).slice(0, 200) };
    const chatId = str(p.chatId);
    if (scope === 'global') return await R.gate.setGlobal(paused, meta);
    if (scope === 'chat') return await R.gate.setChat(chatId, paused, meta);
    if (scope === 'silence') return await R.gate.setSilence(chatId, Math.max(0, Number(p.ms) || 0), meta);
    if (scope !== 'bot') throw bad('scope 只能是 global / bot / chat / silence');
    return await R.gate.setBot(paused, meta);
  });

  def('ledger.recent', 'read', '消息账本最近记录', async (p) => {
    if (!R.ledger) throw notReady('账本未就绪');
    return await R.ledger.recent({
      chatId: str(p.chatId),
      limit: Math.max(1, Math.min(200, Number(p.limit) || 50)),
    });
  });

  /* ---------------- 官方 API 全量透传 ---------------- */

  def('qq.methods', 'read', '列出 qq.call 可透传的方法、风险档与所需 scope', async () => ({
    methods: qqNames(),
    risks: Object.fromEntries(qqNames().map((n) => [n, {
      risk: QQ_RISK.get(n) ?? 'write',
      scope: scopeForQq(n),
      blocked: QQ_BLOCKED_APIS.has(n),
    }])),
  }));

  /**
   * 方法本身挂 read，具体权限在方法体内按**目标 API 的风险**判定：
   * 读接口（getMe / getGroupInfo / listPanels…）只读 scope 就能调，
   * 不必为了查个东西把 allowManage 总闸打开、顺带交出全部写权限。
   */
  def('qq.call', 'read', '按风险分级透传 QQApi 方法（read / message / manage）', async (p, ctx) => {
    if (!R.api) throw notReady('官方接口未就绪（机器人还没连上）');
    const name = str(p.method).trim();
    if (!name || !qqNames().includes(name)) {
      throw notFound(`QQApi 没有这个方法：${name || '(空)'}；用 qq.methods 看清单`);
    }
    if (QQ_INTERNAL_APIS.has(name)) {
      throw new HostError('FORBIDDEN', `${name} 是框架内部端点，请用 media.* / media.image.* 方法`, 403);
    }
    if (QQ_BLOCKED_APIS.has(name)) {
      throw new HostError('FORBIDDEN', `${name} 不经协议直调（跨进程请用 media.*，改设置请用 config.set）`, 403);
    }
    const need = scopeForQq(name);
    if (ctx.scopes && !ctx.scopes.has(need)) {
      throw new HostError('NO_SCOPE', `qq.call ${name} 需要 ${need} 权限，当前 token 没有`, 403);
    }
    if (QQ_RISK.get(name) === 'danger' && p.confirm !== true) {
      throw new HostError('FORBIDDEN', `qq.call ${name} 属于不可逆操作，要带 confirm: true`, 403);
    }
    const args = p.args === undefined ? [] : p.args;
    if (!Array.isArray(args) || args.length > 12) throw bad('args 要是数组，且最多 12 项');
    return await R.api[name](...args);
  });

  /* ---------------- 消息 ---------------- */

  def('msg.send', 'message', '发文本/富媒体；带 clientMsgId 时 5 分钟内幂等', async (p) => {
    if (!R.api) throw notReady('官方接口未就绪（机器人还没连上）');
    const kind = p.kind === 'group' ? 'group' : p.kind === 'c2c' ? 'c2c' : '';
    const chatId = str(p.chatId);
    if (!chatId || !kind) throw bad('要给 chatId，kind 只能是 group / c2c');
    const text = str(p.content);
    if (!text && !p.msgId && !p.eventId) throw bad('content / msgId / eventId 至少给一个');

    const cid = str(p.clientMsgId).slice(0, 120);
    sweepSent();
    if (cid && sent.has(cid)) return { ...sent.get(cid).data, deduped: true };

    /**
     * **必须传 camelCase**：`api.sendGroup` 内部走 `buildSendPayload()`，
     * 它解构的是 `msgId / eventId / msgSeq / msgType`，snake_case 会被整个丢掉。
     * 传成 `msg_id` 的后果很隐蔽——消息照样发出去，但被动回复退化成主动消息，
     * 白白吃掉主动额度，还可能撞频次限制。
     *
     * 富媒体字段按白名单透传：发图 / 发卡片是日常能力，不该为了它去开
     * `qq.call` 的 manage 权限。msgType 交给 buildSendPayload 按 markdown/ark/card
     * 自己算，这里只给默认值。
     */
    const body = { content: text, msgType: Number(p.msgType) || 0 };
    if (p.msgId) body.msgId = str(p.msgId);
    if (p.eventId) body.eventId = str(p.eventId);
    if (p.msgSeq !== undefined) body.msgSeq = Number(p.msgSeq);
    for (const k of ['markdown', 'keyboard', 'media', 'card', 'ark', 'messageReference']) {
      if (p[k] !== undefined) body[k] = p[k];
    }
    /**
     * 走 `sendOut`（即 `R.outbound`），不是直连 `R.api`。
     *
     * 直连会绕开限速、主动额度、离线判断、被动窗口、审核识别和投递账本——
     * ai-chat 的 `/r/send` 上也写着同一条警告。具体分工见 `dispatch.js`。
     */
    const r = await sendOut({
      R, log, kind, chatId, payload: body,
      receivedAt: receivedAtOf(R, p),
      requestId: str(p.requestId).slice(0, 120),
    });
    const data = {
      id: r.id,
      /** 保留 `msgId` 字段名：老调用方（和既有测试）读的是这个名字 */
      msgId: r.id,
      ...(r.pending ? { pending: true } : {}),
      ...(r.requestId ? { requestId: r.requestId } : {}),
      ...(r.reused ? { reused: true } : {}),
    };
    if (cid) sent.set(cid, { at: Date.now(), data });
    return data;
  });

  def('msg.retract', 'message', '撤回一条消息（不给 kind 时按账本推断）', async (p) => {
    if (!R.api) throw notReady('官方接口未就绪');
    const chatId = str(p.chatId);
    const msgId = str(p.msgId);
    if (!chatId || !msgId) throw bad('要给 chatId 和 msgId');
    let kind = p.kind === 'group' || p.kind === 'c2c' ? p.kind : '';
    if (!kind) {
      const rec = R.ledger?.get?.(msgId);
      kind = rec?.kind === 'group' || rec?.kind === 'c2c' ? rec.kind : '';
      // 以前不传就默认 c2c，群消息撤回会打到单聊端点，静默失败
      if (!kind) throw bad('账本里查不到这条消息，群聊请显式给 kind: group');
    }
    return await (kind === 'group'
      ? R.api.retractGroupMessage(chatId, msgId)
      : R.api.retractC2CMessage(chatId, msgId));
  });

  def('msg.stream', 'message', '发一片流式消息（只支持单聊；自动占用并复用 msg_seq）', async (p) => {
    if (!R.api) throw notReady('官方接口未就绪');
    /**
     * 流式消息**故意不走 outbound**：`outbound.js` 只覆盖普通消息（`#post` 里
     * 只有 sendGroup / sendC2C），流式是独立的 `sendStreamMessage` 接口，没有
     * 对应的调度路径。硬塞进去要么改 outbound 的发送模型，要么绕过它的账本——
     * 后者等于假装走了 outbound，比现在更糟。
     *
     * 但离线判断要补：这是 outbound 里唯一不影响语义、又能立刻判掉的分支。
     * 限速与额度暂时由宿主自己控制，`msg_seq` 由本层统一占号避免撞 40054005。
     */
    if (!R.mock && R.online === false) throw notReady('机器人当前没有连上 QQ，流式消息发不出去');
    const openid = str(p.chatId || p.openid).trim();
    if (!openid) throw bad('要给 chatId（单聊 openid）');
    const state = Number(p.state) === 10 ? 10 : 1;
    const content = str(p.contentRaw ?? p.content);
    if (!content && state !== 10) throw bad('要给 contentRaw');
    const key = streamKeyOf(p);
    if (!key) throw bad('要给 streamId / msgId / eventId 之一，用来串起同一条流式消息');

    sweepStreams();
    let seq = streamSeqs.get(key)?.seq;
    if (seq === undefined) {
      seq = typeof R.api.takeSeq === 'function' ? R.api.takeSeq(str(p.msgId) || key) : 1;
      streamSeqs.set(key, { seq, at: Date.now() });
    }
    const opts = {
      contentRaw: content,
      index: Math.max(0, Number(p.index) || 0),
      state,
      mode: p.mode === 'replace' ? 'replace' : 'append',
      contentType: p.contentType === 'text' ? 'text' : 'markdown',
      msgSeq: Number(p.msgSeq) || seq,
    };
    for (const k of ['streamMsgId', 'msgId', 'eventId']) {
      if (p[k] !== undefined) opts[k] = str(p[k]);
    }
    if (p.isWakeup === true) opts.isWakeup = true;

    const data = await R.api.sendStreamMessage(openid, opts);
    /** 首片返回的 stream_msg_id 也映射到同一个 seq，续片只带它也能对上 */
    const sid = str(data?.stream_msg_id ?? data?.id);
    if (sid && !streamSeqs.has(sid)) streamSeqs.set(sid, { seq, at: Date.now() });
    return { ...(data ?? {}), msgSeq: opts.msgSeq };
  });

  def('msg.get', 'read', '按 msgId 取账本记录', async (p) => {
    const id = str(p.msgId);
    if (!id) throw bad('要给 msgId');
    return (await R.ledger?.get?.(id)) ?? null;
  });

  /* ---------------- 群管 ----------------
   *
   * 为什么单开方法、不放开 `qq.call`：AI 工具对协议是外部输入，通用写面一暴露
   * 就等于把管理面交给模型（改配置、装插件、随便调官方接口）。这里每个动作
   * 一条方法，调用方只能看到「禁言」这一个能力，看不到「任意调用」。
   *
   * **scope 归属**：群管是**对外部群**动手，不改框架自己的状态，所以和 `msg.send`
   * 一样归 `message`；只有 `config.set` / `plugin.install` 这类**改框架自己**的才要
   * `manage`。这样装了就能用，不必逼用户去开总闸（`host.allowManage`）。
   * 代价是：谁拿到 `message` 谁就能管群——防线在调用方（roost 侧的档位、二次确认、
   * 每日上限、审计），不是协议层。
   *
   * 返回值统一成 `{ ok, reason, ... }` 而不是抛错：官方错误码得翻译成
   * `not_admin` / `need_invite` / `rate_limited` 这种调用方能判断的原因，
   * 让面板和模型都不去猜中文。
   *
   * 审计不在这里做：bot 只写一行日志，操作记录由 roost 侧落盘（它才有 UI）。
   */

  const MAX_MUTE_SEC = 30 * 24 * 3600;
  const MAX_BATCH = 20;

  /** 官方错误 → 可判断的原因。只认确定的几种，其余原样带出 */
  const groupFail = (e, extra = {}) => {
    const raw = String(e?.message ?? e ?? '');
    if (raw.includes('11253') || raw.includes('内邀')) {
      return { ok: false, reason: 'need_invite', msg: '群管内邀没开：踢人、群成员列表、群黑名单都要官方白名单', ...extra };
    }
    if (raw.includes('40062003')) return { ok: false, reason: 'not_admin', msg: '机器人在这个群不是管理员', ...extra };
    if (raw.includes('40054')) return { ok: false, reason: 'protected', msg: '目标是群主或管理员，官方不允许动他们', ...extra };
    if (/频繁|too many|429|频率/.test(raw)) return { ok: false, reason: 'rate_limited', msg: '太频繁了，等一会儿再试', ...extra };
    return { ok: false, reason: 'unknown', msg: raw || '官方接口出错', ...extra };
  };

  /** openid 数组归一化：去空、去重、保序；也接受单个字符串 */
  const openidList = (v) => {
    const src = Array.isArray(v) ? v : v ? [v] : [];
    const out = [];
    for (const x of src) {
      const s = str(x).trim();
      if (s && !out.includes(s)) out.push(s);
    }
    return out;
  };

  def('group.info', 'read', '群信息 + 机器人在群里的角色 + 能不能管（没内邀也能读公开信息）', async (p) => {
    if (!R.api) throw notReady('官方接口未就绪');
    const groupOpenid = str(p.groupOpenid).trim();
    if (!groupOpenid) throw bad('要给 groupOpenid');
    let info = null;
    let infoError = '';
    try {
      info = await R.api.getGroupInfo?.(groupOpenid);
    } catch (e) {
      infoError = String(e?.message ?? e);
    }
    // canManageGroup 内部带 60 秒缓存、自己吞掉内邀失败，不会抛
    const manage = (await R.api.canManageGroup?.(groupOpenid)) ?? { ok: false, role: null, reason: '状态未知' };
    return {
      groupOpenid,
      name: str(info?.group_name ?? info?.name),
      memberCount: Number(info?.member_count ?? info?.max_member_count) || 0,
      role: manage.role ?? null,
      canManage: manage.ok === true,
      manageReason: str(manage.reason),
      invited: R.api.groupInvited === true,
      infoError,
    };
  });

  def('group.mute', 'message', '禁言 / 解禁（seconds=0 解禁；最长 30 天，一次最多 20 人）', async (p) => {
    if (!R.api) throw notReady('官方接口未就绪');
    const groupOpenid = str(p.groupOpenid).trim();
    const targets = openidList(p.memberOpenids);
    if (!groupOpenid) throw bad('要给 groupOpenid');
    if (!targets.length) throw bad('要给 memberOpenids');
    if (targets.length > MAX_BATCH) return { ok: false, reason: 'too_many', msg: `一次最多 ${MAX_BATCH} 人` };
    const seconds = Math.max(0, Math.floor(Number(p.seconds) || 0));
    if (seconds > MAX_MUTE_SEC) return { ok: false, reason: 'too_long', msg: '禁言最长 30 天' };
    // 官方要的是到期时间，不是时长：这里做一次转换，调用方只管传秒
    const expire = seconds ? new Date(Date.now() + seconds * 1000).toISOString() : '';
    const members = targets.map((o) => ({
      op: seconds ? 'add' : 'del',
      member_openid: o,
      mute_expire_at: expire,
    }));
    try {
      await R.api.muteMembers(groupOpenid, members);
      log(`group.mute ${groupOpenid} ${targets.length} 人 ${seconds ? `${seconds}s` : '解禁'}`);
      return { ok: true, reason: '', seconds, targets };
    } catch (e) {
      return groupFail(e, { targets });
    }
  });

  def('group.kick', 'message', '把成员移出群（需要群管内邀；可选加黑名单）', async (p) => {
    if (!R.api) throw notReady('官方接口未就绪');
    const groupOpenid = str(p.groupOpenid).trim();
    const targets = openidList(p.memberOpenids);
    if (!groupOpenid) throw bad('要给 groupOpenid');
    if (!targets.length) throw bad('要给 memberOpenids');
    if (targets.length > MAX_BATCH) return { ok: false, reason: 'too_many', msg: `一次最多 ${MAX_BATCH} 人` };
    try {
      await R.api.removeMembers(groupOpenid, targets, { addToBlacklist: p.addToBlacklist === true });
      log(`group.kick ${groupOpenid} ${targets.length} 人`);
      return { ok: true, reason: '', targets };
    } catch (e) {
      return groupFail(e, { targets });
    }
  });

  def('group.join', 'message', '入群申请：list 列表 / approve 通过 / decline 拒绝', async (p) => {
    if (!R.api) throw notReady('官方接口未就绪');
    const groupOpenid = str(p.groupOpenid).trim();
    if (!groupOpenid) throw bad('要给 groupOpenid');
    const action = p.action === 'approve' || p.action === 'decline' ? p.action : 'list';
    if (action === 'list') {
      try {
        const r = await R.api.getJoinRequests(groupOpenid, {
          cursor: str(p.cursor),
          limit: Math.min(100, Math.max(1, Number(p.limit) || 20)),
        });
        return { ok: true, reason: '', ...(r ?? {}) };
      } catch (e) {
        return groupFail(e);
      }
    }
    const memberOpenid = str(p.memberOpenid).trim();
    const joinRequestId = str(p.joinRequestId).trim();
    if (!memberOpenid || !joinRequestId) throw bad('approve / decline 要给 memberOpenid 和 joinRequestId');
    try {
      if (action === 'approve') {
        await R.api.approveJoinRequest(groupOpenid, memberOpenid, joinRequestId);
      } else {
        await R.api.declineJoinRequest(groupOpenid, memberOpenid, {
          joinRequestId,
          rejectReason: str(p.reason),
          addToBlacklist: p.addToBlacklist === true,
        });
      }
      log(`group.join ${action} ${groupOpenid} ${memberOpenid}`);
      return { ok: true, reason: '', action, memberOpenid, joinRequestId };
    } catch (e) {
      return groupFail(e);
    }
  });

  /* ---------------- 身份 ---------------- */

  def('identity.resolve', 'read', 'openid ↔ QQ号 / 群号互查', async (p) => {
    const ident = R.identity;
    if (!ident) throw notReady('身份表未就绪');
    const kind = p.kind === 'group' ? 'group' : 'user';
    const botId = str(p.botId) || R.id;
    const openid = str(p.openid);
    const uin = str(p.uin);
    if (openid) {
      const rec = kind === 'group'
        ? ident.resolveGroup?.(botId, openid)
        : ident.resolveUser?.(botId, openid);
      return {
        kind, botId, openid,
        uin: rec?.uin ?? '',
        identityId: rec?.identityId ?? '',
        aliases: rec ? ident.aliasesOf?.(kind, rec.uin, openid) ?? [] : [],
        record: rec ?? null,
      };
    }
    if (uin) {
      const found = kind === 'group'
        ? ident.groupOpenidOf?.(botId, uin)
        : ident.openidOf?.(botId, uin);
      return { kind, botId, uin, openid: found ?? '' };
    }
    throw bad('openid / uin 至少给一个');
  });

  def('identity.list', 'read', '已绑定的身份记录', async (p) => {
    if (!R.identity) throw notReady('身份表未就绪');
    const kind = p.kind === 'group' ? 'group' : p.kind === 'user' ? 'user' : '';
    return { records: await R.identity.list(kind) };
  });

  def('identity.bind', 'manage', '绑定 openid 到 QQ号 / 群号', async (p) => {
    if (!R.identity) throw notReady('身份表未就绪');
    const uin = str(p.uin).trim();
    const openid = str(p.openid).trim();
    if (!uin || !openid) throw bad('要给 uin 和 openid');
    try {
      return await R.identity.bind({
        kind: p.kind === 'group' ? 'group' : 'user',
        uin, openid,
        botId: str(p.botId) || R.id,
        force: p.force === true,
        verifiedBy: 'host',
      });
    } catch (e) {
      throw new HostError(e?.code === 'CONFLICT' ? 'CONFLICT' : 'BAD_PARAMS', str(e?.message ?? e), 409);
    }
  });

  def('identity.unbind', 'manage', '解除绑定', async (p) => {
    if (!R.identity) throw notReady('身份表未就绪');
    const uin = str(p.uin).trim();
    if (!uin) throw bad('要给 uin');
    return await R.identity.unbind({
      kind: p.kind === 'group' ? 'group' : 'user',
      uin,
      botId: str(p.botId) || R.id,
    });
  });

  /* ---------------- 插件 ---------------- */

  def('plugin.list', 'read', '插件清单', async () => ({ plugins: plugins()?.list?.() ?? [] }));

  def('plugin.get', 'read', '单个插件详情', async (p) => {
    const id = str(p.id);
    if (!id) throw bad('要给插件 id');
    const hit = (plugins()?.list?.() ?? []).find((x) => x.id === id);
    if (!hit) throw notFound(`没有这个插件：${id}`);
    return hit;
  });

  def('plugin.enable', 'message', '启用插件', async (p) => {
    if (!plugins()) throw notReady('插件管理器未就绪');
    return { ok: await plugins().setEnabled(str(p.id), true) };
  });

  def('plugin.disable', 'message', '停用插件', async (p) => {
    if (!plugins()) throw notReady('插件管理器未就绪');
    return { ok: await plugins().setEnabled(str(p.id), false) };
  });

  def('plugin.reload', 'message', '重载插件', async (p) => {
    if (!plugins()) throw notReady('插件管理器未就绪');
    return { ok: await plugins().reload(str(p.id)) };
  });

  def('plugin.config.get', 'read', '读插件配置', async (p) => {
    const id = str(p.id);
    const item = plugins()?.loaded?.get?.(id);
    if (!item) throw notFound(`插件没加载：${id || '(空)'}`);
    /**
     * 内建插件读 ctx.config；外部子进程插件没有 ctx，得从 configStore 现读。
     * 不能只看 `configStore.data` —— 那是内部字段，外部插件可能没同步过。
     */
    const config = item.ctx?.config ?? (await item.configStore?.load?.()) ?? null;
    return { config };
  });

  def('plugin.config.set', 'manage', '改插件配置', async (p) => {
    if (!plugins()) throw notReady('插件管理器未就绪');
    const id = str(p.id);
    const patch = p.patch ?? {};
    if (!id || !patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('要给 id 与对象型 patch');
    return { config: await plugins().setConfig(id, patch) };
  });

  def('plugin.tool.list', 'read', '已注册的跨插件工具', async (p) => ({
    tools: R.registry?.listTools?.({ includeHidden: p.includeHidden === true }) ?? [],
  }));

  def('plugin.tool.call', 'manage', '以宿主身份调用插件注册的工具', async (p) => {
    const name = str(p.name).trim();
    if (!name) throw bad('要给工具名 name');
    return await callPluginTool(name, p.args ?? {}, p.msg ?? {});
  });

  def('plugin.panel', 'read', '插件面板元数据', async (p) => {
    if (!plugins()) throw notReady('插件管理器未就绪');
    return { panel: await plugins().panelOf(str(p.id)) };
  });

  def('plugin.dashboard', 'read', '插件仪表盘数据', async () => {
    if (!plugins()) throw notReady('插件管理器未就绪');
    return { dashboards: await plugins().dashboards() };
  });

  /* ---------------- 配置 ---------------- */

  def('config.get', 'read', '读配置（密钥已脱敏）', async () => redact(R.cfg ?? {}));

  def('config.set', 'manage', '改运行时设置（白名单键，凭证类请走面板）', async (p) => {
    const patch = p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch) ? p.patch : p;
    const keys = Object.keys(patch).filter((k) => CONFIG_KEYS.has(k));
    const refused = Object.keys(patch).filter((k) => !CONFIG_KEYS.has(k) && k !== 'patch');
    if (refused.length) {
      throw bad(`这些键不能通过协议改（请走面板）：${refused.join('、')}`);
    }
    if (!keys.length) throw bad('没有可改的键');

    const cfg = R.cfg;
    for (const k of keys) {
      const v = patch[k];
      switch (k) {
        case 'name':
        case 'commandPrefix':
          if (typeof v !== 'string' || !v.trim() || v.length > 120) throw bad(`${k} 要是 1–120 字字符串`);
          cfg[k] = v.trim();
          break;
        case 'owners':
          if (!Array.isArray(v)) throw bad('owners 要是数组');
          cfg.owners = v.map((x) => str(x).trim()).filter(Boolean);
          break;
        case 'whitelist':
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('whitelist 要是对象');
          cfg.whitelist = {
            enabled: Boolean(v.enabled),
            groups: (Array.isArray(v.groups) ? v.groups : []).map(String).filter(Boolean),
            users: (Array.isArray(v.users) ? v.users : []).map(String).filter(Boolean),
          };
          break;
        case 'rateLimit':
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('rateLimit 要是对象');
          cfg.rateLimit = {
            enabled: Boolean(v.enabled),
            perChatPerMinute: Math.max(1, Number(v.perChatPerMinute) || 30),
          };
          break;
        case 'dedupWindowSec':
          cfg.dedupWindowSec = Math.max(0, Number(v) || 0);
          break;
        case 'messageLog':
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('messageLog 要是对象');
          cfg.messageLog = {
            enabled: v.enabled !== false,
            muteKinds: (Array.isArray(v.muteKinds) ? v.muteKinds : [])
              .filter((x) => ['group', 'c2c', 'guild', 'dm'].includes(x)),
          };
          break;
        case 'groupManage':
          if (!v || typeof v !== 'object' || typeof v.invited !== 'boolean') {
            throw bad('groupManage.invited 必须是布尔值');
          }
          cfg.groupManage = { invited: v.invited };
          break;
        case 'media':
          if (!v || typeof v !== 'object' || typeof v.placeholderSpace !== 'boolean') {
            throw bad('media.placeholderSpace 必须是布尔值');
          }
          cfg.media = { placeholderSpace: v.placeholderSpace };
          break;
        default:
          break;
      }
    }

    await saveBotConfig(R.id, cfg);
    /** 和面板一样，这两个开关要立刻同步给 api 实例，不然得等重启才生效 */
    R.api?.setGroupInvited?.(cfg.groupManage?.invited === true);
    R.api?.setMediaPlaceholderSpace?.(cfg.media?.placeholderSpace === true);
    return { ok: true, keys, config: redact(cfg) };
  });

  /* ---------------- 扩展能力 ----------------
   * 富媒体 / 官方素材管理、ai-chat 等价能力、插件全生命周期，拆在独立模块里，
   * 共用同一张方法表，让 system.capabilities 与 scope 校验对它们同样生效。
   */
  const err = {
    bad, notFound, notReady,
    forbidden: (msg) => new HostError('FORBIDDEN', msg, 403),
  };
  registerMedia(def, { R, err, log });
  registerOps(def, { R, err, log });

  /* ---------------- 插件工具 → 一等协议方法（方案 A） ---------------- */

  /**
   * 以宿主身份执行一个插件工具。`plugin.tool.call` 与动态投影共用这一条，
   * 免得两处权限/超时/重入语义慢慢分叉。
   *
   * 注意：能拿到 manage / message scope 的本来就是受信任的宿主客户端，
   * 这里不要求它伪造用户身份；`ownerOnly` / `admin` 工具在投影层已经被
   * 提到 manage scope，见 `dynamicMethods()`。
   */
  async function callPluginTool(name, args, given = {}) {
    if (!R.registry) throw notReady('工具注册表未就绪');
    const caller = createToolCaller({
      registry: R.registry,
      isOwner: () => true,
      can: async () => true,
      scopeOf: () => 'host',
      log: (m) => log(`host.tool: ${m}`),
    });
    const msg = given && typeof given === 'object' && !Array.isArray(given)
      ? { userId: '', chatId: '', kind: 'c2c', userName: 'host', ...given }
      : { userId: '', chatId: '', kind: 'c2c', userName: 'host' };
    return await caller(name, args ?? {}, { msg, stack: [] });
  }

  /** 只做顶层 required / type 校验；完整 JSON Schema 由插件自己在 execute 里把关 */
  function validateToolArgs(schema, args) {
    if (!schema || typeof schema !== 'object') return;
    for (const k of Array.isArray(schema.required) ? schema.required : []) {
      if (args?.[k] === undefined || args?.[k] === null) throw bad(`工具缺参数 ${k}`);
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const checks = {
      string: (x) => typeof x === 'string',
      number: (x) => typeof x === 'number' && Number.isFinite(x),
      integer: (x) => Number.isInteger(x),
      boolean: (x) => typeof x === 'boolean',
      object: (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x),
      array: Array.isArray,
    };
    for (const [k, v] of Object.entries(args ?? {})) {
      const type = props[k]?.type;
      if (type && checks[type] && !checks[type](v)) throw bad(`参数 ${k} 应该是 ${type}`);
    }
  }

  /**
   * 现读注册表，把工具投影成方法。**不缓存**：插件卸载后同名调用立刻 404，
   * 能力表也立刻不再列出它。
   */
  function dynamicMethods() {
    const out = new Map();
    const tools = R.registry?.listTools?.({ includeHidden: false }) ?? [];
    for (const t of tools) {
      const name = str(t?.name).trim();
      if (!name) continue;
      /** 有身份要求的工具要 manage；普通工具用 message（默认宿主令牌就有） */
      const scope = (t.ownerOnly || t.admin) ? 'manage' : 'message';
      out.set(TOOL_PREFIX + name, {
        name: TOOL_PREFIX + name,
        scope,
        desc: `[插件工具·${str(t.pluginName || t.pluginId)}] ${str(t.description || name).slice(0, 200)}`,
        parameters: t.parameters ?? null,
        dynamic: true,
        run: async (p) => {
          const args = p?.args && typeof p.args === 'object' && !Array.isArray(p.args) ? p.args : p;
          validateToolArgs(t.parameters, args);
          const result = await callPluginTool(name, args, p?.msg ?? {});
          return { tool: name, pluginId: str(t.pluginId), result: result ?? null };
        },
      });
    }
    return out;
  }

  /** 能力签名：插件启停导致工具集变化时，用它触发 `capabilities.changed` 事件 */
  function toolSignature() {
    return [...dynamicMethods().values()].map((m) => `${m.name}:${m.scope}`).sort().join('|');
  }

  /* ---------------- 分发 ---------------- */

  function names() {
    return [...table.keys(), ...dynamicMethods().keys()];
  }

  function describe() {
    return [...table.values(), ...dynamicMethods().values()]
      .map(({ name, scope, desc, parameters }) => ({
        name, scope, desc,
        ...(parameters ? { parameters } : {}),
      }));
  }

  return {
    names,
    describe,
    toolSignature,
    /**
     * @param {string} name
     * @param {object} params
     * @param {{scopes?:Set<string>, client?:string}} ctx
     */
    async call(name, params = {}, ctx = {}) {
      const key = str(name).trim();
      const m = table.get(key)
        ?? (key.startsWith(TOOL_PREFIX) ? dynamicMethods().get(key) : null);
      if (!m) throw notFound(`没有这个方法：${key || '(空)'}`);
      if (ctx.scopes && !ctx.scopes.has(m.scope)) {
        throw new HostError('NO_SCOPE', `方法 ${key} 需要 ${m.scope} 权限，当前 token 没有`, 403);
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw bad('params 必须是对象');
      }
      try {
        return await m.run(params, ctx);
      } catch (e) {
        if (e instanceof HostError) throw e;
        throw new HostError('INTERNAL', str(e?.message ?? e), 500);
      }
    },
  };
}
