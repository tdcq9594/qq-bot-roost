/**
 * token 不回显 + 面板按钮契约
 * ============================
 *
 * 守的是一条安全边界：`GET /api/host` 和 `GET /api/onebot` **永远不能**把
 * token 明文带出去。
 *
 * 为什么值得单列一份测试：面板没设 `webui.accessKey` 时 `authorized()` 是
 * 无条件放行的，于是本机任何进程一条 GET 就能读到响应。以前这两个接口对
 * 回环请求会回明文（理由写的是「方便复制到客户端」），等于把一个
 * 「本机管理权限」降维成可复制的 bearer 凭证——它足以冒充框架 /
 * 以机器人身份发言。
 *
 * 这里不启动真实 webServer（它带定时器、端口监听、ports.json 写入，
 * 放进 npm test 会污染真机租约）。改为对两个 GET 分支做**结构契约断言**，
 * 并顺带钉住前端：不回显之后输入框恒为空，所以「显示」必须删掉，
 * 「复制」必须默认隐藏、只在生成出明文时出现、保存/刷新后消失；
 * 而「生成」必须保留明文出口，否则客户端再也配不上 token。
 *
 * 真实 HTTP 行为的验证由临时探针完成（见会话记录），本文件负责防止以后
 * 有人把明文回传 / 常驻死按钮悄悄加回来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/**
 * 剥掉注释再断言。
 *
 * GET 分支的注释里写着历史写法（``local ? c.token : ''`` / ``token:'auto'``），
 * 直接对原文做字符串匹配会被注释干扰：要么误报，要么把「注释里提到」误当成
 * 「代码里还有」。安全断言必须只看真正会执行的代码。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // `[^:]` 保护 `http://` 这类字符串里的双斜杠
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 截出一个分支的函数体：从匹配的 if 到下一个同级 if 之前 */
function branch(src, marker) {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `找不到分支 ${marker}`);
  const next = src.indexOf('\n        if (', start + marker.length);
  const body = src.slice(start, next === -1 ? src.length : next);
  // 防止截错位置导致断言空跑（恒真）：必须确实截到了带响应的那段
  assert.match(body, /json\(res, 200/, `截出的 ${marker} 片段不含响应，截取逻辑可能失效了`);
  return body;
}

/** 截出一个类方法体（到下一个同级方法之前） */
function methodBody(src, name) {
  const start = src.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `找不到方法 ${name}()`);
  const rest = src.slice(start);
  const end = rest.indexOf('\n  }\n');
  return rest.slice(0, end === -1 ? 500 : end);
}

const server = read('src/web/server.js');
const html = read('web/index.html');
const app = read('web/app.js');
const css = read('web/style.css');
const doc = read('docs/OneBot兼容层设计.md');

for (const [name, marker] of [
  ['/api/host', "if (pathname === '/api/host' && req.method === 'GET') {"],
  ['/api/onebot', "if (pathname === '/api/onebot' && req.method === 'GET') {"],
]) {
  test(`${name} GET 只回 tokenSet，不带明文`, () => {
    const code = stripComments(branch(server, marker));
    assert.match(code, /tokenSet:\s*Boolean\(c\.token\)/, `${name} 必须显式给「有没有设置」`);
    /**
     * 白名单口径：整个 GET 响应里**只允许** `tokenSet` 这个键，不允许任何
     * 名为 `token` 的键。以前用黑名单穷举（`token: local ?` / `String(...)` /
     * `?? ''`），最直白的 `token: c.token` 反而能绕过去——安全断言不能靠穷举。
     * `tokenSet` 后面跟的是冒号，正则里的 `\btoken\b` 不会命中它。
     */
    assert.doesNotMatch(code, /(?<![\w.])token\s*:/, `${name} 响应里不能出现 token 键`);
    // `...c` / `...cfg` 展开整个配置对象同样会把 token 带出去
    assert.doesNotMatch(code, /\.\.\.\s*(?:c|cfg)\b/, `${name} 不能展开整个配置对象`);
    assert.doesNotMatch(code, /const\s+local\s*=/, `${name} 不该再判断本机来源`);
  });
}

test('PUT /api/host 的 token:auto 仍一次性回传明文，且只在生成时', () => {
  const put = stripComments(branch(server, "if (pathname === '/api/host' && req.method === 'PUT') {"));
  assert.match(put, /t === 'auto'/, "要保留服务端生成，否则一键配对拿不到 token");
  assert.match(put, /issuedToken = c\.token/, '生成的 token 要存下来供本次响应回传');
  const get = stripComments(branch(server, "if (pathname === '/api/host' && req.method === 'GET') {"));
  assert.doesNotMatch(get, /issuedToken/, 'GET 分支绝不能拿得到一次性明文');
  assert.doesNotMatch(get, /(?<![\w.])token\s*:/, 'GET 分支依旧不能带 token 键');
});

test('snapshot / capability 两个旁路口子都不带 token', () => {
  for (const [name, file] of [
    ['onebot', 'src/onebot/index.js'],
    ['host', 'src/host/index.js'],
  ]) {
    const src = read(file);
    for (const method of ['snapshot', 'capability']) {
      const body = stripComments(methodBody(src, method));
      assert.doesNotMatch(body, /\btoken\b/, `${name}.${method}() 不该含 token`);
    }
  }
});

test('「显示」按钮彻底删除，「复制」按钮默认隐藏', () => {
  // 不回显后输入框恒为空，切换掩码没有意义
  for (const id of ['btnHostRevealToken', 'btnOnebotRevealToken']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} 不该还在 HTML 里`);
    assert.doesNotMatch(app, new RegExp(id), `${id} 不该还有 JS 引用`);
  }
  for (const id of ['btnHostCopyToken', 'btnOnebotCopyToken']) {
    // 首次生成前不能出现一个点不动的死按钮
    assert.match(html, new RegExp(`id="${id}"[^>]*\\shidden`), `${id} 必须默认 hidden`);
    assert.match(app, new RegExp(id), `${id} 要有 JS 引用`);
  }
  // hidden 是 UA 样式，被 .btn 的 display 顶掉就会常驻，必须显式兜住
  assert.match(css, /\.btn\[hidden\]\s*\{\s*display:\s*none/, 'CSS 要显式声明 .btn[hidden]');
  // 不回显后「非本机访问看不到明文」是错的解释
  assert.doesNotMatch(app, /非本机访问看不到明文/);
  assert.doesNotMatch(app, /本机访问时输入框里有明文/);
});

test('复制按钮的显隐由输入框内容驱动：生成出现、保存/刷新消失', () => {
  assert.match(app, /function syncTokenCopy\(/, '要有统一的显隐函数');
  assert.match(app, /btn\.hidden = !input\.value/, '空输入框必须隐藏按钮');
  // 手动改输入框也要实时同步
  assert.match(app, /addEventListener\('input', \(\) => syncTokenCopy/);
  /**
   * 按**渲染函数**定位，而不是数全文出现次数：写死数字会在多一处/少一处时
   * 报警，却说不清是哪条路径漏了。
   */
  for (const [fn, inputId] of [
    ['renderHost', 'hostToken'],
    ['renderOnebot', 'onebotToken'],
  ]) {
    const start = app.indexOf(`function ${fn}(`);
    assert.notEqual(start, -1, `找不到 ${fn}`);
    const next = app.indexOf('\nfunction ', start + 1);
    const body = app.slice(start, next === -1 ? app.length : next);
    assert.match(body, /syncTokenCopy\(/, `${fn} 重新渲染后必须收起复制按钮`);
    assert.ok(body.includes(`'#${inputId}'`), `${fn} 要针对自己的输入框`);
  }
  const binds = app.match(/bindTokenCopy\('#(?:host|onebot)Token'/g) || [];
  assert.equal(binds.length, 2, '两个输入框都要绑定 input 事件与复制点击');
  // 复制按钮本身要真能复制，且剪贴板被拒时有兜底
  assert.match(app, /navigator\.clipboard\.writeText\(val\)/);
  assert.match(app, /Ctrl\+C/);
});

test('「生成」仍是唯一的明文出口，并让复制按钮出现', () => {
  for (const id of ['btnHostGenToken', 'btnOnebotGenToken']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} 必须保留`);
    assert.match(app, new RegExp(`\\$\\('#${id}'\\)\\?\\.addEventListener`), `${id} 要有监听`);
  }
  const gens = app.match(/addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/g) || [];
  const tokenGens = gens.filter((b) => /getRandomValues\(bytes\)/.test(b));
  assert.ok(tokenGens.length >= 2, '两个生成按钮都要能生成随机 token');
  for (const b of tokenGens) {
    assert.match(b, /input\.type = 'text'/, '生成后必须明文可见');
    assert.match(b, /input\.select\(\)/, '剪贴板不可用时还要能手动选中复制');
    assert.match(b, /syncTokenCopy\(/, '生成后要让复制按钮出现');
    assert.match(b, /点「复制」/, '要引导用户点新出现的按钮');
  }
});

test('面板输入不回填旧 token，保存时空值不会被误当成清除', () => {
  assert.doesNotMatch(app, /\.value = cfg\.token/, '输入框不能指望 GET 回填明文');
  assert.match(app, /if \(token\) body\.token = token/, '空值 = 不传，不能变成清空');
});

test('设计文档与实现一致：不再写「回环给明文」', () => {
  assert.doesNotMatch(doc, /回环请求给明文/);
  assert.doesNotMatch(doc, /非本机访问拿不到明文/);
  assert.match(doc, /一律只给 `tokenSet`/);
  assert.match(doc, /「显示」按钮删掉/);
  assert.match(doc, /btn\.hidden = !input\.value/, '文档要写清显隐机制');
});
