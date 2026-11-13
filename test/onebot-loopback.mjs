/**
 * OneBot 兼容层回环测试
 * =====================
 *
 * 起一个真的 WS 服务端，用一个真的 WS 客户端连上去，走一遍：
 *
 *   事件推送 → 客户端发 action → outbound 收到正确报文（带 msgId = 被动回复）
 *
 * 用假的 runtime（api / outbound / gate / groups 都是桩），所以不碰真 QQ、
 * 不写真实数据目录。
 *
 * **需要 `ws` 已装到 `data/deps/onebot`**。没装就跳过——单元测试不该联网装包。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 允许外部指定 HOME（本地想复用已装好 ws 的目录时很方便） */
const home = process.env.ROOST_HOME || (await fs.mkdtemp(path.join(os.tmpdir(), 'roost-onebot-loop-')));
process.env.ROOST_HOME = home;

const deps = await import('../src/ext-deps.js');
const { OneBotBridge } = await import('../src/onebot/index.js');

const depState = await deps.status();
const missingWs = !depState.packages.ws?.resolvable;

/** 等某个条件成立（最多 3s） */
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待超时');
}

function fakeRuntime(calls) {
  return {
    cfg: { id: 't', name: '测试鸟' },
    api: {
      async uploadMedia() {
        return { file_info: 'file-info-1' };
      },
      async uploadLocalFile() {
        return { file_info: 'file-info-1' };
      },
      async getGroupInfo() {
        return { group_name: '测试群' };
      },
      async retractGroupMessage() {
        calls.push(['retract']);
      },
      async retractC2CMessage() {
        calls.push(['retract-c2c']);
      },
    },
    outbound: {
      async send(o) {
        calls.push(o);
        return { id: 'official-1' };
      },
    },
    gate: { check: () => ({ ok: true, reasons: [] }) },
    groups: { async list() { return [{ groupOpenid: 'G1' }]; } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
}

const identity = {
  uinOf: (o) => (o === 'U1' ? '2014433751' : ''),
  groupUinOf: (o) => (o === 'G1' ? '763366431' : ''),
  openidOf: (_b, uin) => (uin === '2014433751' ? 'U1' : ''),
  groupOpenidOf: (_b, uin) => (uin === '763366431' ? 'G1' : ''),
};

test('回环：事件推送 + action 收发', { skip: missingWs && '没装 ws（data/deps/onebot），跳过回环' }, async () => {
  const calls = [];
  const bridge = new OneBotBridge({
    runtime: fakeRuntime(calls),
    cfg: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      token: '0123456789abcdef0123',
      selfUin: '1427835822',
      mode: 'exclusive',
      forwardAll: true,
      http: true,
    },
    botId: 't',
    identity,
  });

  await bridge.start();
  assert.equal(bridge.state, 'running', bridge.error);
  /**
   * 全量群消息是**平台开关**，配置里查不到，所以只能用「见过非 @ 的群消息」
   * 当证据。没见过就如实报 false，别让面板假装全量已开。
   */
  const snap = bridge.snapshot();
  assert.equal(snap.upstream.intents, 0, 'fakeRuntime 没设 intents，应如实报 0');
  assert.equal(snap.upstream.groupAll, false, '还没见过非 @ 群消息时不能声称全量已开');
  bridge.sawUnaddressedGroup = true;
  assert.equal(bridge.snapshot().upstream.groupAll, true, '见过之后应标记为 true');
  bridge.sawUnaddressedGroup = false;
  const port = bridge.port;
  assert.ok(port > 0);

  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?access_token=0123456789abcdef0123`);
  ws.addEventListener('message', (e) => {
    try {
      events.push(JSON.parse(String(e.data)));
    } catch {
      // 忽略非 JSON
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 连不上')), { once: true });
  });

  // 连上先收到 lifecycle
  await waitFor(() => events.find((e) => e.meta_event_type === 'lifecycle'));

  /* ---------- 入站消息 → 事件 ---------- */
  bridge.onMessage({
    id: 'm1',
    chatId: 'G1',
    kind: 'group',
    groupId: 'G1',
    userId: 'U1',
    userName: '倦飞之鸟',
    content: '在吗',
    msgIdx: 'REFIDX_1',
    receivedAt: Date.now(),
    mentions: [],
    attachments: [],
    addressed: true,
    isCommand: false,
    mentioned: false,
    raw: { author: { member_role: 'owner' } },
  });

  const ev = await waitFor(() => events.find((e) => e.post_type === 'message'));
  assert.equal(ev.message_type, 'group');
  assert.equal(ev.group_id, 763366431, '群号走 identity 真号');
  assert.equal(ev.user_id, 2014433751, 'QQ 号走 identity 真号');
  assert.equal(ev.self_id, 1427835822);
  assert.deepEqual(ev.message, [{ type: 'text', data: { text: '在吗' } }]);
  assert.equal(ev.sender.role, 'owner');

  /* ---------- 客户端发 action ---------- */
  ws.send(
    JSON.stringify({
      action: 'send_group_msg',
      params: { group_id: 763366431, message: [{ type: 'text', data: { text: '在' } }] },
      echo: 'e1',
    }),
  );
  const res = await waitFor(() => events.find((e) => e.echo === 'e1'));
  assert.equal(res.retcode, 0, JSON.stringify(res));
  assert.ok(res.data.message_id > 0);

  const sent = calls.find((c) => c && c.payload);
  assert.ok(sent, 'outbound 应该被调用');
  assert.equal(sent.kind, 'group');
  assert.equal(sent.target, 'G1');
  assert.equal(sent.chatKey, 'group:G1');
  assert.equal(sent.payload.content, '在');
  assert.equal(sent.payload.msgId, 'm1', '刚收过消息 → 应该走被动回复');
  /**
   * 投递账本只认「带 requestId 的发送」。OneBot 以前一个都不带，
   * 客户端发出去的消息在面板「投递」页完全看不到。
   */
  assert.match(String(sent.requestId ?? ''), /^ob-/, 'OneBot 发送必须带幂等键，否则不入投递账本');

  /* ---------- 未实现的 action 必须报 1404 ---------- */
  ws.send(JSON.stringify({ action: 'send_poke', params: {}, echo: 'e2' }));
  const bad = await waitFor(() => events.find((e) => e.echo === 'e2'));
  assert.equal(bad.retcode, 1404);
  assert.match(bad.wording, /send_poke/);

  /* ---------- HTTP 同端口 ---------- */
  const httpRes = await fetch(`http://127.0.0.1:${port}/get_login_info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer 0123456789abcdef0123' },
    body: '{}',
  });
  const httpJson = await httpRes.json();
  assert.equal(httpJson.retcode, 0);
  assert.equal(httpJson.data.user_id, 1427835822);

  /* ---------- token 不对要拒 ---------- */
  const denied = await fetch(`http://127.0.0.1:${port}/get_login_info`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);

  ws.close();
  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
});
