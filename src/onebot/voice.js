/**
 * 语音：WAV / mp3 → SILK
 * ======================
 *
 * 官方只收 SILK（`file_type=3`）。`silk-wasm` 是**可选依赖**：
 * 装了才转，没装就明确报错，框架本体不为这条功能破零依赖。
 *
 * 三条路径：
 *   · 已经是 SILK  → 直接发
 *   · WAV          → `silk-wasm.encode(buf, 0)`（它自己读 WAV 头，零转码）
 *   · mp3 / 其它   → 有 ffmpeg 就转 24k 单声道 WAV 再编码；没有就报错并给建议
 *
 * ffmpeg 只做 PATH 探测，**不打包**（80MB 起步、原生二进制）。面板依赖卡会显示
 * 「ffmpeg：未找到」，让用户知道差在哪一步。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('onebot-voice');

/** 官方语音业务上限 20MB */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

let ffmpegCache; // undefined=没查过；null=没有；string=路径

/** 找 ffmpeg（只查 PATH，带缓存） */
export async function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  ffmpegCache = await new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, ['-version'], { windowsHide: true });
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    child.on('error', () => finish(null));
    child.on('exit', (code) => finish(code === 0 ? cmd : null));
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(null);
    }, 5000).unref?.();
  });
  if (!ffmpegCache) log.info('没找到 ffmpeg：mp3 语音发不出去（WAV / SILK 不受影响）');
  return ffmpegCache;
}

/** 把任意音频转成 24k 单声道 WAV（需要 ffmpeg） */
function ffmpegToWav(input, ffmpeg) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'wav', '-ar', '24000', '-ac', '1', 'pipe:1'],
      { windowsHide: true },
    );
    const chunks = [];
    let err = '';
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg 转码失败（exit ${code}）：${err.trim().slice(0, 200) || '无输出'}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * 取音频字节：`base64://` / `http(s)://` / 本地路径。
 * @returns {Promise<Buffer>}
 */
export async function fetchAudio(file) {
  const s = String(file ?? '');
  if (!s) throw new Error('语音段没有 file');
  if (/^base64:\/\//i.test(s)) {
    const b64 = s.slice('base64://'.length);
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('base64 语音解出来是空的');
    return buf;
  }
  if (/^https?:\/\//i.test(s)) {
    const r = await fetch(s);
    if (!r.ok) throw new Error(`下载语音失败：HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
  // Windows 上 `file:///C:/a.wav` 直接切前缀会变成 `/C:/a.wav`，必须走标准转换
  if (/^file:\/\//i.test(s)) return fs.readFile(fileURLToPath(s));
  return fs.readFile(s);
}

/**
 * 转成 SILK。
 *
 * @param {Buffer} buf
 * @param {object} silk  `silk-wasm` 模块
 * @returns {Promise<{silk:Buffer, via:'silk'|'wav'|'ffmpeg'}>}
 */
export async function toSilk(buf, silk) {
  if (!silk) {
    const e = new Error('没装可选依赖 silk-wasm，发不了语音（面板「兼容」页可一键安装）');
    e.retcode = 1400;
    throw e;
  }
  if (buf.length > MAX_VOICE_BYTES) {
    const e = new Error(`语音 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过官方 20MB 上限`);
    e.retcode = 1400;
    throw e;
  }

  if (silk.isSilk?.(buf)) return { silk: buf, via: 'silk' };

  let wav = buf;
  let via = 'wav';
  if (!silk.isWav?.(buf)) {
    const ffmpeg = await findFfmpeg();
    if (!ffmpeg) {
      const e = new Error(
        '这段语音不是 WAV/SILK，需要 ffmpeg 先转码。让 TTS 直接输出 WAV，或把 ffmpeg 加进 PATH',
      );
      e.retcode = 1400;
      throw e;
    }
    wav = await ffmpegToWav(buf, ffmpeg);
    via = 'ffmpeg';
  }

  const out = await silk.encode(wav, 0);
  const data = Buffer.from(out?.data ?? out);
  if (!data.length) {
    const e = new Error('SILK 编码结果是空的');
    e.retcode = 1500;
    throw e;
  }
  return { silk: data, via };
}

/**
 * 传上去并返回 `file_info`。
 *
 * ≤5MB 走二进制直传；超过就走临时文件 + 分片（silk 很少这么大，但别在边界上炸）。
 */
export async function uploadVoice(api, scene, target, silkBuf) {
  if (silkBuf.length <= 5 * 1024 * 1024) {
    const up = await api.uploadMedia(scene, target, {
      fileType: 3,
      fileData: silkBuf.toString('base64'),
      fileName: `${crypto.randomUUID()}.silk`,
    });
    if (!up?.file_info) throw new Error('语音上传成功但没拿到 file_info');
    return up.file_info;
  }

  const tmp = path.join(os.tmpdir(), `roost-voice-${crypto.randomUUID()}.silk`);
  await fs.writeFile(tmp, silkBuf);
  try {
    const up = await api.uploadLocalFileSharded(scene, target, tmp, 3);
    if (!up?.file_info) throw new Error('语音分片上传成功但没拿到 file_info');
    return up.file_info;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
