import fs from 'node:fs/promises';
import { createLogger } from './logger.js';
import { runtime } from './runtime.js';

const log = createLogger('api');

/** 富媒体类型，对应官方 file_type */
export const FILE_TYPE = { IMAGE: 1, VIDEO: 2, VOICE: 3, FILE: 4 };

/**
 * QQ 开放平台 HTTP API 封装。
 * 鉴权头固定为 "QQBot {access_token}"。
 */
export class QQApi {
  constructor({ tokenManager, baseUrl }) {
    this.tokens = tokenManager;
    this.baseUrl = baseUrl;
    // msg_id -> 已用的 msg_seq。被动回复同一消息时必须递增，否则会失败
    this.seqMap = new Map();
    // 群管内邀开关，由 BotRuntime 按配置同步；默认关
    this.groupInvited = false;
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
      runtime.bump('errors');
      const reason = e?.name === 'TimeoutError' ? '请求超时（15s）' : e.message;
      throw new Error(`网络错误 ${method} ${path}: ${reason}`);
    }

    if (res.status === 401 && !retried) {
      log.warn('接口返回 401，刷新访问凭证后重试');
      await this.tokens.refresh();
      return this.#request(method, path, body, { retried: true, headers });
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      runtime.bump('errors');
      const msg = data?.message || data?.msg || text.slice(0, 300);
      const err = new Error(`HTTP ${res.status} ${method} ${path}: ${msg}`);
      err.status = res.status;
      err.body = data;
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
   * @param {object} opts content / msgType / msgId / markdown / keyboard / media / ark
   */
  async sendGroup(groupOpenid, opts = {}) {
    const r = await this.#request('POST', `/v2/groups/${groupOpenid}/messages`, this.#payload(opts));
    runtime.bump('sent');
    return r;
  }

  async sendC2C(openid, opts = {}) {
    const r = await this.#request('POST', `/v2/users/${openid}/messages`, this.#payload(opts));
    runtime.bump('sent');
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
  uploadMedia(scene, target, { fileType = FILE_TYPE.IMAGE, url, fileData } = {}) {
    const path =
      scene === 'group' ? `/v2/groups/${target}/files` : `/v2/users/${target}/files`;
    const body = { file_type: fileType, srv_send_msg: false };
    if (url) body.url = url;
    if (fileData) body.file_data = fileData;
    return this.#request('POST', path, body);
  }

  /** 从本地文件读取并上传（自动转 base64） */
  async uploadLocalFile(scene, target, filePath, fileType = FILE_TYPE.IMAGE) {
    const buf = await fs.readFile(filePath);
    return this.uploadMedia(scene, target, { fileType, fileData: buf.toString('base64') });
  }

  /** 上传后再以 msg_type=7 发出（被动回复） */
  async sendMedia(scene, target, { fileType, url, fileData, msgId }) {
    const up = await this.uploadMedia(scene, target, { fileType, url, fileData });
    if (!up?.file_info) throw new Error('上传成功但未返回 file_info');
    const opts = {
      msgType: 7,
      content: ' ',
      media: { file_info: up.file_info },
      msgId,
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
    return this.#request('DELETE', `/v2/groups/${groupOpenid}/messages/${messageId}`);
  }

  /**
   * 撤回私聊消息。
   * DELETE /v2/users/{openid}/messages/{message_id}
   */
  retractC2CMessage(openid, messageId) {
    return this.#request('DELETE', `/v2/users/${openid}/messages/${messageId}`);
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
   * 设置群成员禁言（公开接口，无需内邀）。
   * POST /v2/groups/{group_openid}/restrict_chat_setting
   *
   * 官方约束：
   *   - 机器人必须是群管理员，否则 40062003
   *   - 最长 30 天；到期时间 RFC3339，如 2026-08-05T11:23:05+08:00
   *   - 单次最多 20 个成员
   *   - 只能操作普通成员，群主 / 管理员 / 机器人都不能动
   *
   * @param {string} groupOpenid
   * @param {Array<{op:'add'|'update'|'del', member_openid:string, mute_expire_at?:string}>} members
   */
  muteMembers(groupOpenid, members) {
    return this.#request('POST', `/v2/groups/${groupOpenid}/restrict_chat_setting`, { members });
  }

  /**
   * 禁言单个成员到某个时间。muteExpireAt 传 null / 空串表示立即解除。
   * 内部仍走 muteMembers，只是把 op 和到期时间填好。
   */
  muteMember(groupOpenid, memberOpenid, muteExpireAt) {
    return this.muteMembers(groupOpenid, [
      { op: muteExpireAt ? 'add' : 'del', member_openid: memberOpenid, mute_expire_at: muteExpireAt ?? '' },
    ]);
  }

  /**
   * 查询群禁言状态（公开接口）。
   * GET /v2/groups/{group_openid}/restrict_chat_setting
   */
  getMuteStatus(groupOpenid) {
    return this.#request('GET', `/v2/groups/${groupOpenid}/restrict_chat_setting`);
  }

  /**
   * 获取群基本信息（公开接口）。
   * GET /v2/groups/{group_openid}/info
   */
  getGroupInfo(groupOpenid) {
    return this.#request('GET', `/v2/groups/${groupOpenid}/info`);
  }

  /**
   * 获取机器人在群内的状态（公开接口）。
   * GET /v2/groups/{group_openid}/bot_state
   */
  getBotGroupState(groupOpenid) {
    return this.#request('GET', `/v2/groups/${groupOpenid}/bot_state`);
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
    return this.#request('GET', `/v2/groups/${groupOpenid}/members${suffix}`);
  }

  /**
   * 获取单个群成员信息（内邀）。
   * GET /v2/groups/{group_openid}/members/{member_openid}
   */
  getGroupMember(groupOpenid, memberOpenid) {
    this.#needInvite();
    return this.#request('GET', `/v2/groups/${groupOpenid}/members/${memberOpenid}`);
  }

  /**
   * 批量移除群成员，即踢人（内邀）。
   * POST /v2/groups/{group_openid}/batch_remove_members
   * 单次最多 20 个；isRobotBlacklist=true 会同时拉黑。
   */
  removeMembers(groupOpenid, memberOpenids, { addToBlacklist = false } = {}) {
    this.#needInvite();
    return this.#request(
      'POST',
      `/v2/groups/${groupOpenid}/batch_remove_members`,
      {
        member_openids: memberOpenids,
        is_robot_blacklist: Boolean(addToBlacklist),
      },
    );
  }

  /**
   * 查询群黑名单（内邀）。
   * GET /v2/groups/{group_openid}/member_blacklist
   */
  getGroupBlacklist(groupOpenid) {
    this.#needInvite();
    return this.#request('GET', `/v2/groups/${groupOpenid}/member_blacklist`);
  }

  /**
   * 操作群黑名单（内邀）。
   * POST /v2/groups/{group_openid}/member_blacklist
   * op: add 加入 / del 移除。目标用户不在群里才能加入。
   */
  operateGroupBlacklist(groupOpenid, { op, memberOpenids }) {
    this.#needInvite();
    return this.#request('POST', `/v2/groups/${groupOpenid}/member_blacklist`, {
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
    return this.#request('GET', `/v2/groups/${groupOpenid}/join_request_list${suffix}`);
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
  handleJoinRequest(groupOpenid, memberOpenid, body = {}) {
    const payload = { op: body.op };
    if (body.joinRequestId) payload.join_request_id = body.joinRequestId;
    if (body.rejectReason) payload.reject_reason = body.rejectReason;
    if (body.addToBlacklist) payload.add_to_member_blacklist = true;
    return this.#request(
      'POST',
      `/v2/groups/${groupOpenid}/approval_join_request/${memberOpenid}`,
      payload,
    );
  }

  /** 通过入群申请 */
  approveJoinRequest(groupOpenid, memberOpenid, joinRequestId) {
    return this.handleJoinRequest(groupOpenid, memberOpenid, { op: 'approve', joinRequestId });
  }

  /** 拒绝入群申请，可同时拉黑 */
  declineJoinRequest(groupOpenid, memberOpenid, { joinRequestId, rejectReason, addToBlacklist } = {}) {
    return this.handleJoinRequest(groupOpenid, memberOpenid, {
      op: 'decline',
      joinRequestId,
      rejectReason,
      addToBlacklist,
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

  /* ---------------- 内部 ---------------- */

  #payload({ content, msgType = 0, msgId, markdown, keyboard, media, ark }) {
    const payload = { msg_type: msgType, content: content ?? '' };
    if (msgId) {
      payload.msg_id = msgId;
      payload.msg_seq = this.#nextSeq(msgId);
    }
    if (markdown) {
      payload.markdown = markdown;
      payload.msg_type = 2;
    }
    if (keyboard) payload.keyboard = keyboard;
    if (media) payload.media = media;
    if (ark) {
      payload.ark = ark;
      payload.msg_type = 3;
    }
    return payload;
  }

  #nextSeq(msgId) {
    const cur = this.seqMap.get(msgId) ?? 0;
    const next = cur + 1;
    this.seqMap.set(msgId, next);
    if (this.seqMap.size > 2000) {
      this.seqMap.delete(this.seqMap.keys().next().value);
    }
    return next;
  }
}
