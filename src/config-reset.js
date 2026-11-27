/**
 * 恢复框架默认设置（**只动设置，不动数据**）
 * ==========================================
 *
 * 给 dsh-roost 面板的「问题反馈 → 恢复默认设置」调用。为什么不直接让插件
 * 改配置文件：框架是有自己内存的进程，`config/bot.json` 改了以后要由
 * `services/config-watch.js` 热加载；绕开框架写文件等于让两个进程抢同一份
 * 状态（面板刚保存的值会被另一头覆盖）。所以正路是框架自己提供接口。
 *
 * 「恢复默认」不是「把所有键 PUT 一遍」：`/api/config` 是合并语义，插件升级
 * 遗留的旧键会永远留在文件里。这里按 `GLOBAL_DEFAULTS` / `BOT_DEFAULTS`
 * **删了重建**，才真的干净。
 *
 * 必须保留的东西（否则恢复完当场失联）：
 *   - 全局：`webui.accessKey`（面板密钥，dsh-roost 调框架 API 也靠它）、
 *     `webui.host` / `webui.port`（运行中的进程不会因改端口重新 bind）。
 *   - 每只鸟：`appId` / `appSecret`（QQ 凭证）、`owners`（主人，绑定要真机扫码）。
 *
 * 全部是纯函数 + 可注入 IO，测试不需要碰真实配置目录。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GLOBAL_DEFAULTS, BOT_DEFAULTS, saveGlobalConfig, saveBotConfig } from './config.js';
import { DIRS, PATHS, listBotIds } from './paths.js';

/** 前端必须带这个确认词；误点 / 老脚本裸调一律拒绝 */
export const RESET_CONFIRM = 'RESET';

/** 全局保留路径：连接引导 + 凭证 */
export const GLOBAL_KEEP_PATHS = [
  ['webui', 'accessKey'],
  ['webui', 'host'],
  ['webui', 'port'],
];

/** 每只鸟保留的顶层键：凭证 + 主人 */
export const BOT_KEEP_KEYS = ['appId', 'appSecret', 'owners'];

function getAt(root, path) {
  return path.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), root);
}

function setAt(root, path, value) {
  let node = root;
  for (const k of path.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) node[k] = {};
    node = node[k];
  }
  node[path.at(-1)] = value;
}

/**
 * 重置全局配置：以默认值重建，只把保留路径的值搬回来。
 * `structuredClone` 是必须的——`BOT_DEFAULTS` / `GLOBAL_DEFAULTS` 里的嵌套对象
 * 是共享引用，直接改会污染后续所有机器人（框架里踩过一次）。
 */
export function resetGlobalKeeping(current = {}, keep = GLOBAL_KEEP_PATHS) {
  const next = structuredClone(GLOBAL_DEFAULTS);
  for (const p of keep) {
    const v = getAt(current, p);
    if (v !== undefined) setAt(next, p, structuredClone(v));
  }
  /** 老配置用过 `webui.token`，兼容搬过来，别让恢复默认变成「密钥消失」 */
  if (!next.webui?.accessKey && current?.webui?.token) next.webui.accessKey = current.webui.token;
  return next;
}

/** 重置单只鸟：保留凭证与主人，其余回到 BOT_DEFAULTS */
export function resetBotKeeping(current = {}, id = '', keep = BOT_KEEP_KEYS) {
  const next = structuredClone(BOT_DEFAULTS);
  next.id = String(id || '');
  for (const k of keep) {
    if (current?.[k] !== undefined) next[k] = structuredClone(current[k]);
  }
  if (!next.name) next.name = next.id;
  return next;
}

/** 读 JSON 失败当空对象：坏配置不该让整个恢复动作失败 */
function readJsonSafe(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 默认 IO：抽出来是为了单测能喂假读写，不碰开发机上的真配置 */
const defaultIo = {
  readGlobal: () => readJsonSafe(PATHS.globalConfig),
  readBot: (id) => readJsonSafe(join(DIRS.botsConfig, `${id}.json`)),
  saveGlobal: (cfg) => saveGlobalConfig(cfg),
  saveBot: (id, cfg) => saveBotConfig(id, cfg),
  listBots: () => listBotIds(),
};

/**
 * 执行恢复。逐只鸟独立处理：某一只配置坏了不能挡住其它鸟恢复。
 * @returns {{ok:boolean, reason?:string, bots:string[], errors:string[], message:string}}
 */
export async function resetFrameworkConfigs({ confirm, io = defaultIo } = {}) {
  if (confirm !== RESET_CONFIRM) {
    return { ok: false, reason: 'confirm', bots: [], errors: [], message: '需要确认词 RESET' };
  }

  const errors = [];
  const bots = [];
  let ids = [];
  try {
    ids = await io.listBots();
  } catch (e) {
    errors.push(`列机器人失败：${e?.message || e}`);
  }

  for (const id of ids) {
    try {
      await io.saveBot(id, resetBotKeeping(await io.readBot(id), id));
      bots.push(id);
    } catch (e) {
      errors.push(`${id}：${e?.message || e}`);
    }
  }

  try {
    await io.saveGlobal(resetGlobalKeeping(await io.readGlobal()));
  } catch (e) {
    errors.push(`全局配置：${e?.message || e}`);
  }

  const ok = errors.length === 0;
  return {
    ok,
    bots,
    errors,
    message: ok
      ? `已恢复 ${bots.length} 只鸟 + 全局设置的默认值；凭证与主人保留`
      : `部分恢复失败：${errors.join('；')}`,
  };
}
