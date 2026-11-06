import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
 * 这个 pid 现在是不是一个 node 进程。
 *
 * 光看「pid 存不存在」不够：Windows 会把回收的 PID 复用给别的程序。
 * 踩过的坑——被强杀的机器人留下 pid=15008 的记录，后来 15008 被
 * SearchProtocolHost.exe 占用，于是 isAlive 误判「机器人还在跑」，
 * 启动被拒且删不掉（看起来是活的）。所以再确认一次进程名。
 *
 * 查不出来时（tasklist/ps 异常）保守返回 true，避免误删真实实例导致双开。
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
      return m ? /(^|\\)node(\.exe)?$/i.test(m[1]) : false;
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
       * 读到空字符串时**按活着算**，不是按死了算。
       *
       * 判断不出来的方向要选保守的那个：当成死 → 删记录 → 放行第二次认领
       * → 同一个 AppID 双开 → 4902 互踢，正是这套机制存在的理由。
       * 当成活 → 顶多让用户手动清一条残留记录（有 `--force`）。
       *
       * 真实的误判代价不对称，所以拿不准就往"活着"倒。
       */
      return comm ? /node/i.test(comm) : true;
    }
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    return comm ? /node/i.test(comm) : false;
  } catch {
    return true;
  }
}

/** pid 是否还活着（且确实是 node 进程）。EPERM 说明进程存在但没权限，也算活着 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
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
async function isOurRoost(pid) {
  if (!isAlive(pid)) return false;
  const cmd = commandLineOf(pid);
  if (cmd === null) return true; // 问不到 → 当成我们的
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
    if (rec && isAlive(rec.pid)) out[key] = rec;
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
    if (await isOurRoost(Number(existing.pid))) {
      return { ok: false, conflict: { pid: existing.pid, at: existing.at } };
    }
    // 命令行显示是别的程序占了复用的 pid → 当死记录，继续往下认领
  }

  inProcessClaims.add(key);
  data[key] = { pid: process.pid, at: Date.now(), mock: key === 'mock' };
  await writeAll(data);
  return { ok: true };
}

/** 退出时注销。只删自己那条，别把别人的清了 */
export async function releaseInstance(appId) {
  const key = String(appId || 'unknown');
  const data = prune(await readAll());
  inProcessClaims.delete(key);
  if (data[key]?.pid === process.pid) delete data[key];
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
      return {
        appId,
        pid,
        at: Number(rec.at) || 0,
        mock: Boolean(rec.mock),
        alive: isAlive(pid),
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
