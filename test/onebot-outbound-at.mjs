/**
 * 群聊出站的 @：自动升级 markdown
 * ================================
 *
 * 官方「文本交互」文档：@用户 **只在 markdown 消息里生效**（群聊 id 填
 * member_openid）。纯文本出口把 `<@openid>` 原样发出去，用户看到的就是
 * `<@8C7419D4B8500528C2248E85360A719D> 咋啦`（2026-11-13 实机截图）。
 *
 * 这里钉住三条：
 *   1. 群聊带 @ → 发 markdown，@ 变成 `<qqbot-at-user>`；
 *   2. markdown 被官方明确拒（4xx）→ 降级纯文本 `@昵称`，话不能丢；
 *   3. 429 / 网络错误 → **不降级**（消息可能已经发出去了，重发会变两条）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createActions } from '../src/onebot/actions.js';

const ids = {
  openidOfUser: (qq) => (String(qq) === '2014433751' ? 'U1' : ''),
  openidOfGroup: (g) => (String(g) === '763366431' ? 'G1' : ''),
  getMessage: () => null,
  bindSent: () => 1,
};

const silentLog = { info() {}, warn() {}, debug() {}, error() {} };

/** 一次发送现场：`outbound.send` 收到的 payload 全部记下来 */
function harness({ fail = null, failOnce = false, idsOverride = null } = {}) {
  const calls = [];
  let thrown = false;
  const runtime = {
    mock: true,
    online: true,
    api: {},
    gate: null,
    groups: null,
    identity: null,
    log: silentLog,
    outbound: {
      async send(o) {
        calls.push(o);
        if (fail && (!failOnce || !thrown)) {
          thrown = true;
          throw fail;
        }
        return { id: `${calls.length}` };
      },
    },
  };
  const actions = createActions({
    runtime,
    ids: idsOverride ?? ids,
    selfUin: 1427835822,
    botName: '天道酬勤',
    getPassive: () => ({ msgId: 'pm1', at: Date.now() }),
    emit: () => {},
  });
  return { calls, actions };
}

const AT_MSG = [
  { type: 'at', data: { qq: '2014433751', name: '倦飞之鸟' } },
  { type: 'text', data: { text: ' 咋啦' } },
];

test('群聊带 @：走 markdown，@ 换成 qqbot-at-user', async () => {
  const { calls, actions } = harness();
  await actions('send_group_msg', { group_id: 763366431, message: AT_MSG });

  assert.equal(calls.length, 1, 'markdown 成功就不该再发一条纯文本');
  const p = calls[0].payload;
  assert.equal(calls[0].kind, 'group');
  assert.equal(p.markdown?.content, '<qqbot-at-user id="U1" /> 咋啦');
  assert.equal(p.content, undefined, 'markdown 报文里 content 必须为空（官方 40034008）');
  assert.equal(p.msgId, 'pm1', '被动回复不能丢');
});

test('markdown 被 4xx 拒：降级纯文本，@昵称 顶上', async () => {
  const err = new Error('HTTP 400');
  err.status = 400;
  const { calls, actions } = harness({ fail: err, failOnce: true });
  await actions('send_group_msg', { group_id: 763366431, message: AT_MSG });

  assert.equal(calls.length, 2, '被拒后必须补一条纯文本');
  assert.equal(calls[1].payload.content, '@倦飞之鸟 咋啦');
  assert.equal(calls[1].payload.markdown, undefined);
});

test('429 / 网络错误不降级：消息可能已经发出，重发会变两条', async () => {
  const err = new Error('HTTP 429');
  err.status = 429;
  const { calls, actions } = harness({ fail: err });
  await assert.rejects(() => actions('send_group_msg', { group_id: 763366431, message: AT_MSG }));
  assert.equal(calls.length, 1);
});

test('单聊不发 markdown：两个人之间 @ 没有意义', async () => {
  const { calls, actions } = harness();
  await actions('send_private_msg', { user_id: 2014433751, message: AT_MSG });
  assert.equal(calls[0].payload.markdown, undefined);
  assert.equal(calls[0].payload.content, '@倦飞之鸟 咋啦');
});

test('没有 at 的群聊消息保持纯文本，不整条变 markdown', async () => {
  const { calls, actions } = harness();
  await actions('send_group_msg', {
    group_id: 763366431,
    message: [{ type: 'text', data: { text: '**你好**' } }],
  });
  assert.equal(calls[0].payload.markdown, undefined, '没必要为了普通消息改消息类型');
  assert.equal(calls[0].payload.content, '**你好**');
});

/* ---------------- 未绑定的人 / 群 ---------------- */

test('@ 一个没绑定的号：降级成文字，不把整条消息变 markdown', async () => {
  const { calls, actions } = harness();
  await actions('send_group_msg', {
    group_id: 763366431,
    message: [
      { type: 'at', data: { qq: '99999', name: '路人' } },
      { type: 'text', data: { text: ' 你好' } },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.markdown, undefined, '没有能落地的真 @，不该走 markdown');
  assert.equal(calls[0].payload.content, '@路人  你好', '至少让群里看到 @ 了谁');
});

test('@ 一个「未绑定但有合成号」的人：照样能真 @（走 markdown）', async () => {
  const synthQq = '9743444427615';
  const synthOpenid = 'E'.repeat(32);
  const { calls, actions } = harness({
    idsOverride: {
      ...ids,
      // 未绑定的号在 OneBot 里看到的是合成号，反查回 openid 就够发 at
      openidOfUser: (qq) => (String(qq) === synthQq ? synthOpenid : ids.openidOfUser(qq)),
    },
  });
  await actions('send_group_msg', {
    group_id: 763366431,
    message: [{ type: 'at', data: { qq: synthQq } }, { type: 'text', data: { text: ' 在吗' } }],
  });
  assert.equal(
    calls[0].payload.markdown?.content,
    `<qqbot-at-user id="${synthOpenid}" /> 在吗`,
    '未绑定的人也能被 @ 到，只要客户端回传的是我们给的号',
  );
});

test('未绑定的群：客户端回传合成群号照样发得出去', async () => {
  const synthGroup = '9344993546320';
  const { calls, actions } = harness({
    idsOverride: {
      ...ids,
      openidOfGroup: (g) => (String(g) === synthGroup ? 'F'.repeat(32) : ids.openidOfGroup(g)),
    },
  });
  await actions('send_group_msg', { group_id: synthGroup, message: [{ type: 'text', data: { text: '测试' } }] });
  assert.equal(calls[0].target, 'F'.repeat(32), 'target 必须是 openid，不是号码');
  assert.equal(calls[0].payload.content, '测试');
});
