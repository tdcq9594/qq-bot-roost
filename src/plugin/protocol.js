/**
 * 外部插件协议 v1
 * =================
 * 传输：子进程的 stdin / stdout，**一行一个 JSON**（NDJSON）。
 * 任何语言只要能读标准输入、写标准输出，就能写插件。
 *
 * 核心 → 插件
 *   {"t":"init", ...}      启动时下发一次，插件应回 {"t":"ready", ...}
 *   {"t":"msg",  "seq":1, "msg":{...}}   有消息要处理
 *   {"t":"shutdown"}       准备退出，插件应尽快结束
 *
 * 插件 → 核心
 *   {"t":"ready","commands":[...],"menus":[...],"levels":[...]}
 *   {"t":"reply","seq":1,"text":"..."}   回复到当前会话（被动回复）
 *   {"t":"reply","seq":1,"image":"https://..."}
 *   {"t":"push","seq":1,"text":"..."}    主动推送（不带 msg_id）
 *   {"t":"handled","seq":1}              这条消息我处理完了
 *   {"t":"log","level":"info","msg":"..."}
 *   {"t":"error","msg":"..."}
 *
 * 约定
 *   - 插件必须对每个 msg 回 `handled`，否则核心会在空闲超时后继续
 *   - 一个 msg 可以发多条 reply（分段回复），发完再发 handled
 *   - stdout 只能写协议 JSON；调试输出请写 stderr
 */

export const PROTOCOL_VERSION = 1;

/** 默认超时（毫秒） */
export const DEFAULTS = {
  readyTimeout: 10000, // 等 ready 的最长时间
  msgTimeout: 15000, // 单条消息最长处理时间
  idleTimeout: 400, // 收到 reply 后，多久没新消息算结束
  restartLimit: 3, // 每分钟最多重启几次
};

/** 把内部 Message 压成可序列化的纯对象 */
export function serializeMessage(msg, extra = {}) {
  return {
    id: msg.id,
    // 外部插件也要能拿到，否则「任意语言插件」这条路上链路就断了
    trace: msg.traceId ?? '',
    kind: msg.kind,
    group: msg.groupId || '',
    user: msg.userId || '',
    name: msg.userName || '',
    content: msg.content ?? '',
    raw: String(msg.raw?.content ?? ''),
    command: msg.command || '',
    args: msg.args ?? [],
    mentioned: Boolean(msg.mentioned),
    isCommand: Boolean(msg.isCommand),
    at: msg.at ?? Date.now(),
    ...extra,
  };
}

/** 解析一行，返回对象或 null */
export function parseLine(line) {
  const s = String(line).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
