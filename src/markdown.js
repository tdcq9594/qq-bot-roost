/**
 * Markdown 与消息内交互标签的构造工具
 * ======================================
 * 官方文档：
 *   文本交互 https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html
 *   Markdown https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/type/markdown.html
 *
 * 几个必须记住的平台限制：
 *   1. `<qqbot-cmd-input>` / `<qqbot-cmd-enter>` **只能在 markdown 消息里用**，
 *      普通文本消息里会被当成纯文字显示。
 *   2. `cmd-enter`（点了直接发）**群聊不支持**，只有单聊和频道能用；
 *      `cmd-input`（点了插入输入框）群聊可用，是群聊场景的正确选择。
 *   3. `text` 参数必须 **urlencode**，且最长 100 字符。
 *   4. markdown 不支持表格，也不支持 HTML。
 */

/** 参数值必须 urlencode，官方要求 */
const enc = (s) => encodeURIComponent(String(s ?? ''));

/**
 * 转义用户可控的文本，避免里面的 * _ ~ ` 破坏行内排版。
 * 只转这几个——把 [ ] < > 也转掉会让「用法 /admin set <openid>」变成
 * 「<openid\>」，反而更难看，而且它们在纯文本里本来也不会生效。
 */
export function escMd(s) {
  return String(s ?? '').replace(/([\\`*_~])/g, '\\$1');
}

export const md = {
  esc: escMd,

  /**
   * 参数指令：点击后把 text 插入输入框，用户自己按发送。
   * **群聊唯一可用的交互标签**，做「点一下就能用」的菜单靠它。
   *
   * @param {string} text 点击后插入输入框的内容，如 '/签到'
   * @param {string} [show] 消息里显示的标签文字，默认同 text
   */
  cmdInput(text, show) {
    const t = String(text ?? '').slice(0, 100);
    const s = String(show ?? text ?? '').slice(0, 100);
    return `<qqbot-cmd-input text="${enc(t)}" show="${enc(s)}" />`;
  },

  /**
   * 回车指令：点击后直接发送，不用用户再按一次。
   * **群聊不支持**，会退化成纯文本，别在群聊菜单里用。
   *
   * @param {string} text 点击后直接发送的内容
   */
  cmdEnter(text) {
    return `<qqbot-cmd-enter text="${enc(String(text ?? '').slice(0, 100))}" />`;
  },

  /** @某人 */
  at(uid) {
    return `<qqbot-at-user id="${String(uid ?? '')}" />`;
  },

  /** 水平分割线 */
  hr() {
    return '***';
  },

  /** 把多行文本转成 markdown 引用块 */
  quote(text) {
    return String(text ?? '')
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
  },
};

/**
 * 把 markdown 消息降级成纯文本。
 *
 * 为什么需要：群机器人发 markdown 要平台放行，没权限 / 内容被判不合规时接口
 * 直接返回 400，而 markdown 是**独立消息类型**、没有纯文本兜底——不发就等于
 * 用户点了菜单什么也看不到。所有 `ctx.menu()` 出来的东西都走这条路，所以降级
 * 不能只打日志。
 *
 * 降级顺序有讲究：交互标签里带 `=` 和引号，必须先换成它显示的文字，
 * 否则后面剥标签的正则会把它啃成半截。
 *
 * @param {string|{content?:string}} src markdown 正文，或 `{ content }` 对象
 * @returns {string} 尽量保留信息量的纯文本
 */
export function mdToPlain(src) {
  let s = typeof src === 'string' ? src : String(src?.content ?? '');
  if (!s) return '';

  /** 从标签里取属性值并解码（官方要求 urlencode） */
  const attr = (tag, name) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag);
    if (!m) return '';
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  };

  // 1) 交互标签 → 它显示的文字（群聊用 show，缺了退回 text）
  s = s.replace(/<qqbot-cmd-input\b[^>]*>/gi, (tag) => attr(tag, 'show') || attr(tag, 'text'));
  s = s.replace(/<qqbot-cmd-enter\b[^>]*>/gi, (tag) => attr(tag, 'text'));
  // 2) @ 人：纯文本里没有 id 对应的昵称，留个 @ 比留一串 openid 强
  s = s.replace(/<qqbot-at-user\b[^>]*>/gi, '@');
  // 3) 其他标签一律剥掉
  s = s.replace(/<[^>\n]{1,200}>/g, '');

  // 4) 链接 [文字](地址) → 文字（地址）；文字和地址一样就只留一份
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, text, url) =>
    !text || text === url ? url : `${text}（${url}）`,
  );

  // 5) 分割线要在剥加粗之前处理，否则 *** 会被当成加粗
  s = s.replace(/^[ \t]*(\*[ \t]*){3,}$/gm, '———');
  s = s.replace(/^[ \t]*(-[ \t]*){3,}$/gm, '———');
  s = s.replace(/^[ \t]*(_[ \t]*){3,}$/gm, '———');

  // 6) 强调标记
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2');
  s = s.replace(/(^|[^\w_])_([^_\n]+)_(?=[^\w_]|$)/g, '$1$2');
  s = s.replace(/~~([^~\n]+)~~/g, '$1');
  s = s.replace(/`{1,3}([^`]*)`{1,3}/g, '$1');

  // 7) 标题、引用符号
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');

  // 8) 还原 escMd 的转义
  s = s.replace(/\\([\\`*_~])/g, '$1');

  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把「分组菜单」渲染成带可点击指令的 markdown。
 *
 * @param {string} title 大标题
 * @param {Array<{title:string, items:Array<{text:string, desc?:string, cmd?:string|null}>}>} groups
 *        `cmd: null` 表示这不是命令（比如被动触发的玩法），只显示文字、不做成可点击
 * @param {object} [opts]
 * @param {'group'|'c2c'|'guild'} [opts.kind] 会话类型，决定用哪种交互标签
 * @returns {string}
 */
export function renderMenuMd(title, groups, { kind = 'group' } = {}) {
  const lines = [`# ${escMd(title)}`];

  for (const g of groups ?? []) {
    if (!g?.items?.length) continue;
    lines.push('');
    lines.push(`## ${escMd(g.title)}`);
    for (const it of g.items) {
      if (it.cmd === null) {
        // 非命令项（被动触发的关键词等），不做成可点击
        lines.push(`- ${escMd(it.text)}${it.desc ? ` · ${it.desc}` : ''}`);
        continue;
      }
      const cmd = it.cmd ?? `/${it.text}`;
      // 群聊只有 cmd-input 可用；单聊/频道才有 cmd-enter（点了直接发）
      const tag = kind === 'group' ? md.cmdInput(cmd, it.text) : md.cmdEnter(cmd);
      // desc 不转义：插件会往里塞反引号包起来的用法示例，转义了反而坏掉
      lines.push(`- ${tag}${it.desc ? ` ${it.desc}` : ''}`);
    }
  }
  return lines.join('\n');
}
