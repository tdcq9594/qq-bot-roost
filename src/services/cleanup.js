/**
 * 清理服务
 * ========
 *
 * 清三类东西，**只清明确能再生或过期的**：
 *
 *   1. `data/.update-*` —— 更新中断留下的临时目录
 *   2. `data/backups/`  —— 更新备份，只留最近 N 份
 *   3. `logs/` 下的旧日志 —— 按天数，默认留 14 天
 *
 * **绝不碰**：config/、data/bots/（存档）、plugins/。
 * 这条是硬约束——清理服务误删存档是最不可接受的 bug。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseService } from './base.js';
import { createLogger } from '../logger.js';
import { DIRS } from '../paths.js';

const log = createLogger('cleanup');

/** 这些目录无论配置怎么写都不许动 */
const FORBIDDEN = ['config', 'plugins', path.join('data', 'bots')];

export class CleanupService extends BaseService {
  constructor({ globalCfg, getRuntimes }) {
    super('cleanup', '文件清理');
    this.cfg = globalCfg?.cleanup ?? {};
    this.getRuntimes = getRuntimes;
    // 6 小时跑一次就够了
    this.intervalMs = 6 * 60 * 60_000;
    this.keepBackups = this.cfg.keepBackups ?? 3;
    this.keepLogDays = this.cfg.keepLogDays ?? 14;
  }

  async tick() {
    const removed = [];

    removed.push(...(await this.#cleanTempDirs()));
    removed.push(...(await this.#cleanBackups()));
    removed.push(...(await this.#cleanOldLogs()));
    removed.push(...(await this.#pruneStats()));

    if (removed.length) {
      this.detail = `清理 ${removed.length} 项`;
      log.info(`清理完成：${removed.join('、')}`);
    } else {
      this.detail = '无过期文件';
    }
  }

  /**
   * 清统计库里的过期明细。
   *
   * 只删 messages/daily/commands 三张表的旧行，**members 不删**——
   * 成员档案的价值恰恰在「很久没来」这个信息上，删了就算不出留存。
   */
  async #pruneStats() {
    const out = [];
    for (const rt of this.getRuntimes?.() ?? []) {
      try {
        const n = rt?.stats?.prune?.();
        if (n && (n.messages || n.daily || n.commands)) {
          out.push(`${rt.id} 统计 -${n.messages} 条`);
        }
      } catch (e) {
        log.warn(`清理 ${rt.id} 统计失败: ${e.message}`);
      }
    }
    return out;
  }

  /** 更新中断留下的 data/.update-xxx */
  async #cleanTempDirs() {
    const out = [];
    const base = DIRS.data;
    let names;
    try {
      names = await fs.readdir(base);
    } catch {
      return out;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith('.update-')) continue;
      const p = path.join(base, name);
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isDirectory()) continue;
      // 只清超过 1 小时的，避免把正在跑的更新删了
      if (now - st.mtimeMs < 60 * 60_000) continue;
      await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      out.push(name);
    }
    return out;
  }

  /** 备份只留最近 N 份 */
  async #cleanBackups() {
    const out = [];
    const dir = path.join(DIRS.data, 'backups');
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return out;
    }

    const items = [];
    for (const name of names) {
      const p = path.join(dir, name);
      const st = await fs.stat(p).catch(() => null);
      if (!st?.isDirectory()) continue;
      items.push({ name, p, at: st.mtimeMs });
    }
    if (items.length <= this.keepBackups) return out;

    items.sort((a, b) => b.at - a.at);
    for (const it of items.slice(this.keepBackups)) {
      await fs.rm(it.p, { recursive: true, force: true }).catch(() => {});
      out.push(`备份 ${it.name}`);
    }
    return out;
  }

  /** 按天数清旧日志 */
  async #cleanOldLogs() {
    const out = [];
    const cutoff = Date.now() - this.keepLogDays * 86400_000;

    const walk = async (dir, depth = 0) => {
      if (depth > 2) return;
      let names;
      try {
        names = await fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const p = path.join(dir, name);
        // 双保险：路径里出现禁区目录直接跳过
        if (FORBIDDEN.some((f) => p.includes(path.sep + f + path.sep))) continue;

        const st = await fs.stat(p).catch(() => null);
        if (!st) continue;
        if (st.isDirectory()) {
          await walk(p, depth + 1);
        } else if (name.endsWith('.log') && st.mtimeMs < cutoff) {
          await fs.rm(p, { force: true }).catch(() => {});
          out.push(`日志 ${name}`);
        }
      }
    };

    await walk(DIRS.logs);
    return out;
  }
}
