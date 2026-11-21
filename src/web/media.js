/**
 * 面板「素材」页的后端逻辑：`/api/media-images*`
 *
 * 为什么单独成模块（跟 qq-call.js 一个套路）：
 *   · server.js 已经是一个几百条 if 的大回调，业务判断塞进去没法单测；
 *   · 这里全是纯函数 + QQApi 方法调用，用假 runtime 就能跑完整流程。
 *
 * 安全边界：
 *   1. 路由层已经过 authorized() / CSRF / 同源校验（见 server.js）；
 *   2. prepare / complete / delete 是 endpoints.js 里的 internal 接口，不准走
 *      /api/qq/call 白名单——外部手搓会绕开 api.js 的本地预检和 100 张配额管理；
 *   3. 删除必须先 listMediaImages 确认 id 属于当前机器人，再显式 allowUnowned。
 *      素材库是机器人级共享的，默认「只删本进程上传的」是刻意的保护。
 */

import { MEDIA_IMAGE_MAX, MEDIA_IMAGE_QUOTA } from '../api.js';

/** 官方素材错误码 → 人话，沿用 qq-call.js 的「提示 + 原始错误」口径 */
export const MEDIA_ERR_HINTS = {
  40035001: '图片格式不支持：扩展名与 Content-Type 要一致，且只能是 png / jpeg / gif / webp',
  40035002: '图片超过 10MB 上限',
  40035003: '上传任务不存在、已过期（超过 4 小时）或不属于当前机器人，请重新上传',
  40035006: '平台处理失败（COS 或链接生成），稍后再试',
  40035007: '机器人素材已达 100 张上限，先删掉不用的图片',
  40035008: '图片不存在或已被删除',
  40035009: '图片已过期或已被删除，引用链接不再可用',
  40035010: '引用链接无效，或不属于当前机器人',
};

/** base64 解码后上限；先按字符串长度挡一次，别让 14MB 的字符串白解码 */
const MEDIA_B64_MAX = Math.ceil(MEDIA_IMAGE_MAX / 3) * 4;

function errorCodeOf(e) {
  const raw = e?.qqCode ?? e?.code ?? e?.body?.code ?? e?.status;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function humanMediaError(e) {
  const code = errorCodeOf(e);
  const hint = code != null ? MEDIA_ERR_HINTS[code] : null;
  const raw = String(e?.message ?? e ?? '');
  return hint ? `${hint}（原始错误：${raw}）` : raw;
}

function failed(e) {
  return {
    code: 502,
    body: {
      ok: false,
      error: humanMediaError(e),
      code: errorCodeOf(e),
      reason: String(e?.reason ?? ''),
    },
  };
}

function resolveRuntime({ runtimes = [], bot = '', fallbackRuntime = null } = {}) {
  let rt = fallbackRuntime;
  if (bot) {
    rt = runtimes.find((r) => r.id === bot) ?? null;
    if (!rt) {
      return { err: { code: 404, body: { ok: false, error: `没有这个机器人：${bot}` } } };
    }
  }
  if (!rt?.api) {
    return { err: { code: 503, body: { ok: false, error: '机器人还没就绪（没连上网关或没拿到 api）' } } };
  }
  return { rt };
}

/** GET /api/media-images —— 列表按官方 cursor 原样翻页，不在服务端拼页 */
export async function handleMediaList({ runtimes = [], query = {}, fallbackRuntime = null, log = null } = {}) {
  const { rt, err } = resolveRuntime({ runtimes, bot: query.bot, fallbackRuntime });
  if (err) return err;
  try {
    const out = await rt.api.listMediaImages({ cursor: String(query.cursor ?? '') });
    return {
      code: 200,
      body: {
        ok: true,
        images: Array.isArray(out?.images) ? out.images : [],
        nextCursor: String(out?.nextCursor ?? ''),
        total: Number(out?.total) || 0,
        quota: Number(out?.quota) || MEDIA_IMAGE_QUOTA,
      },
    };
  } catch (e) {
    log?.warn?.(`media.list ${rt.id} ✗ ${e?.message ?? e}`);
    return failed(e);
  }
}

/**
 * POST /api/media-images/upload —— body:{ bot?, name, data(base64) }
 *
 * retain:true 是刻意的：面板里上传的是「想留着复用」的素材，不是发一条消息
 * 用完即删的临时图。不 retain 的话，下次进程启动会被孤儿回收清掉。
 */
export async function handleMediaUpload({ runtimes = [], body = {}, fallbackRuntime = null, log = null } = {}) {
  const { rt, err } = resolveRuntime({ runtimes, bot: body.bot, fallbackRuntime });
  if (err) return err;

  const rawName = String(body?.name ?? '').trim();
  // 明确拒绝路径分隔符：静默 basename 会把「传个路径过来」的请求伪装成正常上传
  if (!rawName || rawName.length > 200 || /[\\/]/.test(rawName)) {
    return { code: 400, body: { ok: false, error: '文件名不合法（1–200 字符，不能带路径）' } };
  }
  const name = rawName;
  const data = String(body?.data ?? '');
  if (!data || data.length > MEDIA_B64_MAX || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return { code: 400, body: { ok: false, error: '图片数据不是合法的 base64，或超过 10MB 上限' } };
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > MEDIA_IMAGE_MAX) {
    return { code: 400, body: { ok: false, error: '图片为空或超过 10MB 上限' } };
  }

  const t0 = Date.now();
  try {
    const out = await rt.api.uploadMarkdownImageBytes(buf, { fileName: name, retain: true });
    log?.info?.(`media.upload ${rt.id} ${name} ✓ ${Date.now() - t0}ms`);
    return { code: 200, body: { ok: true, image: out ?? null } };
  } catch (e) {
    log?.warn?.(`media.upload ${rt.id} ${name} ✗ ${e?.message ?? e}`);
    return failed(e);
  }
}

/**
 * 翻遍素材列表找 image_id。官方首页不传 cursor，nextCursor 为空即末页。
 * 有上限 + 游标去重：万一平台回了个循环游标，不能让删除请求永远转下去。
 */
export async function findMediaImage(api, imageId) {
  let cursor = '';
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const page = await api.listMediaImages({ cursor });
    const hit = (Array.isArray(page?.images) ? page.images : []).find((x) => x?.imageId === imageId);
    if (hit) return hit;
    const next = String(page?.nextCursor ?? '');
    if (!next || seen.has(next)) return null;
    seen.add(next);
    cursor = next;
  }
  return null;
}

/** 翻遍素材列表收集 imageId → item；批量删除一次校验所有 id，别逐张翻页打爆限频 */
async function listAllMediaImages(api, maxPages = 100) {
  const found = new Map();
  let cursor = '';
  const seen = new Set();
  for (let i = 0; i < maxPages; i++) {
    const page = await api.listMediaImages({ cursor });
    for (const x of (Array.isArray(page?.images) ? page.images : [])) {
      if (x?.imageId) found.set(x.imageId, x);
    }
    const next = String(page?.nextCursor ?? '');
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return found;
}

/**
 * POST /api/media-images/delete
 *   body:{ bot?, imageId, confirm:true }          —— 单张，兼容原返回结构
 *   body:{ bot?, imageIds:[...], confirm:true }   —— 批量，一次翻页校验后逐张删
 *
 * 批量返回的 deleted / missing / failed 让前端能逐张反馈；只要删掉至少一张就算 200，
 * 全失败才按 404 / 502 返回。归属校验同单张：必须在当前机器人素材库里才 allowUnowned。
 */
export async function handleMediaDelete({ runtimes = [], body = {}, fallbackRuntime = null, log = null } = {}) {
  const isBatch = Array.isArray(body?.imageIds);
  const ids = isBatch
    ? [...new Set(body.imageIds.map((x) => String(x).trim()).filter(Boolean))]
    : [String(body?.imageId ?? '').trim()].filter(Boolean);
  if (!ids.length) return { code: 400, body: { ok: false, error: '缺少 imageId' } };
  if (ids.length > MEDIA_IMAGE_QUOTA) {
    return { code: 400, body: { ok: false, error: `一次最多删 ${MEDIA_IMAGE_QUOTA} 张` } };
  }
  if (body?.confirm !== true) {
    return { code: 403, body: { ok: false, error: '删除素材需要显式确认（confirm: true）' } };
  }
  const { rt, err } = resolveRuntime({ runtimes, bot: body.bot, fallbackRuntime });
  if (err) return err;
  try {
    const found = await listAllMediaImages(rt.api);
    const deleted = [];
    const missing = [];
    const failedItems = [];
    let lastError = null;
    for (const id of ids) {
      const hit = found.get(id);
      if (!hit) {
        missing.push(id);
        continue;
      }
      try {
        await rt.api.deleteMediaImage(id, { allowUnowned: true });
        deleted.push({ imageId: id, fileName: hit.fileName ?? '' });
        log?.info?.(`media.delete ${rt.id} ${id} ✓`);
      } catch (e) {
        lastError = lastError || e;
        failedItems.push({ imageId: id, error: humanMediaError(e) });
        log?.warn?.(`media.delete ${rt.id} ${id} ✗ ${e?.message ?? e}`);
      }
    }
    // 单张：原样返回，老前端和单测都不用改
    if (!isBatch) {
      if (deleted.length) return { code: 200, body: { ok: true, imageId: ids[0], fileName: deleted[0].fileName } };
      if (missing.length) {
        return { code: 404, body: { ok: false, error: '这张图片不在当前机器人的素材库里（可能已过期或被删）' } };
      }
      return failed(lastError || new Error('删除失败'));
    }
    const code = deleted.length ? 200 : (missing.length ? 404 : 502);
    const out = { ok: deleted.length > 0, deleted, missing, failed: failedItems };
    if (code !== 200) {
      out.error = [
        missing.length ? `${missing.length} 张已不存在` : '',
        failedItems.length ? `${failedItems.length} 张删除失败：${failedItems[0].error}` : '',
      ].filter(Boolean).join('；');
    }
    return { code, body: out };
  } catch (e) {
    log?.warn?.(`media.delete ${rt.id} ✗ ${e?.message ?? e}`);
    return failed(e);
  }
}
