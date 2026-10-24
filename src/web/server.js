import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../config.js';
import { DIRS, botPaths, listBotIds, rel } from '../paths.js';
import { createLogger, recentLogs, onLog, getLevel, setLevel } from '../logger.js';
import { runtime } from '../runtime.js';
import { EVENT_NAMES, INTENT_META, describeIntents, groupEvents } from '../events.js';
import {
  fetchIndex,
  installPlugin,
  syncRepo,
  cleanupRepo,
  updatePlugins,
  mergeWithInstalled,
  detectUpdates,
  compareVersion,
} from '../plugin/market.js';
import {
  checkUpdate as checkFrameworkUpdate,
  applyUpdate as applyFrameworkUpdate,
  currentVersion,
} from '../updater.js';
// 面板改插件启停时要同步机器人配置里的过滤器，两边不能各说各的
import { pluginFilterOf } from '../bot.js';
import { suspendPluginWatch } from '../services/plugin-watch.js';

const log = createLogger('webui');
const WEB_ROOT = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 1024 * 256) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/**
 * 依次尝试 startPort、startPort+1 … 直到能监听为止。
 * 端口被占用不再直接失败——换一个继续，避免「上次没关干净」导致面板打不开。
 *
 * @returns {Promise<number>} 实际监听成功的端口
 */
function listenWithFallback(server, host, startPort, { tries = 20, onBusy } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryOnce = () => {
      const p = startPort + attempt;

      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && attempt < tries - 1) {
          onBusy?.(p);
          attempt += 1;
          // 稍等一下再试，给上一个 socket 一点清理时间
          setTimeout(tryOnce, 10);
          return;
        }
        reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(p);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      try {
        server.listen(p, host);
      } catch (e) {
        server.off('listening', onListening);
        reject(e);
      }
    };

    tryOnce();
  });
}

/**
 * 可视化面板。
 *
 * 默认只监听 127.0.0.1，不对外暴露。
 * 设置 webui.accessKey 后，所有 /api/* 请求需要带 X-Access-Key 头或 ?key=。
 */
export async function startWebServer({
  globalCfg,
  runtimes,
  saveBotConfig,
  saveGlobalConfig,
  onBotAdd,
  onBotRemove,
  onShutdown,
  services = null,
  mock = false,
}) {
  const wc = globalCfg.webui ?? {};
  // 启动时读一次版本号，status 里带给面板
  const frameworkVersion = await currentVersion().catch(() => '0.0.0');
  if (wc.enabled === false) {
    log.info('可视化面板已禁用（config/bot.json → webui.enabled = false）');
    return null;
  }

  const host = wc.host || '127.0.0.1';
  const port = Number(wc.port) || 15207;
  const accessKey = wc.accessKey || wc.token || '';

  // res -> 这个连接正在看哪个机器人，状态推送时按各自的目标过滤
  const sseClients = new Map();

  /**
   * 按 ?bot=<id> 选机器人，没传就用第一个。
   * 下面每个 handler 开头都会用同名变量把外层的 cfg / plugins / groups … 遮住，
   * 这样 17 个接口的主体逻辑一行都不用改。
   */
  const pickRuntime = (url) => {
    const id = url.searchParams.get('bot');
    if (id) {
      const hit = runtimes.find((r) => r.id === id);
      if (hit) return hit;
    }
    return runtimes[0] ?? null;
  };

  /**
   * 只改「配置里的启用名单」，**不碰运行时**。
   *
   * 和 setPluginEnabled 的区别很重要：
   * 装完插件时只想把它加进名单，然后让 rescan 去加载——
   * 如果这里顺手 load 了，rescan 会发现「已加载」而跳过，added 就是空的，
   * 前端就会误报「插件已安装，但没能自动加载」。
   *
   * @returns {Promise<boolean>} 是否真的改了配置
   */
  const ensurePluginInList = async (rt, id, enabled = true) => {
    const spec = rt?.cfg?.plugins ?? { mode: 'all', list: [] };
    let mode = spec.mode ?? 'all';
    let list = new Set(spec.list ?? []);
    let changed = false;

    if (enabled) {
      if (mode === 'include' && !list.has(id)) {
        list.add(id);
        changed = true;
      } else if (mode === 'exclude' && list.has(id)) {
        list.delete(id);
        changed = true;
      }
    } else if (mode === 'include' && list.has(id)) {
      list.delete(id);
      changed = true;
    } else if (mode === 'exclude' && !list.has(id)) {
      list.add(id);
      changed = true;
    } else if (mode === 'all') {
      // all 模式下禁用单个插件，只能转成「排除名单」
      mode = 'exclude';
      list = new Set([id]);
      changed = true;
    }

    if (!changed) return false;

    rt.cfg.plugins = { ...spec, mode, list: [...list] };
    // filter 是内存里的，不同步的话这次改动不生效
    rt.plugins.filter = pluginFilterOf(rt.cfg.plugins);
    try {
      await saveBotConfig(rt.id, rt.cfg);
    } catch (e) {
      log.warn(`保存插件启用配置失败：${e.message}`);
    }
    return true;
  };

  /**
   * 面板开关 → 改配置 + 真的加载/卸载。
   */
  const setPluginEnabled = async (rt, id, enabled) => {
    await ensurePluginInList(rt, id, enabled);
    return rt.plugins.setEnabled(id, enabled);
  };

  const statusPayload = (rt) =>
    runtime.snapshot({
      credentialExpiresIn: Math.max(0, Math.round(((rt?.tokens?.expiresAt ?? 0) - Date.now()) / 1000)),
      plugins: rt ? rt.plugins.list() : [],
      cfg: rt?.cfg ?? {},
      botId: rt?.id ?? null,
      botName: rt?.name ?? null,
      // 上下线按钮要看机器人自己的状态：idle / starting / online / offline / error / stopped
      state: rt?.state ?? 'offline',
      // 面板「框架版本」直接显示，不用等用户点「检查更新」才有值
      version: frameworkVersion,
    });

  // 日志实时推送：日志是全局的，所有连接都收到同一份
  const offLog = onLog((entry) => {
    const data = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const res of sseClients.keys()) {
      try {
        res.write(data);
      } catch {}
    }
  });

  const statusTimer = setInterval(() => {
    if (!sseClients.size) return;
    // 每个客户端可能在看不同机器人，各自推各自的
    for (const [res, botId] of sseClients) {
      const rt = runtimes.find((r) => r.id === botId) ?? runtimes[0];
      try {
        res.write(`event: status\ndata: ${JSON.stringify(statusPayload(rt))}\n\n`);
      } catch {}
    }
  }, 2000);
  statusTimer.unref?.();

  const authorized = (req, url) => {
    if (!accessKey) return true;
    // 兼容旧的 X-Token / ?token= 写法
    const given =
      req.headers['x-access-key'] ||
      req.headers['x-token'] ||
      url.searchParams.get('key') ||
      url.searchParams.get('token');
    return given === accessKey;
  };

  /**
   * 把机器人显示名同步成官方昵称。
   *
   * 全新安装时配置里的名字是「默认机器人」这种占位符，填完 AppID / AppSecret
   * 之后没人会记得回来改它，面板上就一直显示占位名。所以保存凭证时顺手调一次
   * /users/@me 拿真实昵称。
   *
   * 只在占位名（空 / 等于 id / 「默认机器人」）时替换——用户自己起过的名字不动。
   * 拉取失败不影响配置保存，只记一条 warn。
   */
  const PLACEHOLDER_NAME = /^(默认机器人|未命名|新机器人)$/;
  const syncBotName = async (r) => {
    if (!r || r.mock || !r.cfg.appId || !r.cfg.appSecret) return null;
    const cur = String(r.name ?? '').trim();
    if (cur && cur !== r.id && !PLACEHOLDER_NAME.test(cur)) return null;

    try {
      const me = await r.api.getMe();
      const nick = String(me?.username ?? me?.nickname ?? '').trim();
      if (!nick || nick === r.name) return null;
      r.name = nick;
      r.cfg.name = nick;
      await saveBotConfig(r.id, r.cfg);
      log.info(`机器人昵称已同步为「${nick}」`);
      return nick;
    } catch (e) {
      log.warn(`拉取机器人昵称失败（不影响使用）：${e.message}`);
      return null;
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      // ---------------- API ----------------
      if (pathname.startsWith('/api/')) {
        if (!authorized(req, url)) return json(res, 401, { error: '访问密钥无效' });

        // 选中要操作的机器人，并用同名变量遮住外层的聚合对象，
        // 这样下面所有 handler 的写法都不用变
        const rt = pickRuntime(url);

  /* ---------------- 插件更新检查 ---------------- */

  // 更新检查结果按机器人缓存。插件**代码**是全局共享的，但启用状态 per-bot，
  // 所以每个机器人看到的「可更新」可能不同，缓存也跟着分。
  const updateCache = new Map(); // botId -> { at, updates, error }
  const UPDATE_CACHE_MS = 5 * 60 * 1000;

  /**
   * 对照插件市场，看这个机器人有哪些插件能更新。
   * 只检查不安装——安装会覆盖本地目录，必须用户点。
   */
  const checkUpdates = async (r, { force = false } = {}) => {
    if (!r) return { at: 0, updates: [], error: '没有可用的机器人' };
    const hit = updateCache.get(r.id);
    if (hit && !force && Date.now() - hit.at < UPDATE_CACHE_MS) return hit;

    const out = { at: Date.now(), updates: [], error: '' };
    try {
      const idx = await fetchIndex(globalCfg.plugins?.marketUrl || undefined);
      const localVers = await r.plugins.localVersions();
      out.updates = detectUpdates(idx.plugins, localVers).map((u) => ({
        id: u.id,
        current: u.current,
        latest: u.latest,
        name: u.entry.name ?? u.id,
      }));
      if (out.updates.length) {
        log.info(
          `[${r.id}] 插件市场有 ${out.updates.length} 个更新：` +
            out.updates.map((u) => `${u.id} ${u.current}→${u.latest}`).join('、'),
        );
      }
    } catch (e) {
      // 连不上市场是常事（离线、代理、限流），不该刷错误日志
      out.error = e.message;
    }
    updateCache.set(r.id, out);
    return out;
  };

  // 启动后过一会儿查一次，别拖慢启动；之后每小时一次。
  // 60 秒是有意的：启动瞬间面板、插件、市场可能都在拉数据，
  // 再叠一个 GitHub 请求容易一起超时。fetchIndex 内部也有并发去重兜底。
  const updateTimer = setInterval(() => {
    for (const r of runtimes) checkUpdates(r).catch(() => {});
  }, 60 * 60 * 1000);
  updateTimer.unref?.();
  setTimeout(() => {
    for (const r of runtimes) checkUpdates(r).catch(() => {});
  }, 60000).unref?.();

  /* ---------------- 机器人管理（不依赖当前选中项） ---------------- */

        if (pathname === '/api/bots' && req.method === 'GET') {
          const ids = await listBotIds();
          const list = ids.map((id) => {
            const r = runtimes.find((x) => x.id === id);
            return {
              id,
              name: r?.name ?? id,
              state: r?.state ?? 'not-loaded',
              online: Boolean(r?.online),
              appId: r?.cfg.appId ?? '',
              plugins: r?.plugins ? r.plugins.loaded.size : 0,
              enabled: r ? true : false,
              error: r?.lastError ?? '',
            };
          });
          return json(res, 200, { bots: list, current: rt?.id ?? null });
        }

        if (pathname === '/api/bots' && req.method === 'POST') {
          if (!onBotAdd) return json(res, 501, { error: '当前模式不支持新建机器人' });
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
            return json(res, 400, {
              error: 'id 只能用小写字母、数字、下划线、短横线，1–32 位，且不能以符号开头',
            });
          }
          if ((await listBotIds()).includes(id)) {
            return json(res, 409, { error: `机器人 ${id} 已存在` });
          }
          try {
            const created = await onBotAdd(id, {
              name: String(body.name ?? '').trim() || id,
              appId: String(body.appId ?? '').trim(),
              appSecret: String(body.appSecret ?? '').trim(),
            });
            // 没填显示名时用官方昵称补上
            const name = await syncBotName(created);
            return json(res, 200, { ok: true, id, name: name ?? created?.name ?? id, state: created?.state ?? 'unknown' });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        if (pathname === '/api/bots/delete' && req.method === 'POST') {
          if (!onBotRemove) return json(res, 501, { error: '当前模式不支持删除机器人' });
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { error: '缺少 id' });
          if (runtimes.length <= 1 && runtimes.some((r) => r.id === id)) {
            return json(res, 400, { error: '这是最后一个机器人，删掉就没得跑了' });
          }
          try {
            await onBotRemove(id, { purge: body.purge !== false });
            return json(res, 200, { ok: true });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        if (!rt) return json(res, 503, { error: '没有可用的机器人' });
        const cfg = rt.cfg;
        const plugins = rt.plugins;
        const groups = rt.groups;
        const roles = rt.roles;
        const api = rt.api;
        const tokens = rt.tokens;
        const getGateway = () => rt.gateway;

        // CSRF 防护：写操作必须带 application/json。
        // 跨站的简单表单请求设不了这个 Content-Type，会被浏览器拦在预检阶段。
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const ct = String(req.headers['content-type'] || '');
          if (!ct.includes('application/json')) {
            return json(res, 415, { error: '写操作需要 Content-Type: application/json' });
          }
        }

        /* ---------------- 上下线 ---------------- */

        // 面板的上下线按钮。只动网关连接，不卸载插件、不清存档
        const bo = pathname.match(/^\/api\/bots\/([^/]+)\/(online|offline)$/);
        if (bo && req.method === 'POST') {
          const target = runtimes.find((r) => r.id === decodeURIComponent(bo[1]));
          if (!target) return json(res, 404, { error: '没有这个机器人' });
          try {
            const state =
              bo[2] === 'online' ? await target.goOnline() : await target.goOffline();
            return json(res, 200, {
              ok: state === 'online' || state === 'offline',
              state,
              online: target.online,
              error: target.lastError || '',
            });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        // 状态
        if (pathname === '/api/status' && req.method === 'GET') {
          return json(res, 200, statusPayload(rt));
        }

        // 配置读取（隐藏密钥）
        if (pathname === '/api/config' && req.method === 'GET') {
          return json(res, 200, {
            ...cfg,
            // webui 和 logLevel 是**全局**设置（config/bot.json），所有机器人共用，
            // 不在这台机器人的 cfg 里。不返回的话面板永远显示默认值，
            // 用户改完也看不出当前是什么。
            webui: globalCfg.webui ?? {},
            logLevel: globalCfg.logLevel ?? 'info',
            appSecret: cfg.appSecret ? '********' : '',
            appSecretSet: Boolean(cfg.appSecret),
          });
        }

        // 配置保存
        if (pathname === '/api/config' && req.method === 'PUT') {
          const body = await readBody(req);
          const before = JSON.stringify({ appId: cfg.appId, intents: cfg.intents });
          const oldSecret = cfg.appSecret;

          if (typeof body.appId === 'string') cfg.appId = body.appId.trim();
          // 密钥留空或仍是掩码时保持原值
          if (typeof body.appSecret === 'string' && body.appSecret && body.appSecret !== '********') {
            cfg.appSecret = body.appSecret.trim();
          }
          if (body.baseUrl) cfg.baseUrl = body.baseUrl.trim();
          if (body.intents !== undefined) {
            const n = Number(body.intents);
            if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) {
              return json(res, 400, { error: 'intents 必须是 0 ~ 2147483647 的整数' });
            }
            cfg.intents = n;
          }
          if (body.commandPrefix) cfg.commandPrefix = body.commandPrefix;
          if (Array.isArray(body.owners)) cfg.owners = body.owners.map((s) => String(s).trim()).filter(Boolean);
          if (body.logLevel) {
            globalCfg.logLevel = body.logLevel;
            setLevel(body.logLevel);
            await saveGlobalConfig?.(globalCfg).catch(() => {});
          }
          if (body.whitelist && typeof body.whitelist === 'object') {
            cfg.whitelist = {
              enabled: Boolean(body.whitelist.enabled),
              groups: (body.whitelist.groups ?? []).map(String).filter(Boolean),
              users: (body.whitelist.users ?? []).map(String).filter(Boolean),
            };
          }
          if (body.rateLimit && typeof body.rateLimit === 'object') {
            cfg.rateLimit = {
              enabled: Boolean(body.rateLimit.enabled),
              perChatPerMinute: Math.max(1, Number(body.rateLimit.perChatPerMinute) || 30),
            };
          }
          if (body.dedupWindowSec !== undefined) {
            cfg.dedupWindowSec = Math.max(0, Number(body.dedupWindowSec) || 0);
          }
          if (body.messageLog && typeof body.messageLog === 'object') {
            cfg.messageLog = {
              enabled: body.messageLog.enabled !== false,
              muteKinds: Array.isArray(body.messageLog.muteKinds)
                ? body.messageLog.muteKinds.filter((k) => ['group', 'c2c', 'guild', 'dm'].includes(k))
                : [],
            };
          }
          if (body.webui && typeof body.webui === 'object') {
            // webui 是全局设置，不能写进机器人 cfg：
            // 写进去 saveBotConfig 也不保存它（白名单式保存），
            // 结果是面板提示「已保存」但什么都没变。
            globalCfg.webui = { ...globalCfg.webui, ...body.webui };
            await saveGlobalConfig?.(globalCfg).catch(() => {});
          }
          // 群管内邀开关：同步给 api 层，否则要等重启才生效
          if (body.groupManage && typeof body.groupManage === 'object') {
            cfg.groupManage = { invited: Boolean(body.groupManage.invited) };
            rt.api?.setGroupInvited?.(cfg.groupManage.invited);
          }

          await saveBotConfig(rt.id, cfg);
          log.info('配置已通过面板更新');

          const after = JSON.stringify({ appId: cfg.appId, intents: cfg.intents });
          // 凭证变了要让 token 管理器跟着换，否则还在用旧 AppID 的 access_token
          if (cfg.appSecret !== oldSecret) {
            if (tokens) {
              tokens.appSecret = cfg.appSecret;
              tokens.token = '';
              tokens.expiresAt = 0;
            }
          }
          if (before !== after) {
            if (tokens && tokens.appId !== cfg.appId) {
              tokens.appId = cfg.appId;
              tokens.token = '';
              tokens.expiresAt = 0;
            }
            log.info('连接参数变化，正在重连网关...');
            rt.gateway?.restart?.().catch(() => {});
          }

          // 填完 AppID / AppSecret 顺手把「默认机器人」换成官方昵称
          const name = await syncBotName(rt);
          return json(res, 200, { ok: true, name: name ?? rt.name });
        }

        // 插件
        if (pathname === '/api/plugins' && req.method === 'GET') {
          return json(res, 200, plugins.list());
        }

        /**
         * 统计概览：消息量、活跃人数、命令排行、会话排行。
         * ?days=7 控制窗口（1~365）。SQLite 不可用时返回 available:false，
         * 面板据此显示「统计不可用」而不是画一堆 0。
         */
        if (pathname === '/api/stats' && req.method === 'GET') {
          const days = Number(url.searchParams.get('days')) || 7;
          try {
            return json(res, 200, rt.stats?.overview(days) ?? { available: false });
          } catch (e) {
            return json(res, 500, { error: e.message, available: false });
          }
        }

        // 最近消息（不含正文，只有时间/会话/是否命令）
        if (pathname === '/api/stats/recent' && req.method === 'GET') {
          const limit = Number(url.searchParams.get('limit')) || 50;
          try {
            return json(res, 200, rt.stats?.recent(limit) ?? []);
          } catch (e) {
            return json(res, 500, { error: e.message });
          }
        }

        /**
         * **只在 --mock 模式下注册**：往运行时塞一条假消息。
         *
         * 用途：没有真机也能验证整条链路——统计、权限、命令、限流。
         * 连真 QQ 时这个路由根本不存在，所以不构成额外入口。
         */
        if (mock && pathname === '/api/mock/dispatch' && req.method === 'POST') {
          const body = await readBody(req);
          const event = String(body.event || 'GROUP_AT_MESSAGE_CREATE');
          const data = body.data ?? {
            id: `mock-${Date.now()}`,
            content: String(body.content ?? ''),
            timestamp: new Date().toISOString(),
            group_openid: String(body.groupId ?? 'mock-group'),
            author: { member_openid: String(body.userId ?? 'mock-user'), username: '测试用户' },
          };
          await rt.dispatch(event, data);
          return json(res, 200, { ok: true, event });
        }

        // 插件自定义运行数据：一次拿全部，面板轮询这个接口
        if (pathname === '/api/plugins/dashboard' && req.method === 'GET') {
          return json(res, 200, await plugins.dashboards());
        }

        /* ---------------- 插件注册的面板页面 ---------------- */

        // 有哪些页面（不含 html，可能很大）
        if (pathname === '/api/pages' && req.method === 'GET') {
          return json(res, 200, plugins.pages?.list() ?? []);
        }

        // 页面本体。iframe 直接 src 到这里，所以返回 text/html 而不是 JSON
        const pageM = pathname.match(/^\/api\/pages\/(.+)\/html$/);
        if (pageM && req.method === 'GET') {
          const key = decodeURIComponent(pageM[1]);
          const p = plugins.pages?.get(key);
          if (!p) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('页面不存在（插件可能已卸载或重载）');
          }
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            // 插件页面可能随插件更新而变，不缓存
            'Cache-Control': 'no-store',
          });
          return res.end(p.html);
        }

        // 有哪些插件能更新。结果缓存 5 分钟，?force=1 强制重新查
        if (pathname === '/api/plugins/updates' && req.method === 'GET') {
          const force = url.searchParams.get('force') === '1';
          return json(res, 200, await checkUpdates(rt, { force }));
        }

        // 后台服务状态：健康巡检、清理、配置热加载、定时重启、检查更新
        if (pathname === '/api/services' && req.method === 'GET') {
          const list = services?.status?.() ?? [];
          // 把健康采样和更新检查结果也带上，面板一处显示
          const extra = {};
          for (const s of services?.list ?? []) {
            if (typeof s.snapshot === 'function') extra[s.name] = s.snapshot();
          }
          return json(res, 200, { services: list, extra });
        }

        /* ---------------- 框架自身更新 ---------------- */

        // 查最新版本（不装）
        if (pathname === '/api/update/check' && req.method === 'GET') {
          try {
            return json(res, 200, await checkFrameworkUpdate());
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message });
          }
        }

        // 执行更新。会覆盖代码目录，前端必须先确认过
        if (pathname === '/api/update/apply' && req.method === 'POST') {
          try {
            const info = await checkFrameworkUpdate();
            if (!info.ok) return json(res, 400, { error: info.error || '检查更新失败' });
            if (!info.hasUpdate) return json(res, 400, { error: `已经是最新版本 ${info.current}` });

            const r = await applyFrameworkUpdate(info);
            if (!r.ok) return json(res, 500, { error: r.error, from: r.from });
            return json(res, 200, {
              ok: true,
              from: r.from,
              to: r.to,
              backup: r.backup,
              message: '更新完成，重启程序后生效',
            });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }
        /* ---------------- 插件设置面板 ---------------- */

        // 拿某个插件的配置 schema、当前值、存档
        const pm = pathname.match(/^\/api\/plugins\/([^/]+)\/panel$/);
        if (pm && req.method === 'GET') {
          const p = await plugins.panelOf(decodeURIComponent(pm[1]));
          if (!p) return json(res, 404, { error: '插件没加载' });
          return json(res, 200, p);
        }

        // 改插件配置
        const pc = pathname.match(/^\/api\/plugins\/([^/]+)\/config$/);
        if (pc && req.method === 'PUT') {
          const body = await readBody(req);
          try {
            const next = await plugins.setConfig(decodeURIComponent(pc[1]), body ?? {});
            return json(res, 200, { ok: true, config: next });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        // 改 / 删一条插件存档
        const pd = pathname.match(/^\/api\/plugins\/([^/]+)\/data$/);
        if (pd && req.method === 'POST') {
          const id = decodeURIComponent(pd[1]);
          const body = await readBody(req);
          const key = String(body.key ?? '').trim();
          if (!key) return json(res, 400, { error: '缺少 key' });
          try {
            if (body.remove) {
              await plugins.deleteData(id, key);
              return json(res, 200, { ok: true, removed: key });
            }
            // value 允许是任意 JSON；字符串原样存
            const value = typeof body.value === 'string' ? body.value : body.value;
            await plugins.setData(id, key, value);
            return json(res, 200, { ok: true, key });
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }

        const m = pathname.match(/^\/api\/plugins\/([^/]+)\/(enable|disable|reload|remove)$/);
        if (m && req.method === 'POST') {
          const [, rawId, action] = m;
          const id = decodeURIComponent(rawId);

          /* ---------------- 卸载插件 ---------------- */
          if (action === 'remove') {
            // id 只允许字母数字下划线横线，和安装时的校验保持一致
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
              return json(res, 400, { error: `插件 id 不合法：${id}` });
            }
            const base = path.resolve(DIRS.plugins);
            const dir = path.resolve(base, id);
            // 防路径穿越：必须严格是 plugins/ 下的一级子目录
            if (dir !== path.join(base, id) || !dir.startsWith(base + path.sep)) {
              return json(res, 400, { error: '路径越界，已拒绝' });
            }
            const st = await fs.stat(dir).catch(() => null);
            if (!st?.isDirectory()) return json(res, 404, { error: `插件 ${id} 没装` });

            try {
              // 删目录时同样要挂起热重载：文件一个个消失会被当成「用户改代码」
              suspendPluginWatch(15000);
              // 先卸运行时再删文件，顺序反了会出现进程还在读已删除的代码
              if (plugins.loaded.has(id)) await plugins.unload(id).catch(() => {});
              await ensurePluginInList(rt, id, false).catch(() => {});
              await fs.rm(dir, { recursive: true, force: true });
              // 清掉 state 里的残留，否则重装会被旧的 false 挡住
              await plugins.forget(id).catch(() => {});
              const scanned = await plugins.rescan();
              suspendPluginWatch(1000);
              log.info(`已卸载插件 ${id}（数据目录保留，重装可继续用）`);
              return json(res, 200, { ok: true, id, ...scanned });
            } catch (e) {
              suspendPluginWatch(1000);
              log.error(`卸载插件 ${id} 失败：${e.message}`);
              return json(res, 500, { error: e.message });
            }
          }

          let ok = false;
          if (action === 'enable') ok = await setPluginEnabled(rt, id, true);
          else if (action === 'disable') ok = await setPluginEnabled(rt, id, false);
          else ok = await plugins.reload(id);
          return json(res, ok ? 200 : 500, { ok, error: ok ? undefined : '操作失败，看日志' });
        }

        // 群档案
        /* ---------------- 插件市场 ---------------- */

        // 重新扫描插件目录，加载新放进去的、卸载已删除的
        if (pathname === '/api/plugins/rescan' && req.method === 'POST') {
          const r = await plugins.rescan();
          return json(res, 200, { ok: true, ...r, plugins: plugins.list() });
        }

        // 拉取插件市场索引，并标出哪些已安装
        if (pathname === '/api/market' && req.method === 'GET') {
          const url2 = url.searchParams.get('source') || globalCfg.plugins?.marketUrl || undefined;
          try {
            const idx = await fetchIndex(url2);
            const installedIds = new Set(plugins.loaded.keys());
            // 目录里存在但没加载成功的也算「已装」
            try {
              for (const d of await fs.readdir(DIRS.plugins, { withFileTypes: true })) {
                if (d.isDirectory()) installedIds.add(d.name);
              }
            } catch {}
            const localVers = await plugins.localVersions();
            const updates = detectUpdates(idx.plugins, localVers);
            return json(res, 200, {
              repo: idx.repo,
              updated: idx.updated,
              source: url2 || 'default',
              plugins: mergeWithInstalled(idx.plugins, installedIds),
              // 本地有新版可用的插件
              updates: updates.map((u) => ({
                id: u.id,
                current: u.current,
                latest: u.latest,
              })),
              localVersions: localVers,
              // 网络挂了用的是本地缓存，面板要提示用户「这是旧数据」
              stale: idx.stale === true,
              staleAge: idx.staleAge || '',
            });
          } catch (e) {
            return json(res, 502, { error: e.message });
          }
        }

        // 一键安装
        if (pathname === '/api/market/install' && req.method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { error: '缺少插件 id' });
          try {
            const src = globalCfg.plugins?.marketUrl || undefined;
            const idx = await fetchIndex(src);
            const entry = idx.plugins.find((p) => p.id === id);
            if (!entry) return json(res, 404, { error: `市场里没有 ${id}` });

            /**
             * 下载 + 解包期间要挂起插件热重载。
             *
             * 插件是逐个文件复制进 plugins/ 的，中途会短暂出现「只有一半文件」
             * 的状态。热重载若在那时触发，会读到半个 index.js 报语法错，
             * 用户看到的就是「装完提示加载失败」，而其实装得好好的。
             */
            suspendPluginWatch(30000);

            const r = await installPlugin({
              entry,
              pluginsDir: DIRS.plugins,
              repo: idx.repo,
              branch: idx.branch || 'main',
              exists: (pid) => plugins.loaded.has(pid),
            });

            /**
             * 装完先确保它在启用名单里，**然后交给 rescan 去加载**。
             *
             * 这里只能调 ensurePluginInList（只改配置），不能调 setPluginEnabled
             * ——后者会顺手 load，导致 rescan 看到「已加载」就跳过，added 变成空，
             * 前端就会误报「插件已安装，但没能自动加载」。
             */
            await ensurePluginInList(rt, r.id, true);

            // 装完立刻扫一遍，用户不用重启
            const scanned = await plugins.rescan();
            // 收窄挂起窗口：装完了，1 秒后恢复监视并重建基线
            suspendPluginWatch(1000);
            return json(res, 200, { ok: true, id: r.id, ...scanned });
          } catch (e) {
            suspendPluginWatch(1000);
            return json(res, 400, { error: e.message });
          }
        }

        if (pathname === '/api/groups' && req.method === 'GET') {
          return json(res, 200, await groups.list());
        }
        const gm = pathname.match(/^\/api\/groups\/([^/]+)$/);
        if (gm && (req.method === 'PUT' || req.method === 'DELETE')) {
          const id = decodeURIComponent(gm[1]);
          if (req.method === 'DELETE') {
            await groups.remove(id);
            return json(res, 200, { ok: true });
          }
          const body = await readBody(req);
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
          if (body.note !== undefined) patch.note = String(body.note);
          const g = await groups.upsert(id, patch);
          return json(res, 200, g);
        }

        // 权限
        if (pathname === '/api/roles' && req.method === 'GET') {
          const all = await roles.all();
          const rows = [];
          for (const [scope, members] of Object.entries(all)) {
            for (const [openid, level] of Object.entries(members)) {
              rows.push({ scope, openid, level });
            }
          }
          rows.sort((a, b) => b.level - a.level || a.scope.localeCompare(b.scope));
          return json(res, 200, { owners: cfg.owners, rows });
        }
        if (pathname === '/api/roles/set' && req.method === 'POST') {
          const body = await readBody(req);
          const scope = String(body.scope || '').trim();
          const openid = String(body.openid || '').trim();
          const level = Number(body.level);
          if (!scope || !openid || !Number.isInteger(level)) {
            return json(res, 400, { error: '缺少参数或等级不是整数' });
          }
          if (level === 0) return json(res, 400, { error: '主人只能在 config/bot.json 设置' });
          if (level < 1 || level > 98) return json(res, 400, { error: '等级需在 1-98 之间' });
          await roles.set(scope, openid, level);
          return json(res, 200, { ok: true });
        }
        if (pathname === '/api/roles/remove' && req.method === 'POST') {
          const body = await readBody(req);
          await roles.remove(String(body.scope || ''), String(body.openid || ''));
          return json(res, 200, { ok: true });
        }

        // 日志
        if (pathname === '/api/logs' && req.method === 'GET') {
          const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
          const level = url.searchParams.get('level') || 'debug';
          return json(res, 200, recentLogs(limit, level));
        }

        // 日志级别
        if (pathname === '/api/loglevel' && req.method === 'POST') {
          const body = await readBody(req);
          setLevel(body.level);
          globalCfg.logLevel = body.level;
          await saveGlobalConfig?.(globalCfg).catch(() => {});
          return json(res, 200, { ok: true, level: getLevel() });
        }

        // 网关操作
        if (pathname === '/api/gateway/reconnect' && req.method === 'POST') {
          // 已经下线时没有「重连」可言，直接当上线处理，免得点了没反应
          if (!rt.online) {
            const state = await rt.goOnline();
            return json(res, 200, { ok: state === 'online', state, error: rt.lastError || '' });
          }
          await getGateway?.()?.restart();
          return json(res, 200, { ok: true, state: rt.state });
        }
        if (
          (pathname === '/api/credential/refresh' || pathname === '/api/token/refresh') &&
          req.method === 'POST'
        ) {
          await tokens?.refresh();
          return json(res, 200, { ok: true });
        }

        // 主动发消息（调试用）
        if (pathname === '/api/send' && req.method === 'POST') {
          const body = await readBody(req);
          const { scene, target, content } = body;
          if (!target || !content) return json(res, 400, { error: '需要 target 和 content' });
          const sender = scene === 'c2c' ? api?.sendC2C : api?.sendGroup;
          if (!sender) return json(res, 503, { error: '未连接' });
          const r = await sender.call(api, target, { content });
          return json(res, 200, { ok: true, id: r?.id });
        }

        // SSE
        if (pathname === '/api/stream' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`event: status\ndata: ${JSON.stringify(statusPayload(rt))}\n\n`);
          sseClients.set(res, rt.id);
          const ping = setInterval(() => {
            try {
              res.write(': ping\n\n');
            } catch {}
          }, 15000);
          req.on('close', () => {
            clearInterval(ping);
            sseClients.delete(res);
          });
          return;
        }

        // 事件订阅与接收情况
        if (pathname === '/api/events' && req.method === 'GET') {
          const mask = Number(cfg.intents) || 0;
          const { enabled } = describeIntents(mask);
          const groups = [];
          for (const [group, items] of groupEvents()) {
            groups.push({
              group,
              items: items.map((it) => ({
                name: it.name,
                intent: it.intent,
                intentName: INTENT_META[it.intent]?.name ?? it.intent,
                desc: it.desc,
                message: it.message ?? null,
                doc: it.doc !== false,
                subscribed: enabled.includes(it.intent),
                count: runtime.eventCounts.get(it.name) ?? 0,
                lastAt: runtime.eventLastAt.get(it.name) ?? 0,
              })),
            });
          }
          return json(res, 200, {
            intents: mask,
            enabled,
            intentsMeta: INTENT_META,
            total: EVENT_NAMES.length,
            received: EVENT_NAMES.filter((n) => (runtime.eventCounts.get(n) ?? 0) > 0).length,
            groups,
          });
        }

        // 更新一个已安装的插件。会覆盖本地目录，所以前端必须弹窗确认过
        if (pathname === '/api/market/update' && req.method === 'POST') {
          const body = await readBody(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { error: '缺少插件 id' });
          let repo = null;
          try {
            const src = globalCfg.plugins?.marketUrl || undefined;
            const idx = await fetchIndex(src);
            const entry = idx.plugins.find((p) => p.id === id);
            if (!entry) return json(res, 404, { error: `市场里没有 ${id}` });

            const localVers = await plugins.localVersions();
            const cur = localVers[id];
            if (!cur) return json(res, 400, { error: `本地没装 ${id}，先用「安装」` });
            if (compareVersion(cur, entry.version) >= 0) {
              return json(res, 400, { error: `${id} 已经是 ${cur}，没有新版` });
            }

            // 拉一次仓库，只更新指定的这一个
            repo = await syncRepo({ repo: idx.repo, branch: idx.branch || 'main', indexUrl: src });
            const r = await updatePlugins({
              tmp: repo.tmp,
              index: repo.index,
              pluginsDir: DIRS.plugins,
              ids: [id],
              localVersions: localVers,
            });
            if (r.failed.length) return json(res, 400, { error: r.failed[0].error });
            if (!r.updated.length) return json(res, 400, { error: `${id} 没有可用的更新` });

            // 更新完重载该插件。玩家存档在 data/ 下，不受影响
            await plugins.reload(id).catch((e) => {
              log.warn(`插件 ${id} 更新后重载失败: ${e.message}`);
            });
            const scanned = await plugins.rescan();
            return json(res, 200, { ok: true, from: r.updated[0].from, to: r.updated[0].to, ...scanned });
          } catch (e) {
            return json(res, 400, { error: e.message });
          } finally {
            await cleanupRepo(repo?.tmp);
          }
        }

        // 一键更新全部有新版 的插件。同样会覆盖本地目录
        if (pathname === '/api/market/update-all' && req.method === 'POST') {
          let repo = null;
          try {
            const src = globalCfg.plugins?.marketUrl || undefined;
            repo = await syncRepo({ indexUrl: src });
            const localVers = await plugins.localVersions();
            const r = await updatePlugins({
              tmp: repo.tmp,
              index: repo.index,
              pluginsDir: DIRS.plugins,
              localVersions: localVers,
            });

            // 更新成功的逐个重载，失败的不碰
            for (const u of r.updated) {
              await plugins.reload(u.id).catch((e) => {
                log.warn(`插件 ${u.id} 更新后重载失败: ${e.message}`);
              });
            }
            const scanned = await plugins.rescan();
            return json(res, 200, { ok: true, ...r, ...scanned });
          } catch (e) {
            return json(res, 400, { error: e.message });
          } finally {
            await cleanupRepo(repo?.tmp);
          }
        }

        // 关闭程序（前端已做二次确认）
        if (pathname === '/api/shutdown' && req.method === 'POST') {
          log.info('面板请求关闭程序');
          // 先把响应发出去，再退出，否则前端只会看到连接中断
          json(res, 200, { ok: true, message: '正在关闭' });
          setTimeout(() => {
            try {
              if (onShutdown) onShutdown();
              else process.exit(0);
            } catch {
              process.exit(0);
            }
          }, 200);
          return;
        }

        return json(res, 404, { error: '接口不存在' });
      }

      // ---------------- 静态文件 ----------------
      let filePath = pathname === '/' ? '/index.html' : pathname;
      const abs = path.resolve(WEB_ROOT, '.' + filePath);
      const rel = path.relative(WEB_ROOT, abs);
      // rel 以 .. 开头或为绝对路径，说明跑出了 web 目录
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      let content;
      try {
        content = await fs.readFile(abs);
      } catch {
        // 只有「不像静态资源」的路径才回退到 index.html（前端路由），
        // 带扩展名的直接 404，免得把缺失的 js/css 也伪装成 200
        if (path.extname(abs)) {
          res.writeHead(404);
          return res.end('not found');
        }
        try {
          content = await fs.readFile(path.join(WEB_ROOT, 'index.html'));
          filePath = '/index.html';
        } catch {
          res.writeHead(404);
          return res.end('not found');
        }
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } catch (e) {
      log.error('面板请求出错:', e.message);
      if (!res.headersSent) json(res, 500, { error: e.message });
      else res.end();
    }
  });

  /* ---------------- 监听（端口被占用自动顺延） ---------------- */

  const tries = Math.max(1, Number(wc.portTries) || 20);
  let actualPort;
  try {
    actualPort = await listenWithFallback(server, host, port, {
      tries,
      onBusy: (p) => log.warn(`端口 ${p} 被占用，换 ${p + 1} 试试`),
    });
  } catch (e) {
    log.error(
      `端口 ${port}${tries > 1 ? `~${port + tries - 1}` : ''} 都不可用，可视化面板未启动: ${e.message}`,
    );
    clearInterval(statusTimer);
    offLog();
    return null;
  }

  // 面板监听成功后，运行期再出错只记日志，不影响机器人本体
  server.on('error', (e) => log.error('面板出错:', e.message));

  const shownHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${shownHost}:${actualPort}/${
    accessKey ? '?key=' + encodeURIComponent(accessKey) : ''
  }`;
  log.info(`可视化面板: ${url}`);

  return {
    server,
    url,
    port: actualPort,
    close() {
      clearInterval(statusTimer);
      offLog();
      for (const c of sseClients.keys()) {
        try {
          c.end();
        } catch {}
      }
      sseClients.clear();
      server.close();
    },
  };
}
