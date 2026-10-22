import { createLogger } from './logger.js';

const log = createLogger('token');

/**
 * 访问凭证管理（官方称 AccessToken）。
 * 官方说明：有效期 7200 秒，不会自动续期；到期前 60 秒内再次获取会拿到新 token。
 * 因此这里提前 120 秒刷新，留足余量。
 */
export class TokenManager {
  constructor({ appId, appSecret, baseUrl }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseUrl = baseUrl;
    this.token = '';
    this.expiresAt = 0;
    this.pending = null;
  }

  get valid() {
    return this.token && Date.now() < this.expiresAt - 120_000;
  }

  /** 并发安全：多个请求同时缺 token 时只发一次网络请求 */
  async get() {
    if (this.valid) return this.token;
    if (!this.pending) {
      this.pending = this.#fetch().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  /** 强制刷新（收到 401 时调用） */
  async refresh() {
    this.token = '';
    this.expiresAt = 0;
    return this.get();
  }

  async #fetch() {
    const url = `${this.baseUrl}/app/getAppAccessToken`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`获取访问凭证失败（HTTP ${res.status}）: ${text.slice(0, 200)}`);
    }
    if (!data.access_token) {
      throw new Error(`获取访问凭证失败: ${text.slice(0, 300)}`);
    }
    // 文档里 expires_in 是字符串，做一次兼容
    const ttl = Number(data.expires_in) || 7200;
    this.token = data.access_token;
    this.expiresAt = Date.now() + ttl * 1000;
    log.info(`已获取访问凭证，有效期 ${ttl}s`);
    return this.token;
  }

  /** 仅用于启动自检：验证凭证是否可用 */
  async verify() {
    await this.get();
    return true;
  }
}
