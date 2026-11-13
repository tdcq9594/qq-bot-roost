/**
 * OneBot action → 官方接口
 * =========================
 *
 * 三档：支持 / 降级 / 不支持。**不支持的必须报 1404 并说人话**，
 * 因为静默失败会让客户端以为「发出去了」，比报错危险得多。
 *
 * 发送一律走 `outbound.send()`：被动窗口、`msg_seq`、每秒限速、主动额度、
 * 投递账本都在那里，绕过去等于把这套保护全部作废。
 */

import { parseOutgoing, MAX_PARTS } from './segments.js';
import { recallNotice } from './translate.js';
import { fetchAudio, toSilk, uploadVoice } from './voice.js';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

function obError(retcode, message) {
  const e = new Error(message);
  e.retcode = retcode;
  return e;
}

/** 把 `image` 段的 file 变成 uploadMedia 能吃的参数 */
async function uploadImage(api, scene, target, file) {
  if (/^base64:\/\//.test(file)) {
    return api.uploadMedia(scene, target, { fileData: file.slice('base64://'.length) });
  }
  if (/^https?:\/\//i.test(file)) {
    return api.uploadMedia(scene, target, { url: file });
  }
  // Windows：`file:///C:/x.png` 不能用字符串切前缀，否则路径变成 `/C:/x.png`
  const p = /^file:\/\//i.test(file) ? fileURLToPath(file) : file;
  return api.uploadLocalFile(scene, target, p, 1);
}

/**
 * @param {object} p
 * @param {object} p.runtime BotRuntime（cfg / api / outbound / gate / groups）
 * @param {import('./ids.js').OneBotIds} p.ids
 * @param {number} p.selfUin
 * @param {string} p.botName
 * @param {(chatId:string)=>{msgId:string, at:number}|null} p.getPassive
 * @param {(evt:object)=>void} p.emit 推事件给客户端（撤回通知用）
 * @param {()=>boolean} [p.silkReady]
 */
export function createActions({
  runtime,
  ids,
  selfUin,
  botName,
  getPassive,
  emit,
  silkReady = () => false,
  silk = null,
  version = '',
  historyLimit = 100,
}) {
  const { api, outbound, gate, groups } = runtime;
  const log = runtime.log;

  /** 统一的发送：先过暂停闸，再拆条，最后逐条走 outbound */
  async function sendMessage({ kind, targetOpenid, chatId, parsed }) {
    if (!targetOpenid) throw obError(1404, '找不到这个号码对应的 openid，先去面板「身份」页绑一下');

    /**
     * 机器人本体没上线时，先把话说清楚。
     *
     * 兼容层的监听是**先于网关**起来的（客户端能连上、能收事件），但这时候
     * 发消息一定失败。不解释的话客户端只会看到「机器人当前没有连上 QQ」，
     * 而真正原因往往是 AppID 实例锁冲突 / 凭据过期 / 手动下线——那些都在
     * 面板「运行」页，用户根本不知道该去看。
     */
    if (!runtime.mock && runtime.online === false) {
      const why = String(runtime.lastError || '').trim();
      throw obError(
        1503,
        `Roost 的机器人本体没上线${why ? `（${why}）` : ''}：先到面板「运行」页让它上线，再重发`,
      );
    }

    const v = gate?.check?.(chatId);
    if (v && !v.ok) {
      const why = v.reasons.map((r) => r.text).join('；');
      throw obError(1501, `本会话已暂停（${why}），先到面板放开再发`);
    }

    const parts =
      (parsed.text || parsed.reference || (parsed.images.length === 0 && parsed.records.length === 0) ? 1 : 0) +
      parsed.images.length +
      parsed.records.length;
    if (parts > MAX_PARTS) {
      throw obError(1501, `一条消息最多拆 ${MAX_PARTS} 条（官方限制每条入站消息最多回 5 次），这条要拆 ${parts} 条`);
    }

    const passive = getPassive(chatId);
    const base = {
      kind,
      target: targetOpenid,
      chatKey: `${kind}:${chatId}`,
      ...(passive ? { receivedAt: passive.at } : {}),
    };
    /**
     * 每次 `outbound.send` 都带一个**独立**的幂等键。
     *
     * 为什么必须有：`outbound` 只在拿到 `requestId` 时才写投递账本
     * （`delivery.claim/settle`），没有就「照发但不入账」。OneBot 之前一个都
     * 没带，于是客户端发出去的消息在面板「投递」页完全看不到——出问题了
     * 只能翻日志。
     *
     * 必须**一条一条生成**：一条消息可能拆成文本 + 多张图 + 多段语音，
     * 共用同一个 id 会被账本当成「重发」直接复用上一条的结果。
     */
    const rid = () => `ob-${crypto.randomUUID()}`;
    const withPassive = (payload) => ({ ...payload, ...(passive ? { msgId: passive.msgId } : {}) });

    let last = null;
    // 文本（或纯引用、或没有任何媒体）：第一条
    if (parsed.text || parsed.reference || (parsed.images.length === 0 && parsed.records.length === 0)) {
      const payload = withPassive({ content: parsed.text || '' });
      if (parsed.reference) payload.messageReference = { message_id: parsed.reference };
      last = await outbound.send({ ...base, requestId: rid(), payload });
    }

    // 图片：一张一条，msg_type=7
    for (const img of parsed.images) {
      const scene = kind === 'group' ? 'group' : 'c2c';
      const up = await uploadImage(api, scene, targetOpenid, img.file);
      if (!up?.file_info) throw obError(1500, '图片上传成功但没拿到 file_info');
      last = await outbound.send({
        ...base,
        requestId: rid(),
        payload: withPassive({ msgType: 7, media: { file_info: up.file_info } }),
      });
    }

    // 语音：一条一条，转 SILK 之后走 file_type=3
    for (const rec of parsed.records) {
      const scene = kind === 'group' ? 'group' : 'c2c';
      const buf = await fetchAudio(rec.file);
      const { silk: silkBuf } = await toSilk(buf, silk);
      const fileInfo = await uploadVoice(api, scene, targetOpenid, silkBuf);
      last = await outbound.send({
        ...base,
        requestId: rid(),
        payload: withPassive({ msgType: 7, media: { file_info: fileInfo } }),
        fileType: 3,
      });
    }

    if (parsed.warnings.length) log.warn(`发送降级：${parsed.warnings.join('；')}`);
    return last;
  }

  function sendTo(kind, idOrOpenid) {
    const chatId = kind === 'group' ? ids.openidOfGroup(idOrOpenid) : ids.openidOfUser(idOrOpenid);
    return chatId;
  }

  async function handleSend(kind, params) {
    const raw = kind === 'group' ? params.group_id : params.user_id;
    const chatId = sendTo(kind, raw);
    const parsed = parseOutgoing(params.message, { ids, selfUin });
    const r = await sendMessage({ kind, targetOpenid: chatId, chatId, parsed });
    // 自己发出去的消息也进映射表：客户端随后 delete_msg / get_msg 要用
    const onebotId = ids.bindSent({
      officialId: r?.id ?? '',
      chatId,
      kind,
    });
    return { message_id: onebotId, ...(parsed.warnings.length ? { warning: parsed.warnings.join('；') } : {}) };
  }

  /** 身份表里的昵称（群成员接口拿不到时的兜底） */
  const identityName = (openid) => {
    try {
      const rec = runtime.identity?.resolveUser?.(runtime.cfg?.id ?? '', openid);
      return rec?.record?.name || '';
    } catch {
      return '';
    }
  };

  /**
   * 用账本回放历史消息。
   *
   * 官方没有历史接口，只能给「本进程收到过的」。`ledger.history()` 把 payload
   * 一起取出来，所以图片/语音也能还原——只给 `content` 的话历史里全是纯文字。
   *
   * @param {string} chatId openid
   * @param {'group'|'c2c'} kind
   */
  const historyOf = (chatId, kind, count) => {
    // 上限由 `onebot.historyCache` 控制；0 = 关（返回空）
    if (!historyLimit) return [];
    const lim = Math.min(Math.max(Number(count) || 20, 1), Math.max(Number(historyLimit) || 100, 1));
    const rows = runtime.ledger?.history?.({ chatId, limit: lim }) ?? [];
    return rows
      .filter((r) => r.kind === kind)
      .map((r) => {
        const p = r.payload ?? {};
        const segs = [];
        if (r.content) segs.push({ type: 'text', data: { text: String(r.content) } });
        for (const a of Array.isArray(p.attachments) ? p.attachments : []) {
          const ct = String(a?.content_type ?? '');
          if (ct.startsWith('image/')) {
            segs.push({ type: 'image', data: { file: a.url, url: a.url, summary: '[图片]' } });
          } else if (ct === 'voice') {
            segs.push({ type: 'record', data: { file: a.voice_wav_url || a.url, url: a.voice_wav_url || a.url } });
          } else if (ct.startsWith('video/')) {
            segs.push({ type: 'video', data: { file: a.url, url: a.url } });
          } else if (ct === 'file') {
            segs.push({ type: 'file', data: { file: a.url, name: a.filename } });
          }
        }
        return {
          time: Math.floor((Number(r.at) || Date.now()) / 1000),
          self_id: Number(selfUin) || 0,
          post_type: 'message',
          message_type: kind === 'group' ? 'group' : 'private',
          sub_type: kind === 'group' ? 'normal' : 'friend',
          // 只读映射：账本行 id 不是官方 msg_id，写进索引会让 delete_msg 指向错的消息
          message_id: ids.bindMessage({ id: r.id, msgIdx: r.msgIdx, chatId, kind }, { noIndex: true }),
          ...(kind === 'group' ? { group_id: ids.group(chatId) } : {}),
          user_id: ids.user(r.userId),
          message: segs,
          raw_message: r.content ?? '',
          font: 0,
          sender: {
            user_id: ids.user(r.userId),
            nickname: String(r.userName ?? ''),
            card: String(r.userName ?? ''),
            role: 'member',
          },
        };
      });
  };

  const handlers = {
    async get_login_info() {
      return { user_id: Number(selfUin) || 0, nickname: String(botName ?? '') };
    },

    async get_status() {
      return { online: Boolean(runtime.gateway?.ready), good: true };
    },

    async get_version_info() {
      return { app_name: 'roost', app_version: String(version || runtime.pkgVersion || ''), protocol_version: 'v11' };
    },

    async can_send_image() {
      return { yes: true };
    },

    async can_send_record() {
      return { yes: Boolean(silkReady()) };
    },

    async send_group_msg(params) {
      return handleSend('group', params ?? {});
    },

    async send_private_msg(params) {
      return handleSend('c2c', params ?? {});
    },

    async send_msg(params) {
      const p = params ?? {};
      const kind = String(p.message_type ?? (p.group_id ? 'group' : 'private'));
      return handleSend(kind === 'group' ? 'group' : 'c2c', p);
    },

    async delete_msg(params) {
      const rec = ids.getMessage(params?.message_id);
      if (!rec?.m) throw obError(1404, '找不到这条消息（只记得最近 500 条，重启前的也可能不在了）');
      const kind = rec.k === 'group' ? 'group' : 'c2c';
      if (kind === 'group') await api.retractGroupMessage(rec.c, rec.m);
      else await api.retractC2CMessage(rec.c, rec.m);

      // 官方没有撤回事件，自己撤的这条补一个 group_recall，客户端才能清上下文
      if (kind === 'group') {
        emit(
          recallNotice({
            ids,
            selfUin,
            groupId: ids.group(rec.c),
            userId: Number(selfUin) || 0,
            messageId: params?.message_id,
          }),
        );
      }
      return {};
    },

    async get_msg(params) {
      const rec = ids.getMessage(params?.message_id);
      if (!rec) throw obError(1404, '找不到这条消息');
      return {
        message_id: Number(params.message_id),
        time: Math.floor((rec.t ?? Date.now()) / 1000),
        message_type: rec.k === 'group' ? 'group' : 'private',
        ...(rec.k === 'group' ? { group_id: ids.group(rec.c) } : { user_id: ids.user(rec.c) }),
        message: [],
        raw_message: '',
        sender: { user_id: 0, nickname: '' },
      };
    },

    async get_group_info(params) {
      const openid = ids.openidOfGroup(params?.group_id);
      if (!openid) throw obError(1404, '这个群号没有对应的 openid，先去面板「身份」页绑一下');
      const info = await api.getGroupInfo(openid);
      return {
        group_id: Number(params?.group_id),
        group_name: String(info?.group_name ?? runtime.groupName?.(openid) ?? ''),
        member_count: Number(info?.member_count ?? 0),
        max_member_count: Number(info?.max_member_count ?? 0),
      };
    },

    async get_group_list() {
      const list = (await groups?.list?.()) ?? [];
      const out = [];
      for (const g of list) {
        const openid = String(g.groupOpenid ?? g.group_openid ?? '');
        if (!openid) continue;
        out.push({
          group_id: ids.group(openid),
          group_name: String(runtime.groupName?.(openid) ?? ''),
          member_count: 0,
          max_member_count: 0,
        });
      }
      return out;
    },

    /* ---------------- 群管 ---------------- */

    async set_group_ban(params) {
      const openid = ids.openidOfGroup(params?.group_id);
      if (!openid) throw obError(1404, '这个群号没有对应的 openid，先去面板「身份」页绑一下');
      const uid = ids.openidOfUser(params?.user_id);
      if (!uid) throw obError(1404, '这个 QQ 号没有对应的 openid，先去面板「身份」页绑一下');

      const duration = Number(params?.duration) || 0;
      // duration=0 表示解除；官方要 RFC3339 到期时间，最长 30 天
      const expireAt = duration > 0 ? new Date(Date.now() + duration * 1000).toISOString() : '';
      await api.muteMember(openid, uid, expireAt);
      return {};
    },

    async set_group_add_request(params) {
      const openid = ids.openidOfGroup(params?.group_id);
      if (!openid) throw obError(1404, '这个群号没有对应的 openid');
      const uid = ids.openidOfUser(params?.user_id);
      if (!uid) throw obError(1404, '这个 QQ 号没有对应的 openid');
      const approve = params?.approve === true || params?.approve === 'true';
      await api.handleJoinRequest(openid, uid, {
        op: approve ? 'approve' : 'decline',
        joinRequestId: String(params?.flag ?? ''),
        rejectReason: String(params?.reason ?? ''),
      });
      return {};
    },

    /**
     * 群成员信息：官方是**内邀接口**，没白名单会 11253。
     * 降级返回最小信息（号码 + 已知昵称），别让客户端整段逻辑崩。
     */
    async get_group_member_info(params) {
      const openid = ids.openidOfGroup(params?.group_id);
      if (!openid) throw obError(1404, '这个群号没有对应的 openid');
      const uid = ids.openidOfUser(params?.user_id);
      if (!uid) throw obError(1404, '这个 QQ 号没有对应的 openid');

      try {
        const m = await api.getGroupMember(openid, uid);
        return {
          group_id: Number(params.group_id),
          user_id: Number(params.user_id),
          nickname: String(m?.nickname ?? m?.username ?? ''),
          card: String(m?.card ?? ''),
          role: String(m?.role ?? 'member'),
        };
      } catch (e) {
        log.debug(`群成员信息降级：${e.message}`);
        return {
          group_id: Number(params.group_id),
          user_id: Number(params.user_id),
          nickname: String(identityName(uid) ?? ''),
          card: '',
          role: 'member',
          warning: '官方群成员接口是内邀能力，这里只能给最小信息',
        };
      }
    },

    /** 群成员列表：内邀开了走真接口，否则用「在群里说过话的人」（roles 里记着的） */
    async get_group_member_list(params) {
      const openid = ids.openidOfGroup(params?.group_id);
      if (!openid) throw obError(1404, '这个群号没有对应的 openid');

      if (runtime.cfg?.groupManage?.invited) {
        try {
          const list = await api.getGroupMembers(openid, {});
          const arr = Array.isArray(list) ? list : (list?.members ?? []);
          return arr.map((m) => ({
            group_id: Number(params.group_id),
            user_id: ids.user(String(m.member_openid ?? m.user_openid ?? '')),
            nickname: String(m.nickname ?? m.username ?? ''),
            card: String(m.card ?? ''),
            role: String(m.role ?? 'member'),
          }));
        } catch (e) {
          log.debug(`群成员列表降级：${e.message}`);
        }
      }

      const members = (await runtime.roles?.scopeMembers?.(`group:${openid}`)) ?? {};
      return Object.keys(members).map((uid) => ({
        group_id: Number(params.group_id),
        user_id: ids.user(uid),
        nickname: String(identityName(uid) ?? ''),
        card: '',
        role: 'member',
      }));
    },

    /* ---------------- 历史（官方没有接口，用账本回放） ---------------- */

    async get_group_msg_history(params) {
      const openid = ids.openidOfGroup(params?.group_id);
      if (!openid) throw obError(1404, '这个群号没有对应的 openid');
      // OneBot v11 要 `{ messages: [...] }`，裸数组会让客户端 `data.messages.map` 直接抛
      return { messages: historyOf(openid, 'group', Number(params?.count) || 20) };
    },

    async get_friend_msg_history(params) {
      const openid = ids.openidOfUser(params?.user_id);
      if (!openid) throw obError(1404, '这个 QQ 号没有对应的 openid');
      return { messages: historyOf(openid, 'c2c', Number(params?.count) || 20) };
    },

    async mark_msg_as_read() {
      return {};
    },
  };

  /**
   * 不在表里的 action 一律 1404。
   *
   * 读类给空集更好用（很多客户端不处理错误码），但空集会让「没这个能力」
   * 和「真的没有数据」混在一起——这里选择**报错**，并在 wording 里说清原因，
   * 面板能力矩阵同步显示。
   */
  const dispatchAction = async (action, params) => {
    const fn = handlers[action];
    if (fn) return fn(params);
    throw obError(1404, `roost 没有实现 ${action}：官方接口没有对应能力（详见面板「兼容 → 能力」）`);
  };
  /** 给能力表用：真正注册了哪些 action */
  dispatchAction.names = Object.keys(handlers);
  return dispatchAction;
}
