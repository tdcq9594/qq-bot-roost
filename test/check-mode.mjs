/**
 * `--check` 接线回归（2026-11-21）
 * ==============================
 *
 * 修之前：`main.js` 里 `const CHECK_ONLY = args.has('--check')` 声明完**没再被
 * 引用过**。README 与 `--help` 都写着「只验证 AppID/AppSecret 和网关，不常驻」，
 * 实际行为是照常启动：加载插件、起 OneBot / 宿主协议端口、`runtimes.start()`
 * 真连网关。用户以为只是检查，结果真上线了一只鸟。
 *
 * 这里锁三件事：
 *   1. `runCheckMode()` 只吃**配置**，不需要（也不可能）拿到运行时——
 *      入参对象连 `start` / `init` 都没有，从结构上就不可能启动任何东西；
 *   2. 真探网关失败 → 退出码 1，并给出可操作的下一步；
 *   3. 走完整 CLI：`node src/main.js --check --mock` 输出体检结果、退出 0，
 *      **不打印「已启动」**（那行只有正常启动路径才会出现）。
 *
 * 跑法：node --test test/check-mode.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCheckMode } from '../src/check.js';
import { INTENT_META } from '../src/events.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 收集输出，顺便返回「有没有打印过某段文字」 */
function recorder() {
  const lines = [];
  const print = (s) => lines.push(String(s));
  return { lines, print, text: () => lines.join('\n') };
}

const goodCfg = {
  id: 'main',
  name: '测试鸟',
  appId: '10001',
  appSecret: 's',
  /** 群聊 intent 开着，否则 doctor 会（正确地）报「群聊事件没订阅」 */
  intents: 1 << INTENT_META.GROUP_AND_C2C_EVENT.bit,
  baseUrl: 'https://api.test',
};

test('runCheckMode：只看配置，不启动任何东西，网关可达即通过', async () => {
  const { lines, print, text } = recorder();
  let started = false;
  const bot = {
    ...goodCfg,
    /** 故意挂一个会被发现的 start：runCheckMode 不该碰它 */
    start: () => { started = true; },
    init: () => { started = true; },
  };
  const code = await runCheckMode({
    bots: [bot],
    globalCfg: {},
    print,
    makeApi: () => ({
      tokens: { get: async () => 'tok' },
      api: { getGateway: async () => ({ url: 'wss://gateway.test' }) },
    }),
  });

  assert.equal(code, 0, '没有 error 项就该是 0');
  assert.equal(started, false, '体检模式不能调用 start()/init()');
  assert.match(text(), /体检：main（测试鸟）/);
  assert.match(text(), /网关可达：wss:\/\/gateway\.test/);
  assert.match(text(), /体检通过/);
  assert.ok(lines.some((l) => l.includes('没有启动任何机器人')), '结尾要明确说没启动');
});

test('runCheckMode：插件目录不存在 → warn（不是 error），退出码仍为 0', async () => {
  const { print, text } = recorder();
  const { DIRS } = await import('../src/paths.js');
  const before = DIRS.plugins;
  /**
   * `plugins/` 在 `.gitignore` 里，**全新检出就没有这个目录**（CI 就是这样）。
   * 以前 doctor 把「目录不存在」和「目录不可写」当成同一件事报 error，于是刚
   * clone 完跑 `--check` 会被告知「装插件会失败」并退出 1 —— 一个根本不存在的故障。
   * 这条测试就是那次 CI 红的事故快照。
   */
  DIRS.plugins = path.join(os.tmpdir(), `roost-not-exist-${process.pid}`, 'plugins');
  try {
    const code = await runCheckMode({
      bots: [goodCfg],
      globalCfg: {},
      probe: false,
      print,
      makeApi: () => ({ tokens: {}, api: {} }),
    });
    assert.equal(code, 0, '目录还没建不是错误——首次启动会自动创建');
    assert.match(text(), /插件目录还没建/, '要说清是「还没建」而不是「不可写」');
    assert.doesNotMatch(text(), /插件目录不可写/);
  } finally {
    DIRS.plugins = before;
  }
});

test('runCheckMode：网关不可达 → 退出码 1，并给出下一步', async () => {
  const { print, text } = recorder();
  const code = await runCheckMode({
    bots: [{ cfg: goodCfg }],
    globalCfg: {},
    print,
    makeApi: () => ({
      tokens: { get: async () => 'tok' },
      api: { getGateway: async () => { throw new Error('HTTP 401 鉴权失败'); } },
    }),
  });
  assert.equal(code, 1);
  assert.match(text(), /网关不可达：HTTP 401 鉴权失败/);
  assert.match(text(), /AppID \/ AppSecret/, '要告诉人下一步改什么');
  assert.match(text(), /体检未通过/);
});

test('runCheckMode：过滤掉「连接」「收过消息」这两项运行态检查', async () => {
  const { print, text } = recorder();
  const cfg = { ...goodCfg, intents: 0 }; // 关掉群聊 intent：真正的配置问题仍要报
  await runCheckMode({
    bots: [cfg],
    globalCfg: {},
    mock: true,
    probe: false,
    print,
  });
  assert.doesNotMatch(text(), /还没连上|正在连接|没有连真实网关/, '一次性体检没有运行态，这两项必须过滤');
  assert.match(text(), /群聊事件没订阅/, '真正的配置问题仍要报出来');
});

test('CLI：--check --mock 走体检路径、退出 0，不进入启动流程', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-check-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.mkdirSync(path.join(home, 'config', 'bots'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'bot.json'), JSON.stringify({ logs: { enabled: false } }));
  fs.writeFileSync(
    path.join(home, 'config', 'bots', 'main.json'),
    JSON.stringify({
      id: 'main',
      name: '体检鸟',
      enabled: true,
      appId: '10001',
      appSecret: 's',
      // 群聊 intent 打开，否则 doctor 会（正确地）报「群聊事件没订阅」，退出码变 1
      intents: 1 << INTENT_META.GROUP_AND_C2C_EVENT.bit,
    }),
  );

  const { code, stdout } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ['src/main.js', '--check', '--mock'],
      {
        cwd: ROOT,
        timeout: 60_000,
        env: {
          ...process.env,
          ROOST_HOME: home,
          /** Windows 上 reg.exe 可能被策略拦掉，别让体检死在读系统代理上 */
          ROOST_NO_SYSTEM_PROXY: '1',
        },
      },
      (err, out, errOut) => {
        /**
         * `err.code` 在「被信号杀掉 / 超时」时是 `null`，`?? 0` 会把它当成**成功**。
         * 这里把「有 err 但 code 不是数字」一律算 1，避免超时被当成通过。
         */
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: `${out}\n${errOut}` });
      },
    );
  });

  assert.equal(code, 0, `体检应通过，输出：\n${stdout}`);
  assert.match(stdout, /体检：main（体检鸟）/);
  assert.match(stdout, /体检通过/);
  assert.doesNotMatch(stdout, /已启动 \d+\/\d+ 个机器人/, '走到启动流程就说明 --check 没接线');
});
