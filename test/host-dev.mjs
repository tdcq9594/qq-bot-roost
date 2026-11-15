/**
 * 开放平台（dev.*）契约测试
 * ==========================
 *
 * 全程不联网：所有 CGI 都由假 fetch 应答。要钉死的是**边界**，不是官方行为——
 * 官方字段以后可能变，但「必须显式 appid」「票据不进返回值」「写操作要 message
 * 权限」「登录要 manage」这些是我们自己的承诺。
 *
 * 跑法：node --test test/host-dev.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bknOf, parseCookies, mergeSetCookies, createDevSession,
} from '../src/dev/session.js';
import { developerIdOf, extractCookies, createDevPlatform, requireBoundAppid } from '../src/dev/platform.js';
import { createMethods } from '../src/host/methods.js';

const jsonRes = (data, headers = {}) => new Response(JSON.stringify(data), {
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
});

test('bkn：hash-5381 取低 31 位，稳定且非负', () => {
  assert.equal(bknOf(''), 5381);
  const a = bknOf('abcdef');
  assert.equal(a, bknOf('abcdef'));
  assert.ok(a > 0 && a <= 0x7fffffff);
  assert.notEqual(a, bknOf('abcdeg'));
});

test('parseCookies：cookie 串 / 数组 / 对象三种形态', () => {
  const a = parseCookies('p_skey=abc; qticket_lite=x=y');
  assert.equal(a.get('p_skey'), 'abc');
  // 值里的等号不能被切掉（base64 padding 很常见）
  assert.equal(a.get('qticket_lite'), 'x=y');

  const b = parseCookies([{ name: 'p_skey', value: '1' }, { name: 'quid', value: '2' }]);
  assert.equal(b.get('quid'), '2');

  const c = parseCookies({ p_skey: 'z' });
  assert.equal(c.get('p_skey'), 'z');
});

test('extractCookies：从 Copy as cURL 里只抠 Cookie 头', () => {
  const curl = "curl 'https://bot.q.qq.com/cgi-bin/v2/info/list_bots' "
    + "-H 'cookie: p_skey=abc; qticket_lite=def; developer_id_lite=123' "
    + "-H 'content-type: application/json' --data-raw '{}'";
  const jar = extractCookies(curl);
  assert.equal(jar.get('p_skey'), 'abc');
  assert.equal(jar.get('qticket_lite'), 'def');
  assert.equal(jar.has('content-type'), false);

  // JSON 导出
  const jar2 = extractCookies('[{"name":"p_skey","value":"q"}]');
  assert.equal(jar2.get('p_skey'), 'q');

  // 纯 cookie 串
  assert.equal(extractCookies('p_skey=k').get('p_skey'), 'k');
  assert.equal(extractCookies('').size, 0);
});

test('mergeSetCookies：只收票据键，空值等于删除', () => {
  const jar = new Map([['p_skey', 'old']]);
  const n = mergeSetCookies(jar, [
    'p_skey=new; Path=/; HttpOnly',
    'unrelated=1; Path=/',
    'qticket_lite=; Max-Age=0',
  ]);
  assert.equal(n, 2);
  assert.equal(jar.get('p_skey'), 'new');
  assert.equal(jar.get('qticket_lite'), '');
  assert.equal(jar.has('unrelated'), false);
});

test('developerIdOf：十六进制主体 id 必须原样送，不能被「清洗」成数字', () => {
  assert.equal(developerIdOf(new Map()), 0);
  // 老格式：纯数字（可能带前缀字母），转数字
  assert.equal(developerIdOf(new Map([['developer_id_lite', 'o123456']])), 123456);
  /**
   * 新格式：32 位 hex。以前这里删掉字母只剩数字，平台对不上号 →
   * `retcode:10000 系统繁忙`。这条就是防止再退回去。
   */
  const hex = 'c846ac08cbe603c3e9e0db8a3a5c4e7b';
  assert.equal(developerIdOf(new Map([['developer_id_lite', hex]])), hex);
});

test('会话：没票据时直接拒绝，不去打接口', async () => {
  let hit = 0;
  const s = createDevSession({ fetchImpl: async () => { hit += 1; return jsonRes({}); } });
  await assert.rejects(() => s.post('/cgi-bin/v2/info/list_bots', {}), (e) => e.code === 'NOT_LOGGED_IN');
  assert.equal(hit, 0);
});

test('会话：adopt 之后 describe 不带票据值', () => {
  const s = createDevSession();
  const d = s.adopt('p_skey=secret-value; qticket_lite=t; quid=q');
  assert.equal(d.loggedIn, true);
  assert.equal(JSON.stringify(d).includes('secret-value'), false);
  assert.equal(JSON.stringify(d).includes('t'), true); // hasTicket 是布尔，只允许出现 true
  s.clear();
  assert.equal(s.describe().loggedIn, false);
});

function fakeFetch({ bots = [], calls = [] } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    // 头像上传走 multipart，body 是 FormData，不能当 JSON 解
    calls.push({
      url: u,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body ?? null,
    });
    if (u.includes('/info/list_bots')) {
      return jsonRes({ retcode: 0, data: { bots, create_remain: 1 } });
    }
    if (u.includes('/info/query')) {
      return jsonRes({
        retcode: 0,
        data: {
          base_info: { bot_name: '小鸟', bot_desc: '旧简介', bot_avatar: 'https://a' },
          developer_info: { admin_uin: 10001, admin_nick_name: '主人', subject_type: 1 },
        },
      });
    }
    if (u.includes('/bot_dev_setting/query')) {
      return jsonRes({
        retcode: 0,
        data: {
          connect_info: { mode: 1, webhook_url: 'https://old' },
          event: { all_subscription: false, events: [] },
          ip_whitelist_info: { ip_addresses: ['1.1.1.1'] },
        },
      });
    }
    return jsonRes({ retcode: 0, data: {} });
  };
}

test('导入：能读机器人列表，且记住=落盘是可选项', async () => {
  const calls = [];
  const P = createDevPlatform({
    fetchImpl: fakeFetch({
      calls,
      bots: [{
        bot_appid: 102030, bot_name: '小鸟', bot_avatar: 'https://a', bot_desc: 'd',
        online_state: { online_state: true }, bot_status: 0, user_type: 1,
      }],
    }),
  });
  const out = await P.loginImport('p_skey=k; qticket_lite=t; developer_id_lite=o42', { remember: false });
  assert.equal(out.ok, true);
  assert.equal(out.botCount, 1);
  const first = calls[0];
  assert.match(first.url, /list_bots/);
  assert.equal(first.body.developer_id, 42);
  assert.equal(first.body.filter.page_limit, 100);
  assert.equal(out.loggedIn, true);
});

test('列表：归一化在线状态与注销中', async () => {
  const P = createDevPlatform({
    fetchImpl: fakeFetch({
      bots: [
        { bot_appid: 1, bot_name: 'A', online_state: { online_state: true }, bot_status: 0 },
        { bot_appid: 2, bot_name: 'B', online_state: { online_state: false }, bot_status: 2 },
        { bot_name: '没 appid 的脏数据' },
      ],
    }),
  });
  await P.loginImport('p_skey=k');
  const bots = await P.listBots();
  assert.equal(bots.length, 2);
  assert.equal(bots[0].online, true);
  assert.equal(bots[1].revoking, true);
});

test('改配置：appid 必须显式，字段映射要对', async () => {
  const calls = [];
  const P = createDevPlatform({ fetchImpl: fakeFetch({ calls }) });
  await P.loginImport('p_skey=k');

  await assert.rejects(() => P.setBot('', { base: { desc: 'x' } }), /bot_appid/);

  await P.setBot('102030', { base: { desc: '新简介' } });
  const m = calls.find((c) => c.url.includes('/info/modify'));
  assert.ok(m, '没发 info/modify');
  assert.equal(m.body.bot_appid, 102030);
  assert.equal(m.body.filter.desc, 1);
  assert.equal(m.body.filter.name, 0);
  assert.equal(m.body.desc, '新简介');

  await P.setBot('102030', { connect: { action: 1, webhookUrl: 'https://new' } });
  const c = calls.find((x) => x.url.includes('/connect_info/modify'));
  assert.equal(c.body.action, 1);
  assert.equal(c.body.webhook_url, 'https://new');

  await P.setBot('102030', { ip: { action: 1, addresses: ['2.2.2.2'] } });
  const ip = calls.find((x) => x.url.includes('/ip_whitelist/modify'));
  assert.deepEqual(ip.body.ip_addresses, ['2.2.2.2']);
});

test('改配置：replace 模式按差集增删，不是无脑覆盖', async () => {
  const calls = [];
  const P = createDevPlatform({ fetchImpl: fakeFetch({ calls }) });
  await P.loginImport('p_skey=k');
  await P.setBot('102030', { ip: { mode: 'replace', addresses: ['3.3.3.3'] } });

  const mods = calls.filter((c) => c.url.includes('/ip_whitelist/modify'));
  assert.equal(mods.length, 2, '应该一次增、一次删');
  const add = mods.find((c) => c.body.action === 1);
  const del = mods.find((c) => c.body.action === 2);
  assert.deepEqual(add.body.ip_addresses, ['3.3.3.3']);
  assert.deepEqual(del.body.ip_addresses, ['1.1.1.1']);
});

test('协议：dev.* 都进能力表，且 scope 分级正确', () => {
  const m = createMethods({ runtime: {}, getState: () => ({}) });
  const map = new Map(m.describe().map((x) => [x.name, x.scope]));
  assert.equal(map.get('dev.status'), 'read');
  assert.equal(map.get('dev.bots'), 'read');
  assert.equal(map.get('dev.bot.get'), 'read');
  assert.equal(map.get('dev.bot.set'), 'message');
  // 登录相关一律 manage：票据等于该开发者全部机器人的管理权
  assert.equal(map.get('dev.login.scan'), 'manage');
  assert.equal(map.get('dev.login.scan.cancel'), 'manage');
  assert.equal(map.get('dev.login.import'), 'manage');
  assert.equal(map.get('dev.login.logout'), 'manage');
  // 换浏览器路径等于换「谁来替你登录」，同样归 manage
  assert.equal(map.get('dev.browser.set'), 'manage');
});

test('协议：默认令牌没有 manage 时，登录方法被挡', async () => {
  const m = createMethods({ runtime: {}, getState: () => ({}) });
  const scopes = new Set(['read', 'message']);
  await assert.rejects(
    () => m.call('dev.login.import', { input: 'p_skey=k' }, { scopes }),
    (e) => e.code === 'NO_SCOPE',
  );
  // 只读方法不受影响
  await assert.rejects(
    () => m.call('dev.bots', {}, { scopes }),
    (e) => e.code === 'INTERNAL' && /登录/.test(e.message),
  );
});

test('extractCookies：cmd 续行 / 只复制 header 行 / bash 续行都要认', () => {
  // cmd 的 Copy as cURL：双引号 + 行尾 ^ 续行
  const cmd = 'curl "https://bot.q.qq.com/cgi-bin/v2/info/list_bots" ^\r\n'
    + '  -H "cookie: b-token=bt; qticket_lite=tl" ^\r\n'
    + '  --data-raw "{}"';
  assert.equal(extractCookies(cmd).get('b-token'), 'bt');

  // 只复制了 DevTools 请求头面板里的那一段
  const bare = 'accept: */*\r\ncookie: b-token=bt2; quid=9\r\nreferer: https://q.qq.com/';
  assert.equal(extractCookies(bare).get('b-token'), 'bt2');

  // bash 版（反斜杠续行）照样认
  const bash = "curl 'https://bot.q.qq.com/x' \\\n  -H 'cookie: p_skey=p1' \\\n  --data-raw '{}'";
  assert.equal(extractCookies(bash).get('p_skey'), 'p1');
});

test('「只能改当前机器人」：不相等直接拒，且是 403', () => {
  // 配置里没填 AppID：目标都定不了，不该放行
  assert.throws(() => requireBoundAppid('123', '', '小鸟'), (e) => e.code === 'NO_LOCAL_APPID' && e.http === 400);
  assert.throws(() => requireBoundAppid('123', '456', '小鸟'), (e) => e.code === 'NOT_BOUND' && e.http === 403);
  assert.throws(() => requireBoundAppid('', '456'), (e) => e.code === 'BAD_APPID');
  // 相等才放行，并把 appid 原样回给调用方（配置里手填很容易带空格）
  assert.equal(requireBoundAppid('456', '456', '小鸟'), '456');
  assert.equal(requireBoundAppid(' 456 ', '456'), '456');
});

test('导入：认不出票据键时就地打住，不去打接口', async () => {
  const calls = [];
  const P = createDevPlatform({ fetchImpl: fakeFetch({ calls }) });
  await assert.rejects(
    () => P.loginImport('foo=1; bar=2'),
    (e) => e.code === 'NO_TICKET' && /foo, bar/.test(e.message),
  );
  assert.equal(calls.length, 0, '没有票据键还发请求 = 白挨一次限频');
});

test('换头像：给 avatarId 就直接套用，不试上传接口', async () => {
  const calls = [];
  const P = createDevPlatform({ fetchImpl: fakeFetch({ calls }) });
  await P.loginImport('b-token=bt');
  await P.setAvatar('102030', { avatarId: 'av-1' });

  assert.equal(calls.some((c) => c.url.includes('upload_avatar')), false);
  const m = calls.find((c) => c.url.includes('/info/modify'));
  assert.equal(m.body.bot_appid, 102030);
  assert.equal(m.body.avatar_id, 'av-1');
  assert.equal(m.body.filter.avatar, 1);
});

test('换头像：上传拿到 id 自动套用；拿不到 id 要报清楚', async () => {
  const calls = [];
  const ok = createDevPlatform({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body });
      if (String(url).includes('upload_avatar')) {
        return jsonRes({ retcode: 0, data: { file_info: { avatar_id: 'up-9' } } });
      }
      return jsonRes({ retcode: 0, data: {} });
    },
  });
  await ok.loginImport('b-token=bt');
  const out = await ok.setAvatar('102030', { dataUrl: 'data:image/png;base64,AAAA' });
  assert.equal(out.avatarId, 'up-9');
  assert.equal(out.uploaded, true);
  const mod = calls.find((c) => c.url.includes('/info/modify'));
  assert.equal(JSON.parse(mod.body).avatar_id, 'up-9');

  // 上传接口回了 0 但没 id：不能假装成功
  const bad = createDevPlatform({ fetchImpl: async () => jsonRes({ retcode: 0, data: {} }) });
  await bad.loginImport('b-token=bt');
  await assert.rejects(
    () => bad.setAvatar('102030', { dataUrl: 'data:image/png;base64,AAAA' }),
    (e) => e.code === 'AVATAR_UPLOAD_FAILED' && /avatar/i.test(e.message),
  );
});

test('换头像：既没图也没 id 时给出明确错误', async () => {
  const P = createDevPlatform({ fetchImpl: fakeFetch({}) });
  await P.loginImport('b-token=bt');
  await assert.rejects(() => P.setAvatar('102030', {}), /本地图片|图片地址/);
  await assert.rejects(() => P.setAvatar('102030', { url: 'ftp://x/y.png' }), /图片地址/);
});

test('协议：换头像进能力表，和改配置同级', () => {
  const m = createMethods({ runtime: {}, getState: () => ({}) });
  const map = new Map(m.describe().map((x) => [x.name, x.scope]));
  assert.equal(map.get('dev.bot.avatar'), 'message');
});
