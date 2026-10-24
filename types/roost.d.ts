/**
 * 栖 Roost 插件类型声明
 * ======================
 *
 * 不是构建依赖，纯粹给编辑器的：VS Code 打开插件目录就会有补全和参数提示，
 * 不用一遍遍翻文档。
 *
 * 用法——在 setup 上面写一行 JSDoc 标注参数类型即可：
 *
 *   在 setup(ctx) 的上方写：  @param {RoostCtx} ctx
 *
 * （照抄 docs/插件开发规范.md §2 的示例即可，那里是完整写法。）
 *
 * `jsconfig.json` 已经把 `plugins/**` 和本文件纳入范围，`checkJs` 是关的：
 * **只给补全，不报错**。零依赖、零构建，删掉这个目录也不影响运行。
 */

/** 权限等级：数字越小权限越高 */
declare type RoostLevel = number;

/** 插件私有的键值存储，落盘到 data/bots/<机器人id>/plugins/<插件id>.json */
declare interface RoostStorage {
  /** 读一个键，不存在时返回默认值 */
  get<T = any>(key: string, fallback?: T): Promise<T>;
  /** 写一个键（300ms 防抖落盘） */
  set(key: string, value: any): Promise<void>;
  /** 删一个键 */
  delete(key: string): Promise<boolean>;
  /** 是否有这个键 */
  has(key: string): Promise<boolean>;
  /** 全部键值 */
  all(): Promise<Record<string, any>>;
  /** 所有键 */
  keys(): Promise<string[]>;
  /** 清空 */
  clear(): Promise<void>;
}

/** 日志：自动带上「机器人 + 插件」前缀，按级别过滤 */
declare interface RoostLogger {
  debug(...args: any[]): void;
  info(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

/** Markdown 与消息内交互标签的构造工具 */
declare interface RoostMd {
  /** 点了把指令插进输入框（群聊可用） */
  cmdInput(cmd: string, text: string): string;
  /** 点了直接发（群聊不支持，单聊/频道用） */
  cmdEnter(cmd: string): string;
  /** 转义用户输入，防止破坏排版 */
  esc(text: string): string;
  /** 构造按钮 keyboard 结构 */
  keyboard?(rows: any[][]): any;
}

/** 收到的消息。插件只跟它打交道，不用管官方报文长什么样 */
declare interface RoostMsg {
  /** 消息 id */
  id: string;
  /** 场景：group / c2c / guild / dm */
  kind: 'group' | 'c2c' | 'guild' | 'dm' | 'unknown';
  /** 原始事件名，如 GROUP_AT_MESSAGE_CREATE */
  event: string;
  /** 群 openid（群聊）或频道 id（频道） */
  groupId: string;
  /** 发送者 openid */
  userId: string;
  /** 发送者昵称，频道事件可能为空 */
  userName: string;
  /** 会话 id：有群就是群，没有就是人 */
  chatId: string;
  /** 去掉 @ 之后的正文字 */
  content: string;
  /** 命令名（不含前缀），非命令时为空 */
  command: string;
  /** 命令参数（按空白切分） */
  args: string[];
  /** 是否以命令前缀开头 */
  isCommand: boolean;
  /** 是否 @ 了机器人 */
  mentioned: boolean;
  /** 是否处在免@窗口内 */
  addressed: boolean;
  /** 收到时间戳（毫秒） */
  receivedAt: number;
  /** 内核是否已判定「有人处理过这条消息」 */
  replied: boolean;

  /** 被动回复。不立刻发，攒到本次处理结束合并成一条 */
  reply(text: string, opts?: any): Promise<any>;
  /** 绕过合并，立刻发一条 */
  replyNow(text: string, opts?: any): Promise<any>;
  /** 主动推送（不带 msg_id，受每日额度限制） */
  push(text: string, opts?: any): Promise<any>;
  /** 把攒下的回复发出去 */
  flushReplies(): Promise<any>;
  /** Markdown 消息，可带按钮 */
  replyMarkdown(markdown: { content: string }, keyboard?: any): Promise<any>;
  /** 带可点击指令的菜单 */
  replyMenu(
    title: string,
    groups: Array<{ title: string; items: Array<{ text: string; desc?: string; cmd?: string }> }>,
    opts?: { keyboard?: any },
  ): Promise<any>;
  /** 模板消息：正文 + 按钮 + ark 一次发出 */
  replyCard(card: { markdown?: any; keyboard?: any; ark?: any }): Promise<any>;
  /** 发图片（URL；传 { local: true } 则按本地路径） */
  replyImage(src: string, opts?: { local?: boolean }): Promise<any>;
  replyVideo(src: string, opts?: { local?: boolean }): Promise<any>;
  replyVoice(src: string, opts?: { local?: boolean }): Promise<any>;
  replyFile(src: string, opts?: { local?: boolean }): Promise<any>;
  /** 发内存里的图片（渲染类插件用） */
  replyImageBuffer(buf: Uint8Array | ArrayBuffer, opts?: any): Promise<any>;
  /** 流式回复，仅单聊 */
  replyStream(opts?: any): { push(text: string): Promise<any>; end(text?: string): Promise<any> };
}

/** 命令注册选项 */
declare interface RoostCommandOpts {
  /** 命令说明，会出现在 /help 菜单里 */
  desc?: string;
  /** 别名 */
  alias?: string[];
  /** 冷却秒数 */
  cooldown?: number;
  /** 需要的权限等级 */
  level?: RoostLevel;
}

/** 菜单分组里的一条 */
declare interface RoostMenuItem {
  text: string;
  desc?: string;
  cmd?: string;
}

/** 插件默认导出 */
declare interface RoostPlugin {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  shortDesc?: string;
  icon?: string;
  repo?: string;
  /** 需要的框架版本范围，如 '>=0.5.0' */
  frameworkVersion?: string;
  supportPlatforms?: string[];
  /** 默认配置，面板据此生成表单 */
  config?: Record<string, any>;
  /** 加载时调用一次 */
  setup(ctx: RoostCtx): void | Promise<void>;
  /** 卸载时调用 */
  teardown?(ctx: RoostCtx): void | Promise<void>;
  /** 面板「运行数据」：每次现算（也可以改用 ctx.setDashboard） */
  dashboard?(): any;
}

/** 插件拿到的上下文 */
declare interface RoostCtx {
  /** 插件 id（等于目录名） */
  id: string;
  /** 显示名 */
  name: string;
  /** 版本号 */
  version: string;
  /** 已与默认值合并的用户配置 */
  config: Record<string, any>;
  /** 命令前缀，默认 '/' */
  prefix: string;
  logger: RoostLogger;
  storage: RoostStorage;
  /**
   * 插件自己的内存状态，**跨热重载保留**（模块顶层变量会丢）。
   * 要跨重启请用 storage。
   */
  state: Record<string, any>;
  md: RoostMd;
  /** 官方 HTTP API（禁言、撤回、发消息…） */
  api: any;

  /** 注册命令。模式里的 `[可选]` `<必填>` 只是提示，实际用 msg.args 取 */
  command(pattern: string, opts: RoostCommandOpts, handler: (msg: RoostMsg) => any): void;
  /** 监听事件：'message' / 'notice' / 官方事件名 */
  on(event: string, handler: (data: any, meta?: any) => any): void;
  /** 往 /help 菜单加一组 */
  menu(title: string, items: RoostMenuItem[]): void;

  /** 定时任务，插件卸载时自动清理 */
  schedule(name: string, everyMs: number, fn: () => any): void;
  /** 卸载时的额外清理 */
  onTeardown(fn: () => any): void;

  /** 问一句等回答 */
  prompt(msg: RoostMsg, text: string, opts?: { timeoutMs?: number }): Promise<string | null>;
  /** 等下一条消息（不主动发问） */
  wait(msg: RoostMsg, opts?: { timeoutMs?: number }): Promise<RoostMsg | null>;
  /** 取消等待 */
  cancelWait(msg: RoostMsg): void;

  /** 主动推送到某个会话 */
  push(chatId: string, text: string, opts?: { kind?: 'group' | 'c2c' }): Promise<any>;
  /** 这个会话今天还剩多少主动消息额度 */
  quotaLeft(chatId: string, kind?: 'group' | 'c2c'): Promise<number>;
  /** 是否处在免@窗口内 */
  isSticky(chatId: string): boolean;

  /** 注册中间件 */
  use(name: string, fn: (payload: any, next: () => any) => any): void;

  /** 面板「运行数据」：推一份指标，面板轮询显示 */
  setDashboard(data: {
    metrics?: Array<{ label: string; value: any; unit?: string; hint?: string }>;
    note?: string;
  }): any;
  getDashboard(): any;

  /** 改自己的配置并立刻落盘 */
  setConfig(patch: Record<string, any>): Promise<Record<string, any>>;

  /** 注册一个面板页面 */
  registerPage(page: { key: string; label: string; html: string }): string | null;

  /* ---------------- 权限 ---------------- */

  /** 内核保留等级（只读） */
  CORE_LEVELS: Record<string, RoostLevel>;
  /** 本插件分到的号段起点 */
  levelBase: number;
  /** 本插件可用号段 */
  levelRange: { base: number; end: number };
  /** 号段内的偏移 → 绝对等级 */
  level(offset?: number): RoostLevel;
  /** 按名字定义本插件的等级，返回「名字 → 绝对等级」 */
  defineLevels(map: Record<string, number>): Record<string, RoostLevel>;
  /** 是否主人 */
  isOwner(userId: string): boolean;
  /** 某人在某作用域的等级 */
  levelOf(msg: RoostMsg, scope?: string): Promise<RoostLevel>;
  /** 够不够某个等级 */
  can(msg: RoostMsg, need?: RoostLevel | string): Promise<boolean>;
  /** 这条消息属于哪个作用域 */
  scopeOf(msg: RoostMsg): string;
  /** 是不是群管理员（会预检机器人权限，带缓存） */
  isGroupAdmin(groupOpenid: string, userId: string): Promise<boolean>;
  /** 群档案 */
  getGroup(groupOpenid: string): Promise<any>;
}
