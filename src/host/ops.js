/**
 * 宿主协议：ai-chat 等价能力 + 插件全生命周期
 * ==========================================
 *
 * ai-chat 插件以前给 dsh-roost 开了四条「桥」（见它 index.js 的 registerRoute）：
 *   /r/context（取邻文）、/r/delivery（查投递终态）、/r/send（主动发）、
 *   /r/status（探活）。加上它自己读的 ctx.ledger / ctx.delivery / ctx.reach /
 *   ctx.levelOf / ctx.storage，合起来就是「宿主替代 ai-chat」必须等价拿到的能力。
 *
 * 这里把这些能力做成协议方法，全部复用框架里已有的对象与方法，不另起一套：
 * 账本读的还是 `R.ledger`，投递读的还是 `R.delivery.family()`，
 * 权限算的还是 `R.roles.effective()`，插件市场用的还是 `plugin/market.js`。
 *
 * 注意本轮**不含**框架设置 / 运维动作的全量暴露（全局配置、更新、重启等），
 * 按 2026-11-12 的收窄先只对齐 ai-chat；那部分留到后续版本。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from '../paths.js';
import { saveBotConfig } from '../config.js';
import { FILE_TYPE } from '../api.js';
import {
  fetchIndex, installPlugin, syncRepo, cleanupRepo, updatePlugins,
  mergeWithInstalled, detectUpdates, compareVersion, isOfficialSource,
} from '../plugin/market.js';
import { resolveTrust, blockReason } from '../trust.js';
import { suspendPluginWatch } from '../services/plugin-watch.js';
import { toggleGroupPlugin } from '../plugin/groupscope.js';
import { scopeOf, levelName, NO_PERM } from '../roles.js';

const str = (v, d = '') => (v === undefined || v === null ? d : String(v));
const clamp = (v, d, max) => Math.min(max, Math.max(0, Number(v ?? d) || 0));

/** 插件 id 白名单：和面板 isSafeId 同口径，防路径穿越 */
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function safeId(v, err) {
  const id = str(v).trim();
  if (!SAFE_ID.test(id)) throw err.bad(`插件 id 不合法：${id || '(空)'}`);
  return id;
}

/**
 * 权限档位。数值语义来自 `src/levels.js`（0 主人 / 1 管理员 / 2 群管 / 3 助手），
 * 字符串沿用 ai-chat 的 `bucketOfLevel()`——dsh-roost 已经在按这几个词判权限，
 * 换名字等于静默降权。**算不准就返回 null**，让宿主按「身份不明」处理。
 */
function bucketOfLevel(lv) {
  if (lv === null || lv === undefined || lv === '') return '';
  const n = Number(lv);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n <= 0) return 'owner';
  if (n <= 1) return 'admin';
  if (n <= 2) return 'manager';
  if (n <= 3) return 'helper';
  return 'member';
}

/**
 * 面板的 `ensurePluginInList` 是闭包里的内部函数，这里按同样规则实现一份：
 * 只改配置里的启用名单 + 同步内存 filter，**不碰运行时加载**。
 * 装插件时先加名单、再交给 rescan 加载，顺序反了 rescan 会认为「已经加载」
 * 而跳过，前端就会误报安装失败。
 */
async function ensurePluginInList(R, id, enabled, err) {
  const spec = R.cfg?.plugins ?? { mode: 'all', list: [] };
  let mode = spec.mode ?? 'all';
  let list = new Set(spec.list ?? []);
  let changed = false;

  if (enabled) {
    if (mode === 'include' && !list.has(id)) { list.add(id); changed = true; }
    else if (mode === 'exclude' && list.has(id)) { list.delete(id); changed = true; }
  } else if (mode === 'include' && list.has(id)) { list.delete(id); changed = true; }
  else if (mode === 'exclude' && !list.has(id)) { list.add(id); changed = true; }
  else if (mode === 'all') { mode = 'exclude'; list = new Set([id]); changed = true; }

  if (!changed) return false;
  R.cfg.plugins = { ...spec, mode, list: [...list] };
  /** 动态 import：bot.js → host/index.js → methods.js → ops.js 是一条环，
   *  顶层静态导入会拿到未初始化的绑定。调用时再取，模块早已就绪。 */
  const { pluginFilterOf } = await import('../bot.js');
  if (R.plugins) R.plugins.filter = pluginFilterOf(R.cfg.plugins);
  await saveBotConfig(R.id, R.cfg);
  return true;
}

/** 市场写操作的共同前置：最新索引 + 信任闸 */
async function freshIndex(R, err) {
  const src = R.globalCfg?.plugins?.marketUrl || undefined;
  const idx = await fetchIndex(src, { trust: resolveTrust(R.globalCfg ?? {}), maxAge: 0 });
  return { src, idx };
}

function trustGate(R, idx, src, id, err) {
  const official = isOfficialSource(src, R.globalCfg ?? {});
  const why = blockReason(
    resolveTrust(R.globalCfg ?? {}),
    idx?._trust?.status || 'unavailable',
    id,
    { official },
  );
  if (why) throw err.forbidden(why);
}

/**
 * @param {(name,scope,desc,run)=>void} def
 * @param {object} ctx
 * @param {object} ctx.R    BotRuntime
 * @param {object} ctx.err  { bad, notFound, notReady, forbidden }
 * @param {(s:string)=>void} [ctx.log]
 */
export function registerOps(def, { R, err, log = () => {} }) {
  const plugins = () => {
    if (!R.plugins) throw err.notReady('插件管理器未就绪');
    return R.plugins;
  };
  const ledger = () => {
    if (!R.ledger) throw err.notReady('事件账本未就绪');
    return R.ledger;
  };

  /* ---------------- ai-chat 的四条桥 ---------------- */

  def('ledger.context', 'read', '按 eventId 取原文与前后邻文（ai-chat /r/context 等价）', async (p) => {
    const aroundId = str(p.aroundId).trim();
    if (!aroundId) throw err.bad('要给 aroundId（事件账本里的 id）');
    const L = ledger();
    const row = L.get(aroundId);
    if (!row) {
      return {
        ok: false, gone: true,
        message: '找不到这条事件——可能超过保留期被滚动删了，证据快照还在记忆里',
      };
    }
    const items = L.timeline({
      chatId: row.chat_id,
      anchorSeq: row.seq,
      before: clamp(p.before, 2, 10),
      after: clamp(p.after, 2, 10),
    });
    return {
      ok: true,
      anchor: { id: row.id, seq: row.seq, at: row.at, chatId: row.chat_id },
      items,
    };
  });

  def('ledger.timeline', 'read', '按会话与 seq 取前后文', async (p) => ({
    items: ledger().timeline({
      chatId: str(p.chatId),
      anchorSeq: Number(p.anchorSeq) || 0,
      before: clamp(p.before, 2, 10),
      after: clamp(p.after, 2, 10),
    }),
  }));

  def('ledger.stats', 'read', '事件账本统计', async () => await ledger().stats());

  def('delivery.get', 'read', '按 requestId 查投递终态，多分块自动聚合（ai-chat /r/delivery 等价）', async (p) => {
    const rid = str(p.requestId).trim();
    if (!rid) throw err.bad('要给 requestId');
    const D = R.delivery;
    if (!D) throw err.notReady('投递账本未就绪');
    const fam = D.family?.(rid) ?? null;
    if (fam) {
      return {
        ok: true, state: fam.state, msgId: fam.msgId, code: fam.code,
        attempts: fam.attempts, at: fam.at, parts: fam.parts,
      };
    }
    /** 老框架的 delivery 没有 family()，退回精确查一条 */
    const row = D.get?.(rid);
    if (!row) {
      return { ok: false, gone: true, message: '没有这条投递记录（可能没开账本，或者 id 不对）' };
    }
    return {
      ok: true, state: row.state, msgId: row.msg_id || '', code: row.code || '',
      attempts: Number(row.attempts || 0),
      at: Number(row.settled_at || row.created_at || 0), parts: 1,
    };
  });

  def('delivery.recent', 'read', '最近投递记录', async (p) => ({
    items: R.delivery?.recent?.({ limit: clamp(p.limit, 50, 200), state: str(p.state) }) ?? [],
    stats: R.delivery?.stats?.() ?? { available: false },
  }));

  def('roles.resolve', 'read', '算发送者权限档位 bucket/level/role（ai-chat senderInfo 等价）', async (p) => {
    const userId = str(p.userId).trim();
    if (!userId) throw err.bad('要给 userId（openid）');
    const owners = Array.isArray(R.cfg?.owners) ? R.cfg.owners : [];
    const msg = { userId, kind: p.kind === 'group' ? 'group' : 'c2c',
      chatId: str(p.chatId), groupId: str(p.groupId) || str(p.chatId) };
    try {
      if (owners.includes(userId)) {
        return { userId, bucket: 'owner', level: 0, role: levelName(0) };
      }
      const lv = R.roles
        ? await R.roles.effective(scopeOf(msg), userId, { owners })
        : NO_PERM;
      const bucket = bucketOfLevel(lv);
      if (!bucket) return { userId, bucket: null, level: null, role: null };
      return { userId, bucket, level: lv, role: levelName(lv) };
    } catch (e) {
      log(`权限查询失败（${userId}）：${e?.message ?? e}`);
      return { userId, bucket: null, level: null, role: null };
    }
  });

  def('reach.get', 'read', '查这个会话能不能主动推送（官方没有查询接口，靠事件维护）', async (p) => {
    const target = str(p.target).trim();
    if (!target) throw err.bad('要给 target');
    if (!R.reach) throw err.notReady('可达性表未就绪');
    const kind = p.kind === 'group' ? 'group' : 'c2c';
    const v = kind === 'group'
      ? await R.reach.canGroupPush?.(target)
      : await R.reach.canC2C?.(target);
    return { kind, target, ...(v ?? { verdict: 'unknown' }) };
  });

  def('reach.note', 'manage', '发送成功/失败后回写可达性（ai-chat /r/send 等价）', async (p) => {
    const target = str(p.target).trim();
    if (!target) throw err.bad('要给 target');
    if (!R.reach) throw err.notReady('可达性表未就绪');
    if (p.ok === true) {
      await R.reach.noteSendOk?.({ openid: target });
    } else {
      await R.reach.noteSendError?.({ openid: target, qqCode: Number(p.qqCode) || 0 });
    }
    return { ok: true };
  });

  def('gate.silence', 'message', '让某个会话安静一段时间（ai-chat <<silence>> 等价）', async (p) => {
    const chatId = str(p.chatId).trim();
    const ms = Number(p.ms) || 0;
    if (!chatId || ms <= 0) throw err.bad('要给 chatId 和正数 ms');
    if (!R.gate) throw err.notReady('暂停闸未就绪');
    return await R.gate.setSilence(chatId, Math.min(ms, 30 * 86_400_000), {
      by: 'host', reason: str(p.reason).slice(0, 200),
    });
  });

  /* ---------------- 插件存档 / 配置 / 分群开关 ---------------- */

  def('plugin.data.get', 'read', '读插件存档（ai-chat ctx.storage 等价）', async (p) => {
    const item = plugins().loaded.get(safeId(p.id, err));
    if (!item) throw err.notFound('插件没加载');
    const st = item.ctx?.storage;
    if (!st) throw err.notReady('这个插件没有存档（外部子进程插件可能没有 ctx）');
    const all = await st.all();
    if (p.key !== undefined) return { key: str(p.key), value: all[str(p.key)] ?? null };
    return { data: all };
  });

  def('plugin.data.set', 'manage', '写一条插件存档', async (p) => {
    const id = safeId(p.id, err);
    const key = str(p.key).trim();
    if (!key) throw err.bad('要给 key');
    return { ok: true, ...(await plugins().setData(id, key, p.value)) };
  });

  def('plugin.data.delete', 'manage', '删一条插件存档', async (p) => {
    const id = safeId(p.id, err);
    const key = str(p.key).trim();
    if (!key) throw err.bad('要给 key');
    return { ok: true, ...(await plugins().deleteData(id, key)) };
  });

  def('plugin.data.clear', 'manage', '清空某插件全部存档', async (p) => {
    if (p.confirm !== true) throw err.bad('清空存档不可恢复，请显式传 confirm: true');
    return { ok: true, ...(await plugins().clearData(safeId(p.id, err))) };
  });

  def('plugin.config.reset', 'manage', '恢复插件出厂配置', async (p) => {
    if (p.confirm !== true) throw err.bad('恢复出厂会清掉 API Key 等配置，请显式传 confirm: true');
    return { config: await plugins().resetConfig(safeId(p.id, err)) };
  });

  def('plugin.groups.get', 'read', '某个插件在各群的启用情况', async (p) => {
    const pid = safeId(p.id, err);
    const spec = R.cfg?.plugins ?? { mode: 'all', list: [] };
    const groups = await (R.groups?.list?.() ?? Promise.resolve([]));
    await R.fetchGroupNames?.(groups.map((g) => g.groupOpenid)).catch(() => {});
    return {
      pluginId: pid,
      global: { mode: spec.mode ?? 'all', list: spec.list ?? [] },
      groups: groups.map((g) => ({
        chatId: g.groupOpenid,
        name: R.groupNames?.get?.(g.groupOpenid)?.name ?? '',
        enabled: true,
      })),
      groupsSpec: spec.groups ?? {},
    };
  });

  def('plugin.groups.set', 'manage', '在某个群启用/停用某插件', async (p) => {
    const pid = safeId(p.id, err);
    const chatId = str(p.chatId).trim();
    if (!chatId) throw err.bad('要给 chatId');
    const spec = R.cfg?.plugins ?? { mode: 'all', list: [] };
    const groupsCfg = toggleGroupPlugin(spec, chatId, pid, p.enabled === true);
    R.cfg.plugins = { ...spec, groups: groupsCfg };
    await saveBotConfig(R.id, R.cfg);
    return { ok: true, chatId, pluginId: pid, groups: groupsCfg };
  });

  /* ---------------- 插件市场 / 全生命周期 ---------------- */

  def('plugin.market', 'read', '插件市场索引 + 已装标记 + 可更新列表', async (p) => {
    const src = str(p.source) || R.globalCfg?.plugins?.marketUrl || undefined;
    const idx = await fetchIndex(src, { trust: resolveTrust(R.globalCfg ?? {}) });
    const installed = new Set(plugins().loaded.keys());
    try {
      for (const d of await fs.readdir(DIRS.plugins, { withFileTypes: true })) {
        if (d.isDirectory()) installed.add(d.name);
      }
    } catch { /* 目录还没有就算了 */ }
    const localVers = await plugins().localVersions();
    return {
      repo: idx.repo, updated: idx.updated, source: src || 'default',
      plugins: mergeWithInstalled(idx.plugins, installed),
      updates: detectUpdates(idx.plugins, localVers).map((u) => ({
        id: u.id, current: u.current, latest: u.latest,
      })),
      localVersions: localVers,
      trust: idx?._trust?.status || 'unavailable',
      stale: idx.stale === true, staleAge: idx.staleAge || '',
    };
  });

  def('plugin.versions', 'read', '本地已装插件版本（以磁盘为准）', async () => ({
    versions: await plugins().localVersions(),
  }));

  def('plugin.updates', 'read', '检查哪些插件有新版', async () => {
    const { idx } = await freshIndex(R, err);
    const localVers = await plugins().localVersions();
    return { updates: detectUpdates(idx.plugins, localVers), stale: idx.stale === true };
  });

  def('plugin.install', 'manage', '从市场安装插件（装完自动 rescan 加载）', async (p) => {
    const id = safeId(p.id, err);
    const { src, idx } = await freshIndex(R, err);
    const entry = idx.plugins.find((x) => x.id === id);
    if (!entry) throw err.notFound(`市场里没有 ${id}`);
    trustGate(R, idx, src, id, err);

    /** 下载解包期间挂起热重载：文件是一个个复制进来的，中途会读到半个插件 */
    suspendPluginWatch(30_000);
    try {
      const r = await installPlugin({
        entry,
        pluginsDir: DIRS.plugins,
        repo: idx.repo,
        branch: idx.branch || 'main',
        sha256: idx?.archive?.sha256 ?? idx?.sha256 ?? null,
        exists: (pid) => plugins().loaded.has(pid),
      });
      await ensurePluginInList(R, r.id, true, err);
      const scanned = await plugins().rescan();
      return { ok: true, id: r.id, ...scanned };
    } finally {
      suspendPluginWatch(1000);
    }
  });

  def('plugin.remove', 'manage', '卸载插件（删目录，保留数据目录；需 confirm）', async (p) => {
    if (p.confirm !== true) throw err.bad('卸载会删除插件目录，请显式传 confirm: true');
    const id = safeId(p.id, err);
    const base = path.resolve(DIRS.plugins);
    const dir = path.resolve(base, id);
    /** 路径穿越三重校验：id 白名单 + resolve 后必须是 base 的直接子目录 */
    if (!dir.startsWith(base + path.sep) || path.dirname(dir) !== base) {
      throw err.bad('路径越界，已拒绝');
    }
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) throw err.notFound(`插件 ${id} 没装（${dir}）`);

    suspendPluginWatch(15_000);
    try {
      if (plugins().loaded.has(id)) await plugins().unload(id).catch(() => {});
      await ensurePluginInList(R, id, false, err).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true });
      await plugins().forget(id).catch(() => {});
      const scanned = await plugins().rescan();
      log(`已卸载插件 ${id}（数据目录保留，重装可继续用）：${dir}`);
      return { ok: true, id, removedPath: dir, ...scanned };
    } finally {
      suspendPluginWatch(1000);
    }
  });

  def('plugin.update', 'manage', '更新单个插件到市场最新版', async (p) => {
    const id = safeId(p.id, err);
    let repo = null;
    try {
      const { src, idx } = await freshIndex(R, err);
      const entry = idx.plugins.find((x) => x.id === id);
      if (!entry) throw err.notFound(`市场里没有 ${id}`);
      trustGate(R, idx, src, id, err);
      const localVers = await plugins().localVersions();
      const cur = localVers[id];
      if (!cur) throw err.bad(`本地没装 ${id}，先用 plugin.install`);
      if (compareVersion(cur, entry.version) >= 0) {
        throw err.bad(`${id} 已经是 ${cur}，没有新版`);
      }
      repo = await syncRepo({
        repo: idx.repo, branch: idx.branch || 'main', indexUrl: src,
        only: [`plugins/${id}/`], index: idx,
      });
      const r = await updatePlugins({
        tmp: repo.tmp, index: repo.index, pluginsDir: DIRS.plugins,
        ids: [id], localVersions: localVers,
      });
      if (r.failed.length) throw err.bad(r.failed[0].error);
      if (!r.updated.length) throw err.bad(`${id} 没有可用的更新`);
      await plugins().reload(id).catch((e) => log(`插件 ${id} 更新后重载失败：${e.message}`));
      const scanned = await plugins().rescan();
      return { ok: true, from: r.updated[0].from, to: r.updated[0].to, ...scanned };
    } finally {
      await cleanupRepo(repo?.tmp);
    }
  });

  def('plugin.update.all', 'manage', '一键更新所有有新版的插件', async () => {
    let repo = null;
    try {
      const src = R.globalCfg?.plugins?.marketUrl || undefined;
      repo = await syncRepo({ indexUrl: src });
      const localVers = await plugins().localVersions();
      const r = await updatePlugins({
        tmp: repo.tmp, index: repo.index,
        pluginsDir: DIRS.plugins, localVersions: localVers,
      });
      for (const u of r.updated) {
        await plugins().reload(u.id).catch((e) => log(`插件 ${u.id} 重载失败：${e.message}`));
      }
      const scanned = await plugins().rescan();
      return { ok: true, ...r, ...scanned };
    } finally {
      await cleanupRepo(repo?.tmp);
    }
  });

  def('plugin.rescan', 'manage', '重扫插件目录，加载新增 / 卸载已删', async () => ({
    ok: true, ...(await plugins().rescan()), plugins: plugins().list(),
  }));

  def('plugin.load', 'manage', '加载单个插件', async (p) => ({
    ok: true, result: await plugins().load(safeId(p.id, err)),
  }));

  def('plugin.unload', 'manage', '卸载单个插件的运行时（不删文件）', async (p) => ({
    ok: true, result: await plugins().unload(safeId(p.id, err)),
  }));

  def('plugin.forget', 'manage', '清掉插件状态里的残留开关记录', async (p) => ({
    ok: true, result: await plugins().forget(safeId(p.id, err)),
  }));
}
