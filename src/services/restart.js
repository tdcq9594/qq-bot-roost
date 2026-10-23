/**
 * 定时重启
 * ========
 *
 * 长时间跑的机器人，内存碎片、句柄泄漏、会话表膨胀都是慢慢积累的。
 * 每天凌晨重启一次，比事后排查便宜得多。
 *
 * 两种触发方式，配一个就行：
 *   "restart": { "enabled": true, "at": "04:00" }        // 每天这个点
 *   "restart": { "enabled": true, "everyHours": 12 }     // 每 N 小时
 *
 * 重启怎么实现：**重新拉起一个自己，然后退出**。
 * 这样裸机跑（没 systemd / 没 docker）也能自愈，不依赖外部守护。
 * 新进程启动时旧进程已经释放了端口和实例锁，不会撞车。
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { BaseService } from './base.js';
import { createLogger } from '../logger.js';

const log = createLogger('restart');

export class RestartService extends BaseService {
  /**
   * @param {object} p
   * @param {object} p.globalCfg
   * @param {() => Promise<void>|void} [p.onRestart] 优雅关闭的回调（不传就直接 spawn）
   */
  constructor({ globalCfg, onRestart }) {
    super('restart', '定时重启');
    this.cfg = globalCfg?.restart ?? {};
    this.onRestart = onRestart;
    this.intervalMs = 60_000; // 每分钟看一次该不该重启
    this.lastAt = Date.now();
    /** 当天已经重启过的日期，避免同一分钟内重复触发 */
    this.lastDay = '';
  }

  async tick() {
    const now = new Date();

    if (this.cfg.everyHours) {
      const hours = Number(this.cfg.everyHours);
      if (!Number.isFinite(hours) || hours <= 0) return;
      const elapsed = (Date.now() - this.lastAt) / 3_600_000;
      if (elapsed >= hours) {
        this.detail = `已运行 ${elapsed.toFixed(1)} 小时，准备重启`;
        return this.#restart(`每 ${hours} 小时`);
      }
      this.detail = `距下次重启 ${(hours - elapsed).toFixed(1)} 小时`;
      return;
    }

    if (this.cfg.at) {
      const [hh, mm] = String(this.cfg.at).split(':').map(Number);
      if (!Number.isInteger(hh) || !Number.isInteger(mm)) {
        this.detail = `时间格式不对：${this.cfg.at}（应为 HH:MM）`;
        return;
      }
      const day = now.toISOString().slice(0, 10);
      const target = new Date(now);
      target.setHours(hh, mm, 0, 0);

      // 到点且今天还没重启过
      if (now >= target && this.lastDay !== day) {
        this.lastDay = day;
        this.detail = `到点重启（${this.cfg.at}）`;
        return this.#restart(`每天 ${this.cfg.at}`);
      }
      this.detail = `下次重启 ${this.cfg.at}`;
    }
  }

  async #restart(reason) {
    log.warn(`开始重启（${reason}）`);

    // 有优雅关闭回调就先走它（落盘、断连、卸插件），再 spawn
    if (this.onRestart) {
      try {
        await this.onRestart();
        return; // 由调用方负责 spawn / 退出
      } catch (e) {
        log.error(`优雅关闭失败，直接重启：${e.message}`);
      }
    }

    this.#spawnSelf();
    process.exit(0);
  }

  /**
   * 拉起一个新进程，继承当前参数。
   * detached + stdio inherit：新进程不随父进程退出而死，输出还接在同一个终端。
   */
  #spawnSelf() {
    try {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        detached: true,
        stdio: 'inherit',
        env: { ...process.env, ROOST_RESTARTED: '1' },
      });
      child.unref();
      log.info(`已拉起新进程 pid=${child.pid}`);
    } catch (e) {
      log.error(`拉起新进程失败：${e.message}（请手动重启）`);
    }
  }
}
