/**
 * 人物反查的「匹配与排序」。
 *
 * 从面板 `/api/people/search` 里抽出来的纯函数：那段逻辑最容易出错的是
 * **三种输入怎么区分**——`10001` 是 QQ 号，`8C7419D4…` 是 openid，
 * 「倦飞」是昵称。放这里才能单测，页面那边只负责拼数据源。
 */

/**
 * 像不像 QQ 号。
 *
 * 3~12 位纯数字：官方号码 5~11 位，留点余量。**不要更宽**——
 * 超过 12 位的纯数字多半是别的东西（时间戳、消息 id），按号码查只会白跑。
 */
export function isUinQuery(q) {
  return /^\d{3,12}$/.test(String(q ?? '').trim());
}

/**
 * 像不像 openid。
 *
 * 16 位以上、**且含字母**：openid 是十六进制串，纯数字的长串不是它
 * （这条判断防止把 20 位的时间戳当 openid 去比对）。
 */
export function isOpenidQuery(q) {
  const s = String(q ?? '').trim();
  return /^[0-9A-Za-z_-]{16,}$/.test(s) && /[A-Za-z]/.test(s);
}

/**
 * 按查询词筛人。
 *
 * 三种口径互斥，按「越具体越优先」判：openid → QQ 号 → 昵称模糊。
 * 昵称这一档同时比 `name`（人工备注名 / 群名片）、`card`、`nickname`、`note`，
 * 因为用户嘴里的「昵称」可能是其中任何一个。
 *
 * @param {Array<{openid:string,uin?:string,name?:string,card?:string,nickname?:string,note?:string}>} list
 * @param {string} q
 */
export function filterPeople(list, q) {
  const arr = Array.isArray(list) ? list : [];
  const kw = String(q ?? '').trim().toLowerCase();
  if (!kw) return arr;

  /** 纯数字：**只按号码查**。落回昵称会让「10001」命中「10001号选手」，那不是查人 */
  if (isUinQuery(kw)) {
    return arr.filter((p) => String(p?.uin ?? '').startsWith(kw));
  }

  if (isOpenidQuery(kw)) {
    const hit = arr.filter((p) => String(p?.openid ?? '').toLowerCase().startsWith(kw));
    if (hit.length) return hit;
  }

  const byName = arr.filter((p) => {
    const hay = [p?.name, p?.card, p?.nickname, p?.note].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(kw);
  });
  if (byName.length) return byName;

  /**
   * 最后一道：**openid 短前缀**。
   *
   * 用户经常只粘前半截（或者从别处抄了 8 位）。这类串不满足 `isOpenidQuery`
   * 的长度要求，前面会当成昵称找不到人，所以这里再按前缀试一次。
   * 要求 ≥ 8 位，太短的前缀会匹配到一片人，反而误导。
   */
  if (/^[0-9a-z_-]{8,}$/i.test(kw)) {
    return arr.filter((p) => String(p?.openid ?? '').toLowerCase().startsWith(kw));
  }
  return [];
}

/**
 * 排序：**绑定过的先**，再按名字。
 *
 * 不按「最近说过话」排——查人是找特定的人，不是看谁活跃。
 * 绑定的排前面是因为那种人一定有 QQ 号可反查，对用户更有用。
 */
export function sortPeople(list) {
  const arr = Array.isArray(list) ? [...list] : [];
  return arr.sort((a, b) => {
    if (Boolean(a?.bound) !== Boolean(b?.bound)) return a.bound ? -1 : 1;
    const an = String(a?.name || a?.card || a?.openid || '');
    const bn = String(b?.name || b?.card || b?.openid || '');
    return an.localeCompare(bn, 'zh');
  });
}
