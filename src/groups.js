import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('groups');
const FILE = path.join(DATA_DIR, 'groups.json');

/**
 * 群信息存储。
 *
 * 官方 v2 接口没有「查询群主 / 群成员」的能力，能拿到的唯一信号是
 * GROUP_ADD_ROBOT 事件里的 op_member_openid —— 把机器人拉进群的那个人。
 * 实践中通常就是群主或管理员，因此把它作为该群的管理者默认值，并允许手动改。
 *
 * 数据结构：
 * {
 *   "<group_openid>": {
 *     groupOpenid, inviterOpenid, ownerOpenid,
 *     enabled, addedAt, lastActiveAt, note
 *
 * 注意：这里**不存权限**。谁能在本群做什么，统一看 roles.json 的 group:<id> 作用域。
 * 群档案只负责「这个群是什么情况」。
 *   }
 * }
 */
export class GroupStore {
  constructor() {
    this.data = null;
    this.dirty = false;
    this.timer = null;
  }

  async #load() {
    if (this.data) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(FILE, 'utf8'));
    } catch {
      this.data = {};
    }
    return this.data;
  }

  #scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 300);
    this.timer.unref?.();
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(this.data, null, 2), 'utf8');
  }

  async all() {
    return await this.#load();
  }

  async list() {
    const d = await this.#load();
    return Object.values(d).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }

  async get(groupOpenid) {
    const d = await this.#load();
    return d[groupOpenid] ?? null;
  }

  async upsert(groupOpenid, patch = {}) {
    if (!groupOpenid) return null;
    const d = await this.#load();
    const cur = d[groupOpenid] ?? {
      groupOpenid,
      inviterOpenid: '',
      ownerOpenid: '', // 官方报文里 member_role=owner 的人，最准
      enabled: true,
      addedAt: Date.now(),
      lastActiveAt: 0,
      note: '',
    };
    d[groupOpenid] = { ...cur, ...patch, groupOpenid };
    this.#scheduleSave();
    return d[groupOpenid];
  }

  /** 机器人被拉进群：只记录邀请者，权限由 roles 单独授予 */
  async onAdded(groupOpenid, inviterOpenid) {
    const cur = await this.get(groupOpenid);
    const g = await this.upsert(groupOpenid, {
      inviterOpenid: inviterOpenid || cur?.inviterOpenid || '',
      enabled: true,
      addedAt: cur?.addedAt ?? Date.now(),
    });
    log.info(`机器人入群 ${groupOpenid}，邀请者 ${inviterOpenid || '未知'}`);
    return g;
  }

  async onRemoved(groupOpenid) {
    await this.upsert(groupOpenid, { enabled: false });
    log.info(`机器人被移出群 ${groupOpenid}`);
  }

  async touch(groupOpenid) {
    const cur = await this.get(groupOpenid);
    if (!cur) {
      // 没记录过（比如入群事件丢了），补一条
      return this.upsert(groupOpenid, { lastActiveAt: Date.now() });
    }
    cur.lastActiveAt = Date.now();
    this.#scheduleSave();
    return cur;
  }

  /** 从消息报文里发现群主（author.member_role === 'owner'） */
  async setOwner(groupOpenid, openid) {
    if (!groupOpenid || !openid) return null;
    const cur = await this.get(groupOpenid);
    if (cur?.ownerOpenid === openid) return cur;
    log.info(`发现群主 ${openid}（群 ${groupOpenid}）`);
    return this.upsert(groupOpenid, { ownerOpenid: openid });
  }

  async setEnabled(groupOpenid, enabled) {
    return this.upsert(groupOpenid, { enabled: Boolean(enabled) });
  }

  async remove(groupOpenid) {
    const d = await this.#load();
    delete d[groupOpenid];
    this.#scheduleSave();
  }

}
