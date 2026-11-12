/**
 * 宿主协议 v1 传输层（WS + HTTP + SSE 同端口）
 * ===========================================
 *
 * 一个 `http.Server` 同时处理：
 *   POST /rpc      一问一答调一个方法（curl 可测）
 *   GET  /events   SSE 事件流（只推，给不方便用 WS 的客户端 / 抓包排查）
 *   GET  /ws       WS 升级，双向帧（主通道）
 *   GET  /health   探活，免 token
 *
 * `ws` 模块由调用方用 `deps.load('ws')` 传进来，**不静态 import**。
 * 没装时 `state = 'missing-deps'`，机器人本体照常跑（见 index.js）。
 *
 * 顺序保证：`attach()` 必须同步执行完「注册 sink + 生成 welcome + 补拉」。
 * JS 单线程下这一步中间不会插入 broadcast，所以补拉和实时推送既不会
 * 重复也不会漏——这也是 onHello 不做成 async 的原因。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('host-ws');

/** 单条报文上限：方法参数里可能带图片 base64，给到 1 MiB */
const MAX_PAYLOAD = 1024 * 1024;
const PING_MS = 30_000;

/** 与 onebot/ws-server.js 同一套比较方式：长度不等先拒，等长再定时安全比较 */
function tokenOk(given, want) {
  if (!want) return true;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(want));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function tokenOf(req, url) {
  const q = url?.searchParams?.get('access_token');
  if (q) return q;
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers?.authorization ?? ''));
  return m ? m[1] : '';
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** SSE 文本帧：`id` 只在事件帧上给，浏览器重连会把它放进 Last-Event-ID */
function sseOf(frame) {
  const id = Number.isFinite(frame?.seq) ? `id: ${frame.seq}\n` : '';
  const ev = frame?.type === 'event' ? (frame.event || 'event') : (frame?.type || 'message');
  return `${id}event: ${ev}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * @param {object} p
 * @param {string} p.host
 * @param {number} p.port
 * @param {string} p.token
 * @param {object|null} p.ws             `ws` 模块本身；null 表示只开 HTTP
 * @param {number} [p.maxConnections]
 * @param {(sink:object, info:object)=>{welcome:object, frames:object[]}} p.attach
 * @param {(frame:object, ctx:object)=>Promise<object>} p.onRpc
 * @param {()=>object} p.health
 */
export function createHostServer({
  host,
  port,
  token,
  ws: wsMod,
  maxConnections = 4,
  attach,
  onRpc,
  health = () => ({}),
}) {
  /** id → {send(obj), close()}；WS 与 SSE 共用一份，broadcast 不区分 */
  const sinks = new Map();
  let nextId = 0;

  const atCapacity = () => sinks.size >= Math.max(1, Number(maxConnections) || 4);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { app: 'roost-host', protocol: 1, ok: true, ...health() });
    }

    /** 不设任何 CORS 头；带 Origin 且不同源直接拒，别让网页拿本地 token 乱调 */
    const origin = String(req.headers?.origin ?? '');
    if (origin) {
      try {
        if (new URL(origin).host !== String(req.headers.host ?? '')) {
          return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: '跨源请求被拒绝' } });
        }
      } catch {
        return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Origin 不合法' } });
      }
    }
    if (!tokenOk(tokenOf(req, url), token)) {
      return sendJson(res, 401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'access token 不对' },
      });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return sendJson(res, 200, {
        app: 'roost-host', protocol: 1, ok: true,
        endpoints: ['POST /rpc', 'GET /events', 'GET /ws', 'GET /health'],
      });
    }

    /* ---------------- SSE ---------------- */
    if (req.method === 'GET' && url.pathname === '/events') {
      if (atCapacity()) return sendJson(res, 503, { ok: false, error: { code: 'BUSY', message: '连接数已满' } });
      const since = Number(url.searchParams.get('since') ?? req.headers['last-event-id'] ?? 0) || 0;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': roost-host/1\n\n');

      const id = ++nextId;
      const sink = {
        send: (frame) => {
          try {
            res.write(sseOf(frame));
          } catch {
            /* 对端断了，close 事件会清掉 */
          }
        },
        close: () => res.end(),
      };
      /** attach 同步返回：注册 + welcome + 补拉一气呵成，中间不会插进实时事件 */
      const { welcome, frames } = attach(sink, {
        id, since, via: 'sse', peer: String(req.socket?.remoteAddress ?? ''),
      });
      sinks.set(id, sink);
      sink.send({ type: 'welcome', ...welcome });
      for (const f of frames) sink.send(f);

      req.on('close', () => sinks.delete(id));
      return;
    }

    /* ---------------- HTTP RPC ---------------- */
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > MAX_PAYLOAD) {
          res.writeHead(413).end();
          return;
        }
      }
      let payload;
      try {
        payload = body.trim() ? JSON.parse(body) : {};
      } catch {
        return sendJson(res, 400, {
          id: '', ok: false,
          error: { code: 'BAD_REQUEST', message: '请求体不是合法 JSON' },
        });
      }
      const out = await onRpc(
        { id: payload?.id ?? '', method: payload?.method, params: payload?.params ?? {} },
        { via: 'http', peer: String(req.socket?.remoteAddress ?? '') },
      );
      return sendJson(res, Number(out.http) || 200, {
        id: out.id ?? '',
        ok: Boolean(out.ok),
        ...(out.ok ? { data: out.data ?? null } : { error: out.error }),
      });
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个端点' } });
  });

  /* ---------------- WebSocket ---------------- */
  let wss = null;
  if (wsMod?.WebSocketServer) {
    wss = new wsMod.WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (!['/', '/ws'].includes(url.pathname)) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const origin = String(req.headers?.origin ?? '');
      if (origin) {
        try {
          if (new URL(origin).host !== String(req.headers.host ?? '')) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          socket.destroy();
          return;
        }
      }
      if (!tokenOk(tokenOf(req, url), token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws) => {
      if (atCapacity()) {
        try {
          ws.close(1013, 'too many connections');
        } catch {
          /* 忽略 */
        }
        return;
      }
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('error', (e) => log.warn(`连接异常：${e.message}`));

      const id = ++nextId;
      let attached = null;
      const sink = {
        send: (frame) => {
          if (ws.readyState !== 1) return;
          try {
            ws.send(JSON.stringify(frame));
          } catch (e) {
            log.warn(`推送失败：${e.message}`);
          }
        },
        close: () => {
          try {
            ws.close(1001, 'server closing');
          } catch {
            /* 忽略 */
          }
        },
      };

      ws.on('message', async (raw) => {
        let f;
        try {
          f = JSON.parse(String(raw));
        } catch {
          sink.send({ type: 'res', id: '', ok: false, error: { code: 'BAD_REQUEST', message: '报文不是合法 JSON' } });
          return;
        }
        const type = String(f?.type ?? '');

        if (type === 'hello' || type === 'req') {
          /** 第一个 hello/req 都算握手：先注册，避免漏掉握手期间的事件 */
          if (!attached) {
            const since = Number(f.since ?? 0) || 0;
            const got = attach(sink, {
              id, since, via: 'ws', peer: String(ws._socket?.remoteAddress ?? ''),
              client: String(f.client ?? ''),
              protocol: Number(f.protocol ?? 0),
            });
            attached = got;
            sinks.set(id, sink);
            sink.send({ type: 'welcome', ...got.welcome });
            for (const frame of got.frames) sink.send(frame);
          }
          if (type === 'hello') return;
        }

        if (type === 'req') {
          const out = await onRpc(
            { id: f.id ?? '', method: f.method, params: f.params ?? {} },
            { via: 'ws', clientId: id, peer: String(ws._socket?.remoteAddress ?? '') },
          );
          sink.send({
            type: 'res', id: out.id ?? '', ok: Boolean(out.ok),
            ...(out.ok ? { data: out.data ?? null } : { error: out.error }),
          });
          return;
        }
        if (type === 'ping') {
          sink.send({ type: 'pong', at: Date.now() });
          return;
        }
        if (!attached) {
          sink.send({ type: 'res', id: f.id ?? '', ok: false, error: { code: 'BAD_REQUEST', message: '先发 hello' } });
        }
      });

      ws.on('close', () => sinks.delete(id));
    });
  }

  const pinger = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* 下一轮 terminate */
      }
    }
  }, PING_MS);
  pinger.unref?.();

  return {
    get port() {
      return server.address()?.port ?? port;
    },
    get connections() {
      return sinks.size;
    },
    broadcast(frame) {
      for (const sink of sinks.values()) sink.send(frame);
    },
    start() {
      return new Promise((resolve, reject) => {
        const onError = (e) => {
          server.removeListener('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve(server.address()?.port ?? port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    async stop() {
      clearInterval(pinger);
      for (const sink of sinks.values()) sink.close();
      sinks.clear();
      if (wss) {
        const hard = setTimeout(() => {
          for (const ws of wss.clients) {
            try {
              ws.terminate();
            } catch {
              /* 已经关了 */
            }
          }
        }, 600);
        hard.unref?.();
        await new Promise((resolve) => wss.close(() => resolve()));
        clearTimeout(hard);
      }
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 2000);
        t.unref?.();
        server.close(() => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
