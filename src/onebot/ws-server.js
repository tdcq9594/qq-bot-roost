/**
 * OneBot v11 传输层（WS + HTTP 同端口）
 * =====================================
 *
 * 为什么同端口：客户端（aurobot 等）要填 WS 地址和 HTTP 地址两个框，
 * 分成两个端口就会出现「WS 连上了、HTTP 填错」这种半通状态，排查成本很高。
 * 这里一个 `http.Server` 同时处理 `POST /<action>` 和 `upgrade`。
 *
 * 依赖 `ws`（按需安装，见 deps.js）。没装就不该走到这里——上层会先检查。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('onebot-ws');

/** 单条报文上限：OneBot 报文很小，超过 1MB 基本就是打错了 */
const MAX_PAYLOAD = 1024 * 1024;

/** 心跳周期：30s 发一次 ping，一个周期没 pong 就断 */
const PING_MS = 30_000;

/** token 比较：长度不等直接 false，长度相等再走 timingSafeEqual（它长度不同会抛） */
function tokenOk(given, want) {
  if (!want) return true;
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(want));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 从请求里取 token：`?access_token=` 或 `Authorization: Bearer xxx` */
function tokenOf(req, url) {
  const q = url?.searchParams?.get('access_token');
  if (q) return q;
  const h = String(req.headers?.authorization ?? '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : '';
}

/**
 * @param {object} p
 * @param {string} p.host
 * @param {number} p.port
 * @param {string} p.token
 * @param {object} p.ws          `ws` 模块本身（由 deps.load('ws') 传进来，**不能静态 import**）
 * @param {(action:string, params:object)=>Promise<any>} p.onAction
 * @param {(client:object)=>void} [p.onConnect]
 * @param {boolean} [p.http] 是否接受 HTTP API
 */
export function createOneBotServer({
  host,
  port,
  token,
  ws: wsMod,
  onAction,
  onConnect = null,
  http: enableHttp = true,
  maxConnections = 4,
}) {
  const { WebSocketServer } = wsMod;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

    if (!enableHttp) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: 'failed', retcode: 1404, data: null }));
    }
    if (!tokenOk(tokenOf(req, url), token)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: 'failed', retcode: 1401, data: null, wording: 'access token 不对' }));
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({ app: 'roost-onebot', protocol: 'v11', ok: true, note: 'POST /<action> 调用接口' }),
      );
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ status: 'failed', retcode: 1404, data: null }));
    }

    const action = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_PAYLOAD) {
        res.writeHead(413).end();
        return;
      }
    }
    let params = {};
    if (body.trim()) {
      try {
        params = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(
          JSON.stringify({ status: 'failed', retcode: 1400, data: null, wording: '请求体不是合法 JSON' }),
        );
      }
    }

    let out;
    try {
      out = { status: 'ok', retcode: 0, data: await onAction(action, params ?? {}), echo: params?.echo };
    } catch (e) {
      out = {
        status: 'failed',
        retcode: Number(e?.retcode) || 1500,
        data: null,
        wording: String(e?.message ?? '内部错误'),
        echo: params?.echo,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (!tokenOk(tokenOf(req, url), token)) {
      // 握手阶段就拒，不进 WS 状态机
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    // 连接数上限：超了直接关，别让一个客户端把端口占满
    if (wss.clients.size > Math.max(1, Number(maxConnections) || 4)) {
      try {
        ws.close(1013, 'too many connections');
      } catch {
        // 忽略：连接可能已经断了
      }
      return;
    }
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (e) => log.warn(`连接异常：${e.message}`));
    ws.on('message', async (raw) => {
      let payload;
      try {
        payload = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ status: 'failed', retcode: 1400, data: null, wording: '报文不是合法 JSON' }));
        return;
      }
      const action = String(payload?.action ?? '');
      try {
        const data = await onAction(action, payload?.params ?? {});
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload?.echo }));
      } catch (e) {
        ws.send(
          JSON.stringify({
            status: 'failed',
            retcode: Number(e?.retcode) || 1500,
            data: null,
            wording: String(e?.message ?? '内部错误'),
            echo: payload?.echo,
          }),
        );
      }
    });
    try {
      onConnect?.(ws);
    } catch (e) {
      log.warn(`连接回调出错：${e.message}`);
    }
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // 连接已经烂了，下一轮会被 terminate
      }
    }
  }, PING_MS);
  pinger.unref?.();

  return {
    /** 实际监听端口（`port: 0` 时由系统分配） */
    get port() {
      return server.address()?.port ?? port;
    },
    get connections() {
      return wss.clients.size;
    },
    broadcast(event) {
      const text = JSON.stringify(event);
      for (const ws of wss.clients) {
        if (ws.readyState === 1) {
          try {
            ws.send(text);
          } catch (e) {
            log.warn(`推送失败：${e.message}`);
          }
        }
      }
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
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'server closing');
        } catch {
          // 忽略：下面统一 terminate
        }
      }
      /**
       * `wss.close()` 的回调要等所有连接走完 close 握手，对端不理就是 30s。
       * 面板保存配置 / 关机器人时会被这一下卡住，所以给 600ms 宽限后强拆。
       */
      const hard = setTimeout(() => {
        for (const ws of wss.clients) {
          try {
            ws.terminate();
          } catch {
            // 已经关了
          }
        }
      }, 600);
      hard.unref?.();
      await new Promise((resolve) => wss.close(() => resolve()));
      clearTimeout(hard);
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
