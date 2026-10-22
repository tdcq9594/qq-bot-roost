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
  }

  async #request(method, path, body, { retried = false } = {}) {
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
