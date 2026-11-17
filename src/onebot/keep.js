/**
 * OneBot 独占模式下还放行的内核命令。
 *
 * 为什么只留这四条：OneBot 客户端里每个 QQ 号是**合成号**，要还原成真 QQ 号，
 * 只能靠 `identity` 里的绑定表；而用户在客户端里发消息绑不了号，只能回 QQ 里发命令。
 * 一刀切掉所有命令 = ID 映射永远对不上，主人权限、群号全是错的（第一版就这么踩过）。
 *
 * 其余内核命令（help / menu / ping / status / stats / admin / claim / whoami /
 * plugins / enable / disable / 群插件 / reload）**一律静默**：独占的语义是
 * 「对话交给客户端」，群里再多一条内核菜单就是噪音；要管理去面板或客户端，
 * 那边有完整上下文，也不打扰群里的人。
 *
 * 单独一个文件是为了能脱离 bot.js 的重依赖单测——这条规则很容易被顺手改宽，
 * 而改宽的后果（群里冒菜单）在测试里看不出来，只能靠用例钉住。
 */
export const ONEBOT_KEEP_COMMANDS = Object.freeze([
  '绑定qq',
  'qq验证码',
  '绑定群号',
  '绑定成员',
]);

const KEEP = new Set(ONEBOT_KEEP_COMMANDS);

/**
 * 这条内核命令在独占模式下该不该执行。
 *
 * 入参给注册名（`commandEntry.name`）或消息里解析出的命令名都行：
 * 统一 trim + 小写再比，`绑定QQ` 和 `绑定qq` 是同一个命令。
 */
export function onebotAllowsCore(name) {
  return KEEP.has(String(name ?? '').trim().toLowerCase());
}
