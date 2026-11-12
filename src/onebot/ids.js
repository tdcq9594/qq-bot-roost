/**
 * OneBot ID 映射
 * ===============
 *
 * OneBot 的 `user_id` / `group_id` / `message_id` 都是整数，官方给的是
 * openid（32 位十六进制）和字符串 msg_id。这个模块负责两边换算。
 *
 * 三条规则：
 *
 *   1. **真号优先**：identity 表里有绑定就用真 QQ 号。aurobot 这类客户端
 *      用 `user_id === ownerQQ` 判主人，给合成号等于把主人权限静默关掉。
 *   2. **未绑定给 13 位合成号**：`9_000_000_000_000 + hash`。真 QQ 号最长 12 位，
 *      13 位在数学上撞不上；而且在 JS 安全整数范围内（< 2^53），客户端 `Number()`
 *      不会失真。合成号必须**持久化**，否则重启后同一个人会「换号」。
 *   3. **message_id 计数器必须落盘**。不落盘的话重启后从 1 重新开始，
 *      客户端拿着重启前的 id 调 `delete_msg`，会撤掉**另一条**新消息——
 *      这种错既没法解释也没法撤回。
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, readJsonSafe } from '../fsutil.js';
import { createLogger } from '../logger.js';

const log = createLogger('onebot-ids');

/** 合成号起点：13 位、9 开头 */
const SYNTH_BASE = 9_000_000_000_000;
const SYNTH_MOD = 1_000_000_000_000;

/** 保留多少条消息映射。够 `get_msg` / 引用 / 撤回用即可 */
const MAX_MSGS = 500;

/** 落盘节流：映射变化很频繁，每条都写盘不值当 */
const SAVE_MS = 1000;

export class OneBotIds {
  /**
   * @param {object} p
   * @param {string} p.file       `data/bots/<id>/onebot-ids.json`
   * @param {string} p.botId
   * @param {object} p.identity   IdentityStore（可空：空则一律用合成号）
   */
  constructor({ file, botId, identity = null }) {
    this.file = file;
    this.botId = botId;
    this.identity = identity;
    this.data = null;
    this.dirty = false;
    this.timer = null;
    /** openid → 合成号（反查用） */
    this.synthUsers = new Map();
    this.synthGroups = new Map();
    /** onebot message_id → {m: 官方 msg_id, i: msgIdx, c: chatId, t: 时间} */
    this.msgs = new Map();
    /** 官方 msg_id → onebot message_id（同一条消息重复推送时复用） */
    this.byOfficial = new Map();
    /** msgIdx → onebot message_id（引用回复用） */
    this.byIdx = new Map();
  }

  async load() {
    if (this.data) return this;
    this.data = (await readJsonSafe(this.file, (m) => log.error(m))) ?? {};
    this.data.version ??= 1;
    /**
     * 计数器下限取「当前时间秒」。
     *
     * 落盘是 1 秒节流的，进程被 kill 时最后一批 id 会丢；如果重启后从旧值
     * 继续发，客户端拿着重启前的 id 调 `delete_msg` 就会撤掉**另一条**新消息。
     * 用时间戳兜底：只要重启间隔 > 1s，新 id 一定比旧 id 大，旧 id 只会「查不到」。
     */
    this.data.nextId = Math.max(Number(this.data.nextId) || 1, Math.floor(Date.now() / 1000));
    this.data.users ??= {};
    this.data.groups ??= {};
    this.data.msgs ??= [];

    for (const [openid, id] of Object.entries(this.data.users)) this.synthUsers.set(openid, Number(id));
    for (const [openid, id] of Object.entries(this.data.groups)) this.synthGroups.set(openid, Number(id));
    for (const row of this.data.msgs) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [id, v] = row;
      if (!v || typeof v !== 'object') continue;
      this.msgs.set(Number(id), v);
      if (v.m) this.byOfficial.set(String(v.m), Number(id));
      if (v.i) this.byIdx.set(String(v.i), Number(id));
    }
    return this;
  }

  /* ---------------- 号码 ---------------- */

  /** 合成号：稳定、13 位、9 开头 */
  #synth(openid, bucket) {
    const hit = bucket.get(openid);
    if (hit) return hit;
    const h = crypto.createHash('sha1').update(String(openid)).digest();
    let n = SYNTH_BASE + (h.readUIntBE(0, 6) % SYNTH_MOD);
    // 理论上可能撞（同一机器人下的两个 openid 截断到同一值），撞了就顺延
    const used = new Set([...bucket.values()]);
    while (used.has(n)) n += 1;
    bucket.set(openid, n);
    this.#touch();
    return n;
  }

  /** openid → OneBot user_id（真号优先） */
  user(openid) {
    const id = String(openid ?? '');
    if (!id) return 0;
    const uin = this.identity?.uinOf?.(id) ?? '';
    if (uin) return Number(uin);
    return this.#synth(id, this.synthUsers);
  }

  /** group_openid → OneBot group_id（真号优先） */
  group(groupOpenid) {
    const id = String(groupOpenid ?? '');
    if (!id) return 0;
    const uin = this.identity?.groupUinOf?.(id) ?? '';
    if (uin) return Number(uin);
    return this.#synth(id, this.synthGroups);
  }

  /** OneBot user_id → openid；找不到返回空串 */
  openidOfUser(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return '';
    // 合成号段：只可能是我们发出去的，反查表里一定有
    if (n >= SYNTH_BASE) {
      for (const [openid, v] of this.synthUsers) if (v === n) return openid;
      return '';
    }
    return this.identity?.openidOf?.(this.botId, String(n)) ?? '';
  }

  openidOfGroup(id) {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= SYNTH_BASE) {
      for (const [openid, v] of this.synthGroups) if (v === n) return openid;
      return '';
    }
    return this.identity?.groupOpenidOf?.(this.botId, String(n)) ?? '';
  }

  /* ---------------- 消息 ---------------- */

  /**
   * 给一条入站消息分配（或复用）OneBot message_id。
   *
   * 复用很重要：官方会重复推送同一条消息，客户端拿两个不同 id 会把同一条
   * 当成两条来引用/撤回。
   */
  bindMessage(msg, { noIndex = false } = {}) {
    const official = String(msg?.id ?? '');
    if (official && this.byOfficial.has(official)) return this.byOfficial.get(official);

    const id = this.data.nextId++;
    /**
     * `noIndex`：只借一个号，不登记映射。
     *
     * 历史回放用的是账本行 id（UUID），不是官方 msg_id；登记进去会让
     * `delete_msg` 拿它去撤一条不相干的消息，还会挤掉 500 条配额里的真映射。
     */
    if (noIndex) {
      this.#touch();
      return id;
    }
    const row = {
      m: official,
      i: String(msg?.msgIdx ?? ''),
      c: String(msg?.chatId ?? ''),
      k: String(msg?.kind ?? ''),
      t: Date.now(),
    };
    this.msgs.set(id, row);
    if (official) this.byOfficial.set(official, id);
    if (row.i) this.byIdx.set(row.i, id);

    // 超上限就丢最老的（Map 保持插入顺序）
    while (this.msgs.size > MAX_MSGS) {
      const [oldId, old] = this.msgs.entries().next().value;
      this.msgs.delete(oldId);
      if (old?.m) this.byOfficial.delete(String(old.m));
      if (old?.i) this.byIdx.delete(String(old.i));
    }
    this.#touch();
    return id;
  }

  /** OneBot message_id → {m: 官方 msg_id, i: msgIdx, c: chatId, k: kind, t} */
  getMessage(id) {
    return this.msgs.get(Number(id)) ?? null;
  }

  /**
   * 给「机器人自己发出去的消息」也分配一个 id。
   *
   * 客户端随后会拿它 `delete_msg` / `get_msg`；不登记的话撤回永远失败。
   * 官方没有 msgIdx（那是入站消息才有的引用索引），所以 `i` 留空。
   */
  bindSent({ officialId, chatId, kind }) {
    const official = String(officialId ?? '');
    if (official && this.byOfficial.has(official)) return this.byOfficial.get(official);

    const id = this.data.nextId++;
    const row = { m: official, i: '', c: String(chatId ?? ''), k: String(kind ?? ''), t: Date.now() };
    this.msgs.set(id, row);
    if (official) this.byOfficial.set(official, id);
    while (this.msgs.size > MAX_MSGS) {
      const [oldId, old] = this.msgs.entries().next().value;
      this.msgs.delete(oldId);
      if (old?.m) this.byOfficial.delete(String(old.m));
      if (old?.i) this.byIdx.delete(String(old.i));
    }
    this.#touch();
    return id;
  }

  /** 引用用：msgIdx → OneBot message_id（查不到返回 0） */
  messageIdOfIdx(msgIdx) {
    const i = String(msgIdx ?? '');
    if (!i) return 0;
    return this.byIdx.get(i) ?? 0;
  }

  /* ---------------- 落盘 ---------------- */

  #touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_MS);
    this.timer.unref?.();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.data) return;
    this.dirty = false;
    const out = {
      version: 1,
      nextId: this.data.nextId,
      users: Object.fromEntries(this.synthUsers),
      groups: Object.fromEntries(this.synthGroups),
      // 只留最近 MAX_MSGS 条，别让文件无限长
      msgs: [...this.msgs.entries()].slice(-MAX_MSGS),
    };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeJsonAtomic(this.file, out);
    } catch (e) {
      log.warn(`ID 映射落盘失败（不影响本次运行）：${e.message}`);
    }
  }

  /** 状态快照：面板显示「有多少人/群在用合成号」 */
  stats() {
    return { synthUsers: this.synthUsers.size, synthGroups: this.synthGroups.size, msgs: this.msgs.size };
  }
}
