/**
 * `ctx.api` 记账代理回归（2026-11-06 批次 5）
 * ==========================================
 *
 * 背景：出站账本只在 `Outbound.send()` 的两个出口落账，插件拿到的是裸的
 * `QQApi` 实例，`ctx.api.sendGroup(...)` 直接打接口 —— 不进账本，「谁」列也空。
 * 复核把这条列成「绕过 outbound 的既有路径」，按主人拍板的 C 档用 Proxy 收口。
 *
 * 这里锁住四件事：
 *   1. 代理**不切断**私有字段与 `this`（`#request` 这类只认原对象）；
 *   2. 原对象一个字节都不动，非函数属性（`seqMap`）直读、方法身份稳定；
 *   3. 发送成功后补记一笔，插件名与富媒体占位正确，失败不记；
 *   4. 记账本身出错不许冒泡到发送链路。
 *
 * 跑法：node --test test/api-record.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Outbound } from '../src/outbound.js';
import { createLedger } from '../src/ledger.js';
import { wrapApiForLedger } from '../src/plugin/api-record.js';

/**
 * 冒充 QQApi：带私有字段，`ping()` 读它 —— 代理若把 `this` 换成代理自己，
 * 这里会直接抛 `Cannot read private member`。
 */
class FakeApi {
  #secret = 'ok';

  constructor() {
    this.seqMap = new Map([['m1', 1]]);
    this.fail = false;
    this.sent = [];
  }

  ping() {
    return this.#secret;
  }

  readSeq(id) {
    return this.seqMap.get(id) ?? 0;
  }

  async sendGroup(target, opts = {}) {
    if (this.fail) throw new Error('offline');
    this.sent.push(['group', target, opts]);
    return { id: 'out-1' };
  }

  async sendC2C(target, opts = {}) {
    if (this.fail) throw new Error('offline');
    this.sent.push(['c2c', target, opts]);
    return { id: 'out-2' };
  }

  async sendMedia(scene, target, opts = {}) {
    this.sent.push([scene === 'group' ? 'group' : 'c2c', target, opts]);
    return { file_uuid: 'f-1' };
  }

  async sendStreamMessage(target, p = {}) {
    this.sent.push(['c2c', target, p]);
    return { id: '', stream_msg_id: 'stream-1' };
  }
}

/** 真账本 + 真 Outbound，假 api —— 与生产同一条记账链路 */
function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-apirec-'));
  const ledger = createLedger({ file: path.join(dir, 'events.db'), botId: 'main', retentionDays: 0 });
  ledger.open();
  t.after(() => {
    try { ledger.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  const api = new FakeApi();
  const out = new Outbound({
    api,
    cfg: {},
    isOnline: () => true,
    quotaFile: path.join(dir, 'quota.json'),
    ledger,
  });
  const ctxApi = wrapApiForLedger(api, { outbound: out, plugin: 'ai-chat' });
  const rows = () => ledger.exportRows();
  return { api, out, ctxApi, ledger, rows };
}

/* ---------------- 1. 代理不切断私有字段与 this ---------------- */

test('代理：私有字段仍读得到（this 绑回原对象，不是代理）', () => {
  const api = new FakeApi();
  const ctxApi = wrapApiForLedger(api, { outbound: null });
  assert.equal(ctxApi.ping(), 'ok', '私有字段 #secret 必须能从原对象读到');
  assert.equal(ctxApi.readSeq('m1'), 1);
  assert.ok(ctxApi instanceof FakeApi, '原型链要保住');
});

test('代理：原对象未被改写，非函数属性直读，方法身份稳定', () => {
  const api = new FakeApi();
  const rawSend = api.sendGroup;
  const ctxApi = wrapApiForLedger(api, { outbound: null });

  assert.equal(api.sendGroup, rawSend, '原对象的方法不能被替换');
  assert.equal(ctxApi.seqMap, api.seqMap, '非函数属性原样返回，不做拷贝');
  assert.equal(ctxApi.sendGroup, ctxApi.sendGroup, '同一个方法要拿到同一个包装');
  assert.notEqual(ctxApi, api, '代理是独立一层');
});

/* ---------------- 2. 记账 ---------------- */

test('记账：sendGroup 成功后补一笔，摘要取 markdown 正文、带上插件名', async (t) => {
  const { ctxApi, rows } = rig(t);
  await ctxApi.sendGroup('g1', { markdown: { content: '你好呀' } });

  const all = rows();
  assert.equal(all.length, 1, `应当正好记一笔，实际 ${all.length}`);
  assert.equal(all[0].kind, 'group');
  assert.equal(all[0].plugin, 'ai-chat');
  assert.equal(all[0].content, '你好呀', 'markdown 报文也要有摘要，不能空');
});

test('记账：sendC2C 失败不记（发不出去就不该算发过）', async (t) => {
  const { api, ctxApi, rows } = rig(t);
  api.fail = true;
  await assert.rejects(() => ctxApi.sendC2C('u1', { content: '在吗' }), /offline/);
  assert.equal(rows().length, 0);
});

test('记账：sendMedia 按 scene 定 kind，媒体摘要给中文占位', async (t) => {
  const { ctxApi, rows } = rig(t);
  /** 真实报文形状：`sendMedia` 传的是 `{fileType, url}`，**没有 `media`** */
  await ctxApi.sendMedia('group', 'g1', { fileType: 1, url: 'http://x/1.png' });

  const all = rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].kind, 'group');
  assert.equal(all[0].content, '（图片）', '没有 media 字段时也要给占位，不然账本里是空行');
});

test('记账：流式消息只在结束片记一笔，中途片不记', async (t) => {
  const { ctxApi, rows } = rig(t);
  await ctxApi.sendStreamMessage('u1', { contentRaw: '第一片', index: 0, state: 1 });
  assert.equal(rows().length, 0, '生成中的分片不该进账本');

  await ctxApi.sendStreamMessage('u1', { contentRaw: '全文', index: 1, state: 10 });
  const all = rows();
  assert.equal(all.length, 1, '结束片记一笔');
  assert.equal(all[0].kind, 'c2c');
  assert.equal(all[0].content, '全文');
  /** 结束片服务端只给 `stream_msg_id`、`id` 是空串时，得退到后者当幂等键 */
  assert.equal(all[0].msg_id, 'stream-1', 'id 为空要退到 stream_msg_id');
});

test('记账：连发多张图不会被去重吞行（空 id 退到 file_uuid）', async (t) => {
  const { api, ctxApi, rows } = rig(t);
  /** 只回 `file_uuid` 的宿主：没有 `id` 时全靠它区分三条记录 */
  api.sendMedia = async (scene, target) => {
    api.sent.push([scene, target]);
    return { file_uuid: `f-${api.sent.length}` };
  };
  await ctxApi.sendMedia('group', 'g1', { fileType: 1, url: 'http://x/1.png' });
  await ctxApi.sendMedia('group', 'g1', { fileType: 1, url: 'http://x/2.png' });
  await ctxApi.sendMedia('group', 'g1', { fileType: 1, url: 'http://x/3.png' });

  assert.equal(rows().length, 3, '同一个毫秒、同一句摘要，也不能被 INSERT OR IGNORE 吞掉');
});

/* ---------------- 3. 边界 ---------------- */

test('边界：没有 outbound 时照常发，不记账也不抛', async () => {
  const api = new FakeApi();
  const ctxApi = wrapApiForLedger(api, { outbound: null });
  const r = await ctxApi.sendGroup('g1', { content: 'hi' });
  assert.equal(r.id, 'out-1');
  assert.equal(api.sent.length, 1);
});

test('边界：记账抛错不冒泡，消息照发', async (t) => {
  const { api, rows } = rig(t);
  const ctxApi = wrapApiForLedger(api, {
    outbound: { recordDirect: () => { throw new Error('ledger boom'); } },
    plugin: 'ai-chat',
  });
  const r = await ctxApi.sendGroup('g1', { content: '还发得出去吗' });
  assert.equal(r.id, 'out-1', '记账失败不能连累发送');
  assert.equal(rows().length, 0);
});

test('边界：api 不是对象时原样返回（老宿主 / 假宿主兼容）', () => {
  assert.equal(wrapApiForLedger(null), null);
  assert.equal(wrapApiForLedger(undefined), undefined);
});

/* ---------------- 网络错误的分类与文案（2026-11-13） ---------------- */

{
  const { isSafeToRetryNetworkError, networkReasonOf, networkCodeOf } = await import('../src/api.js');

  /**
   * 只许重试「连接根本没建起来」的那几种。分类错了的代价不对称：
   * 少重试 → 少回一条；多重试 → 群里出现两条一样的消息（每次发送占一个新
   * 的 `msg_seq`，服务端不会去重）。
   */
  test('网络错误：连不上可以重试，连接被重置/超时不行', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
      assert.equal(isSafeToRetryNetworkError(code), true, `${code} 应当可重试`);
    }
    for (const code of ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ETIMEDOUT', '']) {
      assert.equal(isSafeToRetryNetworkError(code), false, `${code} 不能重试（可能已经发出去了）`);
    }
  });

  /**
   * `fetch failed` 不带原因的话，日志里断连 / DNS / 超时长一个样。
   * 2026-11-13「发不出去」就是被这一行卡住的。
   */
  test('网络错误：文案要带上 cause.code（含 AggregateError 形状）', () => {
    const plain = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    assert.equal(networkReasonOf(plain), 'fetch failed（ECONNRESET）');

    const agg = Object.assign(new TypeError('fetch failed'), {
      cause: { errors: [{ code: 'ENOTFOUND' }, { code: 'EAI_AGAIN' }] },
    });
    assert.equal(networkCodeOf(agg), 'ENOTFOUND');
    assert.match(networkReasonOf(agg), /fetch failed（ENOTFOUND）/);

    const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    assert.equal(networkReasonOf(timeout), '请求超时（15s）');

    assert.equal(networkReasonOf(new TypeError('fetch failed')), 'fetch failed');
  });
}
