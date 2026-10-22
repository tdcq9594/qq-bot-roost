import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

/** 环形缓冲，给 WebUI 的日志面板用 */
const BUFFER_MAX = 500;
const buffer = [];
const subscribers = new Set();

/**
 * 文件输出。
 *
 * 两类：
 *   core          → logs/bot.log          收全部日志（含插件），排查全局问题看它
 *   plugin:<id>   → logs/plugins/<id>.log 只收该插件
 *
 * 文件里一律记 debug 及以上，不受控制台 logLevel 影响——出问题时能回溯，
 * 控制台则只看用户设的级别，免得刷屏。按大小轮转，只保留一份历史。
 */
const sinks = new Map(); // key -> { stream, file, bytes, maxBytes, minLevel }

export function setLevel(name) {
  threshold = LEVELS[name] ?? LEVELS.info;
}

export function getLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) ?? 'info';
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 文件里要带日期，否则跨天后分不清 */
function fileStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 从 tag 推出该写哪个日志文件。
 *
 *   'plugin:main:dice' → 'plugin:main/dice'  该机器人的 dice 插件日志
 *   'bot:main'         → 'bot:main'          该机器人自己的日志
 *   其它（core/gateway/api…）→ null          只进全局 bot.log
 *
 * 多机器人下必须带上机器人 id，否则两个机器人的同名插件会写进同一个文件。
 */
function sinkKeyOf(tag) {
  if (!tag) return null;
  const parts = tag.split(':');
  if (parts[0] === 'plugin' && parts.length >= 3) return `plugin:${parts[1]}/${parts[2]}`;
  if (parts[0] === 'bot' && parts.length >= 2) return `bot:${parts[1]}`;
  return null;
}

/* ---------------- 文件输出 ---------------- */

/**
 * 挂一个日志文件。
 * @param {string} key  'core' 或 'plugin:<id>'
 * @param {string} file 绝对路径
 * @param {{maxBytes?:number, minLevel?:string}} [opts]
 */
export async function attachLogFile(key, file, { maxBytes = 5 * 1024 * 1024, minLevel = 'debug' } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await closeSink(key);

  const size = await fsp
    .stat(file)
    .then((s) => s.size)
    .catch(() => 0);

  const stream = fs.createWriteStream(file, { flags: 'a' });
  // 日志写失败绝不能把主程序带崩
  stream.on('error', () => {});
  sinks.set(key, {
    stream,
    file,
    bytes: size,
    maxBytes,
    minLevel: LEVELS[minLevel] ?? LEVELS.debug,
  });
}

async function closeSink(key) {
  const s = sinks.get(key);
  if (!s) return;
  sinks.delete(key);
  await new Promise((resolve) => s.stream.end(resolve));
}

/** 轮转：当前文件改名成 .1，重新开一个空的 */
async function rotate(key) {
  const s = sinks.get(key);
  if (!s) return;
  const backup = `${s.file}.1`;
  s.stream.end();
  await fsp.rename(s.file, backup).catch(() => {});
  const stream = fs.createWriteStream(s.file, { flags: 'a' });
  stream.on('error', () => {});
  sinks.set(key, { ...s, stream, bytes: 0 });
}

function writeFile(key, level, line) {
  const s = sinks.get(key);
  if (!s) return;
  if (LEVELS[level] < s.minLevel) return;
  try {
    s.stream.write(line + '\n');
    s.bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (s.bytes > s.maxBytes) rotate(key).catch(() => {});
  } catch {
    /* 写不进去就算了，不能因为日志影响主流程 */
  }
}

export function detachLogFile(key) {
  closeSink(key).catch(() => {});
}

/** 进程退出前把所有文件刷干净 */
export async function flushLogs() {
  const keys = [...sinks.keys()];
  await Promise.all(keys.map((k) => closeSink(k)));
}

/* ---------------- 核心 ---------------- */

function emit(level, tag, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');

  const now = new Date();
  const entry = {
    t: now.getTime(),
    level,
    tag,
    msg: text,
    time: stamp(now),
  };

  // 无论级别如何都进缓冲，方便 WebUI 调级别后回看
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {}
  }

  const line = `${entry.time} ${level.toUpperCase().padEnd(5)} ${tag ? `[${tag}] ` : ''}${text}`;

  // 文件：先写全局日志（全量），再写该机器人 / 该插件自己的
  writeFile('core', level, `${fileStamp(now)} ${level.toUpperCase().padEnd(5)} ${tag ? `[${tag}] ` : ''}${text}`);
  const key = sinkKeyOf(tag);
  if (key) writeFile(key, level, `${fileStamp(now)} ${level.toUpperCase().padEnd(5)} ${text}`);

  if (LEVELS[level] < threshold) return;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line);
}

export function createLogger(tag = '') {
  return {
    debug: (...a) => emit('debug', tag, a),
    info: (...a) => emit('info', tag, a),
    warn: (...a) => emit('warn', tag, a),
    error: (...a) => emit('error', tag, a),
    child: (sub) => createLogger(tag ? `${tag}:${sub}` : sub),
  };
}

/** 取最近 N 条日志 */
export function recentLogs(limit = 200, minLevel = 'debug') {
  const min = LEVELS[minLevel] ?? 0;
  return buffer.filter((e) => LEVELS[e.level] >= min).slice(-limit);
}

/** 订阅新日志，返回取消函数 */
export function onLog(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 当前挂着的日志文件，给面板显示用 */
export function logFiles() {
  return [...sinks.entries()].map(([key, s]) => ({
    key,
    file: s.file,
    bytes: s.bytes,
    maxBytes: s.maxBytes,
  }));
}

export const log = createLogger();
