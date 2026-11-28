#!/usr/bin/env node
/**
 * 插件页主题注入契约。
 *
 * 守三件事：
 *   1. 服务端只传状态，不复制色值（色值漂移会直接红）；
 *   2. 注入的 CSS 在 @layer 里，插件未分层 CSS 才能覆盖；
 *   3. URL 参数全部经白名单，拼进 <script> 的值不会带出原始输入。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageTheme, pageThemeState, NATIVE_PRESETS, PRESET_IDS } from '../src/web/page-theme.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok ${pass} - ${name}`);
  } catch (e) {
    console.error(`not ok - ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

const vars = read('web/theme-vars.css');
const appJs = read('web/app.js');
const q = (s) => new URLSearchParams(s);

check('theme-vars.css 只有一个 @layer 且包住全部变量', () => {
  assert.equal((vars.match(/@layer roost-theme\s*\{/g) || []).length, 1);
  assert.ok(vars.includes(':root {'));
  assert.ok(vars.includes('[data-theme="dark"] {'));
  for (const p of ['b', 'c', 'd', 'w']) {
    assert.ok(vars.includes(`:root[data-palette="${p}"]:not([data-theme="dark"])`), `缺 ${p} 配色块`);
  }
});

check('theme-vars.css 含玻璃变量块与深色覆盖', () => {
  assert.ok(vars.includes('html[data-bg="image"] {'));
  assert.ok(vars.includes('html[data-bg="image"][data-theme="dark"] {'));
});

check('插件页注入的 CSS 与面板是同一份，不带硬编码色值', () => {
  const out = buildPageTheme(q('theme=light&preset=rose'));
  assert.ok(out.includes('@layer roost-theme'));
  assert.ok(out.includes('--primary: #af5504'), '公共文件里的色值要原样进去');
});

check('服务端预设表与前端 PRESETS 同步', () => {
  // 只取 const PRESETS = [...] 这一段；整文件正则会把 BASES 里的 w 也算进来
  const start = appJs.indexOf('const PRESETS = [');
  const end = appJs.indexOf('\n];', start);
  assert.ok(start > 0 && end > start, '找不到前端 PRESETS 表');
  const table = appJs.slice(start, end);
  const all = [...table.matchAll(/\{\s*id: '([a-z]+)'/g)].map((m) => m[1]);
  const native = [...table.matchAll(/\{\s*id: '([a-z]+)'[^\n]*native:\s*true/g)].map((m) => m[1]);
  assert.ok(all.length >= 10, '前端 PRESETS 表解析失败');
  for (const id of all) assert.ok(PRESET_IDS.has(id), `服务端 PRESET_IDS 缺 ${id}`);
  for (const id of native) assert.ok(NATIVE_PRESETS.has(id), `服务端 NATIVE_PRESETS 缺 ${id}`);
});

check('注入位置在插件自己的内容之前', () => {
  const out = buildPageTheme(q('theme=dark'));
  assert.ok(out.startsWith('<script>'));
  assert.ok(out.includes('</script><style>'));
});

const attrsOf = (out) => out.split('</script>')[0]; // 属性只在 script 里，CSS 全文里有选择器文本会误判

check('明暗两态：深色不写 data-palette / data-appearance，浅色写', () => {
  const dark = attrsOf(buildPageTheme(q('theme=dark&preset=rose&base=c')));
  assert.ok(dark.includes("'data-theme',\"dark\""));
  assert.ok(!dark.includes('data-palette'), '深色不该写 data-palette');
  assert.ok(!dark.includes('data-appearance'), '深色不该写 data-appearance');
  const light = attrsOf(buildPageTheme(q('theme=light&preset=rose&base=c')));
  assert.ok(light.includes("'data-palette',\"c\""));
  assert.ok(light.includes("'data-appearance',\"custom\""));
});

check('colorway 与 appearance 由 preset 推导，不采信前端传值', () => {
  const s = pageThemeState(q('preset=rose&colorway=native&appearance=custom'));
  assert.equal(s.colorway, 'derived');
  assert.equal(s.appearance, true);
  const n = pageThemeState(q('theme=dark&preset=a&colorway=derived'));
  assert.equal(n.colorway, 'native');
});

check('非法参数不进 script：枚举、hex、数值全部收敛', () => {
  const evil = 'x"><script>alert(1)</script>';
  const s = pageThemeState(q(`preset=${encodeURIComponent(evil)}&base=${encodeURIComponent(evil)}&seed=${encodeURIComponent(evil)}&ink=${encodeURIComponent(evil)}&alpha=999&glass=yes`));
  assert.equal(s.preset, 'a');
  assert.equal(s.base, 'a');
  assert.match(s.seed, /^#[0-9a-f]{6}$/i);
  assert.match(s.ink, /^#[0-9a-f]{6}$/i);
  assert.equal(s.alpha, 96);
  assert.equal(s.glass, false);
  const out = buildPageTheme(q(`seed=${encodeURIComponent(evil)}`));
  assert.ok(!out.includes('<script>alert(1)</script>'));
});

check('alpha 缺省走 84，不是 clamp 下限', () => {
  assert.equal(pageThemeState(q('theme=dark')).alpha, 84);
  assert.equal(pageThemeState(q('alpha=')).alpha, 84);
  assert.equal(pageThemeState(q('alpha=bad')).alpha, 84);
  assert.equal(pageThemeState(q('alpha=72')).alpha, 72);
});

check('玻璃开关写 data-bg=image 并下发 surface-alpha', () => {
  const out = attrsOf(buildPageTheme(q('glass=1&alpha=70')));
  assert.ok(out.includes("'data-bg',\"image\""));
  assert.ok(out.includes("'--surface-alpha',\"70%\""));
  assert.ok(!attrsOf(buildPageTheme(q('theme=dark'))).includes('data-bg'));
});

check('面板 head 引入公共变量文件，且顺序在 style.css 之前', () => {
  const html = read('web/index.html');
  const v = html.indexOf('href="/theme-vars.css"');
  const s = html.indexOf('href="/style.css"');
  assert.ok(v > 0, 'index.html 未引入 theme-vars.css');
  assert.ok(s > v, 'theme-vars.css 必须在 style.css 之前');
});

check('插件页 iframe 在玻璃模式下有 backdrop-filter', () => {
  const css = read('web/style.css');
  assert.ok(/html\[data-bg="image"\] \.plugin-page\s*\{[^}]*backdrop-filter/s.test(css));
});

check('外观变化时重载 iframe，且背景图异步加载后补重载', () => {
  const js = read('web/app.js');
  const apply = js.indexOf('function applyAppearance');
  const afterApply = js.slice(apply, apply + 1800);
  assert.ok(afterApply.includes('reloadPluginFrames()'), 'applyAppearance 未重载插件页');
  assert.ok(js.includes('loadBackground()') || js.includes('function loadBackground'));
  const load = js.slice(js.indexOf('function loadBackground'), js.indexOf('function loadBackground') + 1400);
  assert.ok((load.match(/reloadPluginFrames\(\)/g) || []).length >= 2, '图片读回与图丢失两条分支都要重载');
});

console.log(`\n${pass} 项通过`);
