/**
 * 可达性：这个人能不能私聊、这个群能不能主动推。
 * ==============================================
 *
 * 为什么需要单独一个模块：官方**没有查好友列表的接口**（sitemap 里 `friend`
 * 只有两个事件页，没有任何 API）。但官方会把变化**推**过来，所以状态能维护，
 * 只是「接入之前就已经存在的关系」永远是未知的。
 *
 * ── 两层开关，不是一层 ──
 *
 * 很多人以为「加了好友就能发私聊」。官方文档里 `C2C_MSG_REJECT` 的原话是：
 *
 *   > 用户在机器人资料卡手动关闭「主动消息」推送时触发。
 *   > **关闭后机器人无法向该用户发送主动消息。**
 *
 * 也就是说：**有好友 ≠ 能主动发**。用户可以在资料卡里单独关掉推送。
 * 所以这里必须分两列存，判定时先看好友、再看推送开关。
 *
 * 群聊同理，`GROUP_MSG_REJECT` / `GROUP_MSG_RECEIVE` 是**群的属性**
 * （事件体只有 `group_openid` + `op_member_openid`，没有目标用户），
 * 所以群维度单独一张表，不挂在人身上。
 *
 * ── 三个值，不是两个 ──
 *
 * `1` 已知可以、`0` 已知不可以、`null` 未知。
 *
 * **`null` 绝不能当 `0` 用**：群里聊过的人很可能早就加了好友，只是还没私聊过。
 * 把未知当不可，会让主动搭话永远开不了口；把未知当可，最多发失败一次
 * ——两害相权，未知应该放行，失败再记下来。
 *
 * ── 存 JSON 不存 SQLite ──
 *
 * 一个机器人几百个好友，几十 KB，读多写少。框架里已有 `quota.json`
 * 的先例（`outbound.js` 的 QuotaLedger），同一套「内存缓存 + 延迟落盘」，
 * 不引迁移、能手改、出问题能直接删。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('reach');

/** 落盘延迟。好友变动是低频事件，攒一下再写，避免连续事件写多次盘 */
const SAVE_DELAY_MS = 500;

/**
 * 用户档案条数上限。正常部署远远到不了，纯粹防「事件风暴把文件写爆」。
 * 超了按 `updatedAt` 丢最旧的。
 */
const MAX_USERS = 5000;

/** 值归一：只认 1 / 0 / null，别的一律当未知 */
function tri(v) {
  if (v === 1 || v === true) return 1;
  if (v === 0 || v === false) return 0;
  return null;
}

/**
 * @param {object} p
 * @param {string} p.file  reach.json 的路径（每鸟一份）
 */
export function createReach({ file }) {
  /** @type {{users: Record<string, object>, groups: Record<string, object>}|null} */
  let data = null;
  let dirty = false;
  let timer = null;

  async function load() {
    if (data) return data;
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'));
      const users = raw?.users && typeof raw.users === 'object' ? raw.users : {};
      // 手改文件写错类型时不至于让判定崩掉，一律归一成 1 / 0 / null
      for (const u of Object.values(users)) {
        if (!u || typeof u !== 'object') continue;
        u.friend = tri(u.friend);
        u.c2cPush = tri(u.c2cPush);
      }
      const groups = raw?.groups && typeof raw.groups === 'object' ? raw.groups : {};
      for (const g of Object.values(groups)) {
        if (!g || typeof g !== 'object') continue;
        g.push = tri(g.push);
      }
      data = { users, groups };
    } catch {
      data = { users: {}, groups: {} };
    }
    return data;
  }

  function scheduleSave() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch((e) => log.warn('可达性写盘失败:', e.message));
    }, SAVE_DELAY_MS);
    timer.unref?.();
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!dirty || !data) return;
    dirty = false;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      log.warn('可达性写盘失败:', e.message);
    }
  }

  /** 取或建一个用户档案 */
  function slot(users, openid) {
    const id = String(openid ?? '').trim();
    if (!id) return null;
    users[id] ??= { friend: null, c2cPush: null, unionOpenid: '', evidence: '', updatedAt: 0 };
    return users[id];
  }

  /** 超出上限时按 updatedAt 丢最旧的 */
  function trim(users) {
    const ids = Object.keys(users);
    if (ids.length <= MAX_USERS) return;
    ids
      .sort((a, b) => (users[a].updatedAt ?? 0) - (users[b].updatedAt ?? 0))
      .slice(0, ids.length - MAX_USERS)
      .forEach((id) => delete users[id]);
  }

  return {
    /**
     * `FRIEND_ADD`：用户加了机器人。
     *
     * 这是**唯一能拿到 `union_openid` 的地方**（消息事件里也可能有，但经常是空串）。
     * 顺手存下来，将来跨机器人关联人物时用得上。
     */
    async noteFriendAdd({ openid, unionOpenid = '', scene = 0 } = {}) {
      const d = await load();
      const u = slot(d.users, openid);
      if (!u) return false;
      u.friend = 1;
      // 空串不覆盖已有的值——消息事件里 union_openid 常常是空的
      if (unionOpenid) u.unionOpenid = String(unionOpenid);
      u.evidence = `friend_add:${scene}`;
      u.updatedAt = Date.now();
      trim(d.users);
      scheduleSave();
      return true;
    },

    /** `FRIEND_DEL`：用户删了机器人。这时私聊一定发不出去 */
    async noteFriendDel({ openid } = {}) {
      const d = await load();
      const u = slot(d.users, openid);
      if (!u) return false;
      u.friend = 0;
      u.evidence = 'friend_del';
      u.updatedAt = Date.now();
      scheduleSave();
      return true;
    },

    /**
     * `C2C_MSG_REJECT` / `C2C_MSG_RECEIVE`：用户在资料卡里关/开了主动推送。
     *
     * 注意这是**独立于好友关系**的一层：好友还在，但推送被关了，照样发不出去。
     */
    async noteC2cPush({ openid, on } = {}) {
      const d = await load();
      const u = slot(d.users, openid);
      if (!u) return false;
      u.c2cPush = on ? 1 : 0;
      u.evidence = on ? 'c2c_msg_receive' : 'c2c_msg_reject';
      u.updatedAt = Date.now();
      scheduleSave();
      return true;
    },

    /**
     * `GROUP_MSG_REJECT` / `GROUP_MSG_RECEIVE`：群管理员关/开了机器人通知。
     *
     * 存群维度，不存人——事件体里只有 `group_openid` 和操作人，
     * 没有「这个开关对谁生效」的概念，它就是对整个群生效。
     */
    async noteGroupPush({ groupOpenid, on, by = '' } = {}) {
      const gid = String(groupOpenid ?? '').trim();
      if (!gid) return false;
      const d = await load();
      d.groups[gid] = {
        push: on ? 1 : 0,
        by: String(by ?? ''),
        evidence: on ? 'group_msg_receive' : 'group_msg_reject',
        updatedAt: Date.now(),
      };
      scheduleSave();
      return true;
    },

    /**
     * 收到这个人的单聊消息 —— 最强证据：他能发，说明好友一定在。
     *
     * 同时把 `c2cPush` 留空而不是置 1：他主动发消息不代表他允许机器人主动推。
     */
    async noteC2cObserved({ openid, unionOpenid = '' } = {}) {
      const d = await load();
      const u = slot(d.users, openid);
      if (!u) return false;
      u.friend = 1;
      if (unionOpenid) u.unionOpenid = String(unionOpenid);
      u.evidence = 'observed_c2c';
      u.updatedAt = Date.now();
      scheduleSave();
      return true;
    },

    /**
     * 主动发送失败了 —— 按 QQ 业务错误码更新状态。
     *
     * 这些码是官方文档里明写的（`/v2/users/{user_openid}/messages` 错误码表），
     * 所以能**精确判定**，不用再靠人猜：
     *
     *   40054004 无好友关系           → is_friend = 0
     *   40054006 验证好友关系失败      → 不改状态（官方建议「重试」）
     *   40054013 用户拒收消息          → c2c_push = 0（对应 C2C_MSG_REJECT）
     *
     * 其它码（频控 40034100、内容违规 40034006、审核……）**一律不改状态**：
     * 它们跟「这个人能不能收到」无关，改了就等于一次抖动永久封掉一个人。
     *
     * @param {object} p
     * @param {string} p.openid
     * @param {number} p.qqCode QQ 业务错误码（不是 HTTP 状态码）
     */
    async noteSendError({ openid, qqCode } = {}) {
      const d = await load();
      const u = slot(d.users, openid);
      if (!u) return false;
      const code = Number(qqCode) || 0;
      u.lastFailAt = Date.now();
      u.lastFailCode = code;

      if (code === 40054004) {
        u.friend = 0;
        u.evidence = 'send:no-friend';
      } else if (code === 40054013) {
        u.c2cPush = 0;
        u.evidence = 'send:rejected';
      }
      // 40054006 只记时间：官方自己都说「请重试」
      u.updatedAt = Date.now();
      scheduleSave();
      return true;
    },

    /** 主动发送成功了 —— 反证「可达」 */
    async noteSendOk({ openid } = {}) {
      const d = await load();
      const u = slot(d.users, openid);
      if (!u) return false;
      u.friend = 1;
      u.lastOkAt = Date.now();
      scheduleSave();
      return true;
    },

    /**
     * 人工标注 —— 面板上手动纠正状态。
     *
     * 为什么必须有这个口子：好友关系的事件是**增量**的，接入之前就存在的关系
     * 永远拿不到事件，状态会一直停在 `null`。线上真出问题时，运维只能靠
     * 「手动发一条试试」来试，而失败的证据又常常和网络/限流混在一起分不清。
     * 与其让人去改 JSON，不如给一个能校验的入口。
     *
     * `friend` / `c2cPush` 传 `undefined` 表示「这项不动」，传 `null` 表示「重置为未知」。
     * 两者语义不同，所以不能用 `??` 或真值判断。
     *
     * @param {object} p
     * @param {string} p.openid
     * @param {1|0|null} [p.friend]
     * @param {1|0|null} [p.c2cPush]
     */
    async noteManual({ openid, friend, c2cPush } = {}) {
      const d = await load();
      const u = slot(d.users, openid);
      if (!u) return false;
      if (friend !== undefined) u.friend = tri(friend);
      if (c2cPush !== undefined) u.c2cPush = tri(c2cPush);
      u.evidence = 'manual';
      u.updatedAt = Date.now();
      trim(d.users);
      scheduleSave();
      return true;
    },

    /**
     * 群维度的人工标注。`push` 传 `undefined` 不动、`null` 重置为未知。
     *
     * @param {object} p
     * @param {string} p.groupOpenid
     * @param {1|0|null} [p.push]
     */
    async noteGroupManual({ groupOpenid, push } = {}) {
      const gid = String(groupOpenid ?? '').trim();
      if (!gid) return false;
      const d = await load();
      const g = d.groups[gid] ?? { push: null, by: '', evidence: '', updatedAt: 0 };
      if (push !== undefined) g.push = tri(push);
      g.evidence = 'manual';
      g.updatedAt = Date.now();
      d.groups[gid] = g;
      scheduleSave();
      return true;
    },

    /**
     * 能不能给这个人发私聊。
     *
     * @returns {{verdict:'yes'|'no'|'unknown', reason?:string}}
     */
    async canC2C(openid) {
      const d = await load();
      const u = d.users[String(openid ?? '').trim()];
      if (!u) return { verdict: 'unknown' };
      if (u.friend === 0) return { verdict: 'no', reason: 'reach:not-friend' };
      if (u.c2cPush === 0) return { verdict: 'no', reason: 'reach:push-off' };
      if (u.friend === 1) return { verdict: 'yes' };
      return { verdict: 'unknown' };
    },

    /**
     * 能不能往这个群主动推。
     *
     * @returns {{verdict:'yes'|'no'|'unknown', reason?:string}}
     */
    async canGroupPush(groupOpenid) {
      const d = await load();
      const g = d.groups[String(groupOpenid ?? '').trim()];
      if (!g) return { verdict: 'unknown' };
      if (g.push === 0) return { verdict: 'no', reason: 'reach:group-push-off' };
      return { verdict: 'yes' };
    },

    /** 单个人档案，面板用 */
    async get(openid) {
      const d = await load();
      return d.users[String(openid ?? '').trim()] ?? null;
    },

    /** 面板用：全量快照（只读副本） */
    async snapshot() {
      const d = await load();
      return { users: { ...d.users }, groups: { ...d.groups } };
    },

    flush,
  };
}

export { tri };
