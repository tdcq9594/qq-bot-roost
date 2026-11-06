#!/usr/bin/env node
/**
 * WebUI 重构的 DOM 契约快照。
 *
 * 背景：2026-11-06 的 WebUI 重构只改布局，不改功能。这份脚本把「功能不变量」
 * 变成可机器校验的基线：页签值、全部 id、CSS 变量名、面板/表格/弹窗数量、
 * API 调用数、关键函数与挂载点。
 *
 * 用法（在 douluo/bot 下，零依赖）：
 *   node test/webui-contract.mjs --save    生成/更新基线
 *   node test/webui-contract.mjs --check   与基线比对，不一致则退出码 1
 *   node test/webui-contract.mjs           只打印当前摘要
 *
 * 基线文件与脚本同目录，方便跨会话移交（见 交接-2026-11-06-WebUI重构.md）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASELINE = path.join(HERE, 'webui-contract-baseline.json');
// --from-head 让基线严格取自「重构前」的 HEAD，而不是已改动的工作区
const FROM_HEAD = process.argv.includes('--from-head');
// git 里是 LF、Windows 工作区是 CRLF，不统一会让内容哈希假报警
const read = (p) => (FROM_HEAD
  ? execFileSync('git', ['show', `HEAD:${p}`], { cwd: ROOT, encoding: 'utf8' })
  : fs.readFileSync(path.join(ROOT, p), 'utf8')
).replace(/\r\n/g, '\n');

const REQUIRED_IDS = [
  'pluginPageItems', 'pluginPageSep', 'pluginPageLabel',
  'btnTheme', 'btnShutdown', 'connPill', 'botSwitch', 'modalMask',
  'botTrigger', 'botMenu', 'botList', 'newBotMask', 'pluginPanelMask',
];
const REQUIRED_FNS = [
  'function activateTab', 'function closeTabMenus', 'function tabButton',
  'function loadPluginPages', 'function pluginPageUrl', 'function setTheme',
  'function connectStream', 'function pollStatus',
];

function snapshot() {
  const html = read('web/index.html');
  const css = read('web/style.css');
  const js = read('web/app.js');
  const server = read('src/web/server.js');

  const tabs = [...html.matchAll(/\bdata-tab="([^"]+)"/g)].map((m) => m[1]).sort();
  const ids = [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))].sort();
  // 变量名 + 值一起记：只记名字的话，把 --primary 改成别的颜色也照样 PASS；
  // 大小写不敏感，避免 --Primary 这类写法漏网。
  const cssVarDefs = [...css.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;}]+)/g)]
    .map((m) => `${m[1]}=${m[2].trim()}`).sort();
  const cssVars = [...new Set([...css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]))].sort();
  // 引用了却没定义的变量 = 改名后留下的悬空 var()
  const varRefs = [...new Set([...css.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)].map((m) => m[1]))].sort();

  return {
    tabs,
    ids,
    cssVars,
    cssVarDefs,
    varRefs,
    counts: {
      panels: (html.match(/<section\s+id="tab-/g) || []).length,
      tables: (html.match(/<table\b/g) || []).length,
      modals: (html.match(/class="modal-mask"/g) || []).length,
      controls: (html.match(/<(?:input|button|select|textarea)\b/g) || []).length,
      apiCalls: (js.match(/\bapi\(/g) || []).length,
    },
    requiredIds: REQUIRED_IDS.map((id) => ({ id, present: ids.includes(id) })),
    requiredFns: REQUIRED_FNS.map((fn) => ({ fn, present: js.includes(fn) })),
    checks: {
      nav: /<nav\b/.test(html),
      main: /<main\b/.test(html),
      pluginMount: html.includes('id="pluginPageItems"'),
      tabGroupClass: html.includes('tab-group'),
      tabParentClass: html.includes('tab-parent'),
      tabMenuClass: html.includes('tab-menu'),
      tabItemClass: html.includes('tab-item'),
      cspScriptSelf: /script-src 'self'/.test(server),
      pageThemeMirror: /PAGE_THEME/.test(server),
      // 内容哈希而非文件大小：等长替换也能被抓到
      serverHash: crypto.createHash('sha256').update(server).digest('hex'),
    },
  };
}

function compare(base, cur) {
  const errs = [];
  const diffList = (name, a, b) => {
    const missing = a.filter((x) => !b.includes(x));
    const added = b.filter((x) => !a.includes(x));
    if (missing.length) errs.push(`${name} 丢失: ${missing.join(', ')}`);
    if (added.length) errs.push(`${name} 新增(需评审): ${added.join(', ')}`);
  };

  // 页签值必须完全一致，且不能出现重复（重复会让 activateTab 只高亮第一个）
  if (JSON.stringify(base.tabs) !== JSON.stringify(cur.tabs)) {
    diffList('data-tab', base.tabs, cur.tabs);
  }
  const dup = cur.tabs.filter((t, i) => cur.tabs.indexOf(t) !== i);
  if (dup.length) errs.push(`data-tab 重复: ${[...new Set(dup)].join(', ')}`);

  // 原有 id / CSS 变量名只能增不能减；减少 = 有功能或插件页主题被破坏
  const missingIds = base.ids.filter((x) => !cur.ids.includes(x));
  if (missingIds.length) errs.push(`id 丢失: ${missingIds.join(', ')}`);
  const missingVars = base.cssVars.filter((x) => !cur.cssVars.includes(x));
  if (missingVars.length) errs.push(`CSS 变量丢失(会破坏插件页主题): ${missingVars.join(', ')}`);
  // 变量定义双向比对：改名、改值、删定义、擅自新增都要报出来
  if (base.cssVarDefs || cur.cssVarDefs) {
    diffList('CSS 变量定义', base.cssVarDefs || [], cur.cssVarDefs || []);
  }
  const dangling = (cur.varRefs || []).filter((v) => !cur.cssVars.includes(v));
  if (dangling.length) errs.push(`var() 引用了未定义变量: ${dangling.join(', ')}`);

  for (const k of ['panels', 'tables', 'modals', 'apiCalls']) {
    if (base.counts[k] !== cur.counts[k]) {
      errs.push(`counts.${k}: 基线 ${base.counts[k]} → 当前 ${cur.counts[k]}`);
    }
  }
  if (cur.counts.controls < base.counts.controls) {
    errs.push(`counts.controls 减少: ${base.counts.controls} → ${cur.counts.controls}`);
  }

  for (const x of cur.requiredIds) if (!x.present) errs.push(`必需 id 缺失: ${x.id}`);
  for (const x of cur.requiredFns) if (!x.present) errs.push(`必需函数缺失: ${x.fn}`);
  for (const [k, v] of Object.entries(cur.checks)) {
    if (k === 'serverHash') continue;
    if (v !== true) errs.push(`结构检查失败: ${k}`);
  }
  if (base.checks.serverHash !== cur.checks.serverHash) {
    errs.push('src/web/server.js 内容变化 —— 本次重构约定服务端零改动，请人工确认');
  }
  return errs;
}

const arg = process.argv[2] || '';
const cur = snapshot();

if (arg === '--save') {
  fs.writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + '\n');
  console.log(`基线已写入 ${BASELINE}`);
  console.log(`  data-tab ${cur.tabs.length} 项 / id ${cur.ids.length} 个 / CSS 变量 ${cur.cssVars.length} 个`);
  console.log(`  counts ${JSON.stringify(cur.counts)}`);
} else if (arg === '--check') {
  if (!fs.existsSync(BASELINE)) {
    console.error('没有基线文件，先跑 node test/webui-contract.mjs --save');
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const errs = compare(base, cur);
  if (errs.length) {
    console.error(`契约校验失败（${errs.length} 条）：`);
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('契约校验通过：页签 / id / CSS 变量 / 面板 / 表格 / 弹窗 / API / 关键函数 / 服务端 均未变动');
  console.log(`  data-tab ${cur.tabs.length} 项 / id ${cur.ids.length} 个 / CSS 变量 ${cur.cssVars.length} 个`);
} else {
  console.log(JSON.stringify({ tabs: cur.tabs, counts: cur.counts, checks: cur.checks }, null, 2));
}
