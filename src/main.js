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
import { configureMirror } from './mirror.js';
import { BotRuntime, pluginAllowedIn } from './bot.js';
import { toggleGroupPlugin, resetGroupPlugins, describeGroupScope } from './plugin/groupscope.js';
import { runtime, sanitizePayload } from './runtime.js';
import { LEVEL, NO_PERM, levelName, parseLevel, parseScope, scopeOf } from './roles.js';
import { openBrowser } from './browser.js';
import { WebhookServer } from './webhook.js';
import { startWebServer } from './web/server.js';
import { Services } from './services/index.js';
import { recoverInterruptedUpdate } from './updater.js';

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
  config/bots/<机器人id>/plugins/<插件id>.json   插件配置，首次加载自动生成
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

  /**
   * 内核命令分到哪一组。
   *
   * 以前所有命令都塞进「指令」一组，`/help` 主菜单二十多行。
   * 现在分三组，主菜单只放「常用 + 分类入口」，具体命令进下级菜单。
   */
  const CORE_SECTION = {
    ping: '基础',
    whoami: '基础',
    status: '基础',
    stats: '基础',
    admin: '管理',
    plugins: '管理',
    enable: '管理',
    disable: '管理',
    reload: '管理',
    群插件: '管理',
    help: '其它',
    menu: '其它',
    claim: '其它',
  };

  const core = (name, meta, handler) =>
    registry.addCommand(
      '__core',
      name,
      { plugin: '内核', section: CORE_SECTION[name] ?? '其它', ...meta },
      handler,
    );

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
  core('help', { desc: '全局菜单；加插件 id 或分类名看下级菜单' }, async (msg) => {
    const raw = (msg.args[0] || '').trim();
    const arg = raw.toLowerCase();
    const myLv = await roles.effective(scopeOf(msg), msg.userId, { owners: cfg.owners });

    /** 内核命令按权限过滤后的分组（分组名 → 菜单项） */
    const coreSections = () => {
      const out = new Map();
      for (const sec of registry.menus.get('__core')?.sections ?? []) {
        const items = [];
        for (const it of sec.items) {
          if (it.admin && myLv > LEVEL.admin) continue;
          if (it.globalAdmin && myLv > LEVEL.admin) continue;
          items.push(menuItemOf(it));
        }
        if (items.length) out.set(sec.title, items);
      }
      return out;
    };

    const pluginMenus = [...registry.menus.values()].filter((m) => m.id !== '__core');

    /* ---------- 有参数：进下级 ---------- */
    if (arg) {
      // 1) 插件 id
      const m = registry.menus.get(arg);
      if (m) {
        return msg.replyMenu(`${m.title}${m.version ? ' v' + m.version : ''}`, menuGroupsOf(m));
      }

      // 2) 「插件」→ 插件列表
      if (raw === '插件' || arg === 'plugins') {
        if (!pluginMenus.length) {
          return msg.reply('还没有安装插件。把文件夹放进 plugins/ 就会出现在这里。');
        }
        return msg.replyMenu('插件', [
          {
            title: `共 ${pluginMenus.length} 个`,
            items: pluginMenus.map((x) => {
              const cnt = x.sections.reduce((n, s) => n + s.items.length, 0);
              return {
                text: x.id,
                desc: `${x.title}${cnt ? ` · ${cnt} 条` : ' · 未提供菜单'}`,
                cmd: `${P}help ${x.id}`,
              };
            }),
          },
        ]);
      }

      // 3) 内核分组名（基础 / 管理 / 其它）
      const secs = coreSections();
      const hit = secs.get(raw);
      if (hit) return msg.replyMenu(`内核 · ${raw}`, [{ title: raw, items: hit }]);

      const names = [...secs.keys(), '插件', ...pluginMenus.map((x) => x.id)];
      return msg.reply(`没有「${raw}」这个分类或插件。\n可用：${names.join('、')}`);
    }

    /* ---------- 没参数：简短主菜单 ---------- */
    /**
     * 主菜单只放两样东西：最常用的三条命令，和分类入口。
     *
     * 以前是把内核十几个命令全平铺出来，加上插件列表二十多行，
     * 手机上要滑两屏，而且大部分命令一个普通群成员根本用不到。
     */
    const secs = coreSections();
    const groups = [];

    const common = [];
    for (const name of ['ping', 'whoami', 'help']) {
      for (const items of secs.values()) {
        const it = items.find((x) => x.text === `${P}${name}`);
        if (it) {
          common.push(it);
          break;
        }
      }
    }
    if (common.length) groups.push({ title: '常用', items: common });

    const entries = [];
    for (const [title, items] of secs) {
      if (title === '其它') continue;
      // /admin 的 7 个子命令都显示成 `/admin`，去重后再列，否则一行全是重复
      const uniq = [...new Set(items.map((x) => x.text))];
      entries.push({
        text: title,
        desc: `${items.length} 条 · ${uniq.join(' ')}`,
        cmd: `${P}help ${title}`,
      });
    }
    if (pluginMenus.length) {
      entries.push({
        text: '插件',
        desc: `${pluginMenus.length} 个：${pluginMenus.map((x) => x.id).join('、')}`,
        cmd: `${P}help 插件`,
      });
    }
    if (entries.length) groups.push({ title: '分类', items: entries });

    const bot = runtime.botName || '菜单';
    await msg.replyMenu(bot, groups);
  });

  /**
   * /menu 是 /help 的别名。
   *
   * 直接复用 help 的 handler，而不是再写一份——两份菜单各自演化，
   * 迟早会出现「/help 里有、/menu 里没有」这种对不上的情况。
   */
  core('menu', { desc: '等同 /help，查看菜单' }, async (msg) => {
    const h = registry.commands.get('help')?.handler;
    if (h) await h(msg, { args: msg.args, raw: msg.content, bot: rt });
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
  // 归到「管理」组：单独开一组会让 /help 主菜单多出一个「权限子命令」入口，
  // 而它本来就是管理的一部分
  registry.addMenuSection('__core', { name: '内核' }, '管理', [
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

  /**
   * 分群插件开关。
   *
   * 和面板「群组 → 插件」「插件 → 分群开关」改的是同一份 cfg.plugins.groups，
   * 三个入口共用 plugin/groupscope.js 的翻译逻辑。
   *
   * 只影响分发时的判断，不动加载——插件在进程里是全局加载的，
   * 按群卸载等于每个群一套运行时，没必要。
   */
  core('群插件', { desc: '看/改这个群能用哪些插件（群管理）', admin: true }, async (msg) => {
    if (msg.kind !== 'group') return msg.reply('这个指令只能在群里用。');

    const chatId = msg.groupId;
    const spec = cfg.plugins ?? { mode: 'all', list: [] };
    const list = [...plugins.loaded.values()]
      .filter((p) => p.meta?.id && p.meta.id !== '__core')
      .sort((a, b) => a.meta.id.localeCompare(b.meta.id));

    const [act, ...rest] = msg.args;
    const pid = (rest[0] ?? '').trim();

    if (!act) {
      const lines = [`本群插件开关（${describeGroupScope(spec, chatId)}）：`];
      for (const p of list) {
        const on = pluginAllowedIn(spec, chatId, p.meta.id);
        lines.push(`${on ? '●' : '○'} ${p.meta.id} ${p.meta.name ?? ''}`);
      }
      lines.push('', `关掉：${P}群插件 关 <id>`, `打开：${P}群插件 开 <id>`, `恢复跟随全局：${P}群插件 重置`);
      return msg.reply(lines.join('\n'));
    }

    if (act === '重置') {
      cfg.plugins = { ...spec, groups: resetGroupPlugins(spec, chatId) };
      save();
      return msg.reply('已恢复为跟随全局。');
    }

    const want =
      act === '关' || act === '关闭' || act === 'off' || act === '0'
        ? false
        : act === '开' || act === '打开' || act === 'on' || act === '1'
          ? true
          : null;
    if (want === null) {
      return msg.reply(`用法：${P}群插件 关 <id> / ${P}群插件 开 <id> / ${P}群插件 重置`);
    }
    if (!pid) return msg.reply(`要给插件 id，先发 ${P}群插件 看列表。`);
    if (!list.some((p) => p.meta.id === pid)) return msg.reply(`没有这个插件：${pid}`);

    cfg.plugins = { ...spec, groups: toggleGroupPlugin(spec, chatId, pid, want) };
    save();
    const scope = describeGroupScope(cfg.plugins, chatId);
    return msg.reply(`${want ? '已在本群启用' : '已在本群关闭'} ${pid}（${scope}）`);
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
  let mockGroupInvited = false;
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
    // 群管：mock 下也走同一套闸门，方便本地验证插件的群管逻辑
    setGroupInvited(v) {
      mockGroupInvited = Boolean(v);
      return mockGroupInvited;
    },
    muteMembers: async (g, members) => {
      console.log(`\n→ [${botName}] [禁言 ${g}] ${JSON.stringify(members)}`);
      return {};
    },
    muteMember: async (g, uid, expireAt) => {
      console.log(`\n→ [${botName}] [禁言 ${g} ${uid}] ${expireAt || '立即解除'}`);
      return {};
    },
    getMuteStatus: async (g) => {
      console.log(`\n→ [${botName}] [查询禁言 ${g}]`);
      return { mute_list: [] };
    },
    getGroupInfo: async (g) => ({ group_openid: g, name: 'mock群', owner_openid: 'mock' }),
    // bot_state 是内邀接口，mock 同样走闸门；返回字段按官方文档来
    getBotGroupState: async (g) => {
      if (!mockGroupInvited) throw new Error('群管内邀功能未开启');
      console.log(`\n→ [${botName}] [机器人群内状态 ${g}]`);
      return {
        member_openid: 'mock-bot',
        joined_at: new Date().toISOString(),
        allow_proactive_msg: true,
        recv_msg_setting: 'all',
        member_role: 'admin', // mock 下默认当成群管理员，方便验证群管流程
      };
    },
    canManageGroup: async (g) => {
      if (!mockGroupInvited) {
        // 没开内邀就查不到角色：不拦截，让服务端去判
        return { ok: false, role: null, reason: '群管内邀功能未开启，无法预检' };
      }
      return { ok: true, role: 'admin', reason: '机器人是群管理员' };
    },
    clearRoleCache: () => {},
    getGroupMembers: async (g) => {
      if (!mockGroupInvited) throw new Error('群管内邀功能未开启');
      return { members: [], next_index: 0 };
    },
    getGroupMember: async (g, uid) => {
      if (!mockGroupInvited) throw new Error('群管内邀功能未开启');
      return { member_openid: uid, join_timestamp: 0 };
    },
    removeMembers: async (g, ids) => {
      if (!mockGroupInvited) throw new Error('群管内邀功能未开启');
      console.log(`\n→ [${botName}] [踢人 ${g}] ${JSON.stringify(ids)}`);
      return { fail_openids: [] };
    },
    getGroupBlacklist: async (g) => {
      if (!mockGroupInvited) throw new Error('群管内邀功能未开启');
      return { blacklist: [] };
    },
    operateGroupBlacklist: async (g, { op, member_openids }) => {
      if (!mockGroupInvited) throw new Error('群管内邀功能未开启');
      console.log(`\n→ [${botName}] [黑名单 ${op} ${g}] ${JSON.stringify(member_openids)}`);
      return { fail_openids: [] };
    },
    // 入群申请与自动审批：公开接口，mock 直接返回空列表
    getJoinRequests: async (g) => {
      console.log(`\n→ [${botName}] [入群申请列表 ${g}]`);
      return { request_list: [], cursor: '' };
    },
    handleJoinRequest: async (g, uid, body) => {
      console.log(`\n→ [${botName}] [审批入群 ${g} ${uid}] ${body.op}`);
      return {};
    },
    approveJoinRequest: async (g, uid, rid) => {
      console.log(`\n→ [${botName}] [通过入群 ${g} ${uid}] ${rid || ''}`);
      return {};
    },
    declineJoinRequest: async (g, uid, body = {}) => {
      console.log(`\n→ [${botName}] [拒绝入群 ${g} ${uid}] ${body.rejectReason || ''}`);
      return {};
    },
    listJoinStrategies: async () => {
      console.log(`\n→ [${botName}] [审批策略列表]`);
      return { strategy_list: [], cursor: '' };
    },
    createJoinStrategy: async (p) => {
      console.log(`\n→ [${botName}] [创建审批策略] ${JSON.stringify(p)}`);
      return { strategy_id: 'st_mock' };
    },
    updateJoinStrategy: async (id, p) => {
      console.log(`\n→ [${botName}] [修改审批策略 ${id}] ${JSON.stringify(p)}`);
      return {};
    },
    deleteJoinStrategy: async (id) => {
      console.log(`\n→ [${botName}] [删除审批策略 ${id}]`);
      return {};
    },
    executeJoinStrategy: async (id) => {
      console.log(`\n→ [${botName}] [执行审批策略 ${id}]（官方异步，约 10 分钟完成）`);
      return {};
    },
    updateStrategyWhitelist: async (id, { op, whitelist_users }) => {
      console.log(`\n→ [${botName}] [白名单 ${op} ${id}] ${(whitelist_users || []).length} 个号码`);
      return { fail_users: [] };
    },
    // 流式消息与全局菜单：公开接口
    sendStreamMessage: async (openid, p) => {
      console.log(
        `\n→ [${botName}] [流式消息 ${openid}] 第 ${p.index ?? 0} 片 state=${p.state ?? 1} ` +
          `mode=${p.mode ?? 'append'}: ${String(p.contentRaw ?? '').slice(0, 40)}`,
      );
      return { id: `mock-stream-${p.index ?? 0}` };
    },
    getGlobalMenu: async () => {
      console.log(`\n→ [${botName}] [查询全局菜单]`);
      return { menu: { items: [] } };
    },
    setGlobalMenu: async (items) => {
      console.log(`\n→ [${botName}] [设置全局菜单] ${(items || []).length} 项`);
      return {};
    },
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
  // 下载源是全局的，模块里缓存一份，免得每个调用点都传配置
  configureMirror(globalCfg);
  setLevel(globalCfg.logLevel);
  runtime.startedAt = Date.now();

  /**
   * 兜底：任何漏网的异步异常都不要让进程直接死。
   *
   * Node 22+ 对未捕获的 rejection 默认终止进程——一个畸形请求、一条发不出去的
   * 消息，就会把面板和**所有**机器人一起带走。这里记日志后继续跑；
   * 真正的清理交给 SIGINT/SIGTERM 那条路。
   */
  process.on('unhandledRejection', (e) => {
    log.error(`未捕获的异步异常（已忽略，进程继续）：${e?.stack || e?.message || e}`);
  });
  process.on('uncaughtException', (e) => {
    log.error(`未捕获的异常（已忽略，进程继续）：${e?.stack || e?.message || e}`);
  });

  if (globalCfg.logs?.enabled !== false) {
    await attachLogFile('core', PATHS.coreLog, { maxBytes: globalCfg.logs?.maxBytes });
  }

  /**
   * 上次更新如果被强杀（断电 / 任务管理器结束），src/ 可能是半新半旧。
   * 必须在加载任何代码之前回滚——晚一步就是在混着两个版本的进程里跑。
   */
  const recovered = await recoverInterruptedUpdate().catch((e) => {
    log.error(`检查未完成的更新时出错：${e.message}`);
    return { recovered: false };
  });
  if (recovered.recovered) {
    /**
     * 回滚后**必须退出**，不能接着跑。
     *
     * 模块是在这行之前 import 的，此刻内存里装的还是「被打断的那一版」，
     * 而磁盘已经回到旧版了。继续跑就是「用新代码读旧文件」，
     * 报错会指向一堆莫名其妙的地方。让用户重启一次，两边就一致了。
     */
    log.warn(
      `已回滚上次未完成的更新（${recovered.from} → ${recovered.to}），请重新启动一次`,
    );
    await flushLogs().catch(() => {});
    process.exit(0);
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

  // Webhook 接收服务：全局一个端口，按 AppID 分流给各个机器人。
  // 只有机器人配了 connection.mode=webhook 才需要它，但开着也不占多少资源。
  let webhookServer = null;
  if (globalCfg.webhook?.enabled) {
    webhookServer = new WebhookServer({
      host: globalCfg.webhook.host,
      port: globalCfg.webhook.port,
      path: globalCfg.webhook.path,
      // 默认验签；只在排查「验签总是失败」时可以显式关掉
      verifySignature: globalCfg.webhook.verifySignature !== false,
    });
    try {
      const port = await webhookServer.start();
      if (globalCfg.webhook.publicUrl) {
        log.info(`Webhook 对外地址（请到开放平台填写）: ${globalCfg.webhook.publicUrl}${webhookServer.path}`);
      } else {
        log.info(`Webhook 已监听 :${port}${webhookServer.path}，公网部署请配反向代理和 HTTPS`);
      }
    } catch (e) {
      log.error(`Webhook 启动失败: ${e.message}（webhook 模式的机器人将无法收事件）`);
      webhookServer = null;
    }
  } else {
    // 有人配了 webhook 模式但没开服务，提前说清楚
    const wantWebhook = botCfgs.filter((c) => c.enabled !== false && c.connection?.mode === 'webhook');
    if (wantWebhook.length) {
      log.warn(
        `有 ${wantWebhook.length} 个机器人配了 webhook 模式，但全局配置 webhook.enabled=false，` +
          `它们收不到事件。去 config/bot.json 打开`,
      );
    }
  }

  // 建运行时
  const runtimes = [];
  for (const cfg of botCfgs) {
    if (cfg.enabled === false) {
      log.info(`机器人 ${cfg.id}（${cfg.name}）已禁用，跳过`);
      continue;
    }
    if (!MOCK && (!cfg.appId || !cfg.appSecret)) {
      // 注意要**把返回值写回 cfg**：ensureBotCredentials 返回的是重新读出来的配置，
      // 不写回的话下面 new BotRuntime 拿到的还是空凭证，
      // 用户明明输了 AppID 却报「缺少 AppID / AppSecret」。
      Object.assign(cfg, await ensureBotCredentials(cfg.id));
    }
    const rt = new BotRuntime({
      cfg,
      globalCfg,
      mock: MOCK,
      webhook: webhookServer,
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

  /* ---------------- 后台服务 ---------------- */

  /**
   * 健康巡检、文件清理、配置热加载、定时重启、检查更新。
   * 都是增强，单个失败不影响主程序。
   */
  const services = new Services({
    globalCfg,
    getRuntimes: () => runtimes,
    // 手改配置后同步到运行时（能热的字段）
    onConfigReload: (nextGlobal, nextBot) => {
      if (nextBot) {
        const rt = runtimes.find((r) => r.id === nextBot.id);
        if (rt) {
          // 只同步能热改的字段。appId/appSecret 变了要重连，
          // intents 变了也要重连，这些交给面板的保存逻辑处理。
          const hot = ['commandPrefix', 'owners', 'whitelist', 'rateLimit', 'dedupWindowSec', 'groupManage', 'messageLog'];
          for (const k of hot) {
            if (nextBot[k] !== undefined) rt.cfg[k] = nextBot[k];
          }
          /**
           * plugins 单独处理：它是对象，而且分群开关（groups）会随面板/指令频繁改。
           * 之前漏了它，导致「改了配置、提示已热加载、行为却没变」——
           * 面板上关掉的插件在群里照样能用，反过来也一样。
           * 用 Object.assign 保留外层对象引用，别处拿着 cfg.plugins 的不会看到旧值。
           */
          if (nextBot.plugins) {
            if (!rt.cfg.plugins) rt.cfg.plugins = nextBot.plugins;
            else Object.assign(rt.cfg.plugins, nextBot.plugins);
          }
          rt.log.info('配置已热加载');
        }
      }
    },
    // 定时重启：先优雅关闭，再拉起新进程
    onRestart: async () => {
      log.warn('定时重启：正在关闭当前进程…');
      await shutdown({ restarting: true });
    },
  });

  const shutdown = async ({ restarting = false } = {}) => {
    if (shutdown.called) return;
    shutdown.called = true;
    log.info('正在退出...');
    await services.stop().catch(() => {});
    web?.close();
    await webhookServer?.stop().catch(() => {});
    for (const rt of runtimes) await rt.stop().catch(() => {});
    await flushLogs().catch(() => {});
    if (restarting) {
      // 拉起新进程后退出，裸机部署也能自愈
      try {
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(),
          detached: true,
          stdio: 'inherit',
          env: { ...process.env, ROOST_RESTARTED: '1' },
        });
        child.unref();
        log.info(`已拉起新进程 pid=${child.pid}，当前进程退出`);
      } catch (e) {
        log.error(`拉起新进程失败：${e.message}，请手动重启`);
      }
    }
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
    mock: MOCK,
    saveBotConfig,
    saveGlobalConfig,
    onShutdown: shutdown,
    services,

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
        /**
         * webhook 服务必须传进来。
         * 以前这里漏了：全局开着 webhook 时，面板新建的 webhook 机器人
         * 会直接报「配置选了 webhook 模式，但 Webhook 服务没启动」——
         * 而服务其实好端端跑着，必须重启进程才能恢复。
         */
        webhook: webhookServer,
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
      // mock 下也把服务拉起来，方便测服务本身（清理、健康巡检等）
      await services.start();
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

  // 后台服务放在最后启动，不干扰启动流程的日志
  await services.start();

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
