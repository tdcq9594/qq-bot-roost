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

/** 官方的 @ 语法是 `<@openid>`，正文里出现同样的串会被当成真 @——挡掉 */
function neutralizeMentions(s) {
  return String(s).replace(/<@/g, '＜@');
}

/**
 * @param {Array|string} message OneBot 的 `message`（段数组或字符串）
 * @param {object} ctx
 * @param {import('./ids.js').OneBotIds} ctx.ids
 * @param {number} ctx.selfUin
 * @returns {{text:string, reference:string, images:Array<{file:string}>, warnings:string[]}}
 * @throws {Error & {retcode?:number}} 遇到官方根本发不了的段
 */
export function parseOutgoing(message, { ids, selfUin }) {
  const out = { text: '', reference: '', images: [], records: [], warnings: [] };

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
        texts.push(`<@${openid}>`);
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
