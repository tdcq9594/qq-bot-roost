/**
 * 把一段文字画成二维码（SVG 字符串）。
 *
 * 为什么**服务端画**：DSH 的插件前端只有一个 client.js 入口，
 * 再往里塞一个 QR 库既占体积又要改加载方式。服务端画好直接给 `<svg>` 字符串，
 * 前端一句 innerHTML 就完事。
 *
 * 库是 `qrcode-generator` 1.4.4（MIT，Kazuhiko Arase），放在 web/vendor/。
 * 它是 UMD：本仓是 ESM（package.json "type": "module"），直接 import 拿不到，
 * 所以在 vm 里当浏览器脚本跑一遍，取全局 `qrcode`——不需要任何依赖。
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let qrcode = null;

function lib() {
  if (qrcode) return qrcode;
  const src = readFileSync(new URL('../../web/vendor/qrcode.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (typeof sandbox.qrcode !== 'function') throw new Error('QR 库没加载上（vendor/qrcode.js 坏了？）');
  qrcode = sandbox.qrcode;
  return qrcode;
}

/**
 * @param {string} text 要编码的内容
 * @param {{cellSize?:number, margin?:number}} [opt]
 * @returns {string} 完整 `<svg>…</svg>`
 */
export function toSvg(text, { cellSize = 4, margin = 6 } = {}) {
  const qr = lib()(0, 'M'); // 0 = 自动选版本，M = 中等纠错
  qr.addData(String(text));
  qr.make();
  return qr.createSvgTag({ cellSize, margin });
}
