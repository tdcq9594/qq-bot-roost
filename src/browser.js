import { spawn } from 'node:child_process';

/**
 * 各平台「用默认浏览器打开网址」的命令。
 *
 *   Windows  cmd /c start "" "url"   （start 是 cmd 内建命令，空串是窗口标题占位）
 *   macOS    open url
 *   Linux    xdg-open url
 *
 * 单独拆出来是为了能测：不真正拉起进程，只断言命令拼对了。
 *
 * @param {string} url
 * @param {NodeJS.Platform} [platform]
 * @returns {{cmd:string, args:string[]}|null}
 */
export function browserCommand(url, platform = process.platform) {
  if (!url) return null;
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * 用系统默认浏览器打开一个地址。
 * 失败不抛错——打不开浏览器不该影响机器人本身跑起来。
 *
 * @param {string} url
 * @returns {boolean} 是否成功把命令拉起来
 */
export function openBrowser(url) {
  const picked = browserCommand(url);
  if (!picked) return false;

  try {
    const child = spawn(picked.cmd, picked.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // 命令不存在（比如精简版 Linux 没装 xdg-open）时只留个空处理器，别让进程崩
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
