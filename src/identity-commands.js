/**
 * 群里的绑定指令（内核命令的实现）。
 *
 * ## 为什么单独一个文件
 *
 * `main.js` 里的命令 handler 拿不到可测的上下文（registry / roles / cfg / 真消息），
 * 逻辑写在里面只能靠端到端测。这里只做「消息 → 结果文本」的纯逻辑，
 * 权限由调用方算好传进来（`allowed`），身份表通过参数注入。
 *
 * ## 三条硬规矩
 *
 * 1. **只绑当前群、以及当前群里被 @ 的人。** 不接受任何「把别的群的 openid
 *    绑过来」的参数——群里发一句话就能改别人身份的入口，范围必须收到最小。
 * 2. **不做 force。** 冲突就停，让用户去面板确认。群里一句话把别人的身份
 *    改掉，代价比多点两下鼠标高得多。
 * 3. **永远返回文本，不抛。** 聊天命令抛异常等于用户什么都收不到，
 *    而发指令的人只会以为「机器人没反应」。
 */

import { isValidUin } from './identity.js';

/** 参数里可能混着 `<@openid>` 这样的 token，取**最后一个**合法号码 */
export function parseTargetUin(args = []) {
  const list = Array.isArray(args) ? args : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const v = String(list[i] ?? '').trim();
    if (isValidUin(v)) return v;
  }
  return '';
}

/** 被 @ 的人里第一个不是机器人的 */
export function pickMember(mentions = []) {
  for (const m of Array.isArray(mentions) ? mentions : []) {
    if (!m || m.isBot) continue;
    const id = String(m.id ?? '').trim();
    if (id) return { id, name: String(m.name || '') };
  }
  return null;
}

const NEED_ADMIN = '只有主人和管理员（0 / 1 级）能改绑定。';
const ONLY_GROUP = '这个指令只能在群里用。';

function bindErrorText(e) {
  if (e?.code === 'CONFLICT') {
    return `${e.message}。要改绑请去 Roost 面板 →「身份」页，群里不做强制改绑。`;
  }
  if (e?.code === 'INVALID') return `绑定失败：${e.message}`;
  return `绑定失败：${e?.message || e}`;
}

/**
 * `绑定群号 <群号>`：把**当前群**的 openid 绑到群号。
 */
export async function runBindGroup({ msg, identity, botId = '', allowed = false, log = () => {} } = {}) {
  if (msg?.kind !== 'group') return { ok: false, text: ONLY_GROUP };
  if (!allowed) return { ok: false, text: NEED_ADMIN };

  const uin = parseTargetUin(msg.args);
  if (!uin) return { ok: false, text: '用法：绑定群号 763366431（5–12 位数字，首位不能是 0）' };

  /** 群聊时 `chatId` 就是群的 openid；只认这一个来源 */
  const openid = String(msg.chatId || '').trim();
  if (!openid) return { ok: false, text: '拿不到本群的 openid，让群里有人先说句话再试。' };

  try {
    await identity.bind({ kind: 'group', uin, openid, botId });
  } catch (e) {
    return { ok: false, text: bindErrorText(e) };
  }
  log(`绑定指令：${msg.userId} 在 ${openid} 把本群绑到群号 ${uin}`);
  return {
    ok: true,
    text: `已把本群绑到群号 ${uin}。以后换机器人，新群的 openid 也要绑到同一个群号。`,
  };
}

/**
 * `绑定成员 @某人 <QQ号>`：把**当前群里被 @ 的那个人**绑到 QQ号。
 */
export async function runBindUser({ msg, identity, botId = '', allowed = false, log = () => {} } = {}) {
  if (msg?.kind !== 'group') return { ok: false, text: ONLY_GROUP };
  if (!allowed) return { ok: false, text: NEED_ADMIN };

  const member = pickMember(msg.mentions);
  if (!member) return { ok: false, text: '用法：绑定成员 @某人 10001（先 @ 要绑的人，再写 QQ号）' };

  const uin = parseTargetUin(msg.args);
  if (!uin) return { ok: false, text: '缺 QQ号。用法：绑定成员 @某人 10001' };

  try {
    await identity.bind({ kind: 'user', uin, openid: member.id, botId });
  } catch (e) {
    return { ok: false, text: bindErrorText(e) };
  }
  log(`绑定指令：${msg.userId} 在 ${msg.chatId} 把 ${member.id} 绑到 QQ号 ${uin}`);
  return { ok: true, text: `已把 ${member.name ? `@${member.name} ` : '这个人'}绑到 QQ号 ${uin}。` };
}
