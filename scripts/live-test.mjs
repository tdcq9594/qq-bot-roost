#!/usr/bin/env node
/**
 * 真机联调：用小号跟机器人真聊
 * ============================
 *
 * mock 模式测的是「插件逻辑对不对」，测不出下面这些只有真网关才有的东西：
 *
 *   - intents 有没有开（网关连得上、日志也正常，但群消息一条都进不来）
 *   - 被动回复窗口（官方只给 5 分钟）
 *   - msg_seq 递增（同一个 msg_id 连发两条，第二条会被拒）
 *   - @ 判定、免@粘性、群 openid 映射
 *
 * 这个脚本让**一个普通 QQ 小号**在真实群里 @ 机器人，然后把机器人的回复读回来。
 * 小号由 OneBot v11 实现驱动（SnowLuma / NapCat / Lagrange.OneBot / LLOneBot 都行），
 * 我们只跟 OneBot 的 HTTP 接口说话，不关心底下是哪个。
 *
 *   npm run live -- --init          生成 config/live-test.json 模板
 *   npm run live -- --check         探活：小号是谁、群在不在、机器人 uin 是几号
 *   npm run live                    跑一遍场景（不@ / @ / 未知命令 / 连发两条）
 *   npm run live -- --chat          交互：你打字，它当小号发出去，回复打回来
 *   npm run live -- --send "你好"    发一条就走（给 agent 用）
 *
 * 配置优先级：命令行 > 环境变量 > config/live-test.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

const CONFIG_PATH = path.resolve('config/live-test.json');

/* ---------------- 命令行 ---------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

/* ---------------- 配置 ---------------- */

/**
 * 读配置。文件里放的是**本机联调参数**（含 OneBot token），
 * 已经写进 .gitignore，不会入库。
 */
async function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`config/live-test.json 解析失败：${e.message}`);
      process.exit(1);
    }
  }

  const env = process.env;
  return {
    baseUrl: String(opt('--url') ?? env.ROOST_ONEBOT_URL ?? file.baseUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: String(opt('--token') ?? env.ROOST_ONEBOT_TOKEN ?? file.token ?? ''),
    group: Number(opt('--group') ?? env.ROOST_GROUP ?? file.group ?? 0),
    botUin: Number(opt('--bot') ?? env.ROOST_BOT_UIN ?? file.botUin ?? 0),
    /** 没填 botUin 时用来在群成员里找机器人 */
    botName: String(file.botName ?? ''),
    /** 命令前缀，和 config/bot.json 的 commandPrefix 保持一致 */
    prefix: String(file.prefix ?? '/'),
    timeoutMs: Number(opt('--timeout') ?? file.timeoutMs ?? 15000),
  };
}

/* ---------------- OneBot 客户端 ---------------- */

class OneBotError extends Error {
  constructor(message, retcode) {
    super(message);
    this.retcode = retcode;
  }
}

/**
 * 调一个 OneBot action。
 *
 * token 同时放 header 和 query：不同实现的校验方式不一样，
 * 两个都给最省事（OneBot v11 标准是 header，不少实现只认 query）。
 */
async function call(cfg, action, params = {}) {
  const url = new URL(`/${action}`, `${cfg.baseUrl}/`);
  if (cfg.token) url.searchParams.set('access_token', cfg.token);

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    // 连不上是最常见的问题，把「去哪儿改」直接说出来
    throw new OneBotError(
      `连不上 OneBot（${cfg.baseUrl}）：${e.cause?.code || e.message}\n` +
        '  检查：SnowLuma / NapCat 的 OneBot HTTP 服务端开了没、端口对不对、地址要不要写 127.0.0.1',
      -1,
    );
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OneBotError(
      `返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 160)}\n` +
        '  多半是地址写错了——OneBot 的 HTTP 接口通常不在 WebUI 端口上（SnowLuma 的 WebUI 是 5099）',
      res.status,
    );
  }

  // 有的实现回 {status:'ok'|'failed'}，有的只回 retcode
  const failed = json.status === 'failed' || (json.retcode !== undefined && json.retcode !== 0);
  if (failed) {
    throw new OneBotError(
      `${action} 失败：${json.message || json.wording || `retcode ${json.retcode}`}`,
      json.retcode,
    );
  }
  return json.data ?? null;
}

const api = {
  loginInfo: (cfg) => call(cfg, 'get_login_info'),
  groupList: (cfg) => call(cfg, 'get_group_list'),
  memberList: (cfg, group) => call(cfg, 'get_group_member_list', { group_id: group }),
  history: (cfg, group, count = 20) => call(cfg, 'get_group_msg_history', { group_id: group, count }),
};

/* ---------------- 消息工具 ---------------- */

/** 把 OneBot 的消息（数组段或 CQ 码字符串）压成一行可读文本 */
function msgText(m) {
  const msg = m?.message ?? m?.raw_message ?? '';
  if (typeof msg === 'string') {
    return msg
      .replace(/\[CQ:at,qq=([^\]]+)\]/g, '@$1')
      .replace(/\[CQ:[^\]]+\]/g, '[媒体]')
      .trim();
  }
  if (Array.isArray(msg)) {
    return msg
      .map((s) => {
        if (s.type === 'text') return s.data?.text ?? '';
        if (s.type === 'at') return `@${s.data?.qq ?? ''}`;
        if (s.type === 'image') return '[图片]';
        if (s.type === 'face') return '[表情]';
        return `[${s.type}]`;
      })
      .join('')
      .trim();
  }
  return String(msg);
}

const senderOf = (m) => Number(m?.sender?.user_id ?? m?.user_id ?? m?.sender?.uin ?? 0);
const idOf = (m) => String(m?.message_id ?? m?.id ?? '');

/**
 * 发一条群消息。
 *
 * 先按**消息段数组**发（OneBot v11 的 array 格式，SnowLuma / NapCat 都认）；
 * 只有明确报「参数不对」时才退回 CQ 码字符串——不能一失败就重试，
 * 万一第一条其实发出去了，重试会变成群里两条一样的消息。
 */
async function sendGroup(cfg, segments) {
  try {
    return await call(cfg, 'send_group_msg', { group_id: cfg.group, message: segments });
  } catch (e) {
    const paramProblem = e.retcode === 1400 || /message|segment|array|cq/i.test(e.message);
    if (!paramProblem) throw e;

    const cq = segments
      .map((s) => (s.type === 'at' ? `[CQ:at,qq=${s.data.qq}]` : s.data.text))
      .join('');
    return call(cfg, 'send_group_msg', { group_id: cfg.group, message: cq });
  }
}

/** 组一条「@机器人 + 文本」的消息 */
function atSegments(cfg, text) {
  if (!cfg.botUin) return [{ type: 'text', data: { text } }];
  // @ 后面留个空格，人在 QQ 里看到的也是「@机器人 /help」，读起来自然
  return [
    { type: 'at', data: { qq: String(cfg.botUin) } },
    { type: 'text', data: { text: ` ${text}` } },
  ];
}

/** 发消息前记下已有的消息 id，之后凡是「不在这个集合里」的就是新的 */
async function baseline(cfg) {
  const hist = await api.history(cfg, cfg.group, 20).catch(() => null);
  const list = hist?.messages ?? hist ?? [];
  return new Set(list.map(idOf).filter(Boolean));
}

/**
 * 等机器人的回复。
 *
 * 不用 sleep 后读一次，而是轮询：官方被动回复的延迟不稳定（几百毫秒到几秒），
 * 固定等待要么白等要么漏。
 *
 * 机器人一条命令可能**分几条发**（先回一句，再补一条）。拿到第一条就返回会
 * 把后面的截掉，所以收到之后还要再多看一小段安静期（graceMs），确认没有后续。
 *
 * @param {object} o
 * @param {Set<string>} o.base      发送前记下的消息 id
 * @param {number} [o.expect]       至少要凑够几条（连发场景用）
 * @returns {Promise<Array<{text:string, at:number}>>} 新出现的机器人消息
 */
async function waitBotReply(cfg, base, { timeoutMs = cfg.timeoutMs, selfUin = 0, expect = 1, graceMs = 900 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const got = [];
  let firstAt = 0;

  while (Date.now() < deadline) {
    let hist;
    try {
      hist = await api.history(cfg, cfg.group, 20);
    } catch (e) {
      // 读不到历史就别硬等，直接把原因抛给调用方
      throw new OneBotError(`读群消息失败：${e.message}`);
    }
    const list = hist?.messages ?? hist ?? [];

    for (const m of list) {
      const id = idOf(m);
      if (!id || base.has(id)) continue;
      const from = senderOf(m);
      if (selfUin && from === selfUin) continue; // 自己发的不算
      if (cfg.botUin && from !== cfg.botUin) continue; // 只认机器人
      base.add(id); // 防重复
      got.push({ text: msgText(m), at: Number(m.time) * 1000 || Date.now() });
      if (!firstAt) firstAt = Date.now();
    }

    if (got.length >= expect) break;
    // 已经收到一些、而且安静够久了：后面的不会来了
    if (got.length && Date.now() - firstAt >= graceMs) break;

    await new Promise((r) => setTimeout(r, 400));
  }
  return got;
}

/* ---------------- 输出 ---------------- */

const say = (...a) => console.log(...a);
const okMark = '  ✓';
const badMark = '  ✗';

/* ---------------- 子命令：--init ---------------- */

async function cmdInit() {
  const exists = await fs.access(CONFIG_PATH).then(() => true).catch(() => false);
  if (exists) {
    say(`config/live-test.json 已存在，没有覆盖。要看模板就删掉它再跑一次。`);
    return 0;
  }
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(
    CONFIG_PATH,
    `${JSON.stringify(
      {
        _说明: [
          'OneBot v11 HTTP 地址。SnowLuma / NapCat / Lagrange.OneBot 的「HTTP 服务端」都行。',
          '注意不是 WebUI 端口（SnowLuma 的 WebUI 是 5099）。',
        ],
        baseUrl: 'http://127.0.0.1:3000',
        _token: 'OneBot 的 access token，没设就留空',
        token: '',
        _group: '测试群号（数字）。机器人必须在这个群里',
        group: 0,
        _botUin: '机器人自己的 QQ 号。不知道就先留 0，跑 --check 会帮你找',
        botUin: 0,
        _botName: '机器人显示名，用于在群成员里自动找它',
        botName: '',
        _prefix: '和 config/bot.json 的 commandPrefix 一致',
        prefix: '/',
        _timeoutMs: '等机器人回复的最长时间',
        timeoutMs: 15000,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  say(`已生成 ${CONFIG_PATH}`);
  say('下一步：把 baseUrl / token / group 填上，然后 `npm run live -- --check`。');
  return 0;
}

/* ---------------- 子命令：--check ---------------- */

async function cmdCheck(cfg) {
  say('\n探活\n');

  // 1. 小号是谁
  const me = await api.loginInfo(cfg);
  const selfUin = Number(me?.user_id ?? me?.uin ?? 0);
  say(`${okMark} 小号已连上：${me?.nickname ?? '?'}（${selfUin || '未知 uin'}）`);
  say(`     OneBot：${cfg.baseUrl}`);

  // 2. 群在不在
  const groups = await api.groupList(cfg);
  const list = Array.isArray(groups) ? groups : [];
  say(`${okMark} 小号在 ${list.length} 个群里`);

  if (!cfg.group) {
    say('\n还没填 group。下面是小号所在的群，挑一个当测试群：\n');
    for (const g of list.slice(0, 30)) {
      say(`  ${g.group_id}  ${g.group_name ?? ''}`);
    }
    say('\n填进 config/live-test.json 的 group，再跑一次 --check。');
    return 0;
  }

  const target = list.find((g) => Number(g.group_id) === cfg.group);
  if (!target) {
    say(`${badMark} 群 ${cfg.group} 不在小号的群列表里`);
    say('     要么群号写错了，要么小号还没进群。');
    return 1;
  }
  say(`${okMark} 测试群：${target.group_name ?? ''}（${cfg.group}）`);

  // 3. 机器人在不在群里、uin 是几号
  let members = [];
  try {
    members = (await api.memberList(cfg, cfg.group)) ?? [];
  } catch (e) {
    say(`  ! 读不到群成员（${e.message}），机器人 uin 只能自己填`);
  }

  if (cfg.botUin) {
    const hit = members.find((m) => Number(m.user_id) === cfg.botUin);
    if (hit) say(`${okMark} 机器人 uin ${cfg.botUin} 在群里：${hit.nickname ?? hit.card ?? ''}`);
    else if (members.length) say(`  ! 群成员里没找到 uin ${cfg.botUin}，确认一下机器人真的进群了`);
    else say(`  ! 无法核对 uin ${cfg.botUin}（没读到成员列表）`);
  } else if (members.length) {
    // 官方机器人的昵称里通常带「机器人」或你自己起的名字
    const guess = members.filter((m) => {
      const name = `${m.nickname ?? ''}${m.card ?? ''}${m.remark ?? ''}`;
      if (cfg.botName && name.includes(cfg.botName)) return true;
      return /机器人|bot/i.test(name);
    });
    if (guess.length) {
      say(`\n猜机器人是这几个，把对应的 QQ 号填进 botUin：\n`);
      for (const m of guess.slice(0, 10)) {
        say(`  ${m.user_id}  ${m.nickname ?? ''} ${m.card ? `（群名片：${m.card}）` : ''}`);
      }
    } else {
      say(`\n没自动认出机器人。群成员里带「机器人 / bot」的一个都没有。`);
      say('在 QQ 群里点一下机器人的头像，就能看到它的 QQ 号，填进 botUin。');
    }
  }

  // 4. 能不能读历史
  try {
    const hist = await api.history(cfg, cfg.group, 5);
    const n = (hist?.messages ?? hist ?? []).length;
    say(`${okMark} 能读群消息（最近 ${n} 条）`);
  } catch (e) {
    say(`${badMark} 读不了群消息：${e.message}`);
    say('     有的实现要单独开「历史消息」权限，或者换 get_group_msg_history 可用的实现。');
    return 1;
  }

  say('\n都没问题就可以 `npm run live` 跑场景了。');
  return 0;
}

/* ---------------- 子命令：--send ---------------- */

async function cmdSend(cfg, text, expect) {
  /**
   * Git Bash 会把以 / 开头的参数当路径转换：`--send "/help"` 到脚本里
   * 已经变成 `C:/Program Files/Git/help` 了。这不是脚本能修的，
   * 所以提供 `--cmd`——不带斜杠，脚本自己补前缀。
   */
  // 真实消息不会以盘符开头，出现了就是被 Git Bash 转过
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    say(`! 参数被 Git Bash 当成路径了：${text}`);
    say(`  改用：npm run live -- --cmd "${text.split('/').pop()}"`);
    return 1;
  }

  const base = await baseline(cfg);
  await sendGroup(cfg, flag('--no-at') ? [{ type: 'text', data: { text } }] : atSegments(cfg, text));
  say(`→ 已发出${flag('--no-at') ? '（未 @）' : '（@ 机器人）'}：${text}`);

  const replies = await waitBotReply(cfg, base);
  if (!replies.length) {
    say(`✗ ${cfg.timeoutMs / 1000} 秒内没有回复`);
    return 1;
  }
  for (const r of replies) say(`← ${r.text}`);

  if (expect) {
    const hit = replies.some((r) => r.text.includes(expect));
    say(hit ? `✓ 回复里包含「${expect}」` : `✗ 回复里没有「${expect}」`);
    return hit ? 0 : 1;
  }
  return 0;
}

/* ---------------- 子命令：--chat ---------------- */

async function cmdChat(cfg, me) {
  const selfUin = Number(me?.user_id ?? 0);
  say(`\n真机对话：你在键盘上打字，小号在群里发出去。`);
  say(`  :at   切换「要不要 @ 机器人」（现在${cfg.botUin ? '会 @' : '不会 @，因为没填 botUin'}）`);
  say(`  :quit 退出\n`);

  let at = Boolean(cfg.botUin);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    for (;;) {
      const line = (await rl.question(`小号${at ? '[@]' : '[无@]'}> `)).trim();
      if (!line) continue;
      if (line === ':quit' || line === ':q') break;
      if (line === ':at') {
        at = !at;
        say(`  ${at ? '以后都 @ 机器人' : '以后都不 @'}`);
        continue;
      }

      const base = await baseline(cfg);
      await sendGroup(cfg, at ? atSegments(cfg, line) : [{ type: 'text', data: { text: line } }]);

      const replies = await waitBotReply(cfg, base, { selfUin });
      if (!replies.length) {
        say(`  （${cfg.timeoutMs / 1000} 秒内没有回复）\n`);
        continue;
      }
      for (const r of replies) say(`  ← ${r.text}`);
      say('');
    }
  } finally {
    rl.close();
  }
  return 0;
}

/* ---------------- 默认：跑场景 ---------------- */

async function cmdSuite(cfg, me) {
  const selfUin = Number(me?.user_id ?? 0);
  const results = [];

  say(`\n真机场景（群 ${cfg.group}，机器人 ${cfg.botUin || '未指定 uin'}）\n`);

  /** 跑一条，返回是否通过 */
  async function step(name, fn) {
    process.stdout.write(`${name} … `);
    try {
      const r = await fn();
      results.push({ name, ok: r.ok, note: r.note });
      say(r.ok ? `✓${r.note ? ` ${r.note}` : ''}` : `✗ ${r.note ?? ''}`);
    } catch (e) {
      results.push({ name, ok: false, note: e.message });
      say(`✗ ${e.message}`);
    }
  }

  // 1. 不 @ 的普通消息：不该回。
  //    这条必须第一个跑——@ 过一次之后会开 180 秒免@粘性窗口，
  //    那时候不 @ 也会被当成在跟机器人说话，测不出东西。
  await step('不 @ 的普通消息，不该回复', async () => {
    const base = await baseline(cfg);
    await sendGroup(cfg, [{ type: 'text', data: { text: '今天天气不错' } }]);
    const replies = await waitBotReply(cfg, base, { selfUin, timeoutMs: Math.min(cfg.timeoutMs, 8000) });
    if (!replies.length) return { ok: true, note: '安静，符合预期' };
    return {
      ok: false,
      note: `回了「${replies[0].text.slice(0, 40)}」——装了关键词插件就正常，否则说明粘性窗口还开着`,
    };
  });

  // 2. @ + /help：最常见的「活着吗」
  await step('@ 机器人 /help', async () => {
    const base = await baseline(cfg);
    await sendGroup(cfg, atSegments(cfg, `${cfg.prefix}help`));
    const replies = await waitBotReply(cfg, base, { selfUin });
    if (!replies.length) return { ok: false, note: '没回复：intent 没开？机器人没进群？' };
    return { ok: true, note: `回了 ${replies.length} 条` };
  });

  // 3. 未知命令：应该有回应（提示不认识），而不是静默
  await step('@ 机器人 未知命令', async () => {
    const base = await baseline(cfg);
    await sendGroup(cfg, atSegments(cfg, `${cfg.prefix}roost_live_test_nope`));
    const replies = await waitBotReply(cfg, base, { selfUin });
    if (!replies.length) return { ok: false, note: '没回复' };
    return { ok: true, note: replies[0].text.slice(0, 40) };
  });

  // 4. 连发两条：同一个群连着两条消息，各自是独立 msg_id，
  //    官方要求 msg_seq 在同一个 msg_id 下递增——这里验证两条都能回
  await step('连发两条 @ 命令', async () => {
    const base = await baseline(cfg);
    await sendGroup(cfg, atSegments(cfg, `${cfg.prefix}help`));
    await new Promise((r) => setTimeout(r, 600));
    await sendGroup(cfg, atSegments(cfg, `${cfg.prefix}help`));
    const replies = await waitBotReply(cfg, base, { selfUin, expect: 2 });
    if (replies.length >= 2) return { ok: true, note: `${replies.length} 条回复` };
    if (replies.length === 1) return { ok: false, note: '只回了 1 条——第二条可能被 msg_seq 规则拒了' };
    return { ok: false, note: '一条都没回' };
  });

  const pass = results.filter((r) => r.ok).length;
  say(`\n${pass}/${results.length} 通过\n`);
  return pass === results.length ? 0 : 1;
}

/* ---------------- 入口 ---------------- */

async function main() {
  if (flag('--init')) return cmdInit();

  const cfg = await loadConfig();

  if (flag('--check')) return cmdCheck(cfg);

  // 除了 --check / --init，其余都要有群号
  if (!cfg.group) {
    console.error('还没配测试群。先跑 `npm run live -- --init` 生成配置，再 `--check` 探活。');
    return 1;
  }

  const me = await api.loginInfo(cfg).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });

  if (flag('--chat')) return cmdChat(cfg, me);

  // --cmd 不带斜杠，脚本自己补前缀：`--cmd help` → `/help`，`--cmd "roll 6"` → `/roll 6`
  const cmd = opt('--cmd');
  if (cmd !== null) return cmdSend(cfg, `${cfg.prefix}${cmd}`, opt('--expect'));

  const send = opt('--send');
  if (send !== null) return cmdSend(cfg, send, opt('--expect'));

  return cmdSuite(cfg, me);
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    console.error(`\n出错了：${e.message}`);
    process.exit(1);
  });
