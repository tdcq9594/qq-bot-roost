/**
 * 版本号比较与范围匹配
 * ====================
 *
 * 只用标准库，不引 semver 包——框架的零依赖定位不能破。
 *
 * 支持的范围写法（够插件用，不追求覆盖 npm 全部语法）：
 *
 *   "0.5.6"              精确
 *   ">=0.5.0"            比较
 *   ">=0.5.0 <1.0.0"     空格分隔表示「同时满足」
 *   "^0.5.0"             兼容主版本（0.x 时按 npm 规则只兼容到次版本）
 *   "~0.5.0"             兼容次版本
 *   "0.5.x" / "0.x"      通配
 *   ">=0.5.0 || ^0.6.0"  竖线表示「满足其一」
 *   "" / "*" / 不填      都算满足
 *
 * 预发行版规则按 npm 简化：候选版本带 `-beta` 这类后缀时，
 * 只有范围里也明确写了预发行号才算满足。否则 `0.6.0-beta` 会被
 * `>=0.5.0` 判成通过，作者以为测的是正式版。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/** @returns {{nums:number[], pre:string}|null} */
export function parseVersion(v) {
  const m = String(v ?? '').match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? '' };
}

/**
 * 比较两个版本号。
 * @returns {number} 1 表示 a 更新，-1 表示 b 更新，0 表示相等
 */
export function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  // 有一边解析不了就当作相等，交给人工判断，不擅自提示更新
  if (!pa || !pb) return 0;

  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  // 预发行版本低于正式版：1.0.0-beta < 1.0.0
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** 通配写法 `0.5.x` / `0.x` / `*` 能不能匹配这个版本 */
function matchWildcard(version, token) {
  const v = parseVersion(version);
  if (!v) return false;
  const parts = String(token).replace(/^v/, '').split('.');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === 'x' || p === 'X' || p === '*') return true;
    if (Number(p) !== v.nums[i]) return false;
  }
  return true;
}

/** 单个比较符 */
function matchComparator(version, token) {
  const v = parseVersion(version);
  if (!v) return false;

  // 通配
  if (/[xX*]/.test(token)) return matchWildcard(version, token);

  const m = token.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) return false;
  const op = m[1] || '=';
  const target = m[2].trim();

  // ^ 与 ~ 先展开成上下界
  if (target.startsWith('^') || target.startsWith('~')) {
    const base = parseVersion(target.slice(1));
    if (!base) return false;
    const [maj, min, pat] = base.nums;

    let lower;
    let upper;
    if (target.startsWith('^')) {
      // npm 规则：^1.2.3 → <2.0.0；^0.2.3 → <0.3.0；^0.0.3 → <0.0.4
      lower = [maj, min, pat];
      if (maj > 0) upper = [maj + 1, 0, 0];
      else if (min > 0) upper = [0, min + 1, 0];
      else upper = [0, 0, pat + 1];
    } else {
      // ~1.2.3 → <1.3.0；~1.2 → <1.3.0
      lower = [maj, min, pat];
      upper = [maj, min + 1, 0];
    }

    const cmpLow = compareVersion(
      version,
      `${lower[0]}.${lower[1]}.${lower[2]}`,
    );
    const cmpHigh = compareVersion(
      version,
      `${upper[0]}.${upper[1]}.${upper[2]}`,
    );
    return cmpLow >= 0 && cmpHigh < 0;
  }

  const cmp = compareVersion(version, target);
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '<=':
      return cmp <= 0;
    case '>':
      return cmp > 0;
    case '<':
      return cmp < 0;
    default:
      return cmp === 0;
  }
}

/**
 * 版本是否落在范围内。
 * 范围写歪了（解析不了）按「满足」处理——宁可让插件装上跑出真错误，
 * 也别因为作者多打了个空格就拒绝加载。
 */
export function satisfies(version, range) {
  const r = String(range ?? '').trim();
  if (!r || r === '*' || r === 'x') return true;

  const v = parseVersion(version);
  if (!v) return true; // 框架自己版本号读不出来，别拦

  const groups = r.split('||').map((s) => s.trim()).filter(Boolean);
  for (const group of groups) {
    // 预发行版：范围里没写 `-` 就一律不满足
    if (v.pre && !group.includes('-')) continue;
    const tokens = group.split(/\s+/).filter(Boolean);
    if (tokens.every((t) => matchComparator(version, t))) return true;
  }
  return false;
}

/**
 * 框架自己发预发布版（`-beta.1` / `-next.1`）时，按**同号正式版基线**
 * 参与插件的兼容性判断。
 *
 * 为什么要分两层：`satisfies()` 的 npm 语义是「预发布版本不满足没写预发布号
 * 的范围」，这对「挑依赖版本」是对的，但用在框架版本上会变成——测试版框架
 * 把所有带 `frameworkVersion` 的插件全拒掉（`brain` 插件加载失败就是这么来的），
 * 测试版根本没法用。兼容性检查只看 x.y.z 够不够，不关心这次发的是不是预览。
 */
export function compatibilityVersion(v) {
  const p = parseVersion(v);
  return p ? p.nums.join('.') : String(v ?? '');
}

/** 框架 / engines 的兼容性判断入口；`satisfies()` 本身语义一个字不动 */
export function satisfiesFramework(version, range) {
  return satisfies(compatibilityVersion(version), range);
}

let cached = null;

/**
 * 当前框架版本。
 *
 * 同步读一次 package.json 然后缓存——插件加载是同步路径上的高频动作，
 * 每个插件都异步读一遍文件没必要，运行期版本号也不会变。
 */
export function frameworkVersion() {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    cached = JSON.parse(raw).version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
