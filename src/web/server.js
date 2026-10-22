import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../config.js';
import { createLogger, recentLogs, onLog, getLevel, setLevel } from '../logger.js';
import { runtime } from '../runtime.js';

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
 * 可视化面板。
 *
 * 默认只监听 127.0.0.1，不对外暴露。
 * 设置 webui.accessKey 后，所有 /api/* 请求需要带 X-Access-Key 头或 ?key=。
 */
export function startWebServer({ cfg, plugins, groups, roles, getGateway, tokens, api, saveConfig, onConfigApplied }) {
  const wc = cfg.webui ?? {};
  if (wc.enabled === false) {
    log.info('可视化面板已禁用（config.json → webui.enabled = false）');
    return null;
  }

  const host = wc.host || '127.0.0.1';
  const port = Number(wc.port) || 8080;
  const accessKey = wc.accessKey || wc.token || '';

  const sseClients = new Set();

  const statusPayload = () =>
    runtime.snapshot({
      credentialExpiresIn: Math.max(0, Math.round(((tokens?.expiresAt ?? 0) - Date.now()) / 1000)),
      plugins: plugins.list(),
      cfg,
    });

  // 日志实时推送
  const offLog = onLog((entry) => {
    const data = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch {}
    }
  });

  const statusTimer = setInterval(() => {
    if (!sseClients.size) return;
    const data = `event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
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
          return json(res, 200, statusPayload());
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
            cfg.logLevel = body.logLevel;
            setLevel(body.logLevel);
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
          if (body.autoOwnerOnInvite !== undefined) {
            cfg.autoOwnerOnInvite = Boolean(body.autoOwnerOnInvite);
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

          await saveConfig(cfg);
          log.info('配置已通过面板更新');

          const after = JSON.stringify({ appId: cfg.appId, intents: cfg.intents });
          if (before !== after) {
            log.info('连接参数变化，正在重连网关...');
            onConfigApplied?.().catch(() => {});
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
          if (body.adminOpenid !== undefined) patch.adminOpenid = String(body.adminOpenid).trim();
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
          if (level === 0) return json(res, 400, { error: '主人只能在 config.json 设置' });
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
          cfg.logLevel = body.level;
          await saveConfig(cfg);
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
          res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
          sseClients.add(res);
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

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') log.error(`端口 ${port} 被占用，可视化面板未启动`);
    else log.error('面板启动失败:', e.message);
  });

  server.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    log.info(`可视化面板: http://${shown}:${port}${accessKey ? '/?key=' + accessKey : ''}`);
  });

  return {
    server,
    close() {
      clearInterval(statusTimer);
      offLog();
      for (const c of sseClients) {
        try {
          c.end();
        } catch {}
      }
      sseClients.clear();
      server.close();
    },
  };
}
