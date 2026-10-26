/**
 * 监听器派发的两条规则：**顺序**和**认领**。
 *
 * 抽成单独文件不是为了好看，是为了能单独测——
 * 这两条规则错了，表现是「两个插件同时回答同一句话」或者
 * 「该说话的那个被前一个插件挡掉了」，都是很难复现的那种 bug。
 */

/**
 * 按插件优先级排序：**高的先跑**，同优先级保持注册顺序。
 *
 * 为什么顺序重要：`msg.claim()` 是「这条我接了，别人别管」，
 * 谁先跑谁就能认领。专门干某件事的插件（关键词、群管）应该先跑；
 * 像「AI 对话」这种什么都想接的，priority 调低排最后。
 *
 * @param {Array<{pluginId:string}>} listeners
 * @param {(pluginId:string) => object|undefined} metaOf
 * @returns {Array} 排好序的新数组（不改原数组）
 */
export function orderListeners(listeners, metaOf = () => undefined) {
  return (listeners ?? [])
    .map((l, i) => ({ l, i, p: Number(metaOf(l.pluginId)?.priority) || 0 }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x) => x.l);
}

/**
 * 这条消息已经被别人认领了，当前插件要不要跳过。
 *
 * 默认跳过。确实需要看全部消息的插件在 meta 里声明 `seeClaimed: true`，
 * 它照样能收到，并且能从 `msg.claimedBy` 知道是谁接的。
 *
 * 自己认领的不算——同一个插件注册了多个监听器时，
 * 第一个认领了不该把同一个插件的第二个也挡掉。
 *
 * @param {object} msg
 * @param {string} pluginId
 * @param {object} [meta]
 * @returns {boolean}
 */
export function skipBecauseClaimed(msg, pluginId, meta) {
  if (!msg?.claimedBy) return false;
  if (msg.claimedBy === pluginId) return false;
  return meta?.seeClaimed !== true;
}
