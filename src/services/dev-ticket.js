/**
 * 开放平台票据自检
 * ================
 *
 * 为什么需要这个服务：票据续期原本是**被动**的——只有某个请求真的撞上
 * `retcode:401` 才去换票。于是启动后如果没有人打开面板、也没有插件调
 * `dev.*`，那份过期的票就一直躺着，等你哪天想起来点开面板才发现
 * 「登录已过期」。而那时候你已经在等结果了。
 *
 * 现在改成启动后主动探一次，之后按小时复查：过期就地换票（后台无头浏览器，
 * 不弹窗、拿到即关），换不到才 warn 一句让人来处理。
 *
 * 三条约束，缺一不可：
 *   · **没有票据就不探**：本机没存过票时探一次等于凭空开一个浏览器窗口，
 *     用户会以为它在偷登录。
 *   · **mock 环境不探**：`--mock` 跑的是假机器人，真实登录态跟它无关，
 *     探了还会把「静默换票」塞进联调日志里。
 *   · **状态变化才 warn**：换不到票会连续复查，每轮都喊一遍就成了噪音。
 */
import { BaseService } from './base.js';
import { getDevPlatform } from '../host/dev.js';
import { createLogger } from '../logger.js';

const log = createLogger('devTicket');

export class DevTicketService extends BaseService {
  /**
   * @param {object} p
   * @param {() => object[]} p.getRuntimes 每次取当前机器人（面板可能新建/删除）
   * @param {number} [p.minutes]           复查间隔（分钟），默认 30
   */
  constructor({ getRuntimes, minutes = 30 } = {}) {
    super('devTicket', '开放平台票据');
    this.getRuntimes = getRuntimes;
    // 下限 5 分钟：再短就变成「一直在打平台接口」，容易把自己送进限频
    this.intervalMs = Math.max(5, Number(minutes) || 30) * 60_000;
    /** 上一次的结论，用来判断「要不要出声」 */
    this.lastState = '';
  }

  async tick() {
    const rts = this.getRuntimes() ?? [];
    // 全是 mock：这环境里没有真实开放平台登录，探了只会白开浏览器
    if (rts.length && rts.every((rt) => rt.mock)) return;

    const P = getDevPlatform({ log: (m) => log.debug(String(m)) });
    let st = await P.status();

    /**
     * `getDevPlatform()` 恢复票据是**不 await** 的（那是有意的：恢复失败
     * 不该拖慢首个请求）。所以极早期 tick 可能读到「内存里还没票」。
     * 这里补读一次文件——只在内存确实空的时候读，避免把内存里更新过的票
     * 用磁盘上的旧票覆盖回去。
     */
    if (!st.loggedIn) {
      await P.load?.().catch(() => {});
      st = await P.status();
    }

    // 本机没存票：不探。「没登录」是用户的常态，不是要修的故障
    if (!st.loggedIn) return;

    const bound = rts.map((rt) => String(rt?.cfg?.appId ?? '').trim()).find(Boolean) || '';
    const out = await P.checkSession({ verify: true, bound: bound ? { appid: bound } : null });

    const state = String(out?.state || '');
    const changed = state !== this.lastState;
    this.lastState = state;

    if (state === 'ready' || state === 'logged-in' || state === 'no-appid') {
      // 正常：只在状态刚恢复时报一句，平时不刷日志
      if (changed) log.info(`开放平台票据正常（${out.message}）`);
      return;
    }

    /**
     * 走到这里说明「有票但用不了」。续期过程本身已经打过日志，这里只在
     * 结论变化时说一句——不然每 30 分钟重复一遍同样的文案。
     */
    if (changed) {
      log.warn(`开放平台票据需要处理：${out?.message || state}${out?.hint ? `（${out.hint}）` : ''}`);
    }
  }
}
