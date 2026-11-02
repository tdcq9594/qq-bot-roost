// 群名缓存：成功 / 无权限 / 普通失败 / 并发去重 / 负缓存后重试。
//
// 这条链路以前**零测试**：`grep fetchGroupNames test/` 一条都没有。
// 于是「错误码读错字段」这种 bug 活了很久——11253 被当成普通失败，每 30 秒重试
// 一次，正好撞上接口频控，而测试全绿。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 数据目录必须指到临时目录：构造函数会建 GroupStore / reach / gate 这些文件。
 * DIRS 在模块加载时就算好了，所以要先设环境变量再动态 import。
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-gn-'));
process.env.ROOST_HOME = HOME;

const { BotRuntime } = await import('../src/bot.js');

function makeBot(getGroupInfo) {
  const rt = new BotRuntime({
    cfg: { id: `t${Math.random().toString(36).slice(2, 8)}`, name: 't', appId: 'a', appSecret: 's' },
    globalCfg: {},
  });
  rt.calls = 0;
  rt.api = {
    getGroupInfo: async (id) => {
      rt.calls++;
      return getGroupInfo(id, rt.calls);
    },
  };
  return rt;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('群名：拉到就缓存，TTL 10 分钟，第二次不再打接口', async () => {
  const rt = makeBot(async () => ({ group_name: '摸鱼群' }));
  await rt.fetchGroupNames(['G1']);

  assert.equal(rt.groupName('G1'), '摸鱼群');
  assert.equal(rt.calls, 1);
  assert.equal(rt.groupNames.get('G1').ttl, 10 * 60_000);

  await rt.fetchGroupNames(['G1']);
  assert.equal(rt.calls, 1, '缓存还在，不该再打接口');
});

test('群名：11253（无权限）缓存一天，别每 30 秒重试', async () => {
  const rt = makeBot(async () => {
    const e = new Error('no permission');
    e.qqCode = 11253;
    throw e;
  });
  await rt.fetchGroupNames(['G2']);

  assert.equal(rt.groupName('G2'), undefined, '拿不到就是没有名字（groupName 空名返回 undefined）');
  assert.equal(rt.groupNames.get('G2').ttl, 24 * 3600_000, '11253 要缓存一天');

  await rt.fetchGroupNames(['G2']);
  assert.equal(rt.calls, 1, '一天内不该重试');
});

test('群名：普通失败只缓存 30 秒，过点会重试（先失败后恢复能自愈）', async () => {
  let fail = true;
  const rt = makeBot(async () => {
    if (fail) throw new Error('网络抖了一下');
    return { group_name: '恢复了' };
  });

  await rt.fetchGroupNames(['G3']);
  assert.equal(rt.groupName('G3'), undefined);
  assert.equal(rt.groupNames.get('G3').ttl, 30_000, '普通失败不能缓存一天');

  // 把时间拨到 31 秒前，模拟冷却结束
  rt.groupNames.set('G3', { ...rt.groupNames.get('G3'), at: Date.now() - 31_000 });
  fail = false;
  await rt.fetchGroupNames(['G3']);
  assert.equal(rt.groupName('G3'), '恢复了');
  assert.equal(rt.calls, 2, '冷却结束应该重试一次');
});

test('群名：同一个群并发补名只打一次接口', async () => {
  const rt = makeBot(async () => {
    await sleep(20);
    return { group_name: '慢群' };
  });

  // 消息链路和面板会同时来一次，缓存写入在 await 之后 → 没有 in-flight 就会打两次
  await Promise.all([rt.fetchGroupNames(['G4']), rt.fetchGroupNames(['G4'])]);
  assert.equal(rt.calls, 1, 'in-flight 去重没生效');
  assert.equal(rt.groupName('G4'), '慢群');
});

test('群名：拉不到也不抛异常（消息链路不能被显示用的名字搞挂）', async () => {
  const rt = makeBot(async () => {
    throw new Error('接口 500');
  });
  await assert.doesNotReject(() => rt.fetchGroupNames(['G5']));
});

test('群名：空 id / 重复 id 不会打接口', async () => {
  const rt = makeBot(async () => ({ group_name: 'x' }));
  await rt.fetchGroupNames([]);
  await rt.fetchGroupNames(['', null, undefined]);
  assert.equal(rt.calls, 0);
});

test.after(() => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {}
});

test('群名：批量补名有并发上限（官方接口 30 QPM，全并行会一个都拿不到）', async () => {
  let inflight = 0;
  let peak = 0;
  const rt = makeBot(async (id) => {
    inflight++;
    peak = Math.max(peak, inflight);
    await sleep(10);
    inflight--;
    return { group_name: `群${id}` };
  });

  const ids = Array.from({ length: 10 }, (_, i) => `G${i}`);
  await rt.fetchGroupNames(ids, { timeoutMs: 3000 });

  assert.ok(peak <= 4, `并发峰值 ${peak} 超过上限 4`);
  assert.equal(rt.calls, 10, '十个群都要拉到');
});

test('群名：concurrency 传 NaN 不会一个都不拉', async () => {
  const rt = makeBot(async (id) => ({ group_name: `群${id}` }));
  // Math.min(NaN, n) 是 NaN，Array.from({length:NaN}) 是空数组 → 一个都不拉
  await rt.fetchGroupNames(['N1', 'N2', 'N3'], { concurrency: NaN });
  assert.equal(rt.calls, 3, 'NaN 要退回默认并发，不能变成 0');
});

test('群名：并发上限是全局的（两次批量并行也不超过 4）', async () => {
  let inflight = 0;
  let peak = 0;
  const rt = makeBot(async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    await sleep(15);
    inflight--;
    return { group_name: 'x' };
  });

  await Promise.all([
    rt.fetchGroupNames(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'], { timeoutMs: 3000 }),
    rt.fetchGroupNames(['B1', 'B2', 'B3', 'B4', 'B5', 'B6'], { timeoutMs: 3000 }),
  ]);

  assert.ok(peak <= 4, `并发峰值 ${peak} 超过全局上限 4`);
  assert.equal(rt.calls, 12, '十二个群都要拉到');
});

test('群名：超时后不再派新的请求（尾巴不能一直延长）', async () => {
  const rt = makeBot(async () => {
    await sleep(30);
    return { group_name: 'x' };
  });

  const ids = Array.from({ length: 12 }, (_, i) => `T${i}`);
  await rt.fetchGroupNames(ids, { timeoutMs: 5, concurrency: 2 });
  const atReturn = rt.calls;

  await sleep(150);
  // 已经发出去的那两个收不回来，但不能再派新的
  assert.ok(
    rt.calls <= atReturn + 2,
    `超时后还在派活：返回时 ${atReturn} 次，150ms 后 ${rt.calls} 次`,
  );
});
