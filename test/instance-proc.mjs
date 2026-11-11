/**
 * 实例锁的「这个 pid 还是不是 node」判据
 * ====================================
 *
 *   node --test test/instance-proc.mjs
 *
 * 背景：`isAlive()` 要靠「进程名像 node」来识别 **PID 复用**（系统把回收的 pid
 * 分给了别的程序）。判错的代价极不对称——判死会删锁 → 放行第二次认领 →
 * 同 AppID 双开 → 4902 互踢；判活顶多让用户手动清一条残留记录。
 *
 * 踩过两次，都是「只看了进程名的一个字段」：
 *
 *   1. 统一用 `ps -p <pid> -o comm=`，在 GitHub 的 ubuntu runner 上返回空串
 *      （进程明明活着）→ 活实例被判死。改成直接读 `/proc/<pid>/comm`。
 *   2. **Node 24 起把主线程名改成 `MainThread`**，`/proc/<pid>/comm` 读出
 *      `MainThread`，不含 `node` → 又判死。CI 的 `ubuntu-latest / Node 24.x`
 *      就是从 `同 AppID 已有活实例时拒绝启动` 这条断言红起来的。
 *
 * 修法是除了 comm 再核对 `cmdline` 与 `exe`，任一项命中就算活。判定逻辑拆成
 * 纯函数 `looksLikeNodeProc()` 才能在任何平台单测——真机上只有跑在对应系统上
 * 才观测得到 `/proc` 的内容，而这段逻辑恰恰是跨平台行为分叉的地方。
 *
 * 另一个必须锁住的点：**「读不到」不等于「没有证据」**。`/proc/<pid>/exe` 要
 * ptrace 权限，读别人的进程会 EACCES；`cmdline` 在非 dumpable 进程上也读不到。
 * 这时只剩 comm 可看，若仍按 comm 下结论，一个 `MainThread` 的活实例会被判死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { _looksLikeNodeProc } = await import('../src/instance.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'instance.js');

// ── Node 24 的现场：comm 已经是 MainThread ──────────────────────────────

test('comm 是 MainThread 但 cmdline 含 node：判活（CI 红的那一条）', () => {
  assert.equal(
    _looksLikeNodeProc({
      comm: 'MainThread',
      cmdline: '/opt/hostedtoolcache/node/24.9.0/x64/bin/node /home/runner/work/qq-bot-roost/index.js',
      exe: '/opt/hostedtoolcache/node/24.9.0/x64/bin/node',
    }),
    true,
  );
});

test('comm 是 MainThread、cmdline 读不到，只剩 exe 指向 node：判活', () => {
  assert.equal(
    _looksLikeNodeProc({ comm: 'MainThread', cmdline: null, exe: '/usr/local/bin/node' }),
    true,
  );
});

test('comm 是 MainThread、exe 读不到（跨用户 EACCES），只剩 cmdline：判活', () => {
  // 这条是「cmdline 作为唯一证据」的用例。删掉纯函数里对 cmdline 的判断，
  // 上面那条（三者都有）照样绿，只有这条会红。
  assert.equal(
    _looksLikeNodeProc({ comm: 'MainThread', cmdline: '/usr/bin/node app.js', exe: null }),
    true,
  );
});

test('comm 是 MainThread、另两项都读不到：判活，不拿 comm 单独定生死', () => {
  // 跨用户常驻 + `ProtectProc=invisible` 之类加固环境下的形态。
  // 这时若判死，又会绕回 4902 互踢——比留一条残留锁贵得多。
  assert.equal(_looksLikeNodeProc({ comm: 'MainThread' }), true);
  assert.equal(_looksLikeNodeProc({ comm: 'MainThread', cmdline: null, exe: null }), true);
});

// ── 拿不准的方向必须往「活着」倒 ─────────────────────────────────────────

test('comm 读不到（空串）：判活，不否定', () => {
  // 只有进程刚退出才会读到空，此时 kill(0) 那一步已经拦掉了；
  // 万一撞上竞态，方向要保守。
  assert.equal(_looksLikeNodeProc({}), true);
  assert.equal(_looksLikeNodeProc({ comm: '', cmdline: null, exe: null }), true);
});

test('读到证据且都不提 node：才判死', () => {
  // 这才是真的 PID 被复用：comm/cmdline/exe 都读到了，全都不提 node。
  assert.equal(
    _looksLikeNodeProc({
      comm: 'bash',
      cmdline: '/usr/bin/bash -i',
      exe: '/usr/bin/bash',
    }),
    false,
  );
});

test('别的解释器（python3）不误判成 node', () => {
  // 判据宽一点没关系（命中就活），但完全没提 node 的必须判死，
  // 否则 PID 复用永远识别不出来，残留锁永远清不掉。
  assert.equal(_looksLikeNodeProc({ comm: 'python3', cmdline: 'python3 a.py' }), false);
});

// ── 大小写 ──────────────────────────────────────────────────────────────

test('匹配不区分大小写', () => {
  assert.equal(_looksLikeNodeProc({ comm: 'NODE' }), true);
  assert.equal(_looksLikeNodeProc({ comm: 'MainThread', exe: '/usr/bin/Node' }), true);
});

// ── 接线守卫：光有纯函数没用，linux 分支必须真的读三处并全传进去 ────────

test('linux 分支同时读 comm / cmdline / exe 并交给纯函数', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const linuxBranch = src.slice(
    src.indexOf("if (process.platform === 'linux')"),
    src.indexOf("execFileSync('ps', ['-p', String(pid), '-o', 'comm=']"),
  );
  assert.ok(linuxBranch.length > 0, '没找到 linux 分支——选择器过期了，改测试');
  // 正则带上调用形式，避免被注释里的裸词满足
  assert.match(linuxBranch, /readFileSync\(`\/proc\/\$\{pid\}\/comm`/);
  assert.match(linuxBranch, /readFileSync\(`\/proc\/\$\{pid\}\/cmdline`/);
  assert.match(linuxBranch, /readlinkSync\(`\/proc\/\$\{pid\}\/exe`/);
  // 三项都要真的传进去，不能只传 comm
  assert.match(linuxBranch, /looksLikeNodeProc\(\{\s*comm,\s*cmdline,\s*exe\s*\}\)/);
  // 老的「只看 comm」写法不能再回来
  assert.doesNotMatch(linuxBranch, /return comm \? \/node\/i\.test\(comm\) : true/);
});
