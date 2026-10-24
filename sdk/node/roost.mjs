#!/usr/bin/env node
/**
 * 栖 Roost 外部插件 SDK（Node.js，单文件）
 * =======================================
 *
 * 拷到插件目录直接用，不用装包：
 *
 *   plugins/my-plugin/
 *   ├── plugin.json
 *   ├── roost.mjs      ← 这个文件
 *   └── main.mjs
 *
 * main.mjs：
 *
 *   import { Plugin } from './roost.mjs';
 *   const p = new Plugin({ id: 'my-plugin', name: '我的插件', version: '1.0.0' });
 *   p.command('hello [名字]', { desc: '打个招呼' }, (m) => {
 *     m.reply(`你好，${m.args[0] || m.name}`);
 *   });
 *   p.run();
 *
 * 调试输出用 console.error——stdout 只能写协议 JSON。
 */
import process from 'node:process';
import readline from 'node:readline';

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** 收到的一条消息 */
export class Msg {
  constructor(seq, raw) {
    this.seq = seq;
    this.id = raw.id ?? '';
    this.kind = raw.kind ?? '';
    this.group = raw.group ?? '';
    this.user = raw.user ?? '';
    this.name = raw.name ?? '';
    this.content = raw.content ?? '';
    this.command = raw.command ?? '';
    this.args = raw.args ?? [];
    this.isCommand = Boolean(raw.isCommand);
    this.mentioned = Boolean(raw.mentioned);
    this.at = raw.at ?? 0;
    this.raw = raw;
  }

  /** 被动回复，可以连发多条 */
  reply(text) {
    send({ t: 'reply', seq: this.seq, text: String(text) });
  }

  replyImage(url) {
    send({ t: 'reply', seq: this.seq, image: String(url) });
  }

  /** 主动推送（不带 msg_id，受每日额度限制） */
  push(text) {
    send({ t: 'push', seq: this.seq, text: String(text) });
  }

  log(level, text) {
    send({ t: 'log', level, msg: String(text) });
  }
}

export class Plugin {
  constructor({ id, name, version = '0.0.0', config = {}, levels = [] }) {
    this.id = id;
    this.name = name ?? id;
    this.version = version;
    this.config = config;
    this.levels = levels;
    this.commands = new Map();
    this.menus = [];
    this.listeners = [];
  }

  /** 注册命令。模式里的 `[可选]` `<必填>` 只是提示，实际取 m.args */
  command(pattern, opts, fn) {
    const name = String(pattern).trim().split(/\s+/)[0];
    this.commands.set(name, { pattern, desc: opts?.desc ?? '', fn });
    for (const a of opts?.alias ?? []) this.commands.set(a, { pattern, desc: opts?.desc ?? '', fn });
    return this;
  }

  /** 被动监听：返回 true 表示「这条我处理了」 */
  onMessage(fn) {
    this.listeners.push(fn);
    return this;
  }

  menu(title, items) {
    this.menus.push({ title, items });
    return this;
  }

  run() {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let obj;
      try {
        obj = JSON.parse(s);
      } catch {
        return;
      }

      if (obj.t === 'init') {
        if (obj.config && typeof obj.config === 'object') Object.assign(this.config, obj.config);
        this.#ready();
      } else if (obj.t === 'msg') {
        this.#handle(obj);
      } else if (obj.t === 'shutdown') {
        rl.close();
        process.exit(0);
      }
    });
  }

  #ready() {
    send({
      t: 'ready',
      id: this.id,
      name: this.name,
      version: this.version,
      commands: [...this.commands.entries()].map(([name, c]) => ({
        name,
        desc: c.desc,
        pattern: c.pattern,
      })),
      menus: this.menus,
      levels: this.levels,
    });
  }

  async #handle(obj) {
    const m = new Msg(obj.seq ?? 0, obj.msg ?? {});
    try {
      let handled = false;
      const hit = m.isCommand ? this.commands.get(m.command) : null;
      if (hit) {
        await hit.fn(m);
        handled = true;
      } else {
        for (const fn of this.listeners) {
          if ((await fn(m)) === true) {
            handled = true;
            break;
          }
        }
      }
      if (handled) send({ t: 'handled', seq: m.seq });
    } catch (e) {
      // 异常必须回给核心，否则它只能干等超时
      send({ t: 'log', level: 'error', msg: e?.stack || e.message });
      send({ t: 'error', seq: m.seq, msg: '插件处理消息时出错，详见日志' });
    }
  }
}
