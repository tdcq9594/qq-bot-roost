import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadBotConfig,
  loadAllBotConfigs,
  saveBotConfig,
  createBotConfig,
  ensureBotCredentials,
  migrateToMultiBot,
} from './config.js';
import { DIRS, PATHS, botPaths, listBotIds, ensureDirs, rel } from './paths.js';
import { createLogger, setLevel, getLevel, attachLogFile, flushLogs } from './logger.js';
import { BotRuntime } from './bot.js';
import { runtime, sanitizePayload } from './runtime.js';
import { LEVEL, NO_PERM, levelName, parseLevel, parseScope, scopeOf } from './roles.js';
import { openBrowser } from './browser.js';
import { startWebServer } from './web/server.js';

/* ------------------------------------------------------------------ */
/* 开箱即用：先把运行环境检查清楚，别让人对着莫名其妙的报错猜              */
/* ------------------------------------------------------------------ */

const MIN_NODE_MAJOR = 22;
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  console.error(
    `\n需要 Node.js ${MIN_NODE_MAJOR} 或更高版本，当前是 ${process.versions.node}。\n` +
      `本项目用到了内置的全局 WebSocket 和 fetch，低版本跑不起来。\n` +
      `去 https://nodejs.org/ 装一个 LTS 版本即可，不需要 npm install。\n`,
  );
  process.exit(1);
}

const log = createLogger('core');

/**
 * 已知的系统事件不再单独维护一份白名单——全部事件登记在 src/events.js。
 * 这里只保留一个提示：收到登记表里没有的事件时，说明官方加了新事件，
 * 需要补登记（但不影响转发给插件）。
 */
const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');
const CHECK_ONLY = args.has('--check');
const SERVE = args.has('--serve');

if (args.has('--help') || args.has('-h')) {
  console.log(`
QQ 机器人内核

用法:
  node src/main.js              连接 QQ，正常跑（会自动打开面板）
  node src/main.js --no-open    同上，但不自动开浏览器
  node src/main.js --check      只验证 AppID/AppSecret 和网关，不常驻
  node src/main.js --mock       不连 QQ，用本地假消息开发插件
  node src/main.js --mock --serve   只启动可视化面板，不读标准输入（调界面用）
  node src/main.js --force      已经有实例在跑时，强行再开一个（不推荐）
  node src/main.js --help       看这个帮助

同一个 AppID 默认只允许一个实例，重复启动会拒绝并给出 PID。
面板端口被占用时会自动顺延（默认最多试 20 个），实际地址看启动日志。

配置:
  config/bot.json               本体配置（AppID / AppSecret / intents / owners / webui）
  config/plugins/<插件id>.json   插件配置，首次加载自动生成
  logs/bot.log                  本体日志（含所有插件输出）
  logs/plugins/<插件id>.log      单个插件的日志
  data/                         运行时数据（存档、权限、额度），不要手改
  环境变量                       QQ_BOT_APPID / QQ_BOT_SECRET / QQ_BOT_OWNERS
  可视化面板                     默认 http://127.0.0.1:15207
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 消息前置检查已迁到 src/pipeline.js（可插拔中间件），这里不再硬编码    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 核心命令：不依赖任何插件，保证机器人一启动就能用                      */
/* ------------------------------------------------------------------ */

function registerCoreCommands(rt) {
  const { cfg, registry, plugins, tokens, roles, claim, outbound, session, id } = rt;
  const save = () => saveBotConfig(id, cfg);
  const P = cfg.commandPrefix || '/';
  const isOwner = (uid) => cfg.owners.includes(uid);

  const core = (name, meta, handler) =>
    registry.addCommand('__core', name, { plugin: '内核', ...meta }, handler);

  /** 把某插件的菜单渲染成文本 */
  /**
   * 把注册表里的菜单转成 renderMenuMd 需要的分组结构。
   * 命令项做成可点击标签，非命令项（被动触发的关键词）只显示文字。
   */
  function menuGroupsOf(m, { withCommands = true } = {}) {
    const groups = [];
    for (const sec of m.sections) {
      if (!sec.items.length) continue;
      groups.push({ title: sec.title, items: sec.items.map((it) => menuItemOf(it, withCommands)) });
    }
    return groups;
  }

  /**
   * 单个菜单项 → 可点击项。
   * 带参数的命令只把「命令名」做成可点击（点一下插入 /admin，参数自己补），
   * 完整用法放说明里——否则点出来是一串 <openid> 占位符，没法直接用。
   */
  function menuItemOf(it, withCommands = true) {
    if (!it.isCommand) {
      return { text: it.text, desc: it.desc || '', cmd: null };
    }
    const pattern = String(it.text).trim();
    const name = pattern.split(/\s+/)[0];
    const hasArgs = pattern !== name;
    return {
      text: `${P}${name}`,
      // 用法包在反引号里，里面有什么符号都不会被 markdown 吃掉
      desc: hasArgs ? `用法 \`${P}${pattern}\`${it.desc ? ' · ' + it.desc : ''}` : it.desc || '',
      cmd: withCommands ? `${P}${name}` : null,
    };
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
      return msg.replyMenu(`${m.title}${m.version ? ' v' + m.version : ''}`, menuGroupsOf(m));
    }

    // /help → 全局
    const myLv = await roles.effective(scopeOf(msg), msg.userId, { owners: cfg.owners });
    const coreMenu = registry.menus.get('__core');
    const groups = [];

    // 内核指令：按权限过滤掉用不了的
    const coreItems = [];
    for (const sec of coreMenu?.sections ?? []) {
      for (const it of sec.items) {
        if (it.admin && myLv > LEVEL.admin) continue;
        coreItems.push(menuItemOf(it));
      }
    }
    if (coreItems.length) groups.push({ title: '内核', items: coreItems });

    // 插件列表：点一下直接把 /help <id> 填进输入框
    const menus = [...registry.menus.values()].filter((m) => m.id !== '__core');
    if (!menus.length) {
      groups.push({
        title: '插件',
        items: [{ text: '还没有安装插件，把文件夹放进 plugins/ 即可', desc: '', cmd: null }],
      });
    } else {
      groups.push({
        title: `插件（${menus.length} 个）`,
        items: menus.map((m) => {
          const cnt = m.sections.reduce((n, s) => n + s.items.length, 0);
          return {
            text: m.id,
            desc: `${m.title}${cnt ? ` · ${cnt} 条` : ' · 未提供菜单'}`,
            cmd: `${P}help ${m.id}`,
          };
        }),
      });
    }

    const bot = runtime.botName || '全局菜单';
    await msg.replyMenu(bot, groups);
  });

  /** /menu 是 /help 的别名 */
  core('menu', { desc: '等同 /help，查看菜单' }, async (msg, { args }) => {
    const arg = (args[0] || '').toLowerCase();
    if (arg) {
      const m = registry.menus.get(arg);
      if (!m) return msg.reply(`没有「${arg}」这个插件`);
      return msg.replyMenu(`${m.title}${m.version ? ' v' + m.version : ''}`, menuGroupsOf(m));
    }
    const menus = [...registry.menus.values()].filter((m) => m.id !== '__core');
    await msg.replyMenu('插件菜单', [
      {
        title: `共 ${menus.length} 个`,
        items: menus.map((m) => ({
          text: m.id,
          desc: m.title,
          cmd: `${P}help ${m.id}`,
        })),
      },
    ]);
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

  core('claim', { desc: '认领主人身份，需要启动日志里的认领码', usage: `${P}claim <认领码>` }, async (msg) => {
    if (cfg.owners.length > 0) {
      return msg.reply('已经设置过主人了。如需变更，请改 config/bot.json 的 owners，或在面板里配置。');
    }
    if (!claim.code) {
      return msg.reply('当前没有可用的认领码，请重启机器人后再试。');
    }
    const input = String(msg.args[0] ?? '').trim().toUpperCase();
    if (!input) {
      return msg.reply(
        `需要认领码。\n启动日志里有一行「认领码: XXXXXX」，面板「日志」页也能看到。\n用法: ${P}claim <认领码>`,
      );
    }
    if (input !== claim.code) {
      return msg.reply('认领码不正确。');
    }
    cfg.owners.push(msg.userId);
    claim.code = '';
    await save();
    await msg.reply(`已把你设为主人：${msg.userId}\n已写入该机器人的配置文件，重启后依然有效。`);
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

    // 官方接口的额度与窗口状态，出问题时能一眼看出是哪里卡住
    if (outbound) {
      const q = await outbound.quotaSnapshot();
      const used = q[`${msg.kind}:${msg.chatId}`] ?? 0;
      lines.push(
        `本会话主动消息: ${used}/${outbound.dailyActive} 条（今日）` +
          `${used >= outbound.dailyActive ? ' · 已用完，需等用户 @ 才能继续' : ''}`,
      );
      if (outbound.stats.degraded) lines.push(`被动超窗降级: ${outbound.stats.degraded} 次`);
      if (outbound.stats.expired) lines.push(`回复过期被拒: ${outbound.stats.expired} 次`);
    }
    if (session) {
      const s = session.snapshot();
      const remain = session.stickyRemain(msg.chatId);
      if (remain > 0) lines.push(`免@窗口: 还剩 ${remain} 秒`);
      if (s.pending) lines.push(`等待中的多轮对话: ${s.pending} 个`);
    }

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
      if (lv === LEVEL.owner) return msg.reply('主人只能在 config/bot.json 的 owners 里设置');

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
/* Mock 模式：没有凭证也能开发插件                                       */
/* ------------------------------------------------------------------ */

function createMockApi(botName) {
  const echo = (scene) => async (target, body) => {
    runtime.bump('sent');
    // markdown 消息单独打印正文，否则一堆 JSON 没法看
    const text = body?.markdown
      ? `[markdown]\n${body.markdown.content}`
      : body?.content ?? JSON.stringify(body);
    console.log(`\n→ [${botName}] [${scene} ${target}] ${text}`);
    return { id: 'mock', timestamp: Date.now() };
  };
  return {
    sendGroup: echo('群'),
    sendC2C: echo('私聊'),
    uploadMedia: async () => ({ file_info: 'mock', ttl: 0 }),
    uploadLocalFile: async () => ({ file_info: 'mock', ttl: 0 }),
    getGateway: async () => ({ url: 'wss://mock' }),
    getMe: async () => ({ username: 'mock-bot', id: '0' }),
    retractGroupMessage: async () => ({}),
    retractC2CMessage: async () => ({}),
    putInteraction: async () => ({}),
  };
}

/**
 * mock 模式：从标准输入读假消息，喂给第一个机器人。
 * 多机器人时想测哪个，用 !bot <id> 切换。
 */
async function runMock(runtimes) {
  console.log('\n=== Mock 模式 ===');
  console.log('不连接 QQ，用本地假消息验证插件逻辑。输入内容回车发送，Ctrl+C 退出。');
  if (runtimes.length > 1) {
    console.log(`可用机器人: ${runtimes.map((r) => r.id).join(' / ')}，用 !bot <id> 切换\n`);
  } else {
    console.log('');
  }

  let cur = runtimes[0];
  let asUser = null;
  const currentUser = () => asUser ?? cur.cfg.owners[0] ?? 'mock-user-openid';
  const fakeGroup = 'mock-group-openid';
  let seq = 0;

  const feed = async (line) => {
    const t = line.trim();

    if (t.startsWith('!bot')) {
      const [, id] = t.split(/\s+/);
      const next = runtimes.find((r) => r.id === id);
      if (!next) return console.log(`[模拟] 没有机器人 ${id}，可用: ${runtimes.map((r) => r.id).join('/')}`);
      cur = next;
      return console.log(`[模拟] 当前机器人切换为 ${cur.id}`);
    }
    if (t.startsWith('!as')) {
      const [, id] = t.split(/\s+/);
      asUser = id || null;
      return console.log(`[模拟] 发送者切换为 ${currentUser()}`);
    }
    if (t.startsWith('!addbot')) {
      const [, gid = fakeGroup, inviter = 'mock-inviter'] = t.split(/\s+/);
      console.log(`[模拟] ${cur.id} 被 ${inviter} 拉进群 ${gid}`);
      return cur.dispatch('GROUP_ADD_ROBOT', {
        group_openid: gid,
        op_member_openid: inviter,
        timestamp: String(Date.now()),
      });
    }
    if (t.startsWith('!delbot')) {
      const [, gid = fakeGroup] = t.split(/\s+/);
      console.log(`[模拟] ${cur.id} 被移出群 ${gid}`);
      return cur.dispatch('GROUP_DEL_ROBOT', { group_openid: gid, timestamp: String(Date.now()) });
    }

    return cur.dispatch('GROUP_AT_MESSAGE_CREATE', {
      id: `mock-${++seq}`,
      content: line,
      group_openid: fakeGroup,
      author: { member_openid: currentUser() },
      timestamp: String(Date.now()),
    });
  };

  const send = (line) => {
    Promise.resolve(feed(line)).catch((e) => log.error('mock 处理出错:', e.message));
  };

  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    const jobs = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`你> ${line}`);
      if (line.trim().startsWith('!')) {
        // 控制命令（!bot / !as / !addbot）必须按顺序执行，
        // 否则「切机器人」会晚于后面那条消息生效
        await feed(line).catch((e) => log.error('mock 出错:', e.message));
      } else {
        // 普通消息并发投递：否则命令里的 ctx.prompt() 会卡住输入循环
        jobs.push(Promise.resolve(feed(line)).catch((e) => log.error('mock 出错:', e.message)));
      }
    }
    await Promise.allSettled(jobs);
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
    send(line);
  }
  rl.close();
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const globalCfg = await loadGlobalConfig();
  setLevel(globalCfg.logLevel);
  runtime.startedAt = Date.now();

  if (globalCfg.logs?.enabled !== false) {
    await attachLogFile('core', PATHS.coreLog, { maxBytes: globalCfg.logs?.maxBytes });
  }

  // 单机器人 → 多机器人结构迁移（只跑一次）
  const mig = await migrateToMultiBot();
  if (mig.migrated) {
    log.info(`已迁移到多机器人结构：机器人 ${mig.botId}，搬移 ${mig.moved.length} 个文件`);
  }

  let botCfgs = await loadAllBotConfigs();

  // 全新安装：建一个默认机器人
  if (!botCfgs.length) {
    const id = 'main';
    await ensureDirs(id);
    await createBotConfig(id, { name: '默认机器人' });
    log.info(`已创建默认机器人配置: ${rel(botPaths(id).config)}`);
    botCfgs = [await loadBotConfig(id)];
  }

  // 建运行时
  const runtimes = [];
  for (const cfg of botCfgs) {
    if (cfg.enabled === false) {
      log.info(`机器人 ${cfg.id}（${cfg.name}）已禁用，跳过`);
      continue;
    }
    if (!MOCK && (!cfg.appId || !cfg.appSecret)) {
      await ensureBotCredentials(cfg.id);
    }
    const rt = new BotRuntime({
      cfg,
      globalCfg,
      mock: MOCK,
      registerCore: (r) => registerCoreCommands(r),
      makeMockApi: (r) => createMockApi(r.name),
    });
    await rt.init();
    runtimes.push(rt);
  }

  if (!runtimes.length) {
    log.error('没有可启动的机器人，检查 config/bots/*.json 里的 enabled');
    process.exit(1);
  }
  log.info(`准备启动 ${runtimes.length} 个机器人: ${runtimes.map((r) => r.id).join('、')}`);

  /* ---------------- 面板 ---------------- */

  let web = null;

  const shutdown = async () => {
    if (shutdown.called) return;
    shutdown.called = true;
    log.info('正在退出...');
    web?.close();
    for (const rt of runtimes) await rt.stop().catch(() => {});
    await flushLogs().catch(() => {});
    process.exit(0);
  };
  shutdown.called = false;

  // 面板现在支持切换机器人，不再固定展示第一个
  if (runtimes.length > 1) {
    log.info(`面板可切换的机器人: ${runtimes.map((r) => r.id).join('、')}`);
  }

  web = await startWebServer({
    globalCfg,
    runtimes,
    saveBotConfig,
    saveGlobalConfig,
    onShutdown: shutdown,

    /** 面板「新建机器人」 */
    onBotAdd: async (id, patch) => {
      if (!MOCK && (!patch.appId || !patch.appSecret)) {
        throw new Error('AppID 和 AppSecret 都要填');
      }

      // 上次如果用 purge=false 删过，data 目录还在。
      // 直接新建会**静默复用**旧存档（权限、群档案、插件进度全都回来），
      // 这种"以为删干净了其实没删"最容易出事故，所以这里直接拦住。
      let leftover = [];
      try {
        leftover = await fs.readdir(botPaths(id).data);
      } catch {
        leftover = [];
      }
      if (leftover.length) {
        throw new Error(
          `data/bots/${id} 还留着上次删除时保留的数据（${leftover.length} 项）。` +
            `新建会复用这些存档。要干净重来就先删掉该目录；确实想接着用旧数据，` +
            `请手动把它移到目标位置后再建。`,
        );
      }

      const cfg = await createBotConfig(id, {
        name: patch.name,
        appId: patch.appId,
        appSecret: patch.appSecret,
      });
      const rt = new BotRuntime({
        cfg,
        globalCfg,
        mock: MOCK,
        registerCore: (r) => registerCoreCommands(r),
        makeMockApi: (r) => createMockApi(r.name),
      });
      await rt.init();
      runtimes.push(rt);
      await rt.start();
      log.info(`新建机器人 ${id}（${rt.name}）：${rt.state}`);
      return rt;
    },

    /** 面板「删除机器人」 */
    onBotRemove: async (id, { purge }) => {
      const i = runtimes.findIndex((r) => r.id === id);
      if (i >= 0) {
        await runtimes[i].stop().catch(() => {});
        runtimes.splice(i, 1);
      }
      const p = botPaths(id);
      await fs.unlink(p.config).catch(() => {});
      // 插件配置目录（config/bots/<id>/）
      await fs.rm(path.dirname(p.pluginConfigDir), { recursive: true, force: true }).catch(() => {});
      if (purge) {
        await fs.rm(p.data, { recursive: true, force: true }).catch(() => {});
        await fs.rm(p.logDir, { recursive: true, force: true }).catch(() => {});
      }
      log.info(`已删除机器人 ${id}${purge ? '（含数据与日志）' : '（保留数据）'}`);
      if (!purge) {
        log.warn(
          `data/bots/${id} 和 logs/bots/${id} 保留了。注意：再用同名 id 新建会被拒绝，` +
            `需要先手动清理该目录——否则旧存档会被静默复用。`,
        );
      }
    },
  });

  if (web && !args.has('--no-open') && globalCfg.webui?.openBrowser !== false && (!MOCK || SERVE)) {
    if (openBrowser(web.url)) log.info('已在浏览器中打开面板');
  }

  /* ---------------- mock 模式 ---------------- */

  if (MOCK) {
    for (const rt of runtimes) await rt.start();

    if (SERVE) {
      log.info('mock + serve：只跑面板，Ctrl+C 退出');
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return new Promise(() => {});
    }
    await runMock(runtimes);
    web?.close();
    for (const rt of runtimes) await rt.stop().catch(() => {});
    await flushLogs().catch(() => {});
    return;
  }

  /* ---------------- 真实启动 ---------------- */

  log.info(`全局配置: ${rel(PATHS.globalConfig)}`);
  if (globalCfg.logs?.enabled !== false) {
    log.info(`日志: ${rel(PATHS.coreLog)} · 机器人日志在 ${rel(DIRS.botsLogs)}/<id>/`);
  }

  // 认领码：每个机器人各自生成，避免一个码能认领所有机器人
  for (const rt of runtimes) {
    if (!rt.cfg.owners.length) {
      rt.claim.code = randomBytes(3).toString('hex').toUpperCase();
      log.warn(`[${rt.id}] 尚未设置主人。认领码: ${rt.claim.code}`);
      log.warn(`[${rt.id}] 在群里 @机器人 发 /claim ${rt.claim.code} 认领，或在面板里配置 owners。`);
    }
  }

  await Promise.all(runtimes.map((rt) => rt.start()));

  const online = runtimes.filter((r) => r.online);
  log.info(`已启动 ${online.length}/${runtimes.length} 个机器人`);
  for (const rt of runtimes) {
    if (!rt.online) log.error(`[${rt.id}] 未连上：${rt.lastError || '未知原因'}`);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
