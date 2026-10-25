/**
 * 用 OneBot 在测试群真实发消息、收回复
 * ======================================
 *
 * 框架连的是官方 QQ 机器人接口，它只能收到「@ 它」的消息。
 * 所以这里用 OneBot（SnowLuma / NapCat / Lagrange 都行）以**真人账号**的身份
 * 往测试群发一条 @机器人 的消息，再把机器人的回复从群历史里捞出来。
 *
 * 配置读 `config/live-test.json`（baseUrl / token / group / botUin）。
 *
 *   node scripts/onebot-play.mjs /kun 菜单
 *   node scripts/onebot-play.mjs /kun 签到 /kun 查询
 *   node scripts/onebot-play.mjs --wait 20 /来张图
 *   node scripts/onebot-play.mjs --check          # 只检查连通性和机器人是否在群里
 *
 * 参数：
 *   --wait <秒>    每条消息后等多久再收（默认 12）
 *   --gap <秒>     两条消息之间至少隔多久（默认 7，大于养鲲的 6 秒冷却）
 *   --raw          把原始消息段也打出来（调试图片/富媒体用）
 *   --check        只做连通性检查
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const wi = args.indexOf('--wait');
const waitSec = wi >= 0 ? Number(args[wi + 1]) || 12 : 12;
const gi = args.indexOf('--gap');
const gapSec = gi >= 0 ? Number(args[gi + 1]) || 7 : 7;
const raw = args.includes('--raw');
const checkOnly = args.includes('--check');
// 命令 = 非 -- 开头的、且不是 --wait / --gap 的取值
const skipIdx = new Set([wi + 1, gi + 1]);
const commands = args.filter((a, i) => !a.startsWith('--') && !skipIdx.has(i));

const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'config/live-test.json'), 'utf8'));
const base = String(cfg.baseUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = String(cfg.token ?? '');
const GROUP = Number(cfg.group);
const BOT = Number(cfg.botUin);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(action, body = {}) {
  const r = await fetch(`${base}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.retcode !== 0 && j.status !== 'ok') {
    throw new Error(`${action} 失败: ${j.message || j.wording || JSON.stringify(j).slice(0, 120)}`);
  }
  return j.data;
}

/** 把 OneBot 的消息段拼成一行可读文本 */
function renderSegs(segs) {
  if (typeof segs === 'string') return segs;
  if (!Array.isArray(segs)) return '';
  return segs
    .map((s) => {
      if (s.type === 'text') return s.data?.text ?? '';
      if (s.type === 'at') return `@${s.data?.qq ?? '?'}`;
      if (s.type === 'image') return `[图片 ${String(s.data?.url ?? s.data?.file ?? '').slice(-40)}]`;
      if (s.type === 'face') return '[表情]';
      if (s.type === 'reply') return '[引用]';
      return `[${s.type}]`;
    })
    .join('');
}

async function history(count = 20) {
  const d = await call('get_group_msg_history', { group_id: GROUP, count });
  return d?.messages ?? [];
}

/** 当前时间戳（秒），用来判断哪些是「刚发的」 */
const now = () => Math.floor(Date.now() / 1000);

async function main() {
  console.log(`OneBot ${base} · 群 ${GROUP} · 机器人 ${BOT}`);

  const me = await call('get_login_info');
  console.log(`  我（发消息的号）：${me?.user_id} ${me?.nickname ?? ''}`);

  const info = await call('get_group_info', { group_id: GROUP, no_cache: true });
  console.log(`  群：${info?.group_name ?? '?'}（${info?.member_count ?? '?'} 人）`);

  if (checkOnly) {
    const members = await call('get_group_member_info', { group_id: GROUP, user_id: BOT, no_cache: true });
    console.log(`  机器人成员：${members?.nickname ?? members?.card ?? '?'}（${BOT}）`);
    console.log('✓ 连通性正常');
    return;
  }

  if (!commands.length) {
    console.log('\n没给指令。用法：node scripts/onebot-play.mjs /kun 菜单');
    return;
  }

  for (const cmd of commands) {
    console.log(`\n──────── 发：${cmd} ────────`);
    const t0 = now();
    await call('send_group_msg', {
      group_id: GROUP,
      message: [
        { type: 'at', data: { qq: String(BOT) } },
        { type: 'text', data: { text: ` ${cmd}` } },
      ],
    });

    // 等机器人回复。它的回复不一定紧跟着，多收几轮
    const seen = new Set();
    let waited = 0;
    const lines = [];
    while (waited < waitSec) {
      await sleep(1500);
      waited += 1.5;
      const msgs = await history(15);
      for (const m of msgs) {
        if (m.time < t0) continue;
        if (Number(m.sender?.user_id) !== BOT) continue;
        if (seen.has(m.message_id)) continue;
        seen.add(m.message_id);
        lines.push(renderSegs(m.message));
        if (raw) console.log('   raw:', JSON.stringify(m.message).slice(0, 300));
      }
      if (lines.length && waited >= 3) break;   // 已经回了，再等一轮就够
    }

    if (!lines.length) console.log(`  ✗ ${waitSec} 秒内没有回复`);
    else for (const l of lines) console.log(l.replace(/^/gm, '  │ '));

    /**
     * 两条指令之间至少隔 gapSec 秒。
     *
     * 收到回复就提前 break，实测两条指令只隔 4.7 秒——正好撞上养鲲的
     * 6 秒冷却，第二条会被静默丢弃，看起来像「插件坏了」。
     * 这不是插件的问题，是测试节奏太快，所以在这里补上间隔。
     */
    const elapsed = now() - t0;
    if (gapSec > elapsed) await sleep((gapSec - elapsed) * 1000);
  }
}

main().catch((e) => {
  console.error('出错:', e.message);
  process.exit(1);
});
