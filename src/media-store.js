/**
 * 账本图片的落盘存储。
 *
 * ## 为什么要下载
 *
 * QQ 入站附件的 `url` 是**带时效的下载地址**（`multimedia.nt.qq.com.cn/download?…&rkey=…`），
 * 过期之后谁也拿不回来。账本要长期留档，就只能在收到消息那一刻存一份。
 *
 * ## 为什么默认关
 *
 * 存图吃磁盘、吃网络、还可能存到别人的隐私照片——这三件事都不该由框架
 * 默认替用户决定。`ledger.saveImages` 默认 false，用户自己开。
 *
 * ## 为什么不做真缩略图
 *
 * 框架零依赖，没有 JPEG/WebP 缩放能力。面板用 CSS 限尺寸 + `loading="lazy"`，
 * 视觉上就是缩略图，CPU 和磁盘都省。真要压，用户自己换图床。
 *
 * ## 目录布局
 *
 *   `<data>/bots/<botId>/ledger-media/<yyyymmdd>/<sha1_16>.<ext>`
 *
 * 按日期分目录有两个用处：单目录文件数不会失控（一个群一年几万张图，
 * 平铺会拖慢 `readdir`）；清理时按目录判断比逐文件 `stat` 快。
 * 文件名用内容哈希：同一张图被转发多次只存一份。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { dimsOf } from './md-image.js';

/** 允许下载的协议。只认 http/https，`file:` / `data:` 一律拒绝 */
const OK_PROTOCOL = /^https?:$/i;

/** 从字节头判扩展名。比 `content-type` 可信——后者常缺，也可能是 `application/octet-stream` */
function extOf(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return '';
}

/** content-type → 扩展名（字节头认不出时的兜底） */
function extOfType(ct) {
  const t = String(ct ?? '').toLowerCase();
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
  if (t.includes('png')) return 'png';
  if (t.includes('gif')) return 'gif';
  if (t.includes('webp')) return 'webp';
  return '';
}

/** 本地日期目录（YYYYMMDD）。用本地时区：用户按「今天存的」去找图 */
function dayDir(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * @param {object} p
 * @param {string} p.dir 根目录（`data/bots/<botId>/ledger-media`）
 * @param {number} [p.maxBytes] 单张上限，超过直接放弃
 * @param {typeof fetch} [p.fetchImpl] 测试注入
 */
export function createMediaStore({ dir, maxBytes = 2 * 1024 * 1024, fetchImpl = fetch } = {}) {
  const root = path.resolve(String(dir ?? ''));

  /**
   * 把相对路径解析成绝对路径，**并且保证没跑出根目录**。
   *
   * 这是面板图片接口的唯一入口，必须在这里挡穿越（`../..`、绝对路径、
   * 符号链接暂不管——目录是我们自己写的，外部改不了）。
   *
   * @returns {string|null} 越界或空返回 null
   */
  function resolve(rel) {
    const r = String(rel ?? '').replace(/\\/g, '/').trim();
    if (!r || r.includes('\0')) return null;
    const abs = path.resolve(root, r);
    const back = path.relative(root, abs);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
    return abs;
  }

  /** 落盘：先写 `.tmp` 再 rename，断电/进程被杀不会留下半张图 */
  async function write(sub, buf) {
    const abs = path.join(root, sub);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, abs);
    return sub;
  }

  /**
   * 存一份字节。
   *
   * @param {Buffer} buf
   * @param {object} [meta] `{ct, w, h}` 外部已知的尺寸/类型
   * @returns {Promise<object|null>} `{t:'image', file, w, h, size}`；超限或不是图返回 null
   */
  async function saveBuffer(buf, meta = {}) {
    if (!Buffer.isBuffer(buf) || !buf.length) return null;
    if (buf.length > maxBytes) return null;
    const ext = extOf(buf) || extOfType(meta.ct);
    /** 认不出的格式不存：面板显示不了，存下来只是占地方 */
    if (!ext) return null;
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const sub = `${dayDir()}/${name}.${ext}`;
    await write(sub, buf);
    /** 尺寸优先用调用方给的（入站报文里就有），没有再读文件头 */
    const dims = (meta.w && meta.h) ? { w: Number(meta.w), h: Number(meta.h) } : dimsOf(buf);
    return { t: 'image', file: sub, w: Number(dims.w) || 0, h: Number(dims.h) || 0, size: buf.length };
  }

  /**
   * 从 URL 下载。
   *
   * 三个闸：协议只认 http/https；`content-length` 预判（省一次白下载）；
   * 读完之后再量一次真实长度（对方可以不报 length）。
   *
   * 失败一律返回 null，不抛——存图失败不能影响收消息。
   */
  async function saveFromUrl(url, { ct = '', w = 0, h = 0, timeoutMs = 15000 } = {}) {
    let u;
    try {
      u = new URL(String(url ?? ''));
    } catch {
      return null;
    }
    if (!OK_PROTOCOL.test(u.protocol)) return null;
    try {
      const res = await fetchImpl(u.href, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        headers: { 'user-agent': 'qq-bot-roost/ledger' },
      });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len && len > maxBytes) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return await saveBuffer(buf, { ct: ct || res.headers.get('content-type') || '', w, h });
    } catch {
      return null;
    }
  }

  /** 从本地文件存（出站发图时源文件就在本地，不用走网络） */
  async function saveFromFile(file, { ct = '', w = 0, h = 0 } = {}) {
    try {
      const st = await fs.stat(file);
      if (!st.isFile() || !st.size || st.size > maxBytes) return null;
      return await saveBuffer(await fs.readFile(file), { ct, w, h });
    } catch {
      return null;
    }
  }

  /** 删一个（清理/用户删账本时用）。文件没了不算错 */
  async function remove(rel) {
    const abs = resolve(rel);
    if (!abs) return false;
    try {
      await fs.unlink(abs);
      return true;
    } catch {
      return false;
    }
  }

  /** 根目录（面板显示占用、诊断用） */
  function dirOf() {
    return root;
  }

  return { resolve, saveBuffer, saveFromUrl, saveFromFile, remove, dirOf, maxBytes };
}
