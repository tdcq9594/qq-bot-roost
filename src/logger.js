const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLevel(name) {
  threshold = LEVELS[name] ?? LEVELS.info;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function emit(level, tag, args) {
  if (LEVELS[level] < threshold) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} ${tag ? `[${tag}] ` : ''}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
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

export const log = createLogger();
