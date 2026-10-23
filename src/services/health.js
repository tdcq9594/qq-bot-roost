/**
 * 健康巡检
 * ========
 *
 * 每分钟采一次样，每 5 分钟打一条摘要，超阈值才 WARNING。
 *
 * 为什么要它：机器人跑几天没人看，内存涨到 1G、事件积压几千条、
 * 断线重连几十次——这些都不会自己报错，只是越来越慢。
 * 有巡检的话日志里能看出趋势。
 *
 * 不引入监控后端（Prometheus 之类），就看进程自己的数。
 */
import process from 'node:process';
import { BaseService } from './base.js';
import { createLogger } from '../logger.js';

const log = createLogger('health');

/** 阈值。超了就 WARNING，不是致命错误 */
const LIMITS = {
  rssMB: 600, // 单进程 RSS
  eventBacklog: 2000, // 单机器人事件积压
  reconnectCount: 30, // 累计重连次数（一小时内）
  sessionCount: 5000, // 会话表大小
};

export class HealthService extends BaseService {
  constructor({ getRuntimes }) {
    super('health', '健康巡检');
    this.getRuntimes = getRuntimes;
    this.intervalMs = 60_000;
    /** 最近 5 次采样的摘要，用来算趋势 */
    this.samples = [];
    this.lastSummaryAt = 0;
  }

  async tick() {
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1048576);
    const heapMB = Math.round(mem.heapUsed / 1048576);

    let bots = [];
    try {
      bots = this.getRuntimes() ?? [];
    } catch {
      bots = [];
    }

    const perBot = bots.map((rt) => {
      const counters = rt.runtime?.counters ?? {};
      const backlog = counters.queued ?? 0;
      const reconnects = rt.runtime?.reconnectCount ?? 0;
      const sessions = rt.session?.size ?? 0;
      return {
        id: rt.id,
        state: rt.state,
        reconnects,
        backlog,
        sessions,
        received: counters.received ?? 0,
        sent: counters.sent ?? 0,
      };
    });

    const sample = { at: Date.now(), rssMB, heapMB, bots: perBot };
    this.samples.push(sample);
    if (this.samples.length > 5) this.samples.shift();

    this.detail = `RSS ${rssMB}MB · 堆 ${heapMB}MB`;

    // 超阈值告警（每次都查，不等到摘要）
    if (rssMB > LIMITS.rssMB) {
      log.warn(`内存偏高：RSS ${rssMB}MB（阈值 ${LIMITS.rssMB}MB）`);
    }
    for (const b of perBot) {
      if (b.backlog > LIMITS.eventBacklog) {
        log.warn(`[${b.id}] 事件积压 ${b.backlog} 条（阈值 ${LIMITS.eventBacklog}）`);
      }
      if (b.reconnects > LIMITS.reconnectCount) {
        log.warn(`[${b.id}] 已重连 ${b.reconnects} 次，检查网络或凭证`);
      }
      if (b.sessions > LIMITS.sessionCount) {
        log.warn(`[${b.id}] 会话数 ${b.sessions}，可能有会话没释放`);
      }
    }

    // 每 5 分钟一条摘要
    const now = Date.now();
    if (now - this.lastSummaryAt >= 5 * 60_000) {
      this.lastSummaryAt = now;
      const parts = perBot.map((b) => `${b.id}:${b.state}(收${b.received}/发${b.sent})`);
      log.info(`健康摘要 · RSS ${rssMB}MB · 堆 ${heapMB}MB · ${parts.join(' ') || '无机器人'}`);
    }
  }

  /** 面板用：最近一次采样 */
  snapshot() {
    return this.samples[this.samples.length - 1] ?? null;
  }
}
