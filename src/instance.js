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
    return { ok: false, conflict: { pid: existing.pid, at: existing.at } };
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

/** 测试用：直接看文件内容（不剪枝） */
export async function _rawRead() {
  return readAll();
}
