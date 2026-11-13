/**
 * 语音转 SILK 的回归护栏。
 *
 * 2026-11-13 的现场：aurabot 用 Windows 本地语音（SAPI），输出 **22050Hz**
 * 单声道 16bit WAV。`silk.encode()` 只认 8000/12000/16000/24000，22050 不在
 * 表内时它**不报错**，吐出来的是能解码、但全静音的码流，体积还膨胀 18–29 倍。
 * 结果就是消息发得出去、QQ 里点开没声音。
 *
 * 这里固定住两条：
 *   1. 22050 直编必须被判成「没声音」（就是当初那个 bug）；
 *   2. `toSilk()` 必须把它转成 24k 再编，产出正常体积、正常电平的 SILK。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeChecked, toSilk, findFfmpeg, QQ_VOICE_RATE } from '../src/onebot/voice.js';
import { load } from '../src/ext-deps.js';

const silk = await load('silk-wasm');

/** 造一段正弦波 WAV（PCM16 单声道）；不依赖 ffmpeg */
function wavSine({ rate = 22050, seconds = 1, freq = 440 } = {}) {
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  }
  return buf;
}

const skip = silk ? false : '没装 silk-wasm（面板「外接 → 依赖」可装），跳过语音编码用例';

test('22050Hz 直编：必须被静音自检拦住（当初「能发不能播」的现场）', { skip }, async () => {
  const wav = wavSine({ rate: 22050, seconds: 1 });
  await assert.rejects(
    () => encodeChecked(silk, wav),
    /编码后没声音/,
    'silk 不支持 22050，直编出来是静音——这里必须报错，不能把静音条发出去',
  );
});

test('24000Hz 单声道 16bit 直编：自检放行，电平正常', { skip }, async () => {
  const wav = wavSine({ rate: QQ_VOICE_RATE, seconds: 1 });
  const out = await encodeChecked(silk, wav);
  assert.ok(out.data.length > 0);
  assert.ok(out.rms > 100, `正常语音的 RMS 应该上百，实测 ${out.rms}`);
});

test('22050Hz 走 toSilk：转 24k 后体积正常、时长不变', { skip }, async () => {
  const wav = wavSine({ rate: 22050, seconds: 1 });
  const via = await findFfmpeg();
  if (!via) {
    // 没有 ffmpeg 时不能转码，此时应当明确报错（而不是偷偷发静音）
    await assert.rejects(() => toSilk(wav, silk), /ffmpeg/);
    return;
  }
  const r = await toSilk(wav, silk);
  assert.equal(r.via, 'ffmpeg');
  assert.ok(
    r.silk.length < 30000,
    `1 秒语音的 SILK 应该在几 KB 量级，实测 ${r.silk.length}B（直编坏码流会是几十万字节）`,
  );
  const ms = Number(silk.getDuration?.(r.silk)) || 0;
  assert.ok(Math.abs(ms - 1000) < 150, `时长应约 1000ms，实测 ${ms}ms`);
});

test('已经是 24k 的 WAV 不需要 ffmpeg：via=wav', { skip }, async () => {
  const wav = wavSine({ rate: 24000, seconds: 1 });
  const r = await toSilk(wav, silk);
  assert.equal(r.via, 'wav');
});
