import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ROOT, DIRS, PATHS, botPaths, ensureDirs, listBotIds, rel } from './paths.js';

// 兼容旧的导入方式
export { ROOT, PATHS, DIRS };
export const CONFIG_PATH = PATHS.globalConfig;

/* ------------------------------------------------------------------ */
/* 两套默认值                                                          */
/* ------------------------------------------------------------------ */

/** 全局配置：管进程本身（面板、日志、插件依赖策略） */
const GLOBAL_DEFAULTS = {
  logLevel: 'info',
  cooldownHint: true,

  webui: {
    enabled: true,
    host: '127.0.0.1',
    port: 15207,
    accessKey: '',
    portTries: 20,
    openBrowser: true,
  },

  logs: {
    enabled: true,
    maxBytes: 5 * 1024 * 1024,
  },

  /**
   * Webhook 接收服务（全局一个端口，服务所有选了 webhook 模式的机器人）。
   * 不开就不占端口；开了以后每个机器人靠 AppID 分流。
   * 公网部署时记得把 path 暴露出去，并配好 HTTPS 反代。
   */
  webhook: {
    enabled: false,
    host: '0.0.0.0',
    port: 15208,
    path: '/webhook',
    /** 对外可访问的完整地址，只用于面板显示和提示，不参与逻辑 */
    publicUrl: '',
  },

  /**
   * 下载源。国内直连 GitHub 经常超时，插件市场和框架更新都会失败。
   * 这里让用户自己选，面板上有「测速」按钮，按自己网络实际情况挑。
   *
   *   mirror      auto（直连优先，失败切镜像）/ github / ghfast / ghproxy
   *               / gh-proxy / kkgithub / custom
   *   mirrorCustom  选 custom 时的前缀，如 https://my-proxy.example/
   *   mirrorChyanResId / mirrorChyanCdk
   *               MirrorChyan（BGI / MAA 用的 CDN）的资源 ID 与 CDK。
   *               填了才启用，且**只用来查版本**——它分发的是项目方上传的包，
   *               格式不一定是我们的 tar.gz。
   */
  network: {
    mirror: 'auto',
    mirrorCustom: '',
    mirrorChyanResId: '',
    mirrorChyanCdk: '',
  },

  /**
   * 后台服务开关。都是增强，关掉不影响机器人跑。
   */
  services: {
    /** 每分钟采样内存/积压/重连，超阈值告警 */
    health: true,
    /** 清临时目录、旧备份、过期日志 */
    cleanup: true,
    /** 手改 config/*.json 不用重启 */
    configWatch: true,
  },

  cleanup: {
    /** 更新备份保留几份 */
    keepBackups: 3,
    /** 日志保留天数 */
    keepLogDays: 14,
  },

  /**
   * 定时重启。长时间跑内存碎片、句柄泄漏是慢慢积累的，
   * 每天重启一次比事后排查便宜。
   *   "at": "04:00"      每天这个点
   *   "everyHours": 12   每 N 小时
   * 两个都填以 at 为准。
   */
  restart: {
    enabled: false,
    at: '',
    everyHours: 0,
  },

  /**
   * 框架自身更新。
   * autoCheck 只检查不安装（默认），发现新版在面板提示。
   * autoApply 会自动装——**默认关**，开了就要接受装到有 bug 版本的风险。
   */
  update: {
    autoCheck: true,
    autoApply: false,
    intervalHours: 6,
  },

  plugins: {
    autoInstallDeps: true,
    /** Go 插件用的 go 可执行文件路径，留空则用 PATH 里的 go 或 GO_BIN 环境变量 */
    goBin: '',
    /** 插件市场索引地址，换成你自己的插件仓库即可 */
    marketUrl: 'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost-plugins/main/index.json',
    /**
     * 插件热重载：改完插件代码存盘两秒后自动生效。
     * 默认开——开发插件时不用反复重启或点「重载」。
     * 生产环境想省这点 CPU 可以关掉，改完手动点重载。
     */
    hotReload: true,
    /** 轮询间隔（毫秒），默认 2 秒 */
    hotReloadInterval: 2000,
    /**
     * 跳过插件的框架版本校验。插件在 plugin.json 里写了 frameworkVersion，
     * 当前框架不满足时会拒绝加载；作者本地调试想硬跑可以打开这个开关。
     */
    ignoreFrameworkVersion: false,
  },
};

/** 机器人配置：管连接与行为，每个机器人一份 */
const BOT_DEFAULTS = {
  name: '',
  enabled: true,

  appId: '',
  appSecret: '',
  baseUrl: 'https://api.bot.qq.com',
  // GROUP_AND_C2C_EVENT = 1 << 25，群聊 @机器人 + 私聊消息
  intents: 1 << 25,
  commandPrefix: '/',
  owners: [],

  whitelist: {
    enabled: false,
    groups: [],
    users: [],
  },

  rateLimit: {
    enabled: true,
    perChatPerMinute: 30,
  },

  /**
   * 收事件的方式：
   *   websocket —— 长连接，本地跑最省心（默认）
   *   webhook   —— 平台 HTTP 回调，适合公网部署 / Serverless
   * 两种模式下**发消息都走 HTTP API**，行为一致。
   */
  connection: {
    mode: 'websocket',
  },

  dedupWindowSec: 120,

  messageLog: {
    enabled: true,
    muteKinds: [],
  },

  outbound: {
    perSec: 4,
    dailyActive: 20,
    downgradeToActive: true,
  },

  session: {
    stickySec: 180,
    promptTimeoutSec: 120,
  },

  /**
   * 统计：消息量、活跃人数、命令排行。
   * 只记数量与时间，**不记消息正文**——正文落库会让人不敢用。
   * 需要 Node 22.5+ 的内置 SQLite，没有就自动降级为不统计。
   */
  stats: {
    enabled: true,
    /** 明细保留天数，超出的自动清掉；成员档案不清 */
    retentionDays: 90,
  },

  /**
   * 启用哪些插件。三态：
   *   all     — 全部启用，新装插件自动生效
   *   include — 只启用 list 里的
   *   exclude — 除了 list 里的都启用
   *
   * 默认 all：**装了就用**。
   *
   * 早先的默认是 `include` + 空 list（想「避免误触发」），结果是灾难：
   * 用户从市场装了插件 → 不在名单里 → 不加载 → 面板只列已加载的 →
   * 用户看不到这个插件、也没法启用 → 永远「装了不生效」。
   * 装插件本来就是为了用，默认启用才符合直觉。
   *
   * 需要精细控制（比如某个机器人不跑某几个插件）的，自己改成 include 或 exclude。
   */
  plugins: {
    mode: 'all',
    list: [],
    /**
     * 启动时自动更新有新版的内邀/公开插件。默认 false：
     * 自动更新会覆盖 plugins/ 里的目录，用户自己改过的代码会丢，
     * 这种事必须先问过。打开后每次启动检查一次，只更市场里标记过的插件。
     */
    autoUpdate: false,
    /** 在这个版本之前不再弹更新提示（用户选「知道了」后写入） */
    muteUpdateBelow: '',
  },

  /**
   * 群管能力。官方群管理接口分两档：
   *   公开  —— 禁言、撤回、群基本信息、机器人群内状态，随时可用
   *   内邀  —— 群成员列表/信息、批量移除（踢人）、群黑名单，
   *            普通机器人调用返回 11253，需先向平台运营申请白名单
   * invited 默认 false：没申请的机器人不该去调，调了也是报错，
   * 还会在日志里留一堆无意义的 11253。申请到了再回面板打开。
   */
  groupManage: {
    invited: false,
  },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`${rel(file)} 解析失败: ${e.message}`);
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

const exists = (p) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/* ------------------------------------------------------------------ */
/* 全局配置                                                            */
/* ------------------------------------------------------------------ */

export async function loadGlobalConfig() {
  await ensureDirs();
  const file = (await readJson(PATHS.globalConfig)) ?? {};
  const cfg = deepMerge(GLOBAL_DEFAULTS, file);

  // 兼容旧字段：webui.token → webui.accessKey
  if (!cfg.webui.accessKey && cfg.webui.token) {
    cfg.webui.accessKey = cfg.webui.token;
    delete cfg.webui.token;
  }

  /**
   * 环境变量覆盖（容器部署用）。
   * Docker 里配置文件是挂载进来的，改完要重建容器；用环境变量可以直接调，
   * 而且镜像能保持「无状态」——同一份镜像跑不同实例。
   *
   * 优先级：环境变量 > 配置文件 > 默认值。
   * 只在环境变量**有值**时覆盖，不写就完全不影响。
   */
  const env = process.env;
  if (env.ROOST_WEBUI_HOST) cfg.webui.host = env.ROOST_WEBUI_HOST;
  if (env.ROOST_WEBUI_PORT) {
    const p = Number(env.ROOST_WEBUI_PORT);
    if (Number.isInteger(p) && p > 0 && p < 65536) cfg.webui.port = p;
  }
  if (env.ROOST_WEBUI_KEY) cfg.webui.accessKey = env.ROOST_WEBUI_KEY;
  if (env.ROOST_LOG_LEVEL) cfg.logLevel = env.ROOST_LOG_LEVEL;

  // Webhook：容器里想开回调，两个变量就够
  if (env.ROOST_WEBHOOK_ENABLED) {
    cfg.webhook.enabled = !/^(0|false|no|off)$/i.test(env.ROOST_WEBHOOK_ENABLED);
  }
  if (env.ROOST_WEBHOOK_PORT) {
    const p = Number(env.ROOST_WEBHOOK_PORT);
    if (Number.isInteger(p) && p > 0 && p < 65536) cfg.webhook.port = p;
  }
  if (env.ROOST_WEBHOOK_PATH) cfg.webhook.path = env.ROOST_WEBHOOK_PATH;
  if (env.ROOST_WEBHOOK_PUBLIC_URL) cfg.webhook.publicUrl = env.ROOST_WEBHOOK_PUBLIC_URL;

  return cfg;
}

export async function saveGlobalConfig(cfg) {
  await writeJson(PATHS.globalConfig, {
    logLevel: cfg.logLevel,
    cooldownHint: cfg.cooldownHint,
    webui: cfg.webui,
    logs: cfg.logs,
    // 白名单漏了这两项会把用户配好的 webhook / 下载源从文件里抹掉：
    // 面板保存任意全局设置都会走到这里，重启后配置就悄悄回默认了。
    webhook: cfg.webhook,
    network: cfg.network,
    plugins: cfg.plugins,
  });
}

/* ------------------------------------------------------------------ */
/* 机器人配置                                                          */
/* ------------------------------------------------------------------ */

/**
 * 读一个机器人的配置。返回的对象带 `id`。
 * @param {string} id
 */
export async function loadBotConfig(id) {
  const p = botPaths(id);
  const file = await readJson(p.config);
  if (!file) throw new Error(`机器人配置不存在: ${rel(p.config)}`);

  const cfg = deepMerge(BOT_DEFAULTS, file);
  cfg.id = id;
  if (!cfg.name) cfg.name = id;

  // 环境变量只在配置文件没写时才兜底，避免多机器人时互相串
  if (!cfg.appId && process.env.QQ_BOT_APPID) cfg.appId = process.env.QQ_BOT_APPID;
  if (!cfg.appSecret && process.env.QQ_BOT_SECRET) cfg.appSecret = process.env.QQ_BOT_SECRET;
  if (!file.baseUrl && process.env.QQ_BOT_BASE_URL) cfg.baseUrl = process.env.QQ_BOT_BASE_URL;
  if (!file.owners?.length && process.env.QQ_BOT_OWNERS) {
    cfg.owners = process.env.QQ_BOT_OWNERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * 纠正旧默认值。
   *
   * 0.5.4 之前 BOT_DEFAULTS 是 `mode:'include' + list:[]`，字面意思「一个都不启用」。
   * 结果是用户从市场装了插件也永远不加载，而面板只列已加载的插件，
   * 用户既看不到它、也没法启用——死循环。
   *
   * 只在内存里纠正，**不改用户文件**。用户真想全禁用就自己把 mode 设成 exclude。
   */
  if (cfg.plugins?.mode === 'include' && !cfg.plugins.list?.length) {
    cfg.plugins.mode = 'all';
    // 这里不能用 logger：logger 依赖 config，会成环。控制台提示够用了。
    console.warn(
      `[提示] 机器人 ${id} 的插件模式是 include 但名单为空（等于全禁用），` +
        `已按 all 处理。想恢复精细控制请编辑 config/bots/${id}.json`,
    );
  }

  return cfg;
}

export async function saveBotConfig(id, cfg) {
  const p = botPaths(id);
  await writeJson(p.config, {
    name: cfg.name,
    enabled: cfg.enabled !== false,
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    baseUrl: cfg.baseUrl,
    intents: cfg.intents,
    commandPrefix: cfg.commandPrefix,
    owners: cfg.owners,
    whitelist: cfg.whitelist,
    rateLimit: cfg.rateLimit,
    dedupWindowSec: cfg.dedupWindowSec,
    connection: cfg.connection ?? { mode: 'websocket' },
    messageLog: cfg.messageLog,
    outbound: cfg.outbound,
    session: cfg.session,
    stats: cfg.stats ?? { enabled: true, retentionDays: 90 },
    plugins: cfg.plugins,
    groupManage: cfg.groupManage ?? { invited: false },
  });
}

/** 读全部机器人配置（坏配置跳过，不阻塞其他机器人） */
export async function loadAllBotConfigs() {
  const ids = await listBotIds();
  const out = [];
  for (const id of ids) {
    try {
      out.push(await loadBotConfig(id));
    } catch {
      /* 坏配置跳过 */
    }
  }
  return out;
}

/** 新建一个机器人配置 */
export async function createBotConfig(id, patch = {}) {
  const p = botPaths(id);
  if (await exists(p.config)) throw new Error(`机器人 ${id} 已存在`);
  const cfg = deepMerge(BOT_DEFAULTS, { ...patch, name: patch.name || id });
  cfg.id = id;
  await ensureDirs(id);
  await saveBotConfig(id, cfg);
  return cfg;
}

/* ------------------------------------------------------------------ */
/* 迁移：单机器人 → 多机器人                                            */
/* ------------------------------------------------------------------ */

/**
 * 搬一个文件，**校验通过才删原文件**。
 * 任何一步失败都抛错，原文件保持不动。
 */
async function moveFile(from, to) {
  if (!(await exists(from))) return false;
  const buf = await fs.readFile(from);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.writeFile(to, buf);

  // 校验：读回来必须逐字节一致，才敢删原件
  const back = await fs.readFile(to);
  if (!back.equals(buf)) throw new Error(`迁移校验失败: ${rel(from)} → ${rel(to)}`);
  await fs.unlink(from);
  return true;
}

/**
 * 首次启动时把旧结构迁到多机器人结构。
 *
 * 用户要求「迁移后不保留旧文件」，所以顺序是：
 *   读旧 → 写新 → 校验 → 删旧
 * 任何一步失败就抛错中止，旧文件不会被破坏。
 *
 * @returns {Promise<{migrated:boolean, botId?:string, moved:string[]}>}
 */
export async function migrateToMultiBot() {
  if (await exists(PATHS.migratedFlag)) return { migrated: false, moved: [] };

  const existing = await listBotIds();
  if (existing.length) {
    await writeJson(PATHS.migratedFlag, { at: Date.now(), note: '已有机器人配置，跳过迁移' });
    return { migrated: false, moved: [] };
  }

  // 找旧配置：优先 config/bot.json，其次根目录 config.json
  let legacy = await readJson(PATHS.globalConfig);
  if (!legacy) legacy = await readJson(PATHS.legacyConfig);

  // 没有 appId 说明是全新安装
  if (!legacy?.appId) {
    await writeJson(PATHS.migratedFlag, { at: Date.now(), note: '全新安装，无需迁移' });
    return { migrated: false, moved: [] };
  }

  const botId = 'main';
  const p = botPaths(botId);
  const moved = [];

  // 1) 机器人配置
  const botCfg = {
    name: '默认机器人',
    enabled: true,
    appId: legacy.appId,
    appSecret: legacy.appSecret,
    baseUrl: legacy.baseUrl,
    intents: legacy.intents,
    commandPrefix: legacy.commandPrefix,
    owners: legacy.owners,
    whitelist: legacy.whitelist,
    rateLimit: legacy.rateLimit,
    dedupWindowSec: legacy.dedupWindowSec,
    messageLog: legacy.messageLog,
    outbound: legacy.outbound,
    session: legacy.session,
    // 老用户原本就在用的插件，迁移后保持全部启用——
    // 不能因为默认值改成 include 就把人家在跑的插件悄悄停掉
    plugins: { mode: 'all', list: [] },
  };
  await ensureDirs(botId);
  await writeJson(p.config, deepMerge(BOT_DEFAULTS, botCfg));
  moved.push(rel(p.config));

  // 2) 数据文件
  for (const [from, to] of [
    [path.join(DIRS.data, 'groups.json'), p.groups],
    [path.join(DIRS.data, 'roles.json'), p.roles],
    [path.join(DIRS.data, 'quota.json'), p.quota],
    [path.join(DIRS.data, 'plugins.json'), p.pluginState],
  ]) {
    if (await moveFile(from, to)) moved.push(rel(to));
  }

  // 3) 插件存档
  for (const [dir, target, ext] of [
    [path.join(DIRS.data, 'plugins'), p.pluginDataDir, '.json'],
    [path.join(DIRS.logs, 'plugins'), p.pluginLogDir, '.log'],
    [path.join(DIRS.config, 'plugins'), p.pluginConfigDir, '.json'],
  ]) {
    try {
      const files = await fs.readdir(dir);
      for (const f of files.filter((x) => x.endsWith(ext))) {
        if (await moveFile(path.join(dir, f), path.join(target, f))) {
          moved.push(rel(path.join(target, f)));
        }
      }
    } catch {
      /* 目录不存在，正常 */
    }
  }

  // 4) 重写全局配置，只留全局字段
  await writeJson(PATHS.globalConfig, {
    logLevel: legacy.logLevel ?? GLOBAL_DEFAULTS.logLevel,
    cooldownHint: legacy.cooldownHint ?? GLOBAL_DEFAULTS.cooldownHint,
    webui: legacy.webui ?? GLOBAL_DEFAULTS.webui,
    logs: legacy.logs ?? GLOBAL_DEFAULTS.logs,
    plugins: legacy.plugins ?? GLOBAL_DEFAULTS.plugins,
  });
  moved.push(rel(PATHS.globalConfig));

  // 5) 根目录旧配置如果还在，删掉
  if (await exists(PATHS.legacyConfig)) await fs.unlink(PATHS.legacyConfig);

  // 6) 清掉搬空了的旧目录
  for (const d of [
    path.join(DIRS.data, 'plugins'),
    path.join(DIRS.logs, 'plugins'),
    path.join(DIRS.config, 'plugins'),
  ]) {
    try {
      const rest = await fs.readdir(d);
      if (!rest.length) await fs.rmdir(d);
    } catch {
      /* 不存在就忽略 */
    }
  }

  await writeJson(PATHS.migratedFlag, { at: Date.now(), botId, moved: moved.length });
  return { migrated: true, botId, moved };
}

/* ------------------------------------------------------------------ */
/* 凭证                                                                */
/* ------------------------------------------------------------------ */

/** 首启向导：给指定机器人补齐 AppID / AppSecret */
export async function ensureBotCredentials(botId) {
  const cfg = await loadBotConfig(botId);
  if (cfg.appId && cfg.appSecret) return cfg;

  /**
   * 没有交互终端时**不要抛错**。
   *
   * 面板本身就是配置入口——因为没凭证就把进程弄死，用户连配的地方都进不去。
   * 这里只提示，交给 BotRuntime 报「缺少凭证」（state=error），
   * 面板照常启动，用户在面板里填完就能连上。
   */
  if (!stdin.isTTY) {
    console.warn(
      `\n[提示] 机器人 ${botId} 还没有 AppID / AppSecret。\n` +
        `       打开面板填写，或编辑 ${rel(botPaths(botId).config)}。\n` +
        `       面板地址见下面的日志。\n`,
    );
    return cfg;
  }

  console.log(`\n机器人 ${botId} 还没有凭证，请输入 QQ 开放平台的信息（在 q.qq.com 管理端可查看）\n`);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (!cfg.appId) cfg.appId = (await rl.question('AppID: ')).trim();
    if (!cfg.appSecret) cfg.appSecret = (await rl.question('AppSecret: ')).trim();
  } finally {
    rl.close();
  }

  if (!cfg.appId || !cfg.appSecret) {
    console.warn(
      `\n[提示] AppID 或 AppSecret 为空，这次先不连。\n` +
        `       面板已启动，可以在里面填写后再连接。\n`,
    );
    return cfg;
  }

  await saveBotConfig(botId, cfg);
  console.log(`\n已保存到 ${rel(botPaths(botId).config)}\n`);
  return cfg;
}
