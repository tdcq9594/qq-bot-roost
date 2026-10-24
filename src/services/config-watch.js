/**
 * 配置热加载
 * ==========
 *
 * 手改了 `config/bot.json` 或 `config/bots/*.json`，不用重启进程。
 *
 * **用轮询不用 fs.watch**：watch 在 Windows 上对「编辑器保存」这种
 * 先写临时文件再改名的方式经常漏事件，网络盘上更不可靠。
 * 每 3 秒比一次 mtime，开销可以忽略，行为却稳定得多。
 *
 * 能热改的和不能的：
 *   - 能：日志级别、限流、白名单、命令前缀、intents、owners、群管开关
 *   - 不能：面板监听地址/端口（已经 bind 了）、机器人增删（要建/拆运行时）
 * 不能热的会明确提示，而不是静默忽略。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseService } from './base.js';
import { createLogger, setLevel } from '../logger.js';
import { DIRS, PATHS } from '../paths.js';
import { loadGlobalConfig, loadBotConfig } from '../config.js';
import { configureMirror } from '../mirror.js';

const log = createLogger('config-watch');

export class ConfigWatchService extends BaseService {
  constructor({ globalCfg, onReload }) {
    super('configWatch', '配置热加载');
    this.globalCfg = globalCfg;
    this.onReload = onReload;
    this.intervalMs = 3000;
    /** path -> mtime，用来判断变没变 */
    this.seen = new Map();
    /** 首次扫描只记录，不触发重载 */
    this.primed = false;
  }

  async tick() {
    const files = [PATHS.globalConfig];
    try {
      for (const name of await fs.readdir(DIRS.botsConfig)) {
        if (name.endsWith('.json')) files.push(path.join(DIRS.botsConfig, name));
      }
    } catch {
      /* 目录还没建，忽略 */
    }

    const changed = [];
    for (const f of files) {
      const st = await fs.stat(f).catch(() => null);
      const mt = st?.mtimeMs ?? 0;
      const prev = this.seen.get(f);
      this.seen.set(f, mt);
      if (!this.primed) continue;
      if (prev !== undefined && prev !== mt) changed.push(f);
    }

    if (!this.primed) {
      this.primed = true;
      this.detail = `监视 ${files.length} 个配置文件`;
      return;
    }

    if (!changed.length) return;

    // 防抖：编辑器保存可能连着改好几个文件，等 500ms 一起处理
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.#apply(changed).catch((e) => log.warn(`应用配置失败: ${e.message}`));
    }, 500);
  }

  async #apply(changed) {
    const names = changed.map((f) => path.basename(f)).join('、');
    log.info(`检测到配置变更：${names}`);

    // 全局配置
    if (changed.includes(PATHS.globalConfig)) {
      try {
        const before = { host: this.globalCfg?.webui?.host, port: this.globalCfg?.webui?.port };
        const after = await loadGlobalConfig();

        // 端口/监听地址改了不能热应用——端口已经 bind 了
        if (before.host !== after.webui?.host || before.port !== after.webui?.port) {
          log.warn('面板监听地址/端口已修改，需要重启进程才生效');
        }

        // 把新值合并进内存里的全局配置（保持对象引用不变，别处都拿着它）
        if (this.globalCfg) {
          Object.assign(this.globalCfg, after);
          // webui 是嵌套对象，单独合并，避免整个替换掉
          if (after.webui) this.globalCfg.webui = { ...this.globalCfg.webui, ...after.webui };
        }

        // 日志级别可以立刻生效
        if (after.logLevel) setLevel(after.logLevel);
        // 下载源改了也要立刻生效，不然得重启（用户改的就是这个文件）
        configureMirror(this.globalCfg);

        this.onReload?.(after, null);
        log.info('全局配置已重新加载');
      } catch (e) {
        log.warn(`全局配置重载失败（文件可能写了一半）：${e.message}`);
      }
    }

    // 机器人配置
    for (const f of changed) {
      if (f === PATHS.globalConfig) continue;
      const id = path.basename(f, '.json');
      try {
        const next = await loadBotConfig(id);
        this.onReload?.(null, next);
        log.info(`机器人 ${id} 的配置已重新加载`);
      } catch (e) {
        log.warn(`机器人 ${id} 配置重载失败：${e.message}`);
      }
    }
  }
}
