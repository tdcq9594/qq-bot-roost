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
import { createLedger, toImportRow } from '../src/ledger.js';
import { buildMessage } from '../src/message.js';
import { DELIVERY_STATE } from '../src/delivery.js';

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
  /**
   * 每条出站给不同的 msg_id。真机上服务端本来就不会返回同一个 id，
   * 而账本按 `bot_id:msg_id` 去重——固定 id 会让「连发两条」被静默吞成一条，
   * 测「一条入站引出多条回复」时尤其会误判。
   */
  let sent = 0;
  const nextId = () => { sent += 1; return `msg-out-${sent}`; };
  const api = {
    sendGroup: async () => { calls.group += 1; return { id: nextId() }; },
    sendC2C: async () => { calls.c2c += 1; return { id: nextId() }; },
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

test('出站入账：被动回复记下「回的是哪条」和同一轮的 traceId', async (t) => {
  const { ledger, out } = rig(t);
  await out.send(base({ plugin: 'ai-chat', traceId: 'tr-1' }));
  const rows = ledger.recent({ chatId: 'g1', limit: 10 });
  assert.equal(rows.length, 1);
  /**
   * `reply_to` 从报文里的 `msgId` 取——那正是被动回复要求带的被回复消息 id，
   * 也就是入站行的 `msg_id`。以前只用一次就丢了，账本里看不出「这句回哪句」。
   */
  assert.equal(rows[0].replyTo, 'in-1');
  assert.equal(rows[0].trace, 'tr-1', '出站也要带 trace，和入站同一条链路');
});

test('出站入账：主动推送没有回复目标，replyTo 为空', async (t) => {
  const { ledger, out } = rig(t);
  await out.send({ kind: 'group', target: 'g1', chatKey: 'group:g1', payload: { content: '主动说一句' } });
  const rows = ledger.recent({ chatId: 'g1', limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].replyTo, '', '主动推送不该凭空造一条"回复某条"的边');
});

test('repliesOf / byMsgId：一条入站和它的回复能互相查到', async (t) => {
  const { ledger, out } = rig(t);
  ledger.append({
    id: 'in-9',
    kind: 'group',
    chatId: 'g1',
    userName: '甲',
    content: '在吗',
    source: 'gateway',
    raw: { timestamp: Date.now() },
  });
  await out.send(base({ plugin: 'ai-chat', traceId: 'tr-9', payload: { msgId: 'in-9', content: '在的' } }));
  await out.send(base({ plugin: 'echo', traceId: 'tr-9', payload: { msgId: 'in-9', content: '在吗' } }));

  const replies = ledger.repliesOf('in-9');
  assert.deepEqual(replies.map((r) => r.plugin), ['ai-chat', 'echo'], '先回的在前');
  assert.ok(replies.every((r) => r.replyTo === 'in-9'));
  assert.equal(ledger.byMsgId('in-9')?.content, '在吗');
  assert.equal(ledger.repliesOf('不存在').length, 0);
  assert.equal(ledger.repliesOf('').length, 0, '空 msg_id 不该扫全表');
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

/**
 * 非消息频道事件入账（2026-11-15 补）。
 * bot.js 的 #recordNotice 会把 GUILD_* / FORUM_* / MESSAGE_REACTION_* 之类
 * 写成 `kind:'notice'` 的记录，这里锁住「能查到、重推不重复、不冒充用户消息」。
 */
test('非消息频道事件：kind=notice 可查，官方重推不会记重', (t) => {
  const { ledger } = rig(t);
  const evt = {
    kind: 'notice',
    chatId: 'G1',
    /** #recordNotice 用事件名+场景+时间戳拼的稳定 id，dedupe 靠它 */
    id: 'notice:GUILD_CREATE:G1::2026-01-01T00:00:00+08:00:120',
    userId: '',
    userName: '',
    content: '[事件] GUILD_CREATE 测试频道',
    raw: { id: 'G1', name: '测试频道', timestamp: '2026-01-01T00:00:00+08:00' },
  };
  ledger.append(evt);
  ledger.append(evt);
  /** 同会话再放一条真人消息，用来验证 notice 不会挤进邻文 */
  const chat = ledger.append({
    kind: 'guild', chatId: 'G1', id: 'MSG_1', userId: 'U1', userName: '小明',
    content: '大家好', raw: { id: 'MSG_1', timestamp: '2026-01-01T00:00:01+08:00' },
  });

  const rows = ledger.recent({ chatId: 'G1', limit: 10 });
  assert.equal(rows.length, 2, 'notice 要入账可查，且 dedupe 挡住重推');
  const notice = rows.find((r) => r.kind === 'notice');
  assert.equal(notice?.kind, 'notice', '不能混进四态会话类型');
  assert.match(String(notice?.content), /\[事件\] GUILD_CREATE/, '面板里要能认出是系统事件');

  /** 关键回归：dsh-roost 每轮调 ledger.context → timeline()，不能被系统事件污染 */
  const around = ledger.timeline({ chatId: 'G1', anchorSeq: chat.seq, before: 5, after: 5 });
  assert.equal(around.length, 1, '邻文里只能有真人消息');
  assert.equal(around[0].content, '大家好');
  assert.equal(ledger.history({ chatId: 'G1', limit: 10 }).length, 1, 'OneBot 历史也不该混入系统事件');
  assert.equal(ledger.byUser({ userId: 'U1', limit: 10 }).length, 1, '按人历史同样过滤');
});

/* ---------- 来源标记（账本 v4） ---------- */

/**
 * 为什么要有 `source`：`plugin` 只回答「哪个插件说的」。
 * OneBot 客户端发的、宿主协议发的、网关收进来的，三者在账本里以前
 * **全是 `plugin=''`** —— 分不出「用户说的话」和「OneBot 客户端发出去的话」。
 * 这里锁住口径：入口/出口写进 `source`，`plugin` 的含义不变。
 */
test('来源：入站按 dispatch 传的 transport 落库', (t) => {
  const { ledger } = rig(t);
  const raw = { id: 'in-src-1', timestamp: '1700000000000' };
  ledger.append({ id: 'in-src-1', kind: 'group', chatId: 'g1', userId: 'u1', content: '网关', raw, source: 'gateway' });
  ledger.append({ id: 'in-src-2', kind: 'group', chatId: 'g1', userId: 'u1', content: '回调', raw: { ...raw, id: 'in-src-2' }, source: 'webhook' });
  /** 老调用不带 source：写空串表示「不知道」，不能拿它当入站判据 */
  ledger.append({ id: 'in-src-3', kind: 'group', chatId: 'g1', userId: 'u1', content: '老调用', raw: { ...raw, id: 'in-src-3' } });

  const byContent = Object.fromEntries(ledger.recent({ chatId: 'g1', limit: 10 }).map((r) => [r.content, r.source]));
  assert.equal(byContent['网关'], 'gateway');
  assert.equal(byContent['回调'], 'webhook');
  assert.equal(byContent['老调用'], '');
});

test('来源：buildMessage 原样挂到消息上，供 ledger.append 读', () => {
  const msg = buildMessage(
    'GROUP_AT_MESSAGE_CREATE',
    { id: 'in-src-9', content: 'x', group_openid: 'g1', author: { member_openid: 'u1' }, timestamp: '1700000000000' },
    { api: {}, cfg: { commandPrefix: '/' }, source: 'webhook' },
  );
  assert.equal(msg.source, 'webhook');
});

test('来源：出站按显式 source；没给但有 plugin 推断成 plugin', async (t) => {
  const { ledger, out } = rig(t);
  /** rig 的假 api 恒返回同一个 id，账本会按 dedupe 判成「重推」——这里给唯一 id */
  let n = 0;
  out.api.sendGroup = async () => ({ id: `m-src-${++n}` });
  await out.send(base({ plugin: 'ai-chat' }));                       // → plugin（推断）
  await out.send(base({ payload: { msgId: 'in-2', content: 'ob' }, source: 'onebot' })); // → onebot
  await out.send(base({ payload: { msgId: 'in-3', content: 'host' }, plugin: 'host', source: 'host' }));

  const byContent = Object.fromEntries(ledger.recent({ chatId: 'g1', limit: 10 }).map((r) => [r.content, r]));
  assert.equal(byContent['你好'].source, 'plugin', '有 plugin 没 source 时按插件路径推断');
  assert.equal(byContent['你好'].plugin, 'ai-chat');
  assert.equal(byContent['ob'].source, 'onebot', 'OneBot 客户端的发送要能认出来');
  assert.equal(byContent['ob'].plugin, '', 'OneBot 的 plugin 仍为空，两个维度互不影响');
  assert.equal(byContent['host'].source, 'host');
});

test('来源：recordDirect（流式 / 插件直连 api）也带 source', (t) => {
  const { ledger, out } = rig(t);
  out.recordDirect({ kind: 'c2c', target: 'u1', content: '宿主流式', plugin: 'host', source: 'host', id: 's-1' });
  out.recordDirect({ kind: 'c2c', target: 'u1', content: '插件直连', plugin: 'dice', source: 'plugin', id: 's-2' });
  const byContent = Object.fromEntries(ledger.recent({ chatId: 'u1', limit: 10 }).map((r) => [r.content, r.source]));
  assert.equal(byContent['宿主流式'], 'host');
  assert.equal(byContent['插件直连'], 'plugin');
});

test('来源：投递账本 claim 也带上 source', async (t) => {
  let claimed = null;
  const delivery = {
    claim: (p) => { claimed = p; return { action: 'new' }; },
    settle: () => {},
  };
  const { out } = rig(t, { delivery });
  await out.send(base({ requestId: 'ob-1', source: 'onebot' }));
  assert.equal(claimed?.source, 'onebot', 'OneBot 发的消息在投递账本里要能认出来');
});

/* ---------- 失败定性：unknown（不可重发）vs failed（可重试） ---------- */

/**
 * 这一组锁的是**核心承诺**：「结果未知的绝不自动重发」。
 *
 * 以前 `uncertainOf()` 只认 `e.code === 'api'`，而 `#post()` 抛的是 api.js
 * 的原始 Error（只有 status / qqCode，没有 code）→ 网络超时一律落成
 * `failed`（可重试），下一次 `claim()` 返回 `send`，重试就是群里两条一样的消息。
 */
function captureDelivery() {
  const seen = [];
  return {
    seen,
    delivery: {
      claim: () => ({ action: 'new' }),
      settle: (id, state, extra) => { seen.push({ id, state, extra }); },
    },
  };
}

test('失败定性：ECONNRESET（可能已送达）记 unknown，不是 failed', async (t) => {
  const { seen, delivery } = captureDelivery();
  const { out } = rig(t, { delivery });
  out.api.sendGroup = async () => {
    throw new Error('网络错误 POST /v2/groups/g1/messages: fetch failed（ECONNRESET）');
  };
  await assert.rejects(() => out.send(base({ requestId: 'in-1:main', plugin: 'ai-chat' })));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, DELIVERY_STATE.UNKNOWN, '连接重置后不知道发没发出去，必须记 unknown');
});

test('失败定性：请求超时也记 unknown', async (t) => {
  const { seen, delivery } = captureDelivery();
  const { out } = rig(t, { delivery });
  out.api.sendGroup = async () => {
    throw new Error('网络错误 POST /v2/groups/g1/messages: 请求超时（15s）');
  };
  await assert.rejects(() => out.send(base({ requestId: 'in-1:main', plugin: 'ai-chat' })));
  assert.equal(seen[0].state, DELIVERY_STATE.UNKNOWN);
});

test('失败定性：连接没建起来 / 4xx 明确拒绝 → failed（可重试）', async (t) => {
  const { seen, delivery } = captureDelivery();
  const { out } = rig(t, { delivery });

  out.api.sendGroup = async () => { throw new Error('网络错误 POST /v2/groups/g1/messages: fetch failed（ECONNREFUSED）'); };
  await assert.rejects(() => out.send(base({ requestId: 'r-1', plugin: 'ai-chat' })));
  assert.equal(seen[0].state, DELIVERY_STATE.FAILED, '连都没连上，一定没发出去');

  out.api.sendGroup = async () => {
    throw Object.assign(new Error('HTTP 400 POST /v2/groups/g1/messages: 内容违规'), { status: 400, qqCode: 40034006 });
  };
  await assert.rejects(() => out.send(base({ requestId: 'r-2', plugin: 'ai-chat' })));
  assert.equal(seen[1].state, DELIVERY_STATE.FAILED);
  assert.equal(seen[1].extra.code, 'qq-40034006', '原因码要落业务码，别只写 error');

  out.api.sendGroup = async () => { throw Object.assign(new Error('HTTP 500 内部错误'), { status: 500 }); };
  await assert.rejects(() => out.send(base({ requestId: 'r-3', plugin: 'ai-chat' })));
  assert.equal(seen[2].state, DELIVERY_STATE.UNKNOWN, '5xx 可能已处理，按未知处理');
});

/**
 * 降级重发的边界：只有「被动窗口/次数过期」才能改发主动消息。
 *
 * 以前 `#looksExpired` 里有 `超时` 这个关键词，于是**请求超时**（网络层）
 * 被当成窗口过期 → 立刻再发一条主动消息。原消息可能已经送达，
 * 用户就收到两条。这条锁住「网络错误一律不降级」。
 */
test('降级：被动回复请求超时不得改发主动消息（否则双发）', async (t) => {
  const { out } = rig(t);
  let sends = 0;
  out.api.sendGroup = async () => {
    sends += 1;
    throw new Error('网络错误 POST /v2/groups/g1/messages: 请求超时（15s）');
  };
  await assert.rejects(() => out.send(base({ plugin: 'ai-chat' })));
  assert.equal(sends, 1, '超时就停在这里，不能再打一次接口');
});

test('降级：40034128（被动超限）仍然改发主动消息', async (t) => {
  const { out } = rig(t);
  let sends = 0;
  out.api.sendGroup = async () => {
    sends += 1;
    if (sends === 1) {
      throw Object.assign(new Error('HTTP 400 POST /v2/groups/g1/messages: passive reply expired'), { status: 400, qqCode: 40034128 });
    }
    return { id: 'active-1' };
  };
  const r = await out.send(base({ plugin: 'ai-chat' }));
  assert.equal(sends, 2, '这是唯一值得降级的错误');
  assert.equal(r.degraded, true);
  assert.equal(r.id, 'active-1');
});

/**
 * 导出 / 导入必须共用 `toImportRow()`。
 *
 * 原来的导出在 `server.js` 里逐字段手写，加 `source` 时漏了 —— 而 JSONL 正是
 * 「给导回用」的格式，导一轮回来所有 OneBot / 插件消息都变成 `import`。
 * 这两条锁住：字段映射本身，以及「写进去 → 导出 → 导入」整条路。
 */
test('toImportRow：库里 snake_case → 导入用 camelCase，多余字段丢掉', () => {
  const row = toImportRow({
    at: 1700000000000,
    kind: 'group',
    chat_id: 'G1',
    msg_id: 'm1',
    user_id: 'U1',
    user_name: '甲',
    content: 'hi',
    plugin: 'ai-chat',
    source: 'onebot',
    reply_to: 'm0',
    /** 下面这些不在导入形状里，不能让它们漏进去（导回时会被当成未知字段） */
    seq: 9,
    bot_id: 'main',
    dedupe: 'main:m1',
  });
  assert.deepEqual(row, {
    at: 1700000000000,
    kind: 'group',
    chatId: 'G1',
    msgId: 'm1',
    userId: 'U1',
    userName: '甲',
    content: 'hi',
    plugin: 'ai-chat',
    source: 'onebot',
    /** v5：被回复的消息，导出再导入不能丢 */
    replyTo: 'm0',
  });
});

test('导出再导入：source 原样还原，不会被洗成 import', async (t) => {
  const src = rig(t);
  const now = Date.now();
  const add = (id, extra) =>
    src.ledger.append({
      id,
      kind: 'group',
      chatId: 'G1',
      content: id,
      raw: { timestamp: now },
      ...extra,
    });
  add('网关来的', { userId: 'U1', userName: '甲', source: 'gateway' });
  add('OneBot 发的', { source: 'onebot' });
  add('插件发的', { plugin: 'ai-chat', source: 'plugin' });

  /** 和 /api/ledger/export?format=jsonl 完全同一条路 */
  const rows = src.ledger.exportRows({ chatId: 'G1' }).map(toImportRow);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.content === 'OneBot 发的')?.source, 'onebot', '导出的行必须带来源');

  const dst = rig(t);
  const r = dst.ledger.importRows(rows);
  assert.equal(r.added, 3, '三条都是一次导入');
  assert.equal(r.bad, 0);

  const back = Object.fromEntries(
    dst.ledger
      .recent({ chatId: 'G1', limit: 10 })
      .map((x) => [x.content, { source: x.source, plugin: x.plugin }]),
  );
  assert.deepEqual(back['网关来的'], { source: 'gateway', plugin: '' });
  assert.deepEqual(back['OneBot 发的'], { source: 'onebot', plugin: '' }, '不能被洗成 import');
  assert.deepEqual(back['插件发的'], { source: 'plugin', plugin: 'ai-chat' }, 'plugin 列也要跟着回来');
});

/**
 * `history()` 与 `byUser()` 以前各自手写了一份列列表，加 `source` 时没跟着改——
 * `mapRow()` 里 `r.source ?? ''` 会把它们统一读成空串，看起来「正常」，其实恒为空。
 * 这两条查询一个给 OneBot 回放历史、一个给面板「身份」页，都必须带真实来源。
 */
test('history / byUser 也要带 source（不能因为手写列列表漏掉）', async (t) => {
  const { ledger } = rig(t);
  const now = Date.now();
  ledger.append({
    id: 'h1', kind: 'group', chatId: 'G1', userId: 'U1', userName: '甲',
    content: '网关来的', raw: { timestamp: now }, source: 'gateway',
  });
  ledger.append({
    id: 'h2', kind: 'group', chatId: 'G1', userId: 'U1',
    content: '插件发的', raw: { timestamp: now }, plugin: 'ai-chat', source: 'plugin',
  });

  const h = ledger.history({ chatId: 'G1', limit: 10 });
  assert.deepEqual(
    h.map((x) => [x.content, x.source]),
    [['网关来的', 'gateway'], ['插件发的', 'plugin']],
    'history 要给 OneBot 回放带上来源',
  );

  const u = ledger.byUser({ userId: 'U1', limit: 10 });
  assert.deepEqual(
    u.map((x) => [x.content, x.source]),
    [['网关来的', 'gateway'], ['插件发的', 'plugin']],
    'byUser 不能恒为空串',
  );
});
