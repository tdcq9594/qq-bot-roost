import fs from 'node:fs/promises';
import { createLogger } from './logger.js';
/** 路径里的 id 一律编码：openid / 群号是外部数据，含 / 会拼出别的路径 */
const enc = (v) => encodeURIComponent(String(v ?? ''));


const log = createLogger('api');

/** 富媒体类型，对应官方 file_type */
export const FILE_TYPE = { IMAGE: 1, VIDEO: 2, VOICE: 3, FILE: 4 };

/**
 * 富媒体软限制（字节）。官方口径：图片 20MB / 视频 30MB / 语音 20MB / 文件 200MB；
 * 超软限会被服务端拒（普通 base64 上传接口直接 413）。
 *
 * `message.js` 的 `replyMedia` 用它做「图片超 20MB 自动降级为文件」；
 * `uploadLocalFile` 拿它当最后一道兜底（防直接调它传超大文件）。
 */
export const MEDIA_SOFT_LIMIT = {
  [FILE_TYPE.IMAGE]: 20 * 1024 * 1024,
  [FILE_TYPE.VIDEO]: 30 * 1024 * 1024,
  [FILE_TYPE.VOICE]: 20 * 1024 * 1024,
  [FILE_TYPE.FILE]: 200 * 1024 * 1024,
};

/**
 * 被动回复序号的**最后一道**兜底上限。
 *
 * 官方口径按会话类型不同：群聊 5 次（`msg_seq` 1–5），单聊 4 次（1–4）。
 * 这里只按 `msgId` 记，拿不到会话类型，所以取两者较大的 5 当「绝不可能超过」的硬顶。
 * 精确拦截在 `outbound.js`（`PASSIVE_MAX_REPLIES[kind]`），正常流程走不到这里。
 */
const PASSIVE_MAX_SEQ = 5;

/**
 * 构造发送报文。抽成纯函数是为了能单测——`#payload` 是私有方法，测试摸不到。
 *
 * @param {object} opts 驼峰字段：content / msgType / msgId / msgSeq / eventId /
 *                      markdown / keyboard / media / ark / messageReference
 * @param {(msgId:string)=>number} nextSeq 取下一个 msg_seq
 * @returns {object} 官方要的 snake_case 报文
 */
export function buildSendPayload(opts = {}, nextSeq = () => 1) {
  const {
    content,
    msgType = 0,
    msgId,
    msgSeq,
    eventId,
    markdown,
    keyboard,
    media,
    ark,
    messageReference,
  } = opts;

  const payload = { msg_type: msgType, content: content ?? '' };
  if (msgId) {
    payload.msg_id = msgId;
    payload.msg_seq = msgSeq ?? nextSeq(msgId);
  }
  /**
   * 被动回复的另一种方式：拿事件 ID 回。
   * 官方只允许这三种事件用 event_id 回复：
   * INTERACTION_CREATE / GROUP_ADD_ROBOT / GROUP_MSG_RECEIVE。
   * 与 msg_id 二选一。
   */
  if (eventId) payload.event_id = eventId;
  if (markdown) {
    // 官方：填了 markdown 后 content 必须为空，否则 40034008 / 304061
    payload.content = '';
    payload.markdown = markdown;
    payload.msg_type = 2;
  }
  if (keyboard) payload.keyboard = keyboard;
  if (media) payload.media = media;
  if (ark) {
    payload.ark = ark;
    payload.msg_type = 3;
  }
  /**
   * 引用回复。官方是独立字段，不是 msg_id 那套被动回复：
   *   message_id 取 `REFIDX_xxx`——别人发的消息从事件的
   *   `message_scene.ext` 里 `msg_idx` 取；机器人自己发的从发消息响应的
   *   `ext_info.ref_idx` 取。
   */
  if (messageReference) payload.message_reference = messageReference;
  return payload;
}

/**
 * 素材 file_info 的缓存时长。
 * 官方说有效期 3 天，这里按 2 天算——过期前就换新的，
 * 免得刚好卡在边界上收到「file_info 已失效」。
 */
const MEDIA_TTL = 2 * 86400_000;

/**
 * QQ 开放平台 HTTP API 封装。
 * 鉴权头固定为 "QQBot {access_token}"。
 */
export class QQApi {
  constructor({ tokenManager, baseUrl, metrics = null }) {
    this.tokens = tokenManager;
    this.baseUrl = baseUrl;
    // 每个机器人一份指标；mock 等场景可能没有，用可选链兜底
    this.metrics = metrics;
    // msg_id -> 已用的 msg_seq。被动回复同一消息时必须递增，否则会失败
    this.seqMap = new Map();
    // 群管内邀开关，由 BotRuntime 按配置同步；默认关
    this.groupInvited = false;
    // 群角色查询缓存：groupOpenid -> { at, value }。bot_state 只有 30 QPM
    this.roleCache = new Map();
    /**
     * 素材上传缓存：key -> { value, at }。
     *
     * 官方返回的 file_info 有效期 3 天，同一个 url 反复发（比如每日一图）
     * 没必要每次重新上传——富媒体上传有独立频控，大文件还很慢。
     * 键里带 scene + target：file_info 是跟着上传时那个会话走的，
     * 换个群必须重新传，不能跨目标复用。
     */
    this.mediaCache = new Map();
  }

  async #request(method, path, body, { retried = false, headers } = {}) {
    const token = await this.tokens.get();
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        // 没有超时的话，网络卡住会让请求一直挂着，命令永远不返回
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `QQBot ${token}`,
          'Content-Type': 'application/json',
          'X-Union-Appid': this.tokens.appId,
          ...(headers ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      this.metrics?.bump('errors');
      const reason = e?.name === 'TimeoutError' ? '请求超时（15s）' : e.message;
      throw new Error(`网络错误 ${method} ${path}: ${reason}`);
    }

    if (res.status === 401 && !retried) {
      /**
       * 只对 GET 自动重试。
       * POST 发消息重试一次就是群里两条一样的消息，宁可直接报错让上层决定。
       */
      const stale = this.tokens.token;
      log.warn('接口返回 401，刷新访问凭证');
      await this.tokens.refresh(stale);
      if (method === 'GET') return this.#request(method, path, body, { retried: true, headers });
      throw new Error(`HTTP 401 ${method} ${path}: 凭证已刷新，但写请求不自动重试（避免重复发送）`);
    }

    if (res.status === 429) {
      this.metrics?.bump('errors');
      const wait = Number(res.headers.get('retry-after')) || 0;
      const err = new Error(
        `被平台限流（429）${wait ? `，官方建议 ${wait} 秒后再试` : ''}。主动消息有每日额度，被动回复不受限`,
      );
      err.status = 429;
      err.retryAfter = wait;
      throw err;
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      this.metrics?.bump('errors');
      const msg = data?.message || data?.msg || text.slice(0, 300);
      const err = new Error(`HTTP ${res.status} ${method} ${path}: ${msg}`);
      err.status = res.status;
      err.body = data;
      /**
       * QQ 的业务错误码，和 HTTP 状态码是两回事。
       *
       * 同样是 400，`40054004`（无好友关系）和 `40034006`（内容违规）
       * 该做的事完全不同：前者要更新可达性状态，后者只能改文案。
       * 上层拿不到这个码就只能瞎猜，所以在这里就拆出来。
       *
       * 常见值见 `docs/官方接口限制.md` 与 `src/reach.js`。
       */
      err.qqCode = Number(data?.code ?? data?.err_code ?? 0) || 0;
      throw err;
    }
    return data;
  }

  /* ---------------- 基础信息 ---------------- */

  getGateway() {
    return this.#request('GET', '/gateway/bot');
  }

  /** 当前机器人信息 */
  getMe() {
    return this.#request('GET', '/users/@me');
  }

  /* ---------------- 消息发送 ---------------- */

  /**
   * 发送群消息
   * @param {string} groupOpenid
   * @param {object} opts content / msgType / msgId / eventId / markdown / keyboard / media / ark / messageReference
   */
  async sendGroup(groupOpenid, opts = {}) {
    const r = await this.#request('POST', `/v2/groups/${enc(groupOpenid)}/messages`, this.#payload(opts));
    this.metrics?.bump('sent');
    return r;
  }

  async sendC2C(openid, opts = {}) {
    const r = await this.#request('POST', `/v2/users/${enc(openid)}/messages`, this.#payload(opts));
    this.metrics?.bump('sent');
    return r;
  }

  /* ---------------- 富媒体 ---------------- */

  /**
   * 上传富媒体。
   * @param {'group'|'c2c'} scene
   * @param {string} target group_openid 或 user openid
   * @param {object} opts { fileType, url?, fileData?(base64) }
   * @returns {Promise<{file_uuid:string, file_info:string, ttl:number}>}
   */
  async uploadMedia(scene, target, { fileType = FILE_TYPE.IMAGE, url, fileData, reuse = true } = {}) {
    // 只有按 url 传的才缓存：base64 数据做键得先算哈希，不值当
    const cacheKey = reuse && url ? `${scene}:${enc(target)}:${fileType}:${url}` : null;
    if (cacheKey) {
      const hit = this.mediaCache.get(cacheKey);
      if (hit && Date.now() - hit.at < MEDIA_TTL) {
        log.debug(`素材命中缓存，跳过上传: ${url}`);
        return hit.value;
      }
      if (hit) this.mediaCache.delete(cacheKey);
    }

    const path =
      scene === 'group' ? `/v2/groups/${enc(target)}/files` : `/v2/users/${enc(target)}/files`;
    const body = { file_type: fileType, srv_send_msg: false };
    if (url) body.url = url;
    if (fileData) body.file_data = fileData;
    const r = await this.#request('POST', path, body);

    if (cacheKey && r?.file_info) {
      this.mediaCache.set(cacheKey, { value: r, at: Date.now() });
      // 缓存不能无限长：留最近 200 个，超了丢最早的那个
      if (this.mediaCache.size > 200) {
        const oldest = this.mediaCache.keys().next().value;
        if (oldest) this.mediaCache.delete(oldest);
      }
    }
    return r;
  }

  /**
   * 从本地文件读取并上传（自动转 base64）。
   *
   * 带缓存：同一个文件（路径 + 大小 + 修改时间都一样）在 TTL 内不重复上传。
   * 图片缓存类插件（本地存几百张图，用户点一次发一张）没有这层的话，
   * 每发一次都要把整张图 base64 传一遍，慢且费额度。
   */
  async uploadLocalFile(scene, target, filePath, fileType = FILE_TYPE.IMAGE) {
    let cacheKey = null;
    try {
      const st = await fs.stat(filePath);
      /**
       * 软限制前置校验：普通 base64 上传接口对富媒体有大小上限，
       * 超了服务端直接 413。在这里先挡一道，报一个能看懂的错误，
       * 别让调用方拿到「HTTP 413 ... <html>」这种垃圾信息。
       */
      const limit = MEDIA_SOFT_LIMIT[fileType];
      if (limit && st.size > limit) {
        const mb = (st.size / 1024 / 1024).toFixed(1);
        const cap = Math.round(limit / 1024 / 1024);
        throw new Error(`${filePath} 有 ${mb}MB，超过 ${cap}MB 上限，发不出去（先压缩或换张小图）`);
      }
      cacheKey = `${scene}:${enc(target)}:${fileType}:file:${filePath}:${st.size}:${Math.floor(st.mtimeMs)}`;
      const hit = this.mediaCache.get(cacheKey);
      if (hit && Date.now() - hit.at < MEDIA_TTL) return hit.value;
      if (hit) this.mediaCache.delete(cacheKey);
    } catch (e) {
      /**
       * stat 失败或超限都落到这里。stat 失败（文件不存在 / 没权限）时
       * 不能当缓存命中，继续往下走让 `readFile` 抛真正的错误；
       * 超限是**明确拒绝**，必须直接把错误往上抛，不能悄悄读文件再传一遍。
       */
      if (/上限/.test(e?.message ?? '')) throw e;
      /* stat 失败就按无缓存走，readFile 会抛真正的错误 */
    }

    const buf = await fs.readFile(filePath);
    const up = await this.uploadMedia(scene, target, {
      fileType,
      fileData: buf.toString('base64'),
      reuse: false,
    });
    if (cacheKey && up?.file_info) {
      this.mediaCache.set(cacheKey, { value: up, at: Date.now() });
      if (this.mediaCache.size > 200) {
        const oldest = this.mediaCache.keys().next().value;
        if (oldest) this.mediaCache.delete(oldest);
      }
    }
    return up;
  }

  /** 上传后再以 msg_type=7 发出（被动回复） */
  async sendMedia(scene, target, { fileType, url, fileData, msgId, messageReference }) {
    const up = await this.uploadMedia(scene, target, { fileType, url, fileData });
    if (!up?.file_info) throw new Error('上传成功但未返回 file_info');
    const opts = {
      msgType: 7,
      content: ' ',
      media: { file_info: up.file_info },
      msgId,
      messageReference,
    };
    return scene === 'group' ? this.sendGroup(target, opts) : this.sendC2C(target, opts);
  }

  /* ---------------- 撤回 ---------------- */

  /**
   * 撤回群消息。
   * DELETE /v2/groups/{group_openid}/messages/{message_id}
   *
   * 官方约束（这里不做预检，失败了由调用方看错误码）：
   *   - 发送超过 2 分钟的消息不可撤回（40064004）
   *   - 机器人是群管理员时可撤自己的和普通成员的；是普通成员时只能撤自己的（40062003）
   *   - 群成员的消息 ID 取群消息事件的 d.id；自己发的取发送接口响应
   */
  retractGroupMessage(groupOpenid, messageId) {
    return this.#request('DELETE', `/v2/groups/${enc(groupOpenid)}/messages/${enc(messageId)}`);
  }

  /**
   * 撤回私聊消息。
   * DELETE /v2/users/{openid}/messages/{message_id}
   */
  retractC2CMessage(openid, messageId) {
    return this.#request('DELETE', `/v2/users/${enc(openid)}/messages/${enc(messageId)}`);
  }

  /* ---------------- 互动 ---------------- */

  /**
   * 互动回执。收到 INTERACTION_CREATE 后**必须**调用，
   * 否则客户端上的按钮会一直转圈。
   *
   * PUT /interactions/{interaction_id}，需要带 X-Callback-AppID 头
   * @param {string} interactionId
   * @param {number} code 0 = 成功
   */
  putInteraction(interactionId, code = 0) {
    return this.#request('PUT', `/interactions/${interactionId}`, { code }, {
      headers: { 'X-Callback-AppID': this.tokens.appId },
    });
  }

  /* ---------------- 群管理 ---------------- */

  /**
   * 内邀开关。群成员列表 / 踢人 / 群黑名单这几个接口官方只对白名单机器人开放，
   * 没申请就调会返回 11253。默认关着，申请到了在面板打开。
   * 由 BotRuntime 在配置变化时调用，插件不用管。
   */
  setGroupInvited(v) {
    this.groupInvited = Boolean(v);
    // 角色缓存可能存着「查不到」的结果，开关切换后要重新试
    this.roleCache.clear();
    return this.groupInvited;
  }

  /** 内邀接口的统一闸门。没开门就抛错，别把请求发出去刷一屏 11253 */
  #needInvite() {
    if (!this.groupInvited) {
      throw new Error(
        '群管内邀功能未开启。群成员列表 / 踢人 / 群黑名单需要官方白名单，' +
          '申请通过后到面板「配置 → 群管能力」打开',
      );
    }
  }

  /**
   * 群管操作前的身份预检。
   *
   * 禁言、踢人、入群审批都要求机器人是群管理员，服务端不满足就返回 40062003。
   * 这里先查一次 bot_state（带 60 秒缓存），确认不是管理员就直接抛友好错误，
   * 省得插件每次自己 try/catch 猜原因。
   *
   * 查不到角色时（内邀没开、网络失败）**不拦截**——照样发请求让服务端判。
   * 想跳过预检传 `{ precheck: false }`。
   */
  async #precheckAdmin(groupOpenid, opts) {
    if (opts?.precheck === false) return;
    const st = await this.canManageGroup(groupOpenid);
    // 只有「确认不是管理员」才拦；查不到就放行
    if (st.role && !st.ok) {
      throw new Error(`机器人在这个群没有管理权限：${st.reason}`);
    }
  }

  /**
   * 设置群成员禁言（公开接口，无需内邀）。
   * POST /v2/groups/{group_openid}/restrict_chat_setting
   *
   * 官方约束：
   *   - 机器人必须是群管理员，否则 40062003（默认会先用 canManageGroup 预检）
   *   - 最长 30 天；到期时间 RFC3339，如 2026-08-05T11:23:05+08:00
   *   - 单次最多 20 个成员
   *   - 只能操作普通成员，群主 / 管理员 / 机器人都不能动
   *
   * @param {string} groupOpenid
   * @param {Array<{op:'add'|'update'|'del', member_openid:string, mute_expire_at?:string}>} members
   * @param {{precheck?:boolean}} [opts]
   */
  async muteMembers(groupOpenid, members, opts) {
    await this.#precheckAdmin(groupOpenid, opts);
    return this.#request('POST', `/v2/groups/${enc(groupOpenid)}/restrict_chat_setting`, { members });
  }

  /**
   * 禁言单个成员到某个时间。muteExpireAt 传 null / 空串表示立即解除。
   * 内部仍走 muteMembers，只是把 op 和到期时间填好。
   */
  muteMember(groupOpenid, memberOpenid, muteExpireAt, opts) {
    return this.muteMembers(
      groupOpenid,
      [
        {
          op: muteExpireAt ? 'add' : 'del',
          member_openid: memberOpenid,
          mute_expire_at: muteExpireAt ?? '',
        },
      ],
      opts,
    );
  }

  /**
   * 查询群禁言状态（公开接口）。
   * GET /v2/groups/{group_openid}/restrict_chat_setting
   */
  getMuteStatus(groupOpenid) {
    return this.#request('GET', `/v2/groups/${enc(groupOpenid)}/restrict_chat_setting`);
  }

  /**
   * 获取群基本信息（公开接口）。
   * GET /v2/groups/{group_openid}/info
   */
  getGroupInfo(groupOpenid) {
    return this.#request('GET', `/v2/groups/${enc(groupOpenid)}/info`);
  }

  /**
   * 获取机器人在群内的状态（**内邀**接口）。
   * GET /v2/groups/{group_openid}/bot_state
   *
   * 返回里最有用的是 `member_role`：`member` 普通成员 / `owner` 群主 / `admin` 管理员。
   * 禁言、踢人、入群审批都要求机器人是 admin 或 owner，所以调用群管接口前
   * 可以用它预检，省得撞 `40062003`。
   *
   * 注意：这个接口官方标注「仅白名单机器人可用」（11253），
   * 没申请内邀的机器人调不了，只能靠错误码反推。
   */
  getBotGroupState(groupOpenid) {
    this.#needInvite();
    return this.#request('GET', `/v2/groups/${enc(groupOpenid)}/bot_state`);
  }

  /**
   * 机器人在这个群里是不是管理员（群主或群管理员）。
   *
   * 内部走 `getBotGroupState`，带 60 秒缓存——那个接口只有 30 QPM，
   * 每次群管操作都查一遍会烧额度。
   *
   * @returns {Promise<{ok:boolean, role:string|null, reason:string}>}
   *   ok=true 表示可以群管；role 是 member/owner/admin；
   *   查不到（内邀没开、网络失败）时 role=null，reason 说明为什么
   */
  async canManageGroup(groupOpenid, { maxAgeMs = 60000 } = {}) {
    const key = String(groupOpenid || '');
    if (!key) return { ok: false, role: null, reason: '缺少群 openid' };

    const hit = this.roleCache.get(key);
    if (hit && Date.now() - hit.at < maxAgeMs) return hit.value;

    let value;
    try {
      const st = await this.getBotGroupState(key);
      const role = String(st?.member_role ?? '');
      if (role === 'owner' || role === 'admin') {
        value = { ok: true, role, reason: role === 'owner' ? '机器人是群主' : '机器人是群管理员' };
      } else if (role === 'member') {
        value = { ok: false, role, reason: '机器人只是普通成员，没有群管权限' };
      } else {
        value = { ok: false, role: null, reason: `无法识别机器人角色（返回 ${role || '空'}）` };
      }
    } catch (e) {
      // 最常见的是内邀没开（11253）——这时候没法预检，让调用方自己决定
      value = { ok: false, role: null, reason: `查不到机器人角色：${e.message}` };
    }

    // 失败结果也缓存，避免每次调用都去撞一次 11253
    this.roleCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** 清掉角色缓存（内邀开关切换后调用，避免还用着旧的失败结果） */
  clearRoleCache() {
    this.roleCache.clear();
  }

  /**
   * 获取群成员列表（内邀）。
   * GET /v2/groups/{group_openid}/members
   * 每次最多 30 条，用 next_index 翻页。
   */
  getGroupMembers(groupOpenid, { limit, startIndex } = {}) {
    this.#needInvite();
    const q = new URLSearchParams();
    if (limit) q.set('limit', String(limit));
    if (startIndex) q.set('start_index', String(startIndex));
    const suffix = q.toString() ? `?${q}` : '';
    return this.#request('GET', `/v2/groups/${enc(groupOpenid)}/members${suffix}`);
  }

  /**
   * 获取单个群成员信息（内邀）。
   * GET /v2/groups/{group_openid}/members/{member_openid}
   */
  getGroupMember(groupOpenid, memberOpenid) {
    this.#needInvite();
    return this.#request('GET', `/v2/groups/${enc(groupOpenid)}/members/${enc(memberOpenid)}`);
  }

  /**
   * 批量移除群成员，即踢人（内邀）。
   * POST /v2/groups/{group_openid}/batch_remove_members
   * 单次最多 20 个；isRobotBlacklist=true 会同时拉黑。
   */
  async removeMembers(groupOpenid, memberOpenids, { addToBlacklist = false, precheck } = {}) {
    this.#needInvite();
    await this.#precheckAdmin(groupOpenid, { precheck });
    return this.#request('POST', `/v2/groups/${enc(groupOpenid)}/batch_remove_members`, {
      member_openids: memberOpenids,
      is_robot_blacklist: Boolean(addToBlacklist),
    });
  }

  /**
   * 查询群黑名单（内邀）。
   * GET /v2/groups/{group_openid}/member_blacklist
   */
  getGroupBlacklist(groupOpenid) {
    this.#needInvite();
    return this.#request('GET', `/v2/groups/${enc(groupOpenid)}/member_blacklist`);
  }

  /**
   * 操作群黑名单（内邀）。
   * POST /v2/groups/{group_openid}/member_blacklist
   * op: add 加入 / del 移除。目标用户不在群里才能加入。
   */
  operateGroupBlacklist(groupOpenid, { op, memberOpenids }) {
    this.#needInvite();
    return this.#request('POST', `/v2/groups/${enc(groupOpenid)}/member_blacklist`, {
      op,
      member_openids: memberOpenids,
    });
  }

  /* ---------------- 入群申请与自动审批 ---------------- */

  /**
   * 拉取入群申请列表（公开接口）。
   * GET /v2/groups/{group_openid}/join_request_list
   * 机器人需拥有群管理员身份。30 QPM。
   * @param {string} groupOpenid
   * @param {{cursor?:string, limit?:number}} [p] limit 默认 20，最大 50
   */
  getJoinRequests(groupOpenid, { cursor, limit } = {}) {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    if (limit) q.set('limit', String(limit));
    const suffix = q.toString() ? `?${q}` : '';
    return this.#request('GET', `/v2/groups/${enc(groupOpenid)}/join_request_list${suffix}`);
  }

  /**
   * 审批入群申请（公开接口）。
   * POST /v2/groups/{group_openid}/approval_join_request/{member_openid}
   * 机器人需拥有群管理员身份。60 QPM。
   *
   * @param {string} groupOpenid
   * @param {string} memberOpenid 申请人
   * @param {{op:'approve'|'decline', joinRequestId?:string, rejectReason?:string, addToBlacklist?:boolean}} body
   */
  async handleJoinRequest(groupOpenid, memberOpenid, body = {}) {
    await this.#precheckAdmin(groupOpenid, body);
    const payload = { op: body.op };
    if (body.joinRequestId) payload.join_request_id = body.joinRequestId;
    if (body.rejectReason) payload.reject_reason = body.rejectReason;
    if (body.addToBlacklist) payload.add_to_member_blacklist = true;
    return this.#request(
      'POST',
      `/v2/groups/${enc(groupOpenid)}/approval_join_request/${enc(memberOpenid)}`,
      payload,
    );
  }

  /** 通过入群申请 */
  approveJoinRequest(groupOpenid, memberOpenid, joinRequestId, opts) {
    return this.handleJoinRequest(groupOpenid, memberOpenid, { op: 'approve', joinRequestId, ...opts });
  }

  /** 拒绝入群申请，可同时拉黑 */
  declineJoinRequest(groupOpenid, memberOpenid, { joinRequestId, rejectReason, addToBlacklist, ...opts } = {}) {
    return this.handleJoinRequest(groupOpenid, memberOpenid, {
      op: 'decline',
      joinRequestId,
      rejectReason,
      addToBlacklist,
      ...opts,
    });
  }

  /**
   * 查询入群自动审批策略列表（公开接口），按创建时间倒序。
   * GET /v2/groups/join_approval_strategy
   */
  listJoinStrategies({ cursor, limit } = {}) {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    if (limit) q.set('limit', String(limit));
    const suffix = q.toString() ? `?${q}` : '';
    return this.#request('GET', `/v2/groups/join_approval_strategy${suffix}`);
  }

  /**
   * 创建入群自动审批策略（公开接口）。
   * POST /v2/groups/join_approval_strategy
   * group_openids 与 group_ids 二选一，最多 100 个；一个机器人最多 20 个策略。
   * 注意：策略要**机器人是该群管理员**才会实际生效。
   *
   * @param {{groupOpenids?:string[], groupIds?:string[], isEnable?:string, expireAt?:string, remark?:string}} p
   *   isEnable: 'on' | 'off'，默认 on；expireAt: RFC3339，不传默认一年
   */
  createJoinStrategy({ groupOpenids, groupIds, isEnable, expireAt, remark } = {}) {
    const payload = {};
    if (groupOpenids) payload.group_openids = groupOpenids;
    if (groupIds) payload.group_ids = groupIds.map(String);
    if (isEnable) payload.is_enable = isEnable;
    if (expireAt) payload.expire_at = expireAt;
    if (remark) payload.remark = remark;
    return this.#request('POST', `/v2/groups/join_approval_strategy`, payload);
  }

  /**
   * 修改入群自动审批策略（公开接口）。
   * PATCH /v2/groups/join_approval_strategy/{strategy_id}
   *
   * @param {string} strategyId
   * @param {{isEnable?:string, expireAt?:string, remark?:string,
   *          groupAction?:{op:'add'|'del', groupOpenids?:string[], groupIds?:string[]}}} p
   */
  updateJoinStrategy(strategyId, { isEnable, expireAt, remark, groupAction } = {}) {
    const payload = {};
    if (isEnable) payload.is_enable = isEnable;
    if (expireAt) payload.expire_at = expireAt;
    if (remark) payload.remark = remark;
    if (groupAction) {
      payload.group_action = { op: groupAction.op };
      if (groupAction.groupOpenids) payload.group_action.group_openids = groupAction.groupOpenids;
      if (groupAction.groupIds) payload.group_action.group_ids = groupAction.groupIds.map(String);
    }
    return this.#request('PATCH', `/v2/groups/join_approval_strategy/${strategyId}`, payload);
  }

  /** 删除入群自动审批策略 */
  deleteJoinStrategy(strategyId) {
    return this.#request('DELETE', `/v2/groups/join_approval_strategy/${strategyId}`);
  }

  /**
   * 执行策略：对关联的全部群做全量扫描，命中白名单的申请自动通过。
   * **异步执行，约 10 分钟完成**，别当成同步接口等结果。
   */
  executeJoinStrategy(strategyId) {
    return this.#request('POST', `/v2/groups/join_approval_strategy/${strategyId}/execute`, {});
  }

  /**
   * 修改策略的白名单 QQ 号码（公开接口）。
   * POST /v2/groups/join_approval_strategy/{strategy_id}/whitelist_users
   * 单次最多 10000 个，总上限 10 万。
   * 注意这里用的是 **QQ 号码**，不是 openid；用字符串传，避免 JS 数字精度问题。
   *
   * @param {string} strategyId
   * @param {{op:'add'|'del', whitelistUsers:string[]}} p
   */
  updateStrategyWhitelist(strategyId, { op, whitelistUsers }) {
    return this.#request(
      'POST',
      `/v2/groups/join_approval_strategy/${strategyId}/whitelist_users`,
      { op, whitelist_users: whitelistUsers.map(String) },
    );
  }

  /* ---------------- 流式消息与全局菜单 ---------------- */

  /**
   * 流式发送单聊消息（官方接口）。
   * POST /v2/users/{user_openid}/stream_messages
   * 50 QPS。**只支持单聊**，群聊没有这个接口。
   *
   * 用法：第一条发 `input_state:1, index:0`，**服务端会返回 `stream_msg_id`**；
   * 后续每一片都要带上它，`index` 递增；最后一片发 `input_state:10`。
   * `input_mode` 选 append（增量追加）或 replace（全量替换，须以已下发前缀开头）。
   *
   * @param {string} openid
   * @param {object} p
   * @param {string} p.contentRaw 本片内容
   * @param {number} [p.index]    分片序号，从 0 递增
   * @param {number} [p.state]    1=生成中（默认），10=结束
   * @param {'append'|'replace'} [p.mode]  默认 append
   * @param {'text'|'markdown'} [p.contentType] 默认 markdown
   * @param {string} [p.streamMsgId] 第一条留空，后续传上一片返回的 id
   * @param {string} [p.msgId]   被动回复用，二选一
   * @param {string} [p.eventId] 被动回复用，二选一
   * @param {boolean} [p.isWakeup] true 时不校验 msg_id/event_id 有效期
   * @returns {Promise<{id?:string}>} 含服务端生成的 stream_msg_id
   */
  sendStreamMessage(openid, p = {}) {
    const payload = {
      input_mode: p.mode ?? 'append',
      input_state: p.state ?? 1,
      index: p.index ?? 0,
      content_type: p.contentType ?? 'markdown',
      content_raw: String(p.contentRaw ?? ''),
    };
    if (p.streamMsgId) payload.stream_msg_id = p.streamMsgId;
    if (p.msgId) payload.msg_id = p.msgId;
    if (p.eventId) payload.event_id = p.eventId;
    if (p.isWakeup) payload.is_wakeup = true;
    return this.#request('POST', `/v2/users/${enc(openid)}/stream_messages`, payload);
  }

  /**
   * 查询全局自定义菜单（官方接口）。
   * GET /v2/menu，30 QPM。**只对 C2C 私聊场景生效**，且对所有用户一视同仁。
   */
  getGlobalMenu() {
    return this.#request('GET', '/v2/menu');
  }

  /**
   * 修改全局自定义菜单（官方接口）。
   * PUT /v2/menu，5 QPM。**覆盖式**——传上去的就是完整菜单，不传等于清空。
   *
   * @param {Array<object>} items 最多 10 个菜单项
   *   { name, type: 'switch'|'send_message'|'link'|'menu', ... }
   *   send_message 带 send_message 文本；link 带 https 链接（必须 https）；
   *   switch 带 switch 配置；menu 带 sub_menu_items（最多 5 个，不能再嵌套）
   */
  setGlobalMenu(items) {
    if (!Array.isArray(items)) throw new Error('菜单项必须是数组');
    if (items.length > 10) throw new Error('菜单项最多 10 个');
    return this.#request('PUT', '/v2/menu', { menu: { items } });
  }

  /* ---------------- 指令面板（2026-08 新增，6 个接口） ---------------- */

  /**
   * 查询指令面板列表。
   * GET /v2/panels，30 QPM。`scope` 必填。
   *
   * @param {object} p
   * @param {'c2c'|'group'|'channel'|'dm'} p.scope 生效场景
   * @param {string} [p.cursor] 首页不传，后续传上次的 next_cursor
   * @param {number} [p.limit]  默认 20，最大 50
   */
  listPanels({ scope, cursor, limit } = {}) {
    if (!scope) throw new Error('listPanels 需要 scope（c2c/group/channel/dm）');
    const q = new URLSearchParams({ scope: String(scope) });
    if (cursor) q.set('cursor', String(cursor));
    if (limit) q.set('limit', String(limit));
    return this.#request('GET', `/v2/panels?${q.toString()}`);
  }

  /**
   * 创建指令面板。POST /v2/panels，10 QPM，**一个机器人最多 20 个面板**。
   *
   * 面板 = 用户在聊天框旁边看到的「指令/链接」快捷入口，最多 20 个元素。
   * 这是官方给的、OneBot 完全没有的能力。
   *
   * @param {object} p
   * @param {'c2c'|'group'|'channel'|'dm'} p.scope
   * @param {'all'|'specific'} [p.targetType] channel/dm 只能 all
   * @param {string[]} [p.userOpenids]  c2c + specific 时有效，最多 20 个
   * @param {string[]} [p.groupOpenids] group + specific 时有效，最多 20 个
   * @param {object} p.panel { items:[{name,desc,type,only_admin,link}], remark, version }
   * @returns {Promise<{panel_id:string}>}
   */
  createPanel({ scope, targetType, userOpenids, groupOpenids, panel } = {}) {
    if (!scope) throw new Error('createPanel 需要 scope');
    if (!panel) throw new Error('createPanel 需要 panel');
    if (Array.isArray(panel.items) && panel.items.length > 20) {
      throw new Error('一个指令面板最多 20 个元素');
    }
    const body = { scope, panel };
    if (targetType) body.target_type = targetType;
    if (userOpenids?.length) body.user_openids = userOpenids;
    if (groupOpenids?.length) body.group_openids = groupOpenids;
    return this.#request('POST', '/v2/panels', body);
  }

  /** 查询指令面板详情。GET /v2/panels/{panel_id} */
  getPanel(panelId) {
    return this.#request('GET', `/v2/panels/${enc(panelId)}`);
  }

  /**
   * 修改指令面板。PUT /v2/panels/{panel_id}，覆盖式。
   * @param {string} panelId
   * @param {object} panel 同 createPanel 的 panel
   */
  updatePanel(panelId, panel) {
    if (!panel) throw new Error('updatePanel 需要 panel');
    return this.#request('PUT', `/v2/panels/${enc(panelId)}`, { panel });
  }

  /** 删除指令面板。DELETE /v2/panels/{panel_id} */
  deletePanel(panelId) {
    return this.#request('DELETE', `/v2/panels/${enc(panelId)}`);
  }

  /**
   * 修改面板关联对象（增删生效的用户/群）。
   * PUT /v2/panels/{panel_id}/target，60 QPM。
   * 只能对 `target_type=specific` 的面板用，全局面板会返回 40030021。
   *
   * @param {string} panelId
   * @param {'add'|'del'} op
   * @param {{userOpenids?:string[], groupOpenids?:string[]}} targets 各最多 20 个
   */
  updatePanelTarget(panelId, { op, userOpenids, groupOpenids } = {}) {
    if (op !== 'add' && op !== 'del') throw new Error('op 只能是 add 或 del');
    const body = { op };
    if (userOpenids?.length) body.user_openids = userOpenids;
    if (groupOpenids?.length) body.group_openids = groupOpenids;
    return this.#request('PUT', `/v2/panels/${enc(panelId)}/target`, body);
  }

  /* ---------------- 分片上传（大文件，4 个接口收敛成 2 个方法） ---------------- */

  /**
   * 富媒体预上传，拿 upload_id 和各分片的预签名 URL。
   * `POST /v2/{groups,users}/{id}/upload_prepare`，10 QPS。
   *
   * 软限制：图片 20MB / 视频 30MB / 语音 20MB / 文件 200MB；超软限降级为文件，超 200MB 直接报错。
   *
   * @param {'group'|'c2c'} scene
   * @param {string} target 群 openid 或用户 openid
   * @param {object} p
   * @param {number} p.fileType 1图 2视频 3语音 4文件
   * @param {number|string} p.fileSize 字节数
   * @param {string} p.fileName
   * @param {string} p.md5    整个文件
   * @param {string} p.sha1   整个文件
   * @param {string} p.md5_10m 前 10002432 字节（约 10MB）的 MD5
   */
  uploadPrepare(scene, target, { fileType = FILE_TYPE.FILE, fileSize, fileName, md5, sha1, md5_10m } = {}) {
    const base = scene === 'group' ? `/v2/groups/${enc(target)}` : `/v2/users/${enc(target)}`;
    return this.#request('POST', `${base}/upload_prepare`, {
      file_type: fileType,
      file_size: String(fileSize ?? ''),
      file_name: String(fileName ?? ''),
      md5: String(md5 ?? ''),
      sha1: String(sha1 ?? ''),
      md5_10m: String(md5_10m ?? ''),
    });
  }

  /**
   * 通知服务端某个分片已上传完成（每片 PUT 成功后都要调）。
   * `POST /v2/{groups,users}/{id}/upload_part_finish`，10 QPS。
   *
   * 全部分片完成后，拿 `upload_id` 调一次 `uploadMedia` 完成合并。
   *
   * @param {'group'|'c2c'} scene
   * @param {string} target
   * @param {object} p { uploadId, partIndex, blockSize, md5 }
   */
  uploadPartFinish(scene, target, { uploadId, partIndex, blockSize, md5 } = {}) {
    const base = scene === 'group' ? `/v2/groups/${enc(target)}` : `/v2/users/${enc(target)}`;
    return this.#request('POST', `${base}/upload_part_finish`, {
      upload_id: String(uploadId ?? ''),
      part_index: Number(partIndex) || 0,
      block_size: String(blockSize ?? ''),
      md5: String(md5 ?? ''),
    });
  }

  /* ---------------- 生成分享链接 ---------------- */

  /**
   * 生成机器人分享链接，用来邀请用户加机器人。
   * `POST /v2/generate_url_link`，50 QPS。
   *
   * @param {string} [callbackData] 用户通过该链接添加机器人时会透传回来，最长 32 字符
   * @returns {Promise<{data?:{url:string}}>}
   */
  generateUrlLink(callbackData) {
    const body = {};
    if (callbackData !== undefined && callbackData !== null && callbackData !== '') {
      const s = String(callbackData);
      if (s.length > 32) throw new Error('callback_data 最长 32 字符');
      body.callback_data = s;
    }
    return this.#request('POST', '/v2/generate_url_link', body);
  }

  /* ---------------- 频道（guild）管理 ---------------- */

  /**
   * 机器人加入的频道列表。`GET /users/@me/guilds`
   * 这是「机器人所在群列表」在频道侧的对应物（群侧官方确实没有）。
   */
  getMyGuilds() {
    return this.#request('GET', '/users/@me/guilds');
  }

  /** 频道详情。`GET /guilds/{guild_id}` */
  getGuild(guildId) {
    return this.#request('GET', `/guilds/${enc(guildId)}`);
  }

  /** 子频道列表。`GET /guilds/{guild_id}/channels` */
  getGuildChannels(guildId) {
    return this.#request('GET', `/guilds/${enc(guildId)}/channels`);
  }

  /**
   * 创建子频道。`POST /guilds/{guild_id}/channels`，50 QPS，需管理员。
   * body 原样透传，不在这里做字段裁剪——官方字段以后可能加。
   * @param {string} guildId
   * @param {object} body { name, type, sub_type, position, parent_id, private_type, private_user_ids, speak_permission, application_id }
   */
  createGuildChannel(guildId, body = {}) {
    return this.#request('POST', `/guilds/${enc(guildId)}/channels`, body);
  }

  /** 子频道详情。`GET /channels/{channel_id}` */
  getChannel(channelId) {
    return this.#request('GET', `/channels/${enc(channelId)}`);
  }

  /**
   * 修改子频道。`PATCH /channels/{channel_id}`
   * body 原样透传（name / position / parent_id / private_type / private_user_ids / speak_permission）。
   */
  updateChannel(channelId, body = {}) {
    return this.#request('PATCH', `/channels/${enc(channelId)}`, body);
  }

  /** 删除子频道。`DELETE /channels/{channel_id}` */
  deleteChannel(channelId) {
    return this.#request('DELETE', `/channels/${enc(channelId)}`);
  }

  /* ---------------- 内部 ---------------- */

  #payload(opts) {
    return buildSendPayload(opts, (id) => this.#nextSeq(id));
  }

  /**
   * 被动回复序号。硬顶见 `PASSIVE_MAX_SEQ`（群聊 5 / 单聊 4，这里取 5 兜底），
   * 超了服务端返回 40034128。正常流程由 outbound.js 按会话类型先拦。
   */
  #nextSeq(msgId) {
    const cur = this.seqMap.get(msgId) ?? 0;
    if (cur >= PASSIVE_MAX_SEQ) {
      throw new Error(
        `同一条消息最多回复 5 次（群聊）/ 4 次（单聊），这条已经回了 ${cur} 次`,
      );
    }
    const next = cur + 1;
    this.seqMap.set(msgId, next);
    if (this.seqMap.size > 2000) {
      this.seqMap.delete(this.seqMap.keys().next().value);
    }
    return next;
  }
}
