/**
 * 自动检查更新
 * ============
 *
 * 每 6 小时查一次有没有新版本。
 *
 * **只检查，不自动装**。自动装代码风险太高——万一新版有 bug，
 * 用户是在「不知道发生了什么」的情况下被升级的。
 * 发现新版就写日志 + 面板显示红点，让用户自己决定。
 *
 * 想全自动的话把 `update.autoApply` 设为 true，但**默认关**。
 */
import { BaseService } from './base.js';
import { createLogger } from '../logger.js';
import { checkUpdate, applyUpdate, currentVersion } from '../updater.js';

const log = createLogger('auto-update');

export class AutoUpdateService extends BaseService {
  constructor({ globalCfg }) {
    super('autoUpdate', '检查更新');
    this.cfg = globalCfg?.update ?? {};
    // 6 小时查一次，GitHub 也不至于被烦。
    // 必须钳制：0/负数会让 setInterval 退化成 1ms 轮询，
    // 超过 596 小时又会溢出 2^31 变成 1ms——两种都会狂打 GitHub。
    const hours = Number(this.cfg.intervalHours ?? 6);
    this.intervalMs = Math.min(Math.max(Number.isFinite(hours) && hours > 0 ? hours : 6, 0.25), 168) * 3600_000;
    /** 最近一次检查结果，面板用 */
    this.last = null;
    this.checkedAt = 0;
  }

  async tick() {
    const r = await checkUpdate();
    this.last = r;
    this.checkedAt = Date.now();

    if (!r.ok) {
      this.detail = `检查失败：${r.error}`;
      // 网络问题只 debug，不刷 WARNING 吓人
      log.debug(`检查更新失败：${r.error}`);
      return;
    }

    if (!r.hasUpdate) {
      this.detail = `已是最新 v${r.current}`;
      return;
    }

    this.detail = `发现新版 v${r.latest}（当前 v${r.current}）`;
    log.info(`发现新版本 v${r.latest}（当前 v${r.current}），到面板「概览 → 框架版本」更新`);

    // 全自动安装：默认关，开了就要接受「可能装到有 bug 的版本」
    if (this.cfg.autoApply === true) {
      log.warn(`自动更新已开启，正在升级到 v${r.latest}…`);
      const res = await applyUpdate(r).catch((e) => ({ ok: false, error: e.message }));
      if (res.ok) {
        log.warn(`已升级到 v${res.to}，**重启后生效**`);
        this.detail = `已自动升级到 v${res.to}，需重启`;
      } else {
        log.error(`自动更新失败：${res.error}`);
        this.detail = `自动更新失败：${res.error}`;
      }
    }
  }

  /** 面板用 */
  snapshot() {
    return {
      last: this.last,
      checkedAt: this.checkedAt,
      state: this.state,
      detail: this.detail,
    };
  }
}
