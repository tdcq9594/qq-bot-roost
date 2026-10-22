import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const DATA_DIR = path.join(ROOT, 'data');

const DEFAULTS = {
  appId: '',
  appSecret: '',
  baseUrl: 'https://api.bot.qq.com',
  // GROUP_AND_C2C_EVENT = 1 << 25，群聊 @机器人 + 私聊消息
  intents: 1 << 25,
  owners: [],
  commandPrefix: '/',
  logLevel: 'info',

  // 可视化面板
  webui: {
    enabled: true,
    host: '127.0.0.1',
    port: 8080,
    accessKey: '', // 面板访问密钥，留空则不校验
  },

  // 群/用户白名单：enabled 为 true 时只响应名单内的来源
  whitelist: {
    enabled: false,
    groups: [],
    users: [],
  },

  // 限流：每个会话每分钟最多处理多少条
  rateLimit: {
    enabled: true,
    perChatPerMinute: 30,
  },

  // 去重窗口（秒），同一 msg id 只处理一次
  dedupWindowSec: 120,

  // 机器人入群时，自动把「邀请人」设为主人（owners 为空时才生效）
  autoOwnerOnInvite: true,

  // 收到的消息是否写进日志；muteKinds 里的来源类型不记录
  messageLog: {
    enabled: true,
    muteKinds: [], // group / c2c / guild / dm
  },
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export async function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config.json 解析失败: ${e.message}`);
  }
  const cfg = deepMerge(DEFAULTS, fileCfg);

  // 兼容旧配置：以前这个字段叫 webui.token
  if (!cfg.webui.accessKey && cfg.webui.token) {
    cfg.webui.accessKey = cfg.webui.token;
    delete cfg.webui.token;
  }

  // 环境变量优先级最高，方便容器部署
  if (process.env.QQ_BOT_APPID) cfg.appId = process.env.QQ_BOT_APPID;
  if (process.env.QQ_BOT_SECRET) cfg.appSecret = process.env.QQ_BOT_SECRET;
  if (process.env.QQ_BOT_BASE_URL) cfg.baseUrl = process.env.QQ_BOT_BASE_URL;
  if (process.env.QQ_BOT_OWNERS) {
    cfg.owners = process.env.QQ_BOT_OWNERS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return cfg;
}

export async function saveConfig(cfg) {
  const out = {
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    baseUrl: cfg.baseUrl,
    intents: cfg.intents,
    owners: cfg.owners,
    commandPrefix: cfg.commandPrefix,
    logLevel: cfg.logLevel,
    webui: cfg.webui,
    whitelist: cfg.whitelist,
    rateLimit: cfg.rateLimit,
    dedupWindowSec: cfg.dedupWindowSec,
    autoOwnerOnInvite: cfg.autoOwnerOnInvite,
    messageLog: cfg.messageLog,
  };
  // 先写临时文件再改名，避免写一半断电把配置写坏
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
}

/** 首次运行时引导输入 AppID / AppSecret */
export async function ensureCredentials(cfg) {
  if (cfg.appId && cfg.appSecret) return cfg;

  if (!stdin.isTTY) {
    throw new Error(
      '缺少 AppID / AppSecret。请在 config.json 中填写，或设置环境变量 QQ_BOT_APPID / QQ_BOT_SECRET，或打开可视化面板配置。',
    );
  }

  console.log('\n首次运行，请输入 QQ 开放平台的机器人凭证（在 q.qq.com 管理端可查看）\n');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (!cfg.appId) cfg.appId = (await rl.question('AppID: ')).trim();
    if (!cfg.appSecret) cfg.appSecret = (await rl.question('AppSecret: ')).trim();
  } finally {
    rl.close();
  }

  if (!cfg.appId || !cfg.appSecret) throw new Error('AppID 或 AppSecret 为空，已退出。');
  await saveConfig(cfg);
  console.log(`\n已保存到 ${CONFIG_PATH}\n`);
  return cfg;
}
