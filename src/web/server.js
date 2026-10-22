import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../config.js';
import { botPaths, listBotIds, rel } from '../paths.js';
import { createLogger, recentLogs, onLog, getLevel, setLevel } from '../logger.js';
import { runtime } from '../runtime.js';
import { EVENT_NAMES, INTENT_META, describeIntents, groupEvents } from '../events.js';

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
}) {
  const wc = globalCfg.webui ?? {};
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

  const statusPayload = (rt) =>
    runtime.snapshot({
      credentialExpiresIn: Math.max(0, Math.round(((rt?.tokens?.expiresAt ?? 0) - Date.now()) / 1000)),
      plugins: rt ? rt.plugins.list() : [],
      cfg: rt?.cfg ?? {},
      botId: rt?.id ?? null,
      botName: rt?.name ?? null,
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
            return json(res, 200, { ok: true, id, state: created?.state ?? 'unknown' });
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

        // 状态
        if (pathname === '/api/status' && req.method === 'GET') {
          return json(res, 200, statusPayload(rt));
        }

        // 配置读取（隐藏密钥）
        if (pathname === '/api/config' && req.method === 'GET') {
          return json(res, 200, {
            ...cfg,
            appSecret: cfg.appSecret ? '********' : '',
            appSecretSet: Boolean(cfg.appSecret),
          });
        }

        // 配置保存
        if (pathname === '/api/config' && req.method === 'PUT') {
          const body = await readBody(req);
          const before = JSON.stringify({ appId: cfg.appId, intents: cfg.intents });

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
            cfg.webui = { ...cfg.webui, ...body.webui };
          }

          await saveBotConfig(rt.id, cfg);
          log.info('配置已通过面板更新');

          const after = JSON.stringify({ appId: cfg.appId, intents: cfg.intents });
          if (before !== after) {
            log.info('连接参数变化，正在重连网关...');
            rt.gateway?.restart?.().catch(() => {});
          }
          return json(res, 200, { ok: true });
        }

        // 插件
        if (pathname === '/api/plugins' && req.method === 'GET') {
          return json(res, 200, plugins.list());
        }
        const m = pathname.match(/^\/api\/plugins\/([^/]+)\/(enable|disable|reload)$/);
        if (m && req.method === 'POST') {
          const [, id, action] = m;
          let ok = false;
          if (action === 'enable') ok = await plugins.setEnabled(id, true);
          else if (action === 'disable') ok = await plugins.setEnabled(id, false);
          else ok = await plugins.reload(id);
          return json(res, ok ? 200 : 500, { ok, error: ok ? undefined : '操作失败，看日志' });
        }

        // 群档案
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
          await getGateway?.()?.restart();
          return json(res, 200, { ok: true });
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
