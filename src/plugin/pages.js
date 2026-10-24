/**
 * 插件自定义页面注册表
 * ====================
 *
 * 插件可以往面板里加自己的页面，比如「斗罗战绩」「点歌队列」。
 * 插件作者不用改面板代码，写一段 HTML 就行：
 *
 *   ctx.registerPage({
 *     key: 'board',
 *     label: '战绩榜',
 *     html: '<h1>...</h1>',
 *   });
 *
 * 三条约束：
 *   - key 只在插件内部唯一，注册表里统一加 `<插件id>:` 前缀，插件之间不会撞
 *   - 插件卸载 / 重载时自动清掉它的页面，不会留下打不开的死标签
 *   - 页面在 iframe 里渲染：CSS 不会漏到面板上，脚本也拿不到面板的 DOM
 *
 * 关于安全：插件**本身**就是可信代码（内建插件跑在主进程，外部插件是子进程），
 * 所以这里不做权限校验。iframe 的作用是样式隔离和避免互相干扰，不是沙箱边界。
 */
import { createLogger } from '../logger.js';

const log = createLogger('pages');

/** HTML 上限，防止插件把几百兆塞进内存 */
const MAX_HTML = 512 * 1024;

export class PageRegistry {
  constructor() {
    /** `${pluginId}:${key}` -> { key, label, html, pluginId } */
    this.pages = new Map();
  }

  /**
   * @param {string} pluginId
   * @param {{key:string, label:string, html:string}} page
   */
  register(pluginId, page) {
    const key = String(page?.key ?? '').trim();
    const label = String(page?.label ?? '').trim();
    let html = String(page?.html ?? '');

    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) {
      throw new Error(`页面 key 不合法：${key}（只允许小写字母、数字、下划线、横线）`);
    }
    if (!label) throw new Error('页面必须给一个 label（标签上显示的名字）');
    if (!html.trim()) throw new Error('页面 html 不能为空');
    if (html.length > MAX_HTML) {
      throw new Error(`页面 html 太大（${(html.length / 1024).toFixed(0)} KB），上限 512 KB`);
    }

    const full = `${pluginId}:${key}`;
    this.pages.set(full, { key: full, shortKey: key, label, html, pluginId });
    log.info(`插件 ${pluginId} 注册了面板页面「${label}」(${full})`);
    return full;
  }

  /** 插件卸载 / 重载时清掉它的全部页面 */
  clearPlugin(pluginId) {
    let n = 0;
    for (const [k, v] of this.pages) {
      if (v.pluginId === pluginId) {
        this.pages.delete(k);
        n += 1;
      }
    }
    if (n) log.info(`已移除插件 ${pluginId} 的 ${n} 个面板页面`);
    return n;
  }

  /** 给面板的列表，不含 html（可能很大） */
  list() {
    return [...this.pages.values()].map((p) => ({
      key: p.key,
      label: p.label,
      pluginId: p.pluginId,
    }));
  }

  get(key) {
    return this.pages.get(String(key)) ?? null;
  }

  get size() {
    return this.pages.size;
  }
}
