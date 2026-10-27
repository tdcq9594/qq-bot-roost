/**
 * 扫码一键创建 QQ 官方机器人。
 *
 * 官方开放平台提供了一套「绑定」接口，扫一下手机 QQ 就能拿到 AppID / AppSecret，
 * 不用去 q.qq.com 手动建机器人、再手动复制两个值。
 *
 * 三个接口（都是 POST，JSON）：
 *
 *   1. /lite/create_bind_task   { key }        → { data: { task_id } }
 *      key 是我们自己生成的 base64(32 字节随机数)，后面用它解密 secret
 *
 *   2. 二维码内容不是图片，是一个 URL，前端自己画成二维码：
 *      https://q.qq.com/qqbot/openclaw/connect.html?task_id=<id>&_wv=2
 *
 *   3. /lite/poll_bind_result   { task_id }    → { data: { status, bot_appid, bot_encrypt_secret } }
 *      status: 0 无 / 1 待扫码 / 2 完成 / 3 过期
 *
 * 完成时 `bot_encrypt_secret` 是 AES-256-GCM 密文：
 *   base64 解开 = nonce(12) + ciphertext + tag(16)，key 就是第 1 步的 bindKey。
 *
 * 为什么不用第三方库：`node:crypto` 自带 aes-256-gcm，零依赖。
 *
 * 参考实现：AstrBot 的 `qqofficial/login_registration.py`（协议一致，值得致敬）。
 */

import { randomBytes, createDecipheriv } from 'node:crypto';

/** 绑定接口的域名。留个常量，方便以后换成测试环境 */
const BIND_HOST = 'q.qq.com';
const TIMEOUT_MS = 10_000;

/** 轮询状态码 */
export const BIND_STATUS = {
  NONE: 0,
  PENDING: 1,
  DONE: 2,
  EXPIRED: 3,
};

async function postJson(url, payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`绑定接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(`绑定接口失败（HTTP ${res.status}）：${data?.msg ?? text.slice(0, 120)}`);
    if (data && data.retcode != null && Number(data.retcode) !== 0) {
      throw new Error(data.msg || data.message || `绑定接口返回 retcode=${data.retcode}`);
    }
    return data ?? {};
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('连不上 q.qq.com（超时 10 秒），检查网络或代理');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 二维码里要放的内容 */
export function connectUrl(taskId) {
  return `https://${BIND_HOST}/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&_wv=2`;
}

/**
 * 建一个绑定任务。
 *
 * @returns {Promise<{taskId:string, bindKey:string, qrUrl:string}>}
 */
export async function createBindTask() {
  // 32 字节随机数当 AES-256 的 key，base64 后发给官方
  const bindKey = randomBytes(32).toString('base64');
  const data = await postJson(`https://${BIND_HOST}/lite/create_bind_task`, { key: bindKey });
  const taskId = String(data?.data?.task_id ?? '').trim();
  if (!taskId) throw new Error('绑定任务没返回 task_id，可能是接口变了');
  return { taskId, bindKey, qrUrl: connectUrl(taskId) };
}

/**
 * 解 AppSecret。
 *
 * 密文格式：base64( nonce[12] + ciphertext + tag[16] )
 * 少了任何一段都会解不开——所以长度不够就直接报错，别硬解。
 */
export function decryptSecret(encrypted, bindKey) {
  let key;
  let raw;
  try {
    key = Buffer.from(bindKey, 'base64');
    raw = Buffer.from(String(encrypted), 'base64');
  } catch {
    throw new Error('凭证解码失败（bindKey 或密文不是合法 base64）');
  }
  if (key.length !== 32) throw new Error(`bindKey 长度不对（要 32 字节，实际 ${key.length}）`);
  if (raw.length <= 28) throw new Error(`密文太短（${raw.length} 字节，至少要 29）`);

  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);

  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ciphertext), d.final()]).toString('utf8');
  } catch {
    throw new Error('AppSecret 解不开（密钥不匹配或数据被改动）');
  }
}

/**
 * 查一次扫码结果。
 *
 * @returns {Promise<{status:'pending'|'done'|'expired'|'error', appId?:string, appSecret?:string, message?:string}>}
 */
export async function pollBindResult({ taskId, bindKey }) {
  if (!taskId) throw new Error('缺 task_id');
  if (!bindKey) throw new Error('缺 bind_key');

  const data = await postJson(`https://${BIND_HOST}/lite/poll_bind_result`, { task_id: taskId });
  const p = data?.data ?? {};
  const status = Number(p.status ?? BIND_STATUS.NONE);

  if (status === BIND_STATUS.DONE) {
    const appId = String(p.bot_appid ?? '').trim();
    const encrypted = String(p.bot_encrypt_secret ?? '').trim();
    if (!appId || !encrypted) {
      return { status: 'error', message: '扫码成功了，但官方没返回完整凭证（缺 appid 或 secret）' };
    }
    try {
      return { status: 'done', appId, appSecret: decryptSecret(encrypted, bindKey) };
    } catch (e) {
      return { status: 'error', message: e.message };
    }
  }

  if (status === BIND_STATUS.EXPIRED) {
    return { status: 'expired', message: '二维码过期了，重新生成一个' };
  }

  return { status: 'pending' };
}
