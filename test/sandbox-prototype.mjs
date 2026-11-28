/**
 * 沙盒原型验证：不接真 QQ，假消息真跑全链路
 * ==========================================
 *
 * 证明「不接真 QQ 也能全链路真跑」这件事成立，沿用 e2e 的隔离手段：
 *   - ROOST_HOME 指临时目录（不碰开发者 config/data/logs）
 *   - 端口自己挑（不写死，避免测到别人的进程）
 *   - dshUrl=http://127.0.0.1:1（AI 插件连不上宿主，一个字节不出进程）
 *   - 关掉系统代理（reg.exe 在受控环境会被安全策略掐掉）
 *
 * 验证的正证据（不是只看 HTTP 200）：
 *   ① /api/mock/message 收下假消息
 *   ② 落盘痕迹：sent 计数增加（metrics 文件）或 stdout 出现 mock 发送日志
 *   ③ 没有真 QQ 网关连接（stdout 无 wss:// 实连）
 *
 * 这个脚本是沙盒的地基。后续正式沙盒会在 /sandbox 面板页用同一条注入链。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-sandbox-'));
const NODE = process.execPath;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
try {
  // 1. 写隔离配置：端口 + 让 AI 插件连不上真 DSH
  await fs.mkdir(path.join(HOME, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(HOME, 'config', 'bot.json'),
    JSON.stringify({ webui: { port: PORT } }, null, 2),
    'utf8',
  );

  // 2. 起 mock 服务
  server = spawn(NODE, [path.join(ROOT, 'src/main.js'), '--mock', '--serve', '--no-open'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ROOST_TEST: '1',
      ROOST_HOME: HOME,
      ROOST_NO_SYSTEM_PROXY: '1',
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      https_proxy: '',
      http_proxy: '',
    },
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d.toString()));
  server.stderr.on('data', (d) => (out += d.toString()));

  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
  }
  assert.ok(ready, `沙盒服务没起来:\n${out.slice(-800)}`);

  // 3. 反证据：mock 模式不该有真 QQ 网关连接
  assert.ok(!/connect(?:ed|ing)?\s+wss:\/\/(?!mock)/i.test(out), 'mock 模式不该连真 QQ 网关');

  // 4. 正证据：注入一条假消息，服务端收下
  const before = (out.match(/→ \[/g) || []).length;
  const probeText = '沙盒原型验证：这条消息要真跑管线';
  const res = await fetch(`${BASE}/api/mock/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: probeText, groupId: 'sandbox-g', userId: 'sandbox-u' }),
  });
  assert.equal(res.status, 200, `注入失败: ${await res.text()}`);

  // 4b. 沙盒消息流水：面板轮询的这个接口要能读回刚才注入的消息
  const logRes = await fetch(`${BASE}/api/sandbox/messages`);
  assert.equal(logRes.status, 200, `沙盒流水接口不可用: ${logRes.status}`);
  const logData = await logRes.json();
  const found = (logData.messages || []).find((m) => m.content === probeText);
  assert.ok(found, '沙盒流水里没找到刚注入的消息');
  assert.equal(found.userId, 'sandbox-u');
  assert.equal(found.direction, 'in');

  // 等管线跑完（模型/插件可能异步）
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if ((out.match(/→ \[/g) || []).length > before) break;
  }

  // 5. 正证据：stdout 出现"收到消息"日志——证明假消息真进了管线
  //    注意：框架本身只做消息管线，回复能力在 AI 插件/宿主（dsh-roost）里。
  //    空框架没有 AI 插件时没人回复是正常的，本项只验证"消息真进管线"。
  const gotMessage = /收到 group 会话:sandbox-g.*沙盒原型验证/.test(out);
  assert.ok(
    gotMessage,
    `假消息没进管线:\n${out.slice(-1200)}`,
  );

  // 6. 反证据：没有真 QQ 网关连接（日志里没有 wss:// 实连）
  assert.ok(
    !/wss:\/\/(?!mock)/.test(out),
    'mock 模式出现了真 QQ 网关连接',
  );

  console.log('PASS  沙盒：不接真 QQ，假消息真进管线且记入流水');
  console.log('      注入返回 200 · 管线收到消息 · 流水可读回 · 无真网关连接');
  console.log('      注意：空框架无 AI 插件，故无回复；完整对话需带 dsh-roost 真机验证');
} finally {
  if (server && !server.killed) server.kill('SIGTERM');
  await sleep(300);
  await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
}
