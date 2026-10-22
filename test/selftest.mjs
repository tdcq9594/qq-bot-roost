// 框架自检：验证 outbound / session / pipeline / plugin config 的行为。
// 跑法：npm test
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Outbound, SendError } from '../src/outbound.js';
import { SessionManager } from '../src/session.js';
import { Pipeline, dedupMiddleware } from '../src/pipeline.js';
import { PluginConfig } from '../src/plugin/config.js';
import { browserCommand } from '../src/browser.js';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const cfg = {
  dedupWindowSec: 120,
  outbound: { perSec: 4, dailyActive: 2, downgradeToActive: true },
  session: { stickySec: 180, promptTimeoutSec: 2 },
  commandPrefix: '/',
  cooldownHint: false,
};

/** 假 API，记录每次调用的报文 */
function makeApi() {
  const calls = [];
  return {
    calls,
    sendGroup: async (target, body) => {
      calls.push({ target, body });
      return { id: 'm' + calls.length };
    },
    sendC2C: async (target, body) => {
      calls.push({ target, body });
      return { id: 'c' + calls.length };
    },
  };
}

const KEY = 'group:__selftest__';
// 每次运行用不同后缀，避免上一次残留的额度记录干扰本次断言
const RUN = Date.now().toString(36);

/* ---------- 1. 被动回复正常发出 ---------- */
{
  const api = makeApi();
  const ob = new Outbound({ api, cfg, isOnline: () => true });
  const r = await ob.send({
    kind: 'group',
    target: 'g1',
    chatKey: 'group:__t1_passive__',
    payload: { content: 'hi', msgId: 'msg-1' },
    receivedAt: Date.now(),
  });
  check('被动回复带 msgId 发出', api.calls.length === 1 && api.calls[0].body.msgId === 'msg-1');
  check('被动回复未降级', r.degraded === false);
  await ob.flush();
}

/* ---------- 2. 超过 5 分钟窗口 → 降级为主动消息 ---------- */
{
  const api = makeApi();
  const ob = new Outbound({ api, cfg, isOnline: () => true });
  const old = Date.now() - 6 * 60 * 1000;
  const r = await ob.send({
    kind: 'group',
    target: 'g1',
    chatKey: 'group:__t2_degrade__',
    payload: { content: 'late', msgId: 'msg-2' },
    receivedAt: old,
  });
  check('超窗后降级', r.degraded === true);
  check('降级后不带 msgId', api.calls[0].body.msgId === undefined);
  await ob.flush();
}

/* ---------- 3. 主动消息额度用完 → 抛 quota ---------- */
{
  const api = makeApi();
  const cfg3 = { ...cfg, outbound: { ...cfg.outbound, dailyActive: 2 } };
  const ob = new Outbound({ api, cfg: cfg3, isOnline: () => true });
  const k = `group:__t3_quota_${RUN}__`;
  let sent = 0;
  let code = '';
  for (let i = 0; i < 5; i++) {
    try {
      await ob.send({ kind: 'group', target: 'g1', chatKey: k, payload: { content: 'x' } });
      sent += 1;
    } catch (e) {
      code = e instanceof SendError ? e.code : 'unknown';
      break;
    }
  }
  check('额度用完后抛 quota', code === 'quota', `已发 ${sent} 条后拦下`);
  check('额度上限被严格执行', sent === 2, `实际发出 ${sent} 条`);
  await ob.flush();
}

/* ---------- 4. 每秒限速 ---------- */
{
  const api = makeApi();
  const cfg2 = { ...cfg, outbound: { ...cfg.outbound, dailyActive: 100 } };
  const ob = new Outbound({ api, cfg: cfg2, isOnline: () => true });
  const t0 = Date.now();
  // perSec=4，发 8 条被动消息，至少要跨 1 秒
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      ob.send({
        kind: 'group',
        target: 'g2',
        chatKey: 'group:__ratetest__',
        payload: { content: 'n' + i, msgId: 'r' + i },
        receivedAt: Date.now(),
      }),
    ),
  );
  const dt = Date.now() - t0;
  check('8 条消息被限速跨过 1 秒', dt >= 900, `耗时 ${dt}ms`);
  check('8 条全部发出', api.calls.length === 8);
  await ob.flush();
}

/* ---------- 5. 离线拒发 ---------- */
{
  const api = makeApi();
  const ob = new Outbound({ api, cfg, isOnline: () => false });
  let code = '';
  try {
    await ob.send({
      kind: 'group',
      target: 'g1',
      chatKey: 'group:__t5_offline__',
      payload: { content: 'x' },
    });
  } catch (e) {
    code = e.code;
  }
  check('离线时拒发', code === 'offline');
  check('离线时不产生网络调用', api.calls.length === 0);
}

/* ---------- 6. 审核中不算失败 ---------- */
{
  const api = {
    sendGroup: async () => ({ code: 304023, message: 'push message is waiting for audit now' }),
    sendC2C: async () => ({}),
  };
  const ob = new Outbound({ api, cfg, isOnline: () => true });
  const r = await ob.send({
    kind: 'group',
    target: 'g1',
    chatKey: 'group:__t6_audit__',
    payload: { content: 'x' },
  });
  check('304023 标记为 pending 而非报错', r.pending === true);
  await ob.flush();
}

/* ---------- 7. 多轮会话 ---------- */
{
  const sm = new SessionManager({ stickyMs: 60_000, waitTimeoutMs: 5000 });
  const p = sm.wait({ chatId: 'c1', userId: 'u1' });
  const delivered = sm.deliver({ chatId: 'c1', userId: 'u1', content: '1' });
  const ans = await p;
  check('prompt 能拿到用户回复', delivered === true && ans?.content === '1');

  // 别人说话不该命中
  const p2 = sm.wait({ chatId: 'c1', userId: 'u1' });
  const wrong = sm.deliver({ chatId: 'c1', userId: 'u2', content: '乱入' });
  check('其他人的消息不会命中等待', wrong === false);
  sm.cancel('c1', 'u1');
  await p2;
}

/* ---------- 8. 会话级等待（谁都算） ---------- */
{
  const sm = new SessionManager({ waitTimeoutMs: 5000 });
  const p = sm.wait({ chatId: 'c2', userId: 'u1', from: 'chat' });
  const ok = sm.deliver({ chatId: 'c2', userId: 'u9', content: '别人答的' });
  const ans = await p;
  check('from=chat 时任何人都能回答', ok === true && ans?.content === '别人答的');
}

/* ---------- 9. 超时返回 null ---------- */
{
  const sm = new SessionManager({ waitTimeoutMs: 300 });
  const t0 = Date.now();
  const ans = await sm.wait({ chatId: 'c3', userId: 'u1', timeoutMs: 300 });
  check('超时返回 null', ans === null && Date.now() - t0 >= 280);
}

/* ---------- 10. 免@粘性 ---------- */
{
  const sm = new SessionManager({ stickyMs: 60_000 });
  check('未 @ 时不在粘性窗口', sm.isSticky('c4') === false);
  sm.markAddressed('c4');
  check('@ 一次后进入粘性窗口', sm.isSticky('c4') === true);
  check('粘性窗口有剩余秒数', sm.stickyRemain('c4') > 50);
}

/* ---------- 11. 中间件管道 ---------- */
{
  const p = new Pipeline();
  const order = [];
  p.use('a', async (_c, next) => {
    order.push('a');
    await next();
  });
  p.use('b', async (_c, next) => {
    order.push('b');
    await next();
  });
  const passed = await p.run({ msg: {} });
  check('中间件按注册顺序执行', order.join('') === 'ab' && passed === true);

  const p2 = new Pipeline();
  p2.use('block', async () => {
    /* 不调 next，直接拦下 */
  });
  let reached = false;
  p2.use('after', async (_c, next) => {
    reached = true;
    await next();
  });
  const passed2 = await p2.run({ msg: {} });
  check('不调 next 即拦截后续', passed2 === false && reached === false);
}

/* ---------- 12. 去重中间件 ---------- */
{
  const p = new Pipeline();
  p.use('dedup', dedupMiddleware(cfg));
  const ctx1 = { msg: { id: 'dup-1' }, halt() {} };
  const ctx2 = { msg: { id: 'dup-1' }, halt() {} };
  const r1 = await p.run(ctx1);
  const r2 = await p.run(ctx2);
  check('同一 msg id 第二次被拦', r1 === true && r2 === false);
}

/* ---------- 13. 插件配置：生成、合并、写回 ---------- */
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qbcfg-'));
  const file = path.join(dir, 'p.json');
  const exists = async (p) => fs.access(p).then(() => true, () => false);

  // 首次：按默认值生成
  const c1 = new PluginConfig({ id: 'p', defaults: { a: 1, nested: { x: 1 } }, file });
  const v1 = await c1.load();
  check('插件配置首次按默认值生成', v1.a === 1 && (await exists(file)));

  // 用户改了文件，插件升级又加了新项 → 用户值保留，新项补上
  await fs.writeFile(file, JSON.stringify({ a: 99, userOnly: 'keep' }), 'utf8');
  const c2 = new PluginConfig({ id: 'p', defaults: { a: 1, b: 2, nested: { x: 1 } }, file });
  const v2 = await c2.load();
  check('用户改的值不被覆盖', v2.a === 99);
  check('用户多写的键保留', v2.userOnly === 'keep');
  check('插件新增的项自动补上', v2.b === 2 && v2.nested?.x === 1);

  // set 深合并
  await c2.set({ nested: { y: 2 } });
  check('setConfig 深合并保留旧键', c2.value.nested.x === 1 && c2.value.nested.y === 2);

  // 没声明 defaults 且文件不存在 → 不生成空文件
  const file2 = path.join(dir, 'empty.json');
  const c3 = new PluginConfig({ id: 'e', defaults: {}, file: file2 });
  await c3.load();
  check('无默认值时不生成空配置文件', !(await exists(file2)));

  await fs.rm(dir, { recursive: true, force: true });
}

/* ---------- 14. 浏览器命令构造 ---------- */
{
  const url = 'http://127.0.0.1:15207/';
  const win = browserCommand(url, 'win32');
  check(
    'Windows 用 cmd /c start',
    win?.cmd === 'cmd' && win.args[0] === '/c' && win.args[1] === 'start' && win.args[3] === url,
  );
  const mac = browserCommand(url, 'darwin');
  check('macOS 用 open', mac?.cmd === 'open' && mac.args[0] === url);
  const linux = browserCommand(url, 'linux');
  check('Linux 用 xdg-open', linux?.cmd === 'xdg-open' && linux.args[0] === url);
  check('空地址不构造命令', browserCommand('') === null);
}

/* ---------- 15. 事件登记表完整性 ---------- */
{
  const { EVENTS, INTENTS, INTENT_META, EVENT_NAMES, isKnownEvent, messageKindOf, describeIntents } =
    await import('../src/events.js');

  const count = EVENT_NAMES.length;
  check('事件表覆盖官方全部事件', count >= 42, `登记了 ${count} 个`);

  // 每个事件的 intent 必须真实存在
  const badIntent = EVENT_NAMES.filter((n) => !INTENTS[EVENTS[n].intent]);
  check('每个事件都挂在合法 intent 上', badIntent.length === 0, badIntent.join(','));

  // intent 的位值要和 INTENTS 常量对得上
  const badBit = Object.entries(INTENT_META).filter(([k, m]) => (1 << m.bit) !== INTENTS[k]);
  check('INTENT_META 的位值与 INTENTS 一致', badBit.length === 0, badBit.map((x) => x[0]).join(','));

  // 消息类事件的会话类型必须合法
  const validKinds = new Set(['group', 'c2c', 'guild', 'dm']);
  const badKind = EVENT_NAMES.filter((n) => {
    const k = messageKindOf(n);
    return k !== null && !validKinds.has(k);
  });
  check('消息类事件的会话类型合法', badKind.length === 0, badKind.join(','));

  // 群聊/私聊主场景必须被识别成消息事件
  const mustBeMessage = [
    'GROUP_AT_MESSAGE_CREATE',
    'GROUP_MESSAGE_CREATE',
    'C2C_MESSAGE_CREATE',
    'AT_MESSAGE_CREATE',
    'MESSAGE_CREATE',
    'DIRECT_MESSAGE_CREATE',
  ];
  const notMessage = mustBeMessage.filter((n) => !messageKindOf(n));
  check('六种消息事件都能规范化成 Message', notMessage.length === 0, notMessage.join(','));

  // 删除类事件不应该被当成消息事件（没有正文可解析）
  const delAsMsg = ['MESSAGE_DELETE', 'PUBLIC_MESSAGE_DELETE', 'DIRECT_MESSAGE_DELETE'].filter(
    (n) => messageKindOf(n),
  );
  check('删除类事件不当作消息事件', delAsMsg.length === 0, delAsMsg.join(','));

  check('未知事件判定正确', isKnownEvent('GUILD_CREATE') && !isKnownEvent('NOT_A_REAL_EVENT'));

  // describeIntents 应能拆出已启用/未启用
  const d = describeIntents((1 << 25) | (1 << 0));
  check(
    'intents 掩码能翻译成订阅摘要',
    d.enabled.includes('GROUP_AND_C2C_EVENT') && d.enabled.includes('GUILDS') && !d.enabled.includes('INTERACTION'),
  );
}

/* ---------- 16. 实例互斥（防止同一 AppID 双开导致 4902 互踢） ---------- */
{
  const { claimInstance, releaseInstance } = await import('../src/instance.js');
  const { DIRS } = await import('../src/paths.js');
  const { spawn } = await import('node:child_process');
  const lockFile = path.join(DIRS.data, 'instances.json');

  const readLock = async () => {
    try {
      return JSON.parse(await fs.readFile(lockFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeLock = (o) => fs.writeFile(lockFile, JSON.stringify(o, null, 2));

  const A = '__test_a__';
  const B = '__test_b__';
  const C_ = '__test_c__';

  const r1 = await claimInstance({ appId: A });
  check('新 AppID 可以登记实例', r1.ok === true);

  const r2 = await claimInstance({ appId: A });
  check('同一个进程重复登记不算冲突', r2.ok === true);

  // 起个真进程冒充「另一个正在跑的实例」
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 400));

  const lock = await readLock();
  lock[B] = { pid: child.pid, at: Date.now() };
  await writeLock(lock);

  const r3 = await claimInstance({ appId: B });
  check(
    '同 AppID 已有活实例时拒绝启动',
    r3.ok === false && r3.conflict?.pid === child.pid,
    r3.conflict ? `冲突 PID=${r3.conflict.pid}` : '',
  );

  const r4 = await claimInstance({ appId: B, force: true });
  check('--force 可以强行登记', r4.ok === true);

  // 死进程的记录应该被自动清掉，不能把人锁在外面
  const lock2 = await readLock();
  lock2[C_] = { pid: 999999, at: Date.now() };
  await writeLock(lock2);
  const r5 = await claimInstance({ appId: C_ });
  check('残留的死进程记录会被清理', r5.ok === true);

  try {
    child.kill();
  } catch {}
  await releaseInstance(A);
  await releaseInstance(B);
  await releaseInstance(C_);
  const after = await readLock();
  check('退出后能注销自己的登记', !after[A] && !after[B] && !after[C_]);
}

/* ---------- 17. storage 原子更新（并发不丢数据） ---------- */
{
  const { PluginStorage } = await import('../src/plugin/context.js');
  const os = await import('node:os');
  const file = path.join(os.tmpdir(), `roost-test-${Date.now()}.json`);
  const st = new PluginStorage(file);

  // 10 个并发 update，每个 +1。没有串行化的话最终值会小于 10
  await Promise.all(
    Array.from({ length: 10 }, () =>
      st.update('user:1', (p) => {
        const cur = p ?? { n: 0 };
        cur.n += 1;
        return cur;
      }),
    ),
  );
  const after = await st.get('user:1');
  check('并发 update 不丢更新', after?.n === 10, `实际 n=${after?.n}`);

  // 返回 null 表示不写入
  const keep = await st.update('user:1', () => null);
  check('update 返回 null 时不写入', keep?.n === 10, `实际 n=${keep?.n}`);

  // key 不存在时能拿到 fallback 之外的初始值
  const born = await st.update('user:2', (p) => {
    const cur = p ?? { n: 100 };
    cur.n += 1;
    return cur;
  });
  check('新 key 能正常创建', born?.n === 101, `实际 n=${born?.n}`);

  // 并发改不同 key 互不干扰
  await Promise.all([
    st.update('a', (p) => ({ v: (p?.v ?? 0) + 1 })),
    st.update('b', (p) => ({ v: (p?.v ?? 0) + 1 })),
  ]);
  check('不同 key 并行更新互不影响', (await st.get('a'))?.v === 1 && (await st.get('b'))?.v === 1);

  await st.flush();
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  check('flush 后数据真的落盘了', onDisk['user:1']?.n === 10);
  await fs.unlink(file).catch(() => {});
}

/* ---------- 18. 多插件回复合并成一条 ---------- */
{
  const { buildMessage } = await import('../src/message.js');

  const sent = [];
  const fakeApi = {
    sendGroup: async (target, body) => {
      sent.push({ target, body });
      return { id: 'x' };
    },
    sendC2C: async (target, body) => {
      sent.push({ target, body });
      return { id: 'x' };
    },
  };

  const msg = buildMessage(
    'GROUP_AT_MESSAGE_CREATE',
    {
      id: 'm1',
      content: '测试',
      group_openid: 'g1',
      author: { member_openid: 'u1' },
      timestamp: '1700000000000',
    },
    { api: fakeApi, cfg: { commandPrefix: '/' } },
  );

  // 模拟三个插件都要回复同一条消息
  msg.reply('插件A 的结果');
  msg.reply('插件B 的结果');
  msg.reply('插件C 的结果');

  check('回复先攒着不立即发', sent.length === 0, `实际发了 ${sent.length} 条`);
  check('攒着的时候 replied 已置位', msg.replied === true);

  await msg.flushReplies();

  check('合并后只发一条', sent.length === 1, `实际发了 ${sent.length} 条`);
  check(
    '合并内容是三段拼起来的',
    sent[0]?.body?.content === '插件A 的结果\n插件B 的结果\n插件C 的结果',
    JSON.stringify(sent[0]?.body?.content),
  );

  // 再 flush 一次不应该重复发
  await msg.flushReplies();
  check('重复 flush 不会重复发送', sent.length === 1, `实际发了 ${sent.length} 条`);

  // 超长要切分，避免一条塞不下
  const big = buildMessage(
    'GROUP_AT_MESSAGE_CREATE',
    {
      id: 'm2',
      content: 'x',
      group_openid: 'g2',
      author: { member_openid: 'u2' },
      timestamp: '1700000000001',
    },
    { api: fakeApi, cfg: { commandPrefix: '/' } },
  );
  for (let i = 0; i < 5; i++) big.reply('长'.repeat(500));
  await big.flushReplies();
  check('超长内容会拆成多条', sent.length >= 3, `总条数 ${sent.length}`);
  check(
    '拆分后没有丢内容',
    sent.slice(1).reduce((n, s) => n + (s.body.content || '').length, 0) >= 2500,
  );
}

/* ---------- 汇总 ---------- */
// 清掉测试写进额度账本的条目，别污染真实数据。
// 多机器人后账本在 data/bots/<id>/quota.json，所以两边都要扫。
{
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { DIRS } = await import('../src/paths.js');

  const candidates = [path.join(DIRS.data, 'quota.json')];
  try {
    for (const d of await fs.readdir(DIRS.botsData)) {
      candidates.push(path.join(DIRS.botsData, d, 'quota.json'));
    }
  } catch {
    /* 还没有 bots 目录 */
  }

  for (const file of candidates) {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const day of Object.keys(data)) {
        for (const k of Object.keys(data[day])) {
          if (k.includes('__t') || k.includes('__selftest__') || k.includes('__ratetest__')) {
            delete data[day][k];
          }
        }
        if (!Object.keys(data[day]).length) delete data[day];
      }
      await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    } catch {
      /* 文件不存在就算了 */
    }
  }
}

const fail = results.filter((r) => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} 通过`);
if (fail.length) {
  console.log('失败项: ' + fail.map((f) => f.name).join('、'));
  process.exitCode = 1;
}
