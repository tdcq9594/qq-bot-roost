/**
 * CLI 体检（`node src/main.js --check`）
 * =====================================
 *
 * 承诺（README / `--help` 里写的那句）：「只验证 AppID/AppSecret 和网关，不常驻」。
 *
 * ── 以前是什么样 ──
 *
 * `main.js` 里 `const CHECK_ONLY = args.has('--check')` 声明完**再没被引用过**。
 * 于是这个命令什么也没检查，只是**照常把机器人全启起来**：加载插件、
 * 起 OneBot / 宿主协议端口、`runtimes.start()` 真连网关、开面板、起定时任务。
 * 用户按文档说「我只是检查一下」，结果是真上线了一只鸟——同 AppID 已有实例时
 * 还会撞实例锁，报错看着像配置写错了。
 *
 * ── 现在做什么 ──
 *
 * 复用面板「检查」页那套 `runDoctor()`（同一份口径，不再各写一套），
 * 去掉两项**只有常驻进程才有意义**的检查，再补一项真探网关：
 *
 *   1. `runDoctor()`：凭证、intents、插件目录可写、面板暴露面、SQLite…
 *   2. 过滤 `connection` / `traffic`：这两项看的是「进程跑起来之后」的状态，
 *      一次性体检里没有运行态，留着只会误导成「还没连上」。
 *   3. 真探一次 `/gateway/bot`：验证凭证可用 + 接口可达。
 *      **不建 WebSocket、不注册实例、不起任何端口**。
 *
 * 全程只读配置，唯一的网络请求就是换 token 和取网关地址。
 */
import { TokenManager } from './token.js';
import { QQApi } from './api.js';
import { runDoctor, summarize } from './doctor.js';

/** 看的是常驻进程运行态，一次性体检里没有意义 */
const RUNTIME_ONLY = new Set(['connection', 'traffic']);

const MARK = { ok: '✔', warn: '!', error: '✘' };

/**
 * 造一个「只够体检用」的 api：有 token 管理器和 getGateway，没有 outbound、
 * 没有 seqMap、不碰任何全局状态。**不经过 `BotRuntime.init()`**——那一步会
 * 起 OneBot / 宿主协议端口并加载插件，已经不是检查了。
 *
 * @param {object} cfg 机器人配置
 */
export function defaultApiOf(cfg) {
  const tokens = new TokenManager(cfg);
  return { tokens, api: new QQApi({ tokenManager: tokens, baseUrl: cfg.baseUrl }) };
}

/**
 * 真探一次网关地址。
 * @param {object} api
 */
async function probeGateway(api) {
  if (!api?.getGateway) {
    return { id: 'gateway', level: 'warn', title: '网关未校验', detail: 'API 实例没建起来，跳过这一项' };
  }
  try {
    const gw = await api.getGateway();
    if (!gw?.url) throw new Error('网关接口未返回 url');
    return { id: 'gateway', level: 'ok', title: '网关可达', detail: String(gw.url) };
  } catch (e) {
    return {
      id: 'gateway',
      level: 'error',
      title: '网关不可达',
      detail: e.message,
      fix: '检查 AppID / AppSecret、机器人是否已上线、网络或代理设置（面板「设置 → 网络」）。',
    };
  }
}

/**
 * 跑一遍 CLI 体检。
 *
 * @param {object} p
 * @param {Array<{id?:string, cfg:object, mock?:boolean}>} p.bots 机器人配置（**未启动**）
 * @param {object} p.globalCfg 全局配置
 * @param {boolean} [p.mock] 全局 mock 模式（`--mock --check`）
 * @param {(line:string)=>void} [p.print]
 * @param {boolean} [p.probe] 是否真探网关（测试关掉，避免联网）
 * @param {(cfg:object)=>{tokens:object, api:object}} [p.makeApi] 测试注入
 * @returns {Promise<number>} 进程退出码：0 无 error，1 有 error
 */
export async function runCheckMode({
  bots,
  globalCfg,
  mock = false,
  print = (line) => console.log(line),
  probe = true,
  makeApi = defaultApiOf,
}) {
  if (!Array.isArray(bots) || !bots.length) {
    print('没有可体检的机器人：检查 config/bots/*.json 里的 enabled');
    return 1;
  }

  let code = 0;
  for (const b of bots) {
    const cfg = b?.cfg ?? b ?? {};
    const id = String(cfg.id ?? b?.id ?? 'main');
    const isMock = Boolean(b?.mock ?? mock);
    print(`\n—— 体检：${id}${cfg.name && cfg.name !== id ? `（${cfg.name}）` : ''} ——`);

    let made = null;
    try {
      made = makeApi(cfg);
    } catch (e) {
      print(`  ${MARK.error} 无法初始化接口客户端：${e.message}`);
      code = 1;
      continue;
    }

    /** doctor 只读这个壳子里的 `api.tokens` / `mock` / `state`，不需要真运行时 */
    const rt = { id, cfg, state: 'check', mock: isMock, api: made };

    let list;
    try {
      list = (await runDoctor({ cfg, globalCfg, rt, mock: isMock })).filter((x) => !RUNTIME_ONLY.has(x.id));
    } catch (e) {
      print(`  ${MARK.error} 体检本身出错：${e.message}`);
      code = 1;
      continue;
    }

    if (probe && !isMock) list.push(await probeGateway(made?.api));

    for (const it of list) {
      print(`  ${MARK[it.level] ?? '·'} ${it.title}：${it.detail}`);
      if (it.fix) print(`      → ${it.fix}`);
    }
    if (list.some((x) => x.level === 'error')) code = 1;
    print(`  小结：${summarize(list)}`);
  }

  print(
    code
      ? '\n体检未通过：按上面的提示改完再跑一次（本次没有启动任何机器人）'
      : '\n体检通过（本次没有启动任何机器人、没有连 WebSocket）',
  );
  return code;
}
