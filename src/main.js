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

const log = createLogger('core');
const args = new Set(process.argv.slice(2));
const MOCK = args.has('--mock');
const CHECK_ONLY = args.has('--check');

if (args.has('--help') || args.has('-h')) {
  console.log(`
QQ 机器人内核

用法:
  node src/main.js              连接 QQ，正常跑
  node src/main.js --check      只验证 AppID/AppSecret 和网关，不常驻
  node src/main.js --mock       不连 QQ，用本地假消息开发插件
  node src/main.js --help       看这个帮助

配置:
  config.json                   AppID / AppSecret / intents / owners
  环境变量                       QQ_BOT_APPID / QQ_BOT_SECRET / QQ_BOT_OWNERS
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 核心命令：不依赖任何插件，保证机器人一启动就能用                      */
/* ------------------------------------------------------------------ */

function registerCoreCommands(registry, { cfg, plugins, registryRef }) {
  const P = cfg.commandPrefix || '/';
  const isOwner = (uid) => cfg.owners.includes(uid);

  const core = (name, meta, handler) =>
    registry.addCommand('__core', name, { plugin: '内核', ...meta }, handler);

  core('help', { desc: '查看所有可用命令' }, async (msg) => {
    const groups = new Map();
    for (const [, c] of registry.commands) {
      if (c.admin && !isOwner(msg.userId)) continue;
      if (!groups.has(c.plugin)) groups.set(c.plugin, []);
      groups.get(c.plugin).push(c);
    }
    const lines = ['可用命令：'];
    for (const [plugin, cmds] of groups) {
      lines.push(`\n【${plugin}】`);
      for (const c of cmds) {
        lines.push(`  ${P}${c.name}${c.desc ? '  — ' + c.desc : ''}`);
      }
    }
    lines.push(`\n插件共 ${plugins.loaded.size} 个，发 ${P}plugins 查看`);
    await msg.reply(lines.join('\n'));
  });

  core('ping', { desc: '测试机器人是否在线' }, async (msg) => {
    const t = Date.now();
    await msg.reply(`pong（${Date.now() - t}ms）`);
  });

  core('whoami', { desc: '查看自己的 openid（配置主人用）' }, async (msg) => {
    const lines = [
      `来源: ${msg.kind}`,
      `你的 openid: ${msg.userId}`,
      msg.groupId ? `群 openid: ${msg.groupId}` : '',
      `是否主人: ${isOwner(msg.userId) ? '是' : '否'}`,
    ].filter(Boolean);
    await msg.reply(lines.join('\n'));
  });

  core('claim', { desc: '认领机器人主人身份（仅在未设置主人时可用）' }, async (msg) => {
    if (cfg.owners.length > 0) {
      return msg.reply('已经设置过主人了。如需变更，请直接改 config.json 的 owners 字段。');
    }
    cfg.owners.push(msg.userId);
    await saveConfig(cfg);
    await msg.reply(`已把你设为主人：${msg.userId}\n已写入 config.json，重启后依然有效。`);
  });

  core('plugins', { desc: '列出插件与状态' }, async (msg) => {
    const list = plugins.list();
    if (!list.length) return msg.reply('还没有安装任何插件。把插件文件夹放进 plugins/ 即可。');
    const lines = ['插件列表：'];
    for (const p of list) {
      const flag = p.loaded ? '运行中' : p.enabled ? '未加载' : '已禁用';
      const ver = p.version ? ` v${p.version}` : '';
      const desc = p.description ? ` ${p.description}` : '';
      lines.push(`${p.loaded ? '●' : '○'} ${p.id}${ver} [${flag}]${desc}`);
      if (p.error) lines.push(`    错误: ${p.error}`);
    }
    if (isOwner(msg.userId)) {
      lines.push(`\n管理: ${P}enable <id> / ${P}disable <id> / ${P}reload <id>`);
    }
    await msg.reply(lines.join('\n'));
  });

  core('enable', { desc: '启用插件', admin: true, usage: `${P}enable <插件id>` }, async (msg) => {
    const id = msg.args[0];
    if (!id) return msg.reply(`用法: ${P}enable <插件id>`);
    const ok = await plugins.setEnabled(id, true);
    await msg.reply(ok ? `已启用 ${id}` : `启用失败，查看日志或 ${P}plugins 看错误`);
  });

  core('disable', { desc: '禁用插件', admin: true, usage: `${P}disable <插件id>` }, async (msg) => {
    const id = msg.args[0];
    if (!id) return msg.reply(`用法: ${P}disable <插件id>`);
    await plugins.setEnabled(id, false);
    await msg.reply(`已禁用 ${id}`);
  });

  core('reload', { desc: '重载插件（不传 id 则全部重载）', admin: true }, async (msg) => {
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

function createDispatcher({ registry, api, cfg, plugins }) {
  const isOwner = (uid) => cfg.owners.includes(uid);

  return async function dispatch(eventName, d) {
    if (!isMessageEvent(eventName)) {
      // 非消息事件（入群、加好友等）直接抛给监听者
      for (const l of registry.listeners.get(eventName) ?? []) {
        try {
          await l.handler(d, { event: eventName, api });
        } catch (e) {
          log.error(`监听器 ${l.pluginId} 处理 ${eventName} 出错:`, e.message);
        }
      }
      return;
    }

    const msg = buildMessage(eventName, d, { api, cfg });

    // 1) 命令优先
    if (msg.isCommand) {
      const entry = registry.commands.get(msg.command);
      if (entry) {
        if (entry.admin && !isOwner(msg.userId)) {
          return msg.reply('这个命令只有机器人主人能用。发 /whoami 查看自己的 openid。');
        }
        // 必填参数校验：模式里 <xxx> 的个数
        const required = (entry.pattern?.match(/<[^>]+>/g) ?? []).length;
        if (msg.args.length < required) {
          return msg.reply(`参数不够\n用法: ${entry.usage}`);
        }
        try {
          await entry.handler(msg, { args: msg.args, raw: msg.content });
        } catch (e) {
          log.error(`命令 ${entry.name}（插件 ${entry.pluginId}）执行出错:`, e.stack || e.message);
          await msg.reply(`执行出错: ${e.message}`).catch(() => {});
        }
        return;
      }
      // 未知命令：给个提示，避免用户以为机器人死了
      const P = cfg.commandPrefix || '/';
      return msg
        .reply(`没有这个命令：${P}${msg.command}\n发 ${P}help 查看全部命令`)
        .catch(() => {});
    }

    // 2) 其余交给监听者：先 'message' 统一入口，再原始事件名
    for (const evt of ['message', eventName]) {
      for (const l of registry.listeners.get(evt) ?? []) {
        try {
          await l.handler(msg);
        } catch (e) {
          log.error(`监听器 ${l.pluginId} 处理 ${evt} 出错:`, e.stack || e.message);
        }
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Mock 模式：没有凭证也能开发插件                                       */
/* ------------------------------------------------------------------ */

function createMockApi() {
  const echo = (scene) => async (target, body) => {
    console.log(`\n→ [${scene} ${target}] ${body?.content ?? JSON.stringify(body)}`);
    return { id: 'mock', timestamp: Date.now() };
  };
  return {
    sendGroup: echo('群'),
    sendC2C: echo('私聊'),
    postGroupFile: async () => ({ file_info: 'mock' }),
    postC2CFile: async () => ({ file_info: 'mock' }),
    getGateway: async () => ({ url: 'wss://mock' }),
  };
}

async function runMock(cfg, registry, plugins) {
  console.log('\n=== Mock 模式 ===');
  console.log('不连接 QQ，用本地假消息验证插件逻辑。输入内容回车发送，Ctrl+C 退出。\n');

  const dispatch = createDispatcher({ registry, api: createMockApi(), cfg, plugins });
  const fakeUser = cfg.owners[0] ?? 'mock-user-openid';
  const fakeGroup = 'mock-group-openid';
  let seq = 0;

  const feed = (line) =>
    dispatch('GROUP_AT_MESSAGE_CREATE', {
      id: `mock-${++seq}`,
      content: line,
      group_openid: fakeGroup,
      author: { member_openid: fakeUser },
      timestamp: String(Date.now()),
    });

  // 管道输入（自动化测试）：一次性读完，逐行处理
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      console.log(`你> ${line}`);
      await feed(line);
    }
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
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const cfg = await loadConfig();
  setLevel(cfg.logLevel);

  const registry = new Registry();
  let api = null;
  let tokens = null;

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
  } else if (CHECK_ONLY) {
    log.info('mock 模式下 --check 无意义，已跳过');
    return;
  }

  const plugins = new PluginManager({
    pluginsDir: path.join(ROOT, 'plugins'),
    registry,
    api: api ?? createMockApi(),
    cfg,
    isOwner: (uid) => cfg.owners.includes(uid),
  });

  registerCoreCommands(registry, { cfg, plugins, registryRef: registry });
  await plugins.scan();

  if (MOCK) {
    await runMock(cfg, registry, plugins);
    return;
  }

  if (!cfg.owners.length) {
    log.warn('尚未设置主人。请在群里 @机器人 发送 /claim 认领，或手动填写 config.json 的 owners。');
  }

  const dispatch = createDispatcher({ registry, api, cfg, plugins });
  const gateway = new Gateway({
    api,
    tokens,
    intents: cfg.intents,
    onDispatch: dispatch,
  });

  log.info(`配置: ${CONFIG_PATH}`);
  log.info(`intents=${cfg.intents}（${cfg.intents === 1 << 25 ? '群聊@ + 私聊' : '自定义'}）`);

  await gateway.start();

  const shutdown = () => {
    log.info('正在退出...');
    gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
