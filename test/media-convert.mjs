/**
 * 5.3 语音试听：framework 侧的 `media.convert` 只做纯内存 SILK 校验。
 *
 * 钉死三件事：
 *   ① 与真发语音共用 `encodeChecked`（同一份 SILK 转换）；
 *   ② 需要 ffmpeg 重采样的格式一律不试转，试听绝不写临时文件 / 装依赖；
 *   ③ 不上传、不发送、不进投递账本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toSilkDry, MAX_VOICE_BYTES } from '../src/onebot/voice.js';

/** 结构完整的最小 WAV（44 字节头 + 静音 PCM） */
function makeWav({ rate = 24000, channels = 1, bits = 16, samples = 240 } = {}) {
  const dataBytes = samples * channels * (bits / 8);
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * bits / 8, 28);
  b.writeUInt16LE(channels * bits / 8, 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

/** 假 silk-wasm：只实现 toSilkDry / encodeChecked 会碰到的那几个方法 */
function fakeSilk({ rate = 24000, channels = 1, bits = 16, secs = 1 } = {}) {
  const bytesPerSec = rate * channels * bits / 8;
  return {
    isWav: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF',
    isSilk: (b) => b.subarray(0, 9).toString('ascii') === '#!SILK_V3',
    getWavFileInfo: () => ({
      fmt: { sampleRate: rate, numberOfChannels: channels, bitsPerSample: bits, bytesPerSec },
      chunkInfo: [{ chunkId: 'data', dataLength: bytesPerSec * secs }],
    }),
    encode: async () => ({ data: Buffer.from('SILK') }),
    decode: async () => ({ data: Buffer.alloc(64) }),
    getDuration: () => 1000,
  };
}

test('纯内存校验：24kHz 单声道 16bit WAV 走和真发语音同一个 encodeChecked', async () => {
  const r = await toSilkDry(makeWav(), fakeSilk());
  assert.equal(r.ok, true);
  assert.equal(r.via, 'wav');
  assert.equal(r.size, 4, 'size 来自 encodeChecked 的输出');
  assert.equal(r.ms, 1000);
  assert.equal(r.rms, 0, '静音样本量出来的电平如实回传，方便面板提示「可能没声音」');
});

test('本来就是 SILK：直接通过，不再编码一次', async () => {
  const buf = Buffer.from('#!SILK_V3' + 'x'.repeat(32));
  const r = await toSilkDry(buf, fakeSilk());
  assert.equal(r.ok, true);
  assert.equal(r.via, 'silk');
  assert.equal(r.size, buf.length);
});

test('需要 ffmpeg 的格式：明确回报未校验，绝不跑转码（不写盘、不装 62MB）', async () => {
  const mp3 = Buffer.from('ID3' + 'x'.repeat(64));
  const r = await toSilkDry(mp3, fakeSilk());
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'needs_transcode');
  assert.match(r.message, /ffmpeg/);

  /** 22050Hz 的 WAV 正是「能发不能播」那次事故的采样率，试听也不许硬编 */
  const wav = await toSilkDry(makeWav({ rate: 22050 }), fakeSilk({ rate: 22050 }));
  assert.equal(wav.ok, false);
  assert.equal(wav.reason, 'needs_transcode');
});

test('超过 60 秒 / 20MB：不编码，直接拒', async () => {
  const long = await toSilkDry(makeWav(), fakeSilk({ secs: 61 }));
  assert.equal(long.reason, 'needs_transcode');
  const huge = await toSilkDry(Buffer.alloc(MAX_VOICE_BYTES + 1), fakeSilk());
  assert.equal(huge.ok, false);
  assert.equal(huge.reason, 'too_large');
});

test('没装 silk-wasm：试听不自动安装，真发语音那条路才装', async () => {
  const r = await toSilkDry(makeWav(), null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'silk_missing');
});

test('协议方法：media.convert 只到编码为止，不上传不发送不进账本', () => {
  const src = readFileSync('src/host/media.js', 'utf8');
  assert.ok(src.includes("def('media.convert'"), '要注册 media.convert');
  const block = src.slice(src.indexOf("def('media.convert'"), src.indexOf("def('media.markdownImage'"));
  for (const forbidden of ['sendOut(', 'uploadVoice(', 'ensureSilk(', 'ensureFfmpeg(', 'writeFile', 'ffmpegToWav(']) {
    assert.equal(block.includes(forbidden), false, `media.convert 不能碰 ${forbidden}`);
  }
  assert.ok(block.includes('toSilkDry('), '复用同一个编码实现');
  const pkg = readFileSync('package.json', 'utf8');
  assert.ok(pkg.includes('test/media-convert.mjs'), '要接进 npm test');
});
