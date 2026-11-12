/**
 * 宿主协议：富媒体
 * ================
 *
 * ai-chat 作为框架内插件时，发图 / 发文件 / 发语音都靠「本地绝对路径」：
 * 它和框架在同一台机器上，`msg.replyFile(path)` 直接读盘。宿主协议换成
 * 跨进程之后这条路断了——宿主手上的文件在另一台机器（甚至另一个容器），
 * 给一个路径框架根本打不开。
 *
 * 所以这里提供两条上传通道：
 *   1. `media.upload`       一次把 ≤8MiB 的 base64 / URL / 本机路径传上来
 *   2. `media.upload.*`     分块会话，任意大小（官方硬上限 200MB）都能传
 *
 * 落到框架侧之后一律复用 `QQApi` 现成的上传实现：≤5MB 走 `uploadMedia`
 * 二进制直传，更大写临时文件走 `uploadLocalFileSharded` 分片。
 * 不在这里重写一遍分片协议——`src/api.js` 那份已经处理了续传、校验和降级。
 *
 * 语音单独走 `onebot/voice.js`：WAV/SILK → `uploadVoice()`，依赖 `silk-wasm`
 * 是可选依赖，缺了明确报 NOT_READY，不让整个协议起不来。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FILE_TYPE, IMAGE_CONTENT_TYPES } from '../api.js';
import { netFetch } from '../proxy.js';
import * as deps from '../onebot/deps.js';
import { toSilk, uploadVoice, MAX_VOICE_BYTES } from '../onebot/voice.js';
import { sendOut, receivedAtOf } from './dispatch.js';

/** 官方所有富媒体类型的硬上限；会话累计超过就拒，别等 API 报 850031 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 二进制直传上限。官方口径 5M，base64 后约 6.7MiB（见 server.js MAX_PAYLOAD） */
const DIRECT_LIMIT = 5 * 1024 * 1024;
/** 分块会话：10 分钟没 finish 就回收，最多同时 8 个 */
const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 8;
/** media.fetch 下载上限（看图用，20MB 足够） */
const FETCH_LIMIT = 20 * 1024 * 1024;

const str = (v, d = '') => (v === undefined || v === null ? d : String(v));

function sceneOf(p, err) {
  if (p.scene !== 'group' && p.scene !== 'c2c') {
    throw err.bad('scene 只能是 group / c2c');
  }
  const target = str(p.target).trim();
  if (!target) throw err.bad('要给 target（群 / 用户 openid）');
  return { scene: p.scene, target };
}

function fileTypeOf(p, err) {
  const n = Number(p.fileType) || FILE_TYPE.IMAGE;
  if (![1, 2, 3, 4].includes(n)) throw err.bad('fileType 只能是 1 图 / 2 视频 / 3 语音 / 4 文件');
  return n;
}

/** 只允许 http(s)，且不接受 file:// / 内网探测以外的怪协议 */
function assertUrl(u, err) {
  let parsed;
  try {
    parsed = new URL(String(u));
  } catch {
    throw err.bad('url 不是合法地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw err.bad('url 只支持 http / https');
  }
  return parsed.toString();
}

function decodeB64(v, err, label = 'dataBase64') {
  const s = str(v);
  if (!s) throw err.bad(`要给 ${label}`);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(s)) throw err.bad(`${label} 不是合法 base64`);
  const buf = Buffer.from(s.replace(/\s/g, ''), 'base64');
  if (!buf.length) throw err.bad(`${label} 解出来是空的`);
  return buf;
}

/**
 * 官方只认 png/jpeg/gif/webp，且**文件名扩展名必须与 content_type 一致**
 * （错误码 40035001）。宿主常常只丢一段 base64 过来、不带文件名，
 * 这里按文件头补一个正确的扩展名；给了合法扩展名就原样用。
 *
 * 早期版本一律落成 `.png` 临时文件，jpeg/gif/webp 会在 COS 或 prepare 阶段被拒。
 */
function imageFileName(buf, given) {
  const raw = str(given).split(/[\\/]/).pop().trim();
  let ext = path.extname(raw).toLowerCase();
  if (ext && IMAGE_CONTENT_TYPES[ext]) return raw.slice(0, 200);
  const h = Buffer.from(buf.subarray(0, 16));
  if (h.length >= 8 && h[0] === 0x89 && h.toString('ascii', 1, 4) === 'PNG') ext = '.png';
  else if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) ext = '.jpg';
  else if (h.toString('ascii', 0, 4) === 'GIF8') ext = '.gif';
  else if (h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 12) === 'WEBP') ext = '.webp';
  else ext = '';
  const base = (raw ? raw.replace(/\.[^.]+$/, '') : 'image').slice(0, 180) || 'image';
  return `${base}${ext || '.png'}`;
}

/** 临时文件统一放系统临时目录，写完必删；不往工作区 data/ 里堆垃圾 */
async function withTempFile(buf, ext, fn) {
  const p = path.join(os.tmpdir(), `roost-host-${crypto.randomUUID()}${ext}`);
  await fs.writeFile(p, buf);
  try {
    return await fn(p);
  } finally {
    await fs.rm(p, { force: true }).catch(() => {});
  }
}

/**
 * @param {(name,scope,desc,run)=>void} def 方法注册器
 * @param {object} ctx
 * @param {object} ctx.R    BotRuntime
 * @param {object} ctx.err  { bad, notFound, notReady, forbidden }
 * @param {(s:string)=>void} [ctx.log]
 */
export function registerMedia(def, { R, err, log = () => {} }) {
  const api = () => {
    if (!R.api) throw err.notReady('官方接口未就绪（机器人还没连上）');
    return R.api;
  };

  /** uploadId → { chunks:Map, size, fileType, scene, target, fileName, at } */
  const sessions = new Map();

  function sweep() {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(id);
  }

  function getSession(id, err2 = err) {
    const s = sessions.get(str(id));
    if (!s) throw err2.notFound('没有这个上传会话（可能已过期或 finish 过）');
    return s;
  }

  /**
   * 把一串字节变成可发送的 `file_info` / Markdown 素材。
   * 所有上传方法最后都汇到这里，避免「一次性」和「分块」两份实现走偏。
   */
  async function uploadBytes(buf, { scene, target, fileType, fileName, voice, markdownImage, retain = false }) {
    if (buf.length > MAX_UPLOAD_BYTES) {
      throw err.bad(`文件 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过官方 200MB 上限`);
    }

    if (markdownImage) {
      const up = await api().uploadMarkdownImageBytes(buf, {
        fileName: imageFileName(buf, fileName),
        retain,
      });
      return { kind: 'markdownImage', ...up };
    }

    if (voice) {
      if (buf.length > MAX_VOICE_BYTES) {
        throw err.bad(`语音 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限`);
      }
      let silkMod = null;
      try {
        silkMod = await deps.load('silk-wasm');
      } catch {
        silkMod = null;
      }
      if (!silkMod) {
        throw err.notReady('缺可选依赖 silk-wasm：到面板「外接 → 依赖」点『一键安装』');
      }
      const { silk: silkBuf, via } = await toSilk(buf, silkMod);
      const fileInfo = await uploadVoice(api(), scene, target, silkBuf);
      return { kind: 'media', fileInfo, via, size: silkBuf.length };
    }

    if (buf.length <= DIRECT_LIMIT) {
      const up = await api().uploadMedia(scene, target, {
        fileType,
        fileData: buf.toString('base64'),
        fileName: fileName || `upload-${Date.now()}`,
      });
      if (!up?.file_info) throw err.notReady('上传成功但没拿到 file_info');
      return { kind: 'media', fileInfo: up.file_info, via: 'direct', size: buf.length };
    }

    const ext = path.extname(fileName || '') || '';
    const up = await withTempFile(buf, ext, (p) =>
      api().uploadLocalFileSharded(scene, target, p, fileType),
    );
    if (!up?.file_info) throw err.notReady('分片上传成功但没拿到 file_info');
    return { kind: 'media', fileInfo: up.file_info, via: 'sharded', size: buf.length };
  }

  /** 从 url / dataBase64 / path 取到字节或直接用 URL 上传 */
  async function uploadInput(p, opts) {
    if (p.url) {
      const u = assertUrl(p.url, err);
      if (opts.voice || opts.markdownImage) {
        const got = await fetchBytes(u);
        return await uploadBytes(got.buf, { ...opts, fileName: opts.fileName || got.fileName });
      }
      const up = await api().uploadMedia(opts.scene, opts.target, {
        fileType: opts.fileType,
        url: u,
        fileName: opts.fileName || '',
      });
      if (!up?.file_info) throw err.notReady('URL 上传成功但没拿到 file_info');
      return { kind: 'media', fileInfo: up.file_info, via: 'url', size: 0 };
    }
    if (p.path) {
      /** 框架本机路径：同机部署时省掉一次 base64 往返；跨机请用 dataBase64 */
      const p2 = str(p.path);
      const st = await fs.stat(p2).catch(() => null);
      if (!st?.isFile()) throw err.notFound(`框架这边没有这个文件：${p2}`);
      const up = opts.markdownImage
        ? {
            kind: 'markdownImage',
            ...(await api().uploadMarkdownImageBytes(await fs.readFile(p2), {
              fileName: path.basename(p2),
              retain: opts.retain === true,
            })),
          }
        : await (async () => {
            const r = await api().uploadLocalFileSharded(opts.scene, opts.target, p2, opts.fileType);
            if (!r?.file_info) throw err.notReady('分片上传成功但没拿到 file_info');
            return { kind: 'media', fileInfo: r.file_info, via: 'path', size: st.size };
          })();
      return up;
    }
    if (p.dataBase64) {
      return await uploadBytes(decodeB64(p.dataBase64, err), opts);
    }
    throw err.bad('url / dataBase64 / path 至少给一个');
  }

  async function fetchBytes(u) {
    const url = assertUrl(u, err);
    const res = await netFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw err.notReady(`下载失败：HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > FETCH_LIMIT) throw err.bad(`远端文件 ${(len / 1024 / 1024).toFixed(1)}MB 超过 20MB 上限`);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > FETCH_LIMIT) throw err.bad('下载内容超过 20MB 上限');
    const name = path.basename(new URL(url).pathname) || '';
    return { buf, fileName: name, contentType: res.headers.get('content-type') || '' };
  }

  /* ---------------- 一次性上传 ---------------- */

  def('media.upload', 'message', '上传图片/文件/视频/语音，返回可发送的 file_info', async (p) => {
    const { scene, target } = sceneOf(p, err);
    return await uploadInput(p, {
      scene, target,
      fileType: fileTypeOf(p, err),
      fileName: str(p.fileName).slice(0, 200),
      voice: p.voice === true,
      markdownImage: p.markdownImage === true,
      retain: p.retain !== false,
    });
  });

  def('media.send', 'message', '上传并直接发出一条富媒体消息（被动/主动都支持）', async (p) => {
    const { scene, target } = sceneOf(p, err);
    const up = await uploadInput(p, {
      scene, target,
      fileType: fileTypeOf(p, err),
      fileName: str(p.fileName).slice(0, 200),
      voice: p.voice === true,
      markdownImage: false,
    });
    if (up.kind !== 'media') throw err.bad('这条不是会话富媒体，不能 send');
    const body = {
      msgType: 7,
      media: { file_info: up.fileInfo },
    };
    for (const k of ['msgId', 'eventId', 'msgSeq', 'messageReference']) {
      if (p[k] !== undefined) body[k] = k === 'msgSeq' ? Number(p[k]) : p[k];
    }
    const data = await sendOut({
      R, log, kind: scene, chatId: target, payload: body,
      receivedAt: receivedAtOf(R, p),
      requestId: str(p.requestId).slice(0, 120),
      fileType: fileTypeOf(p, err),
    });
    return { id: data.id, msgId: data.id, ...(data.pending ? { pending: true } : {}), ...(data.requestId ? { requestId: data.requestId } : {}), upload: { via: up.via, size: up.size } };
  });

  def('media.markdownImage', 'message', '上传 Markdown 素材图，返回可复用的 qqbot-media:// 引用（默认保留）', async (p) => {
    return await uploadInput(p, {
      scene: p.scene === 'group' ? 'group' : 'c2c',
      target: str(p.target) || 'markdown',
      fileType: FILE_TYPE.IMAGE,
      fileName: str(p.fileName).slice(0, 200),
      voice: false,
      markdownImage: true,
      /** 默认保留：宿主拿 URL 自己去发消息，框架不会自动替它删；用完调 media.image.delete */
      retain: p.retain !== false,
    });
  });

  /* ---------------- 官方素材管理（GET /v2/media-images 这一套） ---------------- */

  /** 按 cursor 翻页找某个 image_id：删除前先确认它确实属于本机器人 */
  async function findMediaImage(id) {
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const r = await api().listMediaImages({ cursor });
      const hit = (r.images ?? []).find((x) => x.imageId === id);
      if (hit) return hit;
      if (!r.nextCursor) return null;
      cursor = r.nextCursor;
    }
    return null;
  }

  def('media.image.list', 'read', '列出机器人级 Markdown 素材（含 100 张配额与剩余量）', async (p) => {
    const r = await api().listMediaImages({ cursor: str(p.cursor).slice(0, 500) });
    return { ...r, remaining: Math.max(0, (r.quota || 100) - (r.total || 0)) };
  });

  def('media.image.delete', 'manage', '删除素材释放配额（要 confirm:true，且 id 必须在列表里）', async (p) => {
    const id = str(p.imageId).trim();
    if (!id) throw err.bad('要给 imageId');
    if (p.confirm !== true) throw err.forbidden('删除素材不可恢复，要带 confirm: true');
    const hit = await findMediaImage(id);
    if (!hit) throw err.notFound(`素材列表里没有 ${id}（可能已删除或已过期）`);
    /**
     * 素材库是机器人级共享的，别的插件 / 上一次进程也可能上传过。
     * 这里已经查过列表确认归属范围，才传 allowUnowned 让框架不拦本进程集合。
     */
    await api().deleteMediaImage(id, { allowUnowned: true });
    return { ok: true, imageId: id, fileName: hit.fileName };
  });

  def('media.image.send', 'message', '上传图片并以 Markdown 发出，默认发完即删（retain:true 可保留）', async (p) => {
    const { scene, target } = sceneOf(p, err);
    const retain = p.retain === true;
    const up = await uploadInput(p, {
      scene, target,
      fileType: FILE_TYPE.IMAGE,
      fileName: str(p.fileName).slice(0, 200),
      voice: false,
      markdownImage: true,
      retain,
    });
    if (up.kind !== 'markdownImage') throw err.bad('没拿到 qqbot-media:// 引用');

    /** 官方 Markdown 语法：![说明 #宽px #高px](qqbot-media://...) */
    const alt = (str(p.alt).slice(0, 200) || '图片').replace(/[[\]()]/g, '');
    const w = Math.max(0, Number(p.width) || 0);
    const h = Math.max(0, Number(p.height) || 0);
    const dim = w && h ? ` #${w}px #${h}px` : '';
    const body = { msgType: 2, markdown: { content: `![${alt}${dim}](${up.url})` } };
    for (const k of ['msgId', 'eventId', 'msgSeq', 'messageReference']) {
      if (p[k] !== undefined) body[k] = k === 'msgSeq' ? Number(p[k]) : p[k];
    }
    try {
      const data = await sendOut({
        R, log, kind: scene, chatId: target, payload: body,
        receivedAt: receivedAtOf(R, p),
        requestId: str(p.requestId).slice(0, 120),
        fileType: FILE_TYPE.IMAGE,
      });
      return { id: data.id, msgId: data.id, ...(data.pending ? { pending: true } : {}), ...(data.requestId ? { requestId: data.requestId } : {}), image: up };
    } finally {
      if (!retain) {
        await api().deleteMediaImage(up.imageId)
          .catch((e) => log(`media.image.send 清理素材 ${up.imageId} 失败：${e?.message ?? e}`));
      }
    }
  });

  def('media.voice', 'message', 'WAV/SILK 转码并上传语音，返回 file_info', async (p) => {
    const { scene, target } = sceneOf(p, err);
    return await uploadInput(p, {
      scene, target,
      fileType: FILE_TYPE.VOICE,
      fileName: str(p.fileName).slice(0, 200),
      voice: true,
      markdownImage: false,
    });
  });

  def('media.fetch', 'read', '把远端 URL 取成 base64（看图用），或落盘到框架临时目录', async (p) => {
    const { buf, contentType, fileName } = await fetchBytes(p.url);
    if (p.saveAsPath === true) {
      const ext = path.extname(fileName) || '.bin';
      const out = path.join(os.tmpdir(), `roost-host-${crypto.randomUUID()}${ext}`);
      await fs.writeFile(out, buf);
      return { path: out, size: buf.length, contentType };
    }
    return { dataBase64: buf.toString('base64'), size: buf.length, contentType };
  });

  /* ---------------- 分块上传会话 ---------------- */

  def('media.upload.begin', 'message', '开一个分块上传会话，返回 uploadId', async (p) => {
    sweep();
    if (sessions.size >= MAX_SESSIONS) throw err.notReady('同时进行的上传会话太多了，先 finish 或等过期');
    const { scene, target } = sceneOf(p, err);
    const id = crypto.randomUUID();
    sessions.set(id, {
      id,
      chunks: new Map(),
      size: 0,
      scene, target,
      fileType: fileTypeOf(p, err),
      fileName: str(p.fileName).slice(0, 200),
      voice: p.voice === true,
      markdownImage: p.markdownImage === true,
      retain: p.retain !== false,
      declaredSize: Math.max(0, Number(p.size) || 0),
      at: Date.now(),
    });
    return { uploadId: id, expiresAt: Date.now() + SESSION_TTL_MS };
  });

  def('media.upload.chunk', 'message', '传一块 base64；index 从 0 开始，可乱序', async (p) => {
    const s = getSession(p.uploadId);
    const idx = Number(p.index);
    if (!Number.isInteger(idx) || idx < 0 || idx > 9999) throw err.bad('index 要是 0–9999 的整数');
    const buf = decodeB64(p.dataBase64, err, 'dataBase64');
    if (s.chunks.has(idx)) throw err.bad(`第 ${idx} 块已经传过了`);
    s.size += buf.length;
    if (s.size > MAX_UPLOAD_BYTES) {
      s.size -= buf.length;
      throw err.bad('累计超过 200MB 上限');
    }
    s.chunks.set(idx, buf);
    s.at = Date.now();
    return { uploadId: s.id, index: idx, received: s.size };
  });

  def('media.upload.finish', 'message', '合并所有分块并上传，返回 file_info', async (p) => {
    const s = getSession(p.uploadId);
    const idx = [...s.chunks.keys()].sort((a, b) => a - b);
    if (!idx.length) throw err.bad('一块都还没传');
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] !== i) throw err.bad(`分块不连续，缺第 ${i} 块`);
    }
    const buf = Buffer.concat(idx.map((i) => s.chunks.get(i)));
    if (s.declaredSize && s.declaredSize !== buf.length) {
      throw err.bad(`长度对不上：begin 说 ${s.declaredSize} 字节，实际 ${buf.length}`);
    }
    sessions.delete(s.id);
    try {
      return await uploadBytes(buf, s);
    } catch (e) {
      log(`分块上传 ${s.id} 失败：${e?.message ?? e}`);
      throw e;
    }
  });

  def('media.upload.abort', 'message', '丢弃一个上传会话', async (p) => {
    const s = getSession(p.uploadId);
    sessions.delete(s.id);
    return { ok: true, discarded: s.chunks.size };
  });
}
