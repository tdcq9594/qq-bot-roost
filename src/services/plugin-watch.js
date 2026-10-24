/**
 * 插件热重载
 * ==========
 *
 * 改完插件代码不用重启进程、也不用去面板点「重载」——存盘两秒后自己生效。
 *
 * **为什么用轮询不用 fs.watch**：和 `config-watch.js` 同一个理由。
 * Windows 上编辑器保存常走「写临时文件再改名」，`fs.watch` 会漏事件；
 * 网络盘、WSL 挂载目录更不可靠。插件目录只有几个文件夹，
 * 每 2 秒走一遍 stat 的开销可以忽略。
 *
 * **为什么要「连续两轮签名一致」才重载**：
 * 编辑器保存大文件时会分几次写，`fs.cp` 安装插件时更是逐个文件复制。
 * 只在「这次读到的签名和上一轮待定的签名相同」时才认为文件写完了，
 * 否则会读到半个文件、报一个莫名其妙的语法错误，用户以为插件坏了。
 *
 * 跳过的东西（这些变化不该触发重载）：
 *   - `node_modules` / `__pycache__` / `.venv`：依赖目录，重载只会白费力气
 *   - `data` / `dist` / `build`：插件自己的运行时产物
 *   - `.log` / `.pyc` / `.db`：运行时写出来的文件
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseService } from './base.js';
import { createLogger } from '../logger.js';
import { DIRS } from '../paths.js';

const log = createLogger('plugin-watch');

/** 这些目录里的变化一律忽略 */
const SKIP_DIRS = new Set([
  'node_modules',
  '__pycache__',
  '.git',
  '.venv',
  'venv',
  'env',
  'dist',
  'build',
  'data',
  '.idea',
  '.vscode',
  '.cache',
]);

/** 这些后缀的变化一律忽略 */
const SKIP_EXT = new Set(['.pyc', '.pyo', '.log', '.db', '.sqlite', '.sqlite3', '.tmp', '.swp', '.lock']);

/**
 * 全局唯一的实例。
 *
 * 面板在安装 / 卸载插件时会往 `plugins/` 里写文件，
 * 那期间的重载全是误报——需要让面板能「挂起」监视器。
 * 服务是进程级的单例，所以这里存一份引用给外部用。
 */
let instance = null;

/**
 * 挂起插件热重载一段时间（安装/卸载插件前后调用）。
 * @param {number} [ms]
 */
export function suspendPluginWatch(ms = 3000) {
  instance?.suspend(ms);
}

export class PluginWatchService extends BaseService {
  /**
   * @param {object} p
   * @param {object} p.globalCfg
   * @param {() => object[]} p.getRuntimes 每次取当前机器人列表
   */
  constructor({ globalCfg, getRuntimes, dir }) {
    super('pluginWatch', '插件热重载');
    this.globalCfg = globalCfg;
    this.getRuntimes = getRuntimes;
    /** 被监视的插件根目录。单独留参数是为了测试能指向临时目录 */
    this.dir = dir || DIRS.plugins;
    this.intervalMs = Math.max(500, Number(globalCfg?.plugins?.hotReloadInterval) || 2000);
    /**
     * 文件最后修改时间距今超过这个值才认为「写完了」。
     * 编辑器保存大文件会分几次写，太早 reload 会读到半个文件。
     */
    this.settleMs = 500;
    /** id -> 已确认的签名 */
    this.seen = new Map();
    /** id -> 待确认的新签名（下一轮还是它才认为写完了） */
    this.pending = new Map();
    /** 首次扫描只建立基线，不触发重载 */
    this.primed = false;
    /** 到这个时间点之前忽略所有变化 */
    this.suspendedUntil = 0;
    /** 正在重载的 `机器人/插件`，防止同一插件被并发重载两次 */
    this.busy = new Set();
    instance = this;
  }

  /** 挂起监视：安装插件时目录会逐个文件出现，不能当成「用户改了代码」 */
  suspend(ms = 3000) {
    this.suspendedUntil = Date.now() + ms;
    // 恢复后要重新建立基线，否则挂起期间的正常改动会被漏掉
    this.primed = false;
    this.pending.clear();
  }

  async stop() {
    if (instance === this) instance = null;
    return super.stop();
  }

  /**
   * 算一个插件目录的签名。
   *
   * 用「文件数 + 最大 mtime + 总字节」而不是内容哈希：
   * 每次轮询都读一遍全部内容没必要。三个值一起变，足以区分「改了」和「没改」。
   */
  async #signature(dir) {
    let count = 0;
    let maxMtime = 0;
    let bytes = 0;

    const walk = async (d) => {
      let entries;
      try {
        entries = await fs.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name)) continue;
          await walk(p);
          continue;
        }
        if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
        const st = await fs.stat(p).catch(() => null);
        if (!st) continue;
        count += 1;
        bytes += st.size;
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      }
    };

    await walk(dir);
    return `${count}:${Math.round(maxMtime)}:${bytes}`;
  }

  async tick() {
    if (Date.now() < this.suspendedUntil) return;

    let entries = [];
    try {
      entries = await fs.readdir(this.dir, { withFileTypes: true });
    } catch {
      return; // 插件目录还没建
    }

    const ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const sigs = new Map();
    for (const id of ids) {
      sigs.set(id, await this.#signature(path.join(this.dir, id)));
    }

    if (!this.primed) {
      this.seen = new Map(sigs);
      this.pending.clear();
      this.primed = true;
      this.detail = `监视 ${ids.length} 个插件`;
      return;
    }

    // 目录结构变了（新增 / 删除）：交给 rescan，它认得「装了什么、删了什么」
    const added = ids.filter((id) => !this.seen.has(id));
    const removed = [...this.seen.keys()].filter((id) => !sigs.has(id));

    if (added.length || removed.length) {
      await this.#rescanAll({ added, removed });
      for (const id of removed) this.seen.delete(id);
      for (const id of added) this.seen.set(id, sigs.get(id));
    }

    // 文件内容变了：等文件「安静」下来才重载（编辑器可能还在写）
    const ready = [];
    for (const [id, sig] of sigs) {
      const confirmed = this.seen.get(id);
      if (confirmed === undefined || confirmed === sig) {
        this.pending.delete(id);
        continue;
      }
      // 签名里第二段是最大 mtime，用它判断「最后一次修改过去多久」
      const mtime = Number(sig.split(':')[1]) || 0;
      const quiet = Date.now() - mtime;
      // 只认「安静够久」。不特判 mtime 在未来的情况——那多半是文件系统
      // 时间精度或时钟偏差，再等一轮自然就正了，急着重载反而会读到半个文件。
      if (quiet >= this.settleMs) {
        ready.push(id);
        this.seen.set(id, sig);
        this.pending.delete(id);
      } else {
        // 刚写完还在变，下一轮再看
        this.pending.set(id, sig);
      }
    }

    this.detail = `监视 ${ids.length} 个插件${this.pending.size ? `，${this.pending.size} 个待确认` : ''}`;
    if (ready.length) await this.#reloadAll(ready);
  }

  async #rescanAll({ added, removed }) {
    if (added.length) log.info(`发现新插件目录: ${added.join('、')}`);
    if (removed.length) log.info(`插件目录已删除: ${removed.join('、')}`);
    for (const rt of this.getRuntimes()) {
      const pm = rt?.plugins;
      if (!pm?.rescan) continue;
      try {
        const r = await pm.rescan();
        if (r.added?.length) log.info(`[${rt.id}] 自动加载: ${r.added.join('、')}`);
        if (r.removed?.length) log.info(`[${rt.id}] 自动卸载: ${r.removed.join('、')}`);
        for (const e of r.errors ?? []) log.warn(`[${rt.id}] 插件 ${e.id} 加载失败: ${e.error}`);
      } catch (e) {
        log.warn(`[${rt.id}] 重新扫描插件失败: ${e.message}`);
      }
    }
  }

  async #reloadAll(ids) {
    for (const rt of this.getRuntimes()) {
      const pm = rt?.plugins;
      if (!pm?.loaded) continue;
      for (const id of ids) {
        // 没加载的（被禁用 / 被配置过滤）不用重载，等用户自己开
        if (!pm.loaded.has(id)) continue;
        if (pm.state?.[id] === false) continue;

        const key = `${rt.id}/${id}`;
        if (this.busy.has(key)) continue;
        this.busy.add(key);
        try {
          const ok = await pm.reload(id);
          if (ok) log.info(`[${rt.id}] 插件 ${id} 已热重载`);
          else log.warn(`[${rt.id}] 插件 ${id} 重载失败，详见插件日志`);
        } catch (e) {
          log.warn(`[${rt.id}] 插件 ${id} 重载出错: ${e.message}`);
        } finally {
          this.busy.delete(key);
        }
      }
    }
  }
}
