import fs from 'node:fs/promises';
import { readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DIRS } from './paths.js';

/**
 * 实例互斥：防止同一个机器人被启动两次。
 *
 * 为什么必须管：两个进程用**同一个 AppID** 连 WebSocket，服务端会判定为冲突，
 * 两边互相踢（关闭码 4902），表现是机器人反复掉线、消息时有时无。
 * 而且用户往往意识不到自己开了两个窗口。
 *
 * 策略（不是简单的一刀切禁止多开）：
 *   - 同一个 AppID 已经有活着的实例 → 拒绝启动，告诉你 PID 和怎么处理
 *   - 不同 AppID → 允许（用户明确要跑多个机器人时的正常场景）
 *   - 上次异常退出留下的僵尸记录 → 自动清理，不阻塞
 *
 * 记录存在 data/instances.json，形如：
 *   { "102055275": { "pid": 12345, "at": 1730000000000, "mock": false } }
 */

/** 本进程已经认领过的 AppID。文件里记的是自己的 pid，光靠文件挡不住同进程重复认领 */
const inProcessClaims = new Set();

const FILE = path.join(DIRS.data, 'instances.json');

/**
 * 心跳租约：让「僵尸锁」自己过期，而不是等人去面板清。
 *
 * 思路来自 moxystudio/node-proper-lockfile（GitHub, MIT）：锁文件靠**周期性
 * 刷新 mtime** 表示「我还活着」，进程被 SIGKILL / 断电后 mtime 不再更新，
 * 超过 stale 阈值就判定为死并移除。它特意指出用创建时间（我们记录里的
 * `at`）判活不适合长驻进程——那正是以前只靠 pid + at 的毛病。
 *
 * 为什么不直接引包：框架是零依赖，而且我们要的是「同一个 AppID 一把锁」，
 * 不是「一个文件一把锁」。所以照搬机制、自己实现：
 *   · 每条记录配一个独立心跳文件（只存文件名，不存绝对路径）
 *   · 进程每 UPDATE_MS 刷一次 mtime，定时器 unref，不拦退出
 *   · 心跳新鲜 = 最强证据，直接判活，不再问 pid / 进程名 / wmic
 *   · 心跳停跳 = 明确停止运行；即便 pid 被复用给别的 node、命令行也查不到，
 *     照样判死并自动剪掉（这正是以前「关机后卡住上不了线」的死角）
 *
 * 心跳停跳但 pid 还在时，仍会用命令行再确认一次：万一进程活着只是事件循环
 * 卡了 30 秒，命令行含本框架特征就继续判活——**判死会放行双开**，这条兜底
 * 不能省。
 */
const BEAT_DIR = path.join(DIRS.data, 'instance-beats');
const STALE_MS = 30_000;
const UPDATE_MS = 10_000;
const BEAT_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** appId -> { timer, file }；同进程内每个 AppID 只有一颗心跳 */
const beats = new Map();
const BEAT_NAME = /^[a-f0-9]{20}\.beat$/;

/** 用 appId 的哈希当文件名：AppID 里可能有路径分隔符，不能直接拼 */
function beatPathOf(appId) {
  const name = `${createHash('sha256').update(String(appId)).digest('hex').slice(0, 20)}.beat`;
  return path.join(BEAT_DIR, name);
}

/** 记录里只认合法文件名，杜绝被塞进一个绝对路径去 stat */
function beatFileOf(rec) {
  if (!rec?.beat || typeof rec.beat !== 'string' || !BEAT_NAME.test(rec.beat)) return null;
  return path.join(BEAT_DIR, rec.beat);
}

/**
 * @returns {boolean|null} true=心跳新鲜（活）/ false=停跳或文件没了（死）/ null=旧记录没有心跳
 */
function beatAlive(rec) {
  const file = beatFileOf(rec);
  if (!file) return null;
  try {
    const age = Date.now() - statSync(file).mtimeMs;
    /** mtime 在未来（时钟回拨 / 文件系统精度）也按活算：判死的代价是双开 */
    return age <= STALE_MS;
  } catch {
    return false;
  }
}

async function startBeat(appId) {
  const key = String(appId);
  await stopBeat(key);
  const file = beatPathOf(key);
  await fs.mkdir(BEAT_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, appId: key }), 'utf8');
  const touch = () => {
    const now = new Date();
    fs.utimes(file, now, now).catch(async () => {
      /** 文件被误删 / 一次 IO 抖动：重建一次，别让活实例因此被判死 */
      try {
        await fs.writeFile(file, JSON.stringify({ pid: process.pid, appId: key }), 'utf8');
      } catch {}
    });
  };
  const timer = setInterval(touch, UPDATE_MS);
  timer.unref?.();
  beats.set(key, { timer, file });
  return path.basename(file);
}

async function stopBeat(appId) {
  const key = String(appId);
  const b = beats.get(key);
  if (!b) return;
  clearInterval(b.timer);
  beats.delete(key);
  await fs.unlink(b.file).catch(() => {});
}

/** 强杀留下的心跳文件会一直过期，攒久了清一下；活进程每 10s 刷新，不会被误删 */
let lastBeatSweep = 0;
async function sweepBeats() {
  if (Date.now() - lastBeatSweep < 60 * 60 * 1000) return;
  lastBeatSweep = Date.now();
  let names;
  try {
    names = await fs.readdir(BEAT_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!BEAT_NAME.test(name)) continue;
    const file = path.join(BEAT_DIR, name);
    try {
      const st = await fs.stat(file);
      if (Date.now() - st.mtimeMs > BEAT_KEEP_MS) await fs.unlink(file).catch(() => {});
    } catch {}
  }
}

/**
 * 进程名看起来像不像一个「跑 JS 的运行时」。
 *
 * **只认 `node.exe` 会漏掉 GUI 包装**：本框架常被 Electron 打包的宿主
 * （`DeepSeek Harness.exe`、各种 `*.exe` 启动器）以内嵌 node 拉起，此时
 * pid 在系统里显示的是**宿主 exe 名**。旧判据把这种活实例判成死进程，
 * 于是 `claimInstance()` 放行第二次认领 → 同一个 AppID 双开 → 服务端
 * 4902 互踢、消息随机丢失（2026-11 外部实测：8 个活进程一个都没认出来）。
 *
 * 进程名这一步**只用来识别 PID 复用**（pid 被系统分给了别的程序），
 * 不是「是不是本框架」的判据——后者由 `isOurRoost()` 里的命令行检查负责。
 * 所以这里宁可放宽：认不出来就让它进第二层，别在第一层就把活实例杀掉。
 *
 * @param {string} name tasklist / ps 给出的进程名
 */
function looksLikeNodeRuntime(name) {
  if (!name) return false;
  const base = String(name).replace(/^.*[\\/]/, '');
  if (/^node(js)?(\.exe)?$/i.test(base)) return true;
  /** 宿主 / 打包程序：靠特征名判断，不做全量白名单，避免又变成「认不出来就不算」 */
  return /\bnode\b|electron|.*harness.*/i.test(base);
}

/**
 * 纯函数：`/proc/<pid>` 的三处内容里，有没有证据表明它是 node 运行时。
 *
 * **为什么不能只看 `comm`**：Node 24 起会把主线程名设成 `MainThread`，
 * `/proc/<pid>/comm` 读出来就是这四个字，不再含 `node`。只认 comm 会把一个
 * **活着的**实例判成陈旧记录 → 删锁 → 放行第二次认领 → 同 AppID 双开 →
 * 4902 互踢。CI 的 `ubuntu-latest / Node 24.x` 就是从这条断言红起的。
 *
 * 判定顺序（与文件头「拿不准往活着倒」一致）：
 *   · `comm` 读不到（空串）→ 活（无法确认就不否定）
 *   · comm / cmdline / exe 任一提及 node → 活
 *   · **另两项一个都没读到**（传 `null`）→ 活
 *   · 至少读到一项、且都没提 node → 死（这才真的是 PID 被别的程序复用）
 *
 * 倒数第二条是**跨用户 / 加固内核**的保命线：`/proc/<pid>/exe` 要 ptrace 权限，
 * 读别人的进程会 EACCES；`cmdline` 在非 dumpable 进程上也可能读不到。
 * 若这时只拿 comm 下结论，一个 `MainThread` 的活实例就会被判死——又绕回互踢。
 * 「读不到」和「读到了但没有 node」必须分开，所以这里用 `null` 表示前者。
 *
 * 拆成纯函数是为了能在**任意平台**单测：真机上只有跑在对应系统上才能观测到
 * `/proc` 的内容，而这段逻辑恰恰是跨平台行为分叉的地方。
 */
function looksLikeNodeProc({ comm = '', cmdline = null, exe = null } = {}) {
  if (!comm) return true;
  if (/node/i.test(comm)) return true;
  if (cmdline && /node/i.test(cmdline)) return true;
  if (exe && /node/i.test(exe)) return true;
  if (cmdline === null && exe === null) return true;
  return false;
}

/**
 * 这个 pid 现在是不是一个 node 进程。
 *
 * 光看「pid 存不存在」不够：Windows 会把回收的 PID 复用给别的程序。
 * 踩过的坑——被强杀的机器人留下 pid=15008 的记录，后来 15008 被
 * SearchProtocolHost.exe 占用，于是 isAlive 误判「机器人还在跑」，
 * 启动被拒且删不掉（看起来是活的）。所以再确认一次进程名。
 *
 * **方向统一：拿不准就往「活着」倒。**
 * 判死会删记录 → 放行第二次认领 → 同 AppID 双开 → 4902 互踢；
 * 判活最多让用户手动清一条残留（面板「实例锁」有一键清理，也有 `--force`）。
 * 两者代价不对称，所以工具缺失、输出为空、名字不认识，一律按活着处理。
 */
function pidLooksLikeNode(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      const m = out.match(/^"([^"]+)"/);
      // 进程已消失时 tasklist 不给 CSV 行，m 为 null → 当作不在了
      return m ? looksLikeNodeRuntime(m[1]) : false;
    }
    /**
     * Linux 直接读 `/proc/<pid>/comm`，不 fork `ps`。
     *
     * 以前这里统一用 `ps -p <pid> -o comm=`，在 GitHub 的 ubuntu runner 上
     * 会返回空字符串（进程明明活着），于是**活实例被判成死进程**：
     * 认领被放行 → 同一个 AppID 双开 → 4902 互踢。
     * CI 从 0.6.17 起一直红在这条断言上，真机上也会踩到同样的坑。
     *
     * `/proc` 是内核直接给的，不用 fork、不受 ps 实现差异影响，也更快。
     */
    if (process.platform === 'linux') {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      /**
       * Node 24 起主线程被改名成 `MainThread`，`comm` 不再含 `node`，
       * 所以再核对 `cmdline`（完整命令行）与 `exe`（可执行文件链接）。
       * **读不到的项传 `null`**（不是空串）：纯函数要区分「这一项没证据」和
       * 「这一项读不到」，后者在跨用户 / 加固内核下很常见，不能单独导致判死。
       */
      let cmdline = null;
      let exe = null;
      try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { /* 读不到就看下一项 */ }
      try { exe = readlinkSync(`/proc/${pid}/exe`); } catch { /* 权限或已退出 */ }
      return looksLikeNodeProc({ comm, cmdline, exe });
    }
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    /**
     * 读不到也按活着算，和 linux 分支、catch 分支保持一致。
     *
     * 以前这里是 `: false`——同一份文件里三种「拿不准」有两种方向，
     * 恰好错的那一种会直接导致双开。
     */
    return comm ? /node/i.test(comm) : true;
  } catch {
    return true;
  }
}

/**
 * pid 现在有没有进程占着——**只看存在，不看它是什么程序**。
 * EPERM 说明进程存在但没权限，也算存在。
 *
 * 为什么要和 isAlive 分开：`looksLikeNodeRuntime` 认不出的宿主 exe
 * （比如 `MyBot.exe` 内嵌 node）会被 isAlive 判死。对有心跳租约的记录，
 * 进程名该交给冲突路径的命令行判据去细判，不能在 prune 这一层就剪掉。
 */
function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** pid 是否还活着（且确实是 node 进程）。EPERM 说明进程存在但没权限，也算活着 */
function isAlive(pid) {
  if (!pidExists(pid)) return false;
  /**
   * 问「我自己还活着吗」恒为真，不用查进程名。
   *
   * 「进程名是不是 node」那一步是为了识别 **PID 复用**——系统把回收的 pid 分给了
   * 别的程序。可这件事对自己根本不适用：pid 就是我的，那个进程当然是我。
   * 而多查这一步反而会出错：CI 的 ubuntu + Node 24 上，面板「实例锁」把
   * 本进程自己那条显示成「已退出」（自检里 635/636 就挂在这一条）。
   */
  if (pid === process.pid) return true;
  // PID 存在，但可能已被系统复用给别的程序；确认它是 node 才算活
  return pidLooksLikeNode(pid);
}

/**
 * 这个进程的命令行。
 *
 * 拿不到（工具不在、没权限、进程刚好退出）返回 null —— 调用方要区分
 * 「问不到」和「问到了但不匹配」，这两种的处理方向完全相反。
 */
function commandLineOf(pid) {
  if (process.platform === 'win32') {
    /**
     * 先用 wmic：开一个进程约 40ms，比 PowerShell 快一个数量级。
     * Win11 24H2 起 wmic 已被移除（本机实测 ENOENT），所以要留后路。
     */
    try {
      const out = execFileSync(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true },
      );
      const m = /CommandLine=(.+)/.exec(out);
      if (m) return m[1].trim() || null;
    } catch {}
    /**
     * 退回 PowerShell。慢（起一个进程 300–600ms），所以**只在冲突路径上调用**：
     * 正常启动、正常注销、面板刷新都不会走到这里。
     */
    try {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
        ],
        { encoding: 'utf8', timeout: 8000, windowsHide: true },
      );
      return out.trim() || null;
    } catch {
      return null;
    }
  }
  try {
    if (process.platform === 'linux') {
      // 内核直接给，不用 fork；参数之间是 \0
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
    }
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim() ||
      null
    );
  } catch {
    return null;
  }
}

/** 本框架进程的特征。安装目录各不相同，所以只认「包名」和「入口文件名」 */
const ROOST_HINT = /(qq-bot-roost|src[\\/]main\.js)/i;

/**
 * pid 是否还活着（且确实是本框架的进程）。
 *
 * 三层，一层比一层贵：
 *   ① `isAlive` —— pid 存在 + 进程名是 node（便宜，正常路径都走这个）
 *   ② 命令行里有没有本框架的特征（慢，**只在冲突时**才查）
 *
 * 第 ② 层是为 PID 复用准备的：Windows 会把回收的 PID 分给别的程序。
 * 踩过的坑——被强杀的机器人留下 pid=15008，后来 15008 被
 * SearchProtocolHost.exe 占用（进程名不是 node，① 就挡住了）。但如果占用者
 * 是**另一个 node 程序**（你的构建脚本、别的 bot），① 看不出来，于是
 * 「机器人还在跑」——启动被拒、记录删不掉、界面上显示一个你从没见过的 PID。
 *
 * 方向仍然是「拿不准就往活着倒」：误判成死 → 同 AppID 双开 → 4902 互踢，
 * 比「多让用户点一次清理」严重得多。
 *
 * @returns {Promise<boolean>}
 */
async function isOurRoost(pid, rec = null) {
  const beat = rec ? beatAlive(rec) : null;
  /** 心跳新鲜：不用再问进程名 / wmic / PowerShell，直接判活 */
  if (beat === true) return true;
  /** 有租约的记录只看 pid 是否存在；升级前的旧记录沿用含进程名的 isAlive */
  const exists = beat === null ? isAlive(pid) : pidExists(pid);
  if (!exists) return false;
  const cmd = commandLineOf(pid);
  if (beat === false) {
    /**
     * 心跳停了但 pid 还在：只有**明确查到那是另一个 JS 程序**才敢判死。
     *
     * 命令行查不到（Win11 移除 wmic / PowerShell 被策略禁用）、或查到的是
     * 宿主 exe 内嵌 node（bug #1 的教训），一律判活——原进程可能只是事件
     * 循环卡了 30 秒没刷上心跳。判死会放行第二次认领 → 同 AppID 双开 →
     * 4902 互踢，代价远大于留一条可手动清理的记录。
     *
     * 所以自愈分三档：关机后 pid 不存在 → prune 直接剪；pid 被复用且
     * 命令行明确是别的 node 程序 → 这里自动剪；只有「工具全失效 + pid
     * 复用」才需要面板一键清。这个残余是防双开的刻意取舍，不能省。
     */
    if (cmd === null) return true;
    if (ROOST_HINT.test(cmd)) return true;
    if (/\.[cm]?js\b/i.test(cmd)) return false;
    return true;
  }
  /** 升级前写的旧记录没有心跳：完全沿用原来的保守判据 */
  if (cmd === null) return true;
  if (ROOST_HINT.test(cmd)) return true;
  // 命令行里跑着某个 .js，却不含本框架特征 → 是别的 node 程序，占的是复用的 pid
  return !/\.[cm]?js\b/i.test(cmd);
}

async function readAll() {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 写实例表（哪个进程占着哪个机器人）。
 *
 * 这只是一本「谁在用」的账，**写不进去不该拦住启动**：
 * 文件被占用、被安全软件拦、上次被强杀留下锁死的 .tmp——
 * 这些都不影响机器人本身能不能上线。
 * 所以失败只记日志，顺手把残留的临时文件清掉。
 */
async function writeAll(data) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, FILE);
  } catch (e) {
    console.warn(`[instance] 实例表写入失败（不影响运行）: ${e.message}`);
    await fs.unlink(tmp).catch(() => {});
  }
}

/** 清掉已经不存在的进程留下的记录 */
function prune(data) {
  const out = {};
  for (const [key, rec] of Object.entries(data)) {
    if (!rec) continue;
    const beat = beatAlive(rec);
    /** 心跳新鲜就是活，连 pid 都不用看——PID 被复用也挡得住 */
    if (beat === true) {
      out[key] = rec;
      continue;
    }
    if (beat === false) {
      /**
       * 有租约但停跳：只要 pid 还占着就先保留，交给冲突路径按命令行细判。
       * 这里**不能**用 isAlive（含进程名判据）：自定义宿主 exe 名不含
       * node/electron/harness 时会被判死，绕过 isOurRoost 直接放行双开。
       */
      if (!pidExists(rec.pid)) continue;
      out[key] = rec;
      continue;
    }
    /** 升级前的旧记录没有心跳：沿用原来的 pid + 进程名判据 */
    if (isAlive(rec.pid)) out[key] = rec;
  }
  return out;
}

/**
 * 登记一个实例。
 *
 * @param {object} p
 * @param {string} p.appId  机器人 AppID（mock 模式用 'mock'）
 * @param {boolean} [p.force] 忽略冲突强制登记（--force 时用）
 * @returns {Promise<{ok:boolean, conflict?:{pid:number,at:number}}>}
 */
export async function claimInstance({ appId, force = false }) {
  const key = String(appId || 'unknown');

  /**
   * 同进程内的重复认领要挡住。
   *
   * 文件里记的 pid 就是自己，`existing.pid !== process.pid` 永远不成立，
   * 于是两份配置填了同一个 AppID 时两边都「认领成功」，各自连网关 →
   * 平台判定冲突互踢（4902），消息随机丢。
   */
  if (inProcessClaims.has(key) && !force) {
    return { ok: false, conflict: { pid: process.pid, at: Date.now() } };
  }

  const data = prune(await readAll());

  const existing = data[key];
  if (existing && existing.pid !== process.pid && !force) {
    /**
     * 冲突时**再核一次**：那个 pid 现在还是不是本框架。
     *
     * `prune()` 走的是便宜的判断（pid 在 + 进程名是 node），挡不住
     * 「pid 被复用给另一个 node 程序」——那种情况用户会看到一个从没见过的
     * PID 拦着自己，而记录删不掉。这里多花一次命令行查询，
     * **只在这条冲突路径上花**，正常启动一次都不会走到。
     */
    if (await isOurRoost(Number(existing.pid), existing)) {
      return { ok: false, conflict: { pid: existing.pid, at: existing.at } };
    }
    // 心跳停了 / 命令行显示是别的程序占了复用的 pid → 当死记录，继续往下认领
  }

  inProcessClaims.add(key);
  /**
   * 心跳是增强项，写不进去不该拦住启动（和 writeAll 同一个原则）。
   * 落不了盘就退回「无心跳的旧记录」，行为不比升级前差。
   */
  let beat = '';
  try {
    beat = await startBeat(key);
  } catch (e) {
    console.warn(`[instance] 心跳租约没建成（不影响运行）: ${e.message}`);
  }
  data[key] = { pid: process.pid, at: Date.now(), mock: key === 'mock', ...(beat ? { beat } : {}) };
  await writeAll(data);
  void sweepBeats();
  return { ok: true };
}

/** 退出时注销。只删自己那条，别把别人的清了 */
export async function releaseInstance(appId) {
  const key = String(appId || 'unknown');
  const data = prune(await readAll());
  inProcessClaims.delete(key);
  if (data[key]?.pid === process.pid) delete data[key];
  await stopBeat(key);
  await writeAll(data);
}

/** 当前登记在案的实例，面板可以展示 */
export async function listInstances() {
  return prune(await readAll());
}

/**
 * 面板用：把文件里的记录**原样**列出来，并标出每条还活着没。
 *
 * 和 `listInstances()` 的区别：那个是互斥判定用的，只返回活的；这个连死记录
 * 一起返回——用户要清的恰恰是死记录，看不到就没法清。
 */
export async function listInstancesAll() {
  const data = await readAll();
  return Object.entries(data)
    .filter(([, rec]) => rec && typeof rec === 'object')
    .map(([appId, rec]) => {
      const pid = Number(rec.pid) || 0;
      const beat = beatAlive(rec);
      return {
        appId,
        pid,
        at: Number(rec.at) || 0,
        mock: Boolean(rec.mock),
        /**
         * 面板的「在世」要和互斥结论一致：停跳但 pid 还在时，互斥仍拦着，
         * 不能显示成「已退出」让用户以为清一下就好了。
         */
        alive: beat === null ? isAlive(pid) : beat === true ? true : pidExists(pid),
        /** 有没有心跳租约：排障时一眼看出这条是新版还是旧版写的 */
        leased: beat !== null,
        /** 租约已停跳（互斥仍可能因防双开判活） */
        stale: beat === false,
        /** 是不是当前这个面板进程自己在用的（那条不能清） */
        self: pid === process.pid,
      };
    })
    .sort((a, b) => b.at - a.at);
}

/**
 * 强制清掉一条实例记录（面板「实例锁」里手动清理用）。
 *
 * 不检查 pid 还活着没——用户点它，本来就是冲着「进程明明没了却还拦着我」来的。
 * 但**本进程自己那条不许清**：那是正在生效的互斥，删掉等于放开同进程双开，
 * 两个机器人用同一个 AppID 连网关会 4902 互踢。
 *
 * @returns {Promise<{ok:boolean, message?:string, pid?:number}>}
 */
export async function clearInstance(appId) {
  const key = String(appId ?? '').trim();
  if (!key) return { ok: false, message: '要指定 AppID' };
  const data = await readAll();
  const rec = data[key];
  if (!rec) return { ok: false, message: `没有 ${key} 的记录` };
  if (Number(rec.pid) === process.pid) {
    return { ok: false, message: '这条是本进程自己在用的，不能清——先把那个机器人下线' };
  }
  delete data[key];
  await writeAll(data);
  /**
   * 顺手删掉它的心跳文件。活进程的 touch 会重建**文件**，但不会重建
   * instances.json 里的记录——用户手动清过之后，那个 AppID 需要重新认领，
   * 这是原有行为，不是这次改动引入的。
   */
  const beatFile = beatFileOf(rec);
  if (beatFile) await fs.unlink(beatFile).catch(() => {});
  return { ok: true, pid: Number(rec.pid) || 0 };
}

/** 测试用：直接看文件内容（不剪枝） */
export async function _rawRead() {
  return readAll();
}

/** 测试用：看某个 pid 的命令行拿不拿得到（拿不到返回 null） */
export function _commandLineOf(pid) {
  return commandLineOf(pid);
}

/**
 * 测试用：进程名判据。
 *
 * 这条判据没法在 CI 里真跑出「宿主 exe 内嵌 node」——CI 的进程名就是
 * `node`，旧实现也返回 true，测不出差别。所以把纯函数单独暴露出来
 * 用表驱动断言（见 selftest「实例锁: 宿主 exe 名不能再被判死」）。
 */
export function _looksLikeNodeRuntime(name) {
  return looksLikeNodeRuntime(name);
}

/** 测试用：心跳判活（true 新鲜 / false 停跳 / null 旧记录） */
export function _beatAlive(rec) {
  return beatAlive(rec);
}

/** 测试用：某个 AppID 的心跳文件路径，便于把 mtime 拨回过去模拟强杀 */
export function _beatPathOf(appId) {
  return beatPathOf(appId);
}

/** 测试用：租约阈值 */
export const _STALE_MS = STALE_MS;

/** 测试用：只看 pid 存不存在（不带进程名判据） */
export function _pidExists(pid) {
  return pidExists(pid);
}

/**
 * 测试用：`/proc/<pid>` 三处证据的合并判据。
 *
 * 这条逻辑跨平台分叉，真机上只有跑在对应系统才观测得到 `/proc` 的内容，
 * 所以在 CI 里用表驱动直接喂 comm / cmdline / exe（见 `test/instance-proc.mjs`）。
 */
export function _looksLikeNodeProc(parts) {
  return looksLikeNodeProc(parts);
}

/** 测试用：直接跑剪枝，便于构造「停跳租约 + 不像 node 的进程名」边界 */
export function _pruneForTest(data) {
  return prune(data);
}
