import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { DIRS } from './paths.js';
/** 路径里的 id 一律编码：openid / 群号是外部数据，含 / 会拼出别的路径 */
const enc = (v) => encodeURIComponent(String(v ?? ''));

/** 本进程创建、尚未删除的 Markdown 素材 id（崩溃后靠它认领孤儿） */
const OWN_MEDIA_FILE = path.join(DIRS.data, 'media-images-own.json');
/**
 * 宿主协议显式 `retain` 的素材单独存一份：不参与孤儿回收。
 * 刻意不碰 OWN_MEDIA_FILE 的数组格式——reply-auto 的回归测试钉着它，
 * 老用户升级后也不需要做格式迁移。
 */
const KEPT_MEDIA_FILE = path.join(DIRS.data, 'media-images-kept.json');

/** 官方给的单机器人素材配额，查询接口的 total 与它同一口径 */
export const MEDIA_IMAGE_QUOTA = 100;


const log = createLogger('api');

/** 富媒体类型，对应官方 file_type */
export const FILE_TYPE = { IMAGE: 1, VIDEO: 2, VOICE: 3, FILE: 4 };

/**
 * 富媒体软限制（字节）。官方口径：图片 20MB / 视频 30MB / 语音 20MB / 文件 200MB；
 * 超软限**降级为文件**（file_type=4），超硬限制（200MB）直接报错。
 *
 * `message.js` 的 `replyMedia` 用它算降级后的 file_type；
 * `uploadLocalFile` 拿它当最后一道兜底。
 */
export const MEDIA_SOFT_LIMIT = {
  [FILE_TYPE.IMAGE]: 20 * 1024 * 1024,
  [FILE_TYPE.VIDEO]: 30 * 1024 * 1024,
  [FILE_TYPE.VOICE]: 20 * 1024 * 1024,
  [FILE_TYPE.FILE]: 200 * 1024 * 1024,
};

/** 所有富媒体类型的硬上限。超过它官方直接报 850031，连分片都没用 */
export const MEDIA_HARD_LIMIT = 200 * 1024 * 1024;

/**
 * 二进制直传（`file_data`）的上限：**5MB**。
 *
 * 官方原文：「直接上传二进制数据……数据大小不能超过 5M，超过建议使用分片上传」。
 * 实测网关对请求体的容忍比 5MB 大一些（约 10MB），但那是运气不是承诺——
 * 一张 24.4MB 的图 base64 后 32.5MB，网关直接回 `413 Request Entity Too Large`
 * （stgw 的 HTML 报错，连 QQ 的业务错误码都没有）。
 *
 * 所以超过这个值一律走分片上传，别再赌网关的脾气。
 */
export const DIRECT_UPLOAD_LIMIT = 5 * 1024 * 1024;

/**
 * Markdown 素材图床（`/v2/media-images`，机器人级）的单图上限。
 * 跟 `/files` 那套完全无关：那边图片软限 20MB、直传 5MB、分片 200MB。
 */
export const MEDIA_IMAGE_MAX = 10 * 1024 * 1024;

/** 官方只认这四种图片 MIME，且文件名扩展名必须与之一致 */
export const IMAGE_CONTENT_TYPES = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
});

/**
 * 上传前的本地预检：只看文件头 + 扩展名，**不发任何网络请求**。
 *
 * 官方注意事项写明「服务端只校验文件名扩展名与 content_type 是否匹配，
 * 不校验文件实际内容」，坏图会一路成功到发消息才失败。这里提前挡掉，
 * 也顺手满足「扩展名与 content_type 一致」的 40035001 约束。
 *
 * @param {Buffer} head 文件前 12+ 字节
 * @param {string} fileName 含扩展名的文件名
 */
export function inspectImageFormat(head, fileName) {
  const b = Buffer.isBuffer(head) ? head : Buffer.from(head ?? '');
  const ext = path.extname(String(fileName ?? '')).toLowerCase();
  const want = IMAGE_CONTENT_TYPES[ext];
  if (!want) return { ok: false, reason: 'bad_format', detail: `扩展名 ${ext || '(无)'} 不在 png/jpeg/gif/webp 白名单` };
  let actual = '';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) actual = 'image/png';
  else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) actual = 'image/jpeg';
  else if (b.length >= 4 && b.toString('ascii', 0, 4) === 'GIF8') actual = 'image/gif';
  else if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') actual = 'image/webp';
  else return { ok: false, reason: 'bad_format', detail: '文件头不是受支持的图片格式' };
  if (actual !== want) return { ok: false, reason: 'bad_format', detail: `扩展名 ${ext} 与实际格式 ${actual} 不符` };
  return { ok: true, contentType: want };
}

/**
 * COS 的 ETag 即文件 MD5，可能带引号或弱校验前缀。
 * 拿不到合法值时回退到本地算出的整文件 md5，complete 时服务端还会
 * 与 COS 对象实际 ETag 比对，不一致返 40035003。
 */
export function etagToMd5(etag, fallback = '') {
  const v = String(etag ?? '').replace(/^W\//i, '').replace(/^"|"$/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(v) ? v : fallback;
}

/**
 * `md5_10m` 取的字节数：官方写死 10002432（约 9.54MB），不是整数 MB。
 * 这个值用于「秒传判断」，传错了服务端不会报错、只是秒传不生效。
 */
export const MD5_10M_SIZE = 10_002_432;

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
 *                      markdown / keyboard / media / card / ark / messageReference
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
    card,
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
   * 图文卡片（`msg_type=8`，官方 2026-10-28 新增，群聊/单聊都支持）。
   *
   * 放在 ark 之后是有意的：`msg_type` 是**单值**，一条消息只能有一种富文本。
   * 同时给 markdown 和 card 时以 card 为准（最后写的赢），调用方本该只给一个。
   *
   * `content` 置空照抄 markdown 那条路的做法——官方示例里 `msg_type=8`
   * 根本没有 content 字段，而 `#payload` 总会带一个 `content: ''`，
   * 留着空串跟「类型与内容不匹配」（22006）只差一步。
   */
  if (card) {
    payload.card = card;
    payload.msg_type = 8;
    payload.content = '';
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
/**
 * 哪些网络错误可以**安全重试**：连接根本没建起来的那几种。
 *
 * `fetch` 失败时只给一句 `fetch failed`，真原因在 `e.cause.code` 里。分类的
 * 依据是「请求有没有可能已经到服务端」：
 *
 *   · 连不上（ECONNREFUSED / ENOTFOUND / EAI_AGAIN / 连接超时 / 网络不可达）
 *     → 一定没发出去，重试不会造成第二条消息。
 *   · 连接被重置（ECONNRESET/EPIPE）、读超时 → **可能已经发出去了**，重试就是
 *     双发。官方被动回复每发一次占一个新的 `msg_seq`，群里会真的出现两条。
 *
 * 抽成纯函数是为了能单测：这条规则错了后果是群里刷重复消息，比少发一条更糟。
 *
 * @param {string} code
 */
export function isSafeToRetryNetworkError(code) {
  return new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  ]).has(String(code ?? ''));
}

/**
 * 取网络错误的机器码（`ECONNRESET` 这类）。取不到返回空串。
 *
 * `cause` 可能是 `AggregateError`（多地址并发连接失败时的常见形状），
 * 那时候真正的码在 `cause.errors[]` 里。
 *
 * @param {any} e
 */
export function networkCodeOf(e) {
  const cause = e?.cause;
  return String(
    cause?.code
    || cause?.errno
    || (Array.isArray(cause?.errors) ? cause.errors.find((x) => x?.code)?.code : '')
    || '',
  );
}

/**
 * 把网络错误变成一句能排障的话。
 *
 * 以前只留 `e.message`，日志里全是「网络错误 POST /v2/...: fetch failed」——
 * 断连、DNS、超时看起来一模一样，只能猜。现在带上 `cause.code`。
 *
 * @param {any} e
 */
export function networkReasonOf(e) {
  if (e?.name === 'TimeoutError') return '请求超时（15s）';
  const code = networkCodeOf(e);
  const msg = String(e?.message ?? e ?? '未知错误');
  return code ? `${msg}（${code}）` : msg;
}

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
    // 「发图带空格」兼容开关，由 BotRuntime 按 cfg.media.placeholderSpace 同步；默认关
    this.mediaPlaceholderSpace = false;
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
    /**
     * Markdown 素材图床里**本进程自己上传**的 image_id。
     *
     * 素材库是机器人级共享的，删除时默认只认这个集合里的 id，避免误删其它插件的素材。
     * 发完即删，正常情况集合是空的。这三个端点已标 `internal:true`，不进 `/api/qq/call` 白名单。
     */
    this._ownMediaImages = new Set();
    /**
     * 宿主协议显式 `retain` 的素材：要跨消息复用 `qqbot-media://` 引用，
     * 既不能发完即删，也不能被重启后的孤儿回收清掉。仍允许显式删除。
     */
    this._keptMediaImages = new Set();
    /** 孤儿素材认领，一个进程只做一次 */
    this._mediaReclaimDone = false;
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
      /**
       * 网络错误要带上**根因**。`fetch` 抛出来的永远是一句 `fetch failed`，
       * 真正的原因藏在 `e.cause` 里（`ECONNRESET` / `ENOTFOUND` /
       * `UND_ERR_CONNECT_TIMEOUT`…）。只记 message 的话，日志里全是
       * 「网络错误 POST /v2/...: fetch failed」，看不出是断连、DNS 还是超时，
       * 只能靠猜——2026-11-13 排查「发不出去」时就被这一行卡住过。
       */
      const code = networkCodeOf(e);
      const reason = networkReasonOf(e);
      /**
       * 只有「连接根本没建起来」才敢重试：那时请求一定没到服务端，重试不可能
       * 变成两条消息。`ECONNRESET` / `EPIPE` 属于「可能已经发出去、响应丢了」，
       * 一律不重试——官方被动回复每次都会占一个新的 `msg_seq`，重发就是双发。
       *
       * 这类失败最常见的原因是本机代理 / TUN 抖了一下：连上失败、下一次就好了，
       * 所以补一次重试的收益很高。
       */
      if (!retried && isSafeToRetryNetworkError(code)) {
        log.warn(`连接没建起来，重试一次：${method} ${path}（${code}）`);
        return this.#request(method, path, body, { retried: true, headers });
      }
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
   * @param {object} opts content / msgType / msgId / eventId / markdown / keyboard / media / card / ark / messageReference
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
   *
   * 三种路径，对应官方 `/files` 的三个入参：
   *   · `url`      —— URL 上传（平台自己去下载转存）
   *   · `fileData` —— 二进制直传（base64，**5MB 以内**，见 `DIRECT_UPLOAD_LIMIT`）
   *   · `uploadId` —— 分片上传的合并（分片已由 `uploadLocalFileSharded` 传完）
   *
   * @param {'group'|'c2c'} scene
   * @param {string} target group_openid 或 user openid
   * @param {object} opts { fileType, url?, fileData?(base64), uploadId?, fileName? }
   * @returns {Promise<{file_uuid:string, file_info:string, ttl:number}>}
   */
  async uploadMedia(
    scene,
    target,
    { fileType = FILE_TYPE.IMAGE, url, fileData, uploadId, fileName, reuse = true } = {},
  ) {
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
    /**
     * `file_name` **不只分片合并要**。
     *
     * 官方字段说明：「文件名（分片上传或者二进制上传时必填）」。
     * 以前只在 `upload_id` 那条路带上，于是小文件走 base64 直传时是**无名文件**——
     * QQ 客户端拿不到名字，显示出来就没有扩展名（`报告` 而不是 `报告.docx`），
     * 对方还得自己猜怎么打开。2026-11-02 线上真踩过。
     *
     * URL 上传不用带：那种路径平台自己下载转存，名字从 URL 里取。
     */
    if (fileName) body.file_name = fileName;
    /**
     * 分片合并：`upload_id` 一进，服务端就走「合并已上传分片」那条路，
     * `url` 可以为空。
     */
    if (uploadId) body.upload_id = uploadId;
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
   * 从本地文件读取并上传（**直传**，base64 整包）。
   *
   * 只适合小文件：`file_data` 官方限 5MB（`DIRECT_UPLOAD_LIMIT`），
   * 超过它请用 `uploadLocalFileSharded`——这里不偷偷分片，
   * 因为「直传」这个方法的语义就是一次请求，隐式换成十几次请求会让调用方
   * 对耗时和失败几率的预期全错。
   *
   * 带缓存：同一个文件（路径 + 大小 + 修改时间都一样）在 TTL 内不重复上传。
   */
  async uploadLocalFile(scene, target, filePath, fileType = FILE_TYPE.IMAGE) {
    let cacheKey = null;
    try {
      const st = await fs.stat(filePath);
      /**
       * 直传上限前置校验：超过 5MB 的 base64 请求体，网关会直接回
       * `413 Request Entity Too Large`（HTML，连业务错误码都没有）。
       * 在这里挡一道，报一个能看懂的错误。
       */
      if (st.size > DIRECT_UPLOAD_LIMIT) {
        const mb = (st.size / 1024 / 1024).toFixed(1);
        throw new Error(
          `${filePath} 有 ${mb}MB，超过直传上限 ${DIRECT_UPLOAD_LIMIT / 1024 / 1024}MB，请改用 uploadLocalFileSharded`,
        );
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
      if (/直传上限/.test(e?.message ?? '')) throw e;
      /* stat 失败就按无缓存走，readFile 会抛真正的错误 */
    }

    const buf = await fs.readFile(filePath);
    const up = await this.uploadMedia(scene, target, {
      fileType,
      fileData: buf.toString('base64'),
      /**
       * 二进制直传**必须带文件名**（官方字段说明：分片上传或二进制上传时必填）。
       * 少了它 QQ 侧就是个无名文件，客户端连扩展名都显示不出来。
       */
      fileName: filePath.split(/[\\/]/).pop() || 'file',
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

  /**
   * PUT 一个分片到预签名 URL。**裸 fetch，不带 QQ 的任何头。**
   *
   * 为什么不能复用 `#request`：那个方法会拼 `baseUrl + path`（预签名是绝对
   * URL）、强塞 `Content-Type: application/json`（分片是二进制）、强带
   * `Authorization: QQBot …`（预签名 URL 自带签名，多带鉴权头反而会被
   * COS 拒）、超时写死 15 秒（5MB 分片在慢网下要更久）。
   *
   * @param {string} presignedUrl 预签名上传地址
   * @param {Buffer} buf 分片二进制
   * @param {number} [timeoutMs]
   * @param {string} [contentType] 仅 Markdown 素材上传需要：必须与 prepare 声明的
   *                               content_type 完全一致，否则 COS 返 403。
   *                               分片上传**不传**，保持原来的裸 PUT 请求头不变。
   * @returns {Promise<string>} 响应头 ETag（分片调用方忽略）
   */
  async #putPart(presignedUrl, buf, timeoutMs = 60_000, contentType = '') {
    let res;
    try {
      res = await fetch(presignedUrl, {
        method: 'PUT',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Length': String(buf.length),
          ...(contentType ? { 'Content-Type': contentType } : {}),
        },
        body: buf,
      });
    } catch (e) {
      const reason = e?.name === 'TimeoutError' ? `超时（${Math.round(timeoutMs / 1000)}s）` : e.message;
      throw new Error(`分片 PUT 网络错误: ${reason}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`分片 PUT 失败 HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`);
    }
    return res.headers?.get('etag') ?? '';
  }

  /**
   * 大文件分片上传（官方推荐路径）。
   *
   * 四步（官方文档《富媒体消息概述》）：
   *   ① `upload_prepare` → upload_id / block_size / parts[] / upload_config
   *   ② 逐片 `PUT` 到 `parts[i].presigned_url`
   *   ③ 每片成功后 `upload_part_finish` 确认
   *   ④ 带 `upload_id` 调 `/files` 合并 → `file_info`
   *
   * 返回值与 `uploadLocalFile` 同形状（`{file_uuid, file_info, ttl}`），
   * 调用方不必分叉。
   *
   * **分片顺序不能乱**：`parts` 按 `index` 排序后逐片上传；并发数听
   * `upload_config.concurrency`（官方默认 1），我们上限 4——再高对
   * 5MB 一片的 COS PUT 没什么收益，反而容易触发服务端侧限流。
   *
   * @param {'group'|'c2c'} scene
   * @param {string} target
   * @param {string} filePath 本地文件
   * @param {number} fileType
   * @param {object} [opts]
   * @param {(m:string)=>void} [opts.log]
   * @returns {Promise<{file_uuid:string, file_info:string, ttl:number}>}
   */
  async uploadLocalFileSharded(scene, target, filePath, fileType = FILE_TYPE.FILE, opts = {}) {
    /**
     * `opts.log` 可能是**函数**，也可能是 `createLogger()` 那种**对象**（有 .info）。
     * 统一成函数再往下用——本机就因为这个炸过 `logFn is not a function`：
     * prepare 已经成功、图却一张没发出去，日志只有一行看不懂的类型错误。
     */
    const rawLog = opts.log;
    const logFn =
      typeof rawLog === 'function'
        ? rawLog
        : typeof rawLog?.info === 'function'
          ? (m) => rawLog.info(m)
          : () => {};

    const buf = await fs.readFile(filePath);
    if (buf.length > MEDIA_HARD_LIMIT) {
      const mb = (buf.length / 1024 / 1024).toFixed(1);
      throw new Error(`${filePath} 有 ${mb}MB，超过官方硬限制 200MB，分片也发不出去`);
    }

    const fileName = filePath.split(/[\\/]/).pop() || 'file';
    /**
     * 三个校验值官方都要：
     *   · `md5` / `sha1` 是整个文件的
     *   · `md5_10m` 是**前 10002432 字节**的（不是 10MB，官方写死的数字）
     * 算错了服务端不报错，只是秒传判断失效，所以照官方数字来。
     */
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const md5_10m = crypto.createHash('md5').update(buf.subarray(0, MD5_10M_SIZE)).digest('hex');

    const prep = await this.uploadPrepare(scene, target, {
      fileType,
      fileSize: buf.length,
      fileName,
      md5,
      sha1,
      md5_10m,
    });
    const uploadId = prep?.upload_id;
    const parts = Array.isArray(prep?.parts) ? prep.parts.slice() : [];
    if (!uploadId || !parts.length) {
      throw new Error(`upload_prepare 没返回可用的 upload_id / parts（${JSON.stringify(prep).slice(0, 200)}）`);
    }
    parts.sort((a, b) => Number(a.index) - Number(b.index));

    /**
     * 并发数：听服务端的，但不超 4。
     * `retry_timeout` / `retry_delay` 也是服务端下发的，用于 40093001 重试。
     */
    const conf = prep.upload_config ?? {};
    const concurrency = Math.max(1, Math.min(Number(conf.concurrency) || 1, 4));
    const retryTimeoutMs = Math.max(1, Number(conf.retry_timeout) || 300) * 1000;
    const retryDelayMs = Math.max(0, Number(conf.retry_delay) || 1) * 1000;
    logFn(`${fileName} ${(buf.length / 1024 / 1024).toFixed(1)}MB · ${parts.length} 片 · 并发 ${concurrency}`);

    /**
     * 每片的字节区间。**按排序后的顺序累加偏移**，不靠 `index` 当数组下标——
     * `index` 是服务端给的序号，正常情况下就是 0,1,2…，但拿它直接当
     * `parts[index]` 用，一旦服务端给的序号不连续就会切错片（内容错位、
     * 合并出来的文件是坏的，而服务端不会报错）。
     */
    const offsets = [];
    let acc = 0;
    for (const p of parts) {
      const size = Number(p.block_size) || 0;
      offsets.push({ part: p, start: acc, end: size ? acc + size : buf.length });
      acc += size;
    }

    /**
     * 单片的「PUT + 确认」，带 40093001 重试。
     *
     * `40093001`（分片转存 BDH 通道异常）是**明确可重试**的，官方给了
     * `retry_timeout`；`40093002`（日配额上限）重试一万次也没用，必须
     * 直接抛出去让上层告诉用户「今天发不了了」。
     */
    const uploadOne = async ({ part, start, end }) => {
      const idx = Number(part.index);
      const chunk = buf.subarray(start, end);
      const chunkMd5 = crypto.createHash('md5').update(chunk).digest('hex');

      let lastErr = null;
      const deadline = Date.now() + retryTimeoutMs;
      while (Date.now() < deadline) {
        try {
          await this.#putPart(part.presigned_url, chunk);
          await this.uploadPartFinish(scene, target, {
            uploadId,
            partIndex: idx,
            blockSize: chunk.length,
            md5: chunkMd5,
          });
          return;
        } catch (e) {
          lastErr = e;
          if (Number(e?.qqCode) === 40093002) throw e; // 日配额，重试无用
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
      throw new Error(`分片 ${idx} 上传失败（重试到 retry_timeout 仍不行）：${lastErr?.message ?? '未知'}`);
    };

    /**
     * 按 concurrency 分批并发。用「一批一批」而不是「维持 N 个在飞」：
     * 片数通常 3~10，分批足够，代码简单且失败位置好定位。
     */
    for (let i = 0; i < offsets.length; i += concurrency) {
      await Promise.all(offsets.slice(i, i + concurrency).map(uploadOne));
    }

    // ④ 合并
    return this.uploadMedia(scene, target, { fileType, uploadId, fileName, reuse: false });
  }

  /** 上传后再以 msg_type=7 发出（被动回复） */
  async sendMedia(scene, target, { fileType, url, fileData, msgId, messageReference }) {
    const up = await this.uploadMedia(scene, target, { fileType, url, fileData });
    if (!up?.file_info) throw new Error('上传成功但未返回 file_info');
    /**
     * **不要在这里传 content。**
     *
     * 官方字段表：`msg_type=7` 时生效的是 `media`，`content` 只在
     * `msg_type=0` 时是全文。以前这里填了一个空格占位，客户端会把
     * 它当成正文，渲染出一块空的文字区（图被挤到一侧）。
     *
     * 那个空格现在做成面板「配置 → 发图兼容」的可选开关（默认关）：
     * 打开后由 `#payload()` 在最终报文里补，这里依旧不带 content，
     * 免得开关关着时又冒出空格、开着时补两遍。
     */
    const opts = {
      msgType: 7,
      media: { file_info: up.file_info },
      msgId,
      messageReference,
    };
    return scene === 'group' ? this.sendGroup(target, opts) : this.sendC2C(target, opts);
  }

  /* ---------------- Markdown 素材图床（机器人级） ---------------- */

  /**
   * 与 `/v2/{groups,users}/{openid}/files` 是**两套体系**：
   * 那边返回绑定会话的 `file_info`，只能喂 `msg_type=7` 的 `media`；
   * 这边返回 `qqbot-media://` 引用，绑定机器人、跨群跨单聊可复用，
   * 是 Markdown（`msg_type=2`）里插本地图的唯一方式。
   *
   * 官方流程：prepare → 裸 PUT 到预签名 URL → complete → 引用 → 删除。
   * 本框架的策略是「自产自销、发完即删」：不建持久化缓存、不做 LRU 淘汰、
   * 不列全量素材，配额常驻接近 0，代价是同一张图每次重传。
   */

  /**
   * 把「本进程已创建、但还没删掉」的 image_id 落盘。
   *
   * 正常流程 complete → send → delete 之间只有几秒；但进程若恰好在这段
   * 时间崩了，内存里的 `_ownMediaImages` 就没了，素材成了孤儿，攒满官方
   * 100 张配额之后所有预上传都会失败。落一个极小的 JSON，下次进程第一次
   * 上传时认领并删掉，配额就不会被崩溃残留慢慢吃掉。
   */
  async #persistOwnMedia() {
    try {
      await fs.mkdir(path.dirname(OWN_MEDIA_FILE), { recursive: true });
      await fs.writeFile(OWN_MEDIA_FILE, JSON.stringify([...this._ownMediaImages]), 'utf8');
      await fs.writeFile(KEPT_MEDIA_FILE, JSON.stringify([...this._keptMediaImages]), 'utf8');
    } catch (e) {
      log.warn(`Markdown 素材归属记录写失败（不影响本次发送）: ${e.message}`);
    }
  }

  /**
   * 进程内只跑一次：认领上次崩溃留下的孤儿素材并删除，同时加载保留清单。
   * 保留清单只读不删——否则宿主缓存的 qqbot-media:// 引用会在框架重启后静默失效。
   */
  async #reclaimOrphanMediaImages() {
    if (this._mediaReclaimDone) return;
    this._mediaReclaimDone = true;
    try {
      const kept = JSON.parse(await fs.readFile(KEPT_MEDIA_FILE, 'utf8'));
      if (Array.isArray(kept)) {
        for (const raw of kept) {
          const id = String(raw ?? '');
          if (id) this._keptMediaImages.add(id);
        }
      }
    } catch {
      // 没有记录文件 / 内容损坏，都当空清单
    }
    let ids;
    try {
      ids = JSON.parse(await fs.readFile(OWN_MEDIA_FILE, 'utf8'));
    } catch {
      return; // 没有记录文件 / 内容损坏，都当没有孤儿
    }
    if (!Array.isArray(ids) || !ids.length) return;
    for (const raw of ids) {
      const id = String(raw ?? '');
      if (!id) continue;
      try {
        await this.#request('DELETE', `/v2/media-images/${enc(id)}/delete`);
      } catch (e) {
        // 可能已被平台回收或已删过：留到下次再试，不阻断本次发送
        log.warn(`孤儿素材清理失败 image_id=${id}: ${e.message}`);
        this._ownMediaImages.add(id);
      }
    }
    await this.#persistOwnMedia();
  }

  /**
   * GET /v2/media-images?cursor={next_cursor}
   *
   * 官方的机器人级素材清单，按上传时间倒序。用它看剩余配额（上限 100 张）、
   * 找可复用的 qqbot-media:// 引用、定位要删除的 image_id。
   * 返回字段统一转 camelCase；`previewUrl` 是短时效预签名链接，别持久化。
   */
  async listMediaImages({ cursor = '' } = {}) {
    const q = new URLSearchParams();
    const c = String(cursor ?? '').trim();
    if (c) q.set('cursor', c);
    const suffix = q.toString();
    const r = await this.#request('GET', `/v2/media-images${suffix ? `?${suffix}` : ''}`);
    const images = (Array.isArray(r?.images) ? r.images : []).map((it) => ({
      imageId: String(it?.image_id ?? ''),
      url: String(it?.url ?? ''),
      fileName: String(it?.file_name ?? ''),
      previewUrl: String(it?.preview_url ?? ''),
      createdAt: Number(it?.created_at) || 0,
      expiresAt: Number(it?.expires_at) || 0,
    }));
    return {
      images,
      nextCursor: String(r?.next_cursor ?? ''),
      total: Number(r?.total) || 0,
      quota: MEDIA_IMAGE_QUOTA,
    };
  }

  /** POST /v2/media-images/prepare */
  prepareMediaImage({ fileName, fileSize, contentType, md5, sha1 } = {}) {
    return this.#request('POST', '/v2/media-images/prepare', {
      file_name: String(fileName ?? ''),
      file_size: Number(fileSize) || 0,
      content_type: String(contentType ?? ''),
      md5: String(md5 ?? ''),
      sha1: String(sha1 ?? ''),
    });
  }

  /**
   * POST /v2/media-images/complete；md5 取 COS 的 ETag（去引号）。
   * `retain:true` 的素材归到 kept（跨消息复用），其余归 own（发完即删）。
   */
  async completeMediaImage({ uploadId, md5 } = {}, { retain = false } = {}) {
    const r = await this.#request('POST', '/v2/media-images/complete', {
      upload_id: String(uploadId ?? ''),
      md5: String(md5 ?? ''),
    });
    // 凡经本 QQApi 创建的素材都算「自己人」，记下来供 finally 清理 / 配额管理
    if (r?.image_id) {
      const id = String(r.image_id);
      if (retain) {
        this._keptMediaImages.add(id);
        this._ownMediaImages.delete(id);
      } else {
        this._ownMediaImages.add(id);
      }
      await this.#persistOwnMedia();
    }
    return r;
  }

  /**
   * DELETE /v2/media-images/{image_id}/delete
   *
   * 删除后引用立即失效，但**已发出的消息不受影响**（平台发送时已转存副本）。
   * 默认只接受本进程创建（own / kept）的 image_id，避免误删其它插件的素材。
   *
   * `allowUnowned` 是给「清理机器人级配额」用的受控入口：调用方必须先用
   * `listMediaImages()` 确认 id 确实属于本机器人，且是用户显式确认的删除。
   * 宿主协议 `media.image.delete` 会先查列表再传它，面板路径不给这个开关。
   */
  async deleteMediaImage(imageId, { allowUnowned = false } = {}) {
    const id = String(imageId ?? '');
    if (!id) throw new Error('deleteMediaImage 需要 image_id');
    const known = this._ownMediaImages.has(id) || this._keptMediaImages.has(id);
    if (!known && !allowUnowned) {
      throw new Error(`拒绝删除非本进程上传的素材 ${id}（素材库是机器人级共享，可能属于其它插件）`);
    }
    const r = await this.#request('DELETE', `/v2/media-images/${enc(id)}/delete`);
    this._ownMediaImages.delete(id);
    this._keptMediaImages.delete(id);
    await this.#persistOwnMedia();
    return r;
  }

  /**
   * 把**图片字节**上传成 Markdown 可用的 `qqbot-media://` 引用。
   *
   * 三个本地预检都在这一层：>10MB / 扩展名不在白名单 / 文件头与扩展名不符。
   * 官方只校验「扩展名 ↔ content_type」、不校验实际内容，坏图会一路成功到发消息
   * 才失败（注意事项第 5 条）。跨进程调用尤其要在这里挡住：宿主给的 fileName
   * 决定 content_type，随便落成 .png 会让 jpeg/gif/webp 被 COS 或 40035001 拒。
   *
   * @param {Buffer} buf 图片原始字节
   * @param {{fileName?:string, retain?:boolean}} opts
   */
  async #pushMarkdownImageBytes(buf, { fileName = '', retain = false } = {}) {
    const name = String(fileName ?? '').split(/[\\/]/).pop() || 'image.png';
    if (!Buffer.isBuffer(buf) || !buf.length) {
      const e = new Error('uploadMarkdownImage 需要非空图片字节');
      e.reason = 'outside';
      throw e;
    }
    if (buf.length > MEDIA_IMAGE_MAX) {
      const e = new Error(`图片有 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过 Markdown 素材 10MB 上限`);
      e.reason = 'oversize';
      throw e;
    }
    const fmt = inspectImageFormat(buf.subarray(0, 16), name);
    if (!fmt.ok) {
      const e = new Error(fmt.detail);
      e.reason = fmt.reason;
      throw e;
    }
    const contentType = fmt.contentType;
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');

    const prep = await this.prepareMediaImage({
      fileName: name, fileSize: buf.length, contentType, md5, sha1,
    });
    const uploadId = prep?.upload_id;
    const presignedUrl = prep?.presigned_url;
    if (!uploadId || !presignedUrl) {
      const e = new Error('media-images/prepare 未返回 upload_id / presigned_url');
      e.reason = 'internal';
      throw e;
    }

    const etag = await this.#putPart(presignedUrl, buf, 60_000, contentType);
    const done = await this.completeMediaImage({ uploadId, md5: etagToMd5(etag, md5) }, { retain });
    if (!done?.image_id || !done?.url) {
      const e = new Error('media-images/complete 未返回 image_id / url');
      e.reason = 'internal';
      throw e;
    }
    return {
      imageId: String(done.image_id),
      url: String(done.url),
      ttl: done.ttl,
      previewUrl: String(done.preview_url ?? ''),
      fileName: name,
      retained: Boolean(retain),
    };
  }

  /**
   * 跨进程入口：宿主协议 / 外部调用方手上的是字节，不是框架本机的路径。
   * `retain:true` 的素材不会被孤儿回收清掉，用完请调 `deleteMediaImage()` 释放配额。
   *
   * @returns {Promise<{imageId:string,url:string,ttl:number,previewUrl:string,fileName:string,retained:boolean}>}
   */
  async uploadMarkdownImageBytes(buf, { fileName = '', retain = false } = {}) {
    await this.#reclaimOrphanMediaImages();
    try {
      return await this.#pushMarkdownImageBytes(buf, { fileName, retain });
    } catch (e) {
      if (!e.reason) e.reason = 'internal';
      throw e;
    }
  }

  /**
   * 把一张**本地**图上传成 Markdown 可用的 `qqbot-media://` 引用。
   * 框架不校验路径所属目录：调用方是可信的插件代码，路径由它把关。
   * 保留原有的 `reason` 分类（outside / oversize / bad_format / internal），
   * `message.js` 的 replyAuto 靠它决定降级文案。
   *
   * @param {string} filePath 本地文件路径（绝对或 cwd 相对）
   */
  async uploadMarkdownImage(filePath) {
    await this.#reclaimOrphanMediaImages();
    const p = String(filePath ?? '');
    if (!p) {
      const e = new Error('uploadMarkdownImage 需要本地文件路径');
      e.reason = 'outside';
      throw e;
    }
    let buf;
    try {
      const st = await fs.stat(p);
      if (st.size > MEDIA_IMAGE_MAX) {
        const e = new Error(`${p} 有 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过 Markdown 素材 10MB 上限`);
        e.reason = 'oversize';
        throw e;
      }
      buf = await fs.readFile(p);
    } catch (e) {
      if (!e.reason) {
        e.reason = /ENOENT|EACCES|EPERM|ENOTDIR/.test(`${e?.code ?? ''} ${e?.message ?? ''}`)
          ? 'outside'
          : 'internal';
      }
      throw e;
    }
    try {
      return await this.#pushMarkdownImageBytes(buf, { fileName: p.split(/[\\/]/).pop() });
    } catch (e) {
      if (!e.reason) e.reason = 'internal';
      throw e;
    }
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

  /**
   * 「发图带空格」开关。由 BotRuntime 按 cfg.media.placeholderSpace 初始化，
   * 面板改动时由 /api/config 同步进来，立即生效、不用重启。
   *
   * 只认布尔 true：`"false"` / `0` / `undefined` 一律当关。
   * 面板配置走 HTTP，字符串 "false" 按真值判断会被读成「开」——
   * security.trust.enforce 踩过这个坑，这里不重犯。
   */
  setMediaPlaceholderSpace(v) {
    this.mediaPlaceholderSpace = v === true;
    return this.mediaPlaceholderSpace;
  }

  /** 内邀接口的统一闸门。没开门就抛错，别把请求发出去刷一屏 11253 */
  #needInvite() {
    if (!this.groupInvited) {
      throw new Error(
        '群管内邀功能未开启。群成员列表 / 踢人 / 群黑名单需要官方白名单，' +
          '申请通过后到 Roost 面板（浏览器打开的那个）「配置 → 群管能力」打开',
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
    if (p.msgId) {
      payload.msg_id = p.msgId;
      /**
       * `msg_seq` 必须显式给，而且**所有分片用同一个值**。
       *
       * 流式消息是「一条消息在长」，不是多条——官方示例里首片、续片、结束片
       * 都是同一个 `msg_seq`。不传的话服务端按 1 处理，而我们自己的普通回复
       * 也从 1 开始递增，于是「先流式、再发图/文件」会撞
       * `40054005 消息被去重`。
       *
       * 取值由调用方先算好传进来（`replyStream` 会在首片前调 `takeSeq`）。
       */
      if (p.msgSeq != null) payload.msg_seq = Number(p.msgSeq);
      else payload.msg_seq = this.#nextSeq(p.msgId);
    }
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

  /**
   * 先占一个 `msg_seq`，供流式消息这种「一条消息发好几次」的场景用。
   *
   * 为什么要有：流式接口不走 `#payload`，所以以前完全不占序号——首片按默认 1 算，
   * 而我们自己后续的普通回复也从 1 开始递增，两边撞上就是
   * `40054005 消息被去重`（用户那边表现为「发了但没出现」）。
   * 流式所有分片共用这一个值（一条消息一个序号）。
   */
  takeSeq(msgId) {
    return this.#nextSeq(msgId);
  }

  #payload(opts) {
    const payload = buildSendPayload(opts, (id) => this.#nextSeq(id));
    /**
     * 「发图带空格」兼容开关（默认关，面板「配置 → 发图兼容」）。
     *
     * 放在最终报文这一层，是为了**一处覆盖所有发图路径**：
     * msg.replyImage / replyImageBuffer、api.sendMedia、插件拿到的
     * ctx.api.sendMedia、以及没有调度器时的 api.sendGroup 兜底，最后都过这里。
     * 放在 outbound 或 message 层都会漏，还会污染投递账本的正文摘要
     * （账本把纯空格当「没有正文」，测试也断言富媒体不带 content）。
     *
     * 只补「没有正文的富媒体」：
     *   · msg_type=7 且 content 为空 —— 老版就是在这里塞 ' '
     *   · 有 text 的图文混排不动，markdown(2) / ark(3) / 卡片(8) 也不动
     */
    if (this.mediaPlaceholderSpace && payload.msg_type === 7 && !payload.content) {
      payload.content = ' ';
    }
    return payload;
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
