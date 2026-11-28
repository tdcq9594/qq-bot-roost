/**
 * 阶段 2：TS 影子编译行为对照测试
 * ================================
 *
 * 证明 tsc 编译产物与原手写 JS 行为一致——这是后续把所有叶子模块
 * 改名成 .ts 的前提假设。如果这条测试挂了，说明"编译 ≡ 原码"不成立，
 * 整个 TS 迁移方案必须重审。
 *
 * 只测纯函数模块 fsutil（无网络、无宿主依赖），覆盖：
 *   - 正常写入 / 读取（含 emoji / 大整数）
 *   - 嵌套目录自动创建
 *   - 文件不存在（ENOENT）
 *   - 坏 JSON → 留档 + 返回 null + 回调收到消息
 *
 * **CI 兼容**：CI 不跑 npm install（无 lock 文件），node_modules/.bin/tsc 不存在。
 * 这种情况下测试 SKIP（影子编译是开发期辅助验证，不是运行时功能），
 * 本机装了 devDependencies 时会真编译并对照。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGINAL = path.join(ROOT, 'src', 'fsutil.js');
const SHADOW_DIR = path.join(ROOT, 'typecheck', 'shadow');
const SHADOW_OUT = path.join(SHADOW_DIR, 'out', 'fsutil.js');
const TSC = path.join(ROOT, 'node_modules', '.bin', 'tsc');

function exists(p) {
  try {
    fsSync.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 对每个实现跑同一组场景，返回可比较的结果 */
async function runScenario(mod, dir) {
  const results = {};

  // 1. 正常写入 + 读取（emoji / 大整数）
  const file = path.join(dir, 'sub', 'normal.json');
  await mod.writeJsonAtomic(file, { a: 1, b: '中文 😀', big: 9007199254740991 });
  results.normal = await mod.readJsonSafe(file);

  // 2. 写出的字节形状（序列化格式必须一致）
  results.raw = await fs.readFile(file, 'utf8');

  // 3. 文件不存在
  results.missing = await mod.readJsonSafe(path.join(dir, 'none.json'));

  // 4. 坏 JSON → 留档 + 回调
  const bad = path.join(dir, 'bad.json');
  await fs.writeFile(bad, '{not json', 'utf8');
  const errors = [];
  results.bad = await mod.readJsonSafe(bad, (m) => errors.push(m));
  // 备份文件名带时间戳，只比较"有没有留下备份 + 回调是否提到解析失败"
  results.badBackups = (await fs.readdir(dir)).filter((x) => x.startsWith('bad.json.corrupt-')).length;
  results.badErrorHasParse = errors.some((m) => m.includes('解析失败'));

  return results;
}

test('TS 影子编译产物与原 JS 行为一致', { skip: !exists(TSC) && '未装 devDependencies（tsc 不存在），跳过影子编译对照' }, async () => {
  // CI 干净环境没 tsc 时上面已 SKIP；这里能进来说明 tsc 可用
  if (!exists(SHADOW_OUT)) {
    const r = spawnSync(TSC, ['-p', path.join(SHADOW_DIR, 'tsconfig.json')], {
      cwd: SHADOW_DIR,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, `影子编译失败：${r.stderr || r.stdout}`);
  }

  const original = await import(pathToFileURL(ORIGINAL).href);
  const compiled = await import(pathToFileURL(SHADOW_OUT).href);

  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-shadow-a-'));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-shadow-b-'));
  try {
    const a = await runScenario(original, dirA);
    const b = await runScenario(compiled, dirB);
    assert.deepEqual(a, b, '编译产物与原 JS 行为不一致');
  } finally {
    await fs.rm(dirA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dirB, { recursive: true, force: true }).catch(() => {});
  }
});
