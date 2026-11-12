/**
 * 能力表
 * ======
 *
 * 面板「外接」页和 `get_status` 共用一份。**别在面板里手写文案**——
 * 那样代码和文档一定会分叉，用户看到的和实际行为对不上。
 *
 * `level` 是设计意图，`implemented` 由 `actions.js` 实际注册的处理函数决定：
 * 两边不一致时以「没实现」为准（宁可说做不到，也不要报 500）。
 */

/** @typedef {'support'|'degrade'|'unsupported'} Level */

export const CAPABILITY = [
  /* 发送 */
  { name: 'send_private_msg', level: 'support', note: '单聊' },
  { name: 'send_group_msg', level: 'support', note: '群聊；多段消息按条拆开' },
  { name: 'send_msg', level: 'support', note: '与上面两条同一条 outbound 路径' },
  { name: 'delete_msg', level: 'support', note: '2 分钟内；撤他人需群管理员；成功后补 group_recall' },
  { name: 'send_group_forward_msg', level: 'unsupported', why: '官方只能收合并转发，不能发' },

  /* 查询 */
  { name: 'get_login_info', level: 'support', note: '用配置里的机器人 QQ 号' },
  { name: 'get_group_info', level: 'support', note: '30 QPM，带缓存' },
  { name: 'get_group_list', level: 'degrade', why: '官方无查询接口，靠事件发现的群档案' },
  { name: 'get_group_member_info', level: 'degrade', why: '内邀接口；没白名单时只给号码和已知昵称' },
  { name: 'get_group_member_list', level: 'degrade', why: '内邀接口；否则只列「在群里说过话的人」' },
  { name: 'get_msg', level: 'degrade', why: '只记得最近 500 条' },
  { name: 'get_forward_msg', level: 'degrade', why: '只覆盖本次进程收到的' },
  { name: 'get_stranger_info', level: 'unsupported', why: '官方没有用户资料接口' },
  { name: 'get_friend_list', level: 'unsupported', why: '官方没有好友列表接口' },
  { name: 'get_group_msg_history', level: 'degrade', why: '用账本回放，只有本进程收到过的' },
  { name: 'get_friend_msg_history', level: 'degrade', why: '同上' },

  /* 群管 */
  { name: 'set_group_ban', level: 'support', note: '需群管理员，最长 30 天' },
  { name: 'set_group_whole_ban', level: 'unsupported', why: '官方只有单成员禁言' },
  { name: 'set_group_kick', level: 'unsupported', why: '内邀接口，普通机器人返回 11253' },
  { name: 'set_group_add_request', level: 'support', note: '需群管理员' },
  { name: 'set_friend_add_request', level: 'unsupported', why: '官方没有加好友审批接口' },
  { name: 'set_group_card', level: 'unsupported', why: '官方无对应接口' },
  { name: 'set_group_name', level: 'unsupported', why: '官方无对应接口' },
  { name: 'set_group_admin', level: 'unsupported', why: '官方无对应接口' },
  { name: 'set_group_leave', level: 'unsupported', why: '官方无对应接口' },
  { name: 'set_group_special_title', level: 'unsupported', why: '官方无对应接口' },

  /* 其它 */
  { name: 'set_input_status', level: 'unsupported', why: '只有单聊能发「输入中」，兼容层没接' },
  { name: 'send_poke', level: 'unsupported', why: '官方没有拍一拍' },
  { name: 'can_send_image', level: 'support' },
  { name: 'can_send_record', level: 'degrade', why: '要装可选依赖 silk-wasm' },
  { name: 'get_status', level: 'support' },
  { name: 'get_version_info', level: 'support' },
  { name: 'mark_msg_as_read', level: 'support', note: '空实现（官方无已读）' },
  { name: 'get_image', level: 'degrade', why: '从附件缓存取 url' },
  { name: 'get_record', level: 'degrade', why: '从附件缓存取 url' },
  { name: 'fetch_ptt_text', level: 'degrade', why: '用官方 asr_refer_text' },
  { name: 'set_restart', level: 'unsupported', why: '安全面，一律拒' },
  { name: 'get_cookies', level: 'unsupported', why: '安全面，一律拒' },
  { name: 'get_csrf_token', level: 'unsupported', why: '安全面，一律拒' },
];

/**
 * @param {object} p
 * @param {string[]} [p.implemented] `actions.js` 实际注册的名字
 * @param {boolean} [p.hasSilk]
 */
export function buildCapability({ implemented = [], hasSilk = false } = {}) {
  const has = new Set(implemented);
  // 没启动时拿不到注册表（空数组）——那就按设计意图显示，别把整张表都标成不支持
  const checkReal = has.size > 0;
  return CAPABILITY.map((c) => {
    let level = c.level;
    // 说「支持」但代码里没有 → 按不支持算，别骗人
    if (level !== 'unsupported' && checkReal && !has.has(c.name)) level = 'unsupported';
    let why = c.why ?? '';
    if (c.name === 'can_send_record' && !hasSilk) {
      level = 'degrade';
      why = '没装 silk-wasm：发不了语音';
    }
    return {
      name: c.name,
      level,
      note: c.note ?? '',
      why: level === 'support' ? '' : why,
    };
  });
}

/** 面板顶部的一行汇总 */
export function summarize(list) {
  const out = { support: 0, degrade: 0, unsupported: 0 };
  for (const c of list) out[c.level] += 1;
  return out;
}
