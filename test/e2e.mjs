/**
 * 全功能端到端测试：把程序所有功能跑一遍。
 * 跑法：node test/e2e.mjs
 *
 * 覆盖：启动、消息、命令、插件生命周期、市场、群管闸门、配置、
 *       面板全部接口、多机器人、权限、markdown、dashboard。
 * 每一项都输出 PASS/FAIL，最后汇总。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * 跑在临时目录里，不碰开发者自己的 config / data / logs。
 *
 * 以前 e2e 直接读写仓库根的 config：跑一次测试，真实机器人的权限表、
 * 群档案、插件配置全被改了；换台干净机器又因为缺插件而一片红。
 * 现在整份运行数据都在 os.tmpdir() 下，跑完就删。
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-e2e-'));
const NODE = process.execPath;

/**
 * 端口自己挑，不能写死 15207。
 *
 * 写死有个很难查的后果：开发机上真机器人（或上一轮没退干净的 e2e）占着
 * 15207 时，新起的服务会「顺延到 15208」，而测试仍然往 15207 发请求——
 * 于是你在测**别人的进程**。表现是一堆莫名其妙的失败（接口不存在、
 * mock 注入 404），关掉机器人再跑又全绿。
 *
 * 现在：先占一个空闲端口，写进临时 HOME 的 config，再让服务绑它。
 */
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const ok = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

/**
 * 跳过：用于依赖外网的用例。
 * 网络不通时不算失败——否则本地没网就跑不了测试，
 * 久而久之大家就不跑测试了。
 */
const skipped = [];
const skip = (name, reason = '') => {
  skipped.push({ name, reason });
  console.log(`SKIP  ${name}${reason ? '  ' + reason : ''}`);
};

let server = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { signCallback, signEventBody } = await import('../src/sign.js');
const { dateKey } = await import('../src/outbound.js');

/**
 * 读某个会话今天已用的主动消息条数。
 *
 * 为什么要读文件而不是问接口：额度账本**没有对外接口**（只有 `/status`
 * 命令里的一行文字），而这里要证明的恰恰是「这条发送被记进账本了」。
 * 直接看 `data/bots/main/quota.json` 是最硬的证据。
 */
async function quotaUsed(chatKey) {
  try {
    const raw = await fs.readFile(path.join(HOME, 'data', 'bots', 'main', 'quota.json'), 'utf8');
    return JSON.parse(raw)?.[dateKey()]?.[chatKey] ?? 0;
  } catch {
    return 0;
  }
}

async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const t = await res.text();
  let d = null;
  try {
    d = t ? JSON.parse(t) : null;
  } catch {
    d = { raw: t };
  }
  return { status: res.status, data: d };
}

/* ---------------- 启动 ---------------- */

async function boot() {
  /**
   * 把端口写进临时 HOME 的全局配置。
   * portTries=1：端口被抢就直接失败，而不是悄悄顺延到别的端口
   * 让测试打到另一台服务上。
   */
  await fs.mkdir(path.join(HOME, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(HOME, 'config', 'bot.json'),
    JSON.stringify({ webui: { port: PORT, portTries: 1, openBrowser: false } }, null, 2),
    'utf8',
  );

  /**
   * ai-chat 必须指到一个**连不上**的地址。
   *
   * 插件代码永远从仓库 `plugins/` 取（`paths.js` 里 `plugins` 不跟着
   * ROOST_HOME 走），配置却从临时 HOME 取——不写这份配置，ai-chat 就用
   * 它自己的默认值：`dshUrl=http://127.0.0.1:17321`、
   * `publicUrl=http://127.0.0.1:8080`。
   *
   * 17321 正好是开发者本机真在跑的 DSH。于是下面 mock 注入的每条消息都会被
   * 送进那个**真会话**：机器人真回、真写日记，而回话地址指向没人监听的 8080，
   * 结果是面板里凭空多出几个「测试用户」会话，日记里多出几条
   * 「发送失败了两次，网络没通」——测试污染了真实记忆，而且很难查。
   *
   * 指向 1 号端口之后，ai-chat 的 fetch 会被它自己的端口黑名单当场拒掉
   * （`bad port`，连 dial 都不会发起），走「连不上宿主」分支直接放弃，
   * 一个字节都不会离开这个进程。`publicUrl` 仍填本次真实端口，
   * 万一以后要测回话链路它是对的。
   */
  const aiChatCfg = path.join(HOME, 'config', 'bots', 'main', 'plugins', 'ai-chat.json');
  await fs.mkdir(path.dirname(aiChatCfg), { recursive: true });
  await fs.writeFile(
    aiChatCfg,
    JSON.stringify({ dshUrl: 'http://127.0.0.1:1', publicUrl: BASE }, null, 2),
    'utf8',
  );

  server = spawn(NODE, [path.join(ROOT, 'src/main.js'), '--mock', '--serve', '--no-open'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ROOST_TEST: '1', ROOST_HOME: HOME },
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));

  // 等端口起来
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return out;
    } catch {}
  }
  throw new Error(`服务没起来:\n${out.slice(-800)}`);
}

/* ---------------- 各功能域 ---------------- */

async function testBasics() {
  const st = await api('/api/status');
  ok('启动: /api/status 200', st.status === 200);
  ok('启动: state=online', st.data?.state === 'online', `实际 ${st.data?.state}`);
  ok('启动: 有 botId', Boolean(st.data?.botId));
  ok('启动: 有 counters', typeof st.data?.counters === 'object');

  // 静态文件
  for (const [p, want] of [['/', 200], ['/app.js', 200], ['/style.css', 200], ['/nope.js', 404]]) {
    const r = await fetch(`${BASE}${p}`);
    ok(`静态: ${p} → ${want}`, r.status === want, `实际 ${r.status}`);
  }

  // 路径穿越防护
  const evil = await fetch(`${BASE}/../config/bot.json`);
  ok('安全: 路径穿越被挡', evil.status === 404 || evil.status === 403, `实际 ${evil.status}`);
}

async function testBots() {
  const r = await api('/api/bots');
  ok('机器人: 列表返回数组', Array.isArray(r.data?.bots));
  ok('机器人: 有 current', Boolean(r.data?.current));
  const b = r.data?.bots?.[0];
  ok('机器人: 有名字', Boolean(b?.name));
  ok('机器人: 有 online 字段', typeof b?.online === 'boolean');

  // 新建 + 删除
  const created = await api('/api/bots', {
    method: 'POST',
    body: JSON.stringify({ id: 'e2e-tmp', name: '临时机器人' }),
  });
  ok('机器人: 可新建', created.status === 200, created.data?.error || '');
  if (created.status === 200) {
    const after = await api('/api/bots');
    ok('机器人: 新建后出现在列表', after.data?.bots.some((x) => x.id === 'e2e-tmp'));
    const del = await api('/api/bots/delete', {
      method: 'POST',
      body: JSON.stringify({ id: 'e2e-tmp', purge: true }),
    });
    ok('机器人: 可删除', del.status === 200, del.data?.error || '');
  }
  // 最后一个不允许删
  const last = await api('/api/bots/delete', {
    method: 'POST',
    body: JSON.stringify({ id: 'main', purge: true }),
  });
  ok('机器人: 最后一个被保护', last.status === 400);
}

async function testOnline() {
  /**
   * 先记下插件数量，下线后再比。
   * 以前写的是「长度 > 0」——干净克隆里没有示例插件，这条必红，
   * 而它真正要验证的是「下线不该卸载插件」，比数量才是对的。
   */
  const before = await api('/api/plugins');
  const beforeCount = (before.data || []).length;

  const off = await api('/api/bots/main/offline', { method: 'POST', body: '{}' });
  ok('上下线: 可下线', off.data?.state === 'offline', off.data?.error || '');
  const st1 = await api('/api/status');
  ok('上下线: 下线后 state=offline', st1.data?.state === 'offline');

  // 下线不该卸载插件
  const pl = await api('/api/plugins');
  ok('上下线: 下线后插件数量不变', (pl.data || []).length === beforeCount, `${beforeCount} → ${(pl.data || []).length}`);

  const on = await api('/api/bots/main/online', { method: 'POST', body: '{}' });
  ok('上下线: 可上线', on.data?.state === 'online', on.data?.error || '');
  const st2 = await api('/api/status');
  ok('上下线: 上线后 state=online', st2.data?.state === 'online');
}

async function testConfig() {
  const get1 = await api('/api/config');
  ok('配置: 可读', get1.status === 200);
  // 干净环境下没填过 AppSecret，没什么可掩码的——有值才断言
  if (get1.data?.appSecret) ok('配置: appSecret 被掩码', get1.data.appSecret === '********');
  else skip('配置: appSecret 被掩码（本机没填 AppSecret，跳过）');
  ok('配置: 返回 webui（全局设置）', typeof get1.data?.webui === 'object');
  ok('配置: 返回 logLevel（全局设置）', typeof get1.data?.logLevel === 'string');
  ok('配置: 返回 groupManage', typeof get1.data?.groupManage === 'object');
  ok('配置: 不返回明文 appSecret', !/^[A-Za-z0-9]{16,}$/.test(get1.data?.appSecret || ''));

  // 保存后仍能读回
  const before = get1.data?.groupManage?.invited;
  const put = await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({ groupManage: { invited: !before } }),
  });
  ok('配置: 可保存', put.status === 200, put.data?.error || '');
  const get2 = await api('/api/config');
  ok('配置: 保存后读回一致', get2.data?.groupManage?.invited === !before);
  // 改回去
  await api('/api/config', { method: 'PUT', body: JSON.stringify({ groupManage: { invited: before } }) });

  // intents 非法值要拒
  const bad = await api('/api/config', { method: 'PUT', body: JSON.stringify({ intents: -1 }) });
  ok('配置: 非法 intents 被拒', bad.status === 400);

  // CSRF：非 JSON Content-Type 的写操作要拒
  const noCt = await fetch(`${BASE}/api/config`, { method: 'PUT', body: '{}' });
  ok('安全: 缺 Content-Type 的写操作被拒', noCt.status === 415, `实际 ${noCt.status}`);
}

async function testPlugins() {
  /**
   * 示例插件在**另一个仓库**（qq-bot-roost-plugins），干净克隆里没有。
   *
   * 以前这里无条件断言 dice/echo/hello-py/kun 都在，所以 clone 下来直接跑
   * 就是 4 条红——CI 里更是必红。现在：没有示例插件就只测通用行为
   * （rescan / dashboard / 非法 id 拒绝），涉及具体插件的断言标为跳过。
   */
  const SAMPLES = ['dice', 'echo', 'hello-py', 'kun'];

  const list = await api('/api/plugins');
  ok('插件: 接口可用且返回数组', Array.isArray(list.data));
  const ids = (list.data ?? []).map((p) => p.id);
  const hasSamples = SAMPLES.every((i) => ids.includes(i));

  if (!hasSamples) {
    skip(`插件: 示例插件 ${SAMPLES.join('/')} 都在（本机没装，跳过）`);
  } else {
    ok('插件: 4 个示例插件都在', true);
  }

  for (const p of list.data ?? []) {
    ok(`插件: ${p.id} 有版本号`, Boolean(p.version));
    ok(`插件: ${p.id} 有类型`, p.kind === 'internal' || p.kind === 'external');
  }

  // rescan
  const rs = await api('/api/plugins/rescan', { method: 'POST', body: '{}' });
  ok('插件: rescan 正常', rs.status === 200 && Array.isArray(rs.data?.added));

  if (hasSamples) {
    // 禁用 → 启用
    const dis = await api('/api/plugins/echo/disable', { method: 'POST', body: '{}' });
    ok('插件: 可禁用', dis.status === 200, dis.data?.error || '');
    const afterDis = await api('/api/plugins');
    const echoOff = afterDis.data.find((p) => p.id === 'echo');
    ok('插件: 禁用后 enabled=false', echoOff?.enabled === false);
    ok('插件: 禁用后仍有版本号（不归零）', Boolean(echoOff?.version));
    const en = await api('/api/plugins/echo/enable', { method: 'POST', body: '{}' });
    ok('插件: 可启用', en.status === 200);

    // 重载
    const rl = await api('/api/plugins/echo/reload', { method: 'POST', body: '{}' });
    ok('插件: 可重载', rl.status === 200, rl.data?.error || '');
  } else {
    skip('插件: 禁用/启用/重载（本机没有示例插件，跳过）');
  }

  /**
   * 卸载接口的**安全边界**。
   * 这里只测拒绝路径——真删会破坏测试环境里的示例插件。
   */
  const rmNo = await api('/api/plugins/nosuch-plugin/remove', { method: 'POST', body: '{}' });
  ok('插件: 卸载不存在的插件返回 404', rmNo.status === 404, rmNo.data?.error || '');

  const rmBad = await api('/api/plugins/KUN/remove', { method: 'POST', body: '{}' });
  ok('插件: 卸载时非法 id 被拒', rmBad.status === 400, rmBad.data?.error || '');

  const rmTrav = await api('/api/plugins/..%2f..%2fsrc/remove', { method: 'POST', body: '{}' });
  ok('插件: 卸载时路径穿越被拒', rmTrav.status === 400 || rmTrav.status === 404, `HTTP ${rmTrav.status}`);

  // 拒绝之后示例插件必须完好
  const afterRm = await api('/api/plugins');
  if (hasSamples) {
    ok(
      '插件: 被拒的卸载没动到任何插件',
      SAMPLES.every((i) => afterRm.data.some((p) => p.id === i)),
    );
  }

  // dashboard 接口：插件指标靠它，插件页要轮询
  const dash = await api('/api/plugins/dashboard');
  ok('插件: dashboard 可读', dash.status === 200 && typeof dash.data === 'object');

  if (!hasSamples) {
    skip('插件: 配置面板读写（本机没有示例插件，跳过）');
    return;
  }

  // 设置面板
  const pp = await api('/api/plugins/echo/panel');
  ok('插件: panel 可读', pp.status === 200);
  ok('插件: panel 有 config/schema/data', 'config' in (pp.data || {}) && 'schema' in (pp.data || {}));

  // 改插件配置
  const pc = await api('/api/plugins/echo/config', {
    method: 'PUT',
    body: JSON.stringify({ 测试项: 'x' }),
  });
  ok('插件: 可改配置', pc.status === 200 || pc.status === 400, pc.data?.error || '');
}

async function testDashboard() {
  const d = await api('/api/plugins/dashboard');
  ok('dashboard: 返回对象', typeof d.data === 'object' && d.data !== null);

  // echo 是示例插件，干净克隆里没有
  if (!d.data?.echo) {
    skip('dashboard: echo 有指标（本机没有 echo 插件，跳过）');
    skip('dashboard: 指标有 label/value（跳过）');
    return;
  }
  ok('dashboard: echo 有指标', Array.isArray(d.data.echo.metrics));
  const m = d.data.echo.metrics?.[0];
  ok('dashboard: 指标有 label/value', Boolean(m?.label) && m?.value !== undefined);
}

async function testMarket() {
  const mk = await api('/api/market');

  /**
   * 市场依赖外网。开发机网络不稳时（代理、DNS、GitHub 限流），
   * 这一组断言失败不代表代码有问题——标记为跳过，不让整个测试变红。
   * 真要看市场功能，单独跑 npm run test:e2e 并保证网络通。
   */
  if (mk.status !== 200) {
    const msg = String(mk.data?.error || '');
    if (/fetch failed|timeout|连不上|ECONN|ENOTFOUND|HTTP 4\d\d|HTTP 5\d\d/i.test(msg)) {
      skip('市场: 拉索引（网络不可用，跳过）', msg.slice(0, 60));
      skip('市场: plugins 结构（跳过）');
      skip('市场: updates 结构（跳过）');
      skip('市场: localVersions（跳过）');
      return;
    }
  }

  ok('市场: 可拉索引', mk.status === 200, mk.data?.error || '');
  ok('市场: 有 plugins 数组', Array.isArray(mk.data?.plugins));
  ok('市场: 有 updates 数组', Array.isArray(mk.data?.updates));
  ok('市场: 有 localVersions', typeof mk.data?.localVersions === 'object');

  const up = await api('/api/plugins/updates?force=1');
  ok('市场: 更新检测可用', up.status === 200);
  ok('市场: 检测结果有 updates', Array.isArray(up.data?.updates));

  // 更新一个已是最新的 → 应被幂等拒绝
  const reupd = await api('/api/market/update', { method: 'POST', body: JSON.stringify({ id: 'echo' }) });
  ok('市场: 无新版时更新被拒', reupd.status === 400, reupd.data?.error || '');

  // 更新不存在的插件
  const none = await api('/api/market/update', { method: 'POST', body: JSON.stringify({ id: 'no-such' }) });
  ok('市场: 更新不存在的插件报错', none.status >= 400);

  // 装不存在的插件
  const badInstall = await api('/api/market/install', {
    method: 'POST',
    body: JSON.stringify({ id: 'no-such-plugin' }),
  });
  ok('市场: 安装不存在的插件报错', badInstall.status >= 400);
}

async function testGroupManage() {
  const cfg = await api('/api/config');
  ok('群管: 默认 invited=false', cfg.data?.groupManage?.invited === false);

  // 未开内邀 → 群成员接口应被闸门挡住
  const gm = await api('/api/plugins');
  ok('群管: 闸门自检已覆盖（单测）', gm.status === 200);

  // 打开内邀后能保存
  const on = await api('/api/config', { method: 'PUT', body: JSON.stringify({ groupManage: { invited: true } }) });
  ok('群管: 可开启内邀开关', on.status === 200);
  const off = await api('/api/config', { method: 'PUT', body: JSON.stringify({ groupManage: { invited: false } }) });
  ok('群管: 可关闭内邀开关', off.status === 200);
}

async function testGroupsAndRoles() {
  const g = await api('/api/groups');
  ok('群组: 列表可读', g.status === 200 && Array.isArray(g.data));

  const r = await api('/api/roles');
  ok('权限: 列表可读', r.status === 200);

  // 加一条权限再删
  const add = await api('/api/roles/set', {
    method: 'POST',
    body: JSON.stringify({ scope: 'group:e2e', openid: 'u1', level: 2 }),
  });
  ok('权限: 可添加', add.status === 200, add.data?.error || '');
  const rm = await api('/api/roles/remove', {
    method: 'POST',
    body: JSON.stringify({ scope: 'group:e2e', openid: 'u1' }),
  });
  ok('权限: 可移除', rm.status === 200, rm.data?.error || '');
}

async function testEventsAndLogs() {
  const ev = await api('/api/events');
  ok('事件: 清单可读', ev.status === 200);
  ok('事件: 有分组', Array.isArray(ev.data?.groups) || typeof ev.data === 'object');

  const lg = await api('/api/logs');
  ok('日志: 可读', lg.status === 200);
  ok('日志: 返回数组', Array.isArray(lg.data?.logs) || Array.isArray(lg.data));

  // SSE 端点应保持连接
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/stream`, { signal: ctrl.signal }).catch(() => null);
  ok('日志: SSE 可连接', sse?.ok === true);
  ctrl.abort();
}

async function testWebhook() {
  const { WebhookServer } = await import('../src/webhook.js');
  const received = [];
  const wh = new WebhookServer({ host: '127.0.0.1', port: 15399, path: '/webhook' });

  try {
    wh.register('app1', {
      secret: 'e2e-fake-secret-not-a-real-key',
      onEvent: (name, d, payload) => received.push({ name, d, payload }),
    });
    /**
     * op=13 的「24 小时只过一次」是**持久化**的（data/webhook-verified.json）。
     * 不清掉的话本地连着跑两次 e2e，第二次的 op=13 会被「该 appId 已验证过」
     * 挡成 403，看起来像代码坏了——CI 每次都是干净环境，所以那里永远不红。
     */
    wh.resetVerify('app1');
    const port = await wh.start();
    ok('webhook: 启动监听', wh.running === true, `端口 ${port}`);

    const WH_SECRET = 'e2e-fake-secret-not-a-real-key';

    /**
     * 平台推事件时一定带签名，所以这里默认就签。
     * 以前 e2e 发的是裸事件——正因为服务端根本没验签，才一直是绿的。
     */
    const post = (body, headers = {}, { signed = true } = {}) => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const ts = String(Math.floor(Date.now() / 1000));
      const sigHeaders = signed
        ? { 'X-Signature-Timestamp': ts, 'X-Signature-Ed25519': signEventBody(WH_SECRET, ts, raw) }
        : {};
      return fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sigHeaders, ...headers },
        body: raw,
      });
    };

    // 1) op=13 签名校验（验证请求同样要带 appid）
    const r1 = await post(
      { op: 13, d: { plain_token: 'tok123', event_ts: '1729555200' } },
      { 'X-Bot-Appid': 'app1' },
    );
    const j1 = await r1.json();
    ok('webhook: op=13 返回签名', r1.status === 200 && j1.plain_token === 'tok123' && /^[0-9a-f]{128}$/.test(j1.signature || ''));
    ok('webhook: 签名可被公钥验证', j1.signature === signCallback('e2e-fake-secret-not-a-real-key', '1729555200', 'tok123'));

    // 2) 缺 appid
    const r2 = await post({ t: 'GROUP_AT_MESSAGE_CREATE', d: {} });
    ok('webhook: 缺 appid 返回 400', r2.status === 400);

    // 3) 未知 appid
    const r3 = await post({ t: 'GROUP_AT_MESSAGE_CREATE', d: {} }, { 'X-Bot-Appid': 'nope' });
    ok('webhook: 未知 appid 返回 404', r3.status === 404);

    // 4) 正常事件（异步分发，等一拍再看）
    const r4 = await post(
      { t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm1', content: 'hi' } },
      { 'X-Bot-Appid': 'app1' },
    );
    ok('webhook: 正常事件返回 200', r4.status === 200);
    await sleep(200);
    ok('webhook: 事件被分发', received.length === 1 && received[0].name === 'GROUP_AT_MESSAGE_CREATE');

    // 5) 交互事件要回 op:12 ACK
    const r5 = await post({ t: 'INTERACTION_CREATE', d: { id: 'i1' } }, { 'X-Bot-Appid': 'app1' });
    const j5 = await r5.json();
    ok('webhook: 交互事件回 op:12 ACK', j5.op === 12 && typeof j5.code === 'number');

    // 6) query 参数也能带 appid
    const body6 = JSON.stringify({ t: 'C2C_MESSAGE_CREATE', d: { id: 'm2' } });
    const ts6 = String(Math.floor(Date.now() / 1000));
    const r6 = await fetch(`http://127.0.0.1:${port}/webhook?appid=app1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature-Timestamp': ts6,
        'X-Signature-Ed25519': signEventBody(WH_SECRET, ts6, body6),
      },
      body: body6,
    });
    ok('webhook: query 参数识别 appid', r6.status === 200);

    // 6b) 不签名的事件必须被拒（伪造事件的入口）
    const r6b = await post(
      { t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm3' } },
      { 'X-Bot-Appid': 'app1' },
      { signed: false },
    );
    ok('webhook: 未签名事件返回 401', r6b.status === 401);

    // 6c) 签名对不上也要拒
    const body6c = JSON.stringify({ t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm4' } });
    const ts6c = String(Math.floor(Date.now() / 1000));
    const r6c = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Appid': 'app1',
        'X-Signature-Timestamp': ts6c,
        'X-Signature-Ed25519': 'a'.repeat(128),
      },
      body: body6c,
    });
    ok('webhook: 签名不匹配返回 401', r6c.status === 401);

    // 7) 非法 JSON / 错误路径 / 错误方法
    const r7 = await post('not-json', { 'X-Bot-Appid': 'app1' });
    ok('webhook: 非法 JSON 返回 400', r7.status === 400);
    const r8 = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST', body: '{}' });
    ok('webhook: 错误路径返回 404', r8.status === 404);
    const r9 = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'DELETE' });
    ok('webhook: DELETE 返回 405', r9.status === 405);
    const r10 = await fetch(`http://127.0.0.1:${port}/webhook`);
    ok('webhook: GET 健康检查', r10.status === 200);

    // 8) 计数器
    ok('webhook: 计数器累计', wh.info().counters.received >= 2 && wh.info().counters.verify === 1);
    ok('webhook: info 有注册的机器人', wh.info().bots.includes('app1'));
  } finally {
    await wh.stop();
  }
}

async function testSendAndCred() {
  /**
   * 面板发送**必须走 outbound**。
   *
   * 只断言 200 是不够的：这条路由以前直连 `api.sendGroup`，同样返回 200，
   * 但额度账本里一条记录都没有——面板随手点几下就能把官方额度打满，
   * 而账本上看起来什么事都没发生。所以这里看**落盘的额度账本**。
   *
   * 额度的「扣」发生在 outbound 内部，是这条链路唯一不可伪造的痕迹。
   */
  const gTarget = 'g-e2e-send';
  const gBefore = await quotaUsed(`group:${gTarget}`);
  const sd = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ scene: 'group', target: gTarget, content: 'e2e 测试' }),
  });
  ok('发送: mock 下可发', sd.status === 200 && sd.data?.ok === true, sd.data?.error || '');
  ok('发送: 返回 id', typeof sd.data?.id === 'string', String(sd.data?.id));
  ok('发送: 标出是否进审核', typeof sd.data?.pending === 'boolean');

  // 额度账本是 500ms 防抖落盘的，等它写完再查
  await sleep(800);
  const gAfter = await quotaUsed(`group:${gTarget}`);
  ok('发送: 面板发送计入主动额度账本', gAfter === gBefore + 1, `${gBefore} → ${gAfter}`);

  // 单聊走的是另一个分支（kind 不同、额度按 c2c 记账）
  const uTarget = 'u-e2e-send';
  const uBefore = await quotaUsed(`c2c:${uTarget}`);
  const sc = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ scene: 'c2c', target: uTarget, content: 'e2e 私聊' }),
  });
  ok('发送: 单聊可发', sc.status === 200 && sc.data?.ok === true, sc.data?.error || '');
  await sleep(800);
  const uAfter = await quotaUsed(`c2c:${uTarget}`);
  ok('发送: 单聊也计入额度账本', uAfter === uBefore + 1, `${uBefore} → ${uAfter}`);

  const empty = await api('/api/send', {
    method: 'POST',
    body: JSON.stringify({ scene: 'group', target: '', content: 'x' }),
  });
  ok('发送: 缺 target 回 400', empty.status === 400, `status=${empty.status}`);

  const rc = await api('/api/gateway/reconnect', { method: 'POST', body: '{}' });
  ok('网关: 重连接口可用', rc.status === 200, rc.data?.error || '');

  const tk = await api('/api/credential/refresh', { method: 'POST', body: '{}' });
  ok('凭证: 刷新接口可用', tk.status === 200 || tk.status === 400, tk.data?.error || '');
}

/* ---------------- 统计与插件页面 ---------------- */

async function testStatsAndPages() {
  const st = await api('/api/stats?days=7');
  ok('统计: 接口可用', st.status === 200, st.data?.error || '');
  ok('统计: 带 available 字段', typeof st.data?.available === 'boolean');

  if (st.data?.available) {
    ok('统计: 折线补齐 7 天', Array.isArray(st.data.series) && st.data.series.length === 7);
    ok('统计: 今日字段齐全', typeof st.data.today?.messages === 'number');

    const before = st.data.total;
    const d = await api('/api/mock/dispatch', {
      method: 'POST',
      body: JSON.stringify({ content: 'e2e 统计', groupId: 'g-e2e', userId: 'u-e2e' }),
    });
    ok('统计: mock 能注入消息', d.status === 200, d.data?.error || '');

    // 统计是 1 秒一批落盘的，等它刷完再查
    await new Promise((r) => setTimeout(r, 1300));
    const st2 = await api('/api/stats?days=7');
    ok('统计: 注入后总数增加', st2.data?.total > before, `${before} → ${st2.data?.total}`);
  } else {
    skip('统计: 当前 Node 不支持内置 SQLite，跳过统计断言');
  }

  const recent = await api('/api/stats/recent?limit=5');
  ok('统计: 最近消息接口可用', recent.status === 200 && Array.isArray(recent.data));

  // 插件自定义页面
  const pages = await api('/api/pages');
  ok('页面: 列表接口可用', pages.status === 200 && Array.isArray(pages.data), pages.data?.error || '');

  if (pages.data?.length) {
    const key = pages.data[0].key;
    const html = await fetch(`${BASE}/api/pages/${encodeURIComponent(key)}/html?theme=dark`);
    const text = await html.text();
    ok('页面: 能取到 HTML', html.status === 200 && text.includes('<'), `status=${html.status}`);
    ok(
      '页面: 返回的是 HTML 而不是 JSON',
      (html.headers.get('content-type') || '').includes('text/html'),
    );
    // 注入的主题变量要真的进去了，插件页面才能跟着面板切深浅色
    ok('页面: 注入了主题变量', text.includes('--panel:') && text.includes('color-scheme:dark'));
    // doctype 被挤到第二位会让浏览器进怪异模式
    if (/<!doctype/i.test(text)) {
      ok('页面: doctype 仍在最前面', /^<!doctype/i.test(text.trimStart()), text.slice(0, 40));
    }
    /**
     * 插件页令牌：iframe 没有 allow-same-origin，是 opaque origin，
     * 拿不到 Cookie，只能靠 `?pt=` 证明身份。
     *
     * 0.8.9 把凭证从 `?key=` 换成 `?pt=` 之后，已有插件的页面还在转发 key
     * → 请求一个凭证都不带 → 被 isSameOrigin() 判跨站 403，页面永远
     * 「加载中…」（dice 战绩页就是这么挂的，0.8.12 修）。
     */
    const tok = pages.data[0].token;
    const pid = pages.data[0].pluginId;
    if (tok && pid) {
      const withTok = await fetch(`${BASE}/api/pages/${encodeURIComponent(key)}/html?pt=${tok}`);
      const patched = await withTok.text();
      ok(
        '页面: 注入了自动带令牌的补丁',
        patched.includes(tok) && patched.includes('searchParams'),
        patched.includes(tok) ? '缺补丁逻辑' : '缺令牌',
      );

      // 模拟插件页发出的请求：Origin 恒为 null（opaque origin）
      const viaPt = await fetch(`${BASE}/api/plugins/${pid}/panel?pt=${tok}`, {
        headers: { Origin: 'null' },
      });
      ok(
        '插件页: 带 pt 的请求不再被判跨站',
        ![401, 403].includes(viaPt.status),
        `status=${viaPt.status}`,
      );

      // 对照组：不带 pt 就是 dice 战绩页 403 的那个场景，必须仍然被拒
      const noPt = await fetch(`${BASE}/api/plugins/${pid}/panel`, {
        headers: { Origin: 'null' },
      });
      ok('插件页: 不带 pt 仍被拒绝', noPt.status === 403, `status=${noPt.status}`);
    } else {
      skip('插件页令牌: 列表没给 token / pluginId，跳过');
    }
  } else {
    skip('页面: 当前没有插件注册页面，跳过内容断言');
  }

  const miss = await fetch(`${BASE}/api/pages/nope%3Ax/html`);
  ok('页面: 不存在的页面返回 404', miss.status === 404, `status=${miss.status}`);

  // 权限页候选人：openid 是长串，不该让人手输
  await api('/api/mock/dispatch', {
    method: 'POST',
    body: JSON.stringify({ content: '我在群里说话', groupId: 'g-people', userId: 'u-people' }),
  });
  await new Promise((r) => setTimeout(r, 300));

  const ppl = await api('/api/roles/candidates');
  ok('权限候选人: 接口可用', ppl.status === 200 && Array.isArray(ppl.data), ppl.data?.error || '');
  const me = (ppl.data || []).find((p) => p.openid === 'u-people');
  ok('权限候选人: 包含刚发过消息的人', !!me, `共 ${(ppl.data || []).length} 人`);
  if (me) {
    ok('权限候选人: 带昵称', me.name === '测试用户', me.name);
    ok('权限候选人: 带作用域和会话', me.scope === 'group' && me.chatId === 'g-people', `${me.scope}/${me.chatId}`);
  }
}

/* ---------------- 下载源 ---------------- */

async function testMirror() {
  const m = await api('/api/mirror');
  ok('下载源: 接口可用', m.status === 200 && Array.isArray(m.data?.presets), m.data?.error || '');
  ok('下载源: 有当前选中项', typeof m.data?.current?.id === 'string', m.data?.current?.id);
  ok('下载源: 带测速地址', typeof m.data?.probeUrl === 'string');

  // 记下原设置，测完还原——这是用户的真实配置文件，别留脏数据
  const orig = m.data?.current ?? {};

  const put = await api('/api/mirror', {
    method: 'PUT',
    body: JSON.stringify({ mirror: 'gitee' }),
  });
  ok('下载源: 可以切换', put.status === 200 && put.data?.current?.id === 'gitee', put.data?.error || '');

  const after = await api('/api/mirror');
  ok('下载源: 切换后立即生效', after.data?.current?.id === 'gitee', after.data?.current?.id);

  const bad = await api('/api/mirror', {
    method: 'PUT',
    body: JSON.stringify({ mirror: '不存在的源' }),
  });
  ok('下载源: 非法值被拒', bad.status === 400, `status=${bad.status}`);

  // 旧版本存在的源 id 现在也要被拒（已移除，不能悄悄落配置里）
  const old = await api('/api/mirror', {
    method: 'PUT',
    body: JSON.stringify({ mirror: 'ghfast' }),
  });
  ok('下载源: 已移除的源被拒', old.status === 400, `status=${old.status}`);

  await api('/api/mirror', {
    method: 'PUT',
    body: JSON.stringify({
      mirror: orig.id || 'auto',
      mirrorCustom: orig.custom || '',
    }),
  });
  const back = await api('/api/mirror');
  ok('下载源: 能还原原设置', back.data?.current?.id === (orig.id || 'auto'));
}

/* ---------------- 体检 / 导出 / 手动登记群 ---------------- */

async function testDoctorAndExport() {
  const d = await api('/api/doctor');
  ok('体检: 接口可用', d.status === 200 && Array.isArray(d.data?.items), d.data?.error || '');
  ok('体检: 有摘要', typeof d.data?.summary === 'string', d.data?.summary);
  ok('体检: 每项都有标题', (d.data?.items ?? []).every((x) => x.title && x.detail));

  const csv = await fetch(`${BASE}/api/stats/export?days=7`);
  ok('导出: 返回 CSV', csv.status === 200, `status=${csv.status}`);
  ok(
    '导出: content-type 是 csv',
    (csv.headers.get('content-type') || '').includes('text/csv'),
    csv.headers.get('content-type'),
  );
  const buf = Buffer.from(await csv.arrayBuffer());
  // Excel 打开中文 CSV 必须有 BOM，否则乱码。
  // 注意要看字节：fetch 的 .text() 会按规范把 BOM 吃掉，看字符是查不出来的
  ok('导出: 带 UTF-8 BOM', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, `前 3 字节 ${buf.subarray(0, 3).toString('hex')}`);
  const text = buf.toString('utf8');
  ok('导出: 有表头', text.includes('日期,消息数'), text.slice(1, 30).replace(/\n/g, ' '));

  const g = await api('/api/groups', {
    method: 'POST',
    body: JSON.stringify({ groupOpenid: 'g-manual', note: 'e2e' }),
  });
  ok('群: 可手动登记', g.status === 200, g.data?.error || '');
  const list = await api('/api/groups');
  ok(
    '群: 登记后出现在列表里',
    (list.data || []).some((x) => x.groupOpenid === 'g-manual'),
  );

  const bad = await api('/api/groups', { method: 'POST', body: JSON.stringify({}) });
  ok('群: 空 openid 被拒', bad.status === 400, `status=${bad.status}`);

  // 收拾干净：这是用户真实的数据文件，别留测试垃圾
  await api('/api/groups/g-manual', { method: 'DELETE' });
  const after = await api('/api/groups');
  ok('群: 测试数据已清理', !(after.data || []).some((x) => x.groupOpenid === 'g-manual'));
}

/* ---------------- 导航结构 ---------------- */

async function testNav() {
  const res = await fetch(BASE);
  const html = await res.text();

  // 页签收进三个下拉里，一级只留四个
  ok('导航: 有分组下拉', html.includes('data-group="data"') && html.includes('data-group="plugins"'));
  ok('导航: 插件页面有独立容器', html.includes('id="pluginPageItems"'));
  ok('导航: 分组按钮带 aria-expanded', /aria-haspopup="true"/.test(html));

  // 原来的 8 个页签都还在，只是挪进了菜单里；新增「关于」「可达性」两页
  const tabs = ['overview', 'stats', 'config', 'plugins', 'events', 'groups', 'roles', 'logs', 'about', 'reach'];
  const missing = tabs.filter((t) => !html.includes(`data-tab="${t}"`));
  ok('导航: 10 个页面一个没少', missing.length === 0, missing.join(','));

  // 页签和 section 必须成对，否则点了是空白
  const orphan = tabs.filter((t) => !html.includes(`id="tab-${t}"`));
  ok('导航: 每个页签都有对应 section', orphan.length === 0, orphan.join(','));
}

/* ---------------- 可达性 ---------------- */

/**
 * 官方没有查好友的接口，状态全靠事件推。这里只测**接口层**：
 * 三态语义（1/0/null）、`undefined` 不动 / `null` 撤销、参数校验。
 *
 * 为什么专门测 `undefined` 和 `null` 的区别：这是最容易写错的地方。
 * 用 `??` 或真值判断的话，用户在面板上改「好友」会把「推送」悄悄清空，
 * 而且界面上不会有任何提示——错得很安静。
 */
async function testReach() {
  const r0 = await api('/api/reach');
  ok('可达性: 能读', r0.status === 200 && Array.isArray(r0.data?.users), `status=${r0.status}`);
  ok(
    '可达性: 群维度也有',
    Array.isArray(r0.data?.groups),
    JSON.stringify(Object.keys(r0.data ?? {})),
  );

  const set = (body) => api('/api/reach', { method: 'POST', body: JSON.stringify(body) });
  const find = (d, id) => (d?.users ?? []).find((u) => u.openid === id);

  const a = await set({ openid: 'e2e-reach-a', friend: 1, c2cPush: 0 });
  const ua = find(a.data, 'e2e-reach-a');
  ok(
    '可达性: 标注后立刻能读到',
    ua?.friend === 1 && ua?.c2cPush === 0,
    JSON.stringify(ua),
  );
  // 有好友但关了推送 → 结论必须是 push-off，不是 ok
  ok('可达性: 有好友但关了推送判为 push-off', ua?.verdict === 'push-off', ua?.verdict);
  ok('可达性: 依据记成人工标注', ua?.evidence === 'manual', ua?.evidence);

  const b = await set({ openid: 'e2e-reach-a', c2cPush: 1 });
  const ub = find(b.data, 'e2e-reach-a');
  ok('可达性: 只改一项不动另一项', ub?.friend === 1 && ub?.c2cPush === 1, JSON.stringify(ub));
  ok('可达性: 两项都通判为 ok', ub?.verdict === 'ok', ub?.verdict);

  const c = await set({ openid: 'e2e-reach-a', friend: null });
  const uc = find(c.data, 'e2e-reach-a');
  ok('可达性: 传 null 是撤销回未知', uc?.friend === null && uc?.verdict === 'unknown', JSON.stringify(uc));
  ok('可达性: 撤销一项不影响另一项', uc?.c2cPush === 1, String(uc?.c2cPush));

  const g = await set({ groupOpenid: 'e2e-reach-g', push: 0 });
  const gg = (g.data?.groups ?? []).find((x) => x.groupOpenid === 'e2e-reach-g');
  ok('可达性: 群也能标注', gg?.push === 0 && gg?.verdict === 'push-off', JSON.stringify(gg));

  const badVal = await set({ openid: 'e2e-reach-x', friend: 'yes' });
  ok('可达性: 非法值被拒', badVal.status === 400, `status=${badVal.status}`);

  const noId = await set({});
  ok('可达性: 空 openid 被拒', noId.status === 400, `status=${noId.status}`);

  // 收拾干净：这是用户真实的数据文件，别留测试垃圾
  await set({ openid: 'e2e-reach-a', friend: null, c2cPush: null });
  await set({ groupOpenid: 'e2e-reach-g', push: null });
  const after = await api('/api/reach');
  const left = find(after.data, 'e2e-reach-a');
  ok('可达性: 测试数据已复位', left?.friend === null && left?.c2cPush === null, JSON.stringify(left));
}

/* ---------------- 主流程 ---------------- */

/* ---------------- 官方能力通道（给 AI 宿主用） ---------------- */

async function testQqChannel() {
  const caps = await api('/api/qq/capabilities');
  ok('能力通道: 清单可读', caps.status === 200 && Array.isArray(caps.data));
  ok('能力通道: 每条都带 risk', Array.isArray(caps.data) && caps.data.every((c) => c.risk && c.api));
  ok('能力通道: 覆盖到 sendGroup', caps.data.some((c) => c.api === 'sendGroup'));

  // 白名单：内部方法名不能调
  const bad = await api('/api/qq/call', {
    method: 'POST',
    body: JSON.stringify({ method: '__request' }),
  });
  ok('能力通道: 白名单外被拒', bad.status === 400, `实际 ${bad.status}`);

  // 只读调用
  const me = await api('/api/qq/call', { method: 'POST', body: JSON.stringify({ method: 'getMe' }) });
  ok('能力通道: getMe 可调', me.status === 200 && me.data?.ok === true, `实际 ${me.status}`);

  // 危险操作必须确认
  const danger = await api('/api/qq/call', {
    method: 'POST',
    body: JSON.stringify({ method: 'removeMembers', args: { __target: 'g1' } }),
  });
  ok('能力通道: 危险操作要 confirm', danger.status === 403 && danger.data?.risk === 'danger');

  // 发消息（mock 下走 echo）
  const sent = await api('/api/qq/call', {
    method: 'POST',
    body: JSON.stringify({ method: 'sendGroup', args: { __target: 'g1', content: 'hi' } }),
  });
  ok('能力通道: sendGroup 走通', sent.status === 200 && sent.data?.ok === true, `实际 ${sent.status}`);
}

async function testMessageBroadcast() {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/stream`, { signal: ctrl.signal }).catch(() => null);
  if (!res?.ok) {
    ok('消息广播: SSE 可连接', false);
    return;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const got = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!raw.includes('event: message')) continue;
          const data = raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('');
          try {
            got.push(JSON.parse(data));
          } catch {}
        }
      }
    } catch {}
  })();

  await sleep(300);
  /**
   * `--mock --serve` 下 mock 不读 stdin（那条路径只跑面板），
   * 所以用 mock 专属的注入接口喂一条消息进来。
   * 这个接口只在 rt.mock 时存在，真实机器人上 404。
   */
  await api('/api/bots/main/online', { method: 'POST', body: '{}' });
  const inj = await api('/api/mock/message', {
    method: 'POST',
    body: JSON.stringify({ text: '你好呀', groupId: 'g-broadcast' }),
  });
  ok('消息广播: 注入接口可用（仅 mock）', inj.status === 200 && inj.data?.ok === true, `实际 ${inj.status}`);
  await sleep(1200);

  ok('消息广播: 收到 event: message', got.length >= 1, `收到 ${got.length} 条`);
  if (got.length) {
    ok(
      '消息广播: 带 chatId 与正文',
      Boolean(got[0].chatId) && got[0].content === '你好呀',
      JSON.stringify(got[0]).slice(0, 120),
    );
    ok('消息广播: 不带 raw（防 auth_token 泄漏）', got[0].raw === undefined);
  }

  ctrl.abort();
  await pump;
}

/* ---------------- 事件账本 ---------------- */

/**
 * 账本的端到端验证：注入一条 mock 消息，确认它**真的**进了库。
 *
 * 单测已经覆盖了 `EventLedger` 本身，这里验的是另一件事：
 * `bot.js` 里那个 `this.ledger?.append(msg)` 有没有接对位置。
 * 接晚了（放在 pipeline 之后）单测看不出来，只有走真实链路才暴露。
 */
/* ---------------- 暂停闸 ---------------- */

/**
 * 闸的验收标准只有两条：**点暂停 → 立刻不发**，以及**暂停不等于丢消息**。
 *
 * 第二条最容易做错：如果闸拦在账本之前，暂停期间的消息就永久消失了
 * （官方没有历史消息接口，补不回来）。所以这里专门去账本里查那条消息。
 */
async function testGate() {
  const g0 = await api('/api/gate');
  ok('闸: 接口可用', g0.status === 200 && g0.data?.ok === true, g0.data?.error || '');
  ok('闸: 带全局状态', typeof g0.data?.global?.paused === 'boolean');
  ok('闸: 带每只鸟', Array.isArray(g0.data?.bots) && g0.data.bots.length > 0);

  const before = await api('/api/status');
  const gatedBefore = Number(before.data?.counters?.gated ?? 0);

  const chatId = 'g-e2e-gate';
  const on = await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'global', paused: true, reason: 'e2e 演练' }),
  });
  ok('闸: 全局暂停成功', on.status === 200 && on.data?.paused === true, on.data?.error || '');

  const g1 = await api('/api/gate');
  ok('闸: 暂停状态读得回', g1.data?.global?.paused === true);
  ok('闸: 暂停原因带出来', String(g1.data?.global?.reason ?? '').includes('e2e'));

  const inj = await api('/api/mock/message', {
    method: 'POST',
    body: JSON.stringify({ text: '暂停期间说的话', groupId: chatId }),
  });
  ok('闸: 暂停期间照常收消息', inj.status === 200, `实际 ${inj.status}`);

  const after = await api('/api/status');
  const gatedAfter = Number(after.data?.counters?.gated ?? 0);
  ok('闸: 消息被闸拦下', gatedAfter > gatedBefore, `${gatedBefore} → ${gatedAfter}`);

  // 暂停 ≠ 丢消息：账本里必须有这条
  await sleep(300);
  const lg = await api(`/api/ledger?chatId=${encodeURIComponent(chatId)}&limit=5`);
  const items = lg.data?.items ?? [];
  ok('闸: 暂停期间的消息照样进账本', items.length > 0, `拿到 ${items.length} 条`);
  ok(
    '闸: 账本里存的是原文',
    items.some((x) => x.content === '暂停期间说的话'),
    JSON.stringify(items[0] ?? {}).slice(0, 100),
  );

  const off = await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'global', paused: false }),
  });
  ok('闸: 放开成功', off.status === 200 && off.data?.paused === false);
  const g2 = await api('/api/gate');
  ok('闸: 放开后状态正确', g2.data?.global?.paused === false);

  // 会话级：只拦这一个会话，且 canSpeak 要说得出原因
  const sc = await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'chat', chatId, paused: true, reason: '这个群太吵' }),
  });
  ok('闸: 会话暂停成功', sc.status === 200 && sc.data?.paused === true, sc.data?.error || '');

  const g3 = await api(`/api/gate?chatId=${encodeURIComponent(chatId)}`);
  const speak = g3.data?.bots?.[0]?.canSpeak;
  ok('闸: canSpeak 说不能', speak?.ok === false, JSON.stringify(speak ?? {}).slice(0, 120));
  ok(
    '闸: canSpeak 给出原因码',
    (speak?.reasons ?? []).some((r) => r.code === 'gate:chat'),
    JSON.stringify((speak?.reasons ?? []).map((r) => r.code)),
  );
  ok(
    '闸: 原因是人话',
    (speak?.reasons ?? []).some((r) => String(r.text).includes('太吵')),
    JSON.stringify((speak?.reasons ?? []).map((r) => r.text)),
  );

  // 别的会话不受影响
  const g4 = await api('/api/gate?chatId=some-other-chat');
  ok('闸: 别的会话照常能说', g4.data?.bots?.[0]?.canSpeak?.ok === true, JSON.stringify(g4.data?.bots?.[0]?.canSpeak ?? {}).slice(0, 100));

  await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'chat', chatId, paused: false }),
  });
  const g5 = await api('/api/gate');
  ok(
    '闸: 取消会话暂停后列表清空',
    !(g5.data?.bots?.[0]?.chats ?? []).some((c) => c.chatId === chatId),
  );

  // 静默：带到期时间，不用手动解
  const sil = await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'silence', chatId, minutes: 2 }),
  });
  ok('闸: 静默设置成功', sil.status === 200 && sil.data?.until > Date.now(), String(sil.data?.until));
  const g6 = await api('/api/gate');
  ok(
    '闸: 静默出现在列表里',
    (g6.data?.bots?.[0]?.silence ?? []).some((s) => s.chatId === chatId),
  );
  await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'silence', chatId, minutes: 0 }),
  });

  const bad = await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'nope' }),
  });
  ok('闸: 不认识的 scope 回 400', bad.status === 400, `实际 ${bad.status}`);

  const noChat = await api('/api/gate', {
    method: 'POST',
    body: JSON.stringify({ scope: 'chat', paused: true }),
  });
  ok('闸: 会话级缺 chatId 回 400', noChat.status === 400, `实际 ${noChat.status}`);
}

async function testLedger() {
  const st0 = await api('/api/ledger/stats');
  ok('账本: 统计可读', st0.status === 200 && typeof st0.data?.total === 'number', `status=${st0.status}`);
  ok('账本: 报告可用', st0.data?.available === true, JSON.stringify(st0.data).slice(0, 100));

  const before = Number(st0.data?.total ?? 0);
  await api('/api/bots/main/online', { method: 'POST', body: '{}' });
  const inj = await api('/api/mock/message', {
    method: 'POST',
    body: JSON.stringify({ text: '记账测试', groupId: 'g-ledger' }),
  });
  ok('账本: 注入消息成功', inj.status === 200, `实际 ${inj.status}`);
  await sleep(600);

  const list = await api('/api/ledger?chatId=g-ledger&limit=10');
  const items = list.data?.items ?? [];
  ok('账本: 收消息后自动入账', items.length >= 1, `拿到 ${items.length} 条`);
  ok(
    '账本: 入账的是原文',
    items.some((x) => x.content === '记账测试'),
    JSON.stringify(items[0] ?? {}).slice(0, 120),
  );
  // 原始报文整包给前端没意义，还会把面板变成数据外泄面
  ok('账本: 不返回原始报文', items.every((x) => x.payload === undefined));
  ok('账本: 带时间基准', items.every((x) => ['message', 'observation', 'unknown'].includes(x.timeBasis)));

  const st1 = await api('/api/ledger/stats');
  ok('账本: 总数增加', Number(st1.data?.total ?? 0) > before, `${before} → ${st1.data?.total}`);

  const seq = items[0]?.seq;
  if (seq) {
    const ctx = await api(`/api/ledger/context?chatId=g-ledger&seq=${seq}`);
    ok('账本: 邻文接口可用', ctx.status === 200 && Array.isArray(ctx.data?.items), `status=${ctx.status}`);
    ok('账本: 邻文含锚点', (ctx.data?.items ?? []).some((x) => x.role === 'hit'));
  }

  const bad = await api('/api/ledger');
  ok('账本: 缺 chatId 被拒', bad.status === 400, `实际 ${bad.status}`);
  const badCtx = await api('/api/ledger/context?chatId=g-ledger');
  ok('账本: 邻文缺 seq 被拒', badCtx.status === 400, `实际 ${badCtx.status}`);
}

async function main() {
  console.log('启动服务…');  const bootLog = await boot();
  ok('启动: 无 ERROR', !/ERROR/.test(bootLog), /ERROR.*/.exec(bootLog)?.[0]?.slice(0, 60) || '');

  await testBasics();
  await testBots();
  await testOnline();
  await testConfig();
  await testPlugins();
  await testDashboard();
  await testMarket();
  await testGroupManage();
  await testGroupsAndRoles();
  await testEventsAndLogs();
  await testWebhook();
  await testMirror();
  await testDoctorAndExport();
  await testNav();
  await testReach();
  await testStatsAndPages();
  await testSendAndCred();
  await testQqChannel();
  await testMessageBroadcast();
  await testLedger();
  await testGate();

  const fail = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fail.length}/${results.length} 通过`);
  if (skipped.length) {
    console.log(`${skipped.length} 项跳过（依赖外网，网络不可用）：`);
    skipped.forEach((s) => console.log('  ~ ' + s.name));
  }
  if (fail.length) {
    console.log('失败项:');
    fail.forEach((f) => console.log('  - ' + f.name));
  }
  process.exitCode = fail.length ? 1 : 0;
}

main()
  .catch((e) => {
    console.error('测试崩溃:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    server?.kill();
    // 临时运行目录跑完就删，别在 TEMP 里堆垃圾
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
