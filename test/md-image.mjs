/**
 * markdown 图片尺寸补全。
 *
 * 这不是"锦上添花"的语法糖：QQ 的 markdown 图片**缺尺寸就不显示**，
 * 平台返回 200、日志无警告，用户只看到"图没出来"。所以这里的每一条断言
 * 都在钉一个"看不见的失败"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dimsOf, sizeSuffix, normalizeMarkdownImages, INLINE_MAX_WIDTH } from '../src/md-image.js';

/** 造一个只有文件头可信的 PNG（dimsOf 只看偏移 16/20，不校验 CRC） */
function pngHead(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** GIF：逻辑屏幕描述符在 6/8，小端 */
function gifHead(w, h) {
  const b = Buffer.alloc(24);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

/** JPEG：FF D8 FF C0 <len:2> <精度:1> <高:2> <宽:2> */
function jpegHead(w, h) {
  const b = Buffer.alloc(24);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(b, 0);
  b.writeUInt16BE(h, 7);
  b.writeUInt16BE(w, 9);
  return b;
}

test('dimsOf：PNG / GIF / JPEG 都读得出', () => {
  assert.deepEqual(dimsOf(pngHead(480, 240)), { w: 480, h: 240 });
  assert.deepEqual(dimsOf(gifHead(320, 180)), { w: 320, h: 180 });
  assert.deepEqual(dimsOf(jpegHead(320, 180)), { w: 320, h: 180 });
});

test('dimsOf：坏输入返回 0，不抛', () => {
  for (const bad of [null, undefined, Buffer.alloc(0), Buffer.from('not an image at all!!!!')]) {
    assert.deepEqual(dimsOf(bad), { w: 0, h: 0 });
  }
});

test('sizeSuffix：超宽缩到 480，比例不变', () => {
  assert.equal(sizeSuffix({ w: 960, h: 540 }), ' #480px #270px');
  assert.equal(sizeSuffix({ w: 1920, h: 1080 }), ' #480px #270px');
});

test('sizeSuffix：小图不放大', () => {
  assert.equal(sizeSuffix({ w: 200, h: 200 }), ' #200px #200px');
  assert.equal(sizeSuffix({ w: INLINE_MAX_WIDTH, h: 100 }), ' #480px #100px');
});

test('sizeSuffix：拿不到宽高返回空串（不猜比例）', () => {
  assert.equal(sizeSuffix({ w: 0, h: 0 }), '');
  assert.equal(sizeSuffix(undefined), '');
  assert.equal(sizeSuffix({ w: 480 }), '');
});

test('normalize：缺尺寸的补上，alt 为空时补占位说明', () => {
  const dims = new Map([['qqbot-media://a', { w: 480, h: 240 }]]);
  const out = normalizeMarkdownImages('看图\n\n![](qqbot-media://a)\n', (u) => dims.get(u));
  assert.match(out, /!\[图片 #480px #240px\]\(qqbot-media:\/\/a\)/);
});

test('normalize：已有的说明文字保留，只补尺寸', () => {
  const dims = new Map([['qqbot-media://a', { w: 320, h: 180 }]]);
  const out = normalizeMarkdownImages('![偷_0001](qqbot-media://a)', (u) => dims.get(u));
  assert.equal(out, '![偷_0001 #320px #180px](qqbot-media://a)');
});

test('normalize：已经写了两个尺寸位的原样放过（作者优先）', () => {
  const dims = new Map([['qqbot-media://a', { w: 320, h: 180 }]]);
  const raw = '![图1 #100px #50px](qqbot-media://a)';
  assert.equal(normalizeMarkdownImages(raw, (u) => dims.get(u)), raw);
});

test('normalize：正文里的 #3月 #5日 不是尺寸位，照常补（旧版 px 可选会误认）', () => {
  const dims = new Map([['qqbot-media://a', { w: 800, h: 400 }]]);
  const raw = '![今天聊了 #3月 #5日](qqbot-media://a)';
  assert.equal(
    normalizeMarkdownImages(raw, (u) => dims.get(u)),
    '![今天聊了 #3月 #5日 #480px #240px](qqbot-media://a)',
  );
});

test('normalize：只写一个尺寸位时按真实比例补齐，作者写的宽度不改', () => {
  const dims = new Map([['qqbot-media://a', { w: 800, h: 400 }]]);
  // 作者指定宽 200 → 真实比例高 100；#480px 超过上限也不动作者的值
  assert.equal(
    normalizeMarkdownImages('![图 #200px](qqbot-media://a)', (u) => dims.get(u)),
    '![图 #200px #100px](qqbot-media://a)',
  );
  assert.equal(
    normalizeMarkdownImages('![图 #480px](qqbot-media://a)', (u) => dims.get(u)),
    '![图 #480px #240px](qqbot-media://a)',
  );
});

test('normalize：单个尺寸位后仍有说明文字时，补的高紧跟尺寸位', () => {
  const dims = new Map([['qqbot-media://a', { w: 800, h: 400 }]]);
  assert.equal(
    normalizeMarkdownImages('![图 #200px 说明](qqbot-media://a)', (u) => dims.get(u)),
    '![图 #200px #100px 说明](qqbot-media://a)',
  );
});

test('normalize：查不到宽高的不动（宁可不显示也不压变形）', () => {
  const raw = '![](qqbot-media://unknown)';
  assert.equal(normalizeMarkdownImages(raw, () => undefined), raw);
});

test('normalize：代码块里的语法不动（那是要给人看的示例）', () => {
  const dims = new Map([['qqbot-media://a', { w: 480, h: 240 }]]);
  const raw = '```\n![](qqbot-media://a)\n```';
  assert.equal(normalizeMarkdownImages(raw, (u) => dims.get(u)), raw);
});

test('normalize：行内反引号里的语法也不动（讲语法时别改坏原文）', () => {
  const dims = new Map([['qqbot-media://a', { w: 480, h: 240 }]]);
  const raw = '发图写法是 `![](qqbot-media://a)` ，注意尺寸位不能省';
  assert.equal(normalizeMarkdownImages(raw, (u) => dims.get(u)), raw);
});

test('normalize：行内代码之外的图照样补，两边互不影响', () => {
  const dims = new Map([['qqbot-media://a', { w: 480, h: 240 }]]);
  const raw = '示例 `![](qqbot-media://a)` 真正要发的是\n![](qqbot-media://a)';
  assert.equal(
    normalizeMarkdownImages(raw, (u) => dims.get(u)),
    '示例 `![](qqbot-media://a)` 真正要发的是\n![图片 #480px #240px](qqbot-media://a)',
  );
});

test('normalize：多反引号行内代码（``a`b``）也保护', () => {
  const dims = new Map([['qqbot-media://a', { w: 480, h: 240 }]]);
  const raw = '``发 `![](qqbot-media://a)` 这样``';
  assert.equal(normalizeMarkdownImages(raw, (u) => dims.get(u)), raw);
});

test('normalize：反引号没配平不能把后面的图吞掉（宁可只当普通字符）', () => {
  const dims = new Map([['qqbot-media://a', { w: 480, h: 240 }]]);
  const raw = '价格 5` 到 10 之间\n![](qqbot-media://a)';
  assert.equal(
    normalizeMarkdownImages(raw, (u) => dims.get(u)),
    '价格 5` 到 10 之间\n![图片 #480px #240px](qqbot-media://a)',
  );
});

test('normalize：一条消息里多张图各自补，顺序不变', () => {
  const dims = new Map([
    ['qqbot-media://a', { w: 480, h: 240 }],
    ['qqbot-media://b', { w: 240, h: 480 }],
  ]);
  const raw = '段一\n![](qqbot-media://a)\n段二\n![](qqbot-media://b)\n段三';
  const out = normalizeMarkdownImages(raw, (u) => dims.get(u));
  assert.match(out, /段一\n!\[图片 #480px #240px\]\(qqbot-media:\/\/a\)\n段二\n!\[图片 #240px #480px\]\(qqbot-media:\/\/b\)\n段三/);
});

test('normalize：http 图 / 非图片 markdown 不碰', () => {
  const dims = new Map([['https://x/a.png', { w: 480, h: 240 }]]);
  const raw = '普通链接 [文字](https://x/a.png) 和 **粗体**';
  assert.equal(normalizeMarkdownImages(raw, (u) => dims.get(u)), raw);
});

test('normalize：没有 `![` 时零成本返回原串', () => {
  const s = '就是一句话';
  assert.equal(normalizeMarkdownImages(s, () => ({ w: 1, h: 1 })), s);
});

test('dimsOf 能读真实 PNG（base64 的 1×1）', () => {
  /** 1×1 透明 PNG，确保偏移和真图一致 */
  const real = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  assert.deepEqual(dimsOf(real), { w: 1, h: 1 });
});
