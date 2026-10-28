/**
 * 更新会替换的代码条目（单一来源）
 * ================================
 *
 * 三处共用：
 *   1. `updater.js` 备份与替换（rsync 式覆盖，绝不碰 config/data/logs/plugins）
 *   2. `gitee.js` 的前缀过滤（Gitee 没有 archive 直链，只能按清单逐个拉）
 *   3. `scripts/build-sums.mjs` 算内容指纹的范围
 *
 * 为什么指纹也按这个范围算：GitHub 的 tarball 是**全量**（还带 .github、
 * scripts、sdk、types），而 Gitee 源只拉下面这几个条目。如果指纹按「包里的
 * 全部文件」算，两条下载路径永远对不上 —— 一边写死校验失败，一边等于没校验。
 *
 * 改这个清单要连带重跑 `npm run sums`，否则已发布的指纹会全部失配。
 */
export const CODE_ENTRIES = [
  'src',
  'web',
  'test',
  'docs',
  'package.json',
  'README.md',
  'LICENSE',
  'start.bat',
];

/** 绝对不能删/覆盖的目录（双保险） */
export const PROTECTED_ENTRIES = new Set(['config', 'data', 'logs', 'plugins', 'node_modules', '.git']);
