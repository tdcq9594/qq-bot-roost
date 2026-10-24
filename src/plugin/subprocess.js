import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';
import { PROTOCOL_VERSION, DEFAULTS, serializeMessage, parseLine } from './protocol.js';
import { scopeOf, LEVEL, NO_PERM } from '../roles.js';

/**
 * 传给插件子进程的环境变量白名单。
 *
 * 只放行「跑起来必需」的那些：PATH 之类决定能不能找到解释器，
 * 语言运行时的 home / 编码。密钥、面板访问口令、webhook 配置一概不给。
 */
const ENV_ALLOW = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'NODE_PATH',
];

function inheritedEnv() {
  const out = {};
  for (const k of ENV_ALLOW) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

/**
 * 外部插件宿主：把一个任意语言写的子进程，包装成和内置插件一样的命令源。
 *
 * 并发模型
 *   - 不同会话（chatId）并行处理
 *   - 同一会话内串行，避免游戏状态被打乱
 *
 * 容错
 *   - 单条消息超时（默认 15s）视为无回应，不阻塞其他会话
 *   - 进程崩溃时结束所有挂起请求，并按次数上限自动重启
 */
export class SubprocessPlugin {
  constructor({ dir, manifest, pythonPath = null, goPath = null, botId = '-', dataDir = null, allocation, cfg, roles, isOwner }) {
    this.dir = dir;
    this.manifest = manifest;
    this.id = manifest.id;
    this.botId = botId;
    // 该插件专属的数据目录，插件想怎么存都行（JSON / SQLite / 自定义格式）
    this.dataDir = dataDir ?? null;
    // 依赖安装器解析出的解释器（可能是插件目录里的 .venv），没有就用系统默认
    this.pythonPath = pythonPath;
    this.goPath = goPath;
    this.allocation = allocation ?? { base: 10, end: 19 };
    this.cfg = cfg;
    this.roles = roles;
    this.isOwner = isOwner;

    this.log = createLogger(`plugin:${this.botId}:${this.id}`);
    this.child = null;
    this.seq = 0;
    this.pending = new Map(); // seq -> { msg, resolve, timer, idle }
    this.queues = new Map(); // chatId -> Promise
    this.commands = [];
    this.menus = [];
    this.levels = [];
    this.listen = []; // 想接收哪些非命令消息，如 ['message']
    // 插件主动上报的面板运行数据（{"t":"dashboard","data":{...}}）
    this.dashboard = null;
    this.state = 'stopped'; // stopped | starting | running | crashed
    this.lastError = '';
    this.restarts = [];
    this.stopping = false;
    this.stdoutBuf = '';

    this.readyPromise = null;
    this.readyResolve = null;
  }

  get status() {
    return {
      kind: 'external',
      runtime: this.manifest.runtime ?? 'exec',
      state: this.state,
      pid: this.child?.pid ?? null,
      error: this.lastError,
    };
  }

  /* ---------------- 生命周期 ---------------- */

  async start() {
    this.stopping = false;
    this.state = 'starting';
    this.stdoutBuf = '';

    const { command, args } = this.#resolveCommand();
    this.log.info(`启动子进程: ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      cwd: this.dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      /**
       * 只传必需的环境变量。
       *
       * 以前是 `{...process.env}`：`QQ_BOT_SECRET`、`ROOST_WEBUI_KEY`、
       * `ROOST_WEBHOOK_*` 全部漏给插件，任何从市场装的第三方插件
       * 都能直接拿到 AppSecret——而文档还写着「彻底隔离」。
       */
      env: {
        ...inheritedEnv(),
        ...(this.manifest.env ?? {}),
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    this.child = child;

    child.on('error', (e) => {
      this.lastError = `启动失败: ${e.message}`;
      this.log.error(this.lastError);
      this.#failAll(this.lastError);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.log.warn(`[stderr] ${text.slice(0, 500)}`);
    });

    child.on('exit', (code, signal) => this.#onExit(code, signal));

    // 等 ready
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = { resolve, reject };
    });
    const readyTimer = setTimeout(() => {
      this.lastError = `插件 ${DEFAULTS.readyTimeout / 1000}s 内没有返回 ready`;
      this.log.error(this.lastError);
      this.readyResolve?.reject(new Error(this.lastError));
    }, DEFAULTS.readyTimeout);
    readyTimer.unref?.();

    // 先把数据目录建好再 init，插件收到就能直接写
    if (this.dataDir) {
      try {
        await fs.mkdir(this.dataDir, { recursive: true });
      } catch (e) {
        this.log.warn(`创建数据目录失败: ${e.message}`);
      }
    }

    this.#send({
      t: 'init',
      protocol: PROTOCOL_VERSION,
      id: this.id,
      config: this.manifest.config ?? {},
      levels: this.allocation,
      coreLevels: LEVEL,
      prefix: this.cfg.commandPrefix || '/',
      // 外部插件没有 storage 协议，给它一个专属目录自己存
      dataDir: this.dataDir,
    });

    try {
      await this.readyPromise;
      this.state = 'running';
      this.lastError = '';
      this.log.info(`外部插件就绪，注册 ${this.commands.length} 条命令`);
    } catch (e) {
      this.state = 'crashed';
      this.lastError = e.message;
      throw e;
    } finally {
      clearTimeout(readyTimer);
    }
  }

  async stop() {
    this.stopping = true;
    this.#failAll('插件已停止');
    if (!this.child) return;
    try {
      this.#send({ t: 'shutdown' });
    } catch {}
    const child = this.child;
    this.child = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {}
    });
    this.state = 'stopped';
  }

  #resolveCommand() {
    const m = this.manifest;
    if (Array.isArray(m.command) && m.command.length) {
      return { command: m.command[0], args: m.command.slice(1) };
    }
    const entry = m.entry ?? '';
    const runtime = (m.runtime ?? '').toLowerCase();
    const py = this.pythonPath || 'python';
    // Go 是编译型，直接用 `go run` 跑源码，省掉手动编译一步。
    // 想要更快可以用 runtime: "exec" + 预先 go build 好的二进制。
    const go = this.goPath || process.env.GO_BIN || 'go';
    const map = {
      python: [py, [entry]],
      python3: [this.pythonPath || 'python3', [entry]],
      node: [process.execPath, [entry]],
      nodejs: [process.execPath, [entry]],
      go: [go, ['run', entry]],
      golang: [go, ['run', entry]],
      exec: [path.join(this.dir, entry), []],
    };
    const picked = map[runtime];
    if (!picked) {
      throw new Error(
        `plugin.json 缺少 command 或 runtime（支持 python / node / go / exec）`,
      );
    }
    return { command: picked[0], args: picked[1] };
  }

  /* ---------------- 收消息 ---------------- */

  #onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      const obj = parseLine(line);
      if (!obj) {
        if (line.trim()) this.log.warn(`[stdout 非协议内容] ${line.slice(0, 200)}`);
        continue;
      }
      try {
        this.#onMessage(obj);
      } catch (e) {
        this.log.error('处理插件输出出错:', e.message);
      }
    }
  }

  #onMessage(o) {
    switch (o.t) {
      case 'ready': {
        this.commands = Array.isArray(o.commands) ? o.commands : [];
        this.menus = Array.isArray(o.menus) ? o.menus : [];
        this.levels = Array.isArray(o.levels) ? o.levels : [];
        // listen 支持 true（= 全部消息）或字符串数组
        if (o.listen === true) this.listen = ['message'];
        else if (Array.isArray(o.listen)) this.listen = o.listen.map(String);
        else this.listen = [];
        this.readyResolve?.resolve();
        break;
      }
      case 'reply': {
        const p = this.pending.get(o.seq);
        if (!p) break;
        if (o.image) p.msg.replyImage(o.image).catch(() => {});
        else if (o.text) p.msg.reply(o.text).catch(() => {});
        this.#touchIdle(o.seq);
        break;
      }
      case 'push': {
        const p = this.pending.get(o.seq);
        if (p && o.text) p.msg.push(o.text).catch(() => {});
        this.#touchIdle(o.seq);
        break;
      }
      case 'handled': {
        this.#finish(o.seq);
        break;
      }
      case 'log': {
        const lv = ['debug', 'info', 'warn', 'error'].includes(o.level) ? o.level : 'info';
        this.log[lv](String(o.msg ?? ''));
        break;
      }
      case 'dashboard': {
        // 插件上报面板运行数据，随时可以发，后到的覆盖先到的
        this.dashboard = o.data ?? null;
        break;
      }
      case 'error': {
        this.log.error(String(o.msg ?? '插件报错'));
        break;
      }
      default:
        this.log.debug(`未知消息类型 ${o.t}`);
    }
  }

  #onExit(code, signal) {
    const wasRunning = this.state === 'running' || this.state === 'starting';
    this.child = null;
    this.#failAll(`插件进程退出 code=${code} signal=${signal ?? '-'}`);
    if (this.stopping) {
      this.state = 'stopped';
      return;
    }
    this.state = 'crashed';
    this.lastError = `进程退出 code=${code}`;
    this.log.error(this.lastError);

    if (this.manifest.autoRestart === false) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60_000);
    if (this.restarts.length >= DEFAULTS.restartLimit) {
      this.log.error(`一分钟内已重启 ${this.restarts.length} 次，不再自动重启`);
      return;
    }
    this.restarts.push(now);
    setTimeout(() => {
      if (this.stopping) return;
      this.log.info('尝试自动重启插件进程');
      this.start().catch((e) => this.log.error('重启失败:', e.message));
    }, 800);
  }

  #failAll(reason) {
    for (const [seq, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.idle) clearTimeout(p.idle);
      p.resolve();
      this.pending.delete(seq);
      this.log.debug(`请求 ${seq} 结束: ${reason}`);
    }
  }

  /* ---------------- 请求/响应 ---------------- */

  #send(obj) {
    if (!this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (e) {
      this.log.warn('写入子进程失败:', e.message);
      return false;
    }
  }

  #touchIdle(seq) {
    const p = this.pending.get(seq);
    if (!p) return;
    if (p.idle) clearTimeout(p.idle);
    // 收到回复后短暂等待，看是否还有后续分段
    p.idle = setTimeout(() => this.#finish(seq), DEFAULTS.idleTimeout);
    p.idle.unref?.();
  }

  #finish(seq) {
    const p = this.pending.get(seq);
    if (!p) return;
    clearTimeout(p.timer);
    if (p.idle) clearTimeout(p.idle);
    this.pending.delete(seq);
    p.resolve();
  }

  /** 计算这条消息在本插件作用域下的等级 */
  async #levelOf(msg) {
    if (this.isOwner(msg.userId)) return LEVEL.owner;
    const [chat, feature] = await Promise.all([
      this.roles.effective(scopeOf(msg), msg.userId, { owners: this.cfg.owners }),
      this.roles.effective(`feature:${this.id}`, msg.userId, { owners: this.cfg.owners }),
    ]);
    return Math.min(chat, feature);
  }

  /**
   * 把一条消息交给插件处理。
   * 同一会话串行，不同会话并行。
   */
  handle(msg) {
    const key = msg.chatId || 'global';
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.#deliver(msg))
      .catch((e) => this.log.error('投递消息出错:', e.message))
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    this.queues.set(key, next);
    return next;
  }

  async #deliver(msg) {
    if (this.state !== 'running' || !this.child) {
      this.log.debug('插件未运行，丢弃消息');
      return;
    }
    const seq = ++this.seq;
    const level = await this.#levelOf(msg);
    const payload = serializeMessage(msg, {
      level: level >= NO_PERM ? 9999 : level,
      scope: scopeOf(msg),
    });

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log.warn(`消息 ${seq} 处理超时（${DEFAULTS.msgTimeout / 1000}s）`);
        this.#finish(seq);
      }, DEFAULTS.msgTimeout);
      timer.unref?.();

      this.pending.set(seq, { msg, resolve, timer, idle: null });
      const ok = this.#send({ t: 'msg', seq, msg: payload });
      if (!ok) this.#finish(seq);
    });
  }
}
