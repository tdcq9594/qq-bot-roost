/**
 * OneBot 兼容层：改机器人资料
 * ============================
 *
 * `set_qq_profile` 在官方机器人上没有「账号资料」这个概念，唯一能落地的地方
 * 是开放平台后台（昵称 / 头像 / 简介）。这里钉住四件事：
 *
 *   1. 只发改动过的项（平台按次限次数，多打一次就是白烧一次额度）
 *   2. 没登录 / 登错号 → 1401，且把「下一步做什么」一起给出去
 *   3. 头像格式和 2 MB 上限按官方限制拦在本机，不浪费一次平台请求
 *   4. 只改这只鸟（`cfg.appId`），接口里没有「改别人」的口子
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createActions } from '../src/onebot/actions.js';

const silentLog = { info() {}, warn() {}, debug() {}, error() {} };

const ids = {
  openidOfUser: () => '',
  openidOfGroup: () => '',
  getMessage: () => null,
  bindSent: () => 1,
};

/**
 * 假门面。
 *
 * `checkSession` / `check` 两种方法名都提供一份——真实门面里叫 `check`，
 * 平台实例上叫 `checkSession`，兼容层两个都认。
 */
function fakeDev({ state = 'ready', message = '可以改', hint = '', desc = '旧简介' } = {}) {
  const calls = [];
  const api = {
    calls,
    async checkSession(o) {
      calls.push({ op: 'check', args: o });
      return { state, message, hint };
    },
    async check(o) {
      return api.checkSession(o);
    },
    async setBot(appid, patch) {
      calls.push({ op: 'setBot', appid, patch });
      return { ok: true };
    },
    async setAvatar(appid, src) {
      calls.push({ op: 'setAvatar', appid, src });
      return { ok: true };
    },
    async getBot(appid) {
      calls.push({ op: 'getBot', appid });
      return { appid, base: { name: '小鸟', desc } };
    },
  };
  return api;
}

function harness({ dev = fakeDev(), appId = '102055275' } = {}) {
  const runtime = {
    mock: true,
    id: 'main',
    online: true,
    api: {},
    gate: null,
    groups: null,
    log: silentLog,
    outbound: { async send() { return { id: '1' }; } },
    cfg: { appId },
  };
  const actions = createActions({
    runtime,
    ids,
    selfUin: 1427835822,
    botName: '天道酬勤',
    getPassive: () => null,
    emit: () => {},
    dev,
  });
  return { actions, dev };
}

/** 一张最小的 PNG / JPEG 头，够让格式嗅探认出来 */
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test('set_qq_profile：昵称和简介合成一次 setBot，头像单独走 setAvatar', async () => {
  const { actions, dev } = harness();
  await actions('set_qq_profile', {
    nickname: ' 新名字 ',
    longNick: '新的介绍',
    avatar: 'https://example.com/a.png',
  });

  const bots = dev.calls.filter((c) => c.op === 'setBot');
  assert.equal(bots.length, 1, '两项资料要在同一次调用里发，别打成两次');
  assert.equal(bots[0].appid, '102055275');
  assert.deepEqual(bots[0].patch.base, { name: '新名字', desc: '新的介绍' });

  const avatars = dev.calls.filter((c) => c.op === 'setAvatar');
  assert.equal(avatars.length, 1);
  assert.deepEqual(avatars[0].src, { url: 'https://example.com/a.png' });
});

test('set_qq_profile：base64:// 按真实格式包成 dataURL，不谎报 png', async () => {
  const { actions, dev } = harness();
  await actions('set_qq_profile', { avatar: `base64://${jpegBytes.toString('base64')}` });
  const [av] = dev.calls.filter((c) => c.op === 'setAvatar');
  assert.match(av.src.dataUrl, /^data:image\/jpeg;base64,/);
  // 只有头像变了，不该顺手打一次资料修改
  assert.equal(dev.calls.some((c) => c.op === 'setBot'), false);
});

test('set_qq_profile：格式不在官方白名单 / 超过 2 MB 就地拒，不请求平台', async () => {
  const { actions, dev } = harness();
  // 认不出来的字节
  await assert.rejects(
    () => actions('set_qq_profile', { avatar: `base64://${Buffer.from('hello world').toString('base64')}` }),
    (e) => e.retcode === 1400 && /png \/ bmp \/ jpeg/.test(e.message),
  );
  // 2 MB + 1 字节的假 PNG
  const big = Buffer.concat([pngBytes, Buffer.alloc(2 * 1024 * 1024)]);
  await assert.rejects(
    () => actions('set_qq_profile', { avatar: `base64://${big.toString('base64')}` }),
    (e) => e.retcode === 1400 && /2 MB/.test(e.message),
  );
  assert.equal(dev.calls.some((c) => c.op === 'setAvatar'), false, '本机拦下的不该出网');
});

test('没登录 / 登错号：1401，并把下一步告诉调用方', async () => {
  const dev = fakeDev({
    state: 'need-login',
    message: '这个 QQ 号名下一条机器人也没有',
    hint: '退出登录换一个号',
  });
  const { actions } = harness({ dev });
  await assert.rejects(
    () => actions('set_qq_profile', { nickname: 'x' }),
    (e) => e.retcode === 1401
      && e.message.includes('这个 QQ 号名下一条机器人也没有')
      && e.message.includes('换一个号'),
  );
  assert.equal(dev.calls.some((c) => c.op === 'setBot'), false);
});

test('配置里没有 AppID：1400，别去猜改哪只', async () => {
  const { actions, dev } = harness({ appId: '' });
  await assert.rejects(
    () => actions('set_qq_profile', { nickname: 'x' }),
    (e) => e.retcode === 1400 && /AppID/.test(e.message),
  );
  assert.equal(dev.calls.length, 0);
});

test('只给了官方没有的字段：1400 并说清能改什么', async () => {
  const { actions, dev } = harness();
  await assert.rejects(
    () => actions('set_qq_profile', { company: '腾讯', email: 'a@b.c' }),
    (e) => e.retcode === 1400 && /nickname \/ avatar \/ longNick/.test(e.message),
  );
  assert.equal(dev.calls.length, 0);
});

test('get_self_longnick / set_self_longnick 对着简介来', async () => {
  const dev = fakeDev({ desc: '我是小鸟' });
  const { actions } = harness({ dev });
  assert.deepEqual(await actions('get_self_longnick', {}), { longNick: '我是小鸟' });

  await actions('set_self_longnick', { longNick: ' 改一下 ' });
  const [b] = dev.calls.filter((c) => c.op === 'setBot');
  assert.deepEqual(b.patch.base, { desc: '改一下' });

  await assert.rejects(() => actions('set_self_longnick', { longNick: '   ' }), (e) => e.retcode === 1400);
});
