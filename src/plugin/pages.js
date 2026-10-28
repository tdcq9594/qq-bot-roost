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
 * 所以这里不做权限校验。iframe 的作用是样式隔离和避免互相干扰。
 *
 * ## 页面令牌（page token）
 *
 * 2026-10-28 加：以前 iframe 地址上直接拼面板的 accessKey，插件页一行
 * `location.search` 就能拿到面板全权（装插件 = 交出面板密码）。现在每个页面
 * 注册时生成一个随机 token，iframe 只带 `?pt=<token>`，并且在面板侧配
 * `sandbox="allow-scripts allow-forms"`（不给 allow-same-origin），
 * 插件页既读不到父页 localStorage，也拿不到面板密钥。
 *
 * token 的权限边界由 server.js 的 `authorized()` 决定：只放行**该插件自己**的
 * 页面与接口（`/api/pages/<id>:<key>/html`、`/api/plugins/<id>/panel`、
 * `/api/plugins/<id>/r/*`），不放行 `/api/config`、`/api/logs` 等面板接口。
 * 方法不限于 GET —— 斗罗那类运营后台要 POST 改数据，只读会直接废掉它，
 * 而限制「插件写自己的数据」没有安全收益（插件本来就有子进程执行权）。
 */
import crypto from 'node:crypto';
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
    /**
     * 页面令牌：24 字节随机（48 位十六进制），进程内有效。
     * 插件重载会重新 register，于是自动换一把新的——旧页面标签刷一下就拿不到了，
     * 这正是想要的（卸载/重载后旧链接失效）。
     */
    const token = crypto.randomBytes(24).toString('hex');
    this.pages.set(full, { key: full, shortKey: key, label, html, pluginId, token });
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
      // 前端拼 iframe 地址用。列表接口本身是鉴权过的，所以这里给得出去
      token: p.token,
    }));
  }

  /**
   * 按页面令牌反查。给 `authorized()` 用：iframe 是 opaque origin，
   * 拿不到 Cookie，只能靠这个 token 证明「我是这个面板页」。
   * @returns {{key:string, pluginId:string, token:string}|null}
   */
  findByToken(token) {
    if (!token) return null;
    for (const p of this.pages.values()) {
      if (p.token === token) return p;
    }
    return null;
  }

  get(key) {
    return this.pages.get(String(key)) ?? null;
  }

  get size() {
    return this.pages.size;
  }
}
