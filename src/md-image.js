/**
 * markdown 图片的尺寸补全。
 *
 * ## 为什么必须有
 *
 * QQ 的 markdown 图片语法是 `![说明 #宽px #高px](url)`，**尺寸位不能省**。
 * 2026-11-22 实测（单聊，同一条消息两个变量对照）：
 *
 * | 写法 | 手机端 |
 * |---|---|
 * | `![图1](qqbot-media://…)` | **不显示**，只剩文字 |
 * | `![#480px #240px](qqbot-media://…)` | 正常显示 |
 * | `![图1 #480px #240px](qqbot-media://…)` | 正常显示 |
 *
 * 也就是说：只看尺寸，跟 alt 有没有内容无关。以前正文里写的是
 * `![](url)`（空 alt、无尺寸），平台照收 200，只是**不渲染图**——
 * 发的人和收的人都只看到"图没出来"，日志里连一条警告都没有。
 *
 * ## 尺寸从哪来
 *
 * 官方的素材接口（`/v2/media-images`）**不回宽高**，只给
 * `image_id / url / file_name / preview_url`。所以只能在上传那一刻
 * 从本地字节里读——那时候图还在手上，读文件头就够了。
 *
 * 这也是为什么补尺寸放在框架侧：上传和发送都在框架里，中间不经过任何人，
 * 图从字节变成引用再变成正文，宽高一次都不用丢。
 *
 * ## 读不出来的怎么办
 *
 * 原样放过，不猜比例。压扁/拉长的图比没有图更难看出是哪里错了。
 * 能读的四种（png / jpeg / gif / webp）正好是 `IMAGE_CONTENT_TYPES`
 * 白名单的全部，正常流程里不会走到这个分支。
 */

/**
 * 从字节里读宽高。
 *
 * @param {Buffer|null} buf 文件头（前 64KB 足够；JPEG 要扫到 SOF 段）
 * @returns {{w:number,h:number}} 读不出时两项都是 0
 */
export function dimsOf(buf) {
  if (!buf || buf.length < 24) return { w: 0, h: 0 };
  /** PNG：89 50 4E 47，IHDR 的宽高在 16 / 20，大端 */
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  /** GIF：GIF8，逻辑屏幕描述符在 6 / 8，小端 */
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  /** JPEG：扫到 SOF0/SOF2 才拿到宽高（段里高在前、宽在后） */
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  /** WebP：RIFF....WEBP + 变体标记 */
  if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
    }
  }
  return { w: 0, h: 0 };
}

/**
 * 正文里最多写多宽。
 *
 * 写原尺寸的话，一张 2560×1600 的截图会在手机上占两三屏，把一段话挤散。
 * 缩到 480 宽既看得清又不喧宾夺主；比 480 小的图走 `Math.min`，不会被放大。
 */
export const INLINE_MAX_WIDTH = 480;

/**
 * 拼尺寸后缀：` #480px #270px`。
 *
 * @param {{w:number,h:number}} d
 * @returns {string} 读不出宽高时是空串
 */
export function sizeSuffix(d) {
  const w0 = Math.floor(Number(d?.w) || 0);
  const h0 = Math.floor(Number(d?.h) || 0);
  if (w0 <= 0 || h0 <= 0) return '';
  const w = Math.min(w0, INLINE_MAX_WIDTH);
  const h = Math.max(1, Math.round((h0 * w) / w0));
  return ` #${w}px #${h}px`;
}

/** 图片语法的 alt 位里，已经写了几个 `#数字px` */
const SIZE_TOKEN = /#\s*\d{1,5}\s*(?:px)?/g;
/** 只认单行的图片语法；URL 里不会有空格，`[^\s)]` 足够 */
const MD_IMAGE = /!\[([^\]\n]*)\]\(([^)\s]+)\)/g;
/** 代码块原样保留：里面的 `![]()` 是要给人看的语法，补尺寸反而改坏了 */
const FENCE = /(```[\s\S]*?```)/g;

/**
 * 把一段正文按行内代码切开：`{code:true}` 的片段原样放过。
 *
 * 为什么不能只靠 `FENCE`：围栏块之外的**行内反引号**同样是在"讲语法"
 * （`对话里说「用 \`![](url)\` 就能发图」`），2026-11-22 自检实测旧实现会把
 * 里面的示例改写成 `![图片 #480px #270px](url)`，等于改坏了别人要看的文字。
 *
 * 反引号串必须**等长配对**（`` `a` `` / ``` ``a`b`` ```），这是 CommonMark 的
 * 规则；找不到收尾就按普通字符处理。跨行不当代码：真跨行的行内代码极少，
 * 而漏配一次就会把后面的图一起吞掉——**图补不上尺寸就发不出来**，代价更大。
 *
 * @param {string} seg 已排除围栏块的一段正文
 * @returns {Array<{code:boolean, text:string}>}
 */
function splitInlineCode(seg) {
  const parts = [];
  let i = 0;
  let from = 0;
  while (i < seg.length) {
    if (seg[i] !== '`') { i += 1; continue; }
    let n = 0;
    while (seg[i + n] === '`') n += 1;
    let j = i + n;
    let close = -1;
    while (j < seg.length) {
      if (seg[j] === '\n') break;
      if (seg[j] !== '`') { j += 1; continue; }
      let m = 0;
      while (seg[j + m] === '`') m += 1;
      if (m === n) { close = j; break; }
      j += m;
    }
    if (close < 0) { i += n; continue; }
    if (from < i) parts.push({ code: false, text: seg.slice(from, i) });
    parts.push({ code: true, text: seg.slice(i, close + n) });
    i = close + n;
    from = i;
  }
  if (from < seg.length) parts.push({ code: false, text: seg.slice(from) });
  return parts;
}

/**
 * 给正文里缺尺寸的 markdown 图片补上 `#宽px #高px`。
 *
 * 三条规则：
 *   1. 已经带两个尺寸位的**不动**（作者显式写的优先，我们只兜底）；
 *   2. 拿不到宽高的**不动**（不猜比例）；
 *   3. alt 为空时补一个占位说明——`![ #480px #240px]` 这种写法官方示例里没有，
 *      填个字更稳，也不会在图上多显示什么东西。
 *
 * 围栏块（```）和行内反引号里的内容都原样保留，见 `splitInlineCode`。
 *
 * @param {string} text markdown 正文
 * @param {(url:string)=>{w:number,h:number}|undefined} lookup 按引用串查宽高
 * @returns {string}
 */
export function normalizeMarkdownImages(text, lookup) {
  if (typeof text !== 'string' || !text.includes('![') || typeof lookup !== 'function') return text;
  const fill = (seg) => seg.replace(MD_IMAGE, (m, alt, url) => {
    const had = String(alt).match(SIZE_TOKEN) ?? [];
    if (had.length >= 2) return m;
    const suffix = sizeSuffix(lookup(url));
    if (!suffix) return m;
    const name = String(alt).trim() || '图片';
    return `![${name}${suffix}](${url})`;
  });
  return String(text)
    .split(FENCE)
    .map((seg, i) => {
      /** split 带捕获组：奇数下标是代码块 */
      if (i % 2) return seg;
      return splitInlineCode(seg).map((p) => (p.code ? p.text : fill(p.text))).join('');
    })
    .join('');
}
