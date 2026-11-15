/**
 * 票据自检服务
 * ============
 *
 * 这个服务本身不换票，它只负责「**主动**问一句还能不能用」。会不会换票是
 * `platform` 的事（收到 401 就开无头浏览器换一张）。所以这里测的是取舍：
 *
 *   1. 本机没票 → 什么都不做。凭空开浏览器是最忌讳的（用户会以为在偷登录）。
 *   2. mock 环境 → 什么都不做，不然联调日志里会混进真实票据的换票记录。
 *   3. 正常 → 只在状态变化时说一次，别每小时刷一条。
 *   4. 不行 → 同样只在**结论变化**时 warn，避免每轮重复同一句。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 服务会去恢复本机票据，指到临时目录避免读到真实登录态
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'roost-ticket-'));
process.env.ROOST_HOME = HOME;

const { DevTicketService } = await import('../src/services/dev-ticket.js');
const { getDevPlatform } = await import('../src/host/dev.js');
const { recentLogs } = await import('../src/logger.js');

const P = getDevPlatform();
const orig = { status: P.status, checkSession: P.checkSession };
test.after(async () => {
  P.status = orig.status;
  P.checkSession = orig.checkSession;
  await fs.rm(HOME, { recursive: true, force: true });
});

/** 装一套假状态，返回调用计数 */
function stub({ loggedIn = true, state = 'ready', message = '可以改', hint = '' } = {}) {
  const calls = { status: 0, check: 0 };
  P.status = async () => { calls.status += 1; return { loggedIn }; };
  P.checkSession = async () => { calls.check += 1; return { state, message, hint }; };
  return calls;
}

/** 取本服务写进日志的条目（别被别的模块干扰） */
const ticketLogs = (level) => recentLogs(300).filter((e) => e.tag === 'devTicket' && e.level === level);

test('本机没票就不探：不该凭空开浏览器', async () => {
  const calls = stub({ loggedIn: false });
  const svc = new DevTicketService({ getRuntimes: () => [{ id: 'main', mock: false }] });
  await svc.tick();
  assert.equal(calls.check, 0, '没票还去 checkSession(verify) = 白开一次浏览器');
});

test('mock 环境直接跳过', async () => {
  const calls = stub();
  const svc = new DevTicketService({ getRuntimes: () => [{ id: 'main', mock: true }] });
  await svc.tick();
  assert.equal(calls.status, 0, 'mock 下连本机状态都不用看');
  assert.equal(calls.check, 0);
});

test('正常时只在状态第一次出现时说一句，不刷屏', async () => {
  stub({ state: 'ready', message: '可以改' });
  const svc = new DevTicketService({ getRuntimes: () => [{ id: 'main', cfg: { appId: '102055275' } }] });
  const before = ticketLogs('info').length;
  await svc.tick();
  await svc.tick();
  await svc.tick();
  assert.equal(ticketLogs('info').length - before, 1, '每 30 分钟复读一遍就成了噪音');
});

test('票据不可用：结论变化才 warn，重复轮次不再喊', async () => {
  stub({ state: 'expired', message: '登录已过期，请重新登录', hint: '点「扫码登录」' });
  const svc = new DevTicketService({ getRuntimes: () => [{ id: 'main', cfg: { appId: '102055275' } }] });
  const before = ticketLogs('warn').length;

  await svc.tick();
  assert.equal(ticketLogs('warn').length - before, 1);
  assert.match(ticketLogs('warn').at(-1).msg, /登录已过期/);
  // hint 要带出来：用户看到 warn 得知道下一步做什么
  assert.match(ticketLogs('warn').at(-1).msg, /扫码登录/);

  await svc.tick();
  assert.equal(ticketLogs('warn').length - before, 1, '同样的结论不该反复喊');
});

test('间隔有下限：配 1 分钟也按 5 分钟走，免得把自己打进限频', () => {
  const svc = new DevTicketService({ getRuntimes: () => [], minutes: 1 });
  assert.equal(svc.intervalMs, 5 * 60_000);
});
