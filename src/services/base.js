/**
 * 服务基类
 * ========
 *
 * 单独一个文件是为了避开循环依赖：
 * index.js 要 import 各个服务，各个服务又要继承 BaseService。
 * 放在 index.js 里就成了环，ESM 会报
 * `Cannot access 'BaseService' before initialization`。
 */
import { createLogger } from '../logger.js';

const log = createLogger('services');

export class BaseService {
  constructor(name, label) {
    this.name = name;
    this.label = label;
    this.state = 'idle'; // idle | running | error
    this.detail = '';
    this.timer = null;
    this.intervalMs = 60000;
    /** 防重入：上一轮 tick 还没结束就不开下一轮 */
    this.busy = false;
  }

  /** 子类实现：一次执行体 */
  async tick() {}

  /** 子类可覆盖：启动时的额外动作 */
  async start() {
    this.state = 'running';
    // 先跑一次（不阻塞启动），再按间隔跑
    setTimeout(() => this.#run().catch(() => {}), 3000).unref?.();
    this.timer = setInterval(() => this.#run().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'idle';
  }

  async #run() {
    /**
     * 上一轮还没跑完就直接跳过。
     *
     * tick 里可能有慢操作（比如装插件依赖要几秒），比 intervalMs 还长。
     * 不拦的话 setInterval 会一轮接一轮地叠上来，同一件事被反复触发——
     * 插件目录「每 2 秒发现一次新插件、反复重装依赖」就是这么来的。
     */
    if (this.busy) return;
    this.busy = true;
    try {
      await this.tick();
      this.state = 'running';
    } catch (e) {
      this.state = 'error';
      this.detail = e.message;
      log.warn(`服务 ${this.name} 执行出错: ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
