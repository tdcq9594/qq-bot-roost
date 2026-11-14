/**
 * 出站入账回归（2026-11-05 批次 1）
 * ==============================
 *
 * 真机曾出现：账本 549 行里 `plugin` 非空 0 条、发图片完全不入账。
 * 根因是 `msg.replyMarkdown` / `replyMedia` 绕过攒批、且 `#recordOutbound`
 * 只挂在 `delivery.settle` 成功分支上，没有幂等键的发送直接被早返回跳过。
 *
 * 这里锁住两批改动：
 *
 * 批次 1（账本出站入账）：
 *   1. 富媒体按 fileType 给中文占位；
 *   2. 无 requestId 的发送也入账，且带 plugin / botId；
 *   3. 有 requestId 的发送**恰好记一次**（两个出口互斥，不双记）；
 *   4. reuse / 发送失败都不记账。
 *
 * 批次 1 独立复核补修（21:09，见末尾一节）：复核抓到 P1 ——
 * `msg.replyStream()` 直连 `api.sendStreamMessage`，完全绕开
 * `outbound.send()`，「一处覆盖全部路径」被证伪，单聊长回复不入账也不带 plugin。
 *   5. 流式回复 end() 补记最终全文、push 不记、重复 end 不双记；
 *   6. 群聊退化成 replyMarkdown 时只记一次；
 *   7. byUser() 的 SELECT 也带 plugin / bot_id；账本没接时静默跳过。
 *
 * 跑法：node test/ledger-outbound.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Outbound, digestTextOf } from '../src/outbound.js';
import { createLedger } from '../src/ledger.js';
import { buildMessage } from '../src/message.js';

/** 每次都给一份干净的临时库；`t.after` 保证失败时也清理 */
function rig(t, { delivery = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-out-'));
  const ledger = createLedger({ file: path.join(dir, 'events.db'), botId: 'main', retentionDays: 0 });
  ledger.open();
  /** 只用一个 after：先 close 再删，否则 Windows 上 sqlite 文件还锁着会 EBUSY */
  t.after(() => {
    try { ledger.close(); } catch {}
    /** Windows 上 WAL 文件偶尔还被占用，给几次重试，别让清理把测试判成失败 */
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  const calls = { group: 0, c2c: 0 };
  const api = {
    sendGroup: async () => { calls.group += 1; return { id: 'msg-out-1' }; },
    sendC2C: async () => { calls.c2c += 1; return { id: 'msg-out-1' }; },
  };
  const out = new Outbound({
    api,
    cfg: {},
    isOnline: () => true,
    quotaFile: path.join(dir, 'quota.json'),
    delivery,
    ledger,
  });
  return { dir, ledger, out, calls };
}

const base = (over = {}) => ({
  kind: 'group',
  target: 'g1',
  chatKey: 'group:g1',
  /** 带 msgId 走被动回复，避开主动额度与限流分支 */
  payload: { msgId: 'in-1', content: '你好' },
  ...over,
});

test('digestTextOf：富媒体按 fileType 给中文占位', () => {
  assert.equal(digestTextOf({ content: ' ' }), '', '纯空格正文视为没有正文');
  assert.equal(digestTextOf({ media: { file_info: 'x' }, fileType: 1 }), '（图片）');
  assert.equal(digestTextOf({ media: { file_info: 'x' }, fileType: 2 }), '（视频）');
  assert.equal(digestTextOf({ media: { file_info: 'x' }, fileType: 3 }), '（语音）');
  assert.equal(digestTextOf({ media: { file_info: 'x' }, fileType: 4 }), '（文件）');
  assert.equal(digestTextOf({ media: { file_info: 'x' } }), '[媒体]');
  assert.equal(digestTextOf({ ark: {} }), '[卡片]');
  assert.equal(digestTextOf({ content: '有正文' }), '有正文');
});

test('digestTextOf：图文卡片带标题，别让账本里十条长得一样', () => {
  const card = (title) => ({ msgType: 8, card: { type: 'tuwen', content: { title, description: 'd', url: 'https://a/b', pic_url: 'https://a/c' } } });
  assert.equal(digestTextOf(card('iPhone 17 Pro 发布')), '[图文卡片] iPhone 17 Pro 发布');
  assert.equal(digestTextOf({ card: { type: 'tuwen', content: {} } }), '[图文卡片]');
  // 没有标题也不能退回空串：空摘要等于这条记录在账本里消失了
  assert.notEqual(digestTextOf({ card: { type: 'tuwen' } }), '');
  /**
   * `/v1/roost.call` → `msg.send` 给的是扁平四字段（框架最终才包成官方结构），
   * 出站账本看到的也是扁平的。以前只认嵌套，摘要退化成 '[图文卡片]'。
   */
  assert.equal(
    digestTextOf({ content: '', card: { title: '扁平卡片', description: 'd', url: 'https://a/b', picUrl: 'https://a/c' } }),
    '[图文卡片] 扁平卡片',
  );
});

test('出站入账：没有 requestId（被动回复 / 富媒体 / 菜单）也要记', async (t) => {
  const { ledger, out, calls } = rig(t);
  await out.send(base({ plugin: 'ai-chat' }));
  assert.equal(calls.group, 1, '确实发出去一次');

  const rows = ledger.recent({ chatId: 'g1', limit: 10 });
  assert.equal(rows.length, 1, '账本里应有一条出站记录');
  assert.equal(rows[0].plugin, 'ai-chat', '谁说的要带出来');
  assert.equal(rows[0].botId, 'main', 'botId 要带出来（前端显示 main 靠它）');
  assert.equal(rows[0].content, '你好');
  assert.equal(rows[0].timeBasis, 'observation');
});

test('出站入账：富媒体占位 + plugin（验收 4 的前提）', async (t) => {
  const { ledger, out } = rig(t);
  await out.send(base({
    plugin: 'ai-chat',
    payload: { msgId: 'in-1', msgType: 7, content: ' ', media: { file_info: 'x' } },
    fileType: 1,
  }));
  const rows = ledger.recent({ chatId: 'g1', limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '（图片）');
  assert.equal(rows[0].plugin, 'ai-chat');
});

test('出站入账：有 requestId 走 settle 时恰好记一次，不双记', async (t) => {
  let settled = 0;
  const delivery = {
    claim: () => ({ action: 'new' }),
    settle: () => { settled += 1; },
  };
  const { ledger, out } = rig(t, { delivery });
  await out.send(base({ requestId: 'in-1:main', plugin: 'ai-chat' }));
  assert.equal(settled, 1, 'settle 只调一次');
  assert.equal(ledger.recent({ chatId: 'g1', limit: 10 }).length, 1, '两个出口互斥，只记一条');
});

test('出站入账：reuse 不重复发也不记账', async (t) => {
  const delivery = {
    claim: () => ({ action: 'reuse', row: { msg_id: 'old', state: 'sent' } }),
    settle: () => { throw new Error('reuse 不该 settle'); },
  };
  const { ledger, out, calls } = rig(t, { delivery });
  await out.send(base({ requestId: 'in-1:main', plugin: 'ai-chat' }));
  assert.equal(calls.group, 0, 'reuse 不打接口');
  assert.equal(ledger.recent({ chatId: 'g1', limit: 10 }).length, 0, 'reuse 不该新增记录');
});

test('出站入账：发送失败不记账', async (t) => {
  const { ledger, out } = rig(t);
  out.api.sendGroup = async () => { throw Object.assign(new Error('offline'), { code: 'api' }); };
  await assert.rejects(() => out.send(base({ plugin: 'ai-chat' })));
  assert.equal(ledger.recent({ chatId: 'g1', limit: 10 }).length, 0, '没发出去就不该记');
});

/* ---------- 批次 1 复核补修：流式回复绕开 outbound.send ---------- */

/**
 * 复核抓到的 P1：`msg.replyStream()` 直连 `api.sendStreamMessage`，
 * 不走 `outbound.send()`，所以 send() 里那两个记账出口都覆盖不到它。
 * 修法是 end() 发送成功后调 `outbound.recordDirect()` 补记最终全文。
 *
 * 假 api 的形状对齐 `src/api.js`：`sendStreamMessage(target, body)` 返回
 * `{ id }`；`takeSeq` 是可选的，缺了就退成 1，不影响这条链路。
 */
function streamRig(t, { event = 'C2C_MESSAGE_CREATE', plugin = 'ai-chat' } = {}) {
  const r = rig(t);
  const streams = [];
  r.out.api.sendStreamMessage = async (target, body) => {
    streams.push({ target, body });
    return { id: `stream-${streams.length}` };
  };
  const group = event.startsWith('GROUP');
  const msg = buildMessage(
    event,
    {
      id: 'in-stream-1',
      content: '问个问题',
      ...(group
        ? { group_openid: 'g1', author: { member_openid: 'u1' } }
        : { author: { user_openid: 'u1' } }),
      timestamp: '1700000000000',
    },
    { api: r.out.api, cfg: { commandPrefix: '/' }, outbound: r.out },
  );
  /** bot.js 在分发插件前设置；测试里直接模拟这一步 */
  msg.pluginId = plugin;
  return { ...r, streams, msg, chatId: group ? 'g1' : 'u1' };
}

test('流式回复：单聊 end() 补记最终全文（push 不记），带 plugin / botId', async (t) => {
  const { ledger, msg, streams, chatId } = streamRig(t);
  const s = msg.replyStream();
  await s.push('正在想');
  assert.equal(ledger.recent({ chatId, limit: 10 }).length, 0, '分片不该单独入账');

  await s.end('这是完整答案');
  assert.equal(streams.length, 2, 'push + end 各打一次接口');
  const rows = ledger.recent({ chatId, limit: 10 });
  assert.equal(rows.length, 1, '一条流式消息只记一笔');
  assert.equal(rows[0].content, '这是完整答案', '记最终全文，不是最后一片');
  assert.equal(rows[0].plugin, 'ai-chat');
  assert.equal(rows[0].botId, 'main');
  assert.ok(rows[0].id, '账本行有内部 id（UUID，不是消息 id）');
  /**
   * `recent()` 不暴露 msg_id，但它才是 `recordDirect` 传进来的那个 id，
   * 同时被 append() 用作 dedupe 键。用 exportRows() 单独验一次。
   */
  assert.equal(ledger.exportRows({ chatId })[0].msg_id, 'stream-2', '消息 id 取结束片的返回值');
  assert.equal(rows[0].timeBasis, 'observation');
});

test('流式回复：重复 end() 不再打接口、只记一笔，返回首次结果', async (t) => {
  const { ledger, msg, streams, chatId } = streamRig(t);
  const s = msg.replyStream();
  const first = await s.end('第一版');
  const second = await s.end('还是这个');
  assert.equal(streams.length, 1, '重复 end 不该再打一次接口');
  assert.deepEqual(second, first, '重复调用回首次结果');
  const rows = ledger.recent({ chatId, limit: 10 });
  assert.equal(rows.length, 1, '账本只记一笔');
  assert.equal(rows[0].content, '第一版', '账本停在首次内容');
});

test('流式回复：群聊退化成 replyMarkdown，只走 send() 记一次', async (t) => {
  const { ledger, msg, streams, calls, chatId } = streamRig(t, {
    event: 'GROUP_AT_MESSAGE_CREATE',
  });
  const s = msg.replyStream();
  await s.end('群聊没有流式接口');
  assert.equal(streams.length, 0, '群聊不该打流式接口');
  assert.equal(calls.group, 1, '走的是普通 markdown 出站');
  const rows = ledger.recent({ chatId, limit: 10 });
  assert.equal(rows.length, 1, '不能既记 send() 又记 recordDirect');
  assert.equal(rows[0].plugin, 'ai-chat');
});

test('byUser() 也返回 plugin / botId（三个 SELECT 都要补列）', async (t) => {
  const { ledger } = rig(t);
  ledger.append(
    {
      id: 'in-user-1',
      kind: 'group',
      chatId: 'g1',
      userId: 'u1',
      userName: '甲',
      content: '甲说的话',
      plugin: 'echo',
    },
    { timeBasis: 'observation' },
  );
  const rows = ledger.byUser({ userId: 'u1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plugin, 'echo');
  assert.equal(rows[0].botId, 'main');
});

test('recordDirect：账本没接时静默跳过，不影响发送', (t) => {
  const { out } = rig(t);
  out.ledger = null;
  assert.doesNotThrow(() => out.recordDirect({ kind: 'c2c', target: 'u1', content: 'hi' }));
});

/* ---------- 批次 5：四批遗留 P2 回归（2026-11-06） ---------- */

test('群聊退化：push()+end() 只发一条、只记一笔，内容是 end 的最终全文', async (t) => {
  const { ledger, msg, calls, chatId } = streamRig(t, { event: 'GROUP_AT_MESSAGE_CREATE' });
  const s = msg.replyStream();
  await s.push('正在想');
  assert.equal(calls.group, 0, '退化路径的 push 只缓存，不单独发一条');
  await s.end('这是最终全文');
  assert.equal(calls.group, 1, 'push + end 合计只发一条');
  const rows = ledger.recent({ chatId, limit: 10 });
  assert.equal(rows.length, 1, '只记一笔');
  assert.equal(rows[0].content, '这是最终全文', '发最终全文，不是中间态');
});

test('流式回复：end() 返回值无 id 时回退到首片 streamId', async (t) => {
  const { ledger, msg, out, chatId } = streamRig(t);
  let n = 0;
  out.api.sendStreamMessage = async () => (++n === 1 ? { id: 'stream-first' } : {});
  const s = msg.replyStream();
  await s.push('正在想');
  await s.end('最终答案');
  assert.equal(ledger.exportRows({ chatId })[0].msg_id, 'stream-first');
});

test('出站入账：有 requestId 且发送失败不记账', async (t) => {
  let settled = null;
  const delivery = {
    claim: () => ({ action: 'new' }),
    settle: (id) => { settled = id; },
  };
  const { ledger, out } = rig(t, { delivery });
  out.api.sendGroup = async () => { throw Object.assign(new Error('offline'), { code: 'api' }); };
  await assert.rejects(() => out.send(base({ requestId: 'in-1:main', plugin: 'ai-chat' })));
  assert.equal(ledger.recent({ chatId: 'g1', limit: 10 }).length, 0, '没发出去就不该记');
  assert.equal(settled, 'in-1:main', 'settle 仍要被调用');
});

test('出站入账：ledger.append 抛错不冒泡到发送链路', async (t) => {
  const { ledger, out, calls } = rig(t);
  ledger.append = () => { throw new Error('disk full'); };
  const r = await out.send(base({ plugin: 'ai-chat' }));
  assert.equal(calls.group, 1, '发送链路没被记账异常打断');
  assert.ok(r);
});
