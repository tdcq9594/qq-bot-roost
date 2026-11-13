/**
 * OneBot 消息段 → 官方报文
 * =========================
 *
 * 官方一条消息只能有一种富文本（`msg_type` 是单值），所以「一段文字 + 两张图」
 * 在 OneBot 里是一条，在官方接口里必然是三条。这里只负责**拆**：
 *
 *   { text, reference, images[] }
 *
 * 由 actions.js 按顺序发出去（第一条带引用，后面每条一张图）。
 */

/**
 * 官方的 @ 语法是 `<@openid>`。
 *
 * 纯文本出口发不出真 @（官方只在 markdown 里认），所以：
 *   · **合法 openid 形态的整段删掉**——`<@8C7419D4B8…>` 留着就是
 *     一串 32 位十六进制，比没有还糟；
 *   · 其它 `<@` 变全角挡住，防止「`<@某人>` 这段字」被官方当 mention。
 *
 * `at` 段自己拼的那串**不经过这里**（由 actions 决定渲染成什么）。
 */
function neutralizeMentions(s) {
  return String(s)
    .replace(/<@!?[0-9A-Za-z]{16,64}>/g, '')
    .replace(/<@/g, '＜@');
}

/**
 * @param {Array|string} message OneBot 的 `message`（段数组或字符串）
 * @param {object} ctx
 * @param {import('./ids.js').OneBotIds} ctx.ids
 * @param {number} ctx.selfUin
 * @returns {{text:string, reference:string, images:Array, records:Array, ats:Array, warnings:string[]}}
 * @throws {Error & {retcode?:number}} 遇到官方根本发不了的段
 */
export function parseOutgoing(message, { ids, selfUin }) {
  const out = { text: '', reference: '', images: [], records: [], ats: [], warnings: [] };

  if (typeof message === 'string') {
    // 只当纯文本：CQ 码原样剥掉，避免把 `[CQ:at,qq=…]` 当文字发出去
    out.text = neutralizeMentions(message.replace(/\[CQ:[^\]]*\]/g, ''));
    return out;
  }

  const segs = Array.isArray(message) ? message : [];
  const texts = [];

  for (const seg of segs) {
    const type = String(seg?.type ?? '');
    const d = seg?.data ?? {};

    switch (type) {
      case 'text':
        texts.push(neutralizeMentions(d.text ?? ''));
        break;

      case 'at': {
        const qq = String(d.qq ?? '');
        // @机器人自己：被动回复本身已经指向它，多一个 @ 是噪音
        if (qq && Number(qq) === Number(selfUin)) break;
        const openid = ids.openidOfUser(qq);
        if (!openid) {
          // 不整条失败：降级成文字，让用户至少看到「@了谁」
          const name = String(d.name ?? qq);
          texts.push(`@${name} `);
          out.warnings.push(`@${qq} 没有绑定 openid，已降级成文字`);
          break;
        }
        /**
         * 这里仍然拼 `<@openid>`，但**能不能原样发出去由 actions 决定**：
         * 官方只在 markdown 消息里认 @ 用户（群聊还要求 member_openid），
         * 纯文本里的这串会被当字面量显示。`ats` 记下来供出口判断。
         */
        texts.push(`<@${openid}>`);
        out.ats.push({ openid, qq, name: String(d.name ?? '') });
        break;
      }

      case 'reply': {
        const rec = ids.getMessage(d.id);
        if (rec?.i) out.reference = String(rec.i);
        else out.warnings.push(`引用失败：找不到 message_id=${d.id}（重启前的消息不在映射表里）`);
        break;
      }

      case 'image': {
        const file = String(d.file ?? d.url ?? '');
        if (file) out.images.push({ file });
        break;
      }

      case 'face':
      case 'mface':
        // 官方没有 QQ 表情码，退化成文字
        texts.push('[表情]');
        break;

      case 'record': {
        const file = String(d.file ?? d.url ?? '');
        if (!file) {
          out.warnings.push('语音段没有 file，已忽略');
          break;
        }
        // 转码与上传在 actions 里做（那里才知道有没有 silk-wasm / ffmpeg）
        out.records.push({ file });
        break;
      }

      case 'forward':
      case 'node':
        {
          const err = new Error('官方接口只能收合并转发，不能发');
          err.retcode = 1404;
          throw err;
        }

      case 'share':
      case 'music':
      case 'location': {
        const title = String(d.title ?? d.name ?? '');
        const url = String(d.url ?? d.file ?? '');
        texts.push([title, url].filter(Boolean).join(' ') || `[${type}]`);
        out.warnings.push(`${type} 段已降级成文字`);
        break;
      }

      default:
        out.warnings.push(`不认识的段类型 ${type || '(空)'}，已忽略`);
    }
  }

  out.text = texts.join('').trim();
  return out;
}

/** 拆条上限：官方一条入站消息最多回 5 次（群聊） */
export const MAX_PARTS = 5;

/**
 * 纯文本出口的正文渲染：把 `<@openid>` 换成 `@昵称`。
 *
 * **为什么必须换**：官方「文本交互」文档——@用户 只在 **markdown 消息**里生效
 * （群聊还要求 id 是 member_openid），纯文本里的这串会被当字面量原样显示。
 * 2026-11-13 实机就是 `<@8C7419D4B8500528C2248E85360A719D> 咋啦`。
 *
 * 昵称来源顺序：at 段自带的 `name` → 调用方给的 nameOf（身份表）→ 都没有就
 * **整段删掉**。宁可少一个 @，也不让 32 位 openid 漏进聊天记录。
 *
 * @param {string} text `parseOutgoing` 拼出来的正文（含 `<@openid>`）
 * @param {Array<{openid:string, name?:string}>} ats
 * @param {(openid:string)=>string} [nameOf]
 * @returns {string}
 */
export function renderPlainText(text, ats = [], nameOf = () => '') {
  const label = new Map();
  for (const a of ats) {
    const name = String(a?.name ?? '').trim() || String(nameOf(a?.openid) ?? '').trim();
    label.set(String(a?.openid ?? ''), name ? `@${name}` : '');
  }
  let s = String(text ?? '');
  // 精确替换 at 段拼的那串（别用正则猜长度：mock / 短 openid 会漏）
  for (const [openid, l] of label) {
    if (openid) s = s.split(`<@${openid}>`).join(l);
  }
  // 兜底：模型自己在正文里写的 `<@openid>`（不是 at 段）同样不能漏出去
  s = s.replace(/<@!?([0-9A-Za-z]{16,64})>/g, (_m, openid) => label.get(openid) ?? '');
  return s.trim();
}

/**
 * markdown 出口的正文渲染：`<@openid>` → `<qqbot-at-user id="openid" />`。
 *
 * 这是官方**唯一**能让 @ 真正生效的写法（`text-chain` 文档：群聊 @用户
 * 只支持 markdown，id 填 member_openid）。`ids` 里的 openid 就是群消息
 * 事件里的 member_openid，直接能用。
 *
 * 正文其余部分原样保留——消息按 markdown 渲染，模型写的加粗 / 列表 / 链接
 * 会照常显示，这就是「自动识别 markdown」想要的。
 *
 * @param {string} text
 * @param {Array<{openid:string}>} ats
 * @returns {string}
 */
export function renderMarkdownText(text, ats = []) {
  const tag = (openid) => `<qqbot-at-user id="${openid}" />`;
  let s = String(text ?? '');
  for (const a of ats) {
    const openid = String(a?.openid ?? '');
    if (openid) s = s.split(`<@${openid}>`).join(tag(openid));
  }
  // 模型自己写的 `<@openid>` 也按同样规则转，别让它变字面量
  s = s.replace(/<@!?([0-9A-Za-z]{16,64})>/g, (_m, openid) => tag(openid));
  return s.trim();
}
