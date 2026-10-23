/**
 * dsh-roost —— 在 DeepSeek Harness 里管理 栖 Roost QQ 机器人
 * =========================================================
 *
 * 栖 Roost 是一个独立跑着的进程（连 QQ 网关、跑插件）。这个插件不把
 * Roost 塞进 DSH 进程，而是通过 Roost 面板的 REST API 跟它对话：
 *
 *     DSH（AI 调用工具）──HTTP──> Roost 面板 :15207 ──> 机器人
 *
 * 所以前提是 **Roost 正在运行**。没运行的话工具会返回一句人话提示，
 * 而不是一堆 ECONNREFUSED。
 *
 * 工具分两类：
 *   只读 —— 查状态 / 插件列表 / 日志，标了 isConcurrencySafe，可以并发
 *   写操作 —— 启停插件 / 发消息 / 重连，会改真实状态，描述里写清了后果
 *
 * 零依赖：只用 Node 内置的 fetch。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-roost';

/** 这个插件只用到工具注册这一个服务，别的都不依赖 */
export const inject = ['tools'];

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/**
 * 配置由 cordis.patch.yml 提供，schema 默认值在这里兜底。
 * 不引 schemastery —— 我们的字段少，手写校验更省事，也少一个 peer 依赖。
 */
function readConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const baseUrl = String(c.baseUrl || 'http://127.0.0.1:15207').replace(/\/+$/, '');
  const accessKey = String(c.accessKey || '');
  return { baseUrl, accessKey };
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端                                                         */
/* ------------------------------------------------------------------ */

function createClient(cfg) {
  const { baseUrl, accessKey } = cfg;

  async function request(method, path, body, signal) {
    const headers = {};
    if (accessKey) headers['X-Access-Key'] = accessKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(15000),
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!res.ok) {
      const msg = data?.error || data?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  return { request, baseUrl };
}

/**
 * 把网络异常翻译成人话。
 *
 * AI 看到 "fetch failed" 只会瞎猜，看到「Roost 没在运行」才能给出正确建议。
 */
function explain(err, baseUrl) {
  const msg = String(err?.message || err || '未知错误');
  if (/ECONNREFUSED|fetch failed|ECONNRESET|socket hang up/i.test(msg)) {
    return `连不上 ${baseUrl}。栖 Roost 可能没在运行，或者面板端口不是这个（启动日志里有真实端口）。`;
  }
  if (/timeout|aborted/i.test(msg)) {
    return `${baseUrl} 响应超时。进程可能卡住了，去面板看日志。`;
  }
  if (/401|403|access key|AccessKey/i.test(msg)) {
    return `面板访问密钥不对。检查 config/bot.json 里的 webui.accessKey，填进本插件的 accessKey。`;
  }
  return msg;
}

/* ------------------------------------------------------------------ */
/* 工具定义的小工具                                                    */
/* ------------------------------------------------------------------ */

/** 所有工具共用的错误结构，和成功结构并列成 oneOf */
const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: { type: 'string', required: true },
  },
};

/** 出错时统一返回这个，而不是抛异常——让 AI 看到原因 */
const fail = (error) => ({ ok: false, error });

/** 只读工具：并发安全 */
const isConcurrencySafe = () => true;

/* ------------------------------------------------------------------ */
/* 工具：查状态                                                        */
/* ------------------------------------------------------------------ */

function roostStatusTool(client) {
  return defineTool({
    name: 'roost_status',
    description:
      '查看栖 Roost QQ 机器人的运行状态：是否在线、收发消息数、重连次数、已加载插件数、'
      + '凭证剩余有效期、面板版本。排查「机器人没反应」时先调这个。',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              botName: { type: 'string', required: true },
              state: { type: 'string', required: true },
              online: { type: 'boolean', required: true },
              received: { type: 'integer', required: true },
              sent: { type: 'integer', required: true },
              reconnects: { type: 'integer', required: true },
              plugins: { type: 'integer', required: true },
              credentialExpiresIn: { type: 'integer', required: true },
              version: { type: 'string', required: true },
              uptime: { type: 'string', required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: v.error }];
        return [
          {
            type: 'text',
            text:
              `${v.botName} · ${v.state}（${v.online ? '已连接网关' : '未连接'}）\n`
              + `收 ${v.received} 条 / 发 ${v.sent} 条 · 重连 ${v.reconnects} 次\n`
              + `插件 ${v.plugins} 个 · 已运行 ${v.uptime}\n`
              + `凭证剩余 ${v.credentialExpiresIn} 秒 · 版本 v${v.version}`,
          },
        ];
      },
    },
    isConcurrencySafe,
    async execute(_args, exec) {
      try {
        const s = await client.request('GET', '/api/status', undefined, exec?.signal);
        const counters = s.counters ?? {};
        return {
          ok: true,
          botName: String(s.botName ?? s.botId ?? '未知'),
          state: String(s.state ?? 'unknown'),
          online: Boolean(s.connected),
          received: Number(counters.received ?? 0),
          sent: Number(counters.sent ?? 0),
          reconnects: Number(s.reconnectCount ?? 0),
          plugins: Array.isArray(s.plugins) ? s.plugins.length : 0,
          credentialExpiresIn: Number(s.credentialExpiresIn ?? 0),
          version: String(s.version ?? ''),
          uptime: fmtDuration(Number(s.uptimeMs ?? 0)),
        };
      } catch (e) {
        return fail(explain(e, client.baseUrl));
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：插件列表                                                      */
/* ------------------------------------------------------------------ */

function roostPluginsTool(client) {
  return defineTool({
    name: 'roost_plugins',
    description:
      '列出栖 Roost 已安装的插件，以及每个插件是否启用、是否加载成功、有没有报错。'
      + '排查「插件不生效」时调这个——enabled 但没 loaded 通常意味着加载失败，看 error 字段。',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              total: { type: 'integer', required: true },
              enabled: { type: 'integer', required: true },
              loaded: { type: 'integer', required: true },
              plugins: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    version: { type: 'string', required: true },
                    enabled: { type: 'boolean', required: true },
                    loaded: { type: 'boolean', required: true },
                    kind: { type: 'string', required: true },
                    error: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: v.error }];
        if (!v.plugins.length) return [{ type: 'text', text: '一个插件都没装。' }];
        const lines = v.plugins.map((p) => {
          const mark = p.loaded ? '运行中' : p.enabled ? '未加载' : '已禁用';
          const err = p.error ? `\n    错误：${p.error}` : '';
          return `  ${p.id} v${p.version} · ${mark} · ${p.kind}${err}`;
        });
        return [
          {
            type: 'text',
            text: `共 ${v.total} 个，启用 ${v.enabled} 个，已加载 ${v.loaded} 个\n${lines.join('\n')}`,
          },
        ];
      },
    },
    isConcurrencySafe,
    async execute(_args, exec) {
      try {
        const list = await client.request('GET', '/api/plugins', undefined, exec?.signal);
        const arr = Array.isArray(list) ? list : [];
        return {
          ok: true,
          total: arr.length,
          enabled: arr.filter((p) => p.enabled).length,
          loaded: arr.filter((p) => p.loaded).length,
          plugins: arr.map((p) => ({
            id: String(p.id ?? ''),
            name: String(p.name ?? p.id ?? ''),
            version: String(p.version ?? '0.0.0'),
            enabled: Boolean(p.enabled),
            loaded: Boolean(p.loaded),
            kind: String(p.kind ?? 'internal'),
            error: String(p.error ?? ''),
          })),
        };
      } catch (e) {
        return fail(explain(e, client.baseUrl));
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：最近日志                                                      */
/* ------------------------------------------------------------------ */

function roostLogsTool(client) {
  return defineTool({
    name: 'roost_logs',
    description:
      '读栖 Roost 最近的运行日志。可以按级别过滤（error/warn 只留问题）。'
      + '机器人收不到消息、插件报错、连接异常，答案基本都在这里。',
    parameters: {
      level: {
        type: 'string',
        description: '只看某个级别及以上：debug / info / warn / error。留空看全部。',
      },
      limit: { type: 'integer', description: '返回多少条，默认 50，最多 200。' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              count: { type: 'integer', required: true },
              lines: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: (_args, v) => {
        if (!v.ok) return [{ type: 'text', text: v.error }];
        if (!v.lines.length) return [{ type: 'text', text: '没有匹配的日志。' }];
        return [{ type: 'text', text: v.lines.join('\n') }];
      },
    },
    isConcurrencySafe,
    async execute(args, exec) {
      const limit = Math.min(Math.max(Number(args?.limit ?? 50) || 50, 1), 200);
      try {
        const d = await client.request('GET', `/api/logs?limit=${limit}`, undefined, exec?.signal);
        // 面板返回 { lines: [...] } 或直接数组，两种都兜住
        const raw = Array.isArray(d) ? d : Array.isArray(d?.lines) ? d.lines : [];
        const want = String(args?.level ?? '').toLowerCase();
        const rank = { debug: 0, info: 1, warn: 2, error: 3 };
        const min = rank[want] ?? -1;

        const lines = raw
          .map((l) => (typeof l === 'string' ? l : formatLogLine(l)))
          .filter((l) => {
            if (min < 0) return true;
            const m = l.match(/\b(DEBUG|INFO|WARN|ERROR)\b/);
            return m ? rank[m[1].toLowerCase()] >= min : true;
          });

        return { ok: true, count: lines.length, lines };
      } catch (e) {
        return fail(explain(e, client.baseUrl));
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：启停插件（写）                                                */
/* ------------------------------------------------------------------ */

function roostPluginToggleTool(client) {
  return defineTool({
    name: 'roost_plugin_toggle',
    description:
      '启用或禁用一个栖 Roost 插件。**会立即生效并写回配置**：禁用会卸载正在跑的插件，'
      + '它的命令立刻不可用；启用会加载插件。做之前先说清要动哪个插件。',
    parameters: {
      id: { type: 'string', description: '插件 id，比如 dice。可以用 roost_plugins 查。' },
      action: { type: 'string', description: 'enable 或 disable。' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              id: { type: 'string', required: true },
              action: { type: 'string', required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: (_a, v) =>
        v.ok
          ? [{ type: 'text', text: `插件 ${v.id} 已${v.action === 'enable' ? '启用' : '禁用'}。` }]
          : [{ type: 'text', text: v.error }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const id = String(args?.id ?? '').trim();
      const action = String(args?.action ?? '').trim();
      if (!id) return fail('缺少插件 id');
      if (action !== 'enable' && action !== 'disable') return fail('action 只能是 enable 或 disable');
      try {
        await client.request('POST', `/api/plugins/${encodeURIComponent(id)}/${action}`, {}, exec?.signal);
        return { ok: true, id, action };
      } catch (e) {
        return fail(explain(e, client.baseUrl));
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：发消息（写）                                                  */
/* ------------------------------------------------------------------ */

function roostSendTool(client) {
  return defineTool({
    name: 'roost_send',
    description:
      '用机器人往群里或私聊发一条消息。**这是真实发消息**，群里的人会看到。'
      + '主动消息有频次限制，只在调试或用户明确要求时用。',
    parameters: {
      scene: { type: 'string', description: 'group（群聊）或 c2c（私聊）。默认 group。' },
      target: { type: 'string', description: '群 openid 或用户 openid。' },
      content: { type: 'string', description: '要发的内容。' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              scene: { type: 'string', required: true },
              target: { type: 'string', required: true },
            },
          },
          ERROR_SCHEMA,
        ],
      },
      render: (_a, v) =>
        v.ok
          ? [{ type: 'text', text: `已发送到 ${v.scene} ${v.target}。` }]
          : [{ type: 'text', text: v.error }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const scene = String(args?.scene ?? 'group').trim();
      const target = String(args?.target ?? '').trim();
      const content = String(args?.content ?? '');
      if (!target) return fail('缺少 target（群或用户的 openid）');
      if (!content) return fail('缺少 content');
      try {
        await client.request('POST', '/api/send', { scene, target, content }, exec?.signal);
        return { ok: true, scene, target };
      } catch (e) {
        return fail(explain(e, client.baseUrl));
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 工具：重连（写）                                                    */
/* ------------------------------------------------------------------ */

function roostReconnectTool(client) {
  return defineTool({
    name: 'roost_reconnect',
    description:
      '让机器人重连 QQ 网关。机器人显示「在线」但收不到消息、或者刚改完连接参数时用。'
      + '重连期间有几秒收不到消息。',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean', required: true } },
          },
          ERROR_SCHEMA,
        ],
      },
      render: (_a, v) =>
        v.ok ? [{ type: 'text', text: '已触发重连，几秒后生效。' }] : [{ type: 'text', text: v.error }],
    },
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      try {
        await client.request('POST', '/api/gateway/reconnect', {}, exec?.signal);
        return { ok: true };
      } catch (e) {
        return fail(explain(e, client.baseUrl));
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 小工具函数                                                          */
/* ------------------------------------------------------------------ */

function fmtDuration(ms) {
  if (!ms || ms < 0) return '不到 1 秒';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

/** 面板的日志条目可能是对象，压成一行文本 */
function formatLogLine(l) {
  if (!l || typeof l !== 'object') return String(l ?? '');
  const time = String(l.time ?? l.ts ?? '').replace('T', ' ').slice(0, 23);
  const level = String(l.level ?? 'INFO').toUpperCase();
  const mod = l.module ? `[${l.module}] ` : '';
  return `${time} ${level.padEnd(5)} ${mod}${l.msg ?? l.message ?? ''}`;
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param ctx 插件上下文，inject 里声明的服务已就绪
 * @param rawConfig cordis.patch.yml 里那一行的 config
 */
export function apply(ctx, rawConfig) {
  const cfg = readConfig(rawConfig);
  const client = createClient(cfg);

  // 每次注册都挂在 ctx 上，插件卸载时会自动撤销
  ctx.tools.register(roostStatusTool(client));
  ctx.tools.register(roostPluginsTool(client));
  ctx.tools.register(roostLogsTool(client));
  ctx.tools.register(roostPluginToggleTool(client));
  ctx.tools.register(roostSendTool(client));
  ctx.tools.register(roostReconnectTool(client));

  console.log(`[dsh-roost] 已注册 6 个工具，面板地址 ${cfg.baseUrl}`);
}
