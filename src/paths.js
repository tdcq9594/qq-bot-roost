import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 全项目路径的唯一来源。
 *
 * 支持多个机器人：每个机器人有自己的配置、数据、日志；
 * 插件**代码**全局共享一份，不复制。
 *
 *   bot/
 *   ├── config/
 *   │   ├── bot.json              全局配置：面板、日志、插件默认值
 *   │   ├── bot.example.json
 *   │   └── bots/
 *   │       ├── main.json         机器人 A 的配置
 *   │       └── main/             机器人 A 的插件配置
 *   │           └── plugins/<插件id>.json
 *   ├── data/
 *   │   └── bots/<id>/
 *   │       ├── groups.json       群档案
 *   │       ├── roles.json        权限
 *   │       ├── quota.json        主动消息额度
 *   │       ├── plugins.json      插件启用状态
 *   │       └── plugins/<id>.json 插件存档
 *   ├── logs/
 *   │   ├── bot.log               全局日志
 *   │   └── bots/<id>/
 *   │       ├── bot.log           该机器人的日志
 *   │       └── plugins/<id>.log
 *   └── plugins/<id>/             插件代码，全局共享
 *
 * 为什么数据必须按机器人隔离：**openid 是每个机器人独立的**，
 * 同一个用户在不同机器人下的 openid 完全不同，共享存档等于全部对不上。
 */

/** 代码根目录（src/ web/ plugins/ package.json 都在这下面），永远跟着仓库走 */
export const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 运行数据根目录：config / logs / data 放哪。
 *
 * 默认就是仓库根。设  可以整体挪走——
 * 测试要的就是这个：跑 e2e 不该写开发者自己的 config 和权限表。
 * plugins/ 不跟着走，它是代码不是数据。
 */
const HOME = process.env.ROOST_HOME ? path.resolve(process.env.ROOST_HOME) : ROOT;

export const DIRS = {
  config: path.join(HOME, 'config'),
  logs: path.join(HOME, 'logs'),
  data: path.join(HOME, 'data'),
  /** 插件代码目录，全局共享（**不跟着 HOME 走**，它是代码不是数据） */
  plugins: path.join(ROOT, 'plugins'),
  /** 机器人配置文件目录 */
  botsConfig: path.join(HOME, 'config', 'bots'),
  /** 机器人数据目录 */
  botsData: path.join(HOME, 'data', 'bots'),
  /** 机器人日志目录 */
  botsLogs: path.join(HOME, 'logs', 'bots'),
};

export const PATHS = {
  /** 全局配置 */
  globalConfig: path.join(DIRS.config, 'bot.json'),
  /** 旧版根目录配置，迁移用 */
  legacyConfig: path.join(ROOT, 'config.json'),
  /** 全局日志 */
  coreLog: path.join(DIRS.logs, 'bot.log'),
  /** 实例互斥记录 */
  instances: path.join(DIRS.data, 'instances.json'),
  /** 迁移完成标记 */
  migratedFlag: path.join(DIRS.data, '.migrated'),
};

/**
 * 断言 target 在 root 里面。
 *
 * id 会被拼进路径，而删除机器人是 `fs.rm(..., {recursive:true})`——
 * 一旦 id 是 `..` 或 `../..`，删掉的就是 config/ 甚至项目根。
 * 所有由 id 拼出来的路径都必须过这一关。
 */
function assertInside(root, target, what) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${what} 越界（id 里可能有 .. 或分隔符）：${target}`);
  }
}

/**
 * 取某个机器人的全套路径。
 * 所有 Store / Manager 都从这里拿路径，不再自己拼，这样多机器人才能互不干扰。
 *
 * @param {string} id 机器人 id（与配置文件同名）
 */
export function botPaths(id) {
  if (!id || typeof id !== 'string') throw new Error('botPaths 需要一个机器人 id');
  const base = path.join(DIRS.botsData, id);
  const logs = path.join(DIRS.botsLogs, id);

  // 拼完先验一遍再返回，调用方拿到的路径一定是安全的
  assertInside(DIRS.botsData, base, '机器人数据目录');
  assertInside(DIRS.botsLogs, logs, '机器人日志目录');
  assertInside(DIRS.botsConfig, path.join(DIRS.botsConfig, `${id}.json`), '机器人配置文件');

  return {
    id,
    /** 机器人主配置 */
    config: path.join(DIRS.botsConfig, `${id}.json`),
    /** 该机器人的插件配置目录 */
    pluginConfigDir: path.join(DIRS.botsConfig, id, 'plugins'),
    /** 数据根目录 */
    data: base,
    groups: path.join(base, 'groups.json'),
    roles: path.join(base, 'roles.json'),
    quota: path.join(base, 'quota.json'),
    /** 可达性（好友关系 / 主动推送开关），官方无查询接口，靠事件维护 */
    reach: path.join(base, 'reach.json'),
    /** 统计库（SQLite，存消息计数与成员活跃，不存正文） */
    stats: path.join(base, 'stats.db'),
    /**
     * 事件账本（SQLite，存原始消息）。
     *
     * 和 `stats.db` 分开两个文件，不是随手分的：
     *   - 生命周期不同：stats 留 90 天聚合，events 只留 7 天全文，滚动删的策略和频率都不一样
     *   - 隐私边界不同：stats 明确「不存正文」，events 存正文。混一个库的话，
     *     「这个库会不会被拷走」这个问题的答案就说不清了
     *   - 备份/删除粒度不同：用户想清掉聊天记录，删 `events.db` 一个文件就够
     */
    events: path.join(base, 'events.db'),
    pluginState: path.join(base, 'plugins.json'),
    pluginDataDir: path.join(base, 'plugins'),
    /** 日志根目录 */
    logDir: logs,
    log: path.join(logs, 'bot.log'),
    pluginLogDir: path.join(logs, 'plugins'),
    pluginLog: (pluginId) => path.join(logs, 'plugins', `${pluginId}.log`),
    pluginConfig: (pluginId) => path.join(DIRS.botsConfig, id, 'plugins', `${pluginId}.json`),
    pluginData: (pluginId) => path.join(base, 'plugins', `${pluginId}.json`),
    /**
     * 外部插件专属的数据目录（不是文件）。
     * 内建插件用 ctx.storage 存单个 JSON；外部插件语言各异，
     * 给它一个目录，想用 JSON / SQLite / 自己的格式都行。
     */
    pluginDataDirFor: (pluginId) => path.join(base, 'plugins', pluginId),
  };
}

/** 插件代码目录（全局共享） */
export const pluginDir = (pluginId) => path.join(DIRS.plugins, pluginId);

/** 目录不存在就建。首次启动时由 main 调一次 */
export async function ensureDirs(botId = null) {
  const list = [
    DIRS.config,
    DIRS.logs,
    DIRS.data,
    DIRS.plugins,
    DIRS.botsConfig,
    DIRS.botsData,
    DIRS.botsLogs,
  ];
  if (botId) {
    const p = botPaths(botId);
    list.push(p.data, p.pluginDataDir, p.pluginConfigDir, p.logDir, p.pluginLogDir);
  }
  for (const dir of list) await fs.mkdir(dir, { recursive: true });
}

/** 列出所有已配置的机器人 id */
export async function listBotIds() {
  try {
    const files = await fs.readdir(DIRS.botsConfig);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/** 相对路径显示，日志里比绝对路径好读 */
export function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/') || '.';
}
