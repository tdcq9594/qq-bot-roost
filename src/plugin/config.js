import fs from 'node:fs/promises';
import path from 'node:path';
import { rel } from '../paths.js';

/**
 * 插件配置：默认值写在插件代码里，用户改的存 config/bots/<机器人id>/plugins/<id>.json。
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
    /**
     * 有 type 时必须是认识的类型，避免把普通对象误判。
     *
     * 'string' 当 'text' 的别名：作者十有八九会写 string，别让他因此踩空。
     *
     * **这里必须和面板支持的类型保持一致。** 漏一个的后果不是「那个类型不好用」，
     * 而是整个 descriptor 被当成普通对象——type 退化成 json、label 和 desc 全丢，
     * 面板上显示成一坨 JSON 文本框。加新类型时记得同步这里。
     */
    (!('type' in v) ||
      ['number', 'text', 'string', 'boolean', 'json', 'select', 'textarea'].includes(v.type))
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

/**
 * 按 schema 校验一份配置。
 *
 * 只检查「作者声明了规则」的项，没声明的一律放过——老插件不受影响。
 * 返回第一条错误的中文说明，没问题返回 null。
 *
 * @param {object} values 合并后的完整配置
 * @param {object} schema schemaOf() 的结果
 */
export function validateConfig(values, schema) {
  for (const [key, s] of Object.entries(schema ?? {})) {
    const v = values?.[key];

    if (s.required && (v === undefined || v === null || v === '')) {
      return `配置项 ${key} 是必填的`;
    }
    if (v === undefined || v === null || v === '') continue;

    if (s.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) return `配置项 ${key} 必须是数字`;
      if (s.min !== undefined && n < s.min) return `配置项 ${key} 不能小于 ${s.min}`;
      if (s.max !== undefined && n > s.max) return `配置项 ${key} 不能大于 ${s.max}`;
    }

    if (s.pattern) {
      let re = null;
      try {
        re = new RegExp(s.pattern);
      } catch {
        // 作者正则写错了，跳过这一条，别让保存整个失败
        continue;
      }
      if (!re.test(String(v))) return `配置项 ${key} 格式不对（要求 ${s.pattern}）`;
    }
  }
  return null;
}

/** 生成给面板用的 schema */
export function schemaOf(defaults) {
  const out = {};
  for (const [k, v] of Object.entries(defaults ?? {})) {
    if (isDescriptor(v)) {
      out[k] = {
        // 统一成面板认识的类型名
        type: v.type === 'string' ? 'text' : (v.type ?? inferType(v.default)),
        default: v.default ?? null,
        desc: v.desc ?? '',
        /**
         * 面板上显示的标题，不填就显示键名。
         *
         * 键名是代码里用的（`ctx.config.apiKey`），不能随便改成中文；
         * 但给用户看的表单写 `apiKey` 太不友好，所以拆成两个：
         * 键名给代码，label 给人。
         */
        ...(v.label ? { label: String(v.label) } : {}),
        ...(Array.isArray(v.options) ? { options: v.options } : {}),
        // 校验规则原样透给面板，填错时当场提示，不用等运行时
        ...(v.required ? { required: true } : {}),
        ...(v.min !== undefined ? { min: v.min } : {}),
        ...(v.max !== undefined ? { max: v.max } : {}),
        ...(v.pattern ? { pattern: v.pattern } : {}),
        ...(v.placeholder ? { placeholder: v.placeholder } : {}),
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
        // 手改漏个逗号就整份配置回默认值、原文件被覆盖——先留一份再说
        const bak = `${this.file}.corrupt-${Date.now()}`;
        await fs.rename(this.file, bak).catch(() => {});
        this.log?.warn(
          `插件配置 ${rel(this.file)} 解析失败（${e.message}），原文件已备份为 ${rel(bak)}，本次用默认值`,
        );
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
    // 先合再验：校验要看「合完之后的完整配置」，只验增量会漏掉必填项
    const next = deepMerge(this.value, patch);
    const bad = validateConfig(next, schemaOf(this.rawDefaults));
    if (bad) throw new Error(bad);
    this.data = next;
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
