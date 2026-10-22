import { createLogger } from './logger.js';

const log = createLogger('api');

/**
 * QQ 开放平台 HTTP API 封装。
 * 鉴权头格式固定为 "QQBot {access_token}"。
 */
export class QQApi {
  constructor({ tokenManager, baseUrl }) {
    this.tokens = tokenManager;
    this.baseUrl = baseUrl;
    // msg_id -> 已用的 msg_seq，被动回复同一消息时必须递增
    this.seqMap = new Map();
  }

  async #request(method, path, body, { retried = false } = {}) {
    const token = await this.tokens.get();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${token}`,
        'Content-Type': 'application/json',
        'X-Union-Appid': this.tokens.appId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // token 失效：刷新后重试一次
    if (res.status === 401 && !retried) {
      log.warn('接口返回 401，刷新 token 后重试');
      await this.tokens.refresh();
      return this.#request(method, path, body, { retried: true });
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const msg = data?.message || data?.msg || text.slice(0, 300);
      const err = new Error(`HTTP ${res.status} ${method} ${path}: ${msg}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  /** 网关地址。返回 { url, shards, session_start_limit } */
  getGateway() {
    return this.#request('GET', '/gateway/bot');
  }

  /**
   * 发送群消息。
   * @param {string} groupOpenid 群 openid
   * @param {object} opts { content, msgType, msgId, markdown, keyboard, media, ark }
   */
  async sendGroup(groupOpenid, opts = {}) {
    const payload = this.#buildPayload(opts);
    return this.#request('POST', `/v2/groups/${groupOpenid}/messages`, payload);
  }

  /** 发送单聊消息 */
  async sendC2C(openid, opts = {}) {
    const payload = this.#buildPayload(opts);
    return this.#request('POST', `/v2/users/${openid}/messages`, payload);
  }

  /** 上传/发送群聊富媒体（图片、视频、语音） */
  postGroupFile(groupOpenid, { fileType = 1, url, srvSendMsg = false }) {
    return this.#request('POST', `/v2/groups/${groupOpenid}/files`, {
      file_type: fileType,
      url,
      srv_send_msg: srvSendMsg,
    });
  }

  postC2CFile(openid, { fileType = 1, url, srvSendMsg = false }) {
    return this.#request('POST', `/v2/users/${openid}/files`, {
      file_type: fileType,
      url,
      srv_send_msg: srvSendMsg,
    });
  }

  #buildPayload({ content, msgType = 0, msgId, markdown, keyboard, media, ark }) {
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
    // 防止无限增长：超过 2000 条清一次最老的
    if (this.seqMap.size > 2000) {
      const oldest = this.seqMap.keys().next().value;
      this.seqMap.delete(oldest);
    }
    return next;
  }
}
