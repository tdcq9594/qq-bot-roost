/**
 * QQ 小黄脸 —— 名字标记 ↔ 协议表情。
 *
 * ## 为什么放在框架里
 *
 * 这件事和「发一张图」「发一条 markdown」是同一层的能力，不是某个插件的私事：
 *
 *   · 每个插件都要用（聊天、运势、抽卡、群管回执……）；
 *   · 码表只有一份才对得上（插件各抄一份，抄错一位就变成乱码）；
 *   · 入站要**看得懂**别人发的表情，出站要**发得出**自己的表情，两头必须同一张表。
 *
 * 以前这套东西长在 dsh-roost 插件里，后果是「插件里有、框架里没有」，
 * 换个插件写 `【表情: 微笑】` 就发成五个中文字。
 *
 * ## 语法（对插件和模型都只有这一条）
 *
 *     正文里写 `【表情: 微笑】`（全角/半角冒号都认）
 *
 * 出站前换成 `0x14 + faceId` 两个字符。这是 QQ 客户端原生认的表情编码，
 * 和「发图片」不是一回事：它不占富媒体额度、不需要上传、跟着文字一起走。
 *
 * ## 三个必须知道的坑
 *
 * 1. **id 不能猜**。这份 id 是**协议 faceId**，不是表情面板里的顺序号。
 *    老表把「惊讶」写成 33、「流汗」写成 2，发出去客户端找不到就整段丢弃，
 *    看起来像"发了但没显示"。表数据与校验方式见 `table.js` 头注释。
 *
 * 2. **名字不认识要删掉，不能原样发**。`【表情: 不存在的脸】` 进了群，
 *    用户看到的是括号加中文，比不发更难看。默认 `unknown: 'drop'`。
 *
 * 3. **入站标签要翻译**。QQ 推过来的是
 *    `<faceType=1,faceId="187",ext="eyJ0ZXh0Ijoi5bm954G1In0=">`，
 *    模型看不懂、还白占十几个 token。转成 `【表情: 幽灵】` 之后它才能接话。
 *    `ext` 里是官方给的 base64 名字，**优先用它**——那是权威来源，
 *    表里没有的新表情也能认出名字。
 *
 * @module faces
 */

import { FACE_TABLE, FACE_ALIASES } from './table.js';

/** 表情编码前缀。`0x14` 是 QQ 私有协议里"后面跟一个表情 id"的标记。 */
export const FACE_PREFIX = 0x14;

/** 名字 → id（含别名） */
const BY_NAME = new Map();
/** id → 主名 */
const BY_ID = new Map();

for (const [name, id] of Object.entries(FACE_TABLE)) {
  BY_NAME.set(name, id);
  // 同一个 id 只留第一个名字当主名（表里已经按 id 升序、且去过重）
  if (!BY_ID.has(id)) BY_ID.set(id, name);
}
for (const [oldName, curName] of Object.entries(FACE_ALIASES)) {
  const id = FACE_TABLE[curName];
  if (id !== undefined) BY_NAME.set(oldName, id);
}

/** 名字一次最多这么长（最长的现行名字 4 个字，留余量给将来的） */
const NAME_MAX = 24;

/** `【表情: 微笑】` / `【表情：微笑】` */
const MARK_RE = /【表情\s*[:：]\s*([^】]{1,24}?)】/g;

/** 收尾：截断留下的半截标记（`【表情: 微`），只可能是最后一段 */
const PARTIAL_RE = /【表情[^】]*$/;

/** `0x14` + 一个码元 */
const CHAR_RE = /\u0014([\s\S])/g;

/** 官方入站格式：`<faceType=1,faceId="187",ext="…">` */
const TAG_RE = /<faceType=(\d+),faceId="(\d+)"(?:,ext="([^"]*)")?\s*\/?>/g;

/**
 * 名字 → 协议 faceId。老名字走别名表。
 *
 * @param {string} name
 * @returns {number|undefined} 不认识返回 undefined（调用方决定删还是留）
 */
export function lookupFace(name) {
  const n = String(name ?? '').trim();
  if (!n) return undefined;
  return BY_NAME.get(n);
}

/**
 * 协议 faceId → 名字。
 *
 * @param {number} id
 * @returns {string} 不认识返回空串（不编"未知表情 123"这种半成品）
 */
export function faceNameOf(id) {
  return BY_ID.get(Number(id)) ?? '';
}

/**
 * 全部表情，按 id 升序。给面板、诊断和提示词用。
 *
 * @returns {Array<{id:number,name:string}>}
 */
export function faceList() {
  return [...BY_ID.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, name]) => ({ id, name }));
}

/** 表里有多少个名字（主名，不含别名） */
export function faceCount() {
  return BY_ID.size;
}

/**
 * 把正文里的 `【表情: 名字】` 换成协议表情字符。
 *
 * 幂等：已经编好的正文里没有 `【表情`，再调一次原样返回。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {(name:string)=>void} [opts.onMiss] 名字不认识时回调（记日志/诊断用）
 * @param {'drop'|'keep'} [opts.unknown='drop'] 不认识的名字：删标记 / 原样保留
 * @returns {string}
 */
export function encodeFaces(text, opts = {}) {
  const s = String(text ?? '');
  if (!s || !s.includes('【表情')) return s;
  const unknown = opts.unknown === 'keep' ? 'keep' : 'drop';
  const onMiss = typeof opts.onMiss === 'function' ? opts.onMiss : null;

  return s
    .replace(MARK_RE, (whole, rawName) => {
      const name = String(rawName ?? '').trim().slice(0, NAME_MAX);
      const id = lookupFace(name);
      if (id === undefined) {
        if (onMiss) {
          try { onMiss(name); } catch { /* 诊断回调不许把发送带崩 */ }
        }
        return unknown === 'keep' ? whole : '';
      }
      return String.fromCharCode(FACE_PREFIX, id);
    })
    .replace(PARTIAL_RE, '');
}

/**
 * 把正文里的 `【表情: 名字】` 标记**全部删掉**，不做编码。
 *
 * 用在「这条消息不能带表情」的场合：
 *   · markdown 通道（会吞控制字符，见 `api.js` 的 `applyFaceEncoding`）；
 *   · 正文里已经有图 / 卡片（一条消息只能有一种富文本）；
 *   · `faces.mode: 'keep'`（用户要排版优先）。
 *
 * 为什么不复用 `encodeFaces(text, { unknown: 'drop' })`：那个对**认识**的名字
 * 会编成控制字符，正是不想要的。这里不管认识不认识，一律删干净。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFaceMarks(text) {
  const s = String(text ?? '');
  if (!s || !s.includes('【表情')) return s;
  return s.replace(MARK_RE, '').replace(PARTIAL_RE, '');
}

/**
 * 把协议表情字符还原成 `【表情: 名字】`。
 *
 * 认不出的 id **原样保留**：宁可留一个不可见字符，也别把正文吃掉。
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeFaceChars(text) {  const s = String(text ?? '');
  if (!s || s.indexOf('\u0014') < 0) return s;
  return s.replace(CHAR_RE, (whole, ch) => {
    const name = faceNameOf(ch.charCodeAt(0));
    return name ? `【表情: ${name}】` : whole;
  });
}

/**
 * 从官方 `ext` 里取名字。
 *
 * `ext` 是 `base64(JSON)`，形如 `eyJ0ZXh0Ijoi5bm954G1In0=` → `{"text":"幽灵"}`。
 * 官方给的这是**权威名字**，比我们表里查 id 更可信（新表情也能认出来），所以优先用。
 *
 * 校验放得比较松（中文 / 字母数字 / 少量符号），但长度卡在 12：
 * 它只该是个表情名，不该是一整句话——万一收到构造过的 ext，别让它把正文撑爆。
 *
 * @param {string} b64
 * @returns {string} 取不到返回空串
 */
function nameFromExt(b64) {
  if (!b64 || b64.length > 512) return '';
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const text = String(JSON.parse(json)?.text ?? '').trim();
    if (!text || text.length > 12) return '';
    return /^[\u4e00-\u9fa5A-Za-z0-9+/!！·_-]+$/.test(text) ? text : '';
  } catch {
    return '';
  }
}

/**
 * 把官方入站的表情标签翻成 `【表情: 名字】`。
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeFaceTags(text) {
  const s = String(text ?? '');
  if (!s || !s.includes('<faceType')) return s;
  return s.replace(TAG_RE, (whole, _faceType, idStr, ext) => {
    const name = nameFromExt(ext) || faceNameOf(Number(idStr));
    return name ? `【表情: ${name}】` : whole;
  });
}

/**
 * 入站统一入口：官方标签 + 控制字符两种形态都翻成人话。
 *
 * 任何一种翻不出来都保留原文，**绝不抛**——这条路上抛一次就是吞掉一条消息。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeInbound(text) {
  const s = String(text ?? '');
  if (!s) return s;
  try {
    return decodeFaceChars(decodeFaceTags(s));
  } catch {
    return s;
  }
}
