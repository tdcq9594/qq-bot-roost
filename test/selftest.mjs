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

/**
 * 清掉测试写进额度账本的条目。
 *
 * **开始和结束各跑一次**：上一次跑崩了（某个断言抛异常、或中途语法错误）
 * 会把记录留在账本里，下次跑就撞上「主动消息额度已用完」——
 * 测试自己把自己弄挂，排查起来非常费劲。
 */
async function cleanQuotaLedger() {
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

// 开跑前先清一次，避免上一次崩溃留下的脏数据
await cleanQuotaLedger();


const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

/**
 * 记一条「跳过」。
 *
 * 为什么不写成 check(x, true)：跳过和通过是两件事。
 * 通过意味着「验证过了没问题」，跳过意味着「这里没验证」——
 * 混在一起会让人以为覆盖到了，实际 CI 上什么都没跑。
 */
function skip(name, why = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${why ? '  ' + why : ''}`);
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

  /**
   * 恢复默认：必须连「插件升级后遗留的旧键」一起清掉。
   *
   * 只把每个已知键写回默认值是不够的——set 是合并语义，
   * 旧键会一直躺在文件里。所以后端实现成「删文件重建」。
   */
  await c2.set({ userOnly: 'stale', b: 42 });
  check('恢复前：用户值和遗留键都在', c2.value.b === 42 && c2.value.userOnly === 'stale');
  const afterReset = await c2.reset();
  check('恢复默认：已知项回到默认值', afterReset.a === 1 && afterReset.b === 2, JSON.stringify(afterReset));
  check('恢复默认：遗留的旧键被清掉', afterReset.userOnly === undefined, JSON.stringify(afterReset));
  check('恢复默认：深层的默认值也在', afterReset.nested?.x === 1, JSON.stringify(afterReset.nested));
  // 磁盘上也要是干净的，不能只在内存里干净
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  check('恢复默认：写回文件', onDisk.userOnly === undefined && onDisk.a === 1, JSON.stringify(onDisk));

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
  /**
   * 同进程重复登记**必须**算冲突。
   * 以前这条断言的是「不算冲突」——那正是 4902 互踢的来源：
   * 两份配置填了同一个 AppID，两边都认领成功，各自连网关。
   */
  check('同进程重复登记同一 AppID 算冲突', r2.ok === false);
  check('同进程冲突能拿到自己的 pid', r2.conflict?.pid === process.pid);

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

  /* ---- 多个插件都回复时，要标明是谁说的 ---- */

  {
    const multi = buildMessage(
      'GROUP_AT_MESSAGE_CREATE',
      {
        id: 'm-multi',
        content: '<@bot> 你好',
        group_openid: 'g1',
        author: { member_openid: 'u1' },
        timestamp: '1700000000000',
      },
      { api: fakeApi, cfg: { commandPrefix: '/' } },
    );
    const before = sent.length;

    // bot.js 在调用每个插件前会设这两个字段，这里手动模拟
    multi.pluginId = 'echo';
    multi.pluginName = '回声';
    multi.reply('你好呀，我是回声');

    multi.pluginId = 'ai-chat';
    multi.pluginName = 'AI 对话';
    multi.reply('你好，我是 AI');
    multi.reply('有什么可以帮你');

    await multi.flushReplies();

    const body = sent[before]?.body?.content ?? '';
    check('多插件合并：只发一条', sent.length === before + 1, `发了 ${sent.length - before} 条`);
    check('多插件合并：带上第一个插件名', body.includes('【回声】'), body);
    check('多插件合并：带上第二个插件名', body.includes('【AI 对话】'), body);
    check(
      '多插件合并：标题在前、内容在后',
      body.startsWith('【回声】\n你好呀，我是回声'),
      JSON.stringify(body.slice(0, 40)),
    );
    check(
      '多插件合并：同一插件的两段并进同一块，不重复加标题',
      (body.match(/【AI 对话】/g) ?? []).length === 1 && body.includes('你好，我是 AI\n有什么可以帮你'),
      JSON.stringify(body),
    );
    check('多插件合并：两块之间有空行', body.includes('\n\n【AI 对话】'), JSON.stringify(body));
  }

  /* ---- 单个插件回复时不加标题（保持原有格式） ---- */

  {
    const single = buildMessage(
      'GROUP_AT_MESSAGE_CREATE',
      {
        id: 'm-single',
        content: '<@bot> 单个',
        group_openid: 'g1',
        author: { member_openid: 'u1' },
        timestamp: '1700000000000',
      },
      { api: fakeApi, cfg: { commandPrefix: '/' } },
    );
    const before = sent.length;
    single.pluginId = 'dice';
    single.pluginName = '掷骰子';
    single.reply('🎲 4');
    single.reply('点数不错');
    await single.flushReplies();

    const body = sent[before]?.body?.content ?? '';
    check('单插件回复：不加【插件名】标题', !body.includes('【'), body);
    check('单插件回复：多段仍然拼在一起', body === '🎲 4\n点数不错', JSON.stringify(body));
  }

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

/* ---------- 19. Markdown 与消息内交互标签 ---------- */
{
  const { md, renderMenuMd, escMd } = await import('../src/markdown.js');

  // text 必须 urlencode，否则带空格/中文的指令会解析错
  const tag = md.cmdInput('/admin set 123 1', '设置权限');
  check('cmdInput 会 urlencode text', tag.includes('text="%2Fadmin%20set%20123%201"'), tag);
  check('cmdInput 会 urlencode show', tag.includes('show="%E8%AE%BE%E7%BD%AE%E6%9D%83%E9%99%90"'));
  check('cmdInput 用对标签名', tag.startsWith('<qqbot-cmd-input') && tag.endsWith('/>'));

  // 群聊只有 cmd-input；单聊/频道才有 cmd-enter（点了直接发）
  const groups = [{ title: '测试', items: [{ text: '/签到', desc: '每日一次' }] }];
  const forGroup = renderMenuMd('标题', groups, { kind: 'group' });
  const forC2C = renderMenuMd('标题', groups, { kind: 'c2c' });
  check('群聊菜单用 cmd-input', forGroup.includes('<qqbot-cmd-input'));
  check('群聊菜单不用 cmd-enter', !forGroup.includes('cmd-enter'));
  check('单聊菜单用 cmd-enter', forC2C.includes('<qqbot-cmd-enter'));

  // 标题会渲染成 markdown 标题
  check('渲染出标题和分组', forGroup.includes('# 标题') && forGroup.includes('## 测试'));

  // cmd: null 的项不做成可点击（被动触发的玩法）
  const passive = renderMenuMd('t', [{ title: 'g', items: [{ text: '我的鲲', cmd: null }] }], {
    kind: 'group',
  });
  check('非命令项不生成点击标签', !passive.includes('cmd-input') && passive.includes('我的鲲'));

  // 转义只处理会破坏行内排版的字符，不碰 < > [ ]
  check('escMd 转义星号', escMd('a*b') === 'a\\*b');
  check('escMd 不动尖括号', escMd('/admin set <openid>') === '/admin set <openid>');
}

/* ---------- 插件运行数据（dashboard） ---------- */

async function testDashboard() {
  const { normalizeDashboard } = await import('../src/plugin/dashboard.js');

  // 无效输入一律返回 null，面板显示「插件未提供运行数据」
  check('dashboard: null 返回 null', normalizeDashboard(null) === null);
  check('dashboard: 空对象返回 null', normalizeDashboard({}) === null);
  check('dashboard: metrics 为空且无 note 返回 null', normalizeDashboard({ metrics: [] }) === null);

  const d = normalizeDashboard({
    metrics: [
      { label: '已回复', value: 1234, unit: '条' },
      { label: '平均耗时', value: 320, unit: 'ms', hint: '最近 100 次' },
    ],
    note: '模型：x',
  });
  check('dashboard: 指标数量', d.metrics.length === 2);
  check('dashboard: 数字转字符串', d.metrics[0].value === '1234');
  check('dashboard: 保留单位', d.metrics[0].unit === '条');
  check('dashboard: 保留说明', d.metrics[1].hint === '最近 100 次');
  check('dashboard: 保留 note', d.note === '模型：x');

  // 0 是合法值，不能被 || 兜成空
  const zero = normalizeDashboard({ metrics: [{ label: '已回复', value: 0 }] });
  check('dashboard: 0 不被吞掉', zero.metrics[0].value === '0');

  // 脏数据不能把面板搞崩
  const dirty = normalizeDashboard({
    metrics: [null, 42, { value: 1 }, { label: '好', value: { a: 1 } }],
  });
  check('dashboard: 丢弃无 label 的项', dirty.metrics.length === 1);
  check('dashboard: 对象值转 JSON', dirty.metrics[0].value === '{"a":1}');

  // 数量与长度都有上限
  const many = normalizeDashboard({
    metrics: Array.from({ length: 40 }, (_, i) => ({ label: 'k' + i, value: i })),
  });
  check('dashboard: 指标上限 12', many.metrics.length === 12);

  const long = normalizeDashboard({ metrics: [{ label: 'x'.repeat(80), value: 'y'.repeat(80) }] });
  check('dashboard: label 截断', long.metrics[0].label.length === 24);
  check('dashboard: value 截断', long.metrics[0].value.length === 40);

  // 声明式 dashboard 支持函数，也支持直接给对象
  const { PluginManager } = await import('../src/plugin/loader.js');
  const { Registry } = await import('../src/plugin/context.js');
  const pm = Object.create(PluginManager.prototype);
  pm.loaded = new Map();
  pm.dashCache = new Map();
  pm.loaded.set('t', { meta: { dashboard: () => ({ metrics: [{ label: 'a', value: 1 }] }) }, ctx: {} });
  const got = await pm.dashboardOf('t');
  check('dashboard: 函数形式被调用', got?.metrics[0].label === 'a');

  // 1 秒内重复拉取走缓存，不会把插件函数打爆
  let calls = 0;
  pm.loaded.set('u', {
    meta: {
      dashboard: () => {
        calls += 1;
        return { metrics: [{ label: 'n', value: calls }] };
      },
    },
    ctx: {},
  });
  await pm.dashboardOf('u');
  await pm.dashboardOf('u');
  check('dashboard: 1 秒内复用缓存', calls === 1);

  // ctx.setDashboard 推的数据也能读到
  pm.loaded.set('v', { meta: {}, ctx: { getDashboard: () => ({ metrics: [{ label: '推的', value: 9 }] }) } });
  const pushed = await pm.dashboardOf('v');
  check('dashboard: 读到 ctx.setDashboard 的数据', pushed?.metrics[0].label === '推的');

  check('dashboard: 未加载的插件返回 null', (await pm.dashboardOf('nope')) === null);

  // 声明式给了但内容为空时，必须继续回退到 ctx.setDashboard 推的那份。
  // 曾经的 bug：用 `if (!raw)` 判断，而 `dashboard: {}` 是 truthy，
  // 于是插件推的数据被活活吞掉。
  pm.loaded.set('w', { meta: { dashboard: {} }, ctx: { getDashboard: () => ({ metrics: [{ label: '推的', value: 1 }] }) } });
  check('dashboard: 声明式为空时回退到 setDashboard', (await pm.dashboardOf('w'))?.metrics[0].label === '推的');

  pm.loaded.set('x', {
    meta: { dashboard: () => null },
    ctx: { getDashboard: () => ({ metrics: [{ label: '推的2', value: 2 }] }) },
  });
  check('dashboard: 函数返回 null 时回退', (await pm.dashboardOf('x'))?.metrics[0].label === '推的2');

  // 声明式有效时不该被覆盖
  pm.loaded.set('y', {
    meta: { dashboard: { metrics: [{ label: '声明的', value: 3 }] } },
    ctx: { getDashboard: () => ({ metrics: [{ label: '推的3', value: 4 }] }) },
  });
  check('dashboard: 声明式有效时优先', (await pm.dashboardOf('y'))?.metrics[0].label === '声明的');
}

await testDashboard();

/* ---------- 群管接口与内邀闸门 ---------- */

async function testGroupManage() {
  const { QQApi } = await import('../src/api.js');
  // 假 token 管理器：闸门在 #request 之前抛错，所以永远走不到网络
  const api = new QQApi({ tokenManager: { get: async () => 'x', appId: '1' }, baseUrl: 'http://127.0.0.1:1' });

  const expectThrow = async (name, fn) => {
    try {
      await fn();
      check(name, false, '居然没抛错');
    } catch (e) {
      check(name, /未开启/.test(e.message), e.message.slice(0, 40));
    }
  };

  // 默认不开：四个内邀接口全部拒绝，且不该发出请求
  await expectThrow('群管: 默认拒绝 getGroupMembers', () => api.getGroupMembers('g'));
  await expectThrow('群管: 默认拒绝 getGroupMember', () => api.getGroupMember('g', 'u'));
  await expectThrow('群管: 默认拒绝 removeMembers', () => api.removeMembers('g', ['u']));
  await expectThrow('群管: 默认拒绝 getGroupBlacklist', () => api.getGroupBlacklist('g'));
  await expectThrow('群管: 默认拒绝 operateGroupBlacklist', () =>
    api.operateGroupBlacklist('g', { op: 'add', memberOpenids: ['u'] }),
  );

  // 打开后闸门放行（会真的去连 127.0.0.1:1，失败说明已经过了闸门）
  api.setGroupInvited(true);
  check('群管: setGroupInvited 生效', api.groupInvited === true);
  try {
    await api.getGroupMembers('g');
    check('群管: 开启后放行', false, '居然连上了');
  } catch (e) {
    check('群管: 开启后放行', !/未开启/.test(e.message), e.message.slice(0, 40));
  }

  // 公开接口不受开关影响：同样会去连，但错误里不该有「未开启」
  api.setGroupInvited(false);
  for (const [name, fn] of [
    ['muteMembers', () => api.muteMembers('g', [])],
    ['getMuteStatus', () => api.getMuteStatus('g')],
    ['getGroupInfo', () => api.getGroupInfo('g')],
  ]) {
    try {
      await fn();
      check(`群管: ${name} 公开可用`, false, '居然连上了');
    } catch (e) {
      check(`群管: ${name} 公开可用`, !/未开启/.test(e.message), e.message.slice(0, 40));
    }
  }

  // bot_state 是**内邀**接口（官方文档标注 11253 仅白名单机器人可用），
  // 早期版本把它归类成公开是错的，这里锁住正确行为
  await expectThrow('群管: getBotGroupState 默认拒绝', () => api.getBotGroupState('g'));

  // 配置默认值：invited 必须是 false
  const { loadBotConfig } = await import('../src/config.js');
  const cfg = await loadBotConfig('main').catch(() => null);
  if (cfg) {
    check('群管: 配置默认 invited=false', cfg.groupManage?.invited === false);
  }

  // 群管预检：查不到角色时不拦截，确认不是管理员才拦
  api.setGroupInvited(false);
  // 没开内邀 → canManageGroup 返回 role=null → 不该拦住禁言请求
  const st1 = await api.canManageGroup('g1');
  check('群管: 内邀未开时查不到角色', st1.role === null && st1.ok === false);
  try {
    await api.muteMembers('g1', []);
    check('群管: 查不到角色不拦截禁言', false, '居然没报错');
  } catch (e) {
    check('群管: 查不到角色不拦截禁言', !/没有管理权限/.test(e.message), e.message.slice(0, 40));
  }

  // 开了内邀 + 假造一个「只是普通成员」的响应 → 应该被友好地拦下来
  api.setGroupInvited(true);
  api.roleCache.clear();
  const realState = api.getBotGroupState.bind(api);
  api.getBotGroupState = async () => ({ member_role: 'member' });
  const st2 = await api.canManageGroup('g2');
  check('群管: 普通成员被识别为无权', st2.ok === false && st2.role === 'member');
  try {
    await api.muteMembers('g2', []);
    check('群管: 普通成员禁言被预检拦下', false, '居然没报错');
  } catch (e) {
    check('群管: 普通成员禁言被预检拦下', /没有管理权限/.test(e.message), e.message.slice(0, 50));
  }
  // 踢人和入群审批同样要拦
  for (const [name, fn] of [
    ['removeMembers', () => api.removeMembers('g2', ['u'])],
    ['approveJoinRequest', () => api.approveJoinRequest('g2', 'u', 'rid')],
  ]) {
    try {
      await fn();
      check(`群管: ${name} 普通成员被拦`, false, '居然没报错');
    } catch (e) {
      check(`群管: ${name} 普通成员被拦`, /没有管理权限/.test(e.message));
    }
  }
  // precheck:false 可以跳过
  try {
    await api.muteMembers('g2', [], { precheck: false });
    check('群管: precheck:false 跳过预检', false, '居然没报错');
  } catch (e) {
    check('群管: precheck:false 跳过预检', !/没有管理权限/.test(e.message), e.message.slice(0, 40));
  }

  // 群主/管理员要放行
  api.getBotGroupState = async () => ({ member_role: 'owner' });
  api.roleCache.clear();
  const st3 = await api.canManageGroup('g3');
  check('群管: 群主识别为有权', st3.ok === true && st3.role === 'owner');
  api.getBotGroupState = realState;
  api.roleCache.clear();

  // 入群申请 / 自动审批是公开接口，不该被内邀闸门挡着
  api.setGroupInvited(false);
  const joinApis = [
    ['approveJoinRequest', () => api.approveJoinRequest('g', 'u', 'rid')],
    ['declineJoinRequest', () => api.declineJoinRequest('g', 'u', {})],
    ['listJoinStrategies', () => api.listJoinStrategies()],
    ['createJoinStrategy', () => api.createJoinStrategy({ groupOpenids: ['g'] })],
    ['updateJoinStrategy', () => api.updateJoinStrategy('st_1', { isEnable: 'off' })],
    ['deleteJoinStrategy', () => api.deleteJoinStrategy('st_1')],
    ['executeJoinStrategy', () => api.executeJoinStrategy('st_1')],
    ['updateStrategyWhitelist', () => api.updateStrategyWhitelist('st_1', { op: 'add', whitelistUsers: ['123'] })],
  ];
  for (const [name, fn] of joinApis) {
    try {
      await fn();
      check(`群管: ${name} 公开可用`, false, '居然连上了');
    } catch (e) {
      check(`群管: ${name} 公开可用`, !/未开启/.test(e.message), e.message.slice(0, 40));
    }
  }
}

await testGroupManage();

/* ---------- Webhook 签名与流式消息/全局菜单 ---------- */

async function testWebhookAndStream() {
  const { signCallback, seedFromSecret, verifyRequest } = await import('../src/sign.js');
  const crypto = await import('node:crypto');

  // seed 推导：短 secret 循环填充，长 secret 截断
  const short = seedFromSecret('abc');
  check('webhook: 短 secret 填充到 32 字节', short.length === 32 && short.toString('utf8') === 'abc'.repeat(11).slice(0, 32));
  const long = seedFromSecret('x'.repeat(50));
  check('webhook: 长 secret 截断到 32 字节', long.length === 32 && long.toString('utf8') === 'x'.repeat(32));

  // 签名必须是合法 Ed25519，且能用对应公钥验过
  const secret = 'test-secret-32-bytes-long-enough';
  const sig = signCallback(secret, '1729555200', 'plain-token-abc');
  check('webhook: 签名是 128 位 hex', /^[0-9a-f]{128}$/.test(sig), sig.slice(0, 20) + '...');
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seedFromSecret(secret)]),
    format: 'der',
    type: 'pkcs8',
  });
  const pub = crypto.createPublicKey(priv);
  check(
    'webhook: 签名可通过公钥验证',
    crypto.verify(null, Buffer.from('1729555200plain-token-abc'), pub, Buffer.from(sig, 'hex')),
  );
  check('webhook: 同输入签名稳定', signCallback(secret, '1729555200', 'plain-token-abc') === sig);
  check('webhook: 不同输入签名不同', signCallback(secret, '1729555200', 'other') !== sig);

  // op=13 验证请求
  const signed = verifyRequest(secret, { op: 13, d: { plain_token: 'tok', event_ts: '1729555200' } });
  check('webhook: op=13 返回 plain_token + signature', signed?.plain_token === 'tok' && signed?.signature === signCallback(secret, '1729555200', 'tok'));
  check('webhook: 缺字段返回 null', verifyRequest(secret, { op: 13, d: {} }) === null);

  // 流式消息与全局菜单：公开接口，不该被内邀闸门挡
  const { QQApi } = await import('../src/api.js');
  const api = new QQApi({ tokenManager: { get: async () => 'x', appId: '1' }, baseUrl: 'http://127.0.0.1:1' });
  api.setGroupInvited(false);
  for (const [name, fn] of [
    ['sendStreamMessage', () => api.sendStreamMessage('u', { contentRaw: 'hi', index: 0 })],
    ['getGlobalMenu', () => api.getGlobalMenu()],
    ['setGlobalMenu', () => api.setGlobalMenu([{ name: '菜单', type: 'send_message', send_message: 'hi' }])],
  ]) {
    try {
      await fn();
      check(`新接口: ${name} 公开可用`, false, '居然连上了');
    } catch (e) {
      check(`新接口: ${name} 公开可用`, !/未开启/.test(e.message), e.message.slice(0, 40));
    }
  }

  // 菜单数量上限要拦
  try {
    api.setGlobalMenu(new Array(11).fill({ name: 'x' }));
    check('新接口: 菜单超过 10 项被拒', false, '居然没报错');
  } catch (e) {
    check('新接口: 菜单超过 10 项被拒', /最多 10 个/.test(e.message));
  }

  // 框架更新的版本比较
  const { compareVersion, currentVersion } = await import('../src/updater.js');
  check('更新: 0.5.1 < 0.5.2', compareVersion('0.5.1', '0.5.2') === -1);
  check('更新: 0.6.0 > 0.5.9', compareVersion('0.6.0', '0.5.9') === 1);
  check('更新: 同版本相等', compareVersion('0.5.1', '0.5.1') === 0);
  check('更新: 带 v 前缀也能比', compareVersion('v0.5.1', '0.5.2') === -1);
  check('更新: 解析不了的版本当相等', compareVersion('next', '0.5.2') === 0);
  const cur = await currentVersion();
  check('更新: 能读到当前版本', /^\d+\.\d+\.\d+/.test(cur), cur);

  // 定时重启的触发条件
  const { RestartService } = await import('../src/services/restart.js');
  let fired = 0;
  const mk = (cfg) =>
    new RestartService({ globalCfg: { restart: cfg }, onRestart: async () => { fired += 1; } });

  const s1 = mk({ enabled: true, everyHours: 6 });
  s1.lastAt = Date.now() - 7 * 3600_000;
  await s1.tick();
  check('重启: everyHours 到点触发', fired === 1);

  fired = 0;
  const s2 = mk({ enabled: true, everyHours: 6 });
  s2.lastAt = Date.now() - 3600_000;
  await s2.tick();
  check('重启: everyHours 未到点不触发', fired === 0);

  const s3 = mk({ enabled: true, at: 'abc' });
  await s3.tick();
  check('重启: at 格式错误有提示', /格式不对/.test(s3.detail), s3.detail);

  fired = 0;
  const s4 = mk({ enabled: true, at: '00:00' });
  await s4.tick();
  await s4.tick();
  check('重启: at 到点只触发一次', fired === 1, `触发 ${fired} 次`);

  // 清理服务：禁区目录必须跳过（存档误删是不可接受的）
  const { CleanupService } = await import('../src/services/cleanup.js');
  const cs = new CleanupService({ globalCfg: {} });
  check('清理: 默认保留 3 份备份', cs.keepBackups === 3);
  check('清理: 默认日志保留 14 天', cs.keepLogDays === 14);

  // tarball：手工造 tar 验证解析与路径穿越防护
  await testTarball();

  // 插件启用过滤器：面板开关和配置必须说同一件事
  const { pluginFilterOf } = await import('../src/bot.js');
  const fAll = pluginFilterOf({ mode: 'all', list: [] });
  check('插件过滤: all 全放行', fAll('any') === true);

  const fInc = pluginFilterOf({ mode: 'include', list: ['a'] });
  check('插件过滤: include 只放行名单内', fInc('a') === true && fInc('b') === false);

  const fExc = pluginFilterOf({ mode: 'exclude', list: ['a'] });
  check('插件过滤: exclude 放行名单外', fExc('a') === false && fExc('b') === true);

  // include + 空名单 = 一个都不启用（旧默认值就是坑在这里）
  const fEmpty = pluginFilterOf({ mode: 'include', list: [] });
  check('插件过滤: include+空名单等于全禁用', fEmpty('any') === false);

  // 缺省值应该等价于 all，不是「全禁用」
  const fDefault = pluginFilterOf({});
  check('插件过滤: 缺省按 include 处理（需显式给 mode）', fDefault('any') === false);

  /**
   * 分群插件开关（分发时过滤）。
   *
   * 和上面的 pluginFilterOf 是两件事：那个决定**加载**哪些插件（进程级），
   * 这个决定**某个会话里**能不能用。混起来就会出「A 群禁用把 B 群也搞没了」。
   */
  const { pluginAllowedIn } = await import('../src/bot.js');
  const G1 = 'group-1';
  const G2 = 'group-2';

  const spec = {
    mode: 'all',
    list: [],
    groups: {
      [G1]: { mode: 'include', list: ['dice'] },
      [G2]: { mode: 'exclude', list: ['kun'] },
    },
  };
  check('分群: 没配的会话跟着全局', pluginAllowedIn(spec, 'other-group', 'kun') === true);
  check('分群: include 只放行名单内', pluginAllowedIn(spec, G1, 'dice') === true);
  check('分群: include 挡住名单外', pluginAllowedIn(spec, G1, 'kun') === false);
  check('分群: exclude 挡住名单内', pluginAllowedIn(spec, G2, 'kun') === false);
  check('分群: exclude 放行名单外', pluginAllowedIn(spec, G2, 'dice') === true);
  check('分群: 两个群互不影响', pluginAllowedIn(spec, G1, 'echo') === false && pluginAllowedIn(spec, G2, 'echo') === true);

  // 内核命令不能被锁在门外，否则群里连 /help 都没了
  check('分群: 内核命令永远放行', pluginAllowedIn(spec, G1, '__core') === true);

  // include + 空名单 = 这个群不响应任何插件（面板上「一个都不勾」）
  check(
    '分群: include+空名单等于本群全禁用',
    pluginAllowedIn({ groups: { [G1]: { mode: 'include', list: [] } } }, G1, 'dice') === false,
  );

  // 没配 groups 字段（老配置）不能炸
  check('分群: 老配置没有 groups 也正常', pluginAllowedIn({ mode: 'all' }, G1, 'dice') === true);
}

/**
 * 造一个最小 tar 条目。tar 头是 512 字节固定格式，
 * 校验和字段要把自己当成 8 个空格算。
 */
function tarEntry(name, content, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); // mode
  h.write('0000000\0', 108); // uid
  h.write('0000000\0', 116); // gid
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124); // size
  h.write('00000000000\0', 136); // mtime
  h.write('        ', 148); // checksum 占位 8 个空格
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);

  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);

  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(body);
  return Buffer.concat([h, body]);
}

async function testTarball() {
  const { parseTar, extractEntries } = await import('../src/tarball.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');

  const tar = Buffer.concat([
    tarEntry('repo-main/', Buffer.alloc(0), '5'),
    tarEntry('repo-main/src/main.js', Buffer.from('console.log(1)')),
    tarEntry('repo-main/package.json', Buffer.from('{}')),
  ]);
  // 结尾两个全零块
  const full = Buffer.concat([tar, Buffer.alloc(1024)]);

  const entries = parseTar(full);
  check('tarball: 解析出 3 个条目', entries.length === 3, `实际 ${entries.length}`);
  check('tarball: 能识别目录', entries[0].dir === true);
  check('tarball: 能读出文件内容', entries[1].content.toString() === 'console.log(1)');

  // 剥顶层目录
  const d1 = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-tar-'));
  await extractEntries(entries, d1);
  const hasMain = await fs.access(path.join(d1, 'src', 'main.js')).then(() => true, () => false);
  check('tarball: 剥掉顶层目录', hasMain);
  await fs.rm(d1, { recursive: true, force: true });

  // 带 ./ 前缀（tar czf 自打的包常见），也要能剥
  const dotTar = Buffer.concat([
    tarEntry('./', Buffer.alloc(0), '5'),
    tarEntry('./repo-main/src/main.js', Buffer.from('x')),
  ]);
  const dotEntries = parseTar(Buffer.concat([dotTar, Buffer.alloc(1024)]));
  const d2 = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-tar-'));
  await extractEntries(dotEntries, d2);
  const ok2 = await fs.access(path.join(d2, 'src', 'main.js')).then(() => true, () => false);
  check('tarball: ./ 前缀也能正确剥离', ok2);
  await fs.rm(d2, { recursive: true, force: true });

  // 路径穿越必须被拦住
  const evil = parseTar(
    Buffer.concat([tarEntry('repo-main/../../../evil.txt', Buffer.from('pwn')), Buffer.alloc(1024)]),
  );
  const d3 = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-tar-'));
  await extractEntries(evil, d3);
  const escaped = await fs
    .access(path.join(d3, '..', '..', '..', 'evil.txt'))
    .then(() => true, () => false);
  const inside = await fs.access(path.join(d3, 'evil.txt')).then(() => true, () => false);
  check('tarball: 路径穿越被拦住', !escaped, escaped ? '写到了目录外！' : '');
  check('tarball: 穿越路径被归一化到目录内', inside || !escaped);
  await fs.rm(d3, { recursive: true, force: true });
}

await testWebhookAndStream();

/* ---------- 配置归属：全局设置不能落进机器人配置 ---------- */

async function testConfigOwnership() {
  const { saveBotConfig, loadBotConfig, BOT_DEFAULTS } = await import('../src/config.js');
  const fsP = await import('node:fs/promises');
  const path = await import('node:path');

  const tmpId = '__selftest_cfg';
  const file = path.join(process.cwd(), 'config', 'bots', `${tmpId}.json`);

  // 故意把 webui / logLevel 塞进 cfg，模拟从面板传进来的脏数据
  const dirty = {
    ...BOT_DEFAULTS,
    id: tmpId,
    name: 'selftest',
    appId: '1',
    appSecret: '2',
    webui: { host: 'evil.example', port: 1, accessKey: 'x' },
    logLevel: 'debug',
  };
  await saveBotConfig(tmpId, dirty);

  let raw = {};
  try {
    raw = JSON.parse(await fsP.readFile(file, 'utf8'));
  } catch {}

  // saveBotConfig 是白名单式保存，这两个全局设置不该出现在机器人配置里
  check('配置: webui 不落进机器人配置', raw.webui === undefined);
  check('配置: logLevel 不落进机器人配置', raw.logLevel === undefined);
  // 该在的必须在
  check('配置: groupManage 会保存', raw.groupManage?.invited === false);
  check('配置: 基本字段会保存', raw.appId === '1' && raw.name === 'selftest');

  // 读回来的 cfg 也不该带上全局设置
  const back = await loadBotConfig(tmpId).catch(() => null);
  if (back) {
    check('配置: 读回的 cfg 不含 webui', back.webui === undefined);
    check('配置: 读回的 cfg 有 groupManage 默认值', back.groupManage?.invited === false);
  }

  await fsP.unlink(file).catch(() => {});
}

await testConfigOwnership();

/* ---------- 插件热重载 ---------- */

async function testPluginWatch() {
  const { PluginWatchService } = await import('../src/services/plugin-watch.js');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-watch-'));
  const put = async (id, rel, body) => {
    const p = path.join(root, id, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    /**
     * 写完统一把 mtime 拨到 5 秒前。
     *
     * 文件系统的 mtime 有时会比 Date.now() 晚 1ms，那一轮
     * `now - mtime` 是负数，会被判成「还没安静够」进 pending，
     * 测试就假失败。拨到过去让判断只依赖 settleMs，不依赖时钟精度。
     */
    const past = new Date(Date.now() - 5000);
    await fs.utimes(p, past, past);
  };
  /** 把 mtime 往前拨，模拟「文件已经写完一会儿了」 */
  const age = async (id, rel = 'index.js') => {
    const p = path.join(root, id, rel);
    const past = new Date(Date.now() - 5000);
    await fs.utimes(p, past, past);
  };

  await put('alpha', 'index.js', 'export default { id:"alpha", v:1 }');

  const calls = { reload: [], rescan: 0 };
  const rt = {
    id: 'main',
    plugins: {
      loaded: new Map([['alpha', {}]]),
      state: {},
      async reload(id) {
        calls.reload.push(id);
        return true;
      },
      async rescan() {
        calls.rescan += 1;
        return { added: [], removed: [] };
      },
    },
  };
  const w = new PluginWatchService({ globalCfg: {}, getRuntimes: () => [rt], dir: root });

  // 首次扫描只记录基线，不能一启动就把所有插件重载一遍
  await w.tick();
  check('热重载: 首次扫描只建基线，不重载', calls.reload.length === 0);

  await w.tick();
  check('热重载: 内容没变不重载', calls.reload.length === 0);

  // 刚写完先不动手：编辑器可能还在写。
  // 这里把 settleMs 调大，让判断不依赖真实时钟——否则机器一卡就假失败。
  w.settleMs = 60000;
  await put('alpha', 'index.js', 'export default { id:"alpha", v:2 }');
  await w.tick();
  check('热重载: 文件刚改完先等稳定', calls.reload.length === 0);

  // settleMs 归零，等价于「写完已经一会儿了」
  w.settleMs = 0;
  await w.tick();
  check('热重载: 文件稳定后触发重载', calls.reload.join() === 'alpha', `reload=${calls.reload.join()}`);

  // 新增插件目录 → 走 rescan（它认得「装了什么」）
  await put('beta', 'index.js', 'export default { id:"beta" }');
  await w.tick();
  check('热重载: 新增插件目录触发 rescan', calls.rescan === 1, `rescan=${calls.rescan}`);

  // 依赖目录的变化不该触发重载，否则 npm install 一次能重载十遍
  await put('alpha', 'node_modules/foo/index.js', 'module.exports = 1');
  await age('alpha', 'node_modules/foo/index.js');
  await w.tick();
  await w.tick();
  check('热重载: node_modules 变化被忽略', calls.reload.length === 1, `reload=${calls.reload.length}`);

  // 运行时产物（__pycache__ / .log / .db）同理
  await put('alpha', '__pycache__/x.pyc', 'x');
  await put('alpha', 'run.log', 'x');
  await age('alpha', 'run.log');
  await w.tick();
  await w.tick();
  check('热重载: __pycache__ 和 .log 变化被忽略', calls.reload.length === 1);

  // 被禁用的插件不重载——用户关掉它就是因为不想让它跑
  rt.plugins.state.alpha = false;
  await put('alpha', 'index.js', 'export default { id:"alpha", v:3 }');
  await age('alpha');
  await w.tick();
  await w.tick();
  check('热重载: 已禁用的插件不重载', calls.reload.length === 1);
  rt.plugins.state.alpha = true;

  // 挂起期间完全不动作（安装/卸载插件时会挂起）
  w.suspend(5000);
  await put('alpha', 'index.js', 'export default { id:"alpha", v:4 }');
  await age('alpha');
  await w.tick();
  check('热重载: 挂起期间不重载', calls.reload.length === 1);

  // 恢复后要重建基线，不能把挂起期间的改动当新变化
  w.suspendedUntil = 0;
  await w.tick();
  await w.tick();
  check('热重载: 恢复后重建基线，不补触发', calls.reload.length === 1);

  // 依赖标记文件（deps.js 写的）不该算「改了代码」
  const beforeDeps = calls.reload.length;
  await put('alpha', '.deps.json', '{"requirements":"abc"}');
  await w.tick();
  await w.tick();
  check('热重载: .deps.json 变化被忽略', calls.reload.length === beforeDeps);

  /**
   * 熔断：插件自己往目录里写文件会造成 2 秒一轮的死循环。
   * 30 秒内重载 3 次就暂停 60 秒，不能一直烧 CPU。
   *
   * 这里**固定跑 5 轮**，不看「这一轮有没有触发 reload」。
   * 以前的循环条件是 `calls.reload.length !== last`，一旦某轮因为
   * 时序没触发重载就立刻退出，可能只累计到 2 次——达不到熔断阈值，
   * 测试就假失败。在 Node 24 上文件系统时序更快，正好踩中。
   *
   * 5 轮足够越过「3 次」的阈值，也多留几轮验证「熔断后不再重载」。
   */
  w.settleMs = 0;
  const ROUNDS = 5;
  for (let i = 0; i < ROUNDS; i++) {
    await put('alpha', 'index.js', `export default { id:"alpha", loop:${i} }`);
    await w.tick();
    // 已经熔断了就停，没必要把 5 轮跑完
    if (w.tripped.has('alpha')) break;
  }
  const afterTrip = calls.reload.length;
  check('热重载: 反复重载后触发熔断', w.tripped.has('alpha'), `reload=${afterTrip}`);
  // 熔断期间再改文件也不该重载
  await put('alpha', 'index.js', 'export default { id:"alpha", loop:"after-trip" }');
  await w.tick();
  check('热重载: 熔断后不再重载', calls.reload.length === afterTrip, `reload=${afterTrip}`);

  await w.stop();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

await testPluginWatch();

/* ---------- 版本范围匹配 ---------- */

async function testSemver() {
  const { satisfies, compareVersion, frameworkVersion, parseVersion } = await import(
    '../src/semver.js'
  );

  check('版本: 精确匹配', satisfies('0.5.6', '0.5.6'));
  check('版本: 精确不匹配', !satisfies('0.5.6', '0.5.5'));
  check('版本: >= 通过', satisfies('0.5.6', '>=0.5.0'));
  check('版本: >= 不通过', !satisfies('0.4.9', '>=0.5.0'));
  check('版本: 区间写法', satisfies('0.5.6', '>=0.5.0 <1.0.0'));
  check('版本: 区间上界不含', !satisfies('1.0.0', '>=0.5.0 <1.0.0'));
  check('版本: ^0.5.0 到 0.6.0 之前', satisfies('0.5.9', '^0.5.0') && !satisfies('0.6.0', '^0.5.0'));
  check('版本: ^1.2.3 到 2.0.0 之前', satisfies('1.9.0', '^1.2.3') && !satisfies('2.0.0', '^1.2.3'));
  check('版本: ~0.5.0 只到 0.6.0 之前', satisfies('0.5.9', '~0.5.0') && !satisfies('0.6.0', '~0.5.0'));
  check('版本: 通配 0.5.x', satisfies('0.5.6', '0.5.x') && !satisfies('0.6.0', '0.5.x'));
  check('版本: 或的写法', satisfies('0.3.0', '>=0.5.0 || ^0.3.0'));
  check('版本: 空范围放行', satisfies('0.5.6', '') && satisfies('0.5.6', '*'));
  check('版本: 写歪的范围不拦（放行）', satisfies('0.5.6', '随便写的'));
  // 预发行版：范围没写 - 就不认，免得作者以为测的是正式版
  check('版本: 预发行版默认不满足', !satisfies('0.6.0-beta.1', '>=0.5.0'));
  check('版本: 预发行版明确写了才认', satisfies('0.6.0-beta.1', '>=0.6.0-beta.1'));
  check('版本: 解析带 v 前缀', parseVersion('v1.2.3')?.nums.join('.') === '1.2.3');
  check('版本: compareVersion 仍可用', compareVersion('0.5.1', '0.5.2') === -1);
  check('版本: 框架版本读得到', /^\d+\.\d+\.\d+/.test(frameworkVersion()), frameworkVersion());

  /**
   * 光 import 模块抓不到「函数体里引用了没导入的名字」——
   * 那次把 compareVersion 改成 re-export 之后，market.js 里的 detectUpdates
   * 直接 ReferenceError，但模块导入测试照样通过。所以这里真的调一遍。
   */
  const { detectUpdates } = await import('../src/plugin/market.js');
  const ups = detectUpdates(
    [{ id: 'a', version: '2.0.0' }, { id: 'b', version: '1.0.0' }],
    { a: '1.0.0', b: '1.0.0' },
  );
  check(
    '版本: detectUpdates 能跑（引用没断）',
    ups.length === 1 && ups[0].id === 'a',
    JSON.stringify(ups.map((u) => u.id)),
  );
}

await testSemver();

/* ---------- 插件框架版本兼容 ---------- */

async function testPluginCompat() {
  const { PluginManager } = await import('../src/plugin/loader.js');
  const { Registry } = await import('../src/plugin/context.js');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-compat-'));
  const mk = async (id, body) => {
    await fs.mkdir(path.join(root, id), { recursive: true });
    await fs.writeFile(path.join(root, id, 'index.js'), body);
  };
  const quiet = { logs: { enabled: false } };
  const makePm = (ignoreCompat = false) =>
    new PluginManager({
      pluginsDir: root,
      paths: {
        id: 'main',
        pluginConfig: () => path.join(root, '.cfg.json'),
        pluginLog: () => path.join(root, '.log'),
        pluginDataDirFor: () => root,
        pluginData: (name) => path.join(root, 'data', name),
      },
      // 用真的 Registry：假对象缺方法会让「加载成功」这个用例变成假阴性
      registry: new Registry(),
      api: {},
      cfg: quiet,
      goBin: null,
      groups: {},
      roles: {},
      outbound: {},
      session: {},
      pipeline: { removeByPlugin() {} },
      isOwner: () => false,
      ignoreCompat,
    });

  // 要求一个不可能满足的版本 → 必须拒绝加载，并说清原因
  await mk(
    'needs-new',
    `export default { id:'needs-new', name:'要新框架', frameworkVersion:'>=99.0.0',
       setup(ctx){ ctx.command('x','x', async()=>'x'); } };`,
  );
  const pm = makePm();
  const ok = await pm.load('needs-new');
  const err = pm.errors.get('needs-new') ?? '';
  check('兼容: 框架版本不满足时拒绝加载', ok === false);
  check('兼容: 报错说清要求与当前版本', /99\.0\.0/.test(err) && /当前/.test(err), err.slice(0, 60));

  // 放宽开关后能装（作者本地调试用）
  const pm2 = makePm(true);
  const ok2 = await pm2.load('needs-new');
  check('兼容: ignoreFrameworkVersion 可跳过校验', ok2 === true);

  // 满足要求就正常加载
  await mk(
    'fine',
    `export default { id:'fine', name:'正常', frameworkVersion:'>=0.1.0',
       setup(ctx){ ctx.command('y','y', async()=>'y'); } };`,
  );
  const pm3 = makePm();
  const ok3 = await pm3.load('fine');
  check('兼容: 满足要求正常加载', ok3 === true);

  // 不写 frameworkVersion 的老插件照旧能跑
  await mk('plain', `export default { id:'plain', setup(ctx){ ctx.command('z','z', async()=>'z'); } };`);
  const pm4 = makePm();
  check('兼容: 没声明版本要求的插件不受影响', (await pm4.load('plain')) === true);

  /**
   * 加载失败必须留下堆栈。
   * 只记 e.message 的话，「Cannot read properties of undefined」这种错误
   * 完全看不出是哪一行，作者只能靠猜。
   */
  await mk(
    'boom',
    `export default { id:'boom', name:'会炸',
       setup(){ const x = null; return x.foo(); } };`,
  );
  const pm5 = makePm();
  const okBoom = await pm5.load('boom');
  const boomMsg = pm5.errors.get('boom') ?? '';
  const boomStack = pm5.errorStacks.get('boom') ?? '';
  check('错误: 加载失败被记录', okBoom === false && !!boomMsg);
  check('错误: 留下完整堆栈', /boom/.test(boomStack) && /\n\s+at /.test(boomStack), boomStack.slice(0, 60));

  // 面板拿到的是 list() 的结果，堆栈得能传出去
  await pm5.rescan().catch(() => {});
  const row = pm5.list().find((p) => p.id === 'boom');
  check(
    '错误: 面板列表里带得出去',
    (row?.errorStack ?? '').length > 0,
    `found=${!!row} len=${(row?.errorStack ?? '').length}`,
  );

  /**
   * ctx.state 要跨热重载保留。
   * 模块顶层变量在重载时必然重建（ESM 行为），框架得给个能留住东西的地方，
   * 否则作者第一反应是「框架把我数据吃了」。
   */
  await mk(
    'keeper',
    `export default { id:'keeper', setup(ctx){ ctx.state.n = (ctx.state.n || 0) + 1; } };`,
  );
  const pm6 = makePm();
  await pm6.load('keeper');
  const stateObj = pm6.stateStore.get('keeper');
  const after1 = stateObj?.n;
  await pm6.reload('keeper');
  const after2 = pm6.stateStore.get('keeper')?.n;
  check(
    '状态: ctx.state 跨重载保留',
    after1 === 1 && after2 === 2 && pm6.stateStore.get('keeper') === stateObj,
    `${after1} → ${after2}`,
  );

  /**
   * 内建插件带 package.json 时也要能正常加载。
   * 这里不测「真装依赖」（要联网、要几十秒），只测这条路径不会把加载搞挂：
   * 没依赖的 package.json 应该被识别成「无需安装」，然后照常加载。
   */
  await mk(
    'withpkg',
    `export default { id:'withpkg', setup(ctx){ ctx.command('w','w', async()=>'w'); } };`,
  );
  await fs.writeFile(
    path.join(root, 'withpkg', 'package.json'),
    JSON.stringify({ name: 'withpkg', private: true }),
  );
  const pm7 = makePm();
  const okPkg = await pm7.load('withpkg');
  check('依赖: 内建插件带 package.json 也能加载', okPkg === true, pm7.errors.get('withpkg') ?? '');

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

await testPluginCompat();

/* ---------- 配置校验规则 ---------- */

async function testConfigRules() {
  const { validateConfig, schemaOf } = await import('../src/plugin/config.js');

  const schema = schemaOf({
    name: { default: '', type: 'string', required: true, desc: '名字' },
    count: { default: 3, type: 'number', min: 1, max: 10 },
    token: { default: '', type: 'string', pattern: '^[a-z]+$' },
    plain: '随便',
  });

  check('校验: 必填项为空时报错', /必填/.test(validateConfig({ name: '' }, schema) ?? ''));
  check('校验: 必填项有值就过', validateConfig({ name: 'x' }, schema) === null);
  check('校验: 小于最小值报错', /不能小于 1/.test(validateConfig({ name: 'x', count: 0 }, schema) ?? ''));
  check('校验: 大于最大值报错', /不能大于 10/.test(validateConfig({ name: 'x', count: 99 }, schema) ?? ''));
  check('校验: 范围内通过', validateConfig({ name: 'x', count: 5 }, schema) === null);
  check('校验: 正则不匹配报错', /格式不对/.test(validateConfig({ name: 'x', token: 'ABC' }, schema) ?? ''));
  check('校验: 正则匹配通过', validateConfig({ name: 'x', token: 'abc' }, schema) === null);
  check('校验: 没声明规则的项一律放过', validateConfig({ name: 'x', plain: {} }, schema) === null);

  // schema 要把规则透给面板，否则前端没法提前拦
  check('校验: schema 带出 required/min/max/pattern', 
    schema.name.required === true && schema.count.min === 1 && schema.count.max === 10 && Boolean(schema.token.pattern));
}

await testConfigRules();

/* ---------- 插件测试夹具 ---------- */

async function testTestkit() {
  const { makeCtx, makeMsg, runCommand } = await import('../src/plugin/testkit.js');

  const fake = {
    id: 'fake',
    setup(ctx) {
      ctx.command('echo [内容]', { desc: '复读' }, async (msg) => {
        await msg.reply(`收到：${msg.args.join(' ')}`);
      });
      ctx.command('save', { desc: '存一下' }, async (msg) => {
        await ctx.storage.set('k', 'v');
        await msg.reply(await ctx.storage.get('k'));
      });
    },
  };

  const r1 = await runCommand(fake, 'echo', { content: '/echo 你好 世界' });
  check('夹具: 命令能跑并拿到回复', r1.replies[0] === '收到：你好 世界', r1.replies[0]);
  check('夹具: 标记了 handled', r1.handled === true);

  const r2 = await runCommand(fake, 'save', { content: '/save' });
  check('夹具: storage 可用', r2.replies[0] === 'v');

  const ctx = makeCtx();
  await fake.setup(ctx);
  const m = makeMsg({ content: '随便说说' });
  check('夹具: 非命令的 args 是整句切分', m.isCommand === false && m.args.join() === '随便说说');

  let missing = '';
  try {
    await runCommand(fake, 'nope', { content: '/nope' });
  } catch (e) {
    missing = e.message;
  }
  check('夹具: 命令不存在时报清楚', /没有注册命令/.test(missing) && /echo/.test(missing), missing.slice(0, 40));
}

await testTestkit();

/* ---------- 体检 ---------- */

async function testDoctor() {
  const { runDoctor, summarize } = await import('../src/doctor.js');

  const items = await runDoctor({
    cfg: { appId: '123', appSecret: 'abc', intents: 1 << 25 },
    globalCfg: { webui: { host: '127.0.0.1', port: 15207, accessKey: '' } },
    rt: null,
    mock: true,
  });

  const ids = items.map((x) => x.id);
  check('体检: 能跑出结果', items.length >= 4, `${items.length} 项`);
  check('体检: 检查了凭证', ids.includes('credential'));
  check('体检: 检查了 intents', ids.includes('intent-group'));
  check('体检: 检查了插件目录', ids.includes('plugins-dir'));
  check('体检: 每项都有标题和说明', items.every((x) => x.title && x.detail));

  // 群聊 intent 没开时必须报错——这是「收不到群消息」最常见的原因
  const noIntent = await runDoctor({
    cfg: { appId: '1', appSecret: '2', intents: 0 },
    globalCfg: {},
    rt: null,
    mock: true,
  });
  const g = noIntent.find((x) => x.id === 'intent-group');
  check('体检: 没订阅群聊事件会报 error', g?.level === 'error' && /群消息/.test(g.detail));

  // 面板暴露到公网又没密钥，必须拦
  const open = await runDoctor({
    cfg: { appId: '1', appSecret: '2', intents: 1 << 25 },
    globalCfg: { webui: { host: '0.0.0.0', port: 15207, accessKey: '' } },
    rt: null,
    mock: true,
  });
  check('体检: 公网无密钥报 error', open.find((x) => x.id === 'webui')?.level === 'error');

  check('体检: 摘要能压成一句话', summarize(items).length > 0, summarize(items));
}

await testDoctor();

/* ---------- 模块可导入性（防止改了导出忘了改引用） ---------- */

/* ---------- 统计库（SQLite） ---------- */

async function testStats() {
  const { StatsStore, dayKey } = await import('../src/storage/index.js');
  const { probeSqlite } = await import('../src/storage/db.js');

  if (!probeSqlite()) {
    // 环境不支持就不算失败，但要说清为什么跳过
    check('统计: 当前 Node 无内置 SQLite，跳过', true, '（需 22.5+）');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-stats-'));
  const file = path.join(root, 'stats.db');
  const store = new StatsStore({ file, retentionDays: 30 });

  check('统计: 能打开并建表', store.open() === true && store.available);

  const now = Date.now();
  store.record({ scope: 'group', chatId: 'g1', userId: 'u1', ts: now });
  store.record({ scope: 'group', chatId: 'g1', userId: 'u2', ts: now });
  store.record({ scope: 'group', chatId: 'g1', userId: 'u1', isCommand: true, command: 'dice', ts: now });
  store.record({ scope: 'c2c', chatId: 'u9', userId: 'u9', isCommand: true, command: 'dice', ts: now });

  check('统计: 写入是缓冲的（flush 前不落盘）', store.buf.length === 4);
  check('统计: flush 返回写入条数', store.flush() === 4);
  check('统计: flush 后缓冲清空', store.buf.length === 0);

  const ov = store.overview(7);
  check('统计: 总消息数正确', ov.total === 4, `total=${ov.total}`);
  check('统计: 今日消息数正确', ov.today.messages === 4);
  check('统计: 今日命令数正确', ov.today.commands === 2, `cmd=${ov.today.commands}`);
  check('统计: 今日活跃去重正确', ov.today.users === 3, `users=${ov.today.users}`);
  check('统计: 命令排行正确', ov.topCommands[0]?.name === 'dice' && ov.topCommands[0].count === 2);
  check('统计: 会话排行正确', ov.topChats[0]?.chatId === 'g1' && ov.topChats[0].messages === 3);
  check('统计: 成员档案去重正确', ov.members.total === 3, `members=${ov.members.total}`);
  check('统计: 折线补齐空白天', ov.series.length === 7 && ov.series.at(-1).day === dayKey(), `len=${ov.series.length}`);

  // 只记数量不记正文——这是隐私底线，用表结构验证
  const cols = store.db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  check('统计: 不存消息正文', !cols.includes('content') && !cols.includes('text'), cols.join(','));

  // 过期清理
  const old = now - 40 * 86400_000;
  store.record({ scope: 'group', chatId: 'g1', userId: 'u3', ts: old });
  store.flush();
  const before = store.overview(7).total;
  const membersBefore = store.overview(7).members.total;
  const pruned = store.prune();
  check('统计: 过期明细被清掉', pruned.messages >= 1, `删除 ${pruned.messages} 条`);
  check('统计: 清理后总量减少', store.overview(7).total === before - 1);
  check(
    '统计: 成员档案不被清理',
    store.overview(7).members.total === membersBefore,
    `清理前 ${membersBefore} → 清理后 ${store.overview(7).members.total}`,
  );

  // 重开同一个库：迁移要幂等，数据要还在
  store.close();
  const again = new StatsStore({ file, retentionDays: 30 });
  again.open();
  check('统计: 重新打开数据还在', again.overview(7).total === 4, `total=${again.overview(7).total}`);
  again.close();

  // 关闭之后 record 不能抛错（退出阶段可能还有消息进来）
  let threw = false;
  try {
    again.record({ scope: 'group', chatId: 'g1', userId: 'u1' });
  } catch {
    threw = true;
  }
  check('统计: 关闭后写入不抛错', !threw);

  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

await testStats();

/* ---------- 素材缓存与模板消息 ---------- */

async function testMediaAndTemplate() {
  const { QQApi, FILE_TYPE } = await import('../src/api.js');

  // 把 fetch 换掉，数一数到底发了几次上传请求
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ file_uuid: 'u1', file_info: 'fi1', ttl: 300 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const api = new QQApi({
      tokenManager: { get: async () => 'tok', appId: 'app', refresh: async () => {} },
      baseUrl: 'http://127.0.0.1:1',
    });

    const a = await api.uploadMedia('group', 'g1', { url: 'https://x/1.png' });
    const b = await api.uploadMedia('group', 'g1', { url: 'https://x/1.png' });
    check('素材: 同一个 url 只上传一次', calls === 1 && b?.file_info === 'fi1', `calls=${calls}`);
    check('素材: 命中缓存返回同样的 file_info', a?.file_info === b?.file_info);

    await api.uploadMedia('group', 'g2', { url: 'https://x/1.png' });
    check('素材: 换一个目标要重新上传', calls === 2, `calls=${calls}`);

    await api.uploadMedia('group', 'g1', { url: 'https://x/1.png', reuse: false });
    check('素材: reuse=false 强制重新上传', calls === 3, `calls=${calls}`);

    await api.uploadMedia('group', 'g1', { fileType: FILE_TYPE.IMAGE, fileData: 'AAAA' });
    await api.uploadMedia('group', 'g1', { fileType: FILE_TYPE.IMAGE, fileData: 'AAAA' });
    check('素材: base64 上传不缓存（每次都传）', calls === 5, `calls=${calls}`);

    // 缓存有上限，不能无限长
    for (let i = 0; i < 210; i++) {
      await api.uploadMedia('group', 'g1', { url: `https://x/${i}.png` });
    }
    check('素材: 缓存不超过 200 条', api.mediaCache.size <= 200, `size=${api.mediaCache.size}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  // 模板消息：markdown + 按钮一次带出去，而不是发三条
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
      id: 'm2',
      content: '测试',
      group_openid: 'g1',
      author: { member_openid: 'u1' },
      timestamp: String(Date.now()),
    },
    { api: fakeApi, cfg: { commandPrefix: '/' } },
  );

  const kb = { content: { rows: [{ buttons: [{ id: '1', render_data: { label: '按钮' } }] }] } };
  await msg.replyCard({ markdown: { content: '## 标题' }, keyboard: kb });
  check('模板: 一条消息带上 markdown 和按钮', sent.length === 1 && !!sent[0].body.markdown);
  check('模板: 按钮没被丢掉', JSON.stringify(sent[0].body.keyboard ?? {}) === JSON.stringify(kb));

  sent.length = 0;
  await msg.replyCard({});
  check('模板: 空内容不发消息', sent.length === 0);

  /**
   * 一条消息只能有一种富文本。两个都给时以 markdown 为准，
   * 不能两个都塞进 payload——api 的 #payload 会让 ark 赢（msg_type=3），
   * 和文档说的相反，所以必须在 replyCard 里就把 ark 丢掉。
   */
  sent.length = 0;
  await msg.replyCard({ markdown: { content: '## x' }, ark: { template_id: 1 } });
  check(
    '模板: markdown 与 ark 同时给时只发 markdown',
    sent.length === 1 && !!sent[0].body.markdown && sent[0].body.ark === undefined,
    JSON.stringify(Object.keys(sent[0]?.body ?? {})),
  );
}

await testMediaAndTemplate();

/* ---------- 下载源（镜像） ---------- */

async function testMirror() {
  const {
    applyMirror,
    mirrorCandidates,
    configureMirror,
    currentMirror,
    presetOf,
    fetchViaMirror,
  } = await import('../src/mirror.js');

  const raw = 'https://raw.githubusercontent.com/a/b/main/index.json';
  const tar = 'https://github.com/a/b/archive/refs/heads/main.tar.gz';

  // 直连：什么都不改
  configureMirror({ network: { mirror: 'github' } });
  check('镜像: 直连不改地址', applyMirror(tar, presetOf('github')) === tar);
  check('镜像: 直连只有一个候选', mirrorCandidates(tar).length === 1);

  // 前缀型
  configureMirror({ network: { mirror: 'ghfast' } });
  check(
    '镜像: 前缀型拼在原始地址前面',
    applyMirror(tar, presetOf('ghfast')) === `https://ghfast.top/${tar}`,
  );
  check('镜像: raw 地址同样能加前缀', mirrorCandidates(raw)[0].startsWith('https://ghfast.top/'));

  // 域名替换型
  configureMirror({ network: { mirror: 'kkgithub' } });
  check(
    '镜像: 域名替换型换 host 保留路径',
    applyMirror(tar, presetOf('kkgithub')) ===
      'https://kkgithub.com/a/b/archive/refs/heads/main.tar.gz',
  );
  check(
    '镜像: raw 域名也跟着换',
    applyMirror(raw, presetOf('kkgithub')) === 'https://raw.kkgithub.com/a/b/main/index.json',
  );

  // 非 GitHub 地址一律不碰（自建图床、MirrorChyan 等）
  const other = 'https://example.com/x.tar.gz';
  check('镜像: 非 GitHub 地址原样返回', applyMirror(other, presetOf('ghfast')) === other);
  check('镜像: 非 GitHub 地址不参与兜底', mirrorCandidates(other).length === 1);

  // 自定义前缀：没填就退回直连，不能把请求发到空地址
  configureMirror({ network: { mirror: 'custom', mirrorCustom: '' } });
  check('镜像: 自定义前缀为空时退回直连', mirrorCandidates(tar)[0] === tar);
  configureMirror({ network: { mirror: 'custom', mirrorCustom: 'gh.example.com' } });
  check(
    '镜像: 自定义前缀自动补协议和斜杠',
    mirrorCandidates(tar)[0] === 'https://gh.example.com/https://github.com/a/b/archive/refs/heads/main.tar.gz',
  );

  // auto：直连排第一，后面跟一串镜像
  configureMirror({ network: { mirror: 'auto' } });
  const auto = mirrorCandidates(tar);
  check('镜像: auto 直连优先', auto[0] === tar);
  check('镜像: auto 带多个备用源', auto.length >= 4, `${auto.length} 个候选`);

  // 配置写歪了要能兜住
  configureMirror({ network: { mirror: '不存在的源' } });
  check('镜像: 未知源退回 auto', currentMirror().id === 'auto');

  // 兜底 fetch：第一个源抛错，第二个能成功
  const realFetch = globalThis.fetch;
  const tried = [];
  globalThis.fetch = async (u) => {
    tried.push(u);
    if (tried.length === 1) throw new Error('模拟直连超时');
    return new Response('ok', { status: 200 });
  };
  try {
    configureMirror({ network: { mirror: 'auto' } });
    const res = await fetchViaMirror(tar);
    check('镜像: 直连失败会自动换源', res.ok && tried.length === 2, `试了 ${tried.length} 次`);
    check('镜像: 换的是镜像地址', tried[1].startsWith('https://'), tried[1].slice(0, 30));

    // 4xx 不该无脑换源（地址错了换源也没用）
    tried.length = 0;
    globalThis.fetch = async (u) => {
      tried.push(u);
      return new Response('nope', { status: 404 });
    };
    const r404 = await fetchViaMirror(tar);
    check('镜像: 404 直接返回不重试', r404.status === 404 && tried.length === 1);
  } finally {
    globalThis.fetch = realFetch;
    configureMirror({});
  }
}

await testMirror();

/* ---------- 模块可导入性（防止改了导出忘了改引用） ---------- */

async function testModulesLoad() {
  const files = [
    '../src/api.js',
    '../src/bot.js',
    '../src/browser.js',
    '../src/config.js',
    '../src/events.js',
    '../src/gateway.js',
    '../src/groups.js',
    '../src/instance.js',
    '../src/levels.js',
    '../src/logger.js',
    '../src/markdown.js',
    '../src/message.js',
    '../src/outbound.js',
    '../src/paths.js',
    '../src/pipeline.js',
    '../src/roles.js',
    '../src/runtime.js',
    '../src/semver.js',
    '../src/mirror.js',
    '../src/storage/db.js',
    '../src/storage/schema.js',
    '../src/storage/index.js',
    '../src/session.js',
    '../src/token.js',
    '../src/updater.js',
    '../src/webhook.js',
    '../src/sign.js',
    '../src/tarball.js',
    '../src/services/index.js',
    '../src/services/base.js',
    '../src/services/health.js',
    '../src/services/cleanup.js',
    '../src/services/config-watch.js',
    '../src/services/restart.js',
    '../src/services/auto-update.js',
    '../src/services/plugin-watch.js',
    '../src/web/server.js',
    '../src/plugin/config.js',
    '../src/plugin/context.js',
    '../src/plugin/dashboard.js',
    '../src/plugin/deps.js',
    '../src/plugin/loader.js',
    '../src/plugin/market.js',
    '../src/plugin/protocol.js',
    '../src/plugin/subprocess.js',
  ];
  let bad = [];
  for (const f of files) {
    try {
      await import(f);
    } catch (e) {
      bad.push(`${f.replace('../src/', '')}: ${e.message.split('\n')[0]}`);
    }
  }
  check(
    `模块: ${files.length} 个源文件全部可导入`,
    bad.length === 0,
    bad.join('; ').slice(0, 160),
  );
}

await testModulesLoad();

/* ---------------- 目录指纹（供应链校验用） ---------------- */

async function testHashDir() {
  const { hashDir } = await import('../src/hashdir.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-hash-'));
  try {
    const mk = async (name, files) => {
      const d = path.join(tmp, name);
      for (const [rel, body] of Object.entries(files)) {
        const f = path.join(d, rel);
        await fs.mkdir(path.dirname(f), { recursive: true });
        await fs.writeFile(f, body);
      }
      return d;
    };

    const a = await mk('a', { 'index.js': 'export default 1\n', 'lib/x.js': 'x\n' });
    const b = await mk('b', { 'index.js': 'export default 1\n', 'lib/x.js': 'x\n' });
    check('目录指纹: 同样内容算出同样的值', (await hashDir(a)) === (await hashDir(b)));

    const c = await mk('c', { 'index.js': 'export default 2\n', 'lib/x.js': 'x\n' });
    check('目录指纹: 改一个字节就变', (await hashDir(a)) !== (await hashDir(c)));

    // Windows 上 autocrlf 检出是 CRLF，GitHub tarball 是 LF，两边必须算出一个值
    const d1 = await mk('d1', { 'index.js': 'a\nb\n' });
    const d2 = await mk('d2', { 'index.js': 'a\r\nb\r\n' });
    check('目录指纹: CRLF 与 LF 视为同一份', (await hashDir(d1)) === (await hashDir(d2)));

    // 依赖目录不该影响指纹：每台机器装出来的 node_modules 都不一样
    const e1 = await mk('e1', { 'index.js': 'y\n' });
    const e2 = await mk('e2', { 'index.js': 'y\n', 'node_modules/ms/index.js': 'ms\n' });
    check('目录指纹: 忽略 node_modules', (await hashDir(e1)) === (await hashDir(e2)));

    // 文件名也要进哈希，否则换个文件名能绕过
    const f1 = await mk('f1', { 'a.js': 'same\n' });
    const f2 = await mk('f2', { 'b.js': 'same\n' });
    check('目录指纹: 文件名参与计算', (await hashDir(f1)) !== (await hashDir(f2)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

await testHashDir();

/* ---------- AI 对话插件 ---------- */

/**
 * 用假 fetch 跑 ai-chat，不打真实 API。
 *
 * 为什么不打真的：跑 CI 不该花钱、也不该依赖网络和余额。
 * 而且真要测的是「我们的逻辑对不对」——上下文有没有攒、命令有没有生效、
 * 错误有没有翻译成人话，这些用一个可控的假响应就够了。
 */
async function testAiChat() {
  const { makeCtx, makeMsg, runCommand, runListeners } = await import('../src/plugin/testkit.js');

  /**
   * 插件代码在**另一个仓库**（qq-bot-roost-plugins），主仓库的 .gitignore
   * 排除了 plugins/。所以 CI 干净克隆时这里没有 ai-chat——直接 import
   * 会抛 ERR_MODULE_NOT_FOUND，把整个自检带崩（不是断言失败，是崩溃）。
   *
   * 本机装了才测，没装就明确跳过。这和 e2e 对示例插件的处理一致。
   */
  let plugin;
  try {
    plugin = (await import('../plugins/ai-chat/index.js')).default;
  } catch (e) {
    const missing = e?.code === 'ERR_MODULE_NOT_FOUND';
    skip(
      missing ? 'AI 对话: 插件未安装，跳过 33 项' : 'AI 对话: 插件加载失败，跳过 33 项',
      missing ? '（本机没装 ai-chat，CI 上正常）' : e.message,
    );
    return;
  }

  const realFetch = globalThis.fetch;
  /** 记录每次请求的 body，用来断言上下文有没有带上 */
  const calls = [];
  /** 下一次响应用这个；设为函数可以自定义 */
  let responder = null;

  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push({ url, body, headers: init?.headers });
    const custom = responder?.(body, calls.length);
    if (custom) return custom;

    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: `回声：${body.messages.at(-1)?.content ?? ''}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      text: async () => '',
    };
  };

  const base = { apiKey: 'sk-test', model: 'deepseek-flash' };

  /**
   * 发一句 `/ai 内容`，返回那条 msg（好断言 replies）。
   *
   * 对话入口是命令不是监听器了，所以不能再用 runListeners。
   * 统一走这个，免得每处都写一遍 content 拼装。
   */
  const ask = async (ctx, text, opts = {}) => {
    const r = await runCommand(plugin, 'ai', { content: `/ai ${text}`, ...opts, ctx });
    return r.msg;
  };

  try {
    /* ---- 基本对话：固定格式 /ai ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      const r = await runCommand(plugin, 'ai', { content: '/ai 你好', ctx });

      check('AI: /ai 能回', r.replies.length === 1, r.replies[0] ?? '无回复');
      check('AI: 回复内容来自模型', (r.replies[0] ?? '').includes('回声：你好'), r.replies[0] ?? '');
      check('AI: 请求带上了 Authorization', /^Bearer sk-test$/.test(calls[0]?.headers?.Authorization ?? ''), calls[0]?.headers?.Authorization ?? '');
      check('AI: 请求打到 /chat/completions', String(calls[0]?.url ?? '').endsWith('/chat/completions'), calls[0]?.url ?? '');
      check('AI: 没开流式', calls[0]?.body?.stream === false);
    }

    /* ---- 指令要剔除，AI 只看到问题本身 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      await runCommand(plugin, 'ai', { content: '/ai 什么是递归', ctx });

      const sent = calls[0]?.body?.messages?.at(-1)?.content ?? '';
      check('AI: 发给模型的是问题本身', sent === '什么是递归', JSON.stringify(sent));
      check('AI: 指令 /ai 被剔除', !String(sent).includes('/ai'), JSON.stringify(sent));
    }

    /* ---- 多词问题要完整保留 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      await runCommand(plugin, 'ai', { content: '/ai 用一句话  解释   什么是 递归', ctx });

      const sent = calls[0]?.body?.messages?.at(-1)?.content ?? '';
      check('AI: 多词问题完整保留', sent.includes('解释') && sent.includes('递归'), JSON.stringify(sent));
      check('AI: 多词问题里没有指令', !sent.startsWith('/ai'), JSON.stringify(sent));
    }

    /* ---- 不带内容时提示用法 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      const r = await runCommand(plugin, 'ai', { content: '/ai', ctx });

      check('AI: 光发 /ai 提示格式', (r.replies[0] ?? '').includes('/ai'), r.replies[0] ?? '无回复');
      check('AI: 光发 /ai 不发请求', calls.length === 0, `calls=${calls.length}`);
    }

    /* ---- 普通聊天不再触发（必须用 /ai） ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      const msg = makeMsg({ content: '随便聊聊', mentioned: true });
      await runListeners(plugin, msg, ctx);

      check('AI: 只 @ 不带 /ai 不回复', msg.replies.length === 0, `replies=${msg.replies.length}`);
      check('AI: 只 @ 不带 /ai 不发请求', calls.length === 0, `calls=${calls.length}`);
    }

    /* ---- 免 @ 窗口也不再触发 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      const msg = makeMsg({ content: '接着说', mentioned: false, sticky: true });
      await runListeners(plugin, msg, ctx);

      check('AI: 免 @ 窗口内也不会自动接话', msg.replies.length === 0, `replies=${msg.replies.length}`);
    }

    /* ---- 私聊也要用 /ai ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      const r = await runCommand(plugin, 'ai', {
        content: '/ai 私聊问一句',
        kind: 'c2c',
        userId: 'u9',
        ctx,
      });

      check('AI: 私聊用 /ai 能回', r.replies.length === 1, `replies=${r.replies.length}`);
    }

    /* ---- 上下文累积 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: { ...base, systemPrompt: '你是测试助手' } });

      const m1 = await ask(ctx, '我叫小明', { groupId: 'g-ctx' });
      await ask(ctx, '我叫什么', { groupId: 'g-ctx' });

      const second = calls[1]?.body?.messages ?? [];
      check('AI: 第二轮带上了上一轮', second.length >= 4, `messages=${second.length}`);
      check('AI: 历史里有第一句提问', second.some((m) => m.role === 'user' && m.content === '我叫小明'));
      check('AI: 历史里有第一句回答', second.some((m) => m.role === 'assistant'));
      check('AI: system 排在最前', second[0]?.role === 'system' && second[0]?.content === '你是测试助手', JSON.stringify(second[0] ?? {}));
    }

    /* ---- 会话之间不串台 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });

      await ask(ctx, 'A群的话', { groupId: 'g-a' });
      await ask(ctx, 'B群的话', { groupId: 'g-b' });

      const bReq = calls[1]?.body?.messages ?? [];
      check('AI: 两个群的上下文互不影响', !bReq.some((m) => m.content === 'A群的话'), JSON.stringify(bReq.map((m) => m.content)));
    }

    /* ---- 新会话清空 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });

      await ask(ctx, '记住这句', { groupId: 'g-r' });
      // runCommand 会自己造 msg，所以要用 content + groupId 传，不能传 msg 对象
      await runCommand(plugin, '新会话', { content: '/新会话', groupId: 'g-r', ctx }).catch(() => null);

      await ask(ctx, '还记得吗', { groupId: 'g-r' });
      const after = calls.at(-1)?.body?.messages ?? [];
      check('AI: /新会话 之后上下文清空', !after.some((m) => m.content === '记住这句'), JSON.stringify(after.map((m) => m.content)));
      check('AI: /新会话 之后模型还认得新问题', after.some((m) => m.content === '还记得吗'), JSON.stringify(after.map((m) => m.content)));
    }

    /* ---- 没配 Key ---- */

    {
      calls.length = 0;
      const ctx = makeCtx({ id: 'ai-chat', config: { ...base, apiKey: '' } });
      const msg = await ask(ctx, '在吗');

      check('AI: 没配 Key 时提示怎么配', (msg.replies[0] ?? '').includes('API Key'), msg.replies[0] ?? '无回复');
      check('AI: 没配 Key 时不发请求', calls.length === 0, `calls=${calls.length}`);
    }

    /* ---- 访问控制 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({
        id: 'ai-chat',
        config: { ...base, access: 'allowlist', allowList: ['g-yes'] },
      });

      const no = await ask(ctx, '不在名单', { groupId: 'g-no' });
      check('AI: 白名单外的群不回复', no.replies.length === 0 || !no.replies[0].includes('回声'), `replies=${JSON.stringify(no.replies)}`);

      const yes = await ask(ctx, '在名单里', { groupId: 'g-yes' });
      check('AI: 白名单内的群正常回', yes.replies.length === 1, `replies=${yes.replies.length}`);
    }

    /* ---- 错误翻译 ---- */

    {
      const cases = [
        [401, 'API Key'],
        [402, '余额'],
        [429, '限流'],
        [500, '服务商'],
      ];
      for (const [status, keyword] of cases) {
        const ctx = makeCtx({ id: 'ai-chat', config: base });
        responder = () => ({
          ok: false,
          status,
          text: async () => 'upstream says no',
          json: async () => ({}),
        });
        const msg = await ask(ctx, '试试');
        const reply = msg.replies[0] ?? '';
        check(`AI: HTTP ${status} 翻译成人话`, reply.includes(keyword), reply.slice(0, 60));
      }
      responder = null;
    }

    /* ---- 空回复 ---- */

    {
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      responder = () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }),
        text: async () => '',
      });
      const msg = await ask(ctx, '空回复');
      check('AI: 模型返回空内容时报错而不是发空白', (msg.replies[0] ?? '').includes('空内容'), msg.replies[0] ?? '无回复');
      responder = null;
    }

    /* ---- 内容审核 ---- */

    {
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      responder = () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
        text: async () => '',
      });
      const msg = await ask(ctx, '敏感内容');
      check('AI: 被内容审核拦下时说清楚', (msg.replies[0] ?? '').includes('审核'), msg.replies[0] ?? '无回复');
      responder = null;
    }

    /* ---- 并发保护 ---- */

    {
      const ctx = makeCtx({ id: 'ai-chat', config: base });

      let release;
      const gate = new Promise((r) => (release = r));
      responder = () => gate.then(() => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '慢回答' }, finish_reason: 'stop' }] }),
        text: async () => '',
      }));

      const first = ask(ctx, '第一个问题', { groupId: 'g-busy' });
      // 让第一个请求真正进到 await fetch 里
      await new Promise((r) => setTimeout(r, 20));

      const m2 = await ask(ctx, '第二个问题', { groupId: 'g-busy' });
      check('AI: 同会话正在生成时提示等待', (m2.replies[0] ?? '').includes('稍等'), m2.replies[0] ?? '无回复');

      release();
      await first;
      responder = null;
    }

    /* ---- 命令 ---- */

    {
      const ctx = makeCtx({ id: 'ai-chat', config: { ...base, model: 'deepseek-flash' } });

      const r1 = await runCommand(plugin, '模型', { content: '/模型', ctx });
      check('AI: /模型 显示当前模型', (r1.replies[0] ?? '').includes('deepseek-flash'), r1.replies[0] ?? '无回复');

      const r2 = await runCommand(plugin, 'AI帮助', { content: '/AI帮助', ctx });
      check('AI: /AI帮助 有内容', (r2.replies[0] ?? '').length > 20, `长度=${(r2.replies[0] ?? '').length}`);

      const r3 = await runCommand(plugin, '对话状态', { content: '/对话状态', ctx });
      check('AI: /对话状态 能看会话', (r3.replies[0] ?? '').includes('模型'), r3.replies[0] ?? '无回复');
    }

    /* ---- 模型名校验 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      const bad = await runCommand(plugin, '模型', { content: '/模型 ../../etc/passwd', ctx });
      check(
        'AI: 非法模型名被拒',
        (bad.replies[0] ?? '').includes('不对'),
        bad.replies[0] ?? '无回复',
      );
    }

    /* ---- 命令不当成聊天内容 ---- */

    {
      calls.length = 0;
      responder = null;
      const ctx = makeCtx({ id: 'ai-chat', config: base });
      const msg = makeMsg({ content: '/新会话', mentioned: true });
      await runListeners(plugin, msg, ctx);
      check('AI: 命令不会被当成聊天发给模型', calls.length === 0, `calls=${calls.length}`);
    }

    /* ---- DeepSeek 思考模式参数 ---- */

    /**
     * 这几条防的是「参数格式不对，真实 API 直接 400」。
     *
     * 关键事实（查官方文档确认的）：
     *   · DeepSeek 的思考模式**默认是开的、强度默认 high**，不显式关掉
     *     就会又慢又贵，而且思考 token 按输出价计费
     *   · `thinking` 是 DeepSeek 独有参数，别家不认，塞过去可能 400
     *   · 思考模式下 temperature 不生效（不报错，但被忽略）
     */
    {
      const ds = { ...base, baseUrl: 'https://api.deepseek.com' };

      calls.length = 0;
      responder = null;
      const ctx1 = makeCtx({ id: 'ai-chat', config: ds });
      await ask(ctx1, '你好');
      check(
        'AI: 默认显式关闭思考模式',
        calls[0]?.body?.thinking?.type === 'disabled',
        JSON.stringify(calls[0]?.body?.thinking),
      );
      check(
        'AI: 关思考时不传 reasoning_effort',
        calls[0]?.body?.reasoning_effort === undefined,
        String(calls[0]?.body?.reasoning_effort),
      );
      check(
        'AI: 关思考时正常传 temperature',
        calls[0]?.body?.temperature === 1,
        String(calls[0]?.body?.temperature),
      );

      calls.length = 0;
      const ctx2 = makeCtx({ id: 'ai-chat', config: { ...ds, thinking: true, reasoningEffort: 'max' } });
      await ask(ctx2, '难题');
      check(
        'AI: 开思考时传 enabled',
        calls[0]?.body?.thinking?.type === 'enabled',
        JSON.stringify(calls[0]?.body?.thinking),
      );
      check(
        'AI: 开思考时传思考强度',
        calls[0]?.body?.reasoning_effort === 'max',
        String(calls[0]?.body?.reasoning_effort),
      );
      check(
        'AI: 开思考时不传 temperature（传了也不生效）',
        calls[0]?.body?.temperature === undefined,
        String(calls[0]?.body?.temperature),
      );

      calls.length = 0;
      const ctx3 = makeCtx({
        id: 'ai-chat',
        config: { ...base, baseUrl: 'https://api.moonshot.cn/v1', thinking: true },
      });
      await ask(ctx3, '你好');
      check(
        'AI: 非 DeepSeek 服务商不传 thinking',
        calls[0]?.body?.thinking === undefined,
        JSON.stringify(calls[0]?.body?.thinking),
      );
    }

    /* ---- 默认人设 ---- */

    {
      calls.length = 0;
      responder = null;
      /**
       * 要用插件声明的默认配置。
       *
       * testkit 的 makeCtx 只认传进去的 config，不会去合并插件的默认值
       * （真实运行时 PluginConfig 会合）。所以这里手动带上 systemPrompt 的默认值。
       */
      const defaults = plugin.config ?? {};
      const sysDefault = defaults.systemPrompt?.default ?? '';
      const ctx = makeCtx({ id: 'ai-chat', config: { apiKey: 'sk-test', systemPrompt: sysDefault } });
      await ask(ctx, '你好');
      const sys = calls[0]?.body?.messages?.[0];
      check(
        'AI: 默认人设非空',
        sys?.role === 'system' && String(sys.content).length > 20,
        JSON.stringify(String(sys?.content ?? '').slice(0, 40)),
      );
      check(
        'AI: 默认人设提到可以 Markdown',
        /markdown/i.test(sys?.content ?? ''),
        JSON.stringify(String(sys?.content ?? '').slice(0, 60)),
      );
      check(
        'AI: 默认人设要求简短',
        /简短|两三句/.test(sys?.content ?? ''),
        JSON.stringify(String(sys?.content ?? '').slice(0, 60)),
      );
    }

    /* ---- Markdown 发送 ---- */

    {
      const ctx = makeCtx({ id: 'ai-chat', config: { ...base, markdown: true } });
      const msg = await ask(ctx, '你好');
      check('AI: 开 markdown 时走 markdown 消息', msg.markdowns?.length === 1, JSON.stringify(msg.replies));
      check(
        'AI: markdown 内容就是模型回复',
        String(msg.markdowns?.[0]?.content ?? '').includes('回声：你好'),
        JSON.stringify(msg.markdowns?.[0] ?? null),
      );
    }

    {
      const ctx = makeCtx({ id: 'ai-chat', config: { ...base, markdown: false } });
      const msg = await ask(ctx, '你好');
      check('AI: 关 markdown 时走纯文本', (msg.markdowns?.length ?? 0) === 0 && msg.replies.length === 1, JSON.stringify(msg.replies));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

await testAiChat();

/* ---------- 更新器：更新了但没重启 ---------- */

/**
 * 这一组防的是「更新完没重启，面板显示旧版本、检查更新却说已是最新」。
 *
 * 真机上的表现：版本号闪一下新版又刷回旧版，用户以为更新坏了反复点。
 * 根因是版本号有两个来源（启动时快照 vs 现读文件），对不上。
 *
 * 这里不打网络：`checkUpdate` 会真去请求 GitHub，测试里只用
 * `needsRestart` 那个判断——它是纯本地逻辑，靠 package.json 的 mtime
 * 和进程启动时间比较。
 */
async function testUpdaterRestartHint() {
  const fsp = await import('node:fs/promises');
  const pkg = path.resolve(import.meta.dirname, '..', 'package.json');
  const orig = await fsp.stat(pkg);
  const m = await import('../src/updater.js');

  try {
    // 正常情况：package.json 比进程启动早，不需要重启
    const r1 = await m.checkUpdate();
    check('更新: 正常时不提示重启', r1.needsRestart === false, `needsRestart=${r1.needsRestart}`);
    check('更新: 返回值带 current', typeof r1.current === 'string' && r1.current.length > 0, r1.current);

    // 模拟「刚更新完、还没重启」：把 package.json 的 mtime 拨到未来
    const future = new Date(Date.now() + 60_000);
    await fsp.utimes(pkg, future, future);
    const r2 = await m.checkUpdate();
    check('更新: 文件比进程新时提示重启', r2.needsRestart === true, `needsRestart=${r2.needsRestart}`);
    check(
      '更新: 已是最新但需重启时 hasUpdate 为 false',
      r2.hasUpdate === false,
      `hasUpdate=${r2.hasUpdate}`,
    );
  } finally {
    // 必须还原：改坏 mtime 会让后面的「需要重启」判断全部错乱
    await fsp.utimes(pkg, orig.atime, orig.mtime);
  }
}

await testUpdaterRestartHint();

/* ---------- 汇总 ---------- */
await cleanQuotaLedger();

const fail = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const passed = results.length - fail.length - skipped.length;
// 跳过的不算进分母：分母是「真正跑过的项」，否则数字会虚高
console.log(
  `\n${passed}/${results.length - skipped.length} 通过` +
    (skipped.length ? `（${skipped.length} 项跳过）` : ''),
);
if (skipped.length) {
  console.log('跳过项: ' + skipped.map((s) => s.name).join('、'));
}
if (fail.length) {
  console.log('失败项: ' + fail.map((f) => f.name).join('、'));
  process.exitCode = 1;
}
