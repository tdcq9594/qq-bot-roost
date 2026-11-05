/**
 * 把 `ctx.api` 包成「发出去就补一笔账」的代理。
 *
 * 为什么需要：出站账本只在 `Outbound.send()` 的两个出口落账，而插件拿到的是
 * **裸的 QQApi 实例**——`ctx.api.sendGroup(...)` 直接打接口，既不进账本、
 * 「谁」列也不带插件名。复核把这条列成「绕过 outbound 的既有路径」，按主人
 * 拍板的 C 档（Proxy 包装）在这里收口。
 *
 * ## 改这个文件前必须先读的三条
 *
 * 1. **不能把 `this` 绑成代理。** `QQApi` 内部大量用私有方法（`#request` /
 *    `#payload` / `#nextSeq`），私有字段只认「声明它的那个对象」——拿代理当
 *    receiver 会直接抛 `Cannot read private member from an object whose class
 *    did not declare it`。所以：
 *      · 不拦截的方法一律 `raw.bind(target)`，绑回原对象；
 *      · 拦截的方法用 `raw.apply(target, args)`，内部调用照旧走原对象。
 * 2. **不改原对象。** 代理是独立的一层，`api.sendGroup` 一个字节都不动；
 *    机器人自己持有的那个实例（`bot.js` 的 `this.api`）行为完全不变。
 * 3. **只在成功之后记。** 抛错就当没发出去（与 `Outbound.send` 一致）；
 *    记账本身出错也只打日志，绝不冒泡到发送链路。
 *
 * ## 已知边界（写在这里，免得以后当 bug 查）
 *
 * · `ctx.api !== bot.api`（对象身份变了）。`instanceof` 仍成立（代理沿用同一
 *   原型），但严格相等会失败——这是 C 档的已知代价。
 * · 插件把方法解构成 `const { sendGroup } = ctx.api` 再调用，拿到的仍是绑好
 *   的函数，照样记账。
 * · `sendMedia` 内部调 `this.sendGroup`，因为 `this` 是原对象，**不会**被本
 *   代理二次拦截——所以它只记一笔，不会双记。
 */

/**
 * 哪几个方法算「真的发出去了」。
 *
 * `target` / `payload` 是实参下标（不是名字），因为这几个方法的签名并不统一：
 * 普通发送是 `(target, opts)`，`sendMedia` 是 `(scene, target, opts)`。
 * `finalOnly` 只给流式消息用：流式是「一条消息在长」，每片都记会让账本里
 * 冒出十几行同一个回复。
 */
const SEND_CALLS = {
  sendGroup: { kind: () => 'group', target: 0, payload: 1 },
  sendC2C: { kind: () => 'c2c', target: 0, payload: 1 },
  sendMedia: {
    kind: (args) => (String(args[0] ?? '') === 'group' ? 'group' : 'c2c'),
    target: 1,
    payload: 2,
  },
  sendStreamMessage: {
    kind: () => 'c2c',
    target: 0,
    payload: 1,
    finalOnly: true,
    /**
     * 流式报文字段是 `contentRaw`，和普通发送的 `content` 不同名；
     * 不转一下，账本摘要会是一条空行。`digestTextOf` 只认 `content`/`text`。
     */
    digestOf: (args) => ({ content: String(args[1]?.contentRaw ?? '') }),
  },
};

/**
 * @param {object} api          QQApi 实例（原对象，不会被修改）
 * @param {object} opts
 * @param {object} [opts.outbound] 出站对象，只用到 `recordDirect()`
 * @param {string} [opts.plugin]   记账时写的插件名
 * @param {object} [opts.log]      logger，用于记账失败时的告警
 * @returns {object} 代理；`api` 不是对象时原样返回
 */
export function wrapApiForLedger(api, { outbound = null, plugin = '', log = null } = {}) {
  if (!api || typeof api !== 'object') return api;

  /** 同一个原函数只造一次包装：`ctx.api.f === ctx.api.f` 要成立 */
  const plain = new Map();
  const recording = new Map();

  function note(spec, args, r) {
    try {
      if (!outbound?.recordDirect) return;
      const payload = args[spec.payload];
      const p = payload && typeof payload === 'object' ? payload : {};
      /** 流式只在结束片（state=10）记一笔 */
      if (spec.finalOnly && Number(p.state) !== 10) return;
      outbound.recordDirect({
        kind: spec.kind(args),
        target: String(args[spec.target] ?? ''),
        payload: spec.digestOf ? spec.digestOf(args) : p,
        plugin,
        /**
         * 用 `||` 不用 `??`：服务端可能给 `id: ''`，而空 id 会让账本的
         * 去重退化成「同毫秒 + 同摘要」——连发几张图时会被 `INSERT OR IGNORE`
         * 静默吞掉几行（复核实测：同毫秒 3 张图只剩 1 行）。
         * `file_uuid` 是上传接口的返回，`sendMedia` 在部分宿主上只回它。
         */
        id: String(r?.id || r?.stream_msg_id || r?.file_uuid || ''),
      });
    } catch (e) {
      log?.warn?.(`出站没记进账本（不影响发送）：${e?.message ?? e}`);
    }
  }

  return new Proxy(api, {
    get(target, prop) {
      const raw = Reflect.get(target, prop, target);
      /** `constructor` 是类本身，绑上去会让 `new ctx.api.constructor()` 失效 */
      if (typeof raw !== 'function' || prop === 'constructor') return raw;

      const spec = Object.hasOwn(SEND_CALLS, prop) ? SEND_CALLS[prop] : null;
      if (!spec) {
        let f = plain.get(raw);
        if (!f) {
          f = raw.bind(target);
          plain.set(raw, f);
        }
        return f;
      }

      let f = recording.get(raw);
      if (!f) {
        f = async (...args) => {
          const r = await raw.apply(target, args);
          note(spec, args, r);
          return r;
        };
        recording.set(raw, f);
      }
      return f;
    },
  });
}
