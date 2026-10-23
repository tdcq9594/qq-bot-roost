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
