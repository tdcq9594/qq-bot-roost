/**
 * 协议方法：开放平台 `dev.*`
 * ==========================
 *
 * 挂进宿主方法表之后，三边共用同一份实现：
 *   · 面板  → `/api/dev/*`（本机会话鉴权，不受协议 scope 限制）
 *   · dsh-roost / 任意语言插件 → `POST /rpc {method:'dev.bots'}`
 *   · 内核插件 → `ctx.dev`（见 `plugin/context.js`）
 *
 * ## scope 为什么这么分
 *
 * `dev.login.*` 给 `manage`：票据是该开发者**全部机器人**的管理权，等价于
 * 「能以宿主身份改平台配置」，和 `config.set` 同级。默认令牌没有 manage，
 * 所以面板能用、协议要显式开 `allowManage`——这道闸不能为了省事拆掉。
 *
 * 扫码那两条（`login.scan` / `login.scan.cancel`）额外多一层理由：它会
 * **在本机弹出浏览器窗口**并短暂开一个调试端口。远程客户端调它等于让宿主
 * 机器上凭空长出一个 GUI，所以除了 manage 还要求是本人操作（面板同机）。
 *
 * `dev.bot.set` 给 `message`：它改的是平台侧配置，不动框架权限，属于
 * 「对外做事」。但每条都要求显式 appid，并且会写审计日志。
 */

import { createDevPlatform } from '../dev/platform.js';

/** 协议层与 WebUI 共用一个实例：登录态只有一份，不能各建一个 */
let singleton = null;

export function getDevPlatform({ log = () => {} } = {}) {
  if (!singleton) {
    singleton = createDevPlatform({ log });
    /**
     * 第一次取实例就尝试恢复「记住的登录」。
     *
     * 不能只在 `registerDev()` 里恢复：面板可以独立于外接协议工作
     * （用户没启用 host 协议时那组方法根本不注册），只挂在那条路径上会
     * 出现「面板显示未登录、其实文件里有票」的错位。
     *
     * 不 await：构造是同步的，恢复失败也只是没登录，不该拖慢首个请求。
     */
    Promise.resolve()
      .then(() => singleton.load())
      .catch((e) => log(`[dev] 恢复登录态失败：${e?.message ?? e}`));
  }
  return singleton;
}

/** 测试用：丢掉单例，避免用例之间互相污染 */
export function resetDevPlatform() {
  singleton = null;
}

export function registerDev(def, { log = () => {} } = {}) {
  const P = getDevPlatform({ log });

  def('dev.status', 'read', '开放平台登录状态（不含票据）', async () => P.status());

  def('dev.session.check', 'read', '能不能干活：登录 / 账号里有几只 / 本机这只在不在（verify 才联网核）', async (p) => P.checkSession({
    verify: Boolean(p?.verify),
    // 协议层没有「面板选中的那只」，只做登录与账号层面的判断
    bound: p?.appid ? { id: '', name: '调用方指定', appid: String(p.appid) } : null,
  }));

  def('dev.bots', 'read', '当前开发者主体下的机器人列表', async () => {
    const bots = await P.listBots();
    return { bots };
  });

  def('dev.bot.get', 'read', '单个机器人的资料 / 连接方式 / IP 白名单', async (p) => {
    if (!p?.appid) throw Object.assign(new Error('要给 appid'), { http: 400 });
    return P.getBot(p.appid);
  });

  def('dev.bot.focus', 'read', '把扫码窗口切到该机器人的设置页（管理端是列表→详情两层）', async (p) => {
    if (!p?.appid) throw Object.assign(new Error('要给 appid'), { http: 400 });
    return P.focus(p.appid);
  });

  def('dev.bot.set', 'message', '改机器人资料 / 连接方式 / IP 白名单（必须显式 appid）', async (p) => {
    if (!p?.appid) throw Object.assign(new Error('要给 appid'), { http: 400 });
    return P.setBot(p.appid, p.patch ?? {});
  });

  def('dev.scope.get', 'read', '体验白名单：测试用户 + 白名单群（显式 appid）', async (p) => {
    if (!p?.appid) throw Object.assign(new Error('要给 appid'), { http: 400 });
    return P.getScope(p.appid);
  });

  /**
   * 加 / 删白名单成员。
   *
   * scope 定成 `message` 而不是 `read`：这条会改平台上的真实配置，和
   * 「改昵称」「改 IP 白名单」同级。只读插件不该能调它。
   */
  def('dev.scope.set', 'message', '加/删测试用户（QQ 号）或白名单群（群号），action 1 加 / 2 删', async (p) => {
    if (!p?.appid) throw Object.assign(new Error('要给 appid'), { http: 400 });
    return P.setScope(p.appid, { kind: p.kind, action: p.action, ids: p.ids });
  });

  def('dev.bot.avatar', 'message', '换机器人头像（appid + 图片 dataURL / 地址 / 已有 avatarId）', async (p) => {
    if (!p?.appid) throw Object.assign(new Error('要给 appid'), { http: 400 });
    return P.setAvatar(p.appid, p.src ?? {});
  });

  def('dev.login.scan', 'manage', '扫码登录：在本机拉起浏览器窗口，需要人在窗口里扫码（默认记住）', async (p) => P.startScan({ remember: p?.remember ?? true }));

  def('dev.login.scan.cancel', 'manage', '取消扫码并关闭浏览器窗口', async () => P.cancelScan());

  def('dev.login.import', 'manage', '备选：导入浏览器 Cookie 或 cURL，建立开发者会话', async (p) => {
    if (!p?.input) throw Object.assign(new Error('要给 Cookie 或 cURL 文本'), { http: 400 });
    return P.loginImport(p.input, { remember: p.remember ?? true });
  });

  def('dev.login.logout', 'manage', '清除本机保存的开放平台登录态（同时关掉扫码窗口）', async () => P.logout());

  def('dev.session.remember', 'manage', '登录后改「要不要记住」：立刻写盘或删盘，不用重登', async (p) => P.setRemember(p?.remember ?? true));

  def('dev.browser.set', 'manage', '指定扫码用的浏览器可执行文件路径（空 = 自动探测）', async (p) => P.setBrowserPath(p?.path ?? ''));

  return P;
}
