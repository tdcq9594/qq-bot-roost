import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rel } from '../paths.js';
import { buildPluginEnv } from './env.js';

/**
 * 插件依赖自动安装 + 运行时探测。
 *
 * 目标是「开箱即用」：用户把插件文件夹丢进 plugins/，第一次加载时
 * 缺什么装什么，不用自己去 pip install。
 *
 * 三条硬原则：
 *   1. **隔离**：Python 依赖装进插件目录下的 .venv，Node 依赖装进插件目录下的
 *      node_modules。绝不碰系统环境，也不碰别的插件。
 *   2. **幂等**：算 requirements/package.json 的哈希存进 .deps.json，
 *      内容没变就跳过，不会每次启动都联网。
 *   3. **失败要能看懂**：装不上时抛出带原因的错误，而不是让插件神秘地起不来。
 */

const INSTALL_TIMEOUT = 180_000;
const MARKER = '.deps.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 跑一个命令，收集输出 */
function run(cmd, args, { cwd, timeout = INSTALL_TIMEOUT, env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      // 净化：只放行必需变量 + 代理/镜像源，绝不透传 QQ_* / ROOST_*
      env: buildPluginEnv(env),
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
    });

    const finish = (code, reason = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out, err, reason });
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(-1, `超时（${Math.round(timeout / 1000)} 秒）`);
    }, timeout);
    timer.unref?.();

    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => finish(-1, e.message));
    child.on('exit', (code) => finish(code ?? -1));
  });
}

/** 命令能不能跑 */
async function usable(cmd, args = ['--version']) {
  try {
    const r = await run(cmd, args, { timeout: 8000 });
    return r.ok;
  } catch {
    return false;
  }
}

/* ---------------- 运行时探测 ---------------- */

let cachedRuntimes = null;

const IS_WIN = process.platform === 'win32';

/** npm 的安装参数。`--ignore-scripts` 见下面调用处的注释 */
const NPM_ARGS = ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'];

/**
 * pnpm 的安装参数。
 *
 * `--config.node-linker=hoisted`：默认的 pnpm 用软链把 `node_modules` 指到全局
 * store，插件是被人手动丢进 `plugins/` 的，不归 pnpm 管；store 一清，
 * `import` 就断。hoisted 给的是跟 npm 一样的扁平目录，行为最可预期。
 *
 * `--ignore-workspace`：插件目录万一落在某个 pnpm workspace 里面（用户把
 * Roost 放在自己项目里就会），pnpm 会拒绝安装并让你去 workspace 根装。
 */
const PNPM_ARGS = ['install', '--prod', '--ignore-scripts', '--config.node-linker=hoisted', '--ignore-workspace'];

/**
 * DSH 桌面版自带的运行时目录。
 *
 * **为什么必须找它**：DSH 是 Electron，安装目录里既没有 `node.exe` 也没有
 * npm；但它自己带了一整套运行时（node / pnpm / python），放在
 * `~/.dsh/dsh-runtimes/<runtime>/dependencies/` 下——DSH 装插件用的就是那套 pnpm。
 *
 * 只查 PATH 的后果很严重：没单独装过 Node.js 的用户 PATH 里当然没有 npm，
 * 于是任何带依赖的插件都会「缺少 npm」而**整个加载失败**，
 * 明明机器上有一套现成能用的。
 */
export function bundledRuntimeRoots({ home = os.homedir() } = {}) {
  const base = path.join(home, '.dsh', 'dsh-runtimes');
  const out = [];
  try {
    for (const name of readdirSync(base)) {
      const dir = path.join(base, name, 'dependencies');
      if (existsSync(dir)) out.push(dir);
    }
  } catch {
    // 没有这个目录很正常：用户可能根本没装 DSH 桌面版
  }
  // 名字里带 primary 的排前面——DSH 自己也优先用它
  return out.sort((a, b) => Number(b.includes('primary')) - Number(a.includes('primary')));
}

/** 在若干运行时根目录里找同一个相对路径，找到就返回绝对路径 */
function pickIn(roots, ...segs) {
  for (const r of roots) {
    const p = path.join(r, ...segs);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 找出这台机器上能用的 Python / Node 命令，以及「用谁来装 Node 依赖」。
 * 只在第一次调用时真正探测，之后走缓存。
 *
 * 返回里的 `installer` 是个描述符 `{ kind, cmd, args, label }`——
 * 因为 npm 和 pnpm 的参数不一样，而且 DSH 自带的 pnpm 还得靠自带的 node 去跑，
 * 光有一个命令名表达不了。
 */
export async function detectRuntimes({ refresh = false } = {}) {
  if (cachedRuntimes && !refresh) return cachedRuntimes;

  const pythonCandidates =
    process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  let python = null;
  for (const c of pythonCandidates) {
    // py 启动器要带 -3 才是 Python 3
    const args = c === 'py' ? ['-3', '--version'] : ['--version'];
    if (await usable(c, args)) {
      python = c;
      break;
    }
  }

  const npmCandidates =
    process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  let npm = null;
  for (const c of npmCandidates) {
    if (await usable(c)) {
      npm = c;
      break;
    }
  }

  // PATH 上的 pnpm：装了 Node.js 的人常常也装了它，参数比 npm 好控
  let pnpm = null;
  for (const c of IS_WIN ? ['pnpm.cmd', 'pnpm'] : ['pnpm']) {
    if (await usable(c)) {
      pnpm = c;
      break;
    }
  }

  /* ---------- DSH 自带运行时（PATH 上找不到时的兜底） ---------- */
  const roots = bundledRuntimeRoots();
  const bundledNode = pickIn(roots, 'node', 'bin', IS_WIN ? 'node.exe' : 'node');
  const bundledPnpm = pickIn(roots, 'pnpm', 'bin', 'pnpm.cjs');
  const bundledPython = IS_WIN
    ? pickIn(roots, 'python', 'python.exe')
    : (pickIn(roots, 'python', 'bin', 'python3') || pickIn(roots, 'python', 'bin', 'python'));

  // 系统 Python 优先（用户可能装了带自己库的那个），找不到才用自带的
  if (!python && bundledPython) python = bundledPython;

  /**
   * 装依赖用哪个工具。顺序：npm → pnpm → DSH 自带 pnpm。
   *
   * 自带 pnpm 必须用**自带的 node** 去跑 `pnpm.cjs`，不能用 `process.execPath`：
   * 那是 DSH 的 Electron 主程序，只有在带 `ELECTRON_RUN_AS_NODE` 时才当 node 用，
   * 而这个变量不在 `buildPluginEnv` 的白名单里，直接跑会把 GUI 拉起来。
   */
  let installer = null;
  if (npm) {
    installer = { kind: 'npm', cmd: npm, args: NPM_ARGS, label: 'npm' };
  } else if (pnpm) {
    installer = { kind: 'pnpm', cmd: pnpm, args: PNPM_ARGS, label: 'pnpm' };
  } else if (bundledPnpm && bundledNode) {
    installer = { kind: 'dsh-pnpm', cmd: bundledNode, args: [bundledPnpm, ...PNPM_ARGS], label: 'DSH 自带 pnpm' };
  }

  cachedRuntimes = {
    python,
    npm,
    pnpm,
    node: process.execPath,
    installer,
    bundled: { node: bundledNode, pnpm: bundledPnpm, python: bundledPython },
  };
  return cachedRuntimes;
}

/* ---------------- 依赖安装 ---------------- */

async function readIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readMarker(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, MARKER), 'utf8'));
  } catch {
    return {};
  }
}

async function writeMarker(dir, data) {
  await fs.writeFile(path.join(dir, MARKER), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const hashOf = (text) => createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);

/** venv 里的 python 路径 */
function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/**
 * requirements.txt 单行的白名单。
 *
 * 只接受「包名 + 版本约束」（可带 extras、可带环境标记）这一种形态，其它一律拒。
 * 不能用黑名单——pip 的选项缩写太多（`-i` = `--index-url`、`-c` = 约束文件、
 * `-r` = 嵌套 requirement、`--no-index`、`--pre`…），黑名单列不完，
 * 漏一个就是一条供应链后门：插件作者能把 pip 指到任意源、拉任意代码。
 *
 * 环境标记里也不许出现 `--`，否则 `pkg; x --index-url evil` 会绕过这条意图。
 */
const REQUIREMENT_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?(?:\s*(?:==|>=|<=|~=|!=|===|>|<)\s*[^\s,]+(?:\s*,\s*[^\s,]+)*)?(?:\s*;\s*(?:(?!--)[^\n])+)?$/;

/**
 * pip 自己的注释规则（见 pip._internal.req.req_file.COMMENT_RE）：(^|\s+)#.*$
 * 套白名单前必须按同样规则剥掉，否则 `requests>=2.31  # 固定下限` 这种合法写法
 * 会被误杀——这里是 throw，误杀等于整个插件装不上。
 */
const stripReqComment = (l) => l.replace(/(^|\s+)#.*$/, '').trim();

/**
 * 校验 requirements.txt 全文。
 * 抽成独立函数是为了能直接测：白名单一旦被改坏（拒了合法行 / 放了危险行），
 * 靠构造假 python 走 ensurePluginDeps 很难测全。
 *
 * @param {string} requirements 文件全文
 * @returns {{ok: true} | {ok: false, line: string}} line 是第一条不安全的行（已剥注释）
 */
export function checkRequirements(requirements) {
  const bad = String(requirements ?? '')
    .split(/\r?\n/)
    .map((l) => stripReqComment(l.trim()))
    .find((l) => l !== '' && !REQUIREMENT_RE.test(l));
  return bad === undefined ? { ok: true } : { ok: false, line: bad };
}

/**
 * 确保插件的依赖装好。
 *
 * @param {object} p
 * @param {string} p.dir      插件目录
 * @param {object} p.manifest plugin.json 内容
 * @param {object} p.log      日志器
 * @param {boolean} [p.enabled] 是否允许自动安装（来自 config.plugins.autoInstallDeps）
 * @param {object} [p.runtimes] 直接指定运行时探测结果，跳过 detectRuntimes()。
 *   **只给测试用**：`detectRuntimes()` 带全局缓存，测「一个工具都没有」这条分支
 *   只能靠伪造 PATH / HOME，会把别的测试带歪。
 * @returns {Promise<{python?:string, installed:string[], skipped:string[], warnings:string[]}>}
 */
export async function ensurePluginDeps({ dir, manifest = {}, log = null, enabled = true, runtimes = null }) {
  const result = { python: null, installed: [], skipped: [], warnings: [] };
  // 统一转绝对路径：下面给 pip / npm 传的路径和 cwd 都以它为准，避免相对路径被拼两次
  dir = path.resolve(dir);
  const runtime = String(manifest.runtime ?? '').toLowerCase();
  const wantsPython = runtime === 'python' || runtime === 'python3';

  // 一次探测，两处用；注入的优先
  let rt = runtimes;
  const getRt = async () => (rt ??= await detectRuntimes());

  const reqFile = path.join(dir, 'requirements.txt');
  const pkgFile = path.join(dir, 'package.json');
  const requirements = await readIfExists(reqFile);
  const pkgText = await readIfExists(pkgFile);

  // 先确定 Python 解释器：有 venv 用 venv 的，没有就找系统的
  if (wantsPython) {
    const rt = await getRt();
    if (!rt.python) {
      throw new Error(
        '这个插件需要 Python，但系统里找不到 python / python3 / py，也没找到 DSH 自带的 Python。\n' +
          '请先安装 Python 3.9+（https://www.python.org/downloads/），装完重试。',
      );
    }
    result.python = rt.python;
  }

  const marker = await readMarker(dir);
  // 注意用 !== null 判断：空文件也是「有这个文件」，只是没内容
  const wantReq = requirements !== null ? hashOf(requirements) : null;
  const wantPkg = pkgText !== null ? hashOf(pkgText) : null;

  /* ---------- Python ---------- */
  if (wantsPython && requirements !== null) {
    const venvDir = path.join(dir, '.venv');
    const py = venvPython(venvDir);

    const venvOk = await fs
      .access(py)
      .then(() => true)
      .catch(() => false);

    const needInstall = !venvOk || marker.requirements !== wantReq;

    if (!needInstall) {
      result.skipped.push('Python 依赖（未变化）');
      result.python = py;
    } else if (!enabled) {
      result.warnings.push(
        '检测到 requirements.txt 需要安装，但 config 里 plugins.autoInstallDeps = false，已跳过',
      );
      if (venvOk) result.python = py;
    } else {
      log?.info(`安装 Python 依赖（${rel(reqFile)}），首次会慢一点…`);

      /**
       * requirements.txt 里能写 `--index-url`、`-e git+...`、直接写 URL——
       * 等于让插件作者把 pip 指到任意源、拉任意代码。
       * 白名单的细节和理由见上面的 checkRequirements()。
       */
      const rq = checkRequirements(requirements);
      if (!rq.ok) {
        throw new Error(
          `requirements.txt 里有不安全的行，已拒绝安装：${rq.line}\n` +
            '只允许「包名 + 版本约束」（如 requests>=2.31），不接受 -e / --index-url / 直接 URL / pip 选项。' +
            '行尾注释可以写（`# xxx`），但不支持反斜杠续行。',
        );
      }

      if (!venvOk) {
        log?.info('创建隔离环境 .venv');
        const made = await run(result.python, ['-m', 'venv', venvDir], { cwd: dir });
        if (!made.ok) {
          throw new Error(
            `创建虚拟环境失败：${made.reason || made.err.slice(-400)}\n` +
              '可以手动执行：python -m venv .venv',
          );
        }
      }

      const pip = await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqFile], {
        cwd: dir,
      });
      if (!pip.ok) {
        throw new Error(
          `安装 Python 依赖失败：${pip.reason || (pip.err || pip.out).slice(-600)}\n` +
            `可以手动执行：${rel(py)} -m pip install -r requirements.txt`,
        );
      }
      result.installed.push('Python 依赖');
      result.python = py;
      marker.requirements = wantReq;
      await writeMarker(dir, marker);
    }
  }

  /* ---------- Node ---------- */
  if (pkgText !== null) {
    let pkg = null;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      result.warnings.push('package.json 不是合法 JSON，已跳过依赖安装');
    }

    /**
     * **必装和可选必须分开。**
     *
     * `dependencies` 缺了插件就是坏的；`optionalDependencies` 缺了只是某个功能
     * 用不了。以前两者合并成一个列表，于是「语音这种可选能力」能把整个插件
     * 拦在门外：找不到 npm 就 throw，`loader.js` 接住之后插件直接不加载。
     * ai-chat 就是这么在没装 Node.js 的机器上整个起不来的。
     */
    const required = pkg ? Object.keys(pkg.dependencies ?? {}) : [];
    const optional = pkg ? Object.keys(pkg.optionalDependencies ?? {}) : [];
    const all = [...new Set([...required, ...optional])];

    if (all.length) {
      const hasModules = await fs
        .access(path.join(dir, 'node_modules'))
        .then(() => true)
        .catch(() => false);
      const needInstall = !hasModules || marker.packageJson !== wantPkg;

      if (!needInstall) {
        result.skipped.push('Node 依赖（未变化）');
      } else if (!enabled) {
        result.warnings.push(
          '检测到 package.json 依赖需要安装，但 config 里 plugins.autoInstallDeps = false，已跳过',
        );
      } else {
        const rt = await getRt();
        if (!rt.installer) {
          // 必装缺工具才算致命；可选缺工具只丢功能，不能让插件起不来
          if (required.length) {
            throw new Error(
              `这个插件需要 ${required.length} 个 Node 依赖（${required.join('、')}），`
                + '但系统里既没有 npm 也没有 pnpm，也没找到 DSH 自带的运行时。\n'
                + '装一个 Node.js（https://nodejs.org/）再重启即可。',
            );
          }
          result.warnings.push(
            `有 ${optional.length} 个可选依赖（${optional.join('、')}）没装：`
              + '找不到 npm / pnpm，也没找到 DSH 自带的运行时。相关功能会不可用，其余功能正常。',
          );
        } else {
          log?.info(
            `安装 Node 依赖（${all.length} 个，用 ${rt.installer.label}）`
              + `${optional.length && !required.length ? '，都是可选的' : ''}，首次会慢一点…`,
          );
          // --ignore-scripts：依赖的 postinstall 就是任意代码执行入口，
          // 装依赖不该顺带跑别人的安装脚本
          const r = await run(rt.installer.cmd, rt.installer.args, { cwd: dir });
          const detail = `${r.reason || (r.err || r.out).slice(-600)}\n`
            + `可以手动执行：cd ${rel(dir)} && ${rt.installer.label} install`;
          if (!r.ok) {
            if (required.length) throw new Error(`安装 Node 依赖失败：${detail}`);
            result.warnings.push(`可选依赖没装上（不影响主功能）：${detail}`);
          } else {
            result.installed.push(`Node 依赖（${rt.installer.label}）`);
          }
          // 装过就记账（成不成功都记）。**不能靠它拦住重试**——
          // 失败时 node_modules 仍然不存在，上面 `!hasModules` 会让下次加载再试一遍
          marker.packageJson = wantPkg;
          await writeMarker(dir, marker);
        }
      }
    }
  }

  // 给个喘息机会，避免连续装多个插件时把机器打满
  if (result.installed.length) await sleep(50);
  return result;
}
