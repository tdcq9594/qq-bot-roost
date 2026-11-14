/**
 * 宿主协议 v1（roost-host/1）
 * ===========================
 *
 * 刻意**不依赖 ws**：`createHostServer({ ws: null })` 仍能开 HTTP RPC 与 SSE，
 * 所以没装可选依赖的机器上这份测试也照跑。WS 帧层的回环由
 * `onebot-loopback.mjs` 那套「装了才测」的机制覆盖。
 *
 * 跑法：node --test test/host-protocol.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostServer } from '../src/host/server.js';
import { HostBridge } from '../src/host/index.js';
import * as extDeps from '../src/ext-deps.js';
import {
  createMethods, effectiveScopes, HostError, HOST_PROTOCOL,
} from '../src/host/methods.js';
import { serializeMessage, serializeNotice } from '../src/host/serialize.js';
import { QQApi, inspectImageFormat, buildSendPayload } from '../src/api.js';
import { OFFICIAL_ENDPOINTS, CALLABLE_METHODS } from '../src/endpoints.js';

const TOKEN = 'test-token-0123456789abcdef';

/* ------------------------------------------------------------------ */
/* 假 runtime：只给方法表真正会读的字段                                 */
/* ------------------------------------------------------------------ */

function makeRuntime() {
  const calls = [];
  class FakeApi {
    async getGroupMembers(groupOpenid, opts) {
      calls.push(['getGroupMembers', groupOpenid, opts]);
      return { groupOpenid, opts, ok: true };
    }
    async sendGroup(chatId, body) {
      calls.push(['sendGroup', chatId, body]);
      return { msgId: `m${calls.length}` };
    }
    async sendC2C(chatId, body) {
      calls.push(['sendC2C', chatId, body]);
      return { msgId: `m${calls.length}` };
    }
    async retractGroupMessage(chatId, msgId) {
      calls.push(['retractGroupMessage', chatId, msgId]);
      return { ok: true };
    }
  }
  const runtime = {
    id: 'test-bot',
    name: '测试鸟',
    state: 'online',
    online: true,
    cfg: {
      name: '测试鸟',
      appId: '1024',
      appSecret: 'super-secret',
      commandPrefix: '/',
      owners: [],
      host: { token: 'host-token-must-not-leak', enabled: false },
    },
    status: { id: 'test-bot', state: 'online' },
    api: new FakeApi(),
    calls,
  };
  /**
   * 假出站调度器：真实 outbound 最后也是调 api 发出去，这里照做。
   *
   * 协议改成走 outbound 之后，`calls` 里会先出现一条 `outbound.send`，
   * 再出现 api 的 `sendGroup` —— 所以「按 sendGroup 计数」的老断言依然成立，
   * 同时新增的断言可以证明消息确实经过了调度器（而不是又直连 api 了）。
   */
  runtime.outbound = {
    async send(o) {
      calls.push(['outbound.send', o.chatKey, o.payload, o]);
      const r = o.kind === 'group'
        ? await runtime.api.sendGroup(o.target, o.payload)
        : await runtime.api.sendC2C(o.target, o.payload);
      return { id: r?.msgId ?? r?.id ?? '', requestId: o.requestId ?? '' };
    },
  };
  return runtime;
}

function makeMethods(runtime = makeRuntime()) {
  const methods = createMethods({
    runtime,
    getState: () => ({ version: '0.0.0-test', seq: 7, connections: 1, counters: { ok: 0, fail: 0 } }),
  });
  return { runtime, methods };
}

/* ------------------------------------------------------------------ */
/* 方法表                                                              */
/* ------------------------------------------------------------------ */

/** 方法数会随能力扩充增长，只钉下界；真正的反漂移靠下面几组针对性断言 */
const MIN_METHODS = 30;

test('方法表：每个方法都带 name/scope/desc，关键能力不缺', () => {
  const { methods } = makeMethods();
  const list = methods.describe();
  assert.equal(HOST_PROTOCOL, 1);
  assert.ok(list.length >= MIN_METHODS, `方法表缩水了，当前只有 ${list.length}`);
  assert.equal(methods.names().length, list.length);
  for (const m of list) {
    assert.ok(m.name && m.desc, `方法 ${m.name} 缺说明`);
    assert.ok(['read', 'message', 'manage'].includes(m.scope), `方法 ${m.name} 的 scope 不合法`);
  }
  /** 「全部协议 API」「调插件」「改设置」「富媒体/素材」这些能力必须真的在表上 */
  for (const n of [
    'qq.call', 'plugin.tool.call', 'config.set', 'msg.stream',
    'media.upload', 'media.image.list', 'media.image.delete', 'media.image.send',
    'ledger.context', 'delivery.get', 'plugin.install',
  ]) {
    assert.ok(methods.names().includes(n), `方法表里缺 ${n}`);
  }
});

/* ------------------------------------------------------------------ */
/* 官方素材管理（GET /v2/media-images 这一套）                          */
/* ------------------------------------------------------------------ */

test('素材端点：查询开放、三步仍 internal、字节入口和配额都在', () => {
  const eps = OFFICIAL_ENDPOINTS.filter((e) => e.path.startsWith('/v2/media-images'));
  const list = eps.find((e) => e.method === 'GET' && e.path === '/v2/media-images');
  assert.ok(list, '缺 GET /v2/media-images 登记');
  assert.equal(list.api, 'listMediaImages');
  assert.ok(!list.internal, '查询是只读，该对面板和宿主开放');
  assert.ok(CALLABLE_METHODS.has('listMediaImages'));
  for (const e of OFFICIAL_ENDPOINTS.filter((x) => x.internal)) {
    assert.ok(!CALLABLE_METHODS.has(e.api), `${e.api} 是 internal，不该进面板白名单`);
  }
  for (const n of ['listMediaImages', 'uploadMarkdownImageBytes', 'uploadMarkdownImage']) {
    assert.equal(typeof QQApi.prototype[n], 'function', `QQApi 缺 ${n}`);
  }
  /** 扩展名必须与文件头一致，否则官方 40035001；以前一律落 .png 会坑死 jpeg/webp */
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
  assert.equal(inspectImageFormat(jpeg, 'photo.jpg').contentType, 'image/jpeg');
  assert.equal(inspectImageFormat(jpeg, 'photo.png').ok, false);
});

function makeMediaRuntime() {
  const { runtime, methods } = makeMethods();
  runtime.api.uploadMarkdownImageBytes = async (buf, opts) => {
    runtime.calls.push(['uploadMarkdownImageBytes', buf.length, opts]);
    return {
      imageId: 'img-1', url: 'qqbot-media://image/v1/abc', ttl: 7776000,
      fileName: opts.fileName, retained: Boolean(opts.retain),
    };
  };
  runtime.api.listMediaImages = async (p = {}) => {
    runtime.calls.push(['listMediaImages', p]);
    return {
      images: [{ imageId: 'img-1', url: 'qqbot-media://image/v1/abc', fileName: 'a.jpg' }],
      nextCursor: '', total: 1, quota: 100,
    };
  };
  runtime.api.deleteMediaImage = async (...args) => {
    runtime.calls.push(['deleteMediaImage', ...args]);
    return {};
  };
  return { runtime, methods };
}

test('素材协议：jpeg 自动补 .jpg、默认保留、删除要 confirm 且先查列表', async () => {
  const { runtime, methods } = makeMediaRuntime();
  const ALL = new Set(['read', 'message', 'manage']);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');

  const up = await methods.call('media.markdownImage', { dataBase64: jpeg }, { scopes: ALL });
  assert.equal(up.retained, true, '默认保留，宿主才能跨消息复用引用');
  const upload = runtime.calls.find((c) => c[0] === 'uploadMarkdownImageBytes');
  assert.match(upload[2].fileName, /\.jpg$/, '没给文件名时按文件头补正确扩展名');
  assert.equal(upload[2].retain, true);

  const listed = await methods.call('media.image.list', {}, { scopes: new Set(['read']) });
  assert.equal(listed.total, 1);
  assert.equal(listed.remaining, 99);

  await assert.rejects(
    () => methods.call('media.image.delete', { imageId: 'img-1' }, { scopes: ALL }),
    (e) => e.code === 'FORBIDDEN', '删除不可恢复，必须显式 confirm',
  );
  await assert.rejects(
    () => methods.call('media.image.delete', { imageId: 'nope', confirm: true }, { scopes: ALL }),
    (e) => e.code === 'NOT_FOUND', '不在列表里的 id 不许拿去打官方接口',
  );
  const del = await methods.call(
    'media.image.delete', { imageId: 'img-1', confirm: true }, { scopes: ALL },
  );
  assert.equal(del.ok, true);
  assert.deepEqual(runtime.calls.find((c) => c[0] === 'deleteMediaImage')[2], { allowUnowned: true });
});

test('素材协议：image.send 引用格式正确，默认发完即删', async () => {
  const { runtime, methods } = makeMediaRuntime();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');
  await methods.call('media.image.send', {
    scene: 'group', target: 'g1', dataBase64: jpeg, alt: '行情', width: 800, height: 400,
  }, { scopes: new Set(['read', 'message']) });
  const sg = runtime.calls.find((c) => c[0] === 'sendGroup');
  assert.match(sg[2].markdown.content, /!\[行情 #800px #400px\]\(qqbot-media:\/\/image\/v1\/abc\)/);
  assert.ok(runtime.calls.some((c) => c[0] === 'deleteMediaImage'), '默认发完即删，别吃满 100 张配额');
});

/* ------------------------------------------------------------------ */
/* 反漂移                                                              */
/* ------------------------------------------------------------------ */

test('反漂移：QQApi 的公开方法一个不漏地能被 qq.methods 反射', async () => {
  const { runtime, methods } = makeMethods();
  Object.setPrototypeOf(runtime.api, QQApi.prototype);
  const got = (await methods.call('qq.methods', {}, { scopes: new Set(['read']) })).methods;
  const want = Object.getOwnPropertyNames(QQApi.prototype)
    .filter((k) => k !== 'constructor' && !k.startsWith('_') && !k.startsWith('#'))
    .filter((k) => typeof QQApi.prototype[k] === 'function')
    .sort();
  assert.deepEqual(got, want, '框架加了官方方法，协议反射却漏了');
});

test('qq.call：读接口只要 read，internal / 路径型 / 写接口按级收口', async () => {
  const { runtime, methods } = makeMethods();
  const proto = Object.getPrototypeOf(runtime.api);
  proto.getMe = async () => ({ id: 'me' });
  proto.prepareMediaImage = async () => ({ upload_id: 'x' });
  proto.uploadLocalFile = async () => ({ ok: true });
  const READ = new Set(['read']);
  const ALL = new Set(['read', 'message', 'manage']);

  assert.deepEqual(
    await methods.call('qq.call', { method: 'getMe', args: [] }, { scopes: READ }),
    { id: 'me' }, '查 getMe 不该逼用户打开 allowManage 总闸',
  );
  await assert.rejects(
    () => methods.call('qq.call', { method: 'prepareMediaImage', args: [{}] }, { scopes: ALL }),
    (e) => e.code === 'FORBIDDEN', 'internal 端点不许协议绕过去',
  );
  await assert.rejects(
    () => methods.call('qq.call', { method: 'uploadLocalFile', args: [] }, { scopes: ALL }),
    (e) => e.code === 'FORBIDDEN', '路径型上传等于让宿主读框架本机任意文件',
  );
  await assert.rejects(
    () => methods.call('qq.call', { method: 'sendGroup', args: ['g', {}] }, { scopes: READ }),
    (e) => e.code === 'NO_SCOPE', '写接口在只读 token 下要挡住',
  );
});

test('scope：read 默认放行，manage 默认拒绝，allowManage 是总闸', async () => {
  const { methods } = makeMethods();
  assert.deepEqual([...effectiveScopes({ scopes: ['read', 'message'] })], ['read', 'message']);
  assert.deepEqual(
    [...effectiveScopes({ scopes: ['read', 'message', 'manage'], allowManage: false })].sort(),
    ['message', 'read'],
    'allowManage 关着时，配置里写了 manage 也必须剔除',
  );
  assert.ok(effectiveScopes({ scopes: ['manage'], allowManage: true }).has('manage'));

  assert.equal((await methods.call('system.ping', {}, { scopes: new Set(['read']) })).pong > 0, true);
  await assert.rejects(
    () => methods.call('config.set', { name: 'x' }, { scopes: new Set(['read']) }),
    (e) => e instanceof HostError && e.code === 'NO_SCOPE' && e.http === 403,
  );
});

test('qq.call 反射 QQApi 原型，拒绝 Object.prototype 与不存在的方法', async () => {
  const { methods } = makeMethods();
  const full = new Set(['read', 'message', 'manage']);
  const names = await methods.call('qq.methods', {}, { scopes: new Set(['read']) });
  assert.ok(names.methods.includes('getGroupMembers'));
  assert.ok(!names.methods.includes('constructor'));
  assert.ok(!names.methods.includes('toString'));

  const got = await methods.call('qq.call', {
    method: 'getGroupMembers', args: ['g1', { limit: 20 }],
  }, { scopes: full });
  assert.deepEqual(got.opts, { limit: 20 });

  await assert.rejects(
    () => methods.call('qq.call', { method: 'constructor' }, { scopes: full }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => methods.call('qq.call', { method: 'nope' }, { scopes: full }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => methods.call('qq.call', { method: 'getGroupMembers', args: 'not-array' }, { scopes: full }),
    (e) => e.code === 'BAD_PARAMS',
  );
});

test('msg.send 的 clientMsgId 五分钟内幂等，不会重复发', async () => {
  const { runtime, methods } = makeMethods();
  const scopes = new Set(['read', 'message']);
  const p = { kind: 'group', chatId: 'g-openid', content: '你好', clientMsgId: 'same-key' };
  const a = await methods.call('msg.send', p, { scopes });
  const b = await methods.call('msg.send', p, { scopes });
  assert.equal(a.msgId, b.msgId);
  assert.equal(b.deduped, true);
  assert.equal(runtime.calls.filter((c) => c[0] === 'sendGroup').length, 1);
});

test('msg.send 用 camelCase：被动回复的 msg_id / msg_seq 不会退化成主动消息', async () => {
  const { runtime, methods } = makeMethods();
  const scopes = new Set(['read', 'message']);
  await methods.call('msg.send', {
    kind: 'group', chatId: 'g-openid', content: '回你', msgId: 'orig-1', msgSeq: 2,
  }, { scopes });
  const body = runtime.calls.find((c) => c[0] === 'sendGroup')[2];
  assert.equal(body.msgId, 'orig-1');
  assert.equal(body.msgSeq, 2);
  assert.equal(body.msg_id, undefined, 'snake_case 会被 buildSendPayload 整个丢掉');

  /** 用框架真正的报文构造函数验一遍，别只信自己写的桩 */
  const wire = buildSendPayload(body, () => 99);
  assert.equal(wire.msg_id, 'orig-1');
  assert.equal(wire.msg_seq, 2);
  assert.equal(wire.msg_type, 0);
  assert.equal(wire.content, '回你');

  await methods.call('msg.send', {
    kind: 'c2c', chatId: 'u-openid', content: '图', media: { file_info: 'x' },
  }, { scopes });
  const c2c = runtime.calls.find((c) => c[0] === 'sendC2C')[2];
  assert.deepEqual(c2c.media, { file_info: 'x' }, '发图不该被迫去开 qq.call 的 manage 权限');
});

test('msg.send 纯图文卡片（content 为空）不该被「至少给一个」挡下', async () => {
  const { runtime, methods } = makeMethods();
  const scopes = new Set(['read', 'message']);
  const card = {
    title: '一只猫', description: '窗台上打盹',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    picUrl: 'https://i0.hdslb.com/a.jpg',
  };
  const r = await methods.call('msg.send', {
    kind: 'c2c', chatId: 'u-openid', content: '', card,
  }, { scopes });
  assert.ok(r.msgId, '卡片发出去要回消息 id');
  const ob = runtime.calls.find((c) => c[0] === 'outbound.send');
  assert.ok(ob, '卡片也要走 outbound，不能绕开限速 / 额度 / 账本');
  assert.deepEqual(ob[3].payload.card, card);
  assert.equal(ob[3].payload.content, '', '官方 msg_type=8 不带正文');

  /** 上线前必须包成官方嵌套结构，否则官方回 `card msg is nil`，卡片根本发不出去 */
  const wire = buildSendPayload(ob[3].payload, () => 99);
  assert.equal(wire.msg_type, 8);
  assert.equal(wire.content, '');
  assert.equal(wire.card.type, 'tuwen');
  assert.deepEqual(wire.card.content, {
    title: '一只猫',
    description: '窗台上打盹',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    pic_url: 'https://i0.hdslb.com/a.jpg',
  });

  /** 放宽的是「富媒体」，不是「什么都没有也能发」 */
  await assert.rejects(
    () => methods.call('msg.send', { kind: 'c2c', chatId: 'u-openid', content: '' }, { scopes }),
    (e) => e.code === 'BAD_PARAMS',
  );
});

test('buildSendPayload：已经是 {type:tuwen,content} 的卡片不再包一层', () => {
  const nested = {
    type: 'tuwen',
    content: { title: '标题', description: '描述', url: 'https://a.example', pic_url: 'https://b.example/a.jpg' },
  };
  const wire = buildSendPayload({ content: '', card: nested }, () => 1);
  assert.equal(wire.card, nested, 'msg.replyTuwen() 构造好的结构要原样过去');
  assert.equal(wire.msg_type, 8);
});

test('msg.send 必须经过 outbound：直连 api 会绕开限速/额度/审核/投递账本', async () => {
  const { runtime, methods } = makeMethods();
  await methods.call('msg.send', { kind: 'group', chatId: 'g-openid', content: 'hi' }, {
    scopes: new Set(['read', 'message']),
  });
  const ob = runtime.calls.find((c) => c[0] === 'outbound.send');
  assert.ok(ob, '没经过 outbound —— 主动额度、被动窗口、审核、投递账本全都不参与');
  assert.equal(ob[3].chatKey, 'group:g-openid', '限速与额度按 kind:chatId 记账，口径要和框架一致');
  assert.equal(ob[3].plugin, 'host', '账本要能看出这条是外接协议发的');
  assert.equal(ob[3].payload.content, 'hi');
});

test('receivedAt：客户端给了就用，没给按 eventId 从账本反查', async () => {
  const { runtime, methods } = makeMethods();
  const scopes = new Set(['read', 'message']);

  await methods.call('msg.send', {
    kind: 'group', chatId: 'g', content: 'a', receivedAt: 1700000000000,
  }, { scopes });
  let ob = runtime.calls.filter((c) => c[0] === 'outbound.send').pop();
  assert.equal(ob[3].receivedAt, 1700000000000);

  runtime.ledger = { get: (id) => (id === 'EVT_9' ? { at: 1700000009999 } : null) };
  await methods.call('msg.send', {
    kind: 'group', chatId: 'g', content: 'b', eventId: 'EVT_9',
  }, { scopes });
  ob = runtime.calls.filter((c) => c[0] === 'outbound.send').pop();
  assert.equal(ob[3].receivedAt, 1700000009999, '不反查的话 age=0，被动窗口检查永远不触发');
});

test('media.image.send 同样走 outbound，并带上 fileType', async () => {
  const { runtime, methods } = makeMediaRuntime();
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');
  await methods.call('media.image.send', {
    scene: 'group', target: 'g1', dataBase64: jpeg, msgId: 'orig-1', receivedAt: 1700000000123,
  }, { scopes: new Set(['read', 'message']) });
  const ob = runtime.calls.find((c) => c[0] === 'outbound.send');
  assert.ok(ob, '富媒体也要进额度与投递账本');
  assert.equal(ob[3].fileType, 1, '账本里要能看出发的是图');
  assert.equal(ob[3].receivedAt, 1700000000123);
  assert.equal(ob[3].payload.msgId, 'orig-1', '被动回复要挂在原消息上');
});

test('msg.stream 离线时直接拒绝，不打接口', async () => {
  const { runtime, methods } = makeMethods();
  runtime.online = false;
  await assert.rejects(
    () => methods.call('msg.stream', { streamId: 's1', chatId: 'u', contentRaw: 'x' }, {
      scopes: new Set(['read', 'message']),
    }),
    (e) => e.code === 'NOT_READY',
  );
  assert.equal(runtime.calls.length, 0);
});

test('outbound 未就绪时退回直连，别让消息发不出去', async () => {
  const { runtime, methods } = makeMethods();
  delete runtime.outbound;
  const r = await methods.call('msg.send', { kind: 'group', chatId: 'g', content: 'hi' }, {
    scopes: new Set(['read', 'message']),
  });
  assert.equal(r.msgId, 'm1');
  assert.equal(runtime.calls.filter((c) => c[0] === 'sendGroup').length, 1);
});

test('config.get 脱敏所有密钥字段（含嵌套的 host.token）', async () => {
  const { methods } = makeMethods();
  const cfg = await methods.call('config.get', {}, { scopes: new Set(['read']) });
  assert.equal(cfg.appSecret, '********');
  assert.equal(cfg.host.token, '********');
  assert.equal(cfg.name, '测试鸟');
});

test('config.set 拒绝凭证类键，且不会走到写盘', async () => {
  const { methods } = makeMethods();
  await assert.rejects(
    () => methods.call('config.set', { patch: { appSecret: 'hack', name: '改名' } }, {
      scopes: new Set(['manage']),
    }),
    (e) => e.code === 'BAD_PARAMS' && e.message.includes('appSecret'),
  );
  await assert.rejects(
    () => methods.call('config.set', { patch: { 'host.token': 'hack' } }, {
      scopes: new Set(['manage']),
    }),
    (e) => e.code === 'BAD_PARAMS',
  );
});

test('serializeMessage：原生 openid/uin，没绑就是空串，不造合成号', () => {
  const data = serializeMessage({
    kind: 'group', chatId: 'g-openid', groupId: 'g-openid',
    userId: 'u-openid', uin: '', identityId: '', userName: '小明',
    id: 'msg-1', content: '看图', addressed: true,
    raw: { content: '<@bot> 看图', author: { bot: false } },
  }, { groupName: '测试群' });
  assert.equal(data.chat.chatId, 'g-openid');
  assert.equal(data.chat.name, '测试群');
  assert.equal(data.sender.openid, 'u-openid');
  assert.equal(data.sender.uin, '', '没绑不能造一个像 QQ 号的合成号');
  assert.equal(data.rawContent, '<@bot> 看图');
  assert.equal(data.replyTo, null);
  assert.equal(data.raw, undefined, '平台原始事件体不进事件流');

  assert.equal(serializeMessage(null), null);
  const notice = serializeNotice('GROUP_ADD_ROBOT', { a: 1 });
  assert.equal(notice.event, 'GROUP_ADD_ROBOT');
  assert.deepEqual(notice.data, { a: 1 });
  assert.ok(notice.at > 0);
});

test('事件带 eventId 与 quoted：ledger.context 这条桥才真的能用', () => {
  const data = serializeMessage({
    id: 'MSG_1', eventId: 'EVT_1', kind: 'group', chatId: 'G1', groupId: 'G1',
    userId: 'U1', content: '在吗', receivedAt: 1700000000000,
    quoted: '被引用的原话',
    raw: { content: '在吗', message_reference: { message_id: 'MSG_0' } },
  });
  assert.equal(data.msgId, 'MSG_1');
  assert.equal(data.eventId, 'EVT_1', '没有 eventId 就调不了 ledger.context 反查原文');
  assert.equal(data.quoted, '被引用的原话', '只有 replyTo 拼不出「引用了哪句话」');
  assert.equal(data.replyTo, 'MSG_0');

  /** 不开账本时是空串（明确「没有」），不是 undefined（像字段丢了） */
  const bare = serializeMessage({ id: 'M2', chatId: 'C2', userId: 'U2', content: 'x' });
  assert.equal(bare.eventId, '');
  assert.equal(bare.quoted, '');
});

/* ------------------------------------------------------------------ */
/* 传输层（HTTP + SSE，无 ws）                                         */
/* ------------------------------------------------------------------ */

/** 起一个真实监听的服务，测完关掉 */
async function withServer(t, { scopes = new Set(['read']), frames = [] } = {}) {
  const { methods } = makeMethods();
  const srv = createHostServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    ws: null,
    maxConnections: 4,
    attach: (_sink, info) => ({
      welcome: { protocol: 1, app: 'roost-host', version: '0.0.0-test', seq: 40, since: info.since },
      frames,
    }),
    health: () => ({ state: 'running', seq: 40 }),
    onRpc: async (frame) => {
      try {
        const data = await methods.call(frame.method, frame.params, { scopes });
        return { id: frame.id, ok: true, data, http: 200 };
      } catch (e) {
        return {
          id: frame.id, ok: false, http: e.http ?? 500,
          error: { code: e.code ?? 'INTERNAL', message: e.message },
        };
      }
    },
  });
  const port = await srv.start();
  t.after(() => srv.stop());
  return { port, srv };
}

const base = (port) => `http://127.0.0.1:${port}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

async function rpc(port, method, params = {}, headers = auth) {
  const res = await fetch(`${base(port)}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ id: 'c1', method, params }),
  });
  return { status: res.status, body: await res.json() };
}

test('传输：/health 免 token，/rpc 缺 token 401，错 token 401', async (t) => {
  const { port } = await withServer(t);
  const h = await fetch(`${base(port)}/health`);
  assert.equal(h.status, 200);
  assert.equal((await h.json()).app, 'roost-host');

  assert.equal((await rpc(port, 'system.ping', {}, {})).status, 401);
  assert.equal((await rpc(port, 'system.ping', {}, { Authorization: 'Bearer wrong' })).status, 401);
});

test('传输：/rpc 一问一答、id 原样回带、方法不存在 404', async (t) => {
  const { port } = await withServer(t);
  const ok = await rpc(port, 'system.ping');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, 'c1');
  assert.equal(ok.body.ok, true);
  assert.ok(ok.body.data.pong > 0);

  const missing = await rpc(port, 'nope.nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
  assert.equal(missing.body.id, 'c1');

  const bad = await fetch(`${base(port)}/rpc`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'BAD_REQUEST');
});

test('传输：scope 在服务端生效，manage 方法被 403 NO_SCOPE', async (t) => {
  const { port } = await withServer(t, { scopes: new Set(['read']) });
  const denied = await rpc(port, 'qq.methods');
  assert.equal(denied.status, 200, 'qq.methods 是 read');

  const blocked = await rpc(port, 'plugin.enable', { id: 'x' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'NO_SCOPE');
});

test('传输：带 Origin 且不同源直接拒，同源放行', async (t) => {
  const { port } = await withServer(t);
  const cross = await rpc(port, 'system.ping', {}, {
    ...auth, Origin: 'http://evil.example',
  });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.error.code, 'FORBIDDEN');

  const same = await rpc(port, 'system.ping', {}, {
    ...auth, Origin: base(port),
  });
  assert.equal(same.status, 200);
});

/** 读 SSE 流的前 n 个 data 帧，然后主动断开 */
async function readSse(port, query, n) {
  const ctrl = new AbortController();
  const res = await fetch(`${base(port)}/events?${query}`, {
    headers: auth, signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out = [];
  try {
    while (out.length < n) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const p of parts) {
        const line = p.split('\n').find((x) => x.startsWith('data: '));
        if (line) out.push(JSON.parse(line.slice(6)));
      }
    }
  } finally {
    ctrl.abort();
    await reader.cancel().catch(() => {});
  }
  return out;
}

test('传输：SSE 先 welcome 再按 since 补拉，id 用 seq', async (t) => {
  const replay = [
    { type: 'event', seq: 39, event: 'message', data: { content: '旧消息' } },
    { type: 'event', seq: 40, event: 'message', data: { content: '新消息' } },
  ];
  const { port } = await withServer(t, { frames: replay });
  const frames = await readSse(port, 'since=30', 3);
  assert.equal(frames[0].type, 'welcome');
  assert.equal(frames[0].since, 30);
  assert.equal(frames[1].seq, 39);
  assert.equal(frames[2].data.content, '新消息');
});

test('传输：broadcast 推给已连接的 SSE，heartbeat 不带 seq', async (t) => {
  const { port, srv } = await withServer(t);
  const ctrl = new AbortController();
  const res = await fetch(`${base(port)}/events`, { headers: auth, signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  srv.broadcast({ type: 'event', seq: 41, event: 'notice', data: { x: 1 } });
  srv.broadcast({ type: 'heartbeat', at: 123 });
  let text = '';
  try {
    while (!text.includes('"seq":41') || !text.includes('heartbeat')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  } finally {
    ctrl.abort();
    await reader.cancel().catch(() => {});
  }
  assert.match(text, /id: 41\n/);
  assert.match(text, /event: notice/);
  assert.match(text, /event: heartbeat/);
});

test('补拉语义：差太多发 gap、恰好接上补事件、首次连接不补拉', () => {
  const bridge = new HostBridge({
    runtime: makeRuntime(), cfg: { enabled: false }, botId: 'test-bot',
  });
  bridge.seq = 500;
  bridge.buffer = [
    { seq: 301, event: 'message', data: { n: 301 }, at: 1 },
    { seq: 302, event: 'message', data: { n: 302 }, at: 2 },
  ];

  const gap = bridge.replaySince(1);
  assert.equal(gap.length, 1, '缓冲不够时只回一条 gap，不假装补上了');
  assert.equal(gap[0].type, 'gap');
  assert.equal(gap[0].oldest, 301);
  assert.equal(gap[0].seq, 500);
  assert.ok(gap[0].message.includes('重开会话'));

  /** since = oldest-1 是「刚好接上」的边界，不该误报 gap */
  const edge = bridge.replaySince(300);
  assert.deepEqual(edge.map((x) => x.seq), [301, 302]);
  assert.ok(edge.every((x) => x.type === 'event'));

  assert.deepEqual(bridge.replaySince(301).map((x) => x.seq), [302]);
  assert.deepEqual(bridge.replaySince(500), []);
  assert.deepEqual(bridge.replaySince(0), [], '首次连接不该把历史全灌给新客户端');
});

/* ------------------------------------------------------------------ */
/* WS 主通道：装了 ws 才跑，没装的机器自动跳过（和 onebot-loopback 同约定） */
/* ------------------------------------------------------------------ */

/** 顶层 await：load 在没装时返回 null，不抛 */
const wsMod = typeof WebSocket === 'undefined' ? null : await extDeps.load('ws');

test('WS 主通道：hello/welcome → req/res → 事件推送', { skip: !wsMod && '没装 ws 或 Node 没有内置 WebSocket' }, async (t) => {
  const { methods } = makeMethods();
  const srv = createHostServer({
    host: '127.0.0.1', port: 0, token: TOKEN, ws: wsMod,
    attach: (_sink, info) => ({
      welcome: {
        protocol: 1, app: 'roost-host', seq: 9, since: info.since,
        features: methods.names(),
      },
      frames: [{ type: 'event', seq: 9, event: 'message', data: { content: '补拉的一条' } }],
    }),
    onRpc: async (frame) => {
      const data = await methods.call(frame.method, frame.params, {
        scopes: new Set(['read', 'message']),
      });
      return { id: frame.id, ok: true, data, http: 200 };
    },
  });
  const port = await srv.start();
  t.after(() => srv.stop());

  const ws = new WebSocket(`ws://127.0.0.1:${port}/?since=8&access_token=${TOKEN}`);
  const msgs = [];
  ws.addEventListener('message', (e) => msgs.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  t.after(() => ws.close());

  const wait = async (pred, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`没等到帧，已收到 ${msgs.map((x) => x.type).join(',')}`);
  };

  /** 不发 hello、直接 req 也要能握手（第一个 req 即握手，避免漏掉握手期间的事件） */
  ws.send(JSON.stringify({ type: 'req', id: 'w1', method: 'system.ping', params: {} }));
  const welcome = await wait((x) => x.type === 'welcome');
  assert.equal(welcome.protocol, 1);
  assert.equal(welcome.seq, 9);
  assert.ok(welcome.features.length >= MIN_METHODS);
  assert.ok(welcome.features.includes('media.image.list'), 'WS 握手的能力清单要含素材管理');

  const replay = await wait((x) => x.type === 'event' && x.seq === 9);
  assert.equal(replay.data.content, '补拉的一条');

  const res = await wait((x) => x.type === 'res' && x.id === 'w1');
  assert.equal(res.ok, true);
  assert.ok(res.data.pong > 0);

  srv.broadcast({ type: 'event', seq: 10, event: 'notice', data: { x: 1 } });
  const pushed = await wait((x) => x.type === 'event' && x.seq === 10);
  assert.deepEqual(pushed.data, { x: 1 });
});

test('HostBridge 端到端：start → 原生消息旁路推送 → RPC → stop', {
  skip: !wsMod && '没装 ws 或 Node 没有内置 WebSocket',
}, async (t) => {
  const runtime = makeRuntime();
  const bridge = new HostBridge({
    runtime,
    cfg: {
      enabled: true, token: TOKEN, host: '127.0.0.1', port: 0,
      scopes: ['read', 'message'], allowManage: false, forwardAll: true,
    },
    botId: 'test-bot',
  });
  t.after(() => bridge.stop());
  await bridge.start();
  assert.equal(bridge.state, 'running', `没能起来：${bridge.error}`);
  assert.ok(bridge.port >= 6800);

  /** 面板要的快照字段 */
  const snap = bridge.snapshot();
  assert.equal(snap.state, 'running');
  assert.equal(snap.mode, 'parallel');
  assert.deepEqual(snap.scopes, ['read', 'message']);
  assert.ok(bridge.capability().methods.length >= MIN_METHODS);

  /** HTTP RPC 走的是 #rpc，不是测试自己拼的方法表 */
  const hi = await rpc(bridge.port, 'system.hello');
  assert.equal(hi.status, 200);
  assert.equal(hi.body.data.bot.id, 'test-bot');
  assert.equal(hi.body.data.protocol, 1);

  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/?access_token=${TOKEN}`);
  const msgs = [];
  ws.addEventListener('message', (e) => msgs.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  t.after(() => ws.close());
  ws.send(JSON.stringify({ type: 'hello', since: 0, client: 'test' }));

  const wait = async (pred, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`没等到帧，已收到 ${msgs.map((x) => x.type).join(',')}`);
  };
  await wait((x) => x.type === 'welcome');

  /** bot.js 的 onMessage 传进来的原生 Message */
  bridge.onMessage({
    kind: 'group', chatId: 'g-openid', groupId: 'g-openid',
    userId: 'u-openid', uin: '', userName: '小明',
    id: 'msg-42', content: '看图', addressed: true,
    raw: { content: '<@bot> 看图', author: { bot: false } },
  });
  const ev = await wait((x) => x.type === 'event' && x.event === 'message');
  assert.equal(ev.data.chat.chatId, 'g-openid');
  assert.equal(ev.data.sender.openid, 'u-openid');
  assert.equal(ev.data.sender.uin, '');
  assert.equal(ev.data.msgId, 'msg-42');
  assert.equal(ev.data.content, '看图');
  assert.equal(ev.seq, 1);

  /** 机器人自己发的消息不能进事件流，否则客户端回一句就自激循环 */
  bridge.onMessage({
    kind: 'group', chatId: 'g-openid', id: 'self-1', content: '我说的',
    addressed: true, raw: { author: { bot: true } },
  });
  assert.equal(msgs.filter((x) => x.type === 'event').length, 1);

  await bridge.stop();
  assert.equal(bridge.state, 'stopped');
  assert.equal(bridge.port, 0);
});

test('缺 token 时拒绝监听，不让空 token 变成后门', async (t) => {
  /**
   * ws 缺失**不再**挡在 token 校验前面：缺 ws 只是没有 `/ws`，
   * HTTP + SSE 照常开，所以这条校验在任何环境下都该跑到。
   */
  const bridge = new HostBridge({
    runtime: makeRuntime(),
    cfg: { enabled: true, token: '', host: '127.0.0.1', port: 0 },
    botId: 'test-bot',
  });
  t.after(() => bridge.stop());
  await bridge.start();
  assert.equal(bridge.state, 'error');
  assert.match(bridge.error, /token/);
  assert.equal(bridge.port, 0, '空 token 绝不许真的 listen');
});

test('未开启时：方法表仍可查，状态与默认权限都收得住', () => {
  const bridge = new HostBridge({
    runtime: makeRuntime(),
    cfg: { enabled: false, allowManage: false, scopes: [] },
    botId: 'test-bot',
  });
  assert.equal(bridge.state, 'stopped');
  assert.ok(bridge.capability().methods.length >= MIN_METHODS, '没开监听也要能看到能力清单');
  assert.equal(bridge.capability().protocol, 1);
  assert.deepEqual(bridge.capability().scopes, ['read'], '显式空 scopes 时只剩 read');

  const snap = bridge.snapshot();
  assert.equal(snap.state, 'stopped');
  assert.equal(snap.port, 0);
  assert.equal(snap.connections, 0);
  assert.equal(snap.mode, 'parallel');
  assert.deepEqual(snap.actions, { ok: 0, fail: 0 });
});
