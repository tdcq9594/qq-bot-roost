/**
 * 官方接口清单（唯一事实来源）。
 *
 * 目的：**保证官方文档里给的每一个 HTTP 接口，框架里都有对应方法**。
 * 就算某些接口一辈子用不上（频道管理、分片上传），也不能没有——
 * 「没封装」和「官方没给」是两回事，混在一起以后排查会浪费大量时间。
 *
 * 数据来源：官方文档 `bot.q.qq.com/wiki/develop/api-v2/autogen/` 的接口索引，
 * 逐条人工核对（2026-10-26）。**不使用三个官方 SDK 仓库**——它们更新滞后。
 *
 * 新增接口时：
 *   1. 在 api.js 里加方法
 *   2. 在这张表里加一行，`api` 填方法名
 *   3. `npm test` 会校验，漏了直接红
 *
 * `api` 为 null 表示「官方有、但我们暂时没有独立方法」——
 * 这种必须是 0 条，否则测试不过。
 */

/**
 * @typedef {object} Endpoint
 * @property {string} method HTTP 方法
 * @property {string} path   官方路径（保留 {xxx} 占位）
 * @property {string|null} api QQApi 上对应的方法名
 * @property {string} group  官方文档里的分组
 * @property {string} [note] 备注（限制、场景）
 */

/** @type {Endpoint[]} */
export const OFFICIAL_ENDPOINTS = [
  /* ---------------- 消息 / 单聊 ---------------- */
  { method: 'POST', path: '/v2/users/{user_openid}/messages', api: 'sendC2C', group: '消息·单聊' },
  { method: 'POST', path: '/v2/users/{user_openid}/stream_messages', api: 'sendStreamMessage', group: '消息·单聊', note: '流式，仅单聊，50 QPS' },
  { method: 'DELETE', path: '/v2/users/{user_openid}/messages/{message_id}', api: 'retractC2CMessage', group: '消息·单聊' },

  /* ---------------- 消息 / 群 ---------------- */
  { method: 'POST', path: '/v2/groups/{group_openid}/messages', api: 'sendGroup', group: '消息·群' },
  { method: 'DELETE', path: '/v2/groups/{group_openid}/messages/{message_id}', api: 'retractGroupMessage', group: '消息·群', note: '2 分钟内' },

  /* ---------------- 消息 / 富媒体 ---------------- */
  { method: 'POST', path: '/v2/groups/{group_openid}/files', api: 'uploadMedia', group: '消息·富媒体' },
  { method: 'POST', path: '/v2/users/{user_openid}/files', api: 'uploadMedia', group: '消息·富媒体' },
  { method: 'POST', path: '/v2/users/{user_id}/upload_prepare', api: 'uploadPrepare', group: '消息·富媒体', note: '分片上传第一步' },
  { method: 'POST', path: '/v2/users/{user_id}/upload_part_finish', api: 'uploadPartFinish', group: '消息·富媒体', note: '分片上传第二步' },
  { method: 'POST', path: '/v2/groups/{group_id}/upload_prepare', api: 'uploadPrepare', group: '消息·富媒体', note: '分片上传第一步' },
  { method: 'POST', path: '/v2/groups/{group_id}/upload_part_finish', api: 'uploadPartFinish', group: '消息·富媒体', note: '分片上传第二步' },

  /* ---------------- 互动 / 自定义菜单 ---------------- */
  { method: 'GET', path: '/v2/menu', api: 'getGlobalMenu', group: '互动·菜单', note: '仅 C2C' },
  { method: 'PUT', path: '/v2/menu', api: 'setGlobalMenu', group: '互动·菜单', note: '仅 C2C，最多 10 项' },

  /* ---------------- 互动 / 指令面板 ---------------- */
  { method: 'GET', path: '/v2/panels', api: 'listPanels', group: '互动·指令面板', note: 'scope 必填' },
  { method: 'POST', path: '/v2/panels', api: 'createPanel', group: '互动·指令面板', note: '最多 20 个面板' },
  { method: 'PUT', path: '/v2/panels/{panel_id}/target', api: 'updatePanelTarget', group: '互动·指令面板', note: '仅 specific 面板' },
  { method: 'GET', path: '/v2/panels/{panel_id}', api: 'getPanel', group: '互动·指令面板' },
  { method: 'PUT', path: '/v2/panels/{panel_id}', api: 'updatePanel', group: '互动·指令面板' },
  { method: 'DELETE', path: '/v2/panels/{panel_id}', api: 'deletePanel', group: '互动·指令面板' },

  /* ---------------- 互动 / 回调 ---------------- */
  { method: 'PUT', path: '/interactions/{interaction_id}', api: 'putInteraction', group: '互动·回调', note: '按钮点击必须回执' },

  /* ---------------- 频道管理 ---------------- */
  { method: 'GET', path: '/channels/{channel_id}', api: 'getChannel', group: '频道' },
  { method: 'PATCH', path: '/channels/{channel_id}', api: 'updateChannel', group: '频道' },
  { method: 'DELETE', path: '/channels/{channel_id}', api: 'deleteChannel', group: '频道' },
  { method: 'GET', path: '/guilds/{guild_id}', api: 'getGuild', group: '频道' },
  { method: 'GET', path: '/guilds/{guild_id}/channels', api: 'getGuildChannels', group: '频道' },
  { method: 'POST', path: '/guilds/{guild_id}/channels', api: 'createGuildChannel', group: '频道', note: '需管理员，私域' },

  /* ---------------- 用户 / 机器人 ---------------- */
  { method: 'GET', path: '/users/@me', api: 'getMe', group: '用户' },
  { method: 'GET', path: '/users/@me/guilds', api: 'getMyGuilds', group: '用户' },

  /* ---------------- 网关 ---------------- */
  { method: 'GET', path: '/gateway', api: 'getGateway', group: '网关' },

  /* ---------------- 分享链接 ---------------- */
  { method: 'POST', path: '/v2/generate_url_link', api: 'generateUrlLink', group: '分享链接', note: 'callback_data ≤ 32 字符' },

  /* ---------------- 群信息 ---------------- */
  { method: 'GET', path: '/v2/groups/{group_openid}/info', api: 'getGroupInfo', group: '群·信息' },
  { method: 'GET', path: '/v2/groups/{group_openid}/bot_state', api: 'getBotGroupState', group: '群·信息', note: '内邀' },

  /* ---------------- 群成员 ---------------- */
  { method: 'GET', path: '/v2/groups/{group_openid}/members', api: 'getGroupMembers', group: '群·成员', note: '内邀，11253' },
  { method: 'GET', path: '/v2/groups/{group_openid}/members/{member_openid}', api: 'getGroupMember', group: '群·成员', note: '内邀' },
  { method: 'POST', path: '/v2/groups/{group_openid}/batch_remove_members', api: 'removeMembers', group: '群·成员', note: '内邀' },

  /* ---------------- 入群申请 ---------------- */
  { method: 'GET', path: '/v2/groups/{group_openid}/join_request_list', api: 'getJoinRequests', group: '群·入群申请' },
  { method: 'POST', path: '/v2/groups/{group_openid}/approval_join_request/{member_openid}', api: 'handleJoinRequest', group: '群·入群申请' },
  { method: 'POST', path: '/v2/groups/join_approval_strategy', api: 'createJoinStrategy', group: '群·入群申请' },
  { method: 'PATCH', path: '/v2/groups/join_approval_strategy/{strategy_id}', api: 'updateJoinStrategy', group: '群·入群申请' },
  { method: 'POST', path: '/v2/groups/join_approval_strategy/{strategy_id}/execute', api: 'executeJoinStrategy', group: '群·入群申请', note: '异步，约 10 分钟' },
  { method: 'POST', path: '/v2/groups/join_approval_strategy/{strategy_id}/whitelist_users', api: 'updateStrategyWhitelist', group: '群·入群申请', note: '填 QQ 号' },
  { method: 'GET', path: '/v2/groups/join_approval_strategy', api: 'listJoinStrategies', group: '群·入群申请' },
  { method: 'DELETE', path: '/v2/groups/join_approval_strategy/{strategy_id}', api: 'deleteJoinStrategy', group: '群·入群申请' },

  /* ---------------- 群黑名单 ---------------- */
  { method: 'GET', path: '/v2/groups/{group_openid}/member_blacklist', api: 'getGroupBlacklist', group: '群·黑名单', note: '内邀' },
  { method: 'POST', path: '/v2/groups/{group_openid}/member_blacklist', api: 'operateGroupBlacklist', group: '群·黑名单', note: '内邀' },

  /* ---------------- 群禁言 ---------------- */
  { method: 'GET', path: '/v2/groups/{group_openid}/restrict_chat_setting', api: 'getMuteStatus', group: '群·禁言' },
  { method: 'POST', path: '/v2/groups/{group_openid}/restrict_chat_setting', api: 'muteMembers', group: '群·禁言', note: '需管理员，最长 30 天' },
];

/** 官方接口总数（测试里当基准，改了这里等于改了"官方有多少接口"的认知） */
export const OFFICIAL_ENDPOINT_COUNT = OFFICIAL_ENDPOINTS.length;

/**
 * 检查一个 QQApi 类（或实例）覆盖了多少官方接口。
 *
 * 只检查「方法存在且是函数」，不发请求——覆盖度是静态事实，
 * 能不能调通取决于权限和真机，那是另一回事。
 *
 * @param {object|Function} apiClass QQApi 实例，或 QQApi 类
 * @returns {{total:number, covered:number, missing:Array<{method:string,path:string,api:string|null}>}}
 */
export function checkCoverage(apiClass) {
  const target = typeof apiClass === 'function' ? apiClass.prototype : apiClass;
  const missing = [];
  for (const ep of OFFICIAL_ENDPOINTS) {
    if (!ep.api) {
      missing.push({ method: ep.method, path: ep.path, api: null });
      continue;
    }
    if (typeof target?.[ep.api] !== 'function') {
      missing.push({ method: ep.method, path: ep.path, api: ep.api });
    }
  }
  return {
    total: OFFICIAL_ENDPOINTS.length,
    covered: OFFICIAL_ENDPOINTS.length - missing.length,
    missing,
  };
}

/** 按分组汇总，面板和文档用 */
export function endpointsByGroup() {
  const out = new Map();
  for (const ep of OFFICIAL_ENDPOINTS) {
    if (!out.has(ep.group)) out.set(ep.group, []);
    out.get(ep.group).push(ep);
  }
  return out;
}

/* ---------------- 风险分级与通用调用白名单 ---------------- */

/**
 * 默认按 HTTP 方法分级：GET 只读，DELETE 危险，其余算写。
 * 但这不够——`POST batch_remove_members` 是踢人，比很多 DELETE 还狠。
 */
const RISK_OVERRIDE = {
  // 不可逆 / 影响他人：踢人、黑名单、入群审批策略
  removeMembers: 'danger',
  operateGroupBlacklist: 'danger',
  createJoinStrategy: 'danger',
  updateJoinStrategy: 'danger',
  deleteJoinStrategy: 'danger',
  executeJoinStrategy: 'danger',
  updateStrategyWhitelist: 'danger',
  // 禁言可以解除，算写
  muteMembers: 'write',
};

/**
 * 一个接口的风险等级。
 *   read   — 只读，随便调
 *   write  — 会改状态但可恢复（发消息、上传、面板、禁言）
 *   danger — 不可逆或影响他人（踢人、黑名单、审批策略、删除类）
 *
 * @param {Endpoint} ep
 * @returns {'read'|'write'|'danger'}
 */
export function riskOf(ep) {
  if (ep?.api && RISK_OVERRIDE[ep.api]) return RISK_OVERRIDE[ep.api];
  if (ep?.method === 'GET') return 'read';
  if (ep?.method === 'DELETE') return 'danger';
  return 'write';
}

/**
 * 允许通过 `/api/qq/call` 调用的方法名。
 *
 * 白名单来自这张表本身——**不在表里的一律拒绝**，
 * 免得以后有人往 QQApi 加了个内部方法，外部就能顺手调。
 */
export const CALLABLE_METHODS = new Set(
  OFFICIAL_ENDPOINTS.map((e) => e.api).filter((v) => typeof v === 'string' && v),
);

/**
 * 给 AI / 外部调用方看的能力清单。
 * 一个方法可能对应多个官方接口（如 `uploadMedia` 覆盖群和单聊两条），合并成一条。
 */
export function capabilityList() {
  const byApi = new Map();
  for (const ep of OFFICIAL_ENDPOINTS) {
    if (!ep.api) continue;
    const cur = byApi.get(ep.api);
    if (!cur) {
      byApi.set(ep.api, {
        api: ep.api,
        http: [`${ep.method} ${ep.path}`],
        group: ep.group,
        risk: riskOf(ep),
        note: ep.note ?? '',
      });
      continue;
    }
    cur.http.push(`${ep.method} ${ep.path}`);
    // 合并时取更严的那一档
    const order = { read: 0, write: 1, danger: 2 };
    if (order[riskOf(ep)] > order[cur.risk]) cur.risk = riskOf(ep);
    if (ep.note) cur.note = cur.note ? `${cur.note}；${ep.note}` : ep.note;
  }
  return [...byApi.values()];
}
