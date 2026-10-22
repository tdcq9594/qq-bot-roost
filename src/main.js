import path from 'node:path';
import process from 'node:process';
import { loadConfig, ensureCredentials, saveConfig, ROOT, CONFIG_PATH } from './config.js';
import { createLogger, setLevel } from './logger.js';
import { TokenManager } from './token.js';
import { QQApi } from './api.js';
import { Gateway } from './gateway.js';
import { buildMessage, isMessageEvent } from './message.js';
import { Registry } from './plugin/context.js';
import { PluginManager } from './plugin/loader.js';
import { runtime } from './runtime.js';
import { GroupStore } from './groups.js';
import { RoleStore, LEVEL, NO_PERM, levelName, parseLevel, parseScope, scopeOf } from './roles.js';
import { startWebServer } from './web/server.js';

const log = createLogger('core');

/** 已知的系统事件，其余的在 debug 级别打印一下，避免新事件被静默吞掉 */
const KNOWN_SYSTEM_EVENTS = new Set([
  'GROUP_ADD_ROBOT',
  'GROUP_DEL_ROBOT',
  'FRIEND_ADD',
  'FRIEND_DEL',
  'C2C_MSG_REJECT',
  'C2C_MSG_RECEIVE',
  'GROUP_MSG_REJECT',
  'GROUP_MSG_RECEIVE',
]);
const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');
const CHECK_ONLY = args.has('--check');
const SERVE = args.has('--serve');

if (args.has('--help') || args.has('-h')) {
  console.log(`
QQ 机器人内核

用法:
  node src/main.js              连接 QQ，正常跑
  node src/main.js --check      只验证 AppID/AppSecret 和网关，不常驻
  node src/main.js --mock       不连 QQ，用本地假消息开发插件
  node src/main.js --mock --serve   只启动可视化面板，不读标准输入（调界面用）
  node src/main.js --help       看这个帮助

配置:
  config.json                   AppID / AppSecret / intents / owners / webui
  环境变量                       QQ_BOT_APPID / QQ_BOT_SECRET / QQ_BOT_OWNERS
  可视化面板                     默认 http://127.0.0.1:8080
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 消息前置检查：去重、限流、白名单                                      */
/* ------------------------------------------------------------------ */

function createGuards(cfg) {
  const seen = new Map(); // msgId -> ts
  const rate = new Map(); // chatId -> { count, start }

  return {
    /** 返回 true 表示应当继续处理 */
    check(msg) {
      // 1) 去重：同一条消息可能因重连被重复投递
      const win = (cfg.dedupWindowSec ?? 0) * 1000;
      if (win > 0 && msg.id) {
        const now = Date.now();
        const hit = seen.get(msg.id);
        if (hit && now - hit < win) {
          runtime.bump('dedup');
          return false;
        }
        seen.set(msg.id, now);
        if (seen.size > 1000) {
          for (const [k, t] of seen) {
            if (now - t > win) seen.delete(k);
            else break;
          }
        }
      }

      // 2) 白名单
      const wl = cfg.whitelist ?? {};
      if (wl.enabled) {
        const okGroup = msg.kind === 'group' && (wl.groups ?? []).includes(msg.groupId);
        const okUser = (wl.users ?? []).includes(msg.userId);
        if (!okGroup && !okUser) {
          runtime.bump('rejected');
          log.debug(`白名单拦截: kind=${msg.kind} group=${msg.groupId} user=${msg.userId}`);
          return false;
        }
      }

      // 3) 限流：每个会话每分钟上限。
      //    只对「@机器人」或「带命令前缀」的消息生效——
      //    普通聊天会先交给插件判断，不该因为闲聊把额度耗光。
      const rl = cfg.rateLimit ?? {};
      const addressed = msg.mentioned || msg.isCommand;
      if (rl.enabled && msg.chatId && addressed) {
        const limit = Math.max(1, rl.perChatPerMinute ?? 30);
        const now = Date.now();
        const rec = rate.get(msg.chatId) ?? { count: 0, start: now };
        if (now - rec.start > 60_000) {
          rec.count = 0;
          rec.start = now;
        }
        rec.count += 1;
        rate.set(msg.chatId, rec);
        if (rec.count > limit) {
          runtime.bump('limited');
          if (rec.count === limit + 1) {
            msg.reply(`本会话每分钟最多 ${limit} 条，请稍后再试。`).catch(() => {});
          }
          return false;
        }
      }

      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 核心命令：不依赖任何插件，保证机器人一启动就能用                      */
/* ------------------------------------------------------------------ */

function registerCoreCommands(registry, { cfg, plugins, tokens, roles }) {
  const P = cfg.commandPrefix || '/';
  const isOwner = (uid) => cfg.owners.includes(uid);

  const core = (name, meta, handler) =>
    registry.addCommand('__core', name, { plugin: '内核', ...meta }, handler);

  /** 把某插件的菜单渲染成文本 */
  function renderMenu(m) {
    const lines = [`${m.title}${m.version ? ' v' + m.version : ''}`];
    if (m.desc) lines.push(m.desc);
    let total = 0;
    for (const sec of m.sections) {
      if (!sec.items.length) continue;
      lines.push(`\n【${sec.title}】`);
      for (const it of sec.items) {
        total += 1;
        const label = it.isCommand ? `${P}${it.text}` : it.text;
        lines.push(`  ${label}${it.desc ? '  ' + it.desc : ''}`);
      }
    }
    if (!total) lines.push('\n（该插件没有提供任何指令）');
    return lines.join('\n');
  }

  /** 全局菜单 */
  core('help', { desc: '全局菜单；加插件 id 看下级菜单' }, async (msg) => {
    const arg = (msg.args[0] || '').toLowerCase();

    // /help <插件id> → 下级菜单
    if (arg) {
      const m = registry.menus.get(arg);
      if (!m) {
        const ids = [...registry.menus.keys()].filter((k) => k !== '__core');
        return msg.reply(`没有「${arg}」这个插件。\n可用: ${ids.join('、') || '无'}`);
      }
      return msg.reply(renderMenu(m));
    }

    // /help → 全局
    const lines = [];
    const bot = runtime.botName ? `${runtime.botName} · 全局菜单` : '全局菜单';
    lines.push(bot);

    const myLv = await roles.effective(scopeOf(msg), msg.userId, { owners: cfg.owners });
    const coreMenu = registry.menus.get('__core');
    lines.push('\n【内核】');
    for (const sec of coreMenu?.sections ?? []) {
      for (const it of sec.items) {
        if (it.admin && myLv > LEVEL.admin) continue;
        lines.push(`  ${P}${it.text}${it.desc ? '  ' + it.desc : ''}`);
      }
    }

    const menus = [...registry.menus.values()].filter((m) => m.id !== '__core');
    lines.push(`\n【插件】${menus.length} 个`);
    if (!menus.length) {
      lines.push('  还没有安装插件，把文件夹放进 plugins/ 即可');
    } else {
      for (const m of menus) {
        const cnt = m.sections.reduce((n, s) => n + s.items.length, 0);
        const flag = cnt ? `${cnt} 条` : '未提供菜单';
        lines.push(`  ${m.id}  ${m.title} · ${flag}`);
      }
      lines.push(`\n发 ${P}help <插件id> 看该插件的下级菜单`);
    }
    await msg.reply(lines.join('\n'));
  });

  /** /menu 是 /help 的别名 */
  core('menu', { desc: '等同 /help，查看菜单' }, async (msg, { args }) => {
    const arg = (args[0] || '').toLowerCase();
    if (arg) {
      const m = registry.menus.get(arg);
      return msg.reply(m ? renderMenu(m) : `没有「${arg}」这个插件`);
    }
    const menus = [...registry.menus.values()].filter((m) => m.id !== '__core');
    await msg.reply(
      ['插件菜单：', ...menus.map((m) => `  ${P}help ${m.id}  ${m.title}`)].join('\n'),
    );
  });

  core('ping', { desc: '测试机器人是否在线' }, async (msg) => {
    await msg.reply(`pong（已运行 ${Math.floor(runtime.uptimeMs / 1000)} 秒）`);
  });

  core('whoami', { desc: '查看自己的 openid（配置主人用）' }, async (msg) => {
    const lv = await roles.effective(scopeOf(msg), msg.userId, { owners: cfg.owners });
    const lines = [
      `来源: ${msg.kind}`,
      `你的 openid: ${msg.userId}`,
      msg.groupId ? `群 openid: ${msg.groupId}` : '',
      `是否主人: ${isOwner(msg.userId) ? '是' : '否'}`,
      `当前权限: ${levelName(lv)}`,
    ].filter(Boolean);
    await msg.reply(lines.join('\n'));
  });

  core('claim', { desc: '认领机器人主人身份（仅在未设置主人时可用）' }, async (msg) => {
    if (cfg.owners.length > 0) {
      return msg.reply('已经设置过主人了。如需变更，请改 config.json 的 owners，或在面板里配置。');
    }
    cfg.owners.push(msg.userId);
    await saveConfig(cfg);
    await msg.reply(`已把你设为主人：${msg.userId}\n已写入 config.json，重启后依然有效。`);
  });

  /** 运行状态总览 */
  core('status', { desc: '机器人运行状态' }, async (msg) => {
    const list = plugins.list();
    const running = list.filter((p) => p.loaded).length;
    const up = Math.floor(runtime.uptimeMs / 1000);
    const d = Math.floor(up / 86400);
    const h = Math.floor((up % 86400) / 3600);
    const m = Math.floor((up % 3600) / 60);
    const uptime = `${d ? d + '天' : ''}${h ? h + '小时' : ''}${m}分${up < 60 ? up + '秒' : ''}`;

    const lines = [
      `连接: ${runtime.connected ? '在线' : '离线'}`,
      `机器人: ${runtime.botName || '-'}`,
      `运行: ${uptime}`,
    ];

    if (tokens?.expiresAt) {
      const left = Math.max(0, Math.round((tokens.expiresAt - Date.now()) / 1000));
      lines.push(`凭证: 剩余 ${Math.floor(left / 60)} 分（自动续期）`);
    }

    lines.push(`消息: 收 ${runtime.counters.recv} / 发 ${runtime.counters.sent} / 命令 ${runtime.counters.commands}`);
    lines.push(`插件: ${running}/${list.length} 运行中`);
    lines.push(`内存: ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
    await msg.reply(lines.join('\n'));
  });

  /** 详细统计 */
  core('stats', { desc: '消息与事件统计' }, async (msg) => {
    const c = runtime.counters;
    const lines = [
      '消息统计',
      `  收到 ${c.recv}   发出 ${c.sent}   命令 ${c.commands}   错误 ${c.errors}`,
      `  去重 ${c.dedup}   限流 ${c.limited}   白名单 ${c.rejected}   无人回应 ${c.ignored}`,
    ];

    const chats = [...runtime.perChat.values()].sort((a, b) => b.count - a.count).slice(0, 5);
    if (chats.length) {
      lines.push('\n活跃会话');
      for (const x of chats) {
        const id = x.id.length > 12 ? x.id.slice(0, 6) + '…' + x.id.slice(-4) : x.id;
        lines.push(`  ${x.kind}  ${id}  ${x.count} 条`);
      }
    }

    const cs = roles.cacheStats();
    lines.push(`\n权限缓存\n  命中 ${cs.hits} / 未命中 ${cs.misses} · 命中率 ${cs.hitRate}% · 条目 ${cs.size}`);

    const events = [...runtime.eventCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (events.length) {
      lines.push('\n事件');
      for (const [name, n] of events) lines.push(`  ${name}  ${n}`);
    } else {
      lines.push('\n事件\n  还没收到任何事件（检查 intents 和沙箱群配置）');
    }

    await msg.reply(lines.join('\n'));
  });

  // 把 /admin 的子命令也写进菜单，保证「所有指令都能在菜单里查到」
  registry.addMenuSection('__core', { name: '内核' }, '权限子命令', [
    { cmd: 'admin me', desc: '查看自己在各作用域的权限', admin: true },
    { cmd: 'admin list [作用域]', desc: '列出某作用域的管理员', admin: true },
    { cmd: 'admin set <openid> <等级> [作用域]', desc: '设置权限，只能授予数字更大的等级', admin: true },
    { cmd: 'admin del <openid> [作用域]', desc: '移除权限', admin: true },
    { cmd: 'admin whois <openid>', desc: '查某人在各作用域的权限（含各插件）', admin: true },
    { cmd: 'admin scopes', desc: '列出所有已配置的作用域', admin: true },
    { cmd: 'admin levels', desc: '查看等级空间与插件号段分配', admin: true },
  ]);

  /* ---------------- 权限管理 ---------------- */

  const levelOf = (uid, scope = 'global') =>
    roles.effective(scope, uid, { owners: cfg.owners });
  const brief = (id) => (id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id);

  core('admin', { desc: '权限管理：list / set / del / me / scopes' }, async (msg) => {
    const [sub, ...rest] = msg.args;
    const scope = scopeOf(msg);
    const myLevel = await levelOf(msg.userId, scope);

    // 不带参数：看当前作用域的权限情况
    if (!sub) {
      const members = await roles.scopeMembers(scope);
      const lines = [`作用域: ${scope}`, `你的等级: ${levelName(myLevel)}`];
      const list = Object.entries(members).sort((a, b) => a[1] - b[1]);
      if (list.length) {
        lines.push('\n本作用域管理员：');
        for (const [oid, lv] of list) lines.push(`  ${brief(oid)}  ${levelName(lv)}`);
      } else {
        lines.push('\n本作用域还没有配置管理员');
      }
      lines.push(
        `\n等级（数字越小权限越高）: 0 主人 / 1 管理员 / 2 群管 / 3 助手 / 4+ 自定义`,
        `作用域: here(默认) / global / group:<id> / channel:<id> / feature:<插件>`,
        `设置: ${P}admin set <openid> <等级> [作用域]`,
      );
      return msg.reply(lines.join('\n'));
    }

    // 我是谁
    if (sub === 'me') {
      const owner = cfg.owners.includes(msg.userId);
      const rows = await roles.scopesOf(msg.userId);
      const lines = [`openid: ${msg.userId}`];
      if (owner) lines.push('身份: 主人（最高权限）');
      else {
        const g = await roles.levelIn('global', msg.userId);
        lines.push(`全局: ${g ? levelName(g) : '无'}`);
        if (rows.length) {
          lines.push('\n各作用域：');
          for (const r of rows) lines.push(`  ${r.scope}  ${levelName(r.level)}`);
        } else {
          lines.push('未在任何作用域获得权限');
        }
      }
      return msg.reply(lines.join('\n'));
    }

    // 等级空间与插件号段
    if (sub === 'levels') {
      if (myLevel > LEVEL.manager) return msg.reply('需要群管及以上权限');
      const rows = [...(plugins.allocations ?? new Map()).entries()].sort(
        (a, b) => a[1].base - b[1].base,
      );
      const lines = [
        '等级空间（数字越小权限越高）',
        '  0 主人 / 1 管理员 / 2 群管 / 3 助手',
        '  4-9 内核预留',
        '  10+ 插件区，每个插件 10 个号位',
      ];
      if (rows.length) {
        lines.push('\n插件号段：');
        for (const [id, a] of rows) {
          const loaded = plugins.loaded.has(id) ? '运行中' : '未加载';
          lines.push(`  ${id.padEnd(12)} ${a.base}-${a.end}  ${loaded}`);
        }
      } else {
        lines.push('\n还没有插件');
      }
      return msg.reply(lines.join('\n'));
    }

    // 查某人在所有作用域的权限
    if (sub === 'whois') {
      const target = rest[0];
      if (!target) return msg.reply(`用法: ${P}admin whois <openid>`);
      if (myLevel > LEVEL.admin) return msg.reply('需要管理员权限');

      const rows = await roles.scopesOf(target);
      const lines = [`openid: ${target}`];
      if (cfg.owners.includes(target)) lines.push('身份: 主人');
      const g = await roles.levelIn('global', target);
      lines.push(`全局: ${g >= NO_PERM ? '无' : levelName(g)}`);
      if (rows.length) {
        lines.push('\n各作用域：');
        for (const r of rows) lines.push(`  ${r.scope}  ${levelName(r.level)}（${r.level}）`);
      } else {
        lines.push('\n未在任何作用域获得权限');
      }
      return msg.reply(lines.join('\n'));
    }

    // 列出所有作用域
    if (sub === 'scopes') {
      const all = await roles.listScopes();
      if (!all.length) return msg.reply('还没有配置任何权限');
      return msg.reply(
        ['已配置的作用域：', ...all.map((x) => `  ${x.scope}  ${x.count} 人`)].join('\n'),
      );
    }

    // 列某作用域成员
    if (sub === 'list') {
      const target = rest[0] ? parseScope(rest[0], msg) : scope;
      if (!target) return msg.reply(`作用域写法不对: ${rest[0]}`);
      if ((await levelOf(msg.userId, target)) > LEVEL.manager) {
        return msg.reply('需要该作用域的群管及以上权限');
      }
      const members = await roles.scopeMembers(target);
      const list = Object.entries(members).sort((a, b) => a[1] - b[1]);
      if (!list.length) return msg.reply(`${target} 下没有配置管理员`);
      return msg.reply(
        [`${target}：`, ...list.map(([oid, lv]) => `  ${brief(oid)}  ${levelName(lv)}`)].join('\n'),
      );
    }

    // 设置
    if (sub === 'set') {
      const [openid, lvText, scopeText] = rest;
      const lv = parseLevel(lvText);
      if (!openid || lv === null) {
        return msg.reply(
          `用法: ${P}admin set <openid> <等级> [作用域]\n等级: 1 管理员 / 2 群管 / 3 助手 / 4 及以上自定义`,
        );
      }
      const target = scopeText ? parseScope(scopeText, msg) : scope;
      if (!target) return msg.reply(`作用域写法不对: ${scopeText}`);
      if (lv === LEVEL.owner) return msg.reply('主人只能在 config.json 的 owners 里设置');

      const actor = await levelOf(msg.userId, target);
      if (actor > LEVEL.manager) {
        return msg.reply(`需要群管及以上权限才能设置（当前 ${levelName(actor)}）`);
      }
      // 核心规则：数字越小权限越高，所以只能授予「数字更大」的等级
      if (lv <= actor) {
        return msg.reply(`不能授予同级或更高的权限（你当前是 ${levelName(actor)}）`);
      }
      const cur = await roles.levelIn(target, openid);
      if (cur <= actor) {
        return msg.reply(`对方当前是 ${levelName(cur)}，权限不低于你，无法修改`);
      }

      await roles.set(target, openid, lv);
      return msg.reply(`已设置 ${brief(openid)} 在 ${target} 为 ${levelName(lv)}`);
    }

    // 移除
    if (sub === 'del' || sub === 'remove') {
      const [openid, scopeText] = rest;
      if (!openid) return msg.reply(`用法: ${P}admin del <openid> [作用域]`);
      const target = scopeText ? parseScope(scopeText, msg) : scope;
      if (!target) return msg.reply(`作用域写法不对: ${scopeText}`);

      const cur = await roles.levelIn(target, openid);
      if (cur >= NO_PERM) return msg.reply('该用户在这个作用域没有权限');
      const actor = await levelOf(msg.userId, target);
      if (actor >= cur) return msg.reply('不能移除同级或更高权限的管理员');

      await roles.remove(target, openid);
      return msg.reply(`已移除 ${brief(openid)} 在 ${target} 的权限`);
    }

    await msg.reply(`未知子命令: ${sub}\n可用: list / set / del / me / scopes`);
  });

  core('plugins', { desc: '列出插件与状态' }, async (msg) => {
    const list = plugins.list();
    if (!list.length) return msg.reply('还没有安装任何插件。把插件文件夹放进 plugins/ 即可。');

    const lines = ['插件列表：'];
    for (const p of list) {
      const flag = p.loaded ? '运行中' : p.enabled ? '未加载' : '已禁用';
      const ver = p.version ? ` v${p.version}` : '';
      const menu = registry.menus.get(p.id);
      const cnt = menu ? menu.sections.reduce((n, s) => n + s.items.length, 0) : 0;
      const menuText = cnt ? `${cnt} 条菜单` : '未提供菜单';
      const alloc = plugins.allocations?.get(p.id);
      const lvText = alloc ? ` · 等级 ${alloc.base}-${alloc.end}` : '';
      lines.push(`${p.loaded ? '●' : '○'} ${p.id}${ver} [${flag}] · ${menuText}${lvText}`);
      if (p.description) lines.push(`    ${p.description}`);
      if (p.error) lines.push(`    错误: ${p.error}`);
    }
    if (isOwner(msg.userId)) {
      lines.push(`\n管理: ${P}enable <id> / ${P}disable <id> / ${P}reload <id>`);
    }
    lines.push(`查看某插件菜单: ${P}help <插件id>`);
    await msg.reply(lines.join('\n'));
  });

  core('enable', { desc: '启用插件（需全局管理员）', admin: true, globalAdmin: true }, async (msg) => {
    const id = msg.args[0];
    if (!id) return msg.reply(`用法: ${P}enable <插件id>`);
    const ok = await plugins.setEnabled(id, true);
    await msg.reply(ok ? `已启用 ${id}` : `启用失败，查看日志或 ${P}plugins 看错误`);
  });

  core('disable', { desc: '禁用插件（需全局管理员）', admin: true, globalAdmin: true }, async (msg) => {
    const id = msg.args[0];
    if (!id) return msg.reply(`用法: ${P}disable <插件id>`);
    await plugins.setEnabled(id, false);
    await msg.reply(`已禁用 ${id}`);
  });

  core('reload', { desc: '重载插件（需全局管理员）', admin: true, globalAdmin: true }, async (msg) => {
    const id = msg.args[0];
    if (id) {
      const ok = await plugins.reload(id);
      return msg.reply(ok ? `已重载 ${id}` : `重载 ${id} 失败，看日志`);
    }
    let n = 0;
    for (const p of plugins.list()) {
      if (p.enabled && (await plugins.reload(p.id))) n++;
    }
    await msg.reply(`已重载 ${n} 个插件`);
  });
}

/* ------------------------------------------------------------------ */
/* 事件分发                                                            */
/* ------------------------------------------------------------------ */

/** 把收到的消息写进日志，可按来源类型屏蔽 */
function logIncoming(msg, cfg) {
  const ml = cfg.messageLog ?? {};
  if (ml.enabled === false) return;
  if ((ml.muteKinds ?? []).includes(msg.kind)) return;

  const content = msg.content.length > 120 ? msg.content.slice(0, 120) + '…' : msg.content;
  const who = msg.userName
    ? `${msg.userName}(${msg.userId.slice(0, 8)})`
    : msg.userId.slice(0, 8) || '-';
  const where = msg.groupId ? msg.groupId.slice(0, 10) : '-';
  log.info(`收到 ${msg.kind} 会话:${where} 来自:${who} 内容:${content || '(空)'}`);
}

function createDispatcher({ registry, api, cfg, plugins, guards, groups, roles }) {
  const isOwner = (uid) => cfg.owners.includes(uid);

  return async function dispatch(eventName, d) {
    runtime.lastEventAt = Date.now();
    runtime.messageEvent = eventName;
    runtime.bumpEvent(eventName);
    // 只留最近一条，截断防止把大对象塞进状态里
    try {
      const raw = JSON.stringify(d);
      runtime.lastRaw = { name: eventName, at: Date.now(), payload: raw.slice(0, 1500) };
    } catch {
      runtime.lastRaw = { name: eventName, at: Date.now(), payload: '<无法序列化>' };
    }

    if (!isMessageEvent(eventName)) {
      // 未知事件不再静默丢弃，留个线索
      if (!KNOWN_SYSTEM_EVENTS.has(eventName)) {
        log.debug(`收到未处理的事件 ${eventName}: ${JSON.stringify(d).slice(0, 300)}`);
      }
      // 入群 / 退群：维护群档案，并在必要时自动认主
      if (eventName === 'GROUP_ADD_ROBOT') {
        const gid = d?.group_openid;
        const inviter = d?.op_member_openid || '';
        await groups.onAdded(gid, inviter);
        // 邀请人默认成为该群管理员（本群作用域），不影响其它群
        if (inviter && gid) {
          const gScope = `group:${gid}`;
          if (!(await roles.levelIn(gScope, inviter))) {
            await roles.set(gScope, inviter, LEVEL.admin);
          }
        }
        if (cfg.autoOwnerOnInvite && !cfg.owners.length && inviter) {
          cfg.owners.push(inviter);
          await saveConfig(cfg);
          log.info(`已自动把邀请人 ${inviter} 设为机器人主人（可在面板修改）`);
        }
      } else if (eventName === 'GROUP_DEL_ROBOT') {
        await groups.onRemoved(d?.group_openid);
      }

      for (const l of registry.listeners.get(eventName) ?? []) {
        try {
          await l.handler(d, { event: eventName, api });
        } catch (e) {
          runtime.bump('errors');
          log.error(`监听器 ${l.pluginId} 处理 ${eventName} 出错:`, e.message);
        }
      }
      return;
    }

    const msg = buildMessage(eventName, d, { api, cfg });
    runtime.bump('recv');
    runtime.touchChat(msg.chatId, msg.kind);

    // 先登记群，再做拦截：被限流/白名单拦掉的消息也说明这个群存在
    if (msg.kind === 'group' && msg.groupId) await groups.touch(msg.groupId);

    // 报文里带 member_role=owner 的就是群主，比「谁邀请机器人」更准
    if (msg.kind === 'group' && msg.raw?.author?.member_role === 'owner') {
      await groups.setOwner(msg.groupId, msg.userId);
      const gScope = `group:${msg.groupId}`;
      if (!(await roles.levelIn(gScope, msg.userId))) {
        await roles.set(gScope, msg.userId, LEVEL.admin);
        log.info(`群主 ${msg.userId} 自动获得 ${gScope} 的管理员权限`);
      }
    }

    logIncoming(msg, cfg);

    if (!guards.check(msg)) return;

    if (msg.isCommand) {
      const entry = registry.commands.get(msg.command);
      if (entry) {
        // 鉴权：本会话等级只算一次，命令判定和插件共用
        const scope = scopeOf(msg);
        if (entry.admin || entry.globalAdmin) {
          const lv = await roles.effective(scope, msg.userId, { owners: cfg.owners });
          if (entry.admin && lv > LEVEL.admin) {
            return msg.reply(
              `需要管理员权限才能用这个命令（你当前是${levelName(lv)}）。\n` +
                `发 ${cfg.commandPrefix || '/'}admin me 查看自己的权限。`,
            );
          }
          if (entry.globalAdmin) {
            // 全局命令要求「全局」等级，不能拿某个群的等级来顶
            const gl = cfg.owners.includes(msg.userId)
              ? LEVEL.owner
              : await roles.levelIn('global', msg.userId);
            if (gl > LEVEL.admin) {
              return msg.reply('这个命令影响全局，需要「全局管理员」权限。');
            }
          }
        }
        const required = (entry.pattern?.match(/<[^>]+>/g) ?? []).length;
        if (msg.args.length < required) {
          return msg.reply(`参数不够\n用法: ${entry.usage}`);
        }
        runtime.bump('commands');
        try {
          await entry.handler(msg, { args: msg.args, raw: msg.content });
        } catch (e) {
          runtime.bump('errors');
          log.error(`命令 ${entry.name}（插件 ${entry.pluginId}）执行出错:`, e.stack || e.message);
          await msg.reply(`执行出错: ${e.message}`).catch(() => {});
        }
        return;
      }
      const P = cfg.commandPrefix || '/';
      return msg.reply(`没有这个命令：${P}${msg.command}\n发 ${P}help 查看全部命令`).catch(() => {});
    }

    // 非命令消息：全部交给监听者判断，谁回应就留下，没人回应则静默丢弃。
    // 这样关键词玩法、被动触发才能工作，也不会让机器人对群里每句话都插话。
    let handled = false;
    for (const evt of ['message', eventName]) {
      for (const l of registry.listeners.get(evt) ?? []) {
        try {
          const ret = await l.handler(msg);
          // 两种「我处理了」的表达：显式 return true，或者已经发过消息
          if (ret === true || msg.replied) handled = true;
        } catch (e) {
          runtime.bump('errors');
          log.error(`监听器 ${l.pluginId} 处理 ${evt} 出错:`, e.stack || e.message);
        }
      }
    }
    if (!handled) runtime.bump('ignored');
  };
}

/* ------------------------------------------------------------------ */
/* Mock 模式：没有凭证也能开发插件                                       */
/* ------------------------------------------------------------------ */

function createMockApi() {
  const echo = (scene) => async (target, body) => {
    runtime.bump('sent');
    console.log(`\n→ [${scene} ${target}] ${body?.content ?? JSON.stringify(body)}`);
    return { id: 'mock', timestamp: Date.now() };
  };
  return {
    sendGroup: echo('群'),
    sendC2C: echo('私聊'),
    postGroupFile: async () => ({ file_info: 'mock' }),
    postC2CFile: async () => ({ file_info: 'mock' }),
    uploadMedia: async () => ({ file_info: 'mock', ttl: 0 }),
    uploadLocalFile: async () => ({ file_info: 'mock', ttl: 0 }),
    getGateway: async () => ({ url: 'wss://mock' }),
    getMe: async () => ({ username: 'mock-bot', id: '0' }),
  };
}

async function runMock(cfg, registry, plugins, groups, roles) {
  console.log('\n=== Mock 模式 ===');
  console.log('不连接 QQ，用本地假消息验证插件逻辑。输入内容回车发送，Ctrl+C 退出。\n');

  const guards = createGuards(cfg);
  const dispatch = createDispatcher({ registry, api: createMockApi(), cfg, plugins, guards, groups, roles });
  let asUser = null; // !as 可以切换发送者，方便测多级权限
  const currentUser = () => asUser ?? cfg.owners[0] ?? 'mock-user-openid';
  const fakeGroup = 'mock-group-openid';
  let seq = 0;

  // 普通文本 = 一条群 @ 消息；以 ! 开头 = 模拟系统事件
  //   !addbot <群openid> <邀请人openid>   模拟机器人被拉进群
  //   !delbot <群openid>                  模拟机器人被移出群
  const feed = async (line) => {
    const t = line.trim();
    if (t.startsWith('!addbot')) {
      const [, gid = fakeGroup, inviter = 'mock-inviter'] = t.split(/\s+/);
      console.log(`[模拟] 机器人被 ${inviter} 拉进群 ${gid}`);
      return dispatch('GROUP_ADD_ROBOT', {
        group_openid: gid,
        op_member_openid: inviter,
        timestamp: String(Date.now()),
      });
    }
    if (t.startsWith('!as')) {
      const [, id] = t.split(/\s+/);
      asUser = id || null;
      console.log(`[模拟] 发送者切换为 ${currentUser()}`);
      return;
    }
    if (t.startsWith('!delbot')) {
      const [, gid = fakeGroup] = t.split(/\s+/);
      console.log(`[模拟] 机器人被移出群 ${gid}`);
      return dispatch('GROUP_DEL_ROBOT', { group_openid: gid, timestamp: String(Date.now()) });
    }
    return dispatch('GROUP_AT_MESSAGE_CREATE', {
      id: `mock-${++seq}`,
      content: line,
      group_openid: fakeGroup,
      author: { member_openid: currentUser() },
      timestamp: String(Date.now()),
    });
  };

  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`你> ${line}`);
      await feed(line);
    }
    await groups.flush();
    return;
  }

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    let line;
    try {
      line = await rl.question('你> ');
    } catch {
      break;
    }
    if (!line.trim()) continue;
    await feed(line);
  }
  rl.close();
  await groups.flush();
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const cfg = await loadConfig();
  setLevel(cfg.logLevel);
  runtime.startedAt = Date.now();

  const registry = new Registry();
  const groups = new GroupStore();
  const roles = new RoleStore();
  let tokens = null;
  let api = null;

  if (!MOCK) {
    await ensureCredentials(cfg);
    tokens = new TokenManager(cfg);
    api = new QQApi({ tokenManager: tokens, baseUrl: cfg.baseUrl });

    log.info('正在验证凭证...');
    try {
      await tokens.verify();
      log.info('凭证有效');
    } catch (e) {
      log.error(e.message);
      process.exit(1);
    }

    if (CHECK_ONLY) {
      const gw = await api.getGateway();
      log.info(`自检通过，网关: ${gw.url}`);
      return;
    }
  } else {
    api = createMockApi();
  }

  const plugins = new PluginManager({
    pluginsDir: path.join(ROOT, 'plugins'),
    registry,
    api,
    cfg,
    groups,
    roles,
    isOwner: (uid) => cfg.owners.includes(uid),
  });

  registerCoreCommands(registry, { cfg, plugins, tokens, roles });
  await plugins.scan();

  let gateway = null;

  // 可视化面板（mock 模式也可用，方便调界面）
  const web = startWebServer({
    cfg,
    plugins,
    groups,
    roles,
    getGateway: () => gateway,
    tokens,
    api,
    saveConfig,
    onConfigApplied: async () => {
      if (gateway) await gateway.restart();
    },
  });

  if (MOCK) {
    if (SERVE) {
      log.info('mock + serve：只跑面板，Ctrl+C 退出');
      process.on('SIGINT', () => {
        web?.close();
        process.exit(0);
      });
      return new Promise(() => {});
    }
    await runMock(cfg, registry, plugins, groups, roles);
    web?.close();
    return;
  }

  if (!cfg.owners.length) {
    log.warn('尚未设置主人。在群里 @机器人 发 /claim 认领，或在可视化面板里配置 owners。');
  }

  const guards = createGuards(cfg);
  const dispatch = createDispatcher({ registry, api, cfg, plugins, guards, groups, roles });

  gateway = new Gateway({
    api,
    tokens,
    intents: cfg.intents,
    onDispatch: dispatch,
  });

  log.info(`配置: ${CONFIG_PATH}`);
  log.info(`intents=${cfg.intents}${cfg.intents === 1 << 25 ? '（群聊@ + 私聊）' : ''}`);

  await gateway.start();

  const shutdown = async () => {
    log.info('正在退出...');
    gateway.stop();
    web?.close();
    await groups.flush().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
