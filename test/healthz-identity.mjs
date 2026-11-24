/**
 * /healthz 的身份指纹
 * ==================
 *
 * `/healthz` 是免密钥探活接口，回环上谁都能答。以前它只回 bots 计数，
 * dsh-roost 只能靠「有 bots 数组」判在跑——另一个目录的 Roost 占着
 * 同一个端口就会被认成「本目录在跑」，随后端口、密钥、机器人配置全串
 * 到那份实例上，界面还看起来一切正常。
 *
 * 现在多回一个 `dirHash`（代码根路径的 sha256 前 12 位）。这里钉两件事：
 *   · 算法口径：dsh-roost 用同一套规范化 + 同一段哈希长度，否则永远对不上
 *   · 接线：字段真的进了 healthz 响应，且不把明文路径送给匿名请求
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { healthDirHash } from '../src/web/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('healthDirHash：尾斜杠 / 相对写法 / 盘符大小写都算同一份', () => {
  const a = healthDirHash(ROOT);
  assert.match(a, /^[a-f0-9]{12}$/, '12 位十六进制，不暴露路径');
  assert.equal(a, healthDirHash(ROOT + path.sep), '尾斜杠不该改变身份');
  assert.equal(a, healthDirHash(ROOT + path.sep + '.'), '/. 不该改变身份');
  if (process.platform === 'win32') {
    const lower = ROOT.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':');
    assert.equal(a, healthDirHash(lower), '盘符大小写不该改变身份');
  }
});

test('healthDirHash：不同目录必须不同', () => {
  assert.notEqual(healthDirHash(ROOT), healthDirHash(path.join(ROOT, 'data')), '另一份 Roost 不能混过去');
});

test('healthDirHash 口径与跨仓约定一致（sha256 前 12 位）', () => {
  const normalized = path.resolve(ROOT)
    .replace(/^([a-z]):/, (_, drive) => drive.toUpperCase() + ':');
  assert.equal(
    healthDirHash(ROOT),
    crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  );
});

test('接线：/healthz 回 pid + dirHash，不回明文路径', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  const at = src.indexOf("pathname === '/healthz'");
  assert.ok(at > 0, '要有 /healthz 分支');
  const block = src.slice(at, at + 6000);
  assert.ok(block.includes('pid: process.pid'), 'healthz 要回 pid，便于用户排查是哪份进程');
  assert.ok(block.includes('dirHash: healthDirHash(ROOT)'), 'healthz 要回身份指纹');
  assert.equal(/dirHash\s*:\s*ROOT\b/.test(block), false, '不能把本机路径明文回给匿名请求');
  assert.ok(block.includes('bots,') && block.includes('online,'), '老字段不能丢');
});
