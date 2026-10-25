/**
 * 分群插件开关
 * =============
 *
 * `cfg.plugins` 的形状（见 config/bot.json）：
 *
 *   {
 *     "mode": "all" | "include" | "exclude",   // 全局：全部 / 白名单 / 黑名单
 *     "list": ["ai-chat", ...],
 *     "groups": {
 *       "<群openid>": { "mode": "include" | "exclude" | "all", "list": [...] }
 *     }
 *   }
 *
 * 某个群没配 `groups[chatId]` 就跟随全局（见 bot.js 的 pluginAllowedIn）。
 *
 * 这里只解决一件事：**把「某个群里关掉/打开某一个插件」翻译成上面那个结构**。
 *
 * 为什么要单独抽出来：面板（web/server.js）和机器人指令（main.js 的 /群插件）
 * 改的是同一份配置，两边各写一套「怎么改」迟早会写出两种结果。
 *
 * 翻译规则：
 *   - 全局 all（默认全开）：关一个 → 给这个群写 exclude 名单；
 *     再打开时从名单里摘掉，名单空了就把整个群配置删掉（回到跟随全局）。
 *   - 全局 include / 该群是 include（白名单）：直接在名单里加/减这个插件。
 *   - 该群是 exclude：同上，加减名单。
 *
 * 注意 exclude 名单在「全局 include」下没有意义（exclude 表示「除了这些，其余都开」，
 * 会把全局白名单架空），所以那种情况一律走 include 名单。
 */

/**
 * 把一份名单归一成「能比大小的形状」。
 *
 * 关键是 `exclude` 空名单和 `all` 是**同一件事**（都表示全开），
 * 只比 mode 字面值会漏掉这种等价，结果留下一条
 * `{mode:"exclude", list:[]}` 的幽灵配置：行为上没区别，
 * 但描述成「自定义：关 0 个」，而且以后改全局它不跟着变。
 */
function normalize(mode, list) {
  if (mode === 'all' || (mode === 'exclude' && !list.length)) return { mode: 'all', list: [] };
  return { mode, list: [...list].sort() };
}

/**
 * 这个群的配置是不是已经和全局一模一样了（语义上，不是字面上）。
 */
function sameAsGlobal(mode, list, globalMode, globalList) {
  const a = normalize(mode, list);
  const b = normalize(globalMode, globalList);
  if (a.mode !== b.mode || a.list.length !== b.list.length) return false;
  return a.list.every((x, i) => x === b.list[i]);
}

/**
 * @param {object} spec `cfg.plugins`
 * @param {string} chatId 群 openid
 * @param {string} pluginId 插件 id
 * @param {boolean} enabled true=在这个群启用，false=在这个群关掉
 * @returns {object} 新的 `groups` 对象（不含 mode/list，调用方自己拼回去）
 */
export function toggleGroupPlugin(spec, chatId, pluginId, enabled) {
  const groupsCfg = { ...(spec?.groups ?? {}) };
  const own = groupsCfg[chatId];
  const globalMode = spec?.mode ?? 'all';
  const globalList = Array.isArray(spec?.list) ? spec.list : [];

  // 这个群现在实际用的是哪套名单
  const mode = own?.mode ?? globalMode;
  const list = new Set(own ? (own.list ?? []) : globalMode === 'all' ? [] : globalList);

  if (mode === 'all') {
    // 全开：只有「关掉某一个」才需要写配置
    if (enabled) return groupsCfg;
    groupsCfg[chatId] = { mode: 'exclude', list: [pluginId] };
    return groupsCfg;
  }

  if (mode === 'exclude') {
    if (enabled) list.delete(pluginId);
    else list.add(pluginId);
  } else {
    // include：白名单，直接加/减
    if (enabled) list.add(pluginId);
    else list.delete(pluginId);
  }

  const next = [...list];
  // 折腾完和全局一致了 → 整条删掉，回到「跟随全局」
  if (sameAsGlobal(mode, next, globalMode, globalList)) delete groupsCfg[chatId];
  else groupsCfg[chatId] = { mode, list: next };
  return groupsCfg;
}

/**
 * 把某个群恢复成「跟随全局」。
 * @param {object} spec
 * @param {string} chatId
 */
export function resetGroupPlugins(spec, chatId) {
  const groupsCfg = { ...(spec?.groups ?? {}) };
  delete groupsCfg[chatId];
  return groupsCfg;
}

/**
 * 一句话描述某个群当前是「跟随全局」还是「自定义」。
 * 面板和指令都用它，免得两边措辞不一样。
 */
export function describeGroupScope(spec, chatId) {
  const own = spec?.groups?.[chatId];
  if (!own) return '跟随全局';
  const n = (own.list ?? []).length;
  if (own.mode === 'include') return `自定义：只开 ${n} 个`;
  if (own.mode === 'exclude') return `自定义：关 ${n} 个`;
  return '自定义：全开';
}
