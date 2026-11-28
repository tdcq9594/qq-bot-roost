// issue #38：多机器人群里 @ 别的机器人的 /命令 被本机器人解析并回复。
//
// 修法不做「改 detectMention 只认 is_you」这种一刀切（会破坏 GROUP_AT_MESSAGE_CREATE
// 不返回 mentions 时的正则 fallback，以及免@窗口），而是单独识别「官方字段明确说
// @ 了别的机器人」→ 静默；另加两个可选开关（只回@ / 命令必须@）。
//
// 这里全部用真实 buildMessage 驱动，不靠读源码字符串猜行为。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-mention-'));
process.env.ROOST_HOME = HOME;

const { buildMessage } = await import('../src/message.js');
const { serializeMessage: serializeHost } = await import('../src/host/serialize.js');
const { serializeMessage: serializePlugin } = await import('../src/plugin/protocol.js');

const api = {};
const groupEvent = (content, mentions, extra = {}) => ({
  id: 'm-issue38',
  content,
  group_openid: 'g1',
  author: { member_openid: 'u1', username: '测试用户' },
  timestamp: '1700000000000',
  ...(mentions ? { mentions } : {}),
  ...extra,
});
const build = (content, mentions, cfg = {}, extra = {}) =>
  buildMessage('GROUP_MESSAGE_CREATE', groupEvent(content, mentions, extra), { api, cfg });
/** 带免@窗口的会话桩（用于验证硬静默优先于 sticky） */
const stickySession = { isSticky: () => true };
const buildSticky = (content, mentions, cfg = {}) =>
  buildMessage('GROUP_MESSAGE_CREATE', groupEvent(content, mentions), { api, cfg, session: stickySession });

// 官方字段：bot = 被@的是不是机器人；is_you = 是不是@的当前这个 bot
const OTHER_BOT = { id: 'B', bot: true, is_you: false };
const ME = { id: 'A', bot: true, is_you: true };

/* ---------------- issue #38：@ 别的机器人静默 ---------------- */

test('@ 别的机器人 + /命令：mentioned/addressed 都为 false，silent 为真', () => {
  const m = build('/我的猪圈', [OTHER_BOT]);
  assert.equal(m.mentioned, false, '不能有 @ 我的假象');
  assert.equal(m.mentionedOtherBot, true);
  assert.equal(m.addressed, false);
  assert.equal(m.silent, true);
  assert.equal(m.isCommand, true, '命令本身仍是命令（供日志/统计），只是不处理');
});

test('同时 @ 了我又 @ 了别的机器人：按 @ 我处理，不静默', () => {
  const m = build('/ping', [OTHER_BOT, ME]);
  assert.equal(m.mentionedOtherBot, false);
  assert.equal(m.mentioned, true);
  assert.equal(m.addressed, true);
  assert.equal(m.silent, false);
});

test('@ 全体不算 @ 别的机器人', () => {
  const m = build('/ping', [{ id: 'all', bot: false, is_you: false, scope: 'all' }]);
  assert.equal(m.mentionedOtherBot, false);
  // bot=false 且无 is_you，宽松口径下 mentioned 也为 false；关键是别误静默成「@别的机器人」
  assert.equal(m.silent, false);
});

test('没有官方 mentions 字段（只有 <@B> 正文）：保守不静默，避免误伤', () => {
  const m = build('<@B> /ping');
  assert.equal(m.mentionedOtherBot, false);
  assert.equal(m.silent, false, '正文正则无法判断是不是机器人，宁可多回一句');
});

test('bot=true 但 is_you 缺失：不静默（官方字段要明确 false 才算）', () => {
  const m = build('/ping', [{ id: 'B', bot: true }]);
  assert.equal(m.mentionedOtherBot, false);
  assert.equal(m.silent, false);
});

/* ---------------- 默认行为保持不变 ---------------- */

test('默认：裸 /命令 仍算 addressed（保留原有用法）', () => {
  const m = build('/ping');
  assert.equal(m.mentioned, false);
  assert.equal(m.silent, false);
  assert.equal(m.addressed, true);
});

test('默认：@ 我 + 普通消息算 addressed', () => {
  const m = build('你好', [ME]);
  assert.equal(m.addressed, true);
  assert.equal(m.silent, false);
});

/* ---------------- 开关：只回 @ ---------------- */

test('groupOnlyMentioned：群聊裸 /命令 静默，但 isCommand 仍为真', () => {
  const cfg = { plugins: { groupOnlyMentioned: true } };
  const m = build('/ping', null, cfg);
  assert.equal(m.silent, true);
  assert.equal(m.addressed, false);
  assert.equal(m.isCommand, true);
});

test('groupOnlyMentioned：群聊普通闲聊静默', () => {
  const cfg = { plugins: { groupOnlyMentioned: true } };
  const m = build('随便聊聊', null, cfg);
  assert.equal(m.silent, true);
  assert.equal(m.addressed, false);
});

test('groupOnlyMentioned：@ 我的消息照常 addressed', () => {
  const cfg = { plugins: { groupOnlyMentioned: true } };
  const m = build('/ping', [ME], cfg);
  assert.equal(m.silent, false);
  assert.equal(m.addressed, true);
});

/* ---------------- 开关：命令必须 @ ---------------- */

test('commandRequiresMention：裸 /命令 静默', () => {
  const cfg = { plugins: { commandRequiresMention: true } };
  const m = build('/ping', null, cfg);
  assert.equal(m.silent, true);
  assert.equal(m.addressed, false);
});

test('commandRequiresMention：普通闲聊不受影响（仍可进插件/模型）', () => {
  const cfg = { plugins: { commandRequiresMention: true } };
  const m = build('随便聊聊', null, cfg);
  assert.equal(m.silent, false);
  assert.equal(m.addressed, false, '非@非命令本来就不 addressed，但没被静默');
});

test('commandRequiresMention：@ 我的 /命令 照常', () => {
  const cfg = { plugins: { commandRequiresMention: true } };
  const m = build('/ping', [ME], cfg);
  assert.equal(m.silent, false);
  assert.equal(m.addressed, true);
});

test('两个开关叠加：只有 @ 我通过', () => {
  const cfg = { plugins: { groupOnlyMentioned: true, commandRequiresMention: true } };
  assert.equal(build('/ping', null, cfg).silent, true);
  assert.equal(build('闲聊', null, cfg).silent, true);
  assert.equal(build('/ping', [ME], cfg).silent, false);
});

test('单聊不受任何开关影响', () => {
  const cfg = { plugins: { groupOnlyMentioned: true, commandRequiresMention: true } };
  const d = {
    id: 'm-c2c', content: '/ping',
    author: { user_openid: 'u1' }, timestamp: '1700000000000',
  };
  const m = buildMessage('C2C_MESSAGE_CREATE', d, { api, cfg });
  assert.equal(m.kind, 'c2c');
  assert.equal(m.silent, false);
  assert.equal(m.addressed, true);
});

test('默认开：其它开关全关时 @ 别的机器人仍静默', () => {
  const m = build('/ping', [OTHER_BOT], { plugins: { groupOnlyMentioned: false, commandRequiresMention: false } });
  assert.equal(m.silent, true);
});

test('默认开：处在免@窗口时 @ 别的机器人仍静默', () => {
  const m = buildSticky('/我的猪圈', [OTHER_BOT]);
  assert.equal(m.sticky, true, '确保这条确实在窗口内');
  assert.equal(m.silent, true);
  assert.equal(m.addressed, false, 'sticky 不能把 @ 别的机器人的消息拉回 addressed');
});

/* ---------------- ignoreOtherBotMention 开关 ---------------- */

test('关掉 ignoreOtherBotMention：恢复旧行为，@ 别的机器人算 @ 我', () => {
  const m = build('/我的猪圈', [OTHER_BOT], { plugins: { ignoreOtherBotMention: false } });
  assert.equal(m.mentionedOtherBot, true, '检测到的事实不随开关变');
  assert.equal(m.mentioned, true, '旧口径：官方 bot=true 也算 @ 我');
  assert.equal(m.addressed, true);
  assert.equal(m.silent, false);
});

test('关掉后同时 @ 我 + 别的机器人：仍按 @ 我处理', () => {
  const m = build('/ping', [OTHER_BOT, ME], { plugins: { ignoreOtherBotMention: false } });
  assert.equal(m.mentionedOtherBot, false);
  assert.equal(m.mentioned, true);
  assert.equal(m.silent, false);
});

test('关掉后免@窗口叠加：不再静默', () => {
  const m = buildSticky('/ping', [OTHER_BOT], { plugins: { ignoreOtherBotMention: false } });
  assert.equal(m.sticky, true);
  assert.equal(m.silent, false);
  assert.equal(m.addressed, true);
});

/* ---------------- 协议层透传 ---------------- */

test('宿主协议带 addressed，外部插件协议带 addressed/silent', () => {
  const m = build('/我的猪圈', [OTHER_BOT]);
  const host = serializeHost(m);
  assert.equal(host.addressed, false);
  const plug = serializePlugin(m);
  assert.equal(plug.addressed, false);
  assert.equal(plug.silent, true);
  assert.equal(plug.mentioned, false);
});

/* ---------------- 消费点结构断言（防止漏接） ---------------- */

test('bot.js：静默检查在命令执行之前、免@窗口写入排除静默', () => {
  const src = fs.readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!msg\.silent && \(msg\.mentioned \|\| msg\.isCommand\)\) session\.markAddressed/);
  const silentGate = src.indexOf('if (msg.silent) return;');
  const cmdExec = src.indexOf('if (msg.isCommand && commandEntry)');
  assert.ok(silentGate > 0 && cmdExec > 0 && silentGate < cmdExec,
    '静默闸必须在命令执行之前');
  const deliver = src.indexOf('if (!coreOnly && session.deliver(msg)) return;');
  const listeners = src.indexOf('for (const l of ordered)');
  assert.ok(deliver > silentGate && listeners > silentGate,
    'session.deliver 与插件监听器都必须在静默闸之后，否则模型仍会补一句');
});

test('pipeline.js：限流不对静默消息计数', () => {
  const src = fs.readFileSync(new URL('../src/pipeline.js', import.meta.url), 'utf8');
  assert.match(src, /const addressed = !msg\.silent && \(msg\.mentioned \|\| msg\.isCommand \|\| isSticky/);
});

test('面板与配置：两个开关接线齐全', () => {
  const cfgSrc = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(cfgSrc, /groupOnlyMentioned: false/);
  assert.match(cfgSrc, /commandRequiresMention: false/);
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /name="groupOnlyMentioned"/);
  assert.match(html, /name="commandRequiresMention"/);
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/groupOnlyMentioned: f\.groupOnlyMentioned\.checked/g) ?? []).length, 2,
    '自动保存与完整保存两处都要提交');
  assert.match(app, /f\.groupOnlyMentioned\.checked = c\.plugins\?\.groupOnlyMentioned === true/);
  const server = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8');
  // 用「包含」而非精确数组：后续新增 plugins 布尔键（如 safeMode）不该让这条回归
  for (const key of ['groupOnlyMentioned', 'ignoreOtherBotMention', 'commandRequiresMention', 'forwardSilentToProtocol']) {
    assert.match(server, new RegExp(`'${key}'`), `保存白名单缺 ${key}`);
  }
});

test('ignoreOtherBotMention：配置 / 面板 / 保存 / merge 四处接线齐全（默认开用 !== false）', () => {
  const msgSrc = fs.readFileSync(new URL('../src/message.js', import.meta.url), 'utf8');
  assert.match(msgSrc, /mentionedOtherBot && cfg\?\.plugins\?\.ignoreOtherBotMention !== false/);
  const cfgSrc = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(cfgSrc, /ignoreOtherBotMention: true/);
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /name="ignoreOtherBotMention" checked/);
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/ignoreOtherBotMention: f\.ignoreOtherBotMention\.checked/g) ?? []).length, 2,
    '自动保存与完整保存两处都要提交');
  assert.match(app, /f\.ignoreOtherBotMention\.checked = c\.plugins\?\.ignoreOtherBotMention !== false/);
});

test('协议层转发：静默消息默认全交，关掉开关后不交（onebot + host）', () => {
  const src = fs.readFileSync(new URL('../src/bot.js', import.meta.url), 'utf8');
  // 判据收在 shouldForwardInbound 里：静默开关 + 内容 + 官方重推三条都在这一处
  const gate = src.indexOf('shouldForwardInbound({');
  assert.ok(gate > 0, '协议层转发要走 shouldForwardInbound');
  const gateBody = src.slice(gate, gate + 260);
  assert.match(gateBody, /hasContent: hasMessageContent\(msg\)/);
  assert.match(gateBody, /silent: msg\.silent/);
  assert.match(gateBody, /forwardSilent/, '闸门必须读 forwardSilentToProtocol，默认 !== false（老配置照旧全交）');
  assert.match(gateBody, /duplicate/, '官方重推不重复触发协议层');
  // 闸门在静默闸之前——协议转发发生在 bot.js 更靠前的位置，所以必须在这一层拦
  const forwardGate = gate;
  const silentGate = src.indexOf('if (msg.silent) return;');
  assert.ok(forwardGate > 0 && silentGate > forwardGate,
    '协议转发闸门必须在静默闸之前');
  // 两个协议入口都在闸门之后，同一个 if 块里
  const onebot = src.indexOf('this.onebot?.onMessage(msg)', forwardGate);
  const host = src.indexOf('this.host?.onMessage(msg)', forwardGate);
  assert.ok(onebot > forwardGate && host > forwardGate,
    'onebot 与 host 两个入口都要受开关控制');

  // 配置 / 面板 / 保存 / merge 四处接线
  const cfgSrc = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(cfgSrc, /forwardSilentToProtocol: true/);
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /name="forwardSilentToProtocol" checked/);
  const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/forwardSilentToProtocol: f\.forwardSilentToProtocol\.checked/g) ?? []).length, 2,
    '自动保存与完整保存两处都要提交');
  assert.match(app, /f\.forwardSilentToProtocol\.checked = c\.plugins\?\.forwardSilentToProtocol !== false/);
});

/* ---------------- AT 事件补判：平台剥掉 @ 前缀时的真 @ ---------------- */

/** 群里 @机器人：平台推 GROUP_AT_MESSAGE_CREATE，正文的 @ 前缀被剥、mentions 常为空 */
const buildAt = (content, mentions, extra = {}) =>
  buildMessage('GROUP_AT_MESSAGE_CREATE', groupEvent(content, mentions, extra), { api, cfg: {} });

test('AT 事件（正文被剥@、无 mentions）：仍判为真 @', () => {
  const m = buildAt('你好呀', undefined);
  assert.equal(m.mentioned, true, 'AT 事件本身就是 @ 的确证');
  assert.equal(m.addressed, true);
  assert.equal(m.silent, false);
});

test('AT 事件 + /命令：不算真 @，留给插件（不抢命令、不开 DSH 窗口）', () => {
  const m = buildAt('/roll', undefined);
  assert.equal(m.mentioned, false, '命令前缀要排除，否则抢插件的活');
  assert.equal(m.isCommand, true, '命令本身仍然是命令');
  assert.equal(m.addressed, true, '命令靠 isCommand 照旧 addressed');
});

test('频道 AT 事件同样补判；普通群消息仍不被误认', () => {
  const guild = buildMessage('AT_MESSAGE_CREATE', {
    ...groupEvent('在吗', undefined), channel_id: 'ch1', guild_id: 'g1',
  }, { api, cfg: {} });
  assert.equal(guild.mentioned, true, '频道 AT 事件也应补判');
  const plain = build('今天天气不错', undefined);
  assert.equal(plain.mentioned, false, 'GROUP_MESSAGE_CREATE 不猜 @');
});

test('AT 事件补判仍受 @别的机器人静默开关约束', () => {
  const m = buildMessage('GROUP_AT_MESSAGE_CREATE', groupEvent('帮我看下', [OTHER_BOT]), { api, cfg: {} });
  assert.equal(m.mentionedOtherBot, true);
  assert.equal(m.mentioned, false, '官方明确 @ 了别的机器人时不能被 AT 事件补成真 @');
  assert.equal(m.silent, true);
});
