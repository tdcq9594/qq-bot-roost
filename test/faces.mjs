/**
 * 小黄脸（框架侧）回归
 * =====================
 *
 * 锁四组事实：
 *
 *   1. **码表的 id 是对的**。这套 id 是协议 faceId，不是表情面板顺序号；
 *      以前插件里那张表把老表情整段编错了（惊讶写成 33、流汗写成 2），
 *      发出去客户端找不到就静默丢弃 —— 2026-11-22 手机实测才定位到。
 *      下面钉住的 14 个值是**用账本里 QQ 自己推的 `<faceType=1,faceId=…,ext=…>`
 *      反解出来的**，谁改表谁先看这里。
 *
 *   2. **编码 = `0x14 + id` 两个字符**。手机 QQ 认这个，PC 不认（显示豆腐块），
 *      所以它不是"万能"，但在手机上是唯一真出小黄脸的办法。
 *
 *   3. **markdown 通道会吞表情**（同一条正文，msg_type=0 出脸、msg_type=2 只剩文字）。
 *      `auto` 模式必须把它降级成纯文本，否则用户白等。
 *
 *   4. **入站要翻成人话**。`<faceType=…>` 直接塞给模型既看不懂又费 token。
 *
 * 跑法：node --test test/faces.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FACE_PREFIX,
  encodeFaces,
  decodeFaceChars,
  decodeFaceTags,
  normalizeInbound,
  lookupFace,
  faceNameOf,
  faceList,
  faceCount,
} from '../src/faces/index.js';
import { buildSendPayload, applyFaceEncoding } from '../src/api.js';

/** 取一段文本的码点，方便断言"到底编成了什么字节" */
const codes = (s) => [...s].map((c) => c.charCodeAt(0));

/* ────────────────────────── 码表 ────────────────────────── */

test('码表：账本反解出来的真实 faceId 必须一条不错', () => {
  /**
   * 左列是 QQ 入站消息里 `faceId="N"` + `ext` 解出的名字，右列是表里的值。
   * 这些不是"资料上抄的"，是我们自己的账本里真实发生过的。
   */
  const truth = {
    惊讶: 0,
    发呆: 3,
    流泪: 5,
    流汗: 27,
    好: 124,
    斜眼笑: 178,
    笑哭: 182,
    幽灵: 187,
    脑阔疼: 262,
    捂脸: 264,
    辣眼睛: 265,
    呵呵哒: 272,
    元宝: 298,
    比心: 319,
    我方了: 343,
    大怨种: 344,
    偷感: 427,
    /** 下面 4 条是 2026-11-22 从运行账本里补抓的，NapCat 表里没有 */
    学习: 481,
    知识增加: 489,
    阴晴圆缺: 496,
    '中!': 498,
  };
  for (const [name, id] of Object.entries(truth)) {
    assert.equal(lookupFace(name), id, `${name} 应该是 ${id}`);
    assert.equal(faceNameOf(id), name, `${id} 应该叫 ${name}`);
  }
});

test('码表：老名字走别名，映射到同一个脸', () => {
  assert.equal(lookupFace('OK'), 124);
  assert.equal(lookupFace('NO'), lookupFace('不'));
  assert.equal(lookupFace('强'), lookupFace('赞'));
  assert.equal(lookupFace('弱'), lookupFace('踩'));
  assert.equal(lookupFace('大兵'), lookupFace('悠闲'));
  // 498 的真名是半角叹号，模型基本都写全角
  assert.equal(lookupFace('中！'), lookupFace('中!'));
});

test('码表：规模与唯一性', () => {
  const list = faceList();
  assert.equal(list.length, faceCount());
  assert.ok(list.length >= 280, '现行 QQ 表情 280+ 个，少了说明表被截断');
  // id 不能重复（重复说明生成脚本把两个名字接到了同一个 id）
  assert.equal(new Set(list.map((x) => x.id)).size, list.length);
  // 按 id 升序（面板和提示词都要稳定顺序）
  const ids = list.map((x) => x.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  // 名字不能为空
  assert.ok(list.every((x) => x.name.length > 0));
});

/* ────────────────────────── 编码 ────────────────────────── */

test('编码：普通标记 → 0x14 + faceId', () => {
  assert.deepEqual(codes(encodeFaces('【表情: 微笑】')), [FACE_PREFIX, 14]);
  assert.deepEqual(codes(encodeFaces('【表情：微笑】')), [FACE_PREFIX, 14]);
  // 前后有正文时只换标记本身
  assert.deepEqual(codes(encodeFaces('你好【表情: 惊恐】')), [0x4f60, 0x597d, FACE_PREFIX, 26]);
});

test('编码：id 超过 0xFF 也照编（手机 QQ 认两个码元）', () => {
  // 2026-11-22 实测：283 在手机上正常显示成狂笑，所以不做范围限制
  const out = encodeFaces('【表情: 狂笑】');
  assert.deepEqual(codes(out), [FACE_PREFIX, 283]);
});

test('编码：不认识的名字默认删掉，并回调名字', () => {
  const missed = [];
  assert.equal(encodeFaces('前【表情: 不存在的脸】后', { onMiss: (n) => missed.push(n) }), '前后');
  assert.deepEqual(missed, ['不存在的脸']);
});

test('编码：unknown=keep 时原样保留', () => {
  assert.equal(encodeFaces('前【表情: 不存在的脸】后', { unknown: 'keep' }), '前【表情: 不存在的脸】后');
});

test('编码：截断留下的半截标记要清掉', () => {
  // 正文按字数截断时可能正好落在 `【表情: 呲` 中间，没有 `】` 就匹配不上
  assert.equal(encodeFaces('说点什么【表情: 呲'), '说点什么');
  assert.equal(encodeFaces('【表情'), '');
});

test('编码：幂等 / 空输入 / 无标记', () => {
  const once = encodeFaces('【表情: 微笑】');
  assert.equal(encodeFaces(once), once, '已编码的正文不该被再编一次');
  assert.equal(encodeFaces(''), '');
  assert.equal(encodeFaces(null), '');
  assert.equal(encodeFaces('普通的正文'), '普通的正文');
});

test('编码：onMiss 抛错不许把发送带崩', () => {
  const out = encodeFaces('【表情: 不存在】', { onMiss: () => { throw new Error('boom'); } });
  assert.equal(out, '');
});

/* ────────────────────────── 解码 ────────────────────────── */

test('解码：0x14 + 码元 → 【表情: 名字】', () => {
  assert.equal(decodeFaceChars('你好\u0014\u000e'), '你好【表情: 微笑】');
  assert.equal(decodeFaceChars('\u0014\u011b'), '【表情: 狂笑】');
  // 认不出的 id 原样留着，别把正文吃掉
  assert.equal(decodeFaceChars('\u0014\u9999'), '\u0014\u9999');
});

test('解码：官方 faceType 标签，优先用 ext 里的名字', () => {
  // ext = base64({"text":"幽灵"})
  assert.equal(
    decodeFaceTags('<faceType=1,faceId="187",ext="eyJ0ZXh0Ijoi5bm954G1In0=">'),
    '【表情: 幽灵】',
  );
  // 没有 ext 时查表
  assert.equal(decodeFaceTags('<faceType=1,faceId="14">'), '【表情: 微笑】');
  // 表里没有的 id、ext 也坏掉 → 原样保留（不猜、不吞）
  assert.equal(decodeFaceTags('<faceType=1,faceId="9999">'), '<faceType=1,faceId="9999">');
  assert.equal(decodeFaceTags('<faceType=1,faceId="9999",ext="!!!notbase64!!!">'), '<faceType=1,faceId="9999",ext="!!!notbase64!!!">');
});

test('解码：ext 里塞超长内容不予采信', () => {
  const long = Buffer.from(JSON.stringify({ text: '一'.repeat(40) })).toString('base64');
  // 名字超过 12 字 → 丢掉 ext，回落到查表（查不到就原样）
  assert.match(decodeFaceTags(`<faceType=1,faceId="9999",ext="${long}">`), /^<faceType/);
});

test('入站：标签和控制字符混着来也能一次翻完', () => {
  assert.equal(
    normalizeInbound('<faceType=1,faceId="26">\u0014\u0000'),
    '【表情: 惊恐】【表情: 惊讶】',
  );
  assert.equal(normalizeInbound('没有表情的正文'), '没有表情的正文');
  assert.equal(normalizeInbound(''), '');
});

/* ───────────────────── 出站：通道策略 ───────────────────── */

test('出站：纯文本消息只编码，不改通道', () => {
  const p = buildSendPayload({ content: '你好【表情: 微笑】' });
  applyFaceEncoding(p, {});
  assert.equal(p.msg_type, 0);
  assert.deepEqual(codes(p.content), [0x4f60, 0x597d, FACE_PREFIX, 14]);
  assert.equal(p.markdown, undefined);
});

test('出站：带表情的 markdown 降级成纯文本（auto）', () => {
  /**
   * 2026-11-22 实测：同一段正文，msg_type=0 手机出脸、msg_type=2 只剩文字。
   * 所以 auto 必须降级，并且把 `**` 这类 markdown 记号剥掉再发。
   */
  const p = buildSendPayload({ markdown: { content: '**重点**【表情: 微笑】' } });
  assert.equal(p.msg_type, 2);
  applyFaceEncoding(p, { mode: 'auto' });
  assert.equal(p.msg_type, 0, '降级后必须是纯文本通道');
  assert.equal(p.markdown, undefined, 'markdown 字段要删掉，否则服务端仍按 2 渲染');
  assert.equal(p.content, '重点\u0014\u000e');
});

test('出站：正文带图时不降级，表情让位', () => {
  const src = '看图![](https://example.com/a.png)【表情: 微笑】';
  const p = buildSendPayload({ markdown: { content: src } });
  applyFaceEncoding(p, { mode: 'auto' });
  assert.equal(p.msg_type, 2, '图片比表情重要，保持 markdown');
  assert.equal(p.markdown.content, '看图![](https://example.com/a.png)');
  assert.equal(p.content, '');
});

test('出站：富媒体 / 卡片不降级', () => {
  // msg_type=7 由调用方显式给（buildSendPayload 只认 media 字段，不改类型）
  const media = buildSendPayload({ content: '图【表情: 微笑】', msgType: 7, media: { file_info: 'x' } });
  applyFaceEncoding(media, { mode: 'auto' });
  assert.equal(media.msg_type, 7, '富媒体通道不变');
  assert.equal(media.content, '图');

  const card = buildSendPayload({ card: { title: 't', url: 'u' } });
  applyFaceEncoding(card, { mode: 'auto' });
  assert.equal(card.msg_type, 8);
});

test('出站：mode=keep 保留排版、删标记', () => {
  const p = buildSendPayload({ markdown: { content: '**重点**【表情: 微笑】' } });
  applyFaceEncoding(p, { mode: 'keep' });
  assert.equal(p.msg_type, 2);
  assert.equal(p.markdown.content, '**重点**');
});

test('出站：mode=force 明知会被吞也照编（实测用）', () => {
  const p = buildSendPayload({ markdown: { content: '【表情: 微笑】' } });
  applyFaceEncoding(p, { mode: 'force' });
  assert.equal(p.msg_type, 2);
  assert.equal(p.markdown.content, '\u0014\u000e');
});

test('出站：markdown 里的名字全不认识 → 只删标记，不降级', () => {
  const p = buildSendPayload({ markdown: { content: '**重点**【表情: 瞎写的】' } });
  applyFaceEncoding(p, { mode: 'auto' });
  assert.equal(p.msg_type, 2, '没有表情字符就不用降级');
  assert.equal(p.markdown.content, '**重点**');
});

test('出站：enabled=false 一个字节都不动', () => {
  const p = buildSendPayload({ content: '【表情: 微笑】' });
  applyFaceEncoding(p, { enabled: false });
  assert.equal(p.content, '【表情: 微笑】');
});

test('出站：没有标记时不动任何字段（别把正常消息改坏）', () => {
  const p = buildSendPayload({ markdown: { content: '**加粗**和 [链接](https://a.b)' } });
  const before = JSON.stringify(p);
  applyFaceEncoding(p, { mode: 'auto' });
  assert.equal(JSON.stringify(p), before);
});
