/**
 * 入账前的正文清洗。
 *
 * ## 为什么要在入账时洗，而不是展示时洗
 *
 * 账本以前存原文，面板打开时临时洗一遍（`web/server.js` 的
 * `ledgerDisplayContent`）。问题是账本的读者不止面板：
 *
 *   · dsh-roost 的 `textOf` 读账本拼「刚才说到」，标签会原样进模型上下文；
 *   · `chat_look` 翻记录、`/api/ledger/search` 检索，搜出来都是尖括号；
 *   · 导出 JSONL 给人看，一屏 `eyJ0ZXh0Ijoi…`。
 *
 * 每一处各写一份清洗规则，迟早分叉。所以把「洗」提前到写库那一刻，
 * 原文另存 `content_raw`（只在真的有差异时才写，绝大多数行是空串）。
 *
 * ## 只清已知标签，不碰其它尖括号
 *
 * 真实账本里出现过的标记只有三类（`<ID>` `<case>` 那种是用户自己聊代码打出来的，
 * 必须原样保留，否则账本就不可信了）：
 *
 *   `<faceType=1,faceId="187",ext="eyJ0ZXh0Ijoi5bm954G1In0=">`  平台表情
 *   `<qqbot-cmd-input text="%2Fping" show="%2Fping" />`        框架菜单按钮
 *   `<qqbot-at-user id="…" />`                                   at 某人
 *
 * 表情的 `ext` 是 base64 的 `{"text":"憨笑"}`，能解出当时的文本描述——
 * 那比 `[表情]` 可读得多，面板和模型都受益。解不出就退 `[表情]`。
 */

/** 属性值提取。只认双引号——官方报文和 `markdown.js` 都只用双引号 */
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return m ? m[1] : '';
}

/** 百分号解码。畸形编码原样返回，不能因为一个属性把整条正文清空 */
function unesc(s) {
  const v = String(s ?? '');
  if (!v.includes('%')) return v;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * 表情标记 → `[表情:憨笑]` / `[表情]`。
 *
 * `ext` 是 `eyJ0ZXh0Ijoi..."` 这种 base64，内容是 `{"text":"憨笑"}`。
 * 解析失败（平台换格式 / 空 ext）就退回不带名字的占位——宁可少个名字，
 * 也不能把整条消息判空。
 */
function faceLabel(tag) {
  const ext = attr(tag, 'ext');
  if (ext) {
    try {
      const j = JSON.parse(Buffer.from(ext, 'base64').toString('utf8'));
      const t = String(j?.text ?? '').replace(/\s+/g, ' ').trim();
      if (t) return `[表情:${t.slice(0, 8)}]`;
    } catch { /* 解码失败走下面的兜底 */ }
  }
  return '[表情]';
}

/** markdown 图片的说明里常带尺寸位（`卡面 #480px #240px`），剥掉 */
function imageLabel(alt) {
  const a = String(alt ?? '').replace(/#\s*\d+px/gi, '').trim();
  return a ? `[图片:${a.slice(0, 20)}]` : '[图片]';
}

/**
 * 正文清洗。
 *
 * 处理顺序有讲究：**先图、后按钮、最后表情**。图片的正则要吃掉整个
 * `![…](…)`，如果先替换表情，URL 里恰好出现的尖括号会被拆坏。
 *
 * @param {unknown} raw 账本原文（`msg.content`）
 * @returns {string} 可读文本。原文没有已知标记时**原样返回**，一个字符都不动。
 */
export function ledgerTextOf(raw) {
  let s = String(raw ?? '');
  if (!s) return '';

  /** `![说明 #480px #240px](qqbot-media://…)` → `[图片:说明]` */
  s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt) => imageLabel(alt));

  /** 菜单按钮：`show` 是给人看的（已解码），`text` 是真正会发出去的指令 */
  s = s.replace(/<qqbot-cmd-input\b[^>]*>/gi, (tag) => unesc(attr(tag, 'show') || attr(tag, 'text')));
  s = s.replace(/<qqbot-cmd-enter\b[^>]*>/gi, (tag) => unesc(attr(tag, 'text')));

  /** at 某人：报文里只有 openid，账本里没有反查，标个 `@` 就够 */
  s = s.replace(/<qqbot-at-user\b[^>]*>/gi, '@');

  /** 表情：先换名字，再清掉可能残留的空标签 */
  s = s.replace(/<faceType=[^>]*>/gi, (tag) => faceLabel(tag));

  /**
   * 清完可能剩一串空白（纯标签消息）。`trim` 只动两端，
   * 中间的换行要留着——多段正文靠它分行。
   */
  return s.trim();
}

/**
 * 这条消息有没有可显示的内容。
 *
 * 清洗后为空的常见情况：纯图片、纯语音、纯文件。这种行在账本里不能是空串，
 * 否则面板是一行空白、`chat_look` 也看不出「他发了张图」。
 *
 * 口径与 `bot.js` 的 `describeForLog` 保持一致（那边是给日志用的，这边给账本），
 * 但**不抄它的全部文案**：账本是长期档案，占位越短越好。
 *
 * @param {object} msg `buildMessage()` 产物或出站 `{attachments}`
 * @returns {string} 有内容时返回空串
 */
export function placeholderOf(msg) {
  const atts = Array.isArray(msg?.attachments) ? msg.attachments : [];
  const has = (t) => atts.some((a) => a?.type === t);
  if (has('image')) return '[图片]';
  if (has('voice')) {
    const asr = atts.find((a) => a?.type === 'voice' && a?.asrText)?.asrText;
    return asr ? `[语音:${String(asr).slice(0, 40)}]` : '[语音]';
  }
  if (has('video')) return '[视频]';
  if (has('file')) {
    const name = atts.find((a) => a?.type === 'file' && a?.filename)?.filename;
    return name ? `[文件:${String(name).slice(0, 40)}]` : '[文件]';
  }
  if (has('other')) return '[表情]';
  if (msg?.ark && typeof msg.ark === 'object') {
    const t = String(msg.ark.title ?? msg.ark.desc ?? '').trim();
    return t ? `[卡片:${t.slice(0, 30)}]` : '[卡片]';
  }
  if (Array.isArray(msg?.elements) && msg.elements.length) return '[合并转发]';
  return '';
}
