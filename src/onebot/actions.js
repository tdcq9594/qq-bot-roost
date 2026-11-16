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

import { parseOutgoing, renderPlainText, renderMarkdownText, MAX_PARTS } from './segments.js';
import { recallNotice } from './translate.js';
import { fetchAudio, toSilk, uploadVoice } from './voice.js';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { getDevPlatform } from '../host/dev.js';

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
  /** 开放平台门面；测试可以塞假的，正常跑用单例 */
  dev = null,
}) {
  const { api, outbound, gate, groups } = runtime;
  const log = runtime.log;

  /**
   * 官方**明确拒绝**（4xx）才值得降级重发。
   *
   * 401 / 429 与网络错误不算：401 是凭据（api 层已重试过一次），
   * 429 是限频，网络超时则**消息可能已经发出去了**——这三种再发一遍
   * 只会让群里出现两条一样的消息。
   */
  const isRejected = (e) => {
    const st = Number(e?.status ?? 0);
    return st >= 400 && st < 500 && st !== 401 && st !== 429;
  };

  /* ---------------- 机器人资料（开放平台后台） ----------------
   *
   * OneBot 客户端的「改机器人资料」只能落到官方后台，所以这条链跟发消息
   * 完全无关：用的是**开发者账号票据**，不是机器人 token。三条辅助函数
   * 把「要不要人登录」「改哪一只」「图片是什么格式」这三件事先钉死。
   */

  /** 这只鸟的 AppID；没有它连改谁都不知道 */
  const requireAppid = () => String(runtime.cfg?.appId ?? '').trim();

  const devOf = () => dev || getDevPlatform({ log: (m) => log.info?.(String(m)) });

  /**
   * 拿到能干活的门面，否则抛出**能指导用户下一步**的错误。
   *
   * 用 `checkSession(verify)` 而不是「先 getBot 再看抛什么」：没登录、
   * 登错号、账号里没这只、平台限频——四种原因对用户来说动作完全不同，
   * 混成一句「失败」等于让他去猜。
   */
  async function requireDev() {
    const appid = requireAppid();
    if (!appid) throw obError(1400, '配置里没有 AppID，没法定位要改哪只机器人');
    const P = devOf();
    const check = P.check || P.checkSession;
    let chk;
    try {
      chk = await check.call(P, { verify: true, bound: { id: String(runtime.id ?? ''), name: botName, appid } });
    } catch (e) {
      throw obError(1401, `开放平台检查失败：${e?.message || e}`);
    }
    if (chk?.state === 'ready') return P;
    // 1401 = 需要人先做一步（登录 / 换号 / 填 AppID），不是技术故障
    throw obError(1401, `改不了机器人资料：${chk?.message || '未知原因'}${chk?.hint ? `。${chk.hint}` : ''}`);
  }

  /** 认图片格式：官方只收 png / bmp / jpeg / jpg / gif */
  function sniffImage(buf) {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    const head = buf.slice(0, 4).toString('ascii');
    if (head.startsWith('GIF')) return 'image/gif';
    if (head.startsWith('BM')) return 'image/bmp';
    return '';
  }

  /**
   * `avatar` 参数 → `setAvatar` 能吃的形态。
   *
   * 客户端给的东西三种：http(s) 地址、`base64://`、`file:///`（也有直接
   * 甩本地路径的）。顺带在这里拦住官方的两条硬限制：≤ 2 MB、格式在白名单。
   */
  async function avatarSource(raw) {
    const v = String(raw || '').trim();
    if (/^https?:\/\//i.test(v)) return { url: v };

    let buf = null;
    if (/^base64:\/\//i.test(v)) {
      buf = Buffer.from(v.slice('base64://'.length), 'base64');
    } else if (v.startsWith('file://')) {
      buf = await fs.readFile(fileURLToPath(v)).catch(() => null);
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
      buf = await fs.readFile(v).catch(() => null);
    }
    if (!buf?.length) throw obError(1400, 'avatar 只支持 http(s) 地址、base64://、file:/// 或本地路径');
    if (buf.length > 2 * 1024 * 1024) throw obError(1400, `头像 ${(buf.length / 1024 / 1024).toFixed(1)} MB，超过官方 2 MB 上限`);
    const mime = sniffImage(buf);
    if (!mime) throw obError(1400, '官方只收 png / bmp / jpeg / jpg / gif，这张认不出格式');
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }

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

    /**
     * 出站正文要按出口渲染两版：
     *   · 纯文本：`<@openid>` → `@昵称`（没有昵称就删掉）
     *   · markdown：`<@openid>` → `<qqbot-at-user id="openid" />`（唯一能让 @ 生效的写法）
     *
     * 官方「文本交互」文档：@用户 只在 **markdown 消息**里生效，群聊还要求
     * id 是 member_openid。纯文本里这串会被当字面量，用户看到的就是
     * `<@8C7419D4B8…> 咋啦`（2026-11-13 实机截图）。
     */
    const ats = parsed.ats ?? [];
    const text = renderPlainText(parsed.text, ats, identityName);
    const mdText = ats.length ? renderMarkdownText(parsed.text, ats) : '';

    const parts =
      (text || parsed.reference || (parsed.images.length === 0 && parsed.records.length === 0) ? 1 : 0) +
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
    if (text || parsed.reference || (parsed.images.length === 0 && parsed.records.length === 0)) {
      const plain = withPassive({ content: text });
      if (parsed.reference) plain.messageReference = { message_id: parsed.reference };

      /**
       * 群聊里带 @ → **自动升级成 markdown 发送**。
       *
       * 官方「文本交互」文档：@用户 只在 markdown 消息里生效（群聊 id 要
       * member_openid，identity 里存的就是它）。纯文本出口只能把
       * `<@openid>` 变成 `@昵称` 或者删掉——对方收不到提醒。
       *
       * 代价是整条消息按 markdown 渲染，正好对上「自动识别 markdown」：
       * 模型写的 `**粗体**`、`- 列表` 会正常显示。单聊不发 markdown：
       * 两个人之间 @ 没有意义，官方也只写了群聊 / 文字子频道。
       *
       * 被官方明确拒（4xx：群没开 markdown 权限、内容判违规、超长）就
       * 降级纯文本——丢一个 @，但话一定送到。
       */
      let viaMarkdown = false;
      if (kind === 'group' && mdText) {
        try {
          last = await outbound.send({
            ...base,
            requestId: rid(),
            payload: withPassive({
              markdown: { content: mdText },
              ...(parsed.reference ? { messageReference: { message_id: parsed.reference } } : {}),
            }),
          });
          viaMarkdown = true;
        } catch (e) {
          if (!isRejected(e)) throw e;
          log.warn(`群里发 markdown（带 @）被官方拒了，降级纯文本：${e.message}`);
        }
      }
      if (!viaMarkdown) {
        last = await outbound.send({ ...base, requestId: rid(), payload: plain });
      }
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
   * 这个机器人最近见过的人。
   *
   * 2026-11-16 起 `#rememberPerson` 会一起记群名片（`card`）和头像
   * （`avatar`），所以「查不到官方资料」时能给出比 openid 好得多的东西：
   * 群里说过一句话的人，`get_group_member_info` 就能答出真名片。
   * 只覆盖「说过话的人」——这是内存索引，不落盘。
   */
  const seenPerson = (openid) => {
    const id = String(openid ?? '');
    if (!id) return null;
    try {
      return (runtime.listRecentPeople?.(200) ?? []).find((p) => p.openid === id) ?? null;
    } catch {
      return null;
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
        /**
         * 发送者从**原始事件**里取：账本存的是 `cleanPayload(raw)`，
         * 所以 `author.member_nickname`（群名片）和 `avatar` 都还在。
         * 以前这里 `nickname` / `card` 都填 `userName`——历史里的名片永远是
         * 群内昵称，跟 QQ 昵称混成一份，客户端改名片时对不上。
         */
        const author = p.author && typeof p.author === 'object' ? p.author : null;
        const nick = String(author?.username ?? '').trim();
        /**
         * **老账本没有 `member_nickname`**（2026-11-16 之前的事件），那时
         * `user_name` 存的就是显示名（群昵称优先）。所以要分清「字段不存在」
         * 和「字段存在但为空」：前者回退到 `userName`，后者就是真的没群名片。
         * 不分的话，升级后翻开历史，老消息的名片会集体变成空串。
         */
        const hasMemberNick = Boolean(author) && Object.hasOwn(author, 'member_nickname');
        const card = hasMemberNick
          ? String(author.member_nickname ?? '').trim()
          : String(r.userName ?? '').trim();
        const avatar = String(author?.avatar ?? '').trim();
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
            nickname: nick || card || String(r.userName ?? ''),
            card,
            role: String(author?.member_role ?? 'member'),
            ...(avatar ? { avatar } : {}),
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
      /**
       * 官方字段是 `group_member_num`（2026-11-16 文档）。
       * 以前读 `member_count` / `max_member_count`——两个都不存在，所以这里
       * **一直返回 0**，OneBot 客户端显示「群人数 0」也没人报警。
       */
      const count = Number(info?.group_member_num ?? info?.member_count ?? 0) || 0;
      return {
        group_id: Number(params?.group_id),
        group_name: String(info?.group_name ?? runtime.groupName?.(openid) ?? ''),
        member_count: count,
        /** 官方不提供成员上限，用同一个数顶上——客户端绝大多数只读 `member_count` */
        max_member_count: count,
        /** 非标准字段：2026-11-16 群信息接口新增，客户端不用就忽略 */
        group_memo: String(info?.group_finger_memo ?? ''),
        group_class: String(info?.group_class_text ?? ''),
        group_tags: Array.isArray(info?.group_tags) ? info.group_tags.map(String) : [],
      };
    },

    /**
     * 查陌生人资料（OneBot 标准动作）。
     *
     * 2026-11-16 官方才给 `GET /v2/users/{openid}/info`，所以这条以前是
     * `unsupported`（「官方没有用户资料接口」）。现在能答昵称和头像了。
     *
     * `user_id` 既可能是绑过的 QQ 号，也可能客户端直接塞 openid：
     * 前者走映射表，后者原样用——只在长得像 openid 时才认，别把 5 位 QQ 号
     * 当 id 发出去。
     */
    async get_stranger_info(params) {
      const raw = String(params?.user_id ?? '').trim();
      if (!raw) throw obError(1400, '要给 user_id（绑过的 QQ 号，或 openid）');
      const mapped = ids.openidOfUser(params?.user_id);
      const openid = mapped || (/^(?=.*[A-Za-z])[0-9A-Za-z_-]{16,}$/.test(raw) ? raw : '');
      if (!openid) throw obError(1404, '这个 QQ 号没有对应的 openid，先去面板「身份」页绑一下');

      const uid = Number(params?.user_id);
      try {
        const r = await api.getUserInfo(openid);
        return {
          user_id: Number.isFinite(uid) ? uid : 0,
          nickname: String(r?.username ?? ''),
          sex: 'unknown',
          age: 0,
          /** 非标准字段：官方直给的头像原图，省得客户端自己按 QQ 号拼 qlogo */
          avatar: String(r?.avatar ?? ''),
          openid,
        };
      } catch (e) {
        /**
         * 群成员通常**不是好友**，实测就是 `40184001`（2026-11-16：同群两人，
         * 没私聊过的那个被拒，私聊过的正常）。这条路走不通时，只要他在群里
         * 说过话，框架就记着他的昵称 / 群名片 / 头像——和 `get_group_member_info`
         * 同一条兜底，别在这里直接判"查不到"。
         */
        const seen = seenPerson(openid);
        if (seen) {
          return {
            user_id: Number.isFinite(uid) ? uid : 0,
            nickname: String(seen.nickname || seen.name || ''),
            sex: 'unknown',
            age: 0,
            ...(seen.card ? { card: String(seen.card) } : {}),
            ...(seen.avatar ? { avatar: String(seen.avatar) } : {}),
            openid,
            warning: '和机器人不是好友，资料来自他最近在群里说过的话',
          };
        }
        throw obError(1404, `查不到这个人的资料：${e?.message ?? e}`);
      }
    },

    async get_group_list() {
      const list = (await groups?.list?.()) ?? [];
      const out = [];
      for (const g of list) {
        const openid = String(g.groupOpenid ?? g.group_openid ?? '');
        if (!openid) continue;
        /** 群档案里现在存了人数（2026-11-16 群信息接口），有就填，没有才 0 */
        const n = Number(g.memberNum) || 0;
        out.push({
          group_id: ids.group(openid),
          group_name: String(g.name || runtime.groupName?.(openid) || ''),
          member_count: n,
          max_member_count: n,
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
        /**
         * 降级路径也别只给 openid：这个人要是在群里说过话，`recentPeople`
         * 里就有真名片（2026-11-16 起事件带 `member_nickname`）和头像。
         */
        const seen = seenPerson(uid);
        return {
          group_id: Number(params.group_id),
          user_id: Number(params.user_id),
          nickname: String(seen?.nickname || seen?.name || identityName(uid) || ''),
          card: String(seen?.card ?? ''),
          role: 'member',
          ...(seen?.avatar ? { avatar: String(seen.avatar) } : {}),
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
      return Object.keys(members).map((uid) => {
        const seen = seenPerson(uid);
        return {
          group_id: Number(params.group_id),
          user_id: ids.user(uid),
          nickname: String(seen?.nickname || seen?.name || identityName(uid) || ''),
          card: String(seen?.card ?? ''),
          role: 'member',
          ...(seen?.avatar ? { avatar: String(seen.avatar) } : {}),
        };
      });
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

    /**
     * 改机器人资料（昵称 / 头像 / 简介）。
     *
     * OneBot 客户端里的 `set_qq_profile` 是「改这个号的名字和头像」，官方
     * 机器人唯一能改的地方就是开放平台后台，所以直接映射过去：
     *   · `nickname`            → `dev.bot.set` 的 `base.name`
     *   · `avatar`              → `dev.setAvatar`（支持 http url / base64:// / file:///）
     *   · `longNick`/`personal_note` → `base.desc`（后台的「介绍」）
     *
     * 三道闸缺一不可：必须已登录开放平台（账号级票据）、只能改**这只**机器人
     * （`cfg.appId`，不接受参数另指）、只发改动过的项（平台按次限次数）。
     */
    async set_qq_profile(params) {
      const p = params ?? {};
      const name = p.nickname == null ? '' : String(p.nickname).trim();
      const avatar = p.avatar == null ? '' : String(p.avatar).trim();
      const descRaw = [p.longNick, p.long_nick, p.personal_note, p.desc].find((v) => v != null);
      const desc = descRaw == null ? '' : String(descRaw).trim();

      if (!name && !avatar && !desc) {
        throw obError(1400, '没有可改的字段：兼容层支持 nickname / avatar / longNick（personal_note）；'
          + 'company、email 这些账号资料官方后台没有接口，改不了');
      }

      const P = await requireDev();
      const appid = requireAppid();
      const touched = [];

      if (name || desc) {
        const base = {};
        if (name) base.name = name;
        if (desc) base.desc = desc;
        await P.setBot(appid, { base });
        touched.push(name ? 'nickname' : '', desc ? 'longNick' : '');
      }
      if (avatar) {
        await P.setAvatar(appid, await avatarSource(avatar));
        touched.push('avatar');
      }
      log.info?.(`[onebot] set_qq_profile → ${touched.filter(Boolean).join(' / ')}`);
      return {};
    },

    /** 读机器人简介（官方后台的「介绍」） */
    async get_self_longnick() {
      const P = await requireDev();
      const bot = await P.getBot(requireAppid());
      return { longNick: String(bot?.base?.desc ?? '') };
    },

    /** 写机器人简介（NapCat / Lagrange 的扩展动作） */
    async set_self_longnick(params) {
      const longNick = String(params?.longNick ?? params?.long_nick ?? params?.desc ?? '').trim();
      if (!longNick) throw obError(1400, 'longNick 不能是空的');
      const P = await requireDev();
      await P.setBot(requireAppid(), { base: { desc: longNick } });
      return {};
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
