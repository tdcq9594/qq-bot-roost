import fs from 'node:fs/promises';
import path from 'node:path';
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

/** pid 是否还活着。EPERM 说明进程存在但没权限，也算活着 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function readAll() {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

async function writeAll(data) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, FILE);
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
