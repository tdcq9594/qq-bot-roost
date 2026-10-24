/**
 * 体检
 * ====
 *
 * 回答一个很常见的问题：「我配好了，为什么没反应？」
 *
 * 不做花哨的自动修复，只把「现在到底哪一步没通」摆出来。每一项都带
 * 一句人话解释和该去哪儿改——用户报问题时最缺的就是这个。
 */
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { DIRS } from './paths.js';
import { INTENT_META } from './events.js';
import { mirrorCandidates } from './mirror.js';

/** 判断某个 intent 位有没有开 */
function hasIntent(intents, name) {
  const bit = INTENT_META[name]?.bit;
  if (bit === undefined) return null;
  return (Number(intents ?? 0) & (1 << bit)) !== 0;
}

/**
 * 跑一遍体检。
 *
 * @param {object} p
 * @param {object} p.cfg        机器人配置
 * @param {object} p.globalCfg  全局配置
 * @param {object} p.rt         BotRuntime（可选，拿运行状态）
 * @param {boolean} p.mock      是否 mock 模式（mock 下网关本来就不连）
 * @returns {Promise<Array<{id:string, level:'ok'|'warn'|'error', title:string, detail:string, fix?:string}>>}
 */
export async function runDoctor({ cfg, globalCfg, rt, mock = false }) {
  const out = [];
  const add = (id, level, title, detail, fix) => out.push({ id, level, title, detail, fix });

  /* ---------- 1. 凭证 ---------- */
  if (!cfg?.appId || !cfg?.appSecret) {
    add(
      'credential',
      'error',
      '还没填机器人凭证',
      'appId / appSecret 是空的，连不上任何接口。',
      '去 QQ 开放平台 → 你的机器人 → 开发设置里复制，填到面板「配置」页。',
    );
  } else if (mock) {
    add('credential', 'ok', '凭证已填（mock 模式不校验）', `AppID ${cfg.appId}`);
  } else {
    try {
      const tokens = rt?.api?.tokens;
      if (!tokens?.get) throw new Error('拿不到 API 实例');
      await tokens.get();
      add('credential', 'ok', '凭证有效', '已成功换取 access_token');
    } catch (e) {
      add(
        'credential',
        'error',
        '凭证换不到 access_token',
        e.message,
        '检查 AppSecret 有没有复制全、机器人是否被停用。',
      );
    }
  }

  /* ---------- 2. 连接 ---------- */
  if (mock) {
    add('connection', 'ok', 'mock 模式', '没有连真实网关，收不到真消息是正常的。');
  } else if (rt?.state === 'online') {
    add('connection', 'ok', '已连上', `网关状态：${rt.state}`);
  } else {
    add(
      'connection',
      'warn',
      '还没连上',
      `当前状态：${rt?.state ?? 'unknown'}`,
      '看「日志」页有没有 4014（没开通群聊能力）或 4902（同一 AppID 重复启动）。',
    );
  }

  /* ---------- 3. intents ---------- */
  const groupOn = hasIntent(cfg?.intents, 'GROUP_AND_C2C_EVENT');
  if (groupOn === false) {
    add(
      'intent-group',
      'error',
      '群聊事件没订阅',
      '群消息事件（GROUP_AT_MESSAGE_CREATE）属于「群聊与私聊」intent，这一位没开就永远收不到群消息。',
      `面板「配置」页把 intents 加上 ${1 << INTENT_META.GROUP_AND_C2C_EVENT.bit}（或直接点「全开」）。`,
    );
  } else if (groupOn === true) {
    add('intent-group', 'ok', '群聊事件已订阅', `当前 intents = ${cfg.intents}`);
  }

  /* ---------- 4. 插件目录可写 ---------- */
  try {
    await fs.access(DIRS.plugins, FS.W_OK);
    add('plugins-dir', 'ok', '插件目录可写', DIRS.plugins);
  } catch {
    add(
      'plugins-dir',
      'error',
      '插件目录不可写',
      `${DIRS.plugins} 打不开或没有写权限，装插件会失败。`,
      '检查目录是否存在、是否被杀毒软件锁住、当前用户有没有权限。',
    );
  }

  /* ---------- 5. 下载源 ---------- */
  const candidates = mirrorCandidates('https://github.com/tdcq9594/qq-bot-roost/archive/refs/heads/main.tar.gz');
  if (candidates.length > 1) {
    add('mirror', 'ok', '下载源有兜底', `${candidates.length} 个候选（含镜像）`);
  } else {
    add(
      'mirror',
      'warn',
      '下载源只有直连',
      '直连 GitHub 失败时不会自动换镜像，装插件可能超时。',
      '面板「插件市场」右上角把下载源改成「自动」。',
    );
  }

  /* ---------- 6. 面板暴露面 ---------- */
  const wc = globalCfg?.webui ?? {};
  const keyed = Boolean(wc.accessKey);
  const localOnly = !wc.host || wc.host === '127.0.0.1' || wc.host === 'localhost';
  if (keyed) {
    add('webui', 'ok', '面板有访问密钥', 'accessKey 已设置');
  } else if (localOnly) {
    add('webui', 'ok', '面板只监听本机', '没设密钥，但只有本机能访问，可以接受。');
  } else {
    add(
      'webui',
      'error',
      '面板暴露到网络但没密钥',
      `监听 ${wc.host}:${wc.port}，任何人都能打开并改配置。`,
      '在「配置」页设一个访问密钥，或者把监听地址改回 127.0.0.1。',
    );
  }

  /* ---------- 7. 统计 ---------- */
  if (rt?.stats) {
    if (rt.stats.available) add('stats', 'ok', '统计可用', 'SQLite 正常');
    else
      add(
        'stats',
        'warn',
        '统计不可用',
        '当前 Node 没有可用的内置 SQLite（需要 22.13+），统计页会是空的，其它功能不受影响。',
        '升级 Node 到 22.13 以上（22.13 起 node:sqlite 不再需要 --experimental-sqlite）。',
      );
  }

  /* ---------- 8. 有没有人跟它说过话 ---------- */
  const people = rt?.listRecentPeople?.(1) ?? [];
  if (people.length) {
    add('traffic', 'ok', '收到过消息', `最近一条来自 ${people[0].name || people[0].openid}`);
  } else if (!mock && rt?.state === 'online') {
    add(
      'traffic',
      'warn',
      '还没收到任何消息',
      '已连上网关，但一条消息都没进来。',
      '去群里 @ 一下机器人，或者看「事件」页里对应事件有没有计数。',
    );
  }

  return out;
}

/** 把结果压成一句话，面板标题上显示 */
export function summarize(list) {
  const bad = list.filter((x) => x.level === 'error').length;
  const warn = list.filter((x) => x.level === 'warn').length;
  if (bad) return `${bad} 项需要处理`;
  if (warn) return `${warn} 项提醒`;
  return '一切正常';
}
