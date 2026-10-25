/**
 * 「跳过哪些目录」的单一来源。
 *
 * 两个用途的语义不同，**不要合并成一个集合**：
 *   - HASH_SKIP  ：供应链内容指纹（hashdir.js）。改它会让已发布插件的
 *                  sha256 变化 → 现有 index.json 全部校验失败，必须同步重建索引。
 *   - WATCH_SKIP ：热重载触发（plugin-watch.js）。在核心集之外额外跳过运行时
 *                  产物，避免插件写日志/存档时把热重载刷爆。
 */

/** 两边都该跳过：依赖目录、缓存、VCS 元数据 */
export const CORE_SKIP = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.git',
  '.idea',
  '.vscode',
]);

/** 内容指纹：保持现状（不要往里加 data / env 等运行时目录） */
export const HASH_SKIP = CORE_SKIP;

/** 热重载：核心集之外，再跳过运行时产物 */
export const WATCH_SKIP = new Set([...CORE_SKIP, 'env', 'dist', 'build', 'data', '.cache']);
