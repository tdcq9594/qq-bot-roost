/**
 * 跨插件 AI 工具的调用核心
 * ========================
 *
 * 工具注册在 `Registry.tools`（按工具名索引，重载插件时按 pluginId 清），
 * 这个文件只管**执行**：权限、超时、重入、调用上下文。
 *
 * 为什么单独拎出来：真 `ctx`（context.js）和插件测试夹具（testkit.js）都要
 * 能调工具。语义写两份必然分叉——夹具里「有权限、没超时」，线上「要管理员、
 * 15 秒超时」，插件作者在本地测通了上线却挂，是最难查的一类问题。
 */

/** 工具默认超时：AI 插件按轮推进，一个工具卡住等于整轮回复卡住 */
export const DEFAULT_TOOL_TIMEOUT_MS = 15000;

/**
 * @param {object} deps
 * @param {import('./context.js').Registry} deps.registry
 * @param {(userId:string)=>boolean} deps.isOwner
 * @param {(msg:object, need:string)=>Promise<boolean>} deps.can
 * @param {(msg:object)=>string} deps.scopeOf
 * @param {(msg:string)=>void} [deps.log]
 */
export function createToolCaller({ registry, isOwner, can, scopeOf, log = () => {} }) {
  /**
   * 执行一个工具。
   *
   * 失败一律 **throw**：调用方多半是 AI 插件，它要把「工具报错了」这句话
   * 回填给模型让模型自己圆回来。返回 null / '' 表示「成功但没内容」，
   * 这两种语义不能混。
   *
   * @param {string} name
   * @param {object} [args]
   * @param {{msg?:object, stack?:string[]}} [opts]
   *        `stack` 是内部用的调用链，别自己传。
   */
  return async function callTool(name, args = {}, { msg = null, stack = [] } = {}) {
    const key = String(name ?? '').trim();
    const t = registry.getTool(key);
    if (!t) throw new Error(`没有名为 "${key}" 的工具`);

    /**
     * 同一条调用链里不许重复出现同一个工具。
     *
     * 为什么用「链」而不是「全局正在执行集合」：全局集合会把**并发**误杀——
     * 两个群同时问一句，第二个请求会因为「第一个还在跑」被拒，
     * 而这两次调用本来毫无关系。用调用链则只挡真正的递归。
     */
    if (stack.includes(key)) {
      throw new Error(`工具 "${key}" 不能在自己的调用链里重复调用（会无限递归）`);
    }
    const nextStack = [...stack, key];

    const userId = msg?.userId ?? '';
    if (t.ownerOnly && !isOwner(userId)) {
      throw new Error(`工具 "${key}" 只有机器人主人能用`);
    }
    if (t.admin) {
      if (!msg) throw new Error(`工具 "${key}" 需要管理员身份，但调用方没给会话上下文`);
      if (!(await can(msg, 'admin'))) {
        throw new Error(`工具 "${key}" 需要当前会话的管理员权限`);
      }
    }

    const ms = t.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `工具 "${key}" 超过 ${ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`} 没返回`,
            ),
          ),
        ms,
      );
      // 别让一个 15s 的定时器把进程钉在事件循环里
      timer.unref?.();
    });

    const call = {
      msg,
      chatId: msg?.chatId ?? '',
      userId,
      userName: msg?.userName ?? '',
      kind: msg?.kind ?? '',
      scope: msg ? scopeOf(msg) : 'global',
      pluginId: t.pluginId,
      toolName: key,
      // 工具之间可以组合，但同样受重入与超时约束
      callTool: (n, a) => callTool(n, a, { msg, stack: nextStack }),
    };

    log(`调用工具 ${key}（注册方：${t.pluginId}）`);
    try {
      return await Promise.race([t.handler(args ?? {}, call), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}
