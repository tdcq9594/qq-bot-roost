/**
 * dsh-roost 插件的逻辑测试
 * ========================
 *
 * 这里测的是「插件自己的逻辑」：工具注册了没有、execute 能不能正确调 API、
 * 错误翻译对不对。
 *
 * 测不了的是 `defineTool` 的真实校验——那要 DSH 运行时才有。
 * 所以做法是：把 defineTool mock 成「原样返回参数」，然后验证参数结构合理。
 * 剩下那层由真机 `dsh plugin add` 验证。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const results = [];
const ok = (name, pass, extra = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

const SRC = new URL('../integrations/dsh-roost/', import.meta.url);

/**
 * 建一个临时副本，塞进假的 @deepseek-ai/dsh-tools。
 * 直接改源目录会留下不该提交的 node_modules。
 */
async function prepare() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-roost-test-'));
  for (const f of ['index.js', 'package.json', 'cordis.patch.yml']) {
    await fs.copyFile(new URL(f, SRC), path.join(tmp, f));
  }
  const fakeDir = path.join(tmp, 'node_modules', '@deepseek-ai', 'dsh-tools');
  await fs.mkdir(fakeDir, { recursive: true });
  await fs.writeFile(
    path.join(fakeDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.2.0', type: 'module', main: 'index.js' }),
  );
  // mock：defineTool 原样返回，这样能直接检查传进去的结构
  await fs.writeFile(path.join(fakeDir, 'index.js'), 'export const defineTool = (spec) => spec;\n');
  return tmp;
}

/** 假面板：按路径返回固定数据 */
function startFakePanel(port) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, body: '' });
    const send = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url.startsWith('/api/status')) {
      return send({
        botName: '测试机器人',
        state: 'online',
        connected: true,
        counters: { received: 12, sent: 7 },
        reconnectCount: 2,
        plugins: [{ id: 'a' }, { id: 'b' }],
        credentialExpiresIn: 3600,
        version: '0.5.5',
        uptimeMs: 3_723_000,
      });
    }
    if (req.url.startsWith('/api/plugins')) {
      return send([
        { id: 'dice', name: '掷骰子', version: '1.0.0', enabled: true, loaded: true, kind: 'internal' },
        { id: 'kun', name: '养鲲', version: '1.0.0', enabled: false, loaded: false, kind: 'internal' },
      ]);
    }
    if (req.url.startsWith('/api/logs')) {
      return send({
        lines: [
          { time: '2026-10-24T00:00:01.000Z', level: 'info', module: 'core', msg: '已启动 1/1 个机器人' },
          { time: '2026-10-24T00:00:02.000Z', level: 'error', module: 'gateway', msg: '连接失败' },
        ],
      });
    }
    if (req.url.includes('/api/plugins/') && req.method === 'POST') {
      return send({ ok: true });
    }
    if (req.url.startsWith('/api/send')) return send({ ok: true });
    if (req.url.startsWith('/api/gateway/reconnect')) return send({ ok: true });

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, calls })));
}

async function main() {
  const tmp = await prepare();
  const mod = await import(pathToFileURL(path.join(tmp, 'index.js')).href);

  ok('插件导出 name', mod.name === 'dsh-roost', mod.name);
  ok('插件声明 inject', Array.isArray(mod.inject) && mod.inject.includes('tools'));
  ok('插件导出 apply', typeof mod.apply === 'function');

  const { srv, calls } = await startFakePanel(15999);

  // 收集注册的工具
  const tools = [];
  const ctx = { tools: { register: (t) => tools.push(t) } };
  mod.apply(ctx, { baseUrl: 'http://127.0.0.1:15999' });

  ok('注册了 6 个工具', tools.length === 6, `实际 ${tools.length}`);

  const names = tools.map((t) => t.name).sort();
  const want = [
    'roost_logs',
    'roost_plugin_toggle',
    'roost_plugins',
    'roost_reconnect',
    'roost_send',
    'roost_status',
  ];
  ok('工具名都对', JSON.stringify(names) === JSON.stringify(want), names.join(','));

  // 结构检查：每个工具该有的字段
  const bad = tools.filter(
    (t) =>
      !t.name ||
      !t.description ||
      typeof t.execute !== 'function' ||
      !t.output?.schema ||
      typeof t.output?.render !== 'function',
  );
  ok('每个工具都有 name/description/output/execute', bad.length === 0, bad.map((t) => t.name).join(','));

  // 只读工具标了并发安全，写操作没标
  const ro = tools.filter((t) => t.name !== 'roost_plugin_toggle' && t.name !== 'roost_send' && t.name !== 'roost_reconnect');
  ok('只读工具标了并发安全', ro.every((t) => t.isConcurrencySafe?.() === true));

  // 实际执行
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const st = await byName.roost_status.execute({}, {});
  ok('roost_status 返回在线', st.ok === true && st.online === true, st.state);
  ok('roost_status 统计正确', st.received === 12 && st.sent === 7 && st.plugins === 2);
  ok('roost_status 格式化时长', st.uptime.includes('小时'), st.uptime);

  const pl = await byName.roost_plugins.execute({}, {});
  ok('roost_plugins 统计正确', pl.ok && pl.total === 2 && pl.enabled === 1 && pl.loaded === 1);

  const lg = await byName.roost_logs.execute({ level: 'error' }, {});
  ok('roost_logs 按级别过滤', lg.ok && lg.count === 1 && lg.lines[0].includes('连接失败'), `${lg.count} 条`);

  const tg = await byName.roost_plugin_toggle.execute({ id: 'kun', action: 'enable' }, {});
  ok('roost_plugin_toggle 调对接口', tg.ok === true && calls.some((c) => c.url.includes('/api/plugins/kun/enable')));

  const tgBad = await byName.roost_plugin_toggle.execute({ id: 'kun', action: 'boom' }, {});
  ok('roost_plugin_toggle 拒绝非法 action', tgBad.ok === false && tgBad.error.includes('enable'));

  const sd = await byName.roost_send.execute({ target: 'g1', content: 'hi' }, {});
  ok('roost_send 缺参数会拦', (await byName.roost_send.execute({ content: 'x' }, {})).ok === false);
  ok('roost_send 正常发送', sd.ok === true);

  const rc = await byName.roost_reconnect.execute({}, {});
  ok('roost_reconnect 可用', rc.ok === true);

  // 连不上时的错误翻译
  srv.close();
  await new Promise((r) => setTimeout(r, 100));
  const dead = await byName.roost_status.execute({}, {});
  ok('连不上时给人话提示', dead.ok === false && /没在运行|连不上/.test(dead.error), dead.error.slice(0, 40));

  // 面板挂了也不能抛异常，要返回结构化错误
  ok('失败时不抛异常、返回结构化错误', typeof dead.error === 'string' && dead.ok === false);

  await fs.rm(tmp, { recursive: true, force: true });

  const fail = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fail.length}/${results.length} 通过`);
  if (fail.length) {
    console.log('失败项:');
    fail.forEach((f) => console.log('  - ' + f.name));
  }
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((e) => {
  console.error('测试崩了:', e);
  process.exitCode = 1;
});
