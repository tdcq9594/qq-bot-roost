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
import { ensureSilk } from '../ext-deps.js';

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
    /**
     * 这个 URL 是**客户端给的**（OneBot 的 `record.file`）。没有超时 +
     * 没有大小上限时，一个挂住的地址能把这条动作拖到天荒地老，一个大文件
     * 能把内存吃干。宿主协议那边的 `fetchBytes` 早就有这两道闸，这里补齐。
     */
    const r = await fetch(s, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`下载语音失败：HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_VOICE_BYTES) {
      throw new Error(`远端语音 ${(len / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_VOICE_BYTES) throw new Error('下载的语音超过 20MB 上限');
    return buf;
  }
  // Windows 上 `file:///C:/a.wav` 直接切前缀会变成 `/C:/a.wav`，必须走标准转换
  const p = /^file:\/\//i.test(s) ? fileURLToPath(s) : s;
  const st = await fs.stat(p);
  if (st.size > MAX_VOICE_BYTES) {
    throw new Error(`本地语音 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过 20MB 上限`);
  }
  return fs.readFile(p);
}

/**
 * 转成 SILK。
 *
 * @param {Buffer} buf
 * @param {object} silk  `silk-wasm` 模块
 * @returns {Promise<{silk:Buffer, via:'silk'|'wav'|'ffmpeg'}>}
 */
export async function toSilk(buf, silk) {
  /**
   * 先看大小：超了官方 20MB 上限就没必要去装依赖了。
   */
  if (buf.length > MAX_VOICE_BYTES) {
    const e = new Error(`语音 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过官方 20MB 上限`);
    e.retcode = 1400;
    throw e;
  }
  /**
   * 第一次发语音时**才**把 `silk-wasm` 装上。
   *
   * 以前这里直接抛「没装可选依赖，去面板点一键安装」——用户是在聊天窗口里
   * 收到这条错误的，还得自己跑去面板找。现在由 `ensureSilk()` 单飞安装一次：
   * 装上了这条消息就能发出去；装不上（没网 / 没有 npm）再给可执行的提示。
   */
  if (!silk) silk = await ensureSilk({ reason: '发语音' });
  if (!silk) {
    const e = new Error(
      '没装可选依赖 silk-wasm，自动安装也没成功（原因见日志）。' +
        '到面板「外接 → 依赖」点『一键安装』，或者先发文字；装好后下一条语音就能发。',
    );
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
