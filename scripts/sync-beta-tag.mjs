#!/usr/bin/env node
/**
 * 把 npm 的 `beta` 标签对齐到当前正式版。
 *
 * 规则（2026-11-17 主人定）：**正式版版本号比 beta 高时，把 beta 指到最新版**。
 * 否则 `npm i <pkg>@beta` 会装到很旧的预发布版——那条通道看起来还在维护，
 * 实际给的是半年前的快照。
 *
 * 反过来不动：beta 比 latest 新（`1.1.3-beta.1` vs `1.1.2`）时保持原样，
 * 那是真的预发布通道，吞掉它等于把测试中的版本藏了。
 *
 * 用法：
 *   node scripts/sync-beta-tag.mjs              # 两个包都检查
 *   node scripts/sync-beta-tag.mjs qq-bot-roost # 只查一个
 *   node scripts/sync-beta-tag.mjs --dry-run    # 只打印，不改
 *
 * 退出码：0 = 已对齐或无需改动；1 = 失败
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_DEFAULTS = ['qq-bot-roost', 'dsh-roost'];

/**
 * 比较版本号。只认 `x.y.z` 和 `x.y.z-pre`（npm 上我们只发这两种）。
 *
 * 规则：先比 core，再比有没有 prerelease——**没有 pre 的更大**（1.1.2 > 1.1.2-rc.1）。
 * 认不出的版本返回 0（相等）：宁可不改，也不要因为解析失败把 beta 乱指。
 *
 * @returns {number} >0 表示 a 更新；0 相等；<0 更旧
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v ?? '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;

  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre);
}

/** 拉 dist-tags：走公共 registry，不需要认证 */
async function distTags(pkg) {
  const r = await fetch(`https://registry.npmjs.org/-/package/${encodeURIComponent(pkg)}/dist-tags`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`查 dist-tags 失败：HTTP ${r.status}`);
  return await r.json();
}

/** 令牌只在本地配置里，不进仓库 */
function npmToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config/bot.json'), 'utf8'));
    return String(cfg?.network?.npmToken ?? '');
  } catch {
    return '';
  }
}

function setTag(pkg, version, token) {
  const rc = path.join(os.tmpdir(), `npmrc-beta-${process.pid}`);
  fs.writeFileSync(rc, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  try {
    const env = { ...process.env };
    /** 本机系统代理经常是坏的，允许显式指定（如 http://127.0.0.1:7892） */
    if (process.env.ROOST_NPM_PROXY) {
      env.HTTPS_PROXY = process.env.ROOST_NPM_PROXY;
      env.HTTP_PROXY = process.env.ROOST_NPM_PROXY;
    }
    const r = spawnSync('npm', ['dist-tag', 'add', `${pkg}@${version}`, 'beta', '--userconfig', rc], {
      encoding: 'utf8',
      env,
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim() || `exit ${r.status}`);
  } finally {
    fs.rmSync(rc, { force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const pkgs = argv.filter((a) => !a.startsWith('--'));
  const packages = pkgs.length ? pkgs : PACKAGE_DEFAULTS;

  let bad = 0;
  for (const pkg of packages) {
    try {
      const tags = await distTags(pkg);
      const latest = String(tags.latest ?? '');
      const beta = String(tags.beta ?? '');
      if (!latest) {
        console.log(`? ${pkg}：没有 latest 标签，跳过`);
        continue;
      }
      if (!beta) {
        console.log(`· ${pkg}：没有 beta 标签（latest=${latest}），不新建`);
        continue;
      }
      if (compareVersions(latest, beta) <= 0) {
        console.log(`✓ ${pkg}：beta=${beta} 不低于 latest=${latest}，不动`);
        continue;
      }
      if (dryRun) {
        console.log(`→ ${pkg}：会把 beta 从 ${beta} 移到 ${latest}（dry-run，未执行）`);
        continue;
      }
      const token = npmToken();
      if (!token) throw new Error('读不到 config/bot.json 的 network.npmToken（请在 bot 仓根目录跑）');
      setTag(pkg, latest, token);
      console.log(`✓ ${pkg}：beta ${beta} → ${latest}`);
    } catch (e) {
      bad += 1;
      console.error(`✗ ${pkg}：${e?.message ?? e}`);
    }
  }
  return bad ? 1 : 0;
}

/** 只有直接运行时才执行；被测试 import 时不要跑去连网络 */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(await main());
}
