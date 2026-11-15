/**
 * 昵称同步
 * ========
 *
 * 本机的 `cfg.name` 是**面板/日志里的显示名**，跟平台上的机器人昵称是两份
 * 数据。人在开放平台改了名，本机不会自动知道——于是顶栏、日志前缀一直喊旧
 * 名字，只有手动改配置才会变。
 *
 * 所以启动后主动问一次官方 `/users/@me`（机器人自己的 token，不需要开发者
 * 登录），对不上就把本地的改过来并落盘。
 *
 * 几个刻意的取舍：
 *   - **只改 `name`**，不碰 AppSecret / intents 之类；写配置走 `saveBotConfig`，
 *     和面板保存是同一条路（字段白名单一致）。
 *   - **失败只 warn**：没网、secret 填错、平台抖动都会让这次拿不到昵称，但那些
 *     问题在别处已经有更明确的报错，这里再喊一遍只是噪音。
 *   - **启动后延迟几秒**再跑：刚起来时 token 还没换、日志也乱，等稳定下来。
 *   - 之后按 `intervalMs` 复查（默认 6 小时）：运行中在平台改名也能跟上，而不是
 *     非得重启。机器人多的时候也就是每 6 小时 N 次 `/users/@me`，可以忽略。
 */
import { BaseService } from './base.js';
import { saveBotConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('nickname');

/**
 * 同步一只机器人：查平台昵称，对不上就改本地并落盘。
 *
 * 拆成独立函数是为了让**手动触发**（面板按钮 / 协议 `bot.nickname.sync`）
 * 和定时任务走同一份逻辑。各写一遍的下场是「手动能改、定时不改」这种事，
 * 而两边看起来都像成功了。
 *
 * @returns {Promise<{changed:boolean, name:string, reason?:string}>}
 */
export async function syncNickname(rt) {
  if (!rt) return { changed: false, name: '', reason: 'no-runtime' };
  // mock / 没有凭证的都问不出东西，跳过
  if (rt.mock) return { changed: false, name: '', reason: 'mock' };
  if (!String(rt.cfg?.appId ?? '').trim() || !String(rt.cfg?.appSecret ?? '').trim()) {
    return { changed: false, name: '', reason: 'no-credential' };
  }

  let nick = '';
  try {
    const me = await rt.api.getMe();
    nick = String(me?.username ?? me?.nickname ?? '').trim();
  } catch (e) {
    return { changed: false, name: '', reason: `query-failed: ${e.message}` };
  }
  if (!nick) return { changed: false, name: '', reason: 'empty-nickname' };

  const cur = String(rt.cfg?.name ?? rt.name ?? '').trim();
  if (nick === cur) return { changed: false, name: nick };

  /**
   * 先改内存再落盘：写配置失败的话，最少这次运行期间面板显示是对的；
   * 下次启动还会重新问一遍，不会因为一次写失败就永久停在旧名字。
   */
  rt.name = nick;
  rt.cfg.name = nick;
  try {
    await saveBotConfig(rt.id, rt.cfg);
  } catch (e) {
    return { changed: true, name: nick, reason: `save-failed: ${e.message}` };
  }
  return { changed: true, name: nick };
}

export class NicknameService extends BaseService {
  constructor({ getRuntimes }) {
    super('nickname', '昵称同步');
    this.getRuntimes = getRuntimes;
    this.intervalMs = 6 * 60 * 60_000;
  }

  async tick() {
    for (const rt of this.getRuntimes() ?? []) {
      const out = await syncNickname(rt);
      if (out.changed) {
        if (out.reason?.startsWith('save-failed')) {
          log.warn(`[${rt.id}] 昵称已更新为「${out.name}」，但写回配置失败：${out.reason.slice(13)}`);
        } else {
          log.info(`[${rt.id}] 昵称已按平台更新为「${out.name}」`);
        }
      } else if (out.reason?.startsWith('query-failed')) {
        log.warn(`[${rt.id}] 查不到平台昵称，先按本机配置显示（${out.reason.slice(14)}）`);
      }
    }
  }
}
