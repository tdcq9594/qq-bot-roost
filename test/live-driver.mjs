#!/usr/bin/env node
/**
 * 真机联调驱动的自测
 * ==================
 *
 * `scripts/live-test.mjs` 平时是对着真的 SnowLuma / NapCat 跑的，
 * 那样既需要小号登录、又需要测试群，没法自动测。
 *
 * 这里起一个**假 OneBot 服务端**，把协议行为按 v11 的样子实现一遍：
 * 小号发出去的消息会被记下来，如果内容像命令就补一条「机器人回复」，
 * 然后让真的 CLI 去打它。测的是驱动本身：地址拼接、消息段、轮询等回复、
 * 回复匹配——这些错了，用户配好 SnowLuma 之后才发现，成本太高。
 */
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SELF_UIN = 111111;
const BOT_UIN = 999999;
const GROUP = 123456;

let pass = 0;
let fail = 0;
function ok(name, cond, note = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${note ? `  ${note}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${note ? `  ${note}` : ''}`);
  }
}

/* ---------------- 假 OneBot ---------------- */

/** 群里已有的消息，新的往后 push */
const messages = [];
let seq = 1;

function pushMsg({ from, text, at = false }) {
  messages.push({
    message_id: seq++,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: from, nickname: from === BOT_UIN ? '机器人' : '小号' },
    message: [
      ...(at ? [{ type: 'at', data: { qq: String(BOT_UIN) } }] : []),
      { type: 'text', data: { text } },
    ],
  });
}

/** 从消息段里取纯文本 */
function textOf(message) {
  if (typeof message === 'string') return message.replace(/\[CQ:[^\]]+\]/g, '');
  return (message ?? [])
    .filter((s) => s.type === 'text')
    .map((s) => s.data?.text ?? '')
    .join('');
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', async () => {
    const action = req.url.split('?')[0].replace(/^\//, '');
    let params = {};
    try {
      params = JSON.parse(body || '{}');
    } catch {}

    const reply = (data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };

    switch (action) {
      case 'get_login_info':
        return reply({ user_id: SELF_UIN, nickname: '小号' });

      case 'get_group_list':
        return reply([{ group_id: GROUP, group_name: '栖 测试群' }]);

      case 'get_group_member_list':
        return reply([
          { user_id: SELF_UIN, nickname: '小号' },
          { user_id: BOT_UIN, nickname: '栖机器人' },
        ]);

      case 'get_group_msg_history':
        return reply({ messages: messages.slice(-(params.count ?? 20)) });

      case 'send_group_msg': {
        const text = textOf(params.message);
        pushMsg({ from: SELF_UIN, text, at: Array.isArray(params.message) && params.message.some((s) => s.type === 'at') });

        // 只有「@ 了 + 带命令前缀」才回，模拟真机器人的行为
        if (text.trim().startsWith('/')) {
          const cmd = text.trim().split(/\s+/)[0];
          setTimeout(() => {
            if (cmd === '/help') pushMsg({ from: BOT_UIN, text: '📖 帮助：/help 看这个菜单' });
            else pushMsg({ from: BOT_UIN, text: `没有「${cmd}」这个命令，发 /help 看看有哪些` });
          }, 300); // 故意延迟，验证轮询而不是 sleep 一次
        }
        return reply({ message_id: seq });
      }

      default:
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'failed', retcode: 1404, message: `不支持的 action: ${action}` }));
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

/** 跑一次 CLI，收完整输出 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'scripts/live-test.mjs'), '--url', baseUrl, '--group', String(GROUP), '--bot', String(BOT_UIN), ...args],
      { cwd: ROOT, env: { ...process.env, ROOST_ONEBOT_TOKEN: '' } },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/* ---------------- 用例 ---------------- */

console.log('\n真机联调驱动\n');

// 1. --check 探活
{
  const r = await runCli(['--check']);
  ok('探活: 退出码 0', r.code === 0, `code=${r.code}`);
  ok('探活: 认出小号', r.out.includes('小号'), '');
  ok('探活: 认出测试群', r.out.includes('栖 测试群'));
  ok('探活: 认出机器人 uin', r.out.includes(String(BOT_UIN)));
  ok('探活: 能读历史', r.out.includes('能读群消息'));
}

// 2. --send + --expect：正常命中
{
  const r = await runCli(['--send', '/help', '--expect', '帮助']);
  ok('发送: 退出码 0', r.code === 0, `code=${r.code}`);
  ok('发送: 打印了机器人回复', r.out.includes('←'), r.out.split('\n').find((l) => l.includes('←')) ?? '');
  ok('发送: 命中断言', r.out.includes('包含「帮助」'));
}

// 3. --send 不存在的命令：回复内容不同，但同样要能读到
{
  const r = await runCli(['--send', '/nope', '--expect', '没有']);
  ok('未知命令: 读到「没有」提示', r.code === 0 && r.out.includes('没有'));
}

// 4. 断言失败时退出码必须是 1（不然 CI 里永远绿）
{
  const r = await runCli(['--send', '/help', '--expect', '不可能出现的字符串']);
  ok('断言失败: 退出码 1', r.code === 1, `code=${r.code}`);
}

// 5. 不 @ 的普通消息：假服务端不回，应该判「没有回复」
{
  const r = await runCli(['--send', '今天天气不错', '--no-at', '--timeout', '3000']);
  ok('不 @ : 超时后退出码 1', r.code === 1, `code=${r.code}`);
  ok('不 @ : 提示没有回复', r.out.includes('没有回复'));
}

// 6. 服务端不存在时，报错要说人话（不是 ECONNREFUSED 裸抛）
{
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts/live-test.mjs'), '--url', 'http://127.0.0.1:1', '--group', String(GROUP)],
    { cwd: ROOT },
  );
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  const code = await new Promise((r) => child.on('close', r));
  ok('连不上: 退出码 1', code === 1, `code=${code}`);
  ok('连不上: 提示检查 HTTP 服务端', out.includes('OneBot HTTP 服务端'));
}

// 7. 场景套件：四条全过（假服务端按真机器人的规则回话）
{
  const r = await runCli(['--timeout', '3000']);
  if (!r.out.includes('4/4 通过')) console.log(`--- 套件输出 ---\n${r.out}${r.err}\n--- 结束 ---`);
  ok('套件: 退出码 0', r.code === 0, `code=${r.code}`);
  ok('套件: 4/4 通过', r.out.includes('4/4 通过'), r.out.split('\n').find((l) => l.includes('通过')) ?? '');
  ok('套件: 覆盖了不 @ 的场景', r.out.includes('不 @ 的普通消息'));
  ok('套件: 覆盖了连发两条', r.out.includes('连发两条'));
}

server.close();

console.log(`\n${pass}/${pass + fail} 通过\n`);
process.exit(fail ? 1 : 0);
