/**
 * 后台服务
 * =========
 *
 * 有些事得「一直在做」：盯着内存别涨爆、清掉过期文件、发现配置被手改了、
 * 定时重启、定期查更新。这些不属于任何一个机器人，属于整个进程。
 *
 * 所以统一放在这里，由 Services 一起启动、一起停。
 *
 * 设计原则：
 *   - **每个服务自己 try/catch**，一个崩了不能拖垮别的
 *   - 所有定时器都 `unref()`，不阻止进程退出
 *   - 启动失败只 warn，不阻止程序跑起来（服务是增强，不是必需）
 */
import { createLogger } from '../logger.js';
import { HealthService } from './health.js';
import { CleanupService } from './cleanup.js';
import { ConfigWatchService } from './config-watch.js';
import { RestartService } from './restart.js';
import { AutoUpdateService } from './auto-update.js';
import { PluginWatchService } from './plugin-watch.js';
import { NicknameService } from './nickname.js';
import { DevTicketService } from './dev-ticket.js';

const log = createLogger('services');

export class Services {
  /**
   * @param {object} p
   * @param {object} p.globalCfg
   * @param {() => object[]} p.getRuntimes  每次取当前的机器人列表（面板可能新建/删除）
   * @param {object} [p.onConfigReload]     配置热加载后的回调
   * @param {() => void} [p.onRestart]      定时重启的触发
   */
  constructor({ globalCfg, getRuntimes, onConfigReload, onRestart }) {
    this.globalCfg = globalCfg;
    this.getRuntimes = getRuntimes;
    this.list = [];

    const cfg = globalCfg.services ?? {};

    // 健康监控：默认开。开销极小（每分钟一次采样）
    if (cfg.health !== false) {
      this.list.push(new HealthService({ getRuntimes }));
    }
    // 清理：默认开。只删明确过期的临时/备份文件
    if (cfg.cleanup !== false) {
      this.list.push(new CleanupService({ globalCfg, getRuntimes }));
    }
    // 配置热加载：默认开。手改 config/*.json 不用重启
    if (cfg.configWatch !== false) {
      this.list.push(new ConfigWatchService({ globalCfg, onReload: onConfigReload }));
    }
    // 定时重启：默认关。需要显式配置时间
    if (globalCfg.restart?.enabled) {
      this.list.push(new RestartService({ globalCfg, onRestart }));
    }
    // 自动检查更新：默认开（只检查不安装），发现新版写日志 + 面板提示
    if (globalCfg.update?.autoCheck !== false) {
      this.list.push(new AutoUpdateService({ globalCfg }));
    }
    // 插件热重载：默认开。改完插件代码存盘即生效，不用重启也不用点重载
    if (globalCfg.plugins?.hotReload !== false) {
      this.list.push(new PluginWatchService({ globalCfg, getRuntimes }));
    }
    // 昵称同步：默认开。启动后把本机显示名对齐平台昵称（改了名不至于一直喊旧的）
    if (cfg.nickname !== false) {
      this.list.push(new NicknameService({ getRuntimes }));
    }
    /**
     * 开放平台票据自检：默认开。
     *
     * 它是**主动**检测——启动后探一次，之后每 30 分钟复查。票据过期就地在
     * 后台换票（无头浏览器，不弹窗），换不到才 warn。没有它的话，续期只能
     * 等某个请求撞上 401，用户得先打开面板才知道「早就过期了」。
     *
     * 配成对象时取 `minutes`；写 `false` 整体关掉。
     */
    if (cfg.devTicket !== false) {
      this.list.push(new DevTicketService({
        getRuntimes,
        minutes: cfg.devTicket?.minutes,
      }));
    }
  }

  async start() {
    for (const s of this.list) {
      try {
        await s.start();
      } catch (e) {
        log.warn(`服务 ${s.name} 启动失败（不影响主程序）：${e.message}`);
      }
    }
    if (this.list.length) {
      log.info(`后台服务已启动: ${this.list.map((s) => s.name).join('、')}`);
    }
  }

  async stop() {
    for (const s of this.list) {
      try {
        await s.stop();
      } catch {
        /* 退出阶段，忽略 */
      }
    }
  }

  /** 面板展示用 */
  status() {
    return this.list.map((s) => ({
      name: s.name,
      label: s.label,
      state: s.state ?? 'idle',
      detail: s.detail ?? '',
    }));
  }
}

// 兼容：外部仍可从 index.js 导入 BaseService
export { BaseService } from './base.js';
