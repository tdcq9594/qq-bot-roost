/**
 * 通用图文自动出口（replyAuto，框架能力，任何插件可用）单测。
 *
 * 覆盖交接 §7 的纯函数层 / 上传层 / 降级层，并专门回归「原有功能不受影响」：
 * 老的 replyMarkdown 纯文字降级、分片上传、官方接口覆盖度都必须照旧。
 *
 * 2026-11-07 B 方案（砍掉兼容层）后改过一轮：
 *   · 图片语法只剩标准 `![](路径)`，旧 `![]()` 不再解析；
 *   · 框架不做路径白名单，也不再有 allowedRoots / imageRoots；
 *   · `replyAuto` 支持 keyboard；3 个素材端点标 internal，不对外开放；
 *   · 新增「崩溃孤儿素材」归属文件与认领清理。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseReplyNodes,
  hasMarkdownSyntax,
  hasLocalImageNode,
  decideReplyMode,
  renderReplyMarkdown,
  renderFallback,
  hintForReason,
  classifyUploadFailure,
  DEFAULT_FALLBACK_HINTS,
} from '../src/reply-auto.js';
import {
  QQApi,
  MEDIA_IMAGE_MAX,
  IMAGE_CONTENT_TYPES,
  inspectImageFormat,
  etagToMd5,
} from '../src/api.js';
import {
  OFFICIAL_ENDPOINTS,
  CALLABLE_METHODS,
  capabilityList,
  checkCoverage,
} from '../src/endpoints.js';
import { DIRS } from '../src/paths.js';
import { buildMessage } from '../src/message.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-reply-auto-'));
const png = path.join(tmp, '笑 脸.png');
const bad = path.join(tmp, 'bad.png');
const big = path.join(tmp, 'big.png');
await fs.writeFile(png, PNG_HEAD);
await fs.writeFile(bad, Buffer.from('this is not an image'));
await fs.writeFile(big, PNG_HEAD);
await fs.truncate(big, MEDIA_IMAGE_MAX + 1024);

/**
 * `completeMediaImage` / `deleteMediaImage` 会把归属集合写进
 * `data/media-images-own.json`。测试不能碰开发者的真实数据，先备份再还原；
 * 同时把内容清成 []，避免上一次运行留下的 id 干扰「孤儿素材」那条用例。
 */
const OWN_FILE = path.join(DIRS.data, 'media-images-own.json');
let ownBackup = null;
try { ownBackup = await fs.readFile(OWN_FILE, 'utf8'); } catch { /* 本来就没有 */ }
await fs.mkdir(path.dirname(OWN_FILE), { recursive: true });
await fs.writeFile(OWN_FILE, '[]', 'utf8');

after(async () => {
  if (ownBackup === null) await fs.rm(OWN_FILE, { force: true });
  else await fs.writeFile(OWN_FILE, ownBackup, 'utf8');
  await fs.rm(tmp, { recursive: true, force: true });
});

const decide = (s) => decideReplyMode(parseReplyNodes(s));
const json = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

/* ---------- 1. 节点解析 ---------- */

test('解析: 保留图片在正文里的位置、alt 尺寸与带空格中文路径', () => {
  const nodes = parseReplyNodes(`前面\n![笑 #200px #200px](C:/stickers/笑 脸.png)\n后面`);
  assert.deepEqual(nodes.map((n) => n.type), ['text', 'image', 'text']);
  assert.equal(nodes[1].alt, '笑 #200px #200px');
  assert.equal(nodes[1].src, 'C:/stickers/笑 脸.png');
  assert.equal(nodes[1].kind, 'local');
  assert.ok(nodes[0].value.includes('前面'));
  assert.ok(nodes[2].value.includes('后面'));
});

test('解析: qqbot-media:// 与公网 URL 都算 remote', () => {
  assert.equal(parseReplyNodes('![](qqbot-media://image/v1/tok)')[0].kind, 'remote');
  assert.equal(parseReplyNodes('![](https://x/a.png)')[0].kind, 'remote');
});

test('解析: 多图按出现顺序排成节点流', () => {
  const nodes = parseReplyNodes('A ![1](C:/1.png) B ![2](C:/2.png) C');
  assert.deepEqual(nodes.map((n) => n.type), ['text', 'image', 'text', 'image', 'text']);
  assert.equal(nodes[1].src, 'C:/1.png');
  assert.equal(nodes[3].src, 'C:/2.png');
});

test('分层: 框架不认模型标记，只认 markdown（转换由 ai-chat 负责）', () => {
  /**
   * 模型协议（`<<image: 路径>>` / `<<image-alone: 路径>>`）属于 AI 插件，
   * 不进通用能力：ai-chat 把 `<<image:>>` 转成 `![](路径)` 再调本出口，
   * `<<image-alone:>>` 自己走 `msg.replyImage()`。
   * 这条断言钉住分层——谁在框架里加标记解析，它会立刻红。
   */
  const nodes = parseReplyNodes('前\n<<image: C:/a.png>>\n后');
  assert.deepEqual(nodes.map((n) => n.type), ['text']);
  assert.equal(decide('前\n<<image: C:/a.png>>\n后').mode, 'plain');
});

test('hasLocalImageNode: 只有本地图才禁纯文本降级，公网图照旧可降级', () => {
  assert.equal(hasLocalImageNode('![a](C:/a.png)'), true);
  assert.equal(hasLocalImageNode('![a](https://x/a.png)'), false);
  assert.equal(hasLocalImageNode('普通文字'), false);
  assert.equal(hasLocalImageNode('半截的 ![图'), false);
});

test('mdToPlain 的坑: 图片语法会被展开成本地路径明文', async () => {
  const { mdToPlain } = await import('../src/markdown.js');
  assert.match(mdToPlain('![](C:/stickers/笑.png)'), /C:\/stickers\/笑\.png/);
});

/* ---------- 2. 判定表 ---------- */

test('判定表: 八类序列全覆盖（唯一触发预上传的是图在中间）', () => {
  const cases = [
    ['纯文字', '你好呀', 'plain', false],
    ['markdown 无图', '## 标题\n- 列表', 'markdown', false],
    ['公网图', '看\n![](https://x/a.png)', 'markdown', false],
    ['单个本地图无文字', '![](C:/a.png)', 'media', false],
    ['图在前', '![](C:/a.png)\n后面文字', 'media-text', false],
    ['图在末尾', '前面文字\n![](C:/a.png)', 'media-text', false],
    ['文字-图-文字', '前\n![](C:/a.png)\n后', 'markdown', true],
    ['markdown 结构 + 末尾本地图', '## 标题\n![](C:/a.png)', 'markdown', true],
  ];
  for (const [name, input, mode, upload] of cases) {
    const d = decide(input);
    assert.equal(d.mode, mode, `${name}: mode`);
    assert.equal(d.upload, upload, `${name}: upload`);
  }
  assert.equal(hasMarkdownSyntax('## 标题'), true);
  assert.equal(hasMarkdownSyntax('**加粗**'), true);
  assert.equal(hasMarkdownSyntax('普通一句话'), false);
});

/* ---------- 3. 渲染与降级 ---------- */

test('渲染: 只换括号里的引用，alt 尺寸原样保留', () => {
  const nodes = parseReplyNodes('前\n![笑 #200px #200px](C:/a.png)\n后');
  const md = renderReplyMarkdown(nodes, new Map([['C:/a.png', 'qqbot-media://image/v1/tok']]));
  assert.match(md, /!\[笑 #200px #200px\]\(qqbot-media:\/\/image\/v1\/tok\)/);
  assert.ok(!md.includes('C:/a.png'));
});


test('降级: 提示原位、不泄漏本地路径、纯文本走 msg_type=0', () => {
  const nodes = parseReplyNodes('前面\n![](C:/secret/a.png)\n后面');
  const fb = renderFallback(nodes, () => '（提示）');
  assert.equal(fb.msgType, 0);
  assert.ok(!fb.content.includes('C:/secret'));
  assert.ok(fb.content.indexOf('前面') < fb.content.indexOf('（提示）'));
  assert.ok(fb.content.indexOf('（提示）') < fb.content.indexOf('后面'));
});

test('降级: 正文含公网图时仍走 msg_type=2，公网图不丢', () => {
  const nodes = parseReplyNodes('前\n![](https://x/a.png)\n![](C:/a.png)\n后');
  const fb = renderFallback(nodes, () => '（提示）');
  assert.equal(fb.msgType, 2);
  assert.ok(fb.content.includes('https://x/a.png'));
  assert.ok(!fb.content.includes('C:/a.png'));
});

test('降级: 提示文案是预告式，不宣称「已单独发成功」', () => {
  for (const reason of Object.keys(DEFAULT_FALLBACK_HINTS)) {
    assert.ok(!hintForReason(reason).includes('已单独发在下面'));
  }
  assert.equal(classifyUploadFailure({ qqCode: 40035002 }), 'oversize');
  assert.equal(classifyUploadFailure({ qqCode: 40035007 }), 'quota');
  assert.equal(classifyUploadFailure({ reason: 'bad_format' }), 'bad_format');
  /**
   * 裸 PUT 的 403 是「Content-Type 与 prepare 不一致」造成的（见 `api.js`），
   * 图片本身没坏。必须落到 `internal` 才会保留补发——归成 `bad_format`
   * 会被剔出补发队列，用户白丢一张本来能发的图，文案还会谎称「格式不支持」。
   */
  assert.equal(classifyUploadFailure({ message: '分片 PUT 失败 HTTP 403' }), 'internal');
  assert.equal(classifyUploadFailure({ message: '请求超时（15s）' }), 'network');
});

/* ---------- 4. 上传层纯函数与本地预检 ---------- */

test('预检: 文件头 + 扩展名，坏格式/超大图不发任何网络请求', async () => {
  assert.deepEqual(inspectImageFormat(PNG_HEAD, 'a.png'), { ok: true, contentType: 'image/png' });
  assert.equal(inspectImageFormat(PNG_HEAD, 'a.txt').reason, 'bad_format');
  assert.equal(inspectImageFormat(Buffer.from('nope'), 'a.png').reason, 'bad_format');
  assert.equal(IMAGE_CONTENT_TYPES['.jpeg'], 'image/jpeg');
  assert.equal(etagToMd5('"e10adc3949ba59abbe56e057f20f883e"'), 'e10adc3949ba59abbe56e057f20f883e');
  assert.equal(etagToMd5('W/"ABC"', 'fallback'), 'fallback');

  const api = new QQApi({ tokenManager: { get: async () => 'tok', appId: 'app' }, baseUrl: 'http://127.0.0.1:1' });
  let fetched = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; throw new Error('不该发请求'); };
  try {
    await assert.rejects(api.uploadMarkdownImage(big), (e) => e.reason === 'oversize');
    await assert.rejects(api.uploadMarkdownImage(bad), (e) => e.reason === 'bad_format');
    assert.equal(fetched, 0, '预检必须在 prepare 之前挡掉');
  } finally {
    globalThis.fetch = orig;
  }
});

test('上传链路: prepare 报文 / PUT Content-Type / ETag→md5 / complete / 只删自己', async () => {
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    seen.push({ u, init });
    if (u.endsWith('/v2/media-images/prepare')) return json({ upload_id: 'up1', presigned_url: 'https://cos.example/put', expires_in: 3600 });
    if (u.endsWith('/v2/media-images/complete')) return json({ image_id: 'img1', url: 'qqbot-media://image/v1/tok', ttl: 7776000 });
    if (u === 'https://cos.example/put') return new Response(null, { status: 200, headers: { etag: '"d41d8cd98f00b204e9800998ecf8427e"' } });
    if (u.endsWith('/delete')) return json({});
    return json({});
  };
  try {
    const api = new QQApi({ tokenManager: { get: async () => 'tok', appId: 'app' }, baseUrl: 'https://api.bot.qq.com' });
    await assert.rejects(async () => api.deleteMediaImage('foreign-images'), /拒绝删除非本进程上传/);

    const up = await api.uploadMarkdownImage(png);
    assert.equal(up.imageId, 'img1');
    assert.equal(up.url, 'qqbot-media://image/v1/tok');

    const prep = seen.find((x) => x.u.endsWith('/prepare'));
    assert.equal(JSON.parse(prep.init.body).content_type, 'image/png');
    assert.equal(JSON.parse(prep.init.body).file_name, '笑 脸.png');
    assert.equal(JSON.parse(prep.init.body).file_size, PNG_HEAD.length);
    assert.match(JSON.parse(prep.init.body).md5, /^[0-9a-f]{32}$/);
    assert.match(JSON.parse(prep.init.body).sha1, /^[0-9a-f]{40}$/);

    const put = seen.find((x) => x.u === 'https://cos.example/put');
    assert.equal(put.init.method, 'PUT');
    assert.equal(put.init.headers['Content-Type'], 'image/png');
    assert.equal(put.init.headers.Authorization, undefined, '预签名 PUT 不能带 QQ 鉴权头');
    assert.equal(JSON.parse(seen.find((x) => x.u.endsWith('/complete')).init.body).md5, 'd41d8cd98f00b204e9800998ecf8427e');

    await api.deleteMediaImage('img1');
    assert.ok(seen.some((x) => x.u.endsWith('/v2/media-images/img1/delete')));
    assert.equal(api._ownMediaImages.has('img1'), false);
    assert.equal(JSON.parse(await fs.readFile(OWN_FILE, 'utf8')).includes('img1'), false,
      '删掉后归属文件也要同步更新，下次启动不会误认领');
  } finally {
    globalThis.fetch = orig;
  }
});

test('孤儿素材: 上次进程崩溃留下的 image_id，下次上传前认领并删除', async () => {
  await fs.writeFile(OWN_FILE, JSON.stringify(['orphan-1', 'orphan-2']), 'utf8');
  const deletes = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === 'DELETE' && u.includes('/v2/media-images/')) {
      deletes.push(u);
      return json({});
    }
    if (u.endsWith('/v2/media-images/prepare')) return json({ upload_id: 'up2', presigned_url: 'https://cos.example/put' });
    if (u.endsWith('/v2/media-images/complete')) return json({ image_id: 'img2', url: 'qqbot-media://image/v1/tok2' });
    if (u === 'https://cos.example/put') return new Response(null, { status: 200, headers: { etag: '"d41d8cd98f00b204e9800998ecf8427e"' } });
    return json({});
  };
  try {
    const api = new QQApi({ tokenManager: { get: async () => 'tok', appId: 'app' }, baseUrl: 'https://api.bot.qq.com' });
    await api.uploadMarkdownImage(png);
    assert.ok(deletes.some((u) => u.includes('orphan-1')), 'orphan-1 要被认领');
    assert.ok(deletes.some((u) => u.includes('orphan-2')), 'orphan-2 要被认领');
    assert.equal(JSON.parse(await fs.readFile(OWN_FILE, 'utf8')).includes('orphan-1'), false,
      '认领成功后归属文件里不再留旧 id');
    await fs.writeFile(OWN_FILE, '[]', 'utf8');
  } finally {
    globalThis.fetch = orig;
  }
});

/* ---------- 5. 端点登记（会触发 selftest 的覆盖度断言） ---------- */

test('端点: 3 个素材接口仍登记且都有同名方法，但标 internal 不对外开放', () => {
  const cov = checkCoverage(QQApi);
  assert.equal(cov.missing.length, 0, JSON.stringify(cov.missing));
  for (const p of ['/v2/media-images/prepare', '/v2/media-images/complete', '/v2/media-images/{image_id}/delete']) {
    const ep = OFFICIAL_ENDPOINTS.find((e) => e.path === p);
    assert.ok(ep, p);
    assert.equal(ep.internal, true, `${p} 必须标 internal`);
  }
  for (const m of ['prepareMediaImage', 'completeMediaImage', 'deleteMediaImage']) {
    assert.equal(typeof QQApi.prototype[m], 'function');
    assert.equal(CALLABLE_METHODS.has(m), false, `${m} 不该出现在 /api/qq/call 白名单`);
    assert.equal(capabilityList().some((c) => c.api === m), false, `${m} 不该出现在能力清单`);
  }
  // 原有能力不受影响
  assert.ok(OFFICIAL_ENDPOINTS.some((e) => e.path === '/v2/groups/{group_openid}/files'));
  assert.ok(OFFICIAL_ENDPOINTS.some((e) => e.path === '/v2/groups/{group_id}/upload_part_finish'));
  assert.equal(CALLABLE_METHODS.has('uploadMedia'), true);
});

/* ---------- 6. 无路径白名单 ---------- */

test('配置: 框架不再有 imageRoots / allowedRoots 链路', async () => {
  const cfg = await fs.readFile(new URL('../src/config.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../src/web/server.js', import.meta.url), 'utf8');
  const example = await fs.readFile(new URL('../config/bots.example.json', import.meta.url), 'utf8');
  const auto = await fs.readFile(new URL('../src/reply-auto.js', import.meta.url), 'utf8');
  assert.ok(!/imageRoots|normalizeImageRoots|resolveImagePath/.test(cfg + server + example + auto));
  assert.match(cfg, /media:\s*\{\s*placeholderSpace:/s);
});

/* ---------- 7. message 层：老行为回归 + 新入口 ---------- */

function harness(extra = {}, cfgExtra = {}) {
  const calls = [];
  const uploaded = [];
  const deleted = [];
  const api = {
    sendGroup: async (target, body) => { calls.push({ target, body }); return { id: 'ok' }; },
    sendC2C: async (target, body) => { calls.push({ target, body }); return { id: 'ok' }; },
    uploadMarkdownImage: async (p) => {
      uploaded.push(p);
      return { imageId: `img${uploaded.length}`, url: 'qqbot-media://image/v1/tok', ttl: 1, fileName: 'x.png' };
    },
    deleteMediaImage: async (id) => { deleted.push(id); return {}; },
    uploadLocalFile: async () => ({ file_info: 'fi' }),
    uploadLocalFileSharded: async () => ({ file_info: 'fi' }),
    uploadMedia: async () => ({ file_info: 'fi' }),
    ...extra,
  };
  // 幂等键是传给 outbound 的，不在 body 里；要断言它就得有调度器
  const sent = [];
  const outbound = {
    send: async (o) => {
      sent.push(o);
      return (o.kind === 'group' ? api.sendGroup : api.sendC2C)(o.target, o.payload);
    },
  };
  const msg = buildMessage(
    'GROUP_AT_MESSAGE_CREATE',
    { id: 'msg-1', content: 'hi', group_openid: 'GROUP1', author: { member_openid: 'USER1', username: 'tester' } },
    { api, cfg: { commandPrefix: '/', ...cfgExtra }, outbound, session: null, traceId: 'trace-1', identity: null },
  );
  return { msg, calls, sent, uploaded, deleted, api };
}

const KB = { content: { rows: [{ buttons: [{ id: '1', render_data: { label: '再来', style: 1 }, action: { type: 2, data: '再来' } }] }] } };

test('老行为: 纯文字 markdown 被 4xx 拒绝时仍降级纯文本重发', async () => {
  const h = harness();
  h.api.sendGroup = async (target, body) => {
    h.calls.push({ target, body });
    if (h.calls.length === 1) throw Object.assign(new Error('400 rejected'), { status: 400 });
    return { id: 'ok' };
  };
  const r = await h.msg.replyMarkdown({ content: '## 标题' });
  assert.equal(h.calls.length, 2, '老降级必须还在');
  assert.equal(h.calls[1].body.content, '标题');
  assert.ok(r);
});

test('修正: 含本地图的 markdown 被拒时不做纯文本降级（不泄漏本地路径）', async () => {
  const h = harness();
  h.api.sendGroup = async (target, body) => {
    h.calls.push({ target, body });
    throw Object.assign(new Error('400 rejected'), { status: 400 });
  };
  const r = await h.msg.replyMarkdown({ content: '![](C:/secret/a.png)' });
  assert.equal(r, null);
  assert.equal(h.calls.length, 1, '不能重发一条纯文本');
});

test('replyAuto: 纯文字 / 无本地图 markdown 直接按原类型发', async () => {
  const h1 = harness();
  await h1.msg.replyAuto('你好呀', { requestId: 'r1' });
  assert.equal(h1.calls[0].body.content, '你好呀');
  assert.equal(h1.calls[0].body.requestId, undefined, 'requestId 不该混进 body');

  const h2 = harness();
  await h2.msg.replyAuto('看 ![](https://x/a.png)');
  assert.equal(h2.calls[0].body.markdown.content, '看 ![](https://x/a.png)');
  assert.equal(h2.uploaded.length, 0, '公网图不预上传');
});

test('replyAuto: 图在前 / 图在末尾走原路，一次预上传都不做', async () => {
  const h = harness();
  await h.msg.replyAuto(`后面文字\n![](${png})`);
  assert.equal(h.uploaded.length, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.msgType, 7);
  assert.match(h.calls[0].body.content, /后面文字/);
});

test('replyAuto: 文字-图-文字触发预上传，发完即删，只删本次 image_id', async () => {
  const h = harness();
  await h.msg.replyAuto(`前面\n![](${png})\n后面`, { requestId: 'r-md' });
  assert.equal(h.uploaded.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.uploaded[0], path.resolve(png), '预上传拿到的是绝对路径');
  assert.equal(h.calls[0].body.markdown.content, '前面\n![](qqbot-media://image/v1/tok)\n后面');
  assert.ok(!h.calls[0].body.markdown.content.includes(tmp), '不能漏本地路径');
  assert.deepEqual(h.deleted, ['img1']);
});

test('replyAuto: 预上传失败降级为 2 条（文本原位提示 + 独立图），幂等键各自独立', async () => {
  const h = harness({
    uploadMarkdownImage: async () => {
      const e = new Error('素材图床不可用');
      e.qqCode = 40035007;
      throw e;
    },
  });
  const reports = [];
  await h.msg.replyAuto(`前面\n![](${png})\n后面`, {
    requestId: 'r-fb', onResult: (x) => reports.push(x),
  });
  assert.equal(h.calls.length, 2, '降级恰好 2 条');
  assert.match(h.calls[0].body.content, /配额不足/);
  assert.ok(!h.calls[0].body.content.includes(tmp), '文本里不能有本地路径');
  assert.equal(h.calls[1].body.msgType, 7);
  assert.ok(h.sent[0].requestId, '降级文本要有独立幂等键');
  assert.ok(h.sent[1].requestId, '降级独立图要有独立幂等键');
  assert.notEqual(h.sent[0].requestId, h.sent[1].requestId);
  assert.notEqual(h.sent[0].requestId, 'r-fb', '不能沿用原 markdown 的 requestId');
  assert.ok(reports.some((x) => x.mode === 'fallback' && x.reason === 'quota'));
});

test('replyAuto: 文件读不到（outside）只提示，不再拿同一路径重试发图', async () => {
  const h = harness({
    uploadMarkdownImage: async () => {
      const e = new Error('ENOENT: 文件不存在');
      e.reason = 'outside';
      throw e;
    },
  });
  await h.msg.replyAuto(`前面\n![](${png})\n后面`);
  assert.equal(h.calls.length, 1, '只该有那条含提示的文本，不该再试发一次');
  assert.match(h.calls[0].body.content, /读不到/);
  assert.ok(!h.calls[0].body.content.includes(tmp), '提示里不能带本地路径');
  assert.deepEqual(h.deleted, [], '没有上传成功过，也就没有素材要删');
});

test('replyAuto: 格式不支持（bad_format）也只提示，不拿假图去撞 QQ 的 400', async () => {
  /**
   * 2026-11-07 真机实测：假图（文件头不对）降级后又被丢给 `replyImage`，
   * QQ 回 `400 富媒体文件格式不支持`，白跑一次请求。和 `outside` 一样，
   * 这是「图本身用不了」，换条消息也不会成。
   */
  const h = harness({
    uploadMarkdownImage: async () => {
      const e = new Error('文件头不是受支持的图片格式');
      e.reason = 'bad_format';
      throw e;
    },
  });
  await h.msg.replyAuto(`前面\n![](${png})\n后面`);
  assert.equal(h.calls.length, 1, '只该有那条含提示的文本');
  assert.match(h.calls[0].body.content, /格式不支持/, '文案要说「已跳过」而不是「下面单独发」');
  assert.ok(!/下面会单独发/.test(h.calls[0].body.content), '不发就不能说会发');
});

test('replyAuto: 大图/配额仍照常单独补发（换条通道还有机会成）', async () => {
  const h = harness({
    uploadMarkdownImage: async () => {
      const e = new Error('超过 10MB');
      e.reason = 'oversize';
      throw e;
    },
  });
  await h.msg.replyAuto(`前面\n![](${png})\n后面`);
  assert.equal(h.calls.length, 2, '文本 + 独立图两条');
  assert.equal(h.calls[1].body.msgType, 7);
});

test('replyAuto: 裸 PUT 403（Content-Type 不符）仍补发，不谎称格式不支持', async () => {
  const h = harness({
    uploadMarkdownImage: async () => {
      throw new Error('分片 PUT 失败 HTTP 403：SignatureDoesNotMatch');
    },
  });
  await h.msg.replyAuto(`前面\n![](${png})\n后面`);
  assert.equal(h.calls.length, 2, '图本身是好的，要换 /files 通道补发');
  assert.equal(h.calls[1].body.msgType, 7);
  assert.match(h.calls[0].body.content, /下面会单独发/, '要说会发，因为真的会发');
  assert.ok(!/格式不支持/.test(h.calls[0].body.content), '403 不是格式问题');
});

test('B 方案: 框架不校验路径所属目录，插件给什么路径就交给上传层', async () => {
  const outside = path.join(os.tmpdir(), '另一处', '图.png');
  const h = harness();
  await h.msg.replyAuto(`前面\n![](${outside})\n后面`);
  assert.deepEqual(h.uploaded, [path.resolve(outside)]);
  assert.equal(h.calls.length, 1);
  assert.ok(!h.calls[0].body.markdown.content.includes(outside), '路径只能换成引用，不能原文漏出');
});

test('replyAuto: 发送阶段之后失败不降级（可能已送达，不重复发）', async () => {
  const h = harness();
  h.api.sendGroup = async (target, body) => {
    h.calls.push({ target, body });
    throw new Error('5xx / timeout');
  };
  const reports = [];
  const r = await h.msg.replyAuto(`前\n![](${png})\n后`, { onResult: (x) => reports.push(x) });
  assert.equal(r, null);
  assert.equal(h.calls.length, 1, '绝不能补发文本 + 独立图');
  assert.deepEqual(h.deleted, ['img1'], '异常也要清理素材');
  assert.ok(reports.some((x) => x.phase === 'send'));
});

/* ---------- 8. keyboard ---------- */

test('keyboard: 纯文字带按钮升成 markdown，不多发一条、不预上传', async () => {
  const h = harness();
  await h.msg.replyAuto('要不要再来一次？', { keyboard: KB });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.markdown.content, '要不要再来一次？');
  assert.deepEqual(h.calls[0].body.keyboard, KB);
  assert.equal(h.uploaded.length, 0);
});

test('keyboard: markdown 出口（含本地图）照常透传按钮', async () => {
  const h = harness();
  await h.msg.replyAuto(`前\n![](${png})\n后`, { keyboard: KB });
  assert.equal(h.uploaded.length, 1);
  assert.deepEqual(h.calls[0].body.keyboard, KB);
  assert.deepEqual(h.deleted, ['img1']);
});

test('keyboard: 富媒体 msg_type=7 出口不挂按钮（官方口径），但不丢消息', async () => {
  const h = harness();
  await h.msg.replyAuto(`后面文字\n![](${png})`, { keyboard: KB });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.msgType, 7);
  assert.equal(h.calls[0].body.keyboard, undefined);
});

test('keyboard: 降级纯文本是 markdown 被拒后的重发，不再挂按钮', async () => {
  const h = harness({
    uploadMarkdownImage: async () => {
      const e = new Error('超大图');
      e.reason = 'oversize';
      throw e;
    },
  });
  await h.msg.replyAuto(`前\n![](${png})\n后`, { keyboard: KB });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].body.content !== undefined, true);
  assert.equal(h.calls[0].body.keyboard, undefined);
});

test('keyboard: 降级文本里仍有公网图时走 msg_type=2，按钮照挂', async () => {
  const h = harness({
    uploadMarkdownImage: async () => {
      const e = new Error('超大图');
      e.reason = 'oversize';
      throw e;
    },
  });
  await h.msg.replyAuto('前\n![](https://x/a.png)\n![](' + png + ')\n后', { keyboard: KB });
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].body.markdown?.content.includes('https://x/a.png'));
  assert.deepEqual(h.calls[0].body.keyboard, KB);
});
