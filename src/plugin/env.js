/**
 * 插件相关的环境变量白名单（单一来源）。
 *
 * 子进程运行时（subprocess.js）和依赖安装（deps.js）都从这里取，
 * 避免「运行时隔离了、安装时却把 AppSecret 漏出去」这类漂移。
 *
 * 原则：只放行「跑起来必需」的变量。密钥、面板口令、webhook 配置一概不给。
 */

/** 运行/安装都需要的：定位解释器、语言运行时 home、编码 */
export const BASE_ENV_ALLOW = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'PYTHONPATH',
  'PYTHONHOME',
  'VIRTUAL_ENV',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'NODE_PATH',
];

/** 依赖安装额外需要：代理与镜像源（pip / npm） */
export const NET_ENV_ALLOW = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'PIP_INDEX_URL',
  'PIP_TRUSTED_HOST',
  'PIP_EXTRA_INDEX_URL',
  'npm_config_registry',
  'npm_config_proxy',
  'npm_config_https_proxy',
];

/** 子进程运行时环境（基础变量；代理由插件按 manifest.env 自行声明） */
export function inheritedEnv() {
  const out = {};
  for (const k of BASE_ENV_ALLOW) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return out;
}

/**
 * 依赖安装用的净化环境：基础变量 + 代理/镜像源。
 * **绝不**透传 QQ_* / ROOST_*（AppSecret、面板口令、webhook 密钥）。
 */
export function buildPluginEnv(extra = {}) {
  const out = {};
  for (const k of [...BASE_ENV_ALLOW, ...NET_ENV_ALLOW]) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  return { ...out, ...extra };
}
