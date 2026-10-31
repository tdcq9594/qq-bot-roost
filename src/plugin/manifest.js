/**
 * 插件清单：能力声明与版本要求
 * ============================
 *
 * 为什么需要它：命名冲突现在只在**注册那一刻**才炸——命令重复要等用户敲到
 * 那条命令、工具重复要等 AI 真的去调。用户看到的是「这个插件好像没生效」，
 * 而不是「A 和 B 都声明了 dice」。更麻烦的是 `hooks`：多个插件都能监听消息，
 * 没有任何一处会告诉你「这两个插件在抢同一件事」。
 *
 * 这里把「我占哪些名字」提前成**声明**，加载前就能对表。
 *
 * 三个原则：
 *   1. **声明可选**。老插件不写 `provides` 照常加载，只是不参与预检（会 warn）。
 *   2. **冲突 fail-closed**。后加载的那个拒绝加载，并说清是谁占了。
 *   3. **只声明不强制**。`provides` 是「我打算用」，真正的注册仍走原有路径，
 *      两边对不上时以实际注册为准——声明不能变成第二套权限。
 */

/** 三类可声明的名字。`hooks` 只是提示，多个插件监听同一条消息是合法的。 */
export const KINDS = ['commands', 'tools', 'hooks'];

/** 把任意输入压成 `{ commands: [], tools: [], hooks: [] }`，去掉空值与非字符串 */
export function normalizeProvides(raw) {
  const out = { commands: [], tools: [], hooks: [] };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of KINDS) {
    const v = raw[k];
    if (!Array.isArray(v)) continue;
    out[k] = [...new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))];
  }
  return out;
}

/**
 * 解析整个清单。`engines` 只保留认识的键，值统一成字符串。
 *
 * 兼容两种写法：顶层 `provides`，或 `requires.provides`（后者是给
 * `frameworkVersion` 那套 `requires.*` 习惯留的）。
 */
export function normalizeManifest(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const req = src.requires && typeof src.requires === 'object' ? src.requires : {};
  const enginesRaw = src.engines && typeof src.engines === 'object' ? src.engines : {};
  const engines = {};
  for (const k of ['roost', 'node', 'dsh']) {
    const v = enginesRaw[k];
    if (v !== undefined && v !== null && String(v).trim()) engines[k] = String(v).trim();
  }
  return {
    provides: normalizeProvides(src.provides ?? req.provides),
    consumes: normalizeProvides(src.consumes ?? req.consumes),
    engines,
  };
}

/**
 * 版本要求检查。
 *
 * `actual` 里缺的键**跳过**：比如 Roost 进程里根本不知道 DSH 版本，
 * 那就不能因为「查不到」判定不兼容——那会把所有声明了 dsh 的插件全拒掉。
 *
 * @param {Record<string,string>} engines
 * @param {{roost?:string, node?:string, dsh?:string}} actual
 * @param {(v:string, r:string)=>boolean} satisfies
 * @returns {{ok:boolean, why?:string}}
 */
export function checkEngines(engines, actual, satisfies) {
  for (const [k, range] of Object.entries(engines ?? {})) {
    const cur = actual?.[k];
    if (!cur) continue; // 不知道就不判
    let ok = false;
    try {
      ok = satisfies(cur, range);
    } catch {
      return { ok: false, why: `engines.${k} 不是合法的版本范围：${range}` };
    }
    if (!ok) return { ok: false, why: `要求 ${k} ${range}，当前是 ${cur}` };
  }
  return { ok: true };
}

/**
 * 声明占用表。
 *
 * 用法：加载前 `claim()`，卸载时 `release()`。
 * `claim` **不注册冲突项**——调用方拿到 conflicts 后应拒绝加载，
 * 这样表里永远只有「真正生效」的声明，不会因为一次失败加载留下幽灵条目。
 */
export class Declarations {
  constructor() {
    /** @type {Map<string, {kind:string, name:string, pluginId:string}>} */
    this.map = new Map();
  }

  static key(kind, name) {
    return `${kind}:${name}`;
  }

  /**
   * 认领一组名字。
   * @param {string} pluginId
   * @param {{commands?:string[], tools?:string[], hooks?:string[]}} provides
   * @returns {Array<{kind:string, name:string, owner:string}>} 冲突项（空数组=全部拿到）
   */
  claim(pluginId, provides) {
    const p = normalizeProvides(provides);
    const conflicts = [];
    const mine = [];

    for (const kind of KINDS) {
      for (const name of p[kind]) {
        const k = Declarations.key(kind, name);
        const held = this.map.get(k);
        if (held && held.pluginId !== pluginId) {
          conflicts.push({ kind, name, owner: held.pluginId });
        } else {
          mine.push([k, { kind, name, pluginId }]);
        }
      }
    }

    // 有冲突就整批不落：半套声明比没有更难查
    if (conflicts.length) return conflicts;
    for (const [k, v] of mine) this.map.set(k, v);
    return [];
  }

  /** 卸载时释放这个插件的全部声明 */
  release(pluginId) {
    let n = 0;
    for (const [k, v] of this.map) {
      if (v.pluginId === pluginId) {
        this.map.delete(k);
        n += 1;
      }
    }
    return n;
  }

  /** 面板「资源占用」用：按插件分组 */
  byPlugin() {
    const out = new Map();
    for (const v of this.map.values()) {
      if (!out.has(v.pluginId)) out.set(v.pluginId, { commands: [], tools: [], hooks: [] });
      out.get(v.pluginId)[v.kind].push(v.name);
    }
    return out;
  }
}
