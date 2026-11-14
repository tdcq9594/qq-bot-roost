/**
 * 把「扩展反向联动」的几处改动以**最小补丁**贴进旧版运行副本。
 *
 * 为什么不整文件覆盖：运行副本可能是 1.0.14，开发实例 1.0.16-beta.1，
 * methods.js 差 200 行。覆盖会把中间版本的行为一起灌进去，副本不是 git
 * 仓库、不能回滚。这里只按精确锚点插入本次新增的代码，插完逐处校验，
 * 任何一处锚点不唯一 / 已存在就整体不动（不写盘）。
 *
 *   node scripts/apply-ext-bridge-patch.mjs <目标框架目录>
 *   node scripts/apply-ext-bridge-patch.mjs <目标框架目录> --check   # 只预检
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] || '');
const checkOnly = process.argv.includes('--check');
if (!process.argv[2]) {
  console.error('用法：node scripts/apply-ext-bridge-patch.mjs <目标框架目录> [--check]');
  process.exit(2);
}
if (!fs.existsSync(path.join(target, 'src/host/methods.js'))) {
  console.error(`目标不像框架目录：${target}`);
  process.exit(2);
}

/** @type {{file:string, anchor:string, insert:string, mode:'before'|'after'|'replace', guard?:string}[]} */
const patches = [
  {
    file: 'src/host/methods.js',
    guard: 'extBridge = null',
    anchor: 'export function createMethods({ runtime: R, getState, log = () => {} }) {',
    mode: 'replace',
    insert: 'export function createMethods({ runtime: R, getState, log = () => {}, extBridge = null }) {',
  },
  {
    file: 'src/host/methods.js',
    guard: "def('ext.list'",
    anchor: '  registerOps(def, { R, err, log });\n',
    mode: 'after',
    insert: `
  /* DSH 扩展反向互通：框架插件 → 扩展（SSE 请求 + RPC 回执） */
  if (extBridge) {
    def('ext.list', 'read', '列出 DSH 已装扩展暴露的动作', async () => extBridge.list());
    def('ext.call', 'message', '调用 DSH 扩展的一个动作（经 SSE 请求 + RPC 回执）', async (p) => {
      const out = await extBridge.call({
        extId: str(p.extId), action: str(p.action), payload: p.payload ?? null, chat: str(p.chat ?? ''),
      });
      return { ok: true, result: out ?? null };
    });
    def('ext.call.reply', 'message', 'DSH 回传扩展调用结果（内部）', async (p) =>
      extBridge.reply({ requestId: str(p.requestId), ok: p.ok !== false, result: p.result ?? null, error: str(p.error ?? '') }));
    def('ext.register', 'message', 'DSH 上报已装扩展能力清单（内部）', async (p) =>
      extBridge.register({ extensions: p.extensions ?? [] }));
  }
`,
  },
  {
    file: 'src/host/index.js',
    guard: "from './ext-bridge.js'",
    anchor: "import { createMethods, effectiveScopes, HostError, HOST_PROTOCOL } from './methods.js';\n",
    mode: 'after',
    insert: "import { createExtBridge } from './ext-bridge.js';\n",
  },
  {
    file: 'src/host/index.js',
    guard: 'this.extBridge = createExtBridge',
    anchor: '    this.methods = createMethods({\n      runtime: this.runtime,\n      getState: () => this.#state(),\n      log: (m) => log.info(m),\n    });',
    mode: 'replace',
    insert: `    /** 反向调用桥：框架插件调 DSH 扩展，事件走协议自己的 SSE 流、回执走 RPC */
    this.extBridge = createExtBridge({
      pushEvent: (event, data) => this.#push(event, data),
      log: (m) => log.info(\`[ext-bridge] \${m}\`),
    });
    this.methods = createMethods({
      runtime: this.runtime,
      getState: () => this.#state(),
      log: (m) => log.info(m),
      extBridge: this.extBridge,
    });`,
  },
  {
    file: 'src/host/index.js',
    guard: "this.extBridge?.clear?.('外接协议已停止')",
    anchor: "    if (this.state === 'running') this.state = 'stopped';",
    mode: 'before',
    insert: "    /** 监听关了就没人能回执了，把还在等的扩展调用全部解掉，别挂死插件 */\n    this.extBridge?.clear?.('外接协议已停止');\n",
  },
  {
    file: 'src/bot.js',
    guard: 'host: this.host,',
    anchor: '      isOwner: (uid) => cfg.owners.includes(uid),\n',
    mode: 'after',
    insert: '      /** 外接协议桥：给插件 ctx.ext.*，让它能调 DSH 侧已装扩展的能力 */\n      host: this.host,\n',
  },
  {
    file: 'src/plugin/loader.js',
    guard: 'ignoreCompat, host = null',
    anchor: 'ignoreCompat }) {',
    mode: 'replace',
    insert: 'ignoreCompat, host = null }) {',
  },
  {
    file: 'src/plugin/loader.js',
    guard: 'this.hostBridge = host;',
    anchor: '    this.isOwner = isOwner;\n',
    mode: 'after',
    insert: '    /** 外接协议桥（可选）：透传给 ctx.ext */\n    this.hostBridge = host;\n',
  },
  {
    file: 'src/plugin/loader.js',
    guard: 'extBridge: this.hostBridge?.extBridge ?? null,',
    anchor: '      routes: this.routes,\n    });',
    mode: 'replace',
    insert: '      routes: this.routes,\n      extBridge: this.hostBridge?.extBridge ?? null,\n    });',
  },
  {
    file: 'src/plugin/context.js',
    guard: 'extBridge = null',
    anchor: 'routes = null, state = null }) {',
    mode: 'replace',
    insert: 'routes = null, state = null, extBridge = null }) {',
  },
  {
    file: 'src/plugin/context.js',
    guard: 'ext: {\n      get available()',
    anchor: '    callTool(name, args, opts) {\n      return callTool(name, args, opts);\n    },\n',
    mode: 'after',
    insert: `
    /** 调 DSH 侧已装扩展的能力（直连协议反向联动） */
    ext: {
      get available() { return Boolean(extBridge); },
      async list() {
        if (!extBridge) return { extensions: [], updatedAt: 0, pending: 0 };
        return extBridge.list();
      },
      async call(extId, action, payload = null, opts = {}) {
        if (!extBridge) throw new Error('没接 DSH 外接协议，调不了扩展能力');
        return await extBridge.call({ extId, action, payload, chat: opts.chat ?? '' });
      },
    },
`,
  },
];

/**
 * 运行副本里有的文件是 CRLF、有的是 LF（历史遗留）。按**每个文件自己的**
 * 换行符把锚点与插入文本对齐，写回时保持原风格，别把整份文件改成 LF——
 * 那会让 diff 变成整文件，下次就没法用小补丁了。
 */
function eolOf(s) { return s.includes('\r\n') ? '\r\n' : '\n'; }
const fit = (s, eol) => eol === '\n' ? s : s.replace(/\n/g, '\r\n');

/**
 * **按文件累积**：同一个文件有好几处补丁（比如 methods.js 有签名和 def 两处），
 * 每条都必须基于上一条的结果继续改。早先一版每条都从磁盘重读原文件、各自
 * 存一份 `src`，最后顺序写盘 —— 后写的把前写的整份覆盖，结果只有最后一条
 * 生效，签名没换却引用了 extBridge，模块一加载就 `extBridge is not defined`。
 */
const perFile = new Map();
for (const p of patches) {
  const file = path.join(target, p.file);
  if (!perFile.has(file)) perFile.set(file, { src: fs.readFileSync(file, 'utf8'), labels: [] });
  const rec = perFile.get(file);
  if (p.guard && rec.src.includes(p.guard)) {
    console.log(`跳过（已打过）：${p.file} · ${p.guard.slice(0, 40)}`);
    continue;
  }
  const eol = eolOf(rec.src);
  const anchor = fit(p.anchor, eol);
  const insert = fit(p.insert, eol);
  const count = rec.src.split(anchor).length - 1;
  if (count !== 1) {
    console.error(`✗ 锚点不唯一（${count} 处）：${p.file} · ${JSON.stringify(p.anchor.slice(0, 60))}`);
    process.exit(1);
  }
  const next = p.mode === 'after' ? anchor + insert
    : p.mode === 'before' ? insert + anchor
      : insert;
  rec.src = rec.src.replace(anchor, next);
  rec.labels.push(`${p.file} · ${p.guard ?? p.mode}${eol === '\r\n' ? ' (CRLF)' : ''}`);
}

/** 先把所有改动算出来并校验，任何一处不合格就整体不写 */
const results = [...perFile.entries()]
  .filter(([, rec]) => rec.labels.length)
  .flatMap(([file, rec]) => rec.labels.map((label) => ({ file, src: rec.src, label })))
  /** 同一文件只写一次，去重 */
  .filter((r, i, arr) => arr.findIndex((x) => x.file === r.file) === i);

/** 新增文件：直接复制，已存在且内容相同就跳过 */
const newFiles = ['src/host/ext-bridge.js'];
for (const rel of newFiles) {
  const from = path.join(SELF, rel);
  const to = path.join(target, rel);
  const content = fs.readFileSync(from, 'utf8');
  if (fs.existsSync(to) && fs.readFileSync(to, 'utf8') === content) {
    console.log(`跳过（已存在且一致）：${rel}`);
    continue;
  }
  results.push({ file: to, src: content, label: `新增 ${rel}`, isNew: true });
}

console.log(checkOnly ? '=== 预检通过（未写盘） ===' : '=== 写入 ===');
for (const r of results) {
  console.log(`  ${r.label}`);
  if (!checkOnly) fs.writeFileSync(r.file, r.src);
}
console.log(`共 ${results.length} 处${checkOnly ? '待应用' : '已应用'}`);
