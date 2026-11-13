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
 *   · mp3 / 其它   → 有 ffmpeg 就转 24k 单声道 WAV 再编码
 *
 * 两个可选依赖都**不在**根 package.json 里，靠 `ext-deps` 按需补装：
 * `silk-wasm` 1.5MB，第一次发语音时装；`ffmpeg` 62MB，第一次遇到
 * **非 WAV 语音**才装（`@ffmpeg-installer` 的平台子包带静态二进制）。
 * 面板「外接 → 依赖」也能手动装/卸。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createLogger } from '../logger.js';
import { ensureSilk, ensureFfmpeg, ffmpegBinary } from '../ext-deps.js';

const log = createLogger('onebot-voice');

/** 官方语音业务上限 20MB */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

/**
 * QQ 只按 **24kHz** 解码语音 SILK。
 *
 * SILK 容器里**不存采样率**，解码器按约定值读——所以编码前必须先把采样率
 * 对齐到 24k，否则客户端解出来就是错的：2026-11-13 实测，22050Hz 的 WAV
 * 直接编码会得到**全静音**的码流，语音条发得出去、点开没声音。
 */
export const QQ_VOICE_RATE = 24000;

/** 读 WAV 头；不是 WAV 或解析失败返回 null */
function wavInfoOf(silk, buf) {
  try {
    if (!silk.isWav?.(buf)) return null;
    return silk.getWavFileInfo?.(buf) ?? null;
  } catch {
    return null;
  }
}

/**
 * 语音条时长上限（秒）。
 *
 * 官方富媒体文档只写了大小（20MB 软限），但 `file_type=3` 实际还有 **60 秒**
 * 上限：超了之后**消息照样发得出去、客户端点开播不出来**。aurabot 这类客户
 * 端会把整段回复念成语音，很容易超过一分钟。
 */
export const MAX_VOICE_SEC = 60;

/** 从 WAV 头算时长（秒）；算不出来返回 0 */
function secondsOf(info) {
  const data = (info?.chunkInfo ?? []).find((c) => /^data$/i.test(String(c?.chunkId ?? '')));
  const perSec = Number(info?.fmt?.bytesPerSec) || 0;
  if (!data || !perSec) return 0;
  return Number(data.dataLength) / perSec;
}

/**
 * ffmpeg 探测结果。
 *
 * 命中就一直用（换 ffmpeg 要重启进程，属于罕见操作）；
 * **没找到只记 30 秒**——自动装可能在聊着聊着就把包装上了，
 * 永久缓存会让「下一条语音」还拿着旧的「没有」。
 */
let ffmpegCache; // undefined=没查过；{path, at}
const FFMPEG_MISS_TTL = 30_000;
let ffmpegMissLogged = false;

/** 跑一次 `-version`，退出码 0 就算可用（5 秒没响应当没有） */
function canRun(cmd) {
  return new Promise((resolve) => {
    let done = false;
    const child = spawn(cmd, ['-version'], { windowsHide: true });
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(false);
    }, 5000);
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

/**
 * 找 ffmpeg。顺序：`ROOST_FFMPEG` 指定 → PATH → 已装的可选依赖包。
 *
 * 用户自己装的排前面：可能比包内那版新（npm 那个是 4.1，2018 年的构建）。
 * 包内那份是兜底——`@ffmpeg-installer/ffmpeg` 的平台子包自带静态二进制，
 * 跟着 npm 一起下来，比让用户自己去下 80MB 的 exe 现实得多。
 *
 * @param {{refresh?: boolean}} [o] `refresh` 无视缓存重探（刚自动装完用）
 * @returns {Promise<string>} 可执行文件路径，或 ''
 */
export async function findFfmpeg({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && ffmpegCache) {
    if (ffmpegCache.path || now - ffmpegCache.at < FFMPEG_MISS_TTL) return ffmpegCache.path;
  }

  let found = '';
  /** 显式指定：用户想用自己的转码器时不用去改 PATH */
  const explicit = String(process.env.ROOST_FFMPEG ?? '').trim();
  if (explicit && (await canRun(explicit))) found = explicit;

  if (!found) {
    const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    if (await canRun(cmd)) found = cmd;
  }

  if (!found) {
    const bundled = await ffmpegBinary({ fresh: refresh });
    if (bundled && (await canRun(bundled))) found = bundled;
  }

  ffmpegCache = { path: found, at: now };
  if (found) {
    log.debug(`ffmpeg：${found}`);
  } else if (!ffmpegMissLogged) {
    ffmpegMissLogged = true;
    log.info('没找到 ffmpeg：mp3 语音发不出去（WAV / SILK 不受影响；第一次遇到会尝试自动装）');
  }
  return found;
}

/**
 * 把任意音频转成 24k 单声道 WAV（需要 ffmpeg）。
 *
 * **输出必须落临时文件，不能走 `pipe:1`。**
 * WAV 的 RIFF 头里带「整个文件多长」，走管道时 ffmpeg 不知道总长度，
 * 会把 size 写成 `0xFFFFFFFF`；`silk-wasm` 按这个字段算采样数，直接
 * `divide by zero`（2026-11-13 实测：同一段音频，文件输出 3487 字节 SILK，
 * 管道输出报错）。落地后 ffmpeg 能回填真实长度。
 * 输入仍走 `pipe:0`（不需要回填），省一次临时文件写入。
 */
async function ffmpegToWav(input, ffmpeg, { maxSec = MAX_VOICE_SEC } = {}) {
  const tmp = path.join(os.tmpdir(), `roost-wav-${crypto.randomUUID()}.wav`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error',
          '-i', 'pipe:0',
          /** 超长直接截断：语音条播不了超过 60 秒的音频，截断至少能听 */
          ...(maxSec ? ['-t', String(maxSec)] : []),
          '-f', 'wav', '-ar', String(QQ_VOICE_RATE), '-ac', '1', '-y', tmp,
        ],
        { windowsHide: true },
      );
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 转码失败（exit ${code}）：${err.trim().slice(0, 200) || '无输出'}`));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
    return await fs.readFile(tmp);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
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

  /**
   * **采样率必须归一到 24kHz / 单声道 / 16bit**，否则客户端放不出来。
   *
   * 2026-11-13 实测（aurabot 用 Windows 本地语音 SAPI，输出 22050Hz / 单声道 /
   * 16bit 的 WAV）：`silk.encode` 只认 8000 / 12000 / 16000 / 24000 四档，
   * 22050 不在表内，它**不报错**，却把码流编成了静音——5 条真实语音解码后
   * RMS 全是 1，SILK 体积还膨胀 18–29 倍。QQ 侧表现就是「语音条发得出去、
   * 点开没声音」，日志里发送还是成功的。
   *
   * 这条路径以前只对「非 WAV」转码，WAV 直接编码，所以 TTS 出 WAV 的用户
   * 一直是坏的；走 mp3 的因为经过 ffmpeg，所以从来没暴露过。
   */
  const info = wavInfoOf(silk, buf);
  const fmt = info?.fmt ?? null;
  const seconds = secondsOf(info);
  const tooLong = seconds > MAX_VOICE_SEC;
  const alreadyQqVoice =
    Boolean(fmt) &&
    Number(fmt.sampleRate) === QQ_VOICE_RATE &&
    Number(fmt.numberOfChannels) === 1 &&
    Number(fmt.bitsPerSample) === 16 &&
    !tooLong;

  if (alreadyQqVoice) {
    const out = await encodeChecked(silk, buf);
    log.info(`语音 SILK 就绪：via=wav，${Math.round(Number(silk.getDuration?.(out.data)) || 0)}ms，${out.data.length}B`);
    return { silk: out.data, via: 'wav' };
  }

  /**
   * 走到这里说明**不能直接编码**：要么不是 WAV，要么采样率/声道/位深不对，
   * 要么时长超限。`silk.encode` 只吃单声道 16bit——双声道、32bit float 的
   * WAV 会被它按错误的方式解释、**不会报错**，产出的码流在客户端就是
   * 「语音条在、点开放不出来」。参数写进日志，现场不用再猜。
   */
  log.info(
    fmt
      ? `语音 WAV ${fmt.sampleRate}Hz / ${fmt.numberOfChannels} 声道 / ${fmt.bitsPerSample}bit`
          + `${seconds ? ` / ${seconds.toFixed(1)}s` : ''} → 转 24kHz 单声道`
      : `语音不是 WAV（${buf.length}B）→ ffmpeg 转 24kHz`,
  );

  let ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    /**
     * 第一次遇到需要转码的语音：**当场补装**（62MB，可能要等一两分钟），
     * 而不是让用户收到一句「去装个 ffmpeg」。`ensureFfmpeg` 自带单飞 +
     * 30 分钟冷却，装不上才走到下面那段报错。
     */
    await ensureFfmpeg({ reason: fmt ? '把 TTS 的语音重采样到 24kHz' : '把 mp3/ogg 语音转成 WAV' });
    ffmpeg = await findFfmpeg({ refresh: true });
  }
  if (!ffmpeg) {
    const e = new Error(
      fmt
        ? `这段 WAV 是 ${fmt.sampleRate}Hz / ${fmt.numberOfChannels} 声道，QQ 只认 24000Hz 单声道，` +
            '需要 ffmpeg 重采样，自动安装也没成功（原因见日志）。到面板「外接 → 依赖」点『一键安装』。'
        : '这段语音不是 WAV/SILK，需要 ffmpeg 转码，自动安装也没成功（原因见日志）。' +
            '到面板「外接 → 依赖」点『一键安装』，或让 TTS 直接输出 WAV；装好后下一条语音就能发。',
    );
    e.retcode = 1400;
    throw e;
  }
  if (tooLong) {
    log.warn(
      `语音 ${seconds.toFixed(0)}s 超过官方 ${MAX_VOICE_SEC}s 上限（超了客户端放不出来），已截断`,
    );
  }
  const wav = await ffmpegToWav(buf, ffmpeg);
  const out = await encodeChecked(silk, wav);
  const data = out.data;
  /**
   * 每次留一行「实际发出去的语音多大多少长」。
   * 2026-11-13 排查「能发不能播」时最缺的就是这个——日志里只有 `[语音消息]`，
   * 分不清是采样率、时长还是编码的问题。现在连电平一起打，静音码流一眼能看出来。
   */
  log.info(
    `语音 SILK 就绪：via=ffmpeg，${Math.round(Number(silk.getDuration?.(data)) || 0)}ms，${data.length}B，RMS ${Math.round(out.rms)}`,
  );
  return { silk: data, via: 'ffmpeg' };
}

/** 低于这个电平就当作「没有声音」：正常语音 RMS 在几百到几千，静音只有 ±1 的量化噪声 */
const MIN_AUDIBLE_RMS = 10;

/** 扫一遍 WAV 的 chunk，取 fmt 和 data 段（静音自检要量输入侧电平） */
function wavParts(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        rate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(start, Math.min(buf.length, start + size));
    }
    off = start + size + (size & 1);
  }
  return fmt && data ? { fmt, data } : null;
}

/** PCM16 的电平（只看前 1MB，判断有没有声音足够了） */
function pcmRms16(buf, maxBytes = 1 << 20) {
  const end = Math.min(buf.length - 1, maxBytes);
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < end; i += 2) {
    const v = buf.readInt16LE(i);
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/**
 * 编码 + **静音自检**。
 *
 * `silk.encode()` 遇到它不支持的采样率（比如 22050）不会报错，而是吐出一段
 * 能解码、但全静音的码流——消息照常发出，用户点开什么都没有，最难查。
 * 所以编完自己解码量一次电平：输入明明有声、输出却没声，就当场抛错，
 * 宁可这条语音报失败，也不发一条「看着在、其实空的」语音条。
 *
 * 导出给测试用：`test/onebot-voice.mjs` 拿 22050 的 WAV 直接喂它，
 * 断言它必须拦下来——这是「能发不能播」那道 bug 的回归护栏。
 */
/**
 * 5.3 试听：**纯内存**的 SILK 编码校验，和真发语音共用 `encodeChecked`。
 *
 * 真发那条路（`toSilk`）在格式不合时会 `ensureSilk` / `ensureFfmpeg`
 * 自动装依赖，`ffmpegToWav` 还会落临时文件——试听若照跑一遍，等于
 * 「点一下试听，后台开始下 62MB、写一堆盘」，直接违背 5.3 的验收。
 *
 * 所以这里只覆盖**不需要转码**的两种输入：本来就是 SILK，或已经是
 * QQ 要的 24kHz / 单声道 / 16bit / ≤60s 的 WAV。这两种走的编码函数
 * 与 `toSilk` 的 `alreadyQqVoice` 分支是同一个 `encodeChecked`，
 * 因此「试听校验通过」等价于「这份字节发出去能播」。
 * 其它格式明确回 `needs_transcode`，让面板说清「发送时框架会转码」，
 * 而不是假装验过了。
 *
 * @returns {Promise<{ok:boolean, reason?:string, message?:string, size?:number, via?:string, ms?:number, rms?:number}>}
 */
export async function toSilkDry(buf, silk) {
  if (buf.length > MAX_VOICE_BYTES) {
    return { ok: false, reason: 'too_large', message: `语音 ${(buf.length / 1048576).toFixed(1)}MB 超过 20MB 上限` };
  }
  if (!silk) {
    return { ok: false, reason: 'silk_missing', message: '没装 silk-wasm；真正发语音时框架会自动安装，试听不装' };
  }
  if (silk.isSilk?.(buf)) {
    return { ok: true, size: buf.length, via: 'silk', ms: Math.round(Number(silk.getDuration?.(buf)) || 0) };
  }
  const info = wavInfoOf(silk, buf);
  const fmt = info?.fmt ?? null;
  const seconds = secondsOf(info);
  const direct = Boolean(fmt)
    && Number(fmt.sampleRate) === QQ_VOICE_RATE
    && Number(fmt.numberOfChannels) === 1
    && Number(fmt.bitsPerSample) === 16
    && seconds <= MAX_VOICE_SEC;
  if (!direct) {
    return {
      ok: false,
      reason: 'needs_transcode',
      message: fmt
        ? `这段 WAV 是 ${fmt.sampleRate}Hz / ${fmt.numberOfChannels} 声道 / ${fmt.bitsPerSample}bit，发送前要 ffmpeg 重采样；试听不跑转码以免写盘`
        : '这段音频不是 WAV/SILK，发送前要 ffmpeg 转码；试听不跑转码以免写盘',
    };
  }
  const out = await encodeChecked(silk, buf);
  return {
    ok: true,
    size: out.data.length,
    via: 'wav',
    ms: Math.round(Number(silk.getDuration?.(out.data)) || 0),
    rms: Math.round(out.rms),
  };
}

export async function encodeChecked(silk, wav) {
  const data = encodeOrThrow(await silk.encode(wav, 0));
  const src = wavParts(wav);
  const inRms =
    src && src.fmt.format === 1 && src.fmt.bits === 16 ? pcmRms16(src.data) : null;
  let rms = -1;
  try {
    const dec = await silk.decode(data, QQ_VOICE_RATE);
    rms = pcmRms16(Buffer.from(dec?.data ?? dec));
  } catch {
    /* 量不出来不挡：解码失败是 silk-wasm 自己的问题，码流本身仍可能没问题 */
  }
  if (inRms !== null && inRms >= MIN_AUDIBLE_RMS && rms >= 0 && rms < MIN_AUDIBLE_RMS) {
    const e = new Error(
      `SILK 编码后没声音（输入 RMS ${inRms.toFixed(0)} → 输出 ${rms.toFixed(0)}），这条语音没发出去`,
    );
    e.retcode = 1500;
    throw e;
  }
  return { data, rms };
}

/** `silk.encode()` 的结果统一成 Buffer；空结果直接抛，别把空语音传上去 */
function encodeOrThrow(out) {
  const data = Buffer.from(out?.data ?? out);
  if (!data.length) {
    const e = new Error('SILK 编码结果是空的');
    e.retcode = 1500;
    throw e;
  }
  return data;
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
