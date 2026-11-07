/**
 * 图文回复「自动选出口」的解析与判定层（**框架通用能力，任何插件都能用**）。
 *
 * 这一层全是**纯函数**，不发请求、不读文件，方便单测覆盖。
 * 发送在 `message.js` 的 `msg.replyAuto()`，上传在 `api.js`。
 *
 * 调用方不必是 AI 插件：指令回复、抽卡结果、图鉴、天气卡片等任意插件，
 * 只要把正文写成标准 markdown，框架就会按内容形态挑最合适的出口。
 * AI 只是第一个接进来的消费者（表情包场景），不是这个能力的前提。
 *
 * 模型侧用哪套语法**不归这一层管**：AI 插件把模型写的标记换成标准 markdown
 * 再交进来（`<<image: 路径>>` → `![](路径)`），框架只认 markdown，
 * 免得把「模型协议」和「框架能力」绑死。
 *
 * 设计边界（交接 §4）：
 *   · 图片语法**只有**标准 `![alt](路径)` 一种；
 *   · 只有「图片两侧都有非空文字」才需要把本地图换成 `qqbot-media://`；
 *   · 图在前 / 图在末尾 / 只有一张图，一律走原来的 `msg_type=7`；
 *   · 框架**不做路径白名单**：调用方是插件代码（可信），给什么路径就发什么图；
 *     不可信输入（模型输出）由调用方自己把关。
 */
import { mdToPlain } from './markdown.js';

/** 图片节点只认标准 markdown 图片（模型侧标记由 ai-chat 转换后再进来） */
const IMAGE_NODE_RE = /!\[([^\]]*)\]\(([^)]*)\)/gi;

/** 带 scheme 的算远程引用（含 qqbot-media://），其余一律当本地路径 */
const REMOTE_SRC_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** 判定表里「这段是 markdown 而不是纯文本」的依据 */
const MD_BLOCK_RE = /^[ \t]{0,3}(#{1,6}[ \t]|>[ \t]?|[-*+][ \t]|\d+\.[ \t]|\|)/m;
const MD_INLINE_RE = /\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|<qqbot-[^>\n]+>|\[[^\]\n]+\]\([^)\n]+\)/;

/**
 * 降级时放在「原本图片位置」的提示文案。
 *
 * 一律用**预告式**措辞，不宣称「已经单独发成功」：
 * 定稿要求「含提示的文本先发、独立图紧跟」，文本发出时独立图还没发，
 * 此时无法知道它的真实结果。写「已单独发送」会变成「说成功但图消失」。
 * 真实结果（成功 / 明确失败 / 不确定）走日志与 `onResult` 回调。
 */
export const DEFAULT_FALLBACK_HINTS = Object.freeze({
  oversize: '（这张图太大，没能放进同一条，下面会单独发这张图）',
  /**
   * `bad_format` 与 `outside` 一样写「已跳过」而不是「下面单独发」：
   * 这两种原因在 `message.js` 里被剔除出补发队列，说了要发却没发就是谎报。
   */
  bad_format: '（这张图格式不支持，已跳过）',
  quota: '（图片素材配额不足，没能放进同一条，下面会单独发这张图）',
  task_expired: '（图片上传任务已过期，没能放进同一条，下面会单独发这张图）',
  outside: '（这张图读不到，已跳过）',
  network: '（图片上传未完成，没能放进同一条，下面会单独发这张图）',
  internal: '（图片上传未完成，没能放进同一条，下面会单独发这张图）',
  default: '（这张图没能放进同一条，下面会单独发这张图）',
});

/** 官方素材图床错误码 → 内部降级原因 */
const QQ_REASON = {
  40035001: 'bad_format',
  40035002: 'oversize',
  40035003: 'task_expired',
  40035006: 'internal',
  40035007: 'quota',
  40035008: 'internal',
  40035009: 'internal',
  40035010: 'internal',
};

export function hintForReason(reason, overrides = {}) {
  return String(overrides[reason] ?? DEFAULT_FALLBACK_HINTS[reason] ?? DEFAULT_FALLBACK_HINTS.default);
}

/** 把预上传失败归类，供文案与日志使用（纯函数，便于断言） */
export function classifyUploadFailure(e) {
  if (e?.reason) return String(e.reason);
  const byCode = QQ_REASON[Number(e?.qqCode)];
  if (byCode) return byCode;
  /**
   * 裸 PUT 的 403 **不算 `bad_format`**。
   *
   * `api.js` 里写明了这个 403 的来源：`Content-Type` 与 prepare 声明的
   * `content_type` 不一致（COS 侧拒绝签名）。图片本身是好的——归成
   * `bad_format` 会被剔出补发队列（那是「图本身用不了」才享受的待遇），
   * 用户白白丢一张本来能发的图，文案还会谎称「格式不支持」。
   * 落到 `internal`：提示「上传未完成」，再用 `/files` 那条通道补发一次。
   */
  if (/超时|TimeoutError|网络错误|ECONN|fetch failed/i.test(String(e?.message))) return 'network';
  if (/ENOENT|EACCES|目录|路径/.test(String(e?.message))) return 'outside';
  return 'internal';
}

/**
 * 正文里是否含**本地图片**节点（用于 replyMarkdown 决定是否允许纯文本降级）。
 *
 * 只有本地图才需要禁降级：mdToPlain 会把 `![alt](C:/…)` 展开成本地绝对路径。
 * 公网图降级成纯文本只会露出 URL，旧版本本来就是这么兜底的，不该被新代码挡掉。
 * 半截文本（正文里聊到图片语法但没写完整）解析不出节点，也就不会误关降级。
 */
export function hasLocalImageNode(text) {
  return parseReplyNodes(String(text ?? '')).some((n) => n.type === 'image' && n.kind === 'local');
}

/**
 * 把正文切成有序节点流。
 *
 * 图片括号里允许空格（表情包文件名常带空格），所以 URL 位用 `[^)]*`
 * 而不是 markdown.js 里那个 `[^)\s]+`；这也是为什么降级必须**先在节点层
 * 替换图片、再做 mdToPlain** —— 后者会把 `![笑](C:/…)` 展开成明文路径。
 *
 * @returns {Array<{type:'text',value:string}|{type:'image',alt:string,src:string,raw:string,kind:'local'|'remote'}>}
 */
export function parseReplyNodes(content) {
  const s = String(content ?? '');
  const nodes = [];
  let last = 0;
  for (const m of s.matchAll(IMAGE_NODE_RE)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push({ type: 'text', value: s.slice(last, at) });
    const src = String(m[2] ?? '').trim();
    nodes.push({
      type: 'image',
      alt: String(m[1] ?? ''),
      src,
      raw: m[0],
      kind: REMOTE_SRC_RE.test(src) ? 'remote' : 'local',
    });
    last = at + m[0].length;
  }
  if (last < s.length) nodes.push({ type: 'text', value: s.slice(last) });
  return nodes;
}

/** 文字块里是否含 markdown 结构（标题 / 列表 / 引用 / 表格 / 强调 / 链接 / 交互标签） */
export function hasMarkdownSyntax(text) {
  const s = String(text ?? '');
  return MD_BLOCK_RE.test(s) || MD_INLINE_RE.test(s);
}

const hasText = (list) => list.some((n) => n.type === 'text' && n.value.trim());

/**
 * 判定表（交接 §4.2）。返回：
 *   mode    plain | markdown | media | media-text
 *   upload  markdown 出口下是否需要预上传本地图
 *
 * 「图片在中间」= 存在某个图片节点，其**之前和之后**都还有非空文字。
 * 这是唯一触发预上传的排列；出口已是 markdown（标题/列表/公网图）时，
 * 同一条里的本地图也必须换引用，否则本地路径会明文漏给用户。
 */
export function decideReplyMode(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const images = list.filter((n) => n.type === 'image');
  const remote = images.filter((n) => n.kind === 'remote');
  const local = images.filter((n) => n.kind === 'local');
  const markdown = list.some((n) => n.type === 'text' && hasMarkdownSyntax(n.value));
  const text = list.filter((n) => n.type === 'text').map((n) => n.value).join('');
  const base = { markdown, images, local, remote, text };

  if (!images.length) return { ...base, mode: markdown ? 'markdown' : 'plain', upload: false };

  // 只有一张本地图、没有别的文字 → 独立发图（原路），不碰素材图床
  if (local.length === 1 && remote.length === 0 && !hasText(list) && !markdown) {
    return { ...base, mode: 'media', upload: false };
  }

  const inMiddle = list.some(
    (n, i) => n.type === 'image' && hasText(list.slice(0, i)) && hasText(list.slice(i + 1)),
  );
  const markdownExit = inMiddle || remote.length > 0 || markdown;
  if (!markdownExit) return { ...base, mode: 'media-text', upload: false };
  return { ...base, mode: 'markdown', upload: local.length > 0 };
}

/** 用上传后的引用替换图片节点的路径；alt（含 #宽px #高px）原样保留 */
export function renderReplyMarkdown(nodes, replacements = new Map()) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((n) => {
      if (n.type === 'text') return n.value;
      const url = replacements.get(n.src) || n.src;
      return `![${n.alt ?? ''}](${url})`;
    })
    .join('');
}

/**
 * 降级正文：图片节点**原位**换成提示文本，位置不动。
 *
 * · 本地图 → 提示文案（越界的图只提示、不进独立发图队列，由 hintFor 决定）
 * · 远程图 → 保留原 markdown 语法，因此整条仍走 `msg_type=2`
 * · 无远程图时走 `msg_type=0`，文字块过 mdToPlain 去掉标题/加粗标记
 *
 * 关键顺序：**先节点替换，再 mdToPlain**。顺序反了，mdToPlain 的链接规则
 * 会把 `![alt](C:/…)` 展开成 `!alt（C:/…）`，把本地绝对路径发给用户。
 */
export function renderFallback(nodes, hintFor = () => DEFAULT_FALLBACK_HINTS.default) {
  const list = Array.isArray(nodes) ? nodes : [];
  const hasRemote = list.some((n) => n.type === 'image' && n.kind === 'remote');
  const parts = list.map((n) => {
    if (n.type === 'image') {
      if (n.kind === 'remote') return `![${n.alt ?? ''}](${n.src})`;
      return String(hintFor(n) ?? '');
    }
    if (hasRemote) return n.value;
    const plain = mdToPlain(n.value);
    const lead = /^\s*\n/.test(n.value) ? '\n' : '';
    const tail = /\n\s*$/.test(n.value) ? '\n' : '';
    return lead + plain + tail;
  });
  return { content: parts.join('').trim(), msgType: hasRemote ? 2 : 0 };
}
