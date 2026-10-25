import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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

/**
 * 找出这台机器上能用的 Python / Node 命令。
 * 只在第一次调用时真正探测，之后走缓存。
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

  cachedRuntimes = { python, npm, node: process.execPath };
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
 * 确保插件的依赖装好。
 *
 * @param {object} p
 * @param {string} p.dir      插件目录
 * @param {object} p.manifest plugin.json 内容
 * @param {object} p.log      日志器
 * @param {boolean} [p.enabled] 是否允许自动安装（来自 config.plugins.autoInstallDeps）
 * @returns {Promise<{python?:string, installed:string[], skipped:string[], warnings:string[]}>}
 */
export async function ensurePluginDeps({ dir, manifest = {}, log = null, enabled = true }) {
  const result = { python: null, installed: [], skipped: [], warnings: [] };
  // 统一转绝对路径：下面给 pip / npm 传的路径和 cwd 都以它为准，避免相对路径被拼两次
  dir = path.resolve(dir);
  const runtime = String(manifest.runtime ?? '').toLowerCase();
  const wantsPython = runtime === 'python' || runtime === 'python3';

  const reqFile = path.join(dir, 'requirements.txt');
  const pkgFile = path.join(dir, 'package.json');
  const requirements = await readIfExists(reqFile);
  const pkgText = await readIfExists(pkgFile);

  // 先确定 Python 解释器：有 venv 用 venv 的，没有就找系统的
  if (wantsPython) {
    const rt = await detectRuntimes();
    if (!rt.python) {
      throw new Error(
        '这个插件需要 Python，但系统里找不到 python / python3 / py。\n' +
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
       * 等于让插件作者把 pip 指到任意源、拉任意代码。这里只接受「包名 + 版本约束」。
       */
      const badLine = requirements
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && /^(-e|--index-url|--extra-index-url|--find-links|--trusted-host|[a-z]+:\/\/|git\+)/i.test(l));
      if (badLine) {
        throw new Error(
          `requirements.txt 里有不安全的行，已拒绝安装：${badLine}\n` +
            '只允许「包名 + 版本约束」（如 requests>=2.31），不接受 -e / --index-url / 直接 URL。',
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
    const deps = pkg ? Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}) }) : [];
    if (deps.length) {
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
        const rt = await detectRuntimes();
        if (!rt.npm) {
          throw new Error('这个插件需要 npm 安装依赖，但系统里找不到 npm（通常随 Node.js 一起安装）');
        }
        log?.info(`安装 Node 依赖（${deps.length} 个），首次会慢一点…`);
        // --ignore-scripts：依赖的 postinstall 就是任意代码执行入口，
        // 装依赖不该顺带跑别人的安装脚本
        const r = await run(
          rt.npm,
          ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
          { cwd: dir },
        );
        if (!r.ok) {
          throw new Error(
            `安装 Node 依赖失败：${r.reason || (r.err || r.out).slice(-600)}\n` +
              `可以手动执行：cd ${rel(dir)} && npm install`,
          );
        }
        result.installed.push('Node 依赖');
        marker.packageJson = wantPkg;
        await writeMarker(dir, marker);
      }
    }
  }

  // 给个喘息机会，避免连续装多个插件时把机器打满
  if (result.installed.length) await sleep(50);
  return result;
}
