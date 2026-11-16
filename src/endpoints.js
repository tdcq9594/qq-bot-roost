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

  /* ---------------- 消息 / Markdown 素材（机器人级图床） ---------------- */
  { method: 'GET', path: '/v2/media-images', api: 'listMediaImages', group: '消息·Markdown 素材', note: '按 cursor 翻页；total 与单机器人 100 张配额同口径' },
  { method: 'POST', path: '/v2/media-images/prepare', api: 'prepareMediaImage', group: '消息·Markdown 素材', note: '单图 ≤10MB，upload_id 4 小时', internal: true },
  { method: 'POST', path: '/v2/media-images/complete', api: 'completeMediaImage', group: '消息·Markdown 素材', note: 'md5 取 COS ETag', internal: true },
  { method: 'DELETE', path: '/v2/media-images/{image_id}/delete', api: 'deleteMediaImage', group: '消息·Markdown 素材', note: '删除后引用失效，已发消息不受影响', internal: true },

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

  /* ---------------- 频道·公告 ---------------- */
  { method: 'POST', path: '/guilds/{guild_id}/announces', api: 'postGuildAnnounces', group: '频道·公告', note: '消息公告或推荐子频道；推荐最多 3 条；仅私域' },
  { method: 'DELETE', path: '/guilds/{guild_id}/announces/{message_id}', api: 'deleteGuildAnnounces', group: '频道·公告', note: 'message_id=all 删除全部推荐子频道' },
  { method: 'POST', path: '/channels/{channel_id}/announces', api: 'postChannelAnnounces', group: '频道·公告' },
  { method: 'DELETE', path: '/channels/{channel_id}/announces/{message_id}', api: 'deleteChannelAnnounces', group: '频道·公告' },

  /* ---------------- 频道·论坛（仅私域） ---------------- */
  { method: 'GET', path: '/channels/{channel_id}/threads', api: 'getThreadsList', group: '频道·论坛', note: 'channel 须为论坛子频道' },
  { method: 'GET', path: '/channels/{channel_id}/threads/{thread_id}', api: 'getThread', group: '频道·论坛' },
  { method: 'PUT', path: '/channels/{channel_id}/threads', api: 'putThread', group: '频道·论坛', note: 'format: 1 文本 / 2 HTML / 3 Markdown / 4 JSON' },
  { method: 'DELETE', path: '/channels/{channel_id}/threads/{thread_id}', api: 'deleteThread', group: '频道·论坛' },

  /* ---------------- 频道·精华消息 ---------------- */
  { method: 'GET', path: '/channels/{channel_id}/pins', api: 'getPinsMessage', group: '频道·精华' },
  { method: 'PUT', path: '/channels/{channel_id}/pins/{message_id}', api: 'putPinsMessage', group: '频道·精华', note: '每子频道最多 20 条' },
  { method: 'DELETE', path: '/channels/{channel_id}/pins/{message_id}', api: 'deletePinsMessage', group: '频道·精华' },

  /* ---------------- 频道·日程 ---------------- */
  { method: 'GET', path: '/channels/{channel_id}/schedules', api: 'getSchedules', group: '频道·日程', note: 'since 起始时间戳（秒）' },
  { method: 'GET', path: '/channels/{channel_id}/schedules/{schedule_id}', api: 'getSchedule', group: '频道·日程' },
  { method: 'POST', path: '/channels/{channel_id}/schedules', api: 'postSchedule', group: '频道·日程', note: '单管理员/天 10 次、单频道/天 100 次' },
  { method: 'PATCH', path: '/channels/{channel_id}/schedules/{schedule_id}', api: 'patchSchedule', group: '频道·日程' },
  { method: 'DELETE', path: '/channels/{channel_id}/schedules/{schedule_id}', api: 'deleteSchedule', group: '频道·日程' },

  /* ---------------- 频道·身份组 ---------------- */
  { method: 'GET', path: '/guilds/{guild_id}/roles', api: 'getGuildRoles', group: '频道·身份组' },
  { method: 'POST', path: '/guilds/{guild_id}/roles', api: 'postGuildRole', group: '频道·身份组' },
  { method: 'PATCH', path: '/guilds/{guild_id}/roles/{role_id}', api: 'patchGuildRole', group: '频道·身份组' },
  { method: 'DELETE', path: '/guilds/{guild_id}/roles/{role_id}', api: 'deleteGuildRole', group: '频道·身份组' },
  { method: 'PUT', path: '/guilds/{guild_id}/members/{user_id}/roles/{role_id}', api: 'putGuildMemberRole', group: '频道·身份组' },
  { method: 'DELETE', path: '/guilds/{guild_id}/members/{user_id}/roles/{role_id}', api: 'deleteGuildMemberRole', group: '频道·身份组' },
  { method: 'GET', path: '/guilds/{guild_id}/roles/{role_id}/members', api: 'getRoleMembers', group: '频道·身份组', note: 'start_index 分页，limit 1–400' },

  /* ---------------- 频道·子频道权限 ---------------- */
  { method: 'GET', path: '/channels/{channel_id}/permissions', api: 'getChannelPermissions', group: '频道·权限' },
  { method: 'PUT', path: '/channels/{channel_id}/permissions', api: 'putChannelPermissions', group: '频道·权限' },
  { method: 'GET', path: '/channels/{channel_id}/roles/{role_id}/permissions', api: 'getChannelRolesPermissions', group: '频道·权限' },
  { method: 'PUT', path: '/channels/{channel_id}/roles/{role_id}/permissions', api: 'putChannelRolesPermissions', group: '频道·权限' },

  /* ---------------- 频道·成员 ---------------- */
  { method: 'GET', path: '/guilds/{guild_id}/members', api: 'getGuildMembers', group: '频道·成员', note: 'after 分页，limit 1–400；仅私域' },
  { method: 'GET', path: '/guilds/{guild_id}/members/{user_id}', api: 'getGuildMember', group: '频道·成员' },
  { method: 'GET', path: '/channels/{channel_id}/online_nums', api: 'getOnlineNums', group: '频道·成员' },

  /* ---------------- 频道·API 权限 ---------------- */
  { method: 'GET', path: '/guilds/{guild_id}/api_permission', api: 'getGuildApiPermission', group: '频道·API权限' },
  { method: 'POST', path: '/guilds/{guild_id}/api_permission/demand', api: 'postGuildApiPermissionDemand', group: '频道·API权限' },

  /* ---------------- 频道·音频（仅音频类机器人） ---------------- */
  { method: 'POST', path: '/channels/{channel_id}/audio', api: 'audioControl', group: '频道·音频', note: '需平台开通音频类机器人' },
  { method: 'PUT', path: '/channels/{channel_id}/mic', api: 'putMic', group: '频道·音频' },
  { method: 'DELETE', path: '/channels/{channel_id}/mic', api: 'deleteMic', group: '频道·音频' },

  /* ---------------- 频道消息 / 私信（server-inter/channel/message/） ----------------
   * 这几个不在 autogen/ 索引里，但官方文档仍有效（见 api-call-guide.html 的频道错误码段）。
   * 官方字段是 snake_case，与 v2 群/单聊的 camelCase 不同，api.js 里单独转换。
   */
  { method: 'POST', path: '/channels/{channel_id}/messages', api: 'sendChannelMessage', group: '频道·消息', note: '被动 5 分钟；主动 20 条/天·子频道、每频道每天 2 个子频道；每子频道 1s ≤5 条；需 WS 在线' },
  { method: 'DELETE', path: '/channels/{channel_id}/messages/{message_id}', api: 'retractChannelMessage', group: '频道·消息', note: '管理员可撤成员、频道主可撤所有人；仅私域' },

  /* ---------------- 频道·表情表态（server-inter/message/trans/emoji） ----------------
   * 官方把这三个放在 `message/trans/` 而不是 `channel/` 下，所以按目录找会漏。
   * 表情表态**仅频道内可用**；type 见 EmojiType，id 见 Emoji 列表。
   */
  { method: 'PUT', path: '/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}', api: 'putReaction', group: '频道·表态', note: '机器人对消息发表情表态' },
  { method: 'DELETE', path: '/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}', api: 'deleteReaction', group: '频道·表态', note: '只能删自己发的表态' },
  { method: 'GET', path: '/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}', api: 'getReactionUsers', group: '频道·表态', note: 'cookie 分页；limit 默认 20、最多 50' },
  { method: 'POST', path: '/users/@me/dms', api: 'createDms', group: '频道·私信', note: '需机器人与用户有共同频道；返回私信会话 guild_id' },
  { method: 'POST', path: '/dms/{guild_id}/messages', api: 'sendDmMessage', group: '频道·私信', note: '主动 2 条/天·用户 + 200 条/天·机器人；被动不限条数；仅私域' },
  { method: 'DELETE', path: '/dms/{guild_id}/messages/{message_id}', api: 'retractDmMessage', group: '频道·私信', note: '只能撤回机器人自己发的私信；仅私域' },

  /* ---------------- 用户 / 机器人 ---------------- */
  { method: 'GET', path: '/users/@me', api: 'getMe', group: '用户' },
  { method: 'GET', path: '/v2/users/{user_openid}/info', api: 'getUserInfo', group: '用户', note: '2026-11-16 新增，10 QPS，需好友关系' },
  { method: 'GET', path: '/users/@me/guilds', api: 'getMyGuilds', group: '用户' },

  /* ---------------- 网关 ---------------- */
  { method: 'GET', path: '/gateway', api: 'getGateway', group: '网关' },

  /* ---------------- 分享链接 ---------------- */
  { method: 'POST', path: '/v2/generate_url_link', api: 'generateUrlLink', group: '分享链接', note: 'callback_data ≤ 32 字符' },

  /* ---------------- 群信息 ---------------- */
  { method: 'GET', path: '/v2/groups/{group_openid}/info', api: 'getGroupInfo', group: '群·信息', note: '30 QPM' },
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
 *
 * `internal:true` 的端点仍登记在官方清单里（覆盖度测试要校验），但**不对外开放**：
 * 素材三步上传必须经 `api.uploadMarkdownImage()` / `uploadMarkdownImageBytes()` 串起来，
 * 外部直接 prepare/complete 会绕过本地预检（10MB / 文件头 / 扩展名），
 * 还能无节制消耗机器人 100 张配额。查询接口 `listMediaImages` 是只读的，正常开放。
 */
export const CALLABLE_METHODS = new Set(
  OFFICIAL_ENDPOINTS.filter((e) => !e.internal)
    .map((e) => e.api).filter((v) => typeof v === 'string' && v),
);

/**
 * 给 AI / 外部调用方看的能力清单。
 * 一个方法可能对应多个官方接口（如 `uploadMedia` 覆盖群和单聊两条），合并成一条。
 */
export function capabilityList() {
  const byApi = new Map();
  for (const ep of OFFICIAL_ENDPOINTS) {
    // 内部专用端点不给外部能力清单，免得 AI 以为可以自己拼素材上传流程
    if (!ep.api || ep.internal) continue;
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
