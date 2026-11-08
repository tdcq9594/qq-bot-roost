import fs from 'node:fs/promises';
import path from 'node:path';

/** 插件目录里不该进快照的**一级**子目录。 */
const SKIP_TOP = new Set(['node_modules', '.roost-cache', 'data', 'logs', 'config', '.git']);

/**
 * 自己遍历复制，不用 `fs.cp`：快照在插件目录**内部**，而 fs.cp 会在开复制前
 * 直接拒绝「目标是源的子目录」（ERR_FS_CP_EINVAL），哪怕 filter 排除了它。
 * 排除只在**插件根目录那一层**生效：嵌套的 `src/data`、`lib/config` 是插件
 * 自己的代码/资源，不该被一并丢掉（审查实测 S11/S12）。
 */
async function copyTree(srcDir, destDir, top = false) {
  await fs.mkdir(destDir, { recursive: true });
  for (const e of await fs.readdir(srcDir, { withFileTypes: true })) {
    if (top && SKIP_TOP.has(e.name)) continue;
    const from = path.join(srcDir, e.name);
    const to = path.join(destDir, e.name);
    if (e.isDirectory()) await copyTree(from, to, false);
    else if (e.isFile()) await fs.copyFile(from, to);
    else if (e.isSymbolicLink()) {
      /**
       * symlink 原先被静默漏掉。指向普通文件时按目标内容复制成快照里的真文件；
       * 指向目录的链接不跟随（避免成环），插件不该靠这种结构装代码。
       */
      const real = await fs.realpath(from).catch(() => null);
      const st = real ? await fs.stat(real).catch(() => null) : null;
      if (st?.isFile()) await fs.copyFile(real, to).catch(() => {});
    }
  }
}

/**
 * 把内建插件复制成一份带唯一戳的快照，返回快照入口路径。
 *
 * 为什么不再用 `?t=`：ESM 按**路径**缓存，入口加查询参数只会重加载入口，
 * 它 import 的子模块还留在旧缓存里——典型表现是「改了 outbound.js，重载后
 * 报 does not provide an export named xxx」，只能重启进程。整目录换路径，
 * 入口和所有相对 import 的子模块才会一起重载。
 *
 * 快照放在**插件目录内部**（`.roost-cache/<stamp>/`）：这样插件 `import '某个 npm 包'`
 * 时，Node 向上查找能落到插件自己的 `node_modules`；复制时把依赖、数据目录、
 * 旧快照都排除掉，避免每次重载把目录越滚越大。
 *
 * @returns {Promise<{snapRoot:string, snapDir:string, stamp:string, entry:string}>}
 */
export async function makeSnapshot(dir, entryFile) {
  const snapRoot = path.join(dir, '.roost-cache');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const snapDir = path.join(snapRoot, stamp);
  await fs.mkdir(snapRoot, { recursive: true });
  await copyTree(dir, snapDir, true);
  return { snapRoot, snapDir, stamp, entry: path.join(snapDir, path.basename(entryFile)) };
}

/** 只留当前这一份快照。旧的不删会随每次重载线性增长。 */
export async function pruneSnapshots(snapRoot, keepStamp) {
  const entries = await fs.readdir(snapRoot).catch(() => []);
  await Promise.all(
    entries
      .filter((x) => x !== keepStamp)
      .map((x) => fs.rm(path.join(snapRoot, x), { recursive: true, force: true }).catch(() => {})),
  );
}
