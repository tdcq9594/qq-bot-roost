#!/usr/bin/env node
/** 面板素材页的 handler 单测：不起 HTTP 服务，用假 runtime 走完整调用链。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleMediaList,
  handleMediaUpload,
  handleMediaDelete,
  findMediaImage,
  humanMediaError,
} from '../src/web/media.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function runtime(impl = {}) {
  const calls = [];
  const defaults = {
    async listMediaImages() {
      return { images: [], nextCursor: '', total: 0, quota: 100 };
    },
    async uploadMarkdownImageBytes(buf, opts) {
      return { imageId: 'img_1', url: 'qqbot-media://image/v1/token', fileName: opts.fileName };
    },
    async deleteMediaImage() {
      return {};
    },
  };
  const api = {};
  for (const name of Object.keys({ ...defaults, ...impl })) {
    api[name] = async (...args) => {
      calls.push([name, ...args]);
      return (impl[name] || defaults[name])(...args);
    };
  }
  return { rt: { id: 'main', api }, calls };
}

test('list 原样透传 cursor，并回 quota', async () => {
  const { rt, calls } = runtime({
    listMediaImages: async ({ cursor }) => ({
      images: [{ imageId: 'a', fileName: 'a.png' }],
      nextCursor: 'next',
      total: 1,
      quota: 100,
    }),
  });
  const out = await handleMediaList({
    runtimes: [rt],
    query: { bot: 'main', cursor: 'abc' },
    fallbackRuntime: null,
  });
  assert.equal(out.code, 200);
  assert.equal(out.body.nextCursor, 'next');
  assert.equal(out.body.quota, 100);
  assert.deepEqual(calls, [['listMediaImages', { cursor: 'abc' }]]);
});

test('list 选不存在的机器人回 404，不打 API', async () => {
  const { rt, calls } = runtime();
  const out = await handleMediaList({ runtimes: [rt], query: { bot: 'nope' } });
  assert.equal(out.code, 404);
  assert.equal(calls.length, 0);
});

test('upload 走 retain:true，传解码后的真实字节', async () => {
  const { rt, calls } = runtime();
  const out = await handleMediaUpload({
    runtimes: [rt],
    body: { bot: 'main', name: 'kline.png', data: PNG.toString('base64') },
    fallbackRuntime: null,
  });
  assert.equal(out.code, 200);
  assert.equal(out.body.image.imageId, 'img_1');
  assert.deepEqual(calls[0][1], PNG);
  assert.deepEqual(calls[0][2], { fileName: 'kline.png', retain: true });
});

test('upload 拒绝非法 base64 / 路径名 / 空数据', async () => {
  const { rt, calls } = runtime();
  for (const body of [
    { name: 'a.png', data: 'not-base64!' },
    { name: '', data: PNG.toString('base64') },
    { name: '../a.png', data: PNG.toString('base64') },
    { name: 'a.png', data: '' },
  ]) {
    const out = await handleMediaUpload({ runtimes: [rt], body, fallbackRuntime: rt });
    assert.equal(out.code, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test('upload 在解码前按 base64 长度挡住超过 10MB 的图片', async () => {
  const { rt, calls } = runtime();
  const out = await handleMediaUpload({
    runtimes: [rt],
    body: { name: 'big.png', data: 'A'.repeat(Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4) },
    fallbackRuntime: rt,
  });
  assert.equal(out.code, 400);
  assert.equal(calls.length, 0);
});

test('delete 没 confirm 不放行；确认后先查列表再 allowUnowned', async () => {
  const { rt, calls } = runtime({
    listMediaImages: async () => ({
      images: [{ imageId: 'img_1', fileName: 'a.png' }],
      nextCursor: '',
      total: 1,
      quota: 100,
    }),
  });
  const base = { runtimes: [rt], body: { bot: 'main', imageId: 'img_1' } };
  assert.equal((await handleMediaDelete(base)).code, 403);
  assert.equal(calls.length, 0);

  const out = await handleMediaDelete({ ...base, body: { ...base.body, confirm: true } });
  assert.equal(out.code, 200);
  assert.deepEqual(calls.map((c) => c[0]), ['listMediaImages', 'deleteMediaImage']);
  assert.deepEqual(calls[1], ['deleteMediaImage', 'img_1', { allowUnowned: true }]);
});

test('delete 拒绝不属于当前机器人的 image_id', async () => {
  const { rt, calls } = runtime();
  const out = await handleMediaDelete({
    runtimes: [rt],
    body: { imageId: 'other', confirm: true },
    fallbackRuntime: rt,
  });
  assert.equal(out.code, 404);
  assert.equal(calls.filter((c) => c[0] === 'deleteMediaImage').length, 0);
});

test('findMediaImage 翻页找得到，也认得出循环游标', async () => {
  const pages = [
    { images: [], nextCursor: 'p2' },
    { images: [{ imageId: 'target' }], nextCursor: '' },
  ];
  const api = {
    async listMediaImages({ cursor }) {
      return cursor === '' ? pages[0] : pages[1];
    },
  };
  assert.deepEqual(await findMediaImage(api, 'target'), { imageId: 'target' });

  let n = 0;
  const loop = {
    async listMediaImages() {
      n += 1;
      return { images: [], nextCursor: 'same' };
    },
  };
  assert.equal(await findMediaImage(loop, 'none'), null);
  assert.equal(n, 2);
});

test('官方错误码给人话，原始错误不丢', () => {
  assert.match(humanMediaError({ qqCode: 40035007 }), /100 张上限/);
  assert.match(humanMediaError({ qqCode: 40035007 }), /原始错误/);
  assert.equal(humanMediaError(new Error('网络断了')), '网络断了');
});
