/**
 * 插件 HTTP 路由注册表
 * ====================
 *
 * 为什么需要它：`ctx.registerPage()` 只是把一段 HTML 塞进 iframe，
 * **服务端不会在每个请求时回调插件**。所以「插件自带管理页」这件事，
 * 页面能画出来，却拿不到自己的数据——除非走 KV 存档（`/api/plugins/:id/data`），
 * 而 KV 既没有事务也没有查询能力。
 *
 * 这里补上缺的那一环：插件注册 REST 路由，挂在
 *
 *     /api/plugins/<插件id>/r<插件自己写的路径>
 *
 * 前缀 `/r/` 是有意选的——现有 `/api/plugins/:id/panel|config|data` 已经被占用，
 * 换个前缀就不用去动那些分支，回滚时删掉这一块即可。
 *
 * 鉴权**完全复用**面板那套：路由分发写在 `authorized()` / CSRF / 同源校验之后，
 * 插件拿不到裸 req/res，也就不可能绕开它们。
 *
 * 和 pages 一样：插件卸载 / 重载时自动清空，不会留下打不开的死接口。
 */
import { createLogger } from '../logger.js';

const log = createLogger('routes');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** 单个插件最多注册多少条，防止插件写飞了把内存占满 */
const MAX_PER_PLUGIN = 200;

/**
 * 把 `/players/:openid/items` 编译成 `{ re, keys }`。
 *
 * 只支持 `:name` 形式的路径参数，不支持通配和正则——够用，而且不会有
 * 正则回溯这类安全问题。
 */
function compile(pattern) {
  const keys = [];
  const body = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return { re: new RegExp(`^${body}$`), keys };
}

export class RouteRegistry {
  constructor() {
    /** 插件id -> [{ method, pattern, re, keys, handler }] */
    this.byPlugin = new Map();
  }

  /**
   * @param {string} pluginId
   * @param {string} method  GET / POST / PUT / PATCH / DELETE
   * @param {string} pattern 以 `/` 开头，可含 `:param`
   * @param {(req:{params:object,query:object,body:any,method:string,json:Function})=>any} handler
   * @returns {string|null} `METHOD /path`，环境不支持时返回 null
   */
  add(pluginId, method, pattern, handler) {
    const m = String(method ?? '').toUpperCase();
    const p = String(pattern ?? '').trim();

    if (!METHODS.has(m)) throw new Error(`不支持的方法：${method}（只允许 ${[...METHODS].join('/')}）`);
    if (!p.startsWith('/')) throw new Error(`路由必须以 / 开头：${p}`);
    if (typeof handler !== 'function') throw new Error(`路由 ${m} ${p} 缺少处理函数`);

    const list = this.byPlugin.get(pluginId) ?? [];
    if (list.length >= MAX_PER_PLUGIN) {
      throw new Error(`插件 ${pluginId} 的路由超过上限 ${MAX_PER_PLUGIN} 条`);
    }
    if (list.some((r) => r.method === m && r.pattern === p)) {
      throw new Error(`插件 ${pluginId} 重复注册路由：${m} ${p}`);
    }

    list.push({ method: m, pattern: p, ...compile(p), handler });
    this.byPlugin.set(pluginId, list);
    log.info(`插件 ${pluginId} 注册了路由 ${m} ${p}`);
    return `${m} ${p}`;
  }

  /**
   * 找匹配的路由。
   * @returns {{handler:Function, params:object}|null}
   */
  match(pluginId, method, pathname) {
    const list = this.byPlugin.get(pluginId);
    if (!list?.length) return null;
    const m = String(method ?? '').toUpperCase();
    for (const r of list) {
      if (r.method !== m) continue;
      const hit = r.re.exec(pathname);
      if (!hit) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(hit[i + 1] ?? '');
      });
      return { handler: r.handler, params };
    }
    return null;
  }

  /** 插件卸载 / 重载时清掉它的全部路由 */
  clearPlugin(pluginId) {
    const n = this.byPlugin.get(pluginId)?.length ?? 0;
    this.byPlugin.delete(pluginId);
    if (n) log.info(`已移除插件 ${pluginId} 的 ${n} 条路由`);
    return n;
  }

  /** 给面板看的清单（不含 handler） */
  list() {
    const out = [];
    for (const [pluginId, list] of this.byPlugin) {
      for (const r of list) out.push({ pluginId, method: r.method, path: `/api/plugins/${pluginId}/r${r.pattern}` });
    }
    return out;
  }

  get size() {
    let n = 0;
    for (const list of this.byPlugin.values()) n += list.length;
    return n;
  }
}

/**
 * 执行一条匹配到的路由，并把返回值归一成 `{ code, data }`。
 *
 * 单独抽出来是为了**可测**：HTTP 那层只负责读 body / 写响应，
 * 判断「插件返回了什么」的逻辑在这里，不依赖 socket。
 *
 * 插件返回值三种情况：
 *   - `json(code, data)` 的返回值 → 用指定状态码
 *   - undefined / null           → 204
 *   - 其它对象                    → 200
 */
export async function runRoute(hit, { query = {}, body = null, method = 'GET' } = {}) {
  const out = await hit.handler({
    params: hit.params ?? {},
    query,
    body,
    method,
    json: (code, data) => ({ __response: { code, data } }),
  });
  if (out && typeof out === 'object' && out.__response) {
    return { code: out.__response.code, data: out.__response.data };
  }
  if (out === undefined || out === null) return { code: 204, data: null };
  return { code: 200, data: out };
}
