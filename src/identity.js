/**
 * 身份对照表：QQ号 / 群号 ↔ openid
 * ================================
 *
 * 官方给的是 `openid`——**每个 AppID 一套**，换机器人就全变。QQ 号和群号是稳定的，
 * 但官方报文里一个都不给，也没有任何查询接口。所以只能人工指认一次，框架负责记住、查得快。
 *
 * 为什么这张表必须**全局**（`data/identity.json`，不跟着机器人走）：
 *   它存在的全部意义就是横跨机器人。放进 `data/bots/<id>/` 就等于换机器人那一刻又对不上，
 *   而这个功能要解决的正是那件事。`paths.js` 里「数据按机器人隔离」的注释要记得改，
 *   否则下一个人会把它当 bug 修掉。
 *
 * 三条设计约束：
 *
 *   1. **openid 永远是发送凭据，号码只是识别标签。** 任何地方都不许拿号码去调接口。
 *   2. **未绑定不落盘。** 没有记录就是没绑，查询返回 `bound:false`。否则每来一个新人都要写一次盘。
 *   3. **写入是「读-合并-写」。** 多个机器人进程共享这一个文件，后写的不能把先写的抹掉，
 *      所以落盘前重读一遍，claims 按 `(botId, openid)` 做并集。
 *
 * 数据结构（v1）：
 *
 *   {
 *     "version": 1,
 *     "updatedAt": 1793500000000,
 *     "users":  { "10001":     { uin, status, name, note, claims: [...] } },
 *     "groups": { "763366431": { groupUin, status, name, note, claims: [...] } }
 *   }
 *
 * claim 里的 `botId` 允许空串：旧机器人已经从配置里删掉时，账号迁移页绑出来的记录
 * 没有归属可填。别名计算**不看 botId**，所以照样读得到旧记忆。
 */

import fs from 'node:fs/promises';
import { createLogger } from './logger.js';
import { writeJsonAtomic, readJsonSafe } from './fsutil.js';
import { PATHS } from './paths.js';

const log = createLogger('identity');

/** 文件格式版本。结构变了就 +1，读取时按版本迁移 */
export const DATA_VERSION = 1;

/** 错误码，插件和面板都按它判断，别去匹配 message */
export const UNBOUND = 'IDENTITY_UNBOUND';
export const CONFLICT = 'IDENTITY_CONFLICT';
export const INVALID = 'IDENTITY_INVALID';

/**
 * 号码：QQ 号 5–12 位，群号同量级。一律按字符串存（超大数不会变科学计数法）。
 *
 * **首位不能是 0**：QQ号 / 群号都不以 0 开头，而多打一个 0 是很常见的粘贴错误。
 * 放过去的话会建出一条**查不到的死绑定**——`openidOf('12345')` 找不到
 * 以 `'012345'` 存的记录，面板上看是「已绑定」，用起来就是「没绑」。
 * 挡在入口比事后排查便宜得多。
 *
 * 这条规则 `dsh-roost/src/account.js` 里有一份**逐字相同**的副本
 * （跨包不能直接 import）。改这里必须同步改那边，否则会出现
 * 「这边说没绑、那边说已绑」的鬼打墙。
 */
const UIN_RE = /^[1-9]\d{4,11}$/;

/** 同一个号码最多挂多少条 openid。正常部署（几个机器人）远远到不了，纯防御 */
const MAX_CLAIMS = 50;

/** 已载入时，多久检查一次「文件被别的进程改过」。面板每个请求都会 load()，必须节流 */
const REFRESH_MS = 2000;

/** 单个 openid 的长度上限。不校验字符集——官方哪天换格式，这里不该先炸 */
function isOpenid(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 64 && !/\s/.test(s);
}

/**
 * 从任意形态的键里把号码抠出来。
 *
 * 旧记忆的键不止一种写法，实测见过：
 *
 *   aiocqhttp:GroupMessage:763366431   ← AstrBot 的会话 id
 *   group_763366431                    ← 带前缀
 *   763366431                          ← 纯号码
 *   5559767753895AA8456F848BCC489133   ← 本框架的 openid，**不是号码**
 *
 * 最后一种必须排除：openid 里那串 `5559767753895` 有 13 位数字，
 * 不排除的话会被当成群号，直接把两个不相干的会话并到一起。
 *
 * @returns {string} 号码，认不出来返回空串
 */
export function uinFromKey(key) {
  const s = String(key ?? '').trim();
  if (!s || s.length > 64) return '';
  // 整串就是 openid（32 位 hex）——不是号码
  if (/^[0-9a-f]{32}$/i.test(s)) return '';

  const parts = s.split(/[^0-9a-zA-Z]+/).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (UIN_RE.test(p)) return p;
    // 段里已经是 openid 了，别再往前猜——`x:5559767753895AA84…` 里没有号码
    if (/^[0-9a-f]{32}$/i.test(p)) return '';
  }
  return '';
}

/** 号码是否合法 */
export function isValidUin(v) {
  return UIN_RE.test(String(v ?? '').trim());
}

/**
 * 「没绑定」的错误。
 *
 * message 是**给管理员看的中文**：插件把它直接回给用户也不会显得像崩了。
 * 真正的边界不在这句提示上——插件想自己处理就用 `has()` 先判断，那条路不抛。
 */
export function unboundError({ kind = 'user', uin = '', botId = '' } = {}) {
  const what = kind === 'group' ? '群号' : 'QQ号';
  const bot = botId ? `机器人「${botId}」` : '当前机器人';
  const err = new Error(`${what} ${uin || '(空)'} 还没绑定到${bot}，请管理员在面板「身份」页绑定`);
  err.code = UNBOUND;
  err.kind = kind;
  err.uin = String(uin ?? '');
  err.botId = String(botId ?? '');
  return err;
}

function invalidError(msg, extra = {}) {
  const err = new Error(msg);
  err.code = INVALID;
  Object.assign(err, extra);
  return err;
}

function conflictError(msg, extra = {}) {
  const err = new Error(msg);
  err.code = CONFLICT;
  Object.assign(err, extra);
  return err;
}

/** 空记录 */
function newRecord(kind, uin, now) {
  const base = {
    status: 'active',
    name: '',
    note: '',
    createdAt: now,
    updatedAt: now,
    /** 状态（active/disabled）最后变更的时间，和 `updatedAt` 分开——改备注不该影响它 */
    statusUpdatedAt: now,
    verifiedBy: 'panel',
    verifiedAt: now,
    claims: [],
  };
  return kind === 'group' ? { groupUin: uin, ...base } : { uin, ...base };
}

/** 把磁盘上读到的记录补齐字段，别让半个旧文件把后面的逻辑带崩 */
function normalizeRecord(kind, uin, raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const claims = Array.isArray(r.claims)
    ? r.claims
        .filter((c) => c && isOpenid(c.openid))
        .map((c) => ({
          botId: String(c.botId ?? ''),
          openid: String(c.openid),
          state: c.state === 'revoked' ? 'revoked' : 'active',
          /**
           * **这条必须原样带回来。**
           *
           * 漏了它，合并时只能退回记录级 `updatedAt`，而那个值会被
           * `setNote` / `bind` 这类无关操作顶新——于是「解绑」会被
           * 一个只是改了备注的旧进程覆盖回去。而且丢得毫无声息：
           * 内存里看着是对的，一重启就失效。
           */
          updatedAt: Number(c.updatedAt) || 0,
          firstSeenAt: Number(c.firstSeenAt) || 0,
          lastSeenAt: Number(c.lastSeenAt) || 0,
          seenCount: Number(c.seenCount) || 0,
          scopes: Array.isArray(c.scopes) ? c.scopes.map(String).slice(0, 20) : [],
        }))
    : [];
  return {
    ...(kind === 'group' ? { groupUin: uin } : { uin }),
    status: r.status === 'disabled' ? 'disabled' : 'active',
    name: String(r.name ?? ''),
    note: String(r.note ?? ''),
    createdAt: Number(r.createdAt) || 0,
    updatedAt: Number(r.updatedAt) || 0,
    /**
     * 老数据没有这个字段，回退到 `updatedAt`。
     * 没有它的话，`setNote` 这种无关操作会把 `updatedAt` 顶新，
     * 于是一个只是改了备注的旧进程能把「停用」覆盖回「启用」——
     * 而停用是为了让这个号码的记忆读不到，翻回 active 等于白停。
     */
    statusUpdatedAt: Number(r.statusUpdatedAt) || Number(r.updatedAt) || 0,
    verifiedBy: String(r.verifiedBy ?? 'panel'),
    verifiedAt: Number(r.verifiedAt) || 0,
    claims,
  };
}

export class IdentityStore {
  /** @param {string} file 全局身份表路径（`PATHS.identity`） */
  constructor(file) {
    this.file = file;
    this.data = null;
    this.mtimeMs = 0;
    this.dirty = false;
    this.timer = null;
    /** 写串行化：同一进程里两次 bind 并发时，别让后一次覆盖前一次 */
    this.chain = Promise.resolve();
    /** `${botId}\u0000${openid}` -> uin，热路径只查它 */
    this.userIndex = new Map();
    this.groupIndex = new Map();
    /** 不限机器人的反查：openid -> uin（`uinOf()` 用） */
    this.userByOpenid = new Map();
    this.groupByOpenid = new Map();
    this.loaded = false;
    /** 正在载入的 Promise，并发 load() 共用 */
    this.loading = null;
    /** 上次检查磁盘 mtime 的时间（节流用） */
    this.checkedAt = 0;
    /** 正在写盘：这段时间不许重载，否则会覆盖还没落盘的本地改动 */
    this.flushing = false;
  }

  /* ---------------- 载入 ---------------- */

  /**
   * 载入。并发调用合并成一次——面板的多个请求可能同时触发，
   * 各跑一遍会把彼此的 `this.data` 覆盖掉。
   *
   * 已经载入过时会**顺带检查文件有没有被别的进程改过**（节流）。
   * 不检查的话：一只鸟的面板绑完，另一只鸟（另一个进程）永远看不到，
   * 而文档写的是「多个机器人进程共享这一个文件」——那只对写成立。
   */
  async load() {
    if (this.loaded) {
      await this.#refreshIfChanged();
      return this.data;
    }
    this.loading ??= this.#loadOnce().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /**
   * 磁盘上的文件比内存新就重新读一遍。
   *
   * 两条不做的事：
   *   · **有没落盘的本地改动时不动**（`dirty` / 定时器还在）——
   *     重新载入会把刚 bind 的东西丢掉，比看不到别人的更新严重得多。
   *   · **节流**：`load()` 会被面板的每个请求调到，每次都 stat 一下没必要。
   */
  async #refreshIfChanged() {
    if (this.dirty || this.timer || this.flushing) return;
    const now = Date.now();
    if (now - (this.checkedAt || 0) < REFRESH_MS) return;
    this.checkedAt = now;
    try {
      const m = await this.#mtime();
      if (!m || m === this.mtimeMs) return;
      const raw = await readJsonSafe(this.file, (msg) => log.error(msg));
      this.data = this.#normalizeRoot(raw);
      this.mtimeMs = m;
      this.#rebuildIndexes();
      log.debug?.('身份表被别的进程改过，已重新载入');
    } catch (e) {
      /** 读不到就维持内存里这份，下次再试——不能因为别人写坏了就让自己不可用 */
      log.warn?.(`身份表重载失败，继续用内存里的：${e.message}`);
    }
  }

  async #loadOnce() {
    const raw = await readJsonSafe(this.file, (m) => log.error(m));
    this.data = this.#normalizeRoot(raw);
    this.mtimeMs = await this.#mtime();
    this.#rebuildIndexes();
    this.loaded = true;
    const n = Object.keys(this.data.users).length + Object.keys(this.data.groups).length;
    if (n) log.info(`身份表已载入：${Object.keys(this.data.users).length} 人 / ${Object.keys(this.data.groups).length} 群`);
    return this.data;
  }

  #normalizeRoot(raw) {
    const root = raw && typeof raw === 'object' ? raw : {};
    const out = {
      version: DATA_VERSION,
      updatedAt: Number(root.updatedAt) || 0,
      users: {},
      groups: {},
    };
    /**
     * 号码不合法的记录**丢掉**，但要喊一声。
     *
     * 静默 `continue` 的后果很重：下一次落盘会把整份文件重写，
     * 那条记录就**永久没了**，而用户那边只会看到「我明明绑过」。
     * 号码规则改过一次（首位不能是 0），所以这条不是假想。
     */
    const dropped = [];
    for (const [uin, rec] of Object.entries(root.users ?? {})) {
      if (!isValidUin(uin)) {
        dropped.push(uin);
        continue;
      }
      out.users[uin] = normalizeRecord('user', uin, rec);
    }
    for (const [uin, rec] of Object.entries(root.groups ?? {})) {
      if (!isValidUin(uin)) {
        dropped.push(uin);
        continue;
      }
      out.groups[uin] = normalizeRecord('group', uin, rec);
    }
    if (dropped.length) {
      log.warn(
        `身份表里有 ${dropped.length} 个号码不合法，已跳过（下次落盘会丢掉它们）：${dropped.slice(0, 5).join('、')}`,
      );
    }
    return out;
  }

  async #mtime() {
    try {
      return (await fs.stat(this.file)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 重建索引。
   *
   * 只索引 `status === 'active'` 且 `claim.state === 'active'` 的条目——
   * 停用和解绑过的必须查不到，否则「解绑」等于没解。
   */
  #rebuildIndexes() {
    this.userIndex.clear();
    this.groupIndex.clear();
    this.userByOpenid.clear();
    this.groupByOpenid.clear();
    const fill = (recs, index, byOpenid) => {
      for (const [uin, rec] of Object.entries(recs)) {
        if (rec.status !== 'active') continue;
        for (const c of rec.claims) {
          if (c.state !== 'active') continue;
          index.set(`${c.botId}\u0000${c.openid}`, uin);
          // 反查不限机器人：同一个 openid 只可能属于一个号码，先到先得
          if (!byOpenid.has(c.openid)) byOpenid.set(c.openid, uin);
        }
      }
    };
    fill(this.data.users, this.userIndex, this.userByOpenid);
    fill(this.data.groups, this.groupIndex, this.groupByOpenid);
  }

  /* ---------------- 查询（同步，热路径） ---------------- */

  /** 这个人是谁。未绑定返回 null */
  resolveUser(botId, openid) {
    if (!this.loaded || !openid) return null;
    const uin = this.userIndex.get(`${botId ?? ''}\u0000${openid}`);
    if (!uin) return null;
    return { uin, identityId: `u:${uin}`, record: this.data.users[uin] ?? null };
  }

  /** 这个群是哪个群。未绑定返回 null */
  resolveGroup(botId, groupOpenid) {
    if (!this.loaded || !groupOpenid) return null;
    const uin = this.groupIndex.get(`${botId ?? ''}\u0000${groupOpenid}`);
    if (!uin) return null;
    return { uin, identityId: `g:${uin}`, record: this.data.groups[uin] ?? null };
  }

  /** openid → QQ号，**不限机器人**。查不到返回空串 */
  uinOf(openid) {
    return this.userByOpenid.get(String(openid ?? '')) ?? '';
  }

  /** group_openid → 群号，不限机器人 */
  groupUinOf(groupOpenid) {
    return this.groupByOpenid.get(String(groupOpenid ?? '')) ?? '';
  }

  /** 号码是否有有效绑定 */
  has(kind, uin) {
    const rec = this.#rec(kind, uin);
    return Boolean(rec && rec.status === 'active' && rec.claims.some((c) => c.state === 'active'));
  }

  /** 某个机器人下这个号码对应的 openid。取 `lastSeenAt` 最新的那条 */
  openidOf(botId, uin) {
    const rec = this.#rec('user', uin);
    return this.#pickClaim(rec, botId)?.openid ?? '';
  }

  groupOpenidOf(botId, groupUin) {
    const rec = this.#rec('group', groupUin);
    return this.#pickClaim(rec, botId)?.openid ?? '';
  }

  /**
   * 和 `openidOf` 一样，但**没绑定就抛**。
   *
   * 插件要的正是这个：`ctx.identity.openidOf('10001')` 未绑定时不该返回空串
   * 让调用方自己去猜，而是一句能直接回给管理员的话。
   */
  requireOpenid({ kind = 'user', botId = '', uin = '' } = {}) {
    const openid = kind === 'group' ? this.groupOpenidOf(botId, uin) : this.openidOf(botId, uin);
    if (!openid) throw unboundError({ kind, uin, botId });
    return openid;
  }

  #rec(kind, uin) {
    if (!this.loaded) return null;
    const key = String(uin ?? '').trim();
    return kind === 'group' ? (this.data.groups[key] ?? null) : (this.data.users[key] ?? null);
  }

  /**
   * 挑「当前生效」的那条 claim。
   *
   * 按 `lastSeenAt` 取最新（真正在用的那条），相等时**后追加的优先**——
   * 同一毫秒里连绑两条（换 AppID 后立刻补绑）时时间戳一样，
   * 用 `>` 会选到旧的那条，发消息就发到已经作废的 openid 上了。
   */
  #pickClaim(rec, botId) {
    if (!rec || rec.status !== 'active') return null;
    const bot = String(botId ?? '');
    let best = null;
    for (const c of rec.claims) {
      if (c.state !== 'active' || String(c.botId) !== bot) continue;
      if (!best || (c.lastSeenAt || 0) >= (best.lastSeenAt || 0)) best = c;
    }
    return best;
  }

  /**
   * 读旧记忆用的备用键：号码本身 + 这个号码名下的所有 openid。
   *
   * 为什么不带 botId 过滤：换机器人之后要读的正是**旧机器人**那些键。
   * 只取 active 的 claim——解绑过的不该再被读到。
   *
   * @param {'user'|'group'} kind
   * @param {string} uin
   * @param {string} [current] 当前会话的 chatId，已经在读，不必重复
   * @returns {string[]}
   */
  aliasesOf(kind, uin, current = '') {
    const rec = this.#rec(kind, uin);
    const id = String(uin ?? '').trim();
    /**
     * **停用**的记录一条都不给。
     *
     * `resolveUser` / `openidOf` 都按 `status === 'active'` 判，只有这里不判的话，
     * 会出现「停用了还读得到旧记忆」——面板上查不到这个号码，AI 却照样
     * 把它的记忆读出来，两处说法不一致，排查时根本想不到是这里。
     */
    if (rec && rec.status !== 'active') return [];
    /**
     * 没绑过的号码**仍然返回号码本身**：旧记忆的键可能就是一个纯号码
     * （早期手工配的、别的框架迁过来的），那时候根本不会有 claim。
     * 返回空等于把那份记忆永久锁死。
     */
    const out = [];
    const push = (v) => {
      const s = String(v ?? '').trim();
      if (s && s !== String(current ?? '') && !out.includes(s)) out.push(s);
    };
    push(id);
    if (rec) for (const c of rec.claims) if (c.state === 'active') push(c.openid);
    return out;
  }

  /* ---------------- 写入 ---------------- */

  /**
   * 绑定。已存在同一个 `(botId, openid)` 属于别人时抛冲突，除非 `force`。
   *
   * `force` 的语义是「改绑」：旧记录那条 claim 标 `revoked`，留痕，不删。
   *
   * **绑定 = 启用**：对一条 `disabled` 的记录调 `bind` 会把它改回 `active`。
   * 这是刻意的——`has()` / `resolveUser` 都要求 `status === 'active'`，
   * 不这么做会出现「明明绑了却查不到」的鬼打墙。
   * 副作用要知道：给已停用的号码**补绑一条新 openid**（换 AppID 的常规操作）
   * 会顺带把这个号码重新启用，记忆又开始被读到。面板上会提示。
   */
  async bind({ kind = 'user', uin, openid, botId = '', force = false, verifiedBy = 'panel' } = {}) {
    const id = String(uin ?? '').trim();
    if (!isValidUin(id)) throw invalidError(`号码不合法：${uin}（要 5–12 位数字）`, { kind, uin: id });
    if (!isOpenid(openid)) throw invalidError('openid 不合法（空、过长或含空白）', { kind, uin: id });
    await this.load();

    const table = kind === 'group' ? this.data.groups : this.data.users;
    const now = Date.now();

    // 这个 openid 是不是已经属于别的号码了
    const owner = this.#ownerOf(kind, botId, openid);
    if (owner && owner !== id) {
      if (!force) {
        throw conflictError(`这个 openid 已经绑到 ${kind === 'group' ? '群号' : 'QQ号'} ${owner} 了`, {
          kind,
          uin: id,
          openid,
          owner,
        });
      }
      const old = table[owner];
      const c = old?.claims.find((x) => x.botId === String(botId ?? '') && x.openid === openid);
      if (c) {
        c.state = 'revoked';
        c.updatedAt = now;
        old.updatedAt = now;
      }
      log.info(`改绑：openid ${openid} 从 ${owner} 转到 ${id}（${botId || '无归属'}）`);
    }

    const rec = table[id] ?? (table[id] = newRecord(kind, id, now));
    const sameBot = rec.claims.filter((c) => c.botId === String(botId ?? '') && c.state === 'active');
    const hit = rec.claims.find((c) => c.botId === String(botId ?? '') && c.openid === openid);

    if (hit) {
      hit.state = 'active';
      hit.updatedAt = now;
      hit.lastSeenAt = now;
    } else {
      /**
       * 同一个机器人下已经有一条 active 的旧 openid：**不撤销**。
       *
       * 换 AppID 之后旧的那条是读旧记忆唯一的线索（别名靠它），
       * 撤掉就等于「绑完记忆全没了」。所以只追加，旧的留着。
       */
      if (sameBot.length >= MAX_CLAIMS) {
        throw invalidError(`同一个机器人下最多 ${MAX_CLAIMS} 条 openid，先解绑一些`, { kind, uin: id });
      }
      rec.claims.push({
        botId: String(botId ?? ''),
        openid,
        state: 'active',
        /**
         * 每条 claim 自己记时间。
         *
         * 合并时**按 claim 比新旧**，不是整条记录比一次。整条比的话：
         * 进程 B 给同一个号码追加一条新 openid → B 的 `updatedAt` 变新 →
         * 整条记录按 B 的版本走 → B 内存里那条「还没收到解绑通知」的
         * active claim 就把 A 刚做的解绑覆盖回去。解绑看起来成功了，重启又活了。
         */
        updatedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 0,
        scopes: [],
      });
    }

    /** 绑定等于「这个号码是活的」，所以状态时间也要跟着走（否则会被停用覆盖回去） */
    rec.status = 'active';
    rec.statusUpdatedAt = now;
    rec.updatedAt = now;
    /** panel = 主人在面板/管理员指认；email = 成员自己用 QQ 邮箱验证码验证 */
    rec.verifiedBy = String(verifiedBy || 'panel');
    rec.verifiedAt = now;
    if (!rec.createdAt) rec.createdAt = now;

    this.#rebuildIndexes();
    this.#scheduleSave();
    return rec;
  }

  /** 解绑：把这个号码在某个机器人下的 claim 全标 revoked，记录本身留着 */
  async unbind({ kind = 'user', uin, botId = '' } = {}) {
    const id = String(uin ?? '').trim();
    await this.load();
    const rec = this.#rec(kind, id);
    if (!rec) return null;
    const now = Date.now();
    let n = 0;
    for (const c of rec.claims) {
      if (String(c.botId) === String(botId ?? '') && c.state === 'active') {
        c.state = 'revoked';
        c.updatedAt = now;
        n += 1;
      }
    }
    if (n) {
      rec.updatedAt = now;
      this.#rebuildIndexes();
      this.#scheduleSave();
    }
    return { record: rec, revoked: n };
  }

  /** 启用 / 停用整条记录 */
  async setStatus({ kind = 'user', uin, status } = {}) {
    const id = String(uin ?? '').trim();
    await this.load();
    const rec = this.#rec(kind, id);
    if (!rec) return null;
    rec.status = status === 'disabled' ? 'disabled' : 'active';
    rec.updatedAt = Date.now();
    rec.statusUpdatedAt = rec.updatedAt;
    this.#rebuildIndexes();
    this.#scheduleSave();
    return rec;
  }

  /** 改备注名 / 备注 */
  async setNote({ kind = 'user', uin, name, note } = {}) {
    const id = String(uin ?? '').trim();
    await this.load();
    const rec = this.#rec(kind, id);
    if (!rec) return null;
    if (name !== undefined) rec.name = String(name ?? '').slice(0, 64);
    if (note !== undefined) rec.note = String(note ?? '').slice(0, 200);
    rec.updatedAt = Date.now();
    this.#scheduleSave();
    return rec;
  }

  /**
   * 记一次「见过」。
   *
   * 只改内存、只标 dirty，由 300ms 的延迟落盘合并成一次写——
   * 每条群消息都写盘的话，磁盘会被这一个文件打满。
   *
   * 再加一层 60 秒节流：同一条 claim 一分钟内只更新一次。
   * 热聊的群一分钟几百条消息，没有这层的话 `dirty` 会被反复点亮，
   * 落盘就变成「一直在写」。`lastSeenAt` 精确到分钟对面板和 `openidOf` 都够用。
   */
  touch({ kind = 'user', uin, botId = '', scope = '' } = {}) {
    if (!this.loaded) return;
    const rec = this.#rec(kind, uin);
    if (!rec) return;
    const c = rec.claims.find((x) => x.botId === String(botId ?? '') && x.state === 'active');
    if (!c) return;
    const now = Date.now();
    const fresh = now - (c.lastSeenAt || 0) < 60_000;
    if (fresh && (!scope || c.scopes.includes(scope))) return;
    if (!fresh) {
      c.lastSeenAt = now;
      c.seenCount = (c.seenCount || 0) + 1;
    }
    if (scope && !c.scopes.includes(scope)) {
      c.scopes = [...c.scopes, scope].slice(-20);
    }
    this.#scheduleSave();
  }

  #ownerOf(kind, botId, openid) {
    const table = kind === 'group' ? this.data.groups : this.data.users;
    for (const [uin, rec] of Object.entries(table)) {
      if (rec.claims.some((c) => c.state === 'active' && c.botId === String(botId ?? '') && c.openid === openid)) {
        return uin;
      }
    }
    return '';
  }

  /* ---------------- 列表 ---------------- */

  /** 全部记录（面板用）。不给 kind 就人+群一起给 */
  async list(kind = '') {
    await this.load();
    const out = [];
    if (kind !== 'group') {
      for (const [uin, rec] of Object.entries(this.data.users)) out.push({ kind: 'user', uin, ...rec });
    }
    if (kind !== 'user') {
      for (const [uin, rec] of Object.entries(this.data.groups)) out.push({ kind: 'group', uin, ...rec });
    }
    return out;
  }

  /** 某个机器人下已经绑过的 openid 集合，面板算「未识别」时用 */
  async boundOpenids(botId) {
    await this.load();
    const users = new Set();
    const groups = new Set();
    const walk = (recs, set) => {
      for (const rec of Object.values(recs)) {
        for (const c of rec.claims) {
          if (c.state === 'active' && String(c.botId) === String(botId ?? '')) set.add(c.openid);
        }
      }
    };
    walk(this.data.users, users);
    walk(this.data.groups, groups);
    return { users, groups };
  }

  /* ---------------- 落盘 ---------------- */

  #scheduleSave() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => log.error(`身份表写盘失败：${e.message}`));
    }, 300);
    this.timer.unref?.();
  }

  /** 立即落盘。写前重读磁盘，把别的进程写进去的 claims 并进来 */
  async flush() {
    /**
     * 两个回调都要给：上一次写盘失败会让 `chain` 变成 rejected，
     * 之后每次 `.then(fn)` 都直接跳过——身份表就永远不再落盘了。
     */
    this.chain = this.chain.then(
      () => this.#flushOnce(),
      () => this.#flushOnce()
    );
    return this.chain;
  }

  async #flushOnce() {
    if (!this.dirty || !this.data) return;
    this.dirty = false;
    /**
     * 写盘期间不许刷新。
     *
     * `dirty` 已经置 false 了，但改动还在内存里、还没写到盘上。
     * 这段时间里如果 `load()` 走了「磁盘更新了就重载」，本地改动会被覆盖掉。
     * 窗口只有一次 stat 那么宽，压测没复现过，但路径是通的——
     * 而且丢的是用户刚做的绑定，代价太高。
     */
    this.flushing = true;
    try {
      /**
       * 写前重读：别的机器人进程可能刚写过。
       *
       * **必须无条件重读，不能拿 mtime 做「磁盘变没变」的判断。**
       * `mtimeMs` 只有毫秒精度（Windows 上尤其粗），同一毫秒里连着两次落盘
       * mtime 一模一样 → 判定「磁盘没变」→ 不重读 → 用内存里的旧状态整份覆盖，
       * 别的进程刚做的解绑 / 停用就被翻回去了。
       * 这不是假想：CI 的 Windows + Node 22 上两条「旧进程不许复活解绑」的
       * 用例稳定复现，第一次报 21 号、重跑报 35 号——同一毫秒内谁先谁后看运气。
       *
       * 代价可控：落盘本来就有 300ms 节流、只在 `dirty` 时跑，多读一个小 JSON
       * 可以忽略；文件不存在 / 读坏时 `readJsonSafe` 返回 null，归一化成空表，
       * 合并结果仍是内存这份，不会丢。
       */
      const raw = await readJsonSafe(this.file, (m) => log.error(m));
      const disk = this.#normalizeRoot(raw);
      this.data = this.#merge(this.data, disk);
      this.#rebuildIndexes();

      this.data.version = DATA_VERSION;
      this.data.updatedAt = Date.now();
      await writeJsonAtomic(this.file, this.data);
      this.mtimeMs = await this.#mtime();
    } catch (e) {
      this.dirty = true;
      throw e;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 合并两份数据。
   *
   * claims 按 `(botId, openid)` 做**并集**——这是多进程不丢更新的关键：
   * 两只鸟同时绑不同的人，后写的那次不会把先写的抹掉。
   * 记录级字段（name/note/status）取 `updatedAt` 较新的那份。
   *
   * **重复的 claim 按它自己的 `updatedAt` 比新旧，平局时撤销优先。**
   *
   * 为什么不能整条记录比一次（以前的做法）：进程 B 给同一个号码**追加**
   * 一条新 openid（换机器人时的标准操作）→ B 的 `updatedAt` 变新 →
   * 整条记录按 B 的版本走 → B 内存里那条「还没收到解绑通知」的 active claim
   * 把 A 刚做的解绑覆盖回去。表现是「解绑成功了，重启又活了」。
   *
   * 平局偏向 revoked 也是刻意的：撤销是**删除类**动作，宁可多撤销一条
   * （用户再绑一次就好），也不能让一个已经删掉的绑定自己复活。
   */
  #merge(mine, theirs) {
    const out = { version: DATA_VERSION, updatedAt: Math.max(mine.updatedAt || 0, theirs.updatedAt || 0), users: {}, groups: {} };
    /**
     * 老数据没有 claim 级时间时的回退。
     *
     * **不能退回记录级 `updatedAt`**：那个值会被 `setNote` / `bind` 这类
     * 无关操作顶新，于是「解绑」会被一个只是改了备注的旧进程盖回去。
     * 退回这条 claim 自己的活动时间（`lastSeenAt` / `firstSeenAt`），
     * 都没有就返回 0——两边都 0 时会走「平局撤销优先」，
     * 和这个函数本来的取向一致：删除类动作不该被自动撤销。
     */
    /**
     * **不用 `lastSeenAt` 回退。**
     *
     * `lastSeenAt` 是心跳：`touch()` 每收到一条消息就写它，不写 `updatedAt`。
     * 对没有 `updatedAt` 的老 claim，一个陈旧进程只要**收到这个人一条消息**，
     * 就能把 `lastSeenAt` 顶到解绑之后，merge 时 active 赢过 revoked——
     * 表现是「解绑了，那个人一说话又绑回来了」。
     * 只用「状态真正变过的时间」，没有就 0（走平局撤销优先）。
     */
    const atOf = (c) => Number(c.updatedAt) || Number(c.firstSeenAt) || 0;
    for (const table of ['users', 'groups']) {
      const a = mine[table] ?? {};
      const b = theirs[table] ?? {};
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const uin of keys) {
        const ra = a[uin];
        const rb = b[uin];
        if (!ra) { out[table][uin] = rb; continue; }
        if (!rb) { out[table][uin] = ra; continue; }
        const [first, second] = (rb.updatedAt || 0) > (ra.updatedAt || 0) ? [rb, ra] : [ra, rb];
        const claims = [];
        /** key → 在 `claims` 里的下标 */
        const idx = new Map();
        const take = (c) => {
          const k = `${c.botId}\u0000${c.openid}`;
          const pos = idx.get(k);
          if (pos === undefined) {
            idx.set(k, claims.length);
            claims.push(c);
            return;
          }
          const cur = claims[pos];
          const ta = atOf(c);
          const tb = atOf(cur);
          // 新的一侧胜出；时间相同则撤销优先（删除类动作不该被自动撤销）
          const win = ta > tb || (ta === tb && c.state === 'revoked' && cur.state !== 'revoked');
          if (!win) return;
          claims[pos] = c;
        };
        for (const c of first.claims ?? []) take(c);
        for (const c of second.claims ?? []) take(c);
        /**
         * 状态单独合：按 `statusUpdatedAt` 比，不跟记录级 `updatedAt` 走。
         * 平局偏向 `disabled`——停用是为了让这个号码的记忆读不到，
         * 翻回 active 等于白停，比多停一次严重。
         */
        const sa = Number(ra.statusUpdatedAt) || Number(ra.updatedAt) || 0;
        const sb = Number(rb.statusUpdatedAt) || Number(rb.updatedAt) || 0;
        const status =
          sa === sb
            ? ra.status === 'disabled' || rb.status === 'disabled'
              ? 'disabled'
              : first.status
            : (sa > sb ? ra : rb).status;
        /**
         * `statusUpdatedAt` 取两边的**最大值**，不能跟着 `first` 走。
         *
         * `first` 是按记录级 `updatedAt` 选的，而那个值会被 `setNote` 顶新。
         * 跟着它走会把停用时间**往回写**（比如从 200 退回 100），
         * 之后任何一个 `statusUpdatedAt` 落在中间（120）的陈旧进程一落盘，
         * 就能把停用翻回 active。时间只进不退，才谈得上单调。
         */
        out[table][uin] = { ...first, status, statusUpdatedAt: Math.max(sa, sb), claims };
      }
    }
    return out;
  }

  /** 观测用 */
  snapshot() {
    return {
      loaded: this.loaded,
      file: this.file,
      users: this.loaded ? Object.keys(this.data.users).length : 0,
      groups: this.loaded ? Object.keys(this.data.groups).length : 0,
      index: this.userIndex.size + this.groupIndex.size,
      dirty: this.dirty,
    };
  }

  /** 退出时把没写的写掉 */
  async close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await this.flush();
    } catch {
      /* 退出阶段，忽略 */
    }
  }
}

/**
 * 进程级单例。
 *
 * 一个进程里可能同时跑好几只鸟，但它们共用**同一个** `identity.json`。
 * 每只鸟各建一个实例的话，同一份数据会有好几个内存副本互相覆盖——
 * 虽然 `flush()` 的「写前重读」能兜住，但那是给跨进程准备的兜底，
 * 没必要让同进程也走这条路。
 *
 * 注意：`file` 只在第一次调用时生效，之后忽略。
 */
let shared = null;
export function sharedIdentity(file = PATHS.identity) {
  shared ??= new IdentityStore(file);
  return shared;
}
