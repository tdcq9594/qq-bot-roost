/**
 * 插件自定义数据（面板「运行数据」）。
 *
 * 插件想在面板上显示「已回复 1234 条」「平均 320ms」这类运行指标，
 * 不用写任何前端代码，只要给出一份结构化数据，面板负责渲染。
 *
 * 两种给法（都在插件里）：
 *
 *   1. 声明式——每次面板拉取时现算：
 *      export default {
 *        dashboard() {
 *          return {
 *            metrics: [
 *              { label: '已回复', value: counters.reply, unit: '条' },
 *              { label: '平均耗时', value: 320, unit: 'ms' },
 *            ],
 *            note: '模型：xxx',
 *          };
 *        },
 *      };
 *
 *   2. 主动推——数据不由插件即时算得出时：
 *      ctx.setDashboard({ metrics: [...] });
 *
 * 外部插件（Python / Go）发一条协议消息即可：
 *   {"type":"dashboard","data":{"metrics":[...]}}
 *
 * 这里负责把插件给的东西洗成面板能直接用的形状，顺便挡掉脏数据：
 * 超长文本截断、数量上限、非对象丢弃。洗不出有效内容就返回 null。
 */

const MAX_METRICS = 12;
const MAX_LABEL = 24;
const MAX_VALUE = 40;
const MAX_UNIT = 8;
const MAX_HINT = 60;
const MAX_NOTE = 800;

/** 转成一行文本并截断。对象/数组转 JSON，免得面板上出现 [object Object] */
function text(v, max) {
  if (v === undefined || v === null) return '';
  let s;
  if (typeof v === 'object') {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  } else {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @param {unknown} raw 插件给的原始数据
 * @returns {{metrics: Array<{label:string,value:string,unit:string,hint:string}>, note:string, updatedAt:number}|null}
 */
export function normalizeDashboard(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const out = { metrics: [], note: '', updatedAt: Date.now() };

  const metrics = Array.isArray(raw.metrics) ? raw.metrics : [];
  for (const m of metrics.slice(0, MAX_METRICS)) {
    if (!m || typeof m !== 'object') continue;
    const label = text(m.label ?? m.name ?? m.title, MAX_LABEL);
    if (!label) continue;
    out.metrics.push({
      label,
      // 0 是合法值，不能用 || 兜底
      value: text(m.value ?? m.count ?? '', MAX_VALUE) || '0',
      unit: text(m.unit, MAX_UNIT),
      hint: text(m.hint ?? m.desc, MAX_HINT),
    });
  }

  out.note = text(raw.note ?? raw.text, MAX_NOTE);

  // 什么都没有等于没提供，让面板显示「插件未提供运行数据」
  if (!out.metrics.length && !out.note) return null;
  return out;
}
