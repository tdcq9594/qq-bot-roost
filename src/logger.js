const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

/** 环形缓冲，给 WebUI 的日志面板用 */
const BUFFER_MAX = 500;
const buffer = [];
const subscribers = new Set();

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

function emit(level, tag, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join(' ');

  const entry = {
    t: Date.now(),
    level,
    tag,
    msg: text,
    time: stamp(),
  };

  // 无论级别如何都进缓冲，方便 WebUI 调级别后回看
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  for (const fn of subscribers) {
    try {
      fn(entry);
    } catch {}
  }

  if (LEVELS[level] < threshold) return;
  const line = `${entry.time} ${level.toUpperCase().padEnd(5)} ${tag ? `[${tag}] ` : ''}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line + text);
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

export const log = createLogger();
