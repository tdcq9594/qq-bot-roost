import fs from 'node:fs/promises';
import path from 'node:path';
import { rel } from '../paths.js';

/**
 * 插件配置：默认值写在插件代码里，用户改的存 config/plugins/<id>.json。
 *
 * 规则（和主流框架一致）：
 *   - 文件不存在 → 用默认值生成一份，让用户知道有哪些项可以改
 *   - 文件存在 → 与默认值深合并，**缺失的补上，用户多写的保留**
 *   - 插件升级加了新配置项 → 下次加载自动出现在文件里，不用手动加
 *
 * 这样插件作者只需要在代码里写一份默认值，用户就有一份带注释意义的配置文件可改。
 */

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, extra) {  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** 把 defaults 里存在、target 里缺失的键补进去（不动用户已有值） */
function fillDefaults(target, defaults) {
  const out = { ...target };
  for (const [k, v] of Object.entries(defaults ?? {})) {
    if (!(k in out)) out[k] = v;
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = fillDefaults(out[k], v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 配置 schema                                                         */
/* ------------------------------------------------------------------ */

/** 是不是「带类型的字段描述」，而不是一个普通值 */
function isDescriptor(v) {
  return (
    isPlainObject(v) &&
    ('default' in v || 'type' in v) &&
    // 有 type 时必须是认识的类型，避免把普通对象误判
    (!('type' in v) || ['number', 'text', 'boolean', 'json', 'select'].includes(v.type))
  );
}

/** 从值的类型推断控件 */
function inferType(v) {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'text';
  return 'json';
}

/**
 * 插件可以两种写法声明配置：
 *
 *   // 简写：只有默认值，面板按类型自动渲染
 *   config: { 买蛋价: 80, 开启PvP: true }
 *
 *   // 完整：带说明和校验
 *   config: {
 *     买蛋价: { type: 'number', default: 80, desc: '买一颗蛋要多少节操' },
 *     难度:   { type: 'select', default: '普通', options: ['简单','普通','困难'] },
 *   }
 *
 * 下面两个函数把两种写法统一掉。
 */

/** 取纯默认值（喂给 PluginConfig） */
export function resolveDefaults(defaults) {
  const out = {};
  for (const [k, v] of Object.entries(defaults ?? {})) {
    out[k] = isDescriptor(v) ? (v.default ?? null) : v;
  }
  return out;
}

/** 生成给面板用的 schema */
export function schemaOf(defaults) {
  const out = {};
  for (const [k, v] of Object.entries(defaults ?? {})) {
    if (isDescriptor(v)) {
      out[k] = {
        type: v.type ?? inferType(v.default),
        default: v.default ?? null,
        desc: v.desc ?? '',
        ...(Array.isArray(v.options) ? { options: v.options } : {}),
      };
    } else {
      out[k] = { type: inferType(v), default: v, desc: '' };
    }
  }
  return out;
}

export class PluginConfig {
  /**
   * @param {object} p
   * @param {string} p.id 插件 id
   * @param {object} [p.defaults] 插件声明的默认配置
   * @param {object} [p.log] 日志器
   * @param {string} [p.file] 覆盖配置文件路径（测试用）
   */
  constructor({ id, defaults = {}, log = null, file = null }) {
    this.id = id;
    // 插件可能用完整写法声明（带 type/desc），这里统一取纯默认值
    this.rawDefaults = defaults ?? {};
    this.defaults = resolveDefaults(defaults);
    // 路径必须由 loader 按机器人传进来，这里不再自己拼
    if (!file) throw new Error(`插件 ${id} 的配置文件路径未指定`);
    this.file = file;
    this.log = log;
    this.data = null;
  }

  /** 读配置；首次会生成文件 */
  async load() {
    let raw = null;
    let existed = true;
    try {
      raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.log?.warn(`插件配置 ${rel(this.file)} 解析失败，已按默认值重建: ${e.message}`);
      }
      existed = false;
      raw = {};
    }

    const merged = fillDefaults(raw, this.defaults);

    // 插件压根没声明配置、文件也不存在 → 不生成空文件，免得 plugins 配置目录一堆 {}
    if (!existed && Object.keys(this.defaults ?? {}).length === 0) {
      this.data = merged;
      return this.data;
    }

    // 首次生成，或插件升级后补了新项 → 写回，让用户能看到完整配置
    const changed = JSON.stringify(merged) !== JSON.stringify(raw);
    if (!existed || changed) {
      this.data = merged;
      await this.save();
      if (existed) this.log?.info(`插件配置已补齐新增项: ${rel(this.file)}`);
    } else {
      this.data = merged;
    }
    return this.data;
  }

  /** 当前生效的配置（已与默认值合并） */
  get value() {
    return this.data ?? this.defaults;
  }

  /** 取某项，带默认值兜底 */
  get(key, fallback = undefined) {
    const v = this.value?.[key];
    return v === undefined ? fallback : v;
  }

  /**
   * 改配置并落盘。只改传入的键，其余保留。
   * @returns {Promise<object>} 合并后的完整配置
   */
  async set(patch) {
    if (!isPlainObject(patch)) throw new Error('插件配置只能传对象');
    this.data = deepMerge(this.value, patch);
    await this.save();
    return this.data;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data ?? {}, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, this.file);
  }
}
