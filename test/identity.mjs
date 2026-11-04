// 身份对照表：QQ号 / 群号 ↔ openid
//
// 这张表唯一的用途是「换机器人之后还能认出是同一个人 / 同一个群」，
// 所以测试重点全在**跨 bot** 和**并发写**上，不在增删改查本身。
//
// 重点覆盖：
//   - uinFromKey 对旧记忆键形态的识别（含必须排除的 openid 形态）
//   - 人和群分开（群会话读到私聊记忆 = 串场，这个错很隐蔽）
//   - 未绑定抛 IDENTITY_UNBOUND（插件靠它给管理员一句话）
//   - 两个进程交替写：谁都不能把对方写的 claim 抹掉
//   - 解绑之后不会被旧进程的落盘「复活」

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { IdentityStore, uinFromKey, isValidUin, unboundError, UNBOUND, CONFLICT, INVALID } = await import(
  '../src/identity.js'
);

/** 每个用例一个独立目录，互不干扰 */
function tmpFile(name = 'identity.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-id-'));
  return path.join(dir, name);
}

const OPENID_A = '5559767753895AA8456F848BCC489133';
const OPENID_B = 'AA8456F848BCC4891335559767753895';

/* ============ 号码提取 ============ */

test('uinFromKey：认得出旧记忆的四种键形态', () => {
  // AstrBot 的会话 id
  assert.equal(uinFromKey('aiocqhttp:GroupMessage:763366431'), '763366431');
  // 带前缀
  assert.equal(uinFromKey('group_763366431'), '763366431');
  assert.equal(uinFromKey('user-10001'), '10001');
  // 纯号码
  assert.equal(uinFromKey('763366431'), '763366431');
  // 私聊会话 id
  assert.equal(uinFromKey('aiocqhttp:FriendMessage:10001'), '10001');
});

test('uinFromKey：openid 一律不认成号码', () => {
  // 本框架的 openid 是 32 位 hex，里面那串 5559767753895 有 13 位数字，
  // 一旦被当成群号，两个不相干的会话就被并到一起了
  assert.equal(uinFromKey(OPENID_A), '');
  assert.equal(uinFromKey(OPENID_A.toLowerCase()), '');
  assert.equal(uinFromKey(`group:${OPENID_A}`), '');
  assert.equal(uinFromKey(`c2c:10001:${OPENID_A}`), '');
});

test('uinFromKey：边界不炸', () => {
  assert.equal(uinFromKey(''), '');
  assert.equal(uinFromKey(null), '');
  assert.equal(uinFromKey(undefined), '');
  assert.equal(uinFromKey(12345), '12345');
  assert.equal(uinFromKey('1234'), '', '4 位太短');
  assert.equal(uinFromKey('1234567890123'), '', '13 位太长');
  assert.equal(uinFromKey('x'.repeat(200)), '', '超长直接放弃');
  assert.equal(uinFromKey('  10001  '), '10001', '首尾空白要吃掉');
});

test('isValidUin', () => {
  assert.equal(isValidUin('10001'), true);
  assert.equal(isValidUin('763366431'), true);
  assert.equal(isValidUin(763366431), true);
  assert.equal(isValidUin('1000'), false);
  assert.equal(isValidUin('abcde'), false);
  assert.equal(isValidUin(''), false);
  assert.equal(isValidUin(null), false);
});

/* ============ 基本解析 ============ */

test('绑定后能反查，未绑定返回 null', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();

  assert.equal(s.resolveUser('botA', OPENID_A), null);

  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });

  const hit = s.resolveUser('botA', OPENID_A);
  assert.equal(hit.uin, '10001');
  assert.equal(hit.identityId, 'u:10001');
  assert.equal(hit.record.uin, '10001');

  // 别的机器人拿到同一个 openid 也认不出——openid 是按 AppID 隔离的
  assert.equal(s.resolveUser('botB', OPENID_A), null);
  await s.close();
});

test('同一个号码在两个机器人下各有一个 openid，都能解析回同一个号码', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_B, botId: 'botB' });

  assert.equal(s.resolveUser('botA', OPENID_A).uin, '10001');
  assert.equal(s.resolveUser('botB', OPENID_B).uin, '10001');

  // 不限机器人的反查（面板「这个 openid 是谁」用）
  assert.equal(s.uinOf(OPENID_A), '10001');
  assert.equal(s.uinOf(OPENID_B), '10001');
  assert.equal(s.uinOf('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'), '');

  // 按机器人取回发送用的 openid
  assert.equal(s.openidOf('botA', '10001'), OPENID_A);
  assert.equal(s.openidOf('botB', '10001'), OPENID_B);
  assert.equal(s.openidOf('botC', '10001'), '');
  await s.close();
});

test('人和群分开：群号查不到人的别名，反过来也一样', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.bind({ kind: 'group', uin: '763366431', openid: OPENID_B, botId: 'botA' });

  // 同一条 openid 在两个维度各查各的，不会串
  assert.equal(s.resolveUser('botA', OPENID_B), null);
  assert.equal(s.resolveGroup('botA', OPENID_A), null);
  assert.equal(s.resolveGroup('botA', OPENID_B).uin, '763366431');

  // 别名也不能串——群会话读到私聊记忆是这个设计最容易犯的错
  assert.deepEqual(s.aliasesOf('user', '10001'), ['10001', OPENID_A]);
  assert.deepEqual(s.aliasesOf('group', '763366431'), ['763366431', OPENID_B]);
  await s.close();
});

/* ============ 别名（读旧记忆的备用键） ============ */

test('aliasesOf：号码本身在最前，当前键不重复，解绑的不给', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_B, botId: 'botB' });

  // current 是当前会话已经在读的键，不必重复
  assert.deepEqual(s.aliasesOf('user', '10001', OPENID_A), ['10001', OPENID_B]);
  // 号码本身永远在里面——旧记忆可能直接就是纯号码
  assert.deepEqual(s.aliasesOf('user', '10001'), ['10001', OPENID_A, OPENID_B]);

  // 没绑过的号码：仍然给出号码本身（旧记忆可能就是纯号码键）
  assert.deepEqual(s.aliasesOf('user', '99999'), ['99999']);

  // botA 那条解绑后，别名里不该再出现它
  await s.unbind({ kind: 'user', uin: '10001', botId: 'botA' });
  assert.deepEqual(s.aliasesOf('user', '10001'), ['10001', OPENID_B]);
  await s.close();
});

test('换 AppID 但机器人 id 不变：追加新 openid，旧的不撤销', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  // botId 是配置里人起的名字，换 AppID 时通常不改，所以两条 claim 同 botId
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'main' });
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_B, botId: 'main' });

  const rec = s.resolveUser('main', OPENID_B).record;
  assert.equal(rec.claims.length, 2, '旧的必须留着，它是读旧记忆唯一的线索');
  assert.ok(rec.claims.every((c) => c.state === 'active'));
  // 两个都能解析回同一个号码
  assert.equal(s.resolveUser('main', OPENID_A).uin, '10001');
  // 发消息用最新的那条
  assert.equal(s.openidOf('main', '10001'), OPENID_B);
  await s.close();
});

/* ============ 未绑定 ============ */

test('未绑定：查询类返回空值，不抛', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();

  assert.equal(s.has('user', '10001'), false);
  assert.equal(s.has('group', '763366431'), false);
  assert.equal(s.resolveUser('botA', '10001'), null);
  assert.equal(s.resolveGroup('botA', '763366431'), null);
  assert.equal(s.openidOf('botA', '10001'), '');
  assert.equal(s.groupOpenidOf('botA', '763366431'), '');
  await s.close();
});

test('requireOpenid：绑了给 openid，没绑抛 UNBOUND 且带上下文', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();

  assert.throws(
    () => s.requireOpenid({ kind: 'user', uin: '10001', botId: 'botA' }),
    (e) => {
      assert.equal(e.code, UNBOUND);
      assert.equal(e.uin, '10001');
      assert.equal(e.botId, 'botA');
      assert.equal(e.kind, 'user');
      assert.match(e.message, /10001/);
      assert.match(e.message, /没绑定|还没绑定/);
      return true;
    }
  );

  assert.throws(
    () => s.requireOpenid({ kind: 'group', uin: '763366431' }),
    (e) => e.code === UNBOUND && e.kind === 'group'
  );

  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  assert.equal(s.requireOpenid({ kind: 'user', uin: '10001', botId: 'botA' }), OPENID_A);
  // 换了机器人还是没绑
  assert.throws(() => s.requireOpenid({ kind: 'user', uin: '10001', botId: 'botB' }), (e) => e.code === UNBOUND);

  const err = unboundError({ kind: 'group', uin: '763366431', botId: 'botA' });
  assert.equal(err.code, UNBOUND);
  await s.close();
});

/* ============ 冲突与改绑 ============ */

test('同一个 openid 绑到两个号码：不 force 就抛冲突', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });

  await assert.rejects(
    () => s.bind({ kind: 'user', uin: '20002', openid: OPENID_A, botId: 'botA' }),
    (e) => {
      assert.equal(e.code, CONFLICT);
      assert.equal(e.owner, '10001');
      return true;
    }
  );
  // 原绑定没被破坏
  assert.equal(s.resolveUser('botA', OPENID_A).uin, '10001');
  await s.close();
});

test('force 改绑：旧记录那条 claim 标 revoked，留痕不删', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.bind({ kind: 'user', uin: '20002', openid: OPENID_A, botId: 'botA', force: true });

  assert.equal(s.resolveUser('botA', OPENID_A).uin, '20002');
  // 旧记录还在，claim 也在，只是 revoked——面板要能看到「曾经绑过谁」
  const old = (await s.list('user')).find((r) => r.uin === '10001');
  assert.ok(old, '旧记录不能被删');
  assert.equal(old.claims.length, 1);
  assert.equal(old.claims[0].state, 'revoked');
  // 撤销的 claim 不能再当别名用
  assert.deepEqual(s.aliasesOf('user', '10001'), ['10001']);
  await s.close();
});

test('非法输入直接拒', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await assert.rejects(() => s.bind({ kind: 'user', uin: 'abc', openid: OPENID_A }), (e) => e.code === INVALID);
  await assert.rejects(() => s.bind({ kind: 'user', uin: '10001', openid: '' }), (e) => e.code === INVALID);
  await assert.rejects(() => s.bind({ kind: 'user', uin: '10001', openid: 'has space' }), (e) => e.code === INVALID);
  await assert.rejects(() => s.bind({ kind: 'user', uin: '10001', openid: 'x'.repeat(65) }), (e) => e.code === INVALID);
  await s.close();
});

/* ============ 停用 / 解绑 / 触达 ============ */

test('停用整条记录后查不到，启用后恢复', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });

  await s.setStatus({ kind: 'user', uin: '10001', status: 'disabled' });
  assert.equal(s.resolveUser('botA', OPENID_A), null);
  assert.equal(s.has('user', '10001'), false);
  assert.equal(s.openidOf('botA', '10001'), '');
  // 记录本身还在
  assert.equal((await s.list('user')).length, 1);

  await s.setStatus({ kind: 'user', uin: '10001', status: 'active' });
  assert.equal(s.resolveUser('botA', OPENID_A).uin, '10001');
  await s.close();
});

test('解绑只影响指定机器人', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_B, botId: 'botB' });

  const r = await s.unbind({ kind: 'user', uin: '10001', botId: 'botA' });
  assert.equal(r.revoked, 1);
  assert.equal(s.resolveUser('botA', OPENID_A), null);
  assert.equal(s.resolveUser('botB', OPENID_B).uin, '10001');

  // 解绑不存在的号码不炸
  assert.equal(await s.unbind({ kind: 'user', uin: '99999' }), null);
  await s.close();
});

test('setNote 与 touch', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.setNote({ kind: 'user', uin: '10001', name: '小明', note: '群主' });

  const rec = s.resolveUser('botA', OPENID_A).record;
  assert.equal(rec.name, '小明');
  assert.equal(rec.note, '群主');

  // 刚绑完 lastSeenAt 就是「现在」，所以第一次 touch 落在节流窗口内：
  // 只补记 scope，不算一次新的「见过」
  const claim = rec.claims[0];
  s.touch({ kind: 'user', uin: '10001', botId: 'botA', scope: 'group:763366431' });
  assert.deepEqual(claim.scopes, ['group:763366431']);
  assert.equal(claim.seenCount, 0, '节流窗口内不重复计数');

  // 同一个 scope 再来一次：什么都不该变
  const before = claim.lastSeenAt;
  s.touch({ kind: 'user', uin: '10001', botId: 'botA', scope: 'group:763366431' });
  assert.equal(claim.lastSeenAt, before);

  // 把时间往回拨 2 分钟，模拟「上一次说话是两分钟前」
  claim.lastSeenAt = Date.now() - 120_000;
  s.touch({ kind: 'user', uin: '10001', botId: 'botA', scope: 'c2c:10001' });
  assert.equal(claim.seenCount, 1, '超出节流窗口才计数');
  assert.ok(claim.lastSeenAt > Date.now() - 5_000);
  assert.deepEqual(claim.scopes, ['group:763366431', 'c2c:10001'], '新 scope 要记下来');

  // touch 一个没绑过的号码不能炸
  s.touch({ kind: 'user', uin: '99999', botId: 'botA' });
  await s.close();
});

test('boundOpenids：按机器人给出已绑集合', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.bind({ kind: 'group', uin: '763366431', openid: OPENID_B, botId: 'botA' });
  await s.bind({ kind: 'user', uin: '20002', openid: OPENID_A, botId: 'botB' });

  const a = await s.boundOpenids('botA');
  assert.ok(a.users.has(OPENID_A));
  assert.ok(a.groups.has(OPENID_B));
  assert.equal(a.users.size, 1);

  const c = await s.boundOpenids('botC');
  assert.equal(c.users.size, 0);
  await s.close();
});

/* ============ 落盘与并发 ============ */

test('落盘后新实例读得到', async () => {
  const file = tmpFile();
  const s1 = new IdentityStore(file);
  await s1.load();
  await s1.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s1.close();

  const s2 = new IdentityStore(file);
  await s2.load();
  assert.equal(s2.resolveUser('botA', OPENID_A).uin, '10001');
  await s2.close();
});

test('两个进程交替写：谁都不丢 claim', async () => {
  const file = tmpFile();
  // 两个实例都在对方写盘之前载入，模拟两只鸟同时启动
  const a = new IdentityStore(file);
  const b = new IdentityStore(file);
  await a.load();
  await b.load();

  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();
  // b 内存里完全没有 10001，落盘时必须先重读再合并
  await b.bind({ kind: 'user', uin: '20002', openid: OPENID_B, botId: 'botB' });
  await b.flush();

  const check = new IdentityStore(file);
  await check.load();
  const users = await check.list('user');
  assert.deepEqual(users.map((r) => r.uin).sort(), ['10001', '20002'], 'a 写的不能被 b 覆盖掉');
  await a.close();
  await b.close();
});

test('解绑不会被旧进程的落盘复活', async () => {
  const file = tmpFile();
  const a = new IdentityStore(file);
  const b = new IdentityStore(file);
  await a.load();
  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();

  await b.load(); // b 看到的是「已绑定」
  await a.unbind({ kind: 'user', uin: '10001', botId: 'botA' });
  await a.flush();

  // b 内存里还是 active，随便写点别的触发落盘
  await b.bind({ kind: 'user', uin: '20002', openid: OPENID_B, botId: 'botB' });
  await b.flush();

  const check = new IdentityStore(file);
  await check.load();
  assert.equal(check.resolveUser('botA', OPENID_A), null, '解绑被旧进程覆盖回去了');
  await a.close();
  await b.close();
});

test('同进程并发 bind 不互相覆盖', async () => {
  const file = tmpFile();
  const s = new IdentityStore(file);
  await s.load();
  await Promise.all([
    s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' }),
    s.bind({ kind: 'user', uin: '20002', openid: OPENID_B, botId: 'botA' }),
    s.bind({ kind: 'group', uin: '763366431', openid: 'C'.repeat(32), botId: 'botA' }),
  ]);
  await s.close();

  const check = new IdentityStore(file);
  await check.load();
  assert.equal((await check.list('user')).length, 2);
  assert.equal((await check.list('group')).length, 1);
  await check.close();
});

test('并发 load 只跑一次，不把对方的 data 覆盖掉', async () => {
  const file = tmpFile();
  const s = new IdentityStore(file);
  await Promise.all([s.load(), s.load(), s.load()]);
  assert.equal(s.loaded, true);
  await s.close();
});

/* ============ 脏数据 ============ */

test('坏文件：留档后当空表，不炸', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  const s = new IdentityStore(file);
  await s.load();
  assert.deepEqual(await s.list(), []);
  const baks = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.corrupt-'));
  assert.equal(baks.length, 1, '坏文件要留一份，不能静默覆盖');
  await s.close();
});

test('脏字段：非法号码 / 非法 openid / 缺字段都被过滤掉', async () => {
  const file = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 99,
      users: {
        '10001': {
          uin: '10001',
          claims: [
            { botId: 'botA', openid: OPENID_A, state: 'active' },
            { botId: 'botA', openid: '', state: 'active' }, // 空 openid
            { botId: 'botA', openid: 'has space', state: 'active' }, // 含空白
            null,
            { botId: 'botA', openid: OPENID_B, state: 'weird' }, // 未知 state → active
          ],
        },
        'abc': { uin: 'abc', claims: [] }, // 号码不合法，整条丢
        '20002': null, // 整个记录是 null
      },
      groups: { '763366431': { claims: [{ botId: 'botA', openid: OPENID_A, state: 'active' }] } },
    }),
    'utf8'
  );

  const s = new IdentityStore(file);
  await s.load();
  const users = await s.list('user');
  assert.deepEqual(users.map((r) => r.uin), ['10001', '20002']);
  assert.equal(users[0].claims.length, 2, '只留两条合法 claim');
  assert.equal(users[0].claims[1].state, 'active', '未知 state 按 active 处理');
  // 记录缺的字段要补齐，别让后面 slice/filter 崩
  assert.equal(users[1].status, 'active');
  assert.deepEqual(users[1].claims, []);
  assert.equal(typeof users[1].createdAt, 'number');

  // version 99 的文件按当前版本读，不拒绝
  assert.equal(s.data.version, 1);
  await s.close();
});

test('空文件路径 / 目录不存在也能落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-id-'));
  const file = path.join(dir, 'nested', 'deep', 'identity.json');
  const s = new IdentityStore(file);
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await s.close();
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.users['10001'].claims.length, 1);
});

test('snapshot 观测字段', async () => {
  const s = new IdentityStore(tmpFile());
  assert.equal(s.snapshot().loaded, false);
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  const snap = s.snapshot();
  assert.equal(snap.loaded, true);
  assert.equal(snap.users, 1);
  assert.equal(snap.index, 1);
  await s.close();
});

/* ---------------- 撤销是单调的（P1 回归） ---------------- */

test('解绑不会被「旧进程给同一个号码追加」复活', async () => {
  /**
   * 这是换机器人时最常见的操作序列，也是最容易丢掉撤销的场景：
   *
   *   A 绑好 10001→openidA
   *   B 载入（看到 active）
   *   A 解绑并落盘
   *   B 给**同一个号码**追加一条新 openid（换 AppID 后的标准动作）
   *
   * 以前合并是「整条记录按 updatedAt 取新的」：B 追加之后 updatedAt 变新，
   * 整条按 B 的版本走，B 内存里那条还没收到解绑通知的 active 就把撤销盖回去。
   * 表现是「解绑成功了，重启又活了」。
   *
   * 现在按 claim 自己的 updatedAt 比，撤销不会被更旧的副本覆盖。
   */
  const file = tmpFile();
  const a = new IdentityStore(file);
  const b = new IdentityStore(file);
  await a.load();
  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();

  await b.load(); // b 看到 active
  await a.unbind({ kind: 'user', uin: '10001', botId: 'botA' });
  await a.flush();

  // b 给同一个号码追加一条新的（内存里那条 OPENID_A 还是 active）
  await b.bind({ kind: 'user', uin: '10001', openid: OPENID_B, botId: 'botB' });
  await b.flush();

  const check = new IdentityStore(file);
  await check.load();
  assert.equal(check.resolveUser('botA', OPENID_A), null, '撤销被旧进程复活了');
  assert.equal(check.resolveUser('botB', OPENID_B)?.uin, '10001', '新追加的那条必须在');
  const rec = (await check.list('user')).find((r) => r.uin === '10001');
  assert.equal(rec.claims.find((c) => c.openid === OPENID_A).state, 'revoked');
  assert.equal(rec.claims.find((c) => c.openid === OPENID_B).state, 'active');
  await a.close();
  await b.close();
});

test('平局时撤销优先：同毫秒的两份副本，revoked 赢', async () => {
  /**
   * 撤销是删除类动作。宁可多撤销一条（用户再绑一次就好），
   * 也不能让一个已经删掉的绑定自己复活。
   */
  const file = tmpFile();
  const a = new IdentityStore(file);
  const b = new IdentityStore(file);
  await a.load();
  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();
  await b.load();
  await a.unbind({ kind: 'user', uin: '10001', botId: 'botA' });
  await a.flush();
  // b 什么都不改，只是落一次盘（此时两边 updatedAt 可能撞在同一毫秒）
  await b.flush();

  const check = new IdentityStore(file);
  await check.load();
  assert.equal(check.resolveUser('botA', OPENID_A), null, '平局时应该保持撤销');
  await a.close();
  await b.close();
});

test('已载入的实例能看到别的进程写进来的绑定（跨进程读）', async () => {
  /**
   * `load()` 以前只载一次、永不刷新，于是「文档说多进程共享一个文件」
   * 只对写成立：一只鸟的面板绑完，另一只鸟永远看不到。
   * 现在按 mtime 节流重载。
   */
  const file = tmpFile();
  const a = new IdentityStore(file);
  const b = new IdentityStore(file);
  await a.load();
  await b.load();
  assert.equal(b.resolveUser('botA', OPENID_A), null, '一开始都没绑');

  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();

  // 节流窗口内可能还没检查；把时间往前拨，模拟「过了一会儿再来一次请求」
  b.checkedAt = 0;
  await b.load();
  assert.equal(b.resolveUser('botA', OPENID_A)?.uin, '10001', 'b 应该看到 a 刚绑的');
  await a.close();
  await b.close();
});

test('aliasesOf：停用的记录一条别名都不给', async () => {
  const s = new IdentityStore(tmpFile());
  await s.load();
  await s.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  assert.deepEqual(s.aliasesOf('user', '10001'), ['10001', OPENID_A]);

  await s.setStatus({ kind: 'user', uin: '10001', status: 'disabled' });
  /**
   * 停用之后 `resolveUser` 返回 null。`aliasesOf` 还返回旧 openid 的话，
   * 就会出现「面板查不到这个号码，AI 却照样读得到它的记忆」——
   * 两处说法不一致，排查时根本想不到是这里。
   */
  assert.equal(s.resolveUser('botA', OPENID_A), null);
  assert.deepEqual(s.aliasesOf('user', '10001'), [], '停用后不该再给别名');
  await s.close();
});

test('uinFromKey：首位不能是 0（否则建出一条查不到的死绑定）', () => {
  /**
   * QQ号 / 群号都不以 0 开头，而多打一个 0 是很常见的粘贴错误。
   * 放过去的话会以 `'012345'` 存，而 `openidOf('12345')` 永远找不到——
   * 面板上显示「已绑定」，用起来就是「没绑」。
   */
  assert.equal(uinFromKey('012345'), '');
  assert.equal(isValidUin('012345'), false);
  assert.equal(isValidUin('000000'), false);
  // 正常号码不受影响
  assert.equal(uinFromKey('10001'), '10001');
  assert.equal(isValidUin('123456789012'), true, '12 位仍然合法');
  assert.equal(isValidUin('1234567890123'), false, '13 位太长');
});

test('claim 的 updatedAt 必须活过「落盘 → 重新载入」', async () => {
  /**
   * 第一版修法只在内存里生效：`normalizeRecord` 重建 claim 时把
   * `updatedAt` 丢了，于是重启之后合并又退回记录级时间，
   * 撤销照样会被复活——而且丢得毫无声息，内存里看着还是对的。
   */
  const file = tmpFile();
  const a = new IdentityStore(file);
  await a.load();
  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();
  await a.close();

  const b = new IdentityStore(file);
  await b.load();
  const rec = (await b.list('user')).find((r) => r.uin === '10001');
  assert.ok(Number(rec.claims[0].updatedAt) > 0, '载入后 claim.updatedAt 不能丢');
  await b.close();
});

test('旧进程只是改备注，也不能把解绑覆盖回去', async () => {
  /**
   * 这是第一版修法漏掉的场景：A 解绑，B（内存里还是 active）
   * 只是 `setNote` 改了个备注就落盘。
   * 记录级 `updatedAt` 被这次无关操作顶新，claim 级时间又没落盘，
   * 于是 B 那份 active 赢了——「解绑成功了，重启又活了」。
   */
  const file = tmpFile();
  const a = new IdentityStore(file);
  const b = new IdentityStore(file);
  await a.load();
  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();

  await b.load(); // b 看到 active
  await a.unbind({ kind: 'user', uin: '10001', botId: 'botA' });
  await a.flush();

  // b 做的事和绑定完全无关：只改了个备注
  await b.setNote({ kind: 'user', uin: '10001', note: '这人挺熟' });
  await b.flush();

  const check = new IdentityStore(file);
  await check.load();
  assert.equal(check.resolveUser('botA', OPENID_A), null, '改备注不该让解绑复活');
  await a.close();
  await b.close();
});

test('旧进程改备注，也不能把「停用」翻回「启用」', async () => {
  /**
   * 停用是为了让这个号码的记忆读不到。翻回 active 等于白停，
   * 而且 `aliasesOf` 会重新给出别名，旧记忆又能读了。
   */
  const file = tmpFile();
  const a = new IdentityStore(file);
  const b = new IdentityStore(file);
  await a.load();
  await a.bind({ kind: 'user', uin: '10001', openid: OPENID_A, botId: 'botA' });
  await a.flush();

  await b.load();
  await a.setStatus({ kind: 'user', uin: '10001', status: 'disabled' });
  await a.flush();

  await b.setNote({ kind: 'user', uin: '10001', note: '随手写点什么' });
  await b.flush();

  const check = new IdentityStore(file);
  await check.load();
  assert.equal(check.resolveUser('botA', OPENID_A), null, '停用被翻回启用了');
  assert.deepEqual(check.aliasesOf('user', '10001'), [], '停用后不该再给别名');
  await a.close();
  await b.close();
});

test('合并之后 statusUpdatedAt 不能往回退（否则停用会被逆序复活）', async () => {
  /**
   * `first` 是按**记录级** `updatedAt` 选的，而那个值会被 `setNote` 顶新。
   * 如果 `statusUpdatedAt` 跟着 `first` 走，就会把停用时间往回写，
   * 之后任何一个「状态时间落在中间」的陈旧进程一落盘就能把停用翻回 active。
   * 时间只进不退，才谈得上单调。
   */
  const file = tmpFile();
  const OLD_STATUS = 2000;

  // 磁盘初始状态：启用，状态时间是 2000
  const writeRaw = (status, statusUpdatedAt, updatedAt) =>
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        updatedAt,
        users: {
          10001: {
            uin: '10001',
            status,
            statusUpdatedAt,
            updatedAt,
            createdAt: 1000,
            claims: [{ botId: 'botA', openid: OPENID_A, state: 'active', updatedAt: 1000, firstSeenAt: 1000, lastSeenAt: 1000 }],
          },
        },
        groups: {},
      }),
      'utf8',
    );
  writeRaw('active', OLD_STATUS, OLD_STATUS);

  // B 载入（看到 active@2000），之后一直没刷新
  const b = new IdentityStore(file);
  await b.load();

  // A 把它停用并落盘（状态时间 = 现在，远大于 2000）
  const a = new IdentityStore(file);
  await a.load();
  await a.setStatus({ kind: 'user', uin: '10001', status: 'disabled' });
  await a.flush();

  /**
   * 把刷新节流占住：`setNote` 内部会 `load()`，而 `load()` 发现磁盘变了
   * 会先重载——那就绕过合并了，测不到这条路径。
   * 真实场景里陈旧进程正是**在两秒窗口内**没刷新，所以这里必须模拟它。
   */
  b.checkedAt = Date.now();
  // B 只是改了个备注（记录级 updatedAt 被顶新，状态时间还是 2000），然后落盘
  await b.setNote({ kind: 'user', uin: '10001', note: '顺手写一句' });
  await b.flush();

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rec = raw.users['10001'];
  assert.equal(rec.status, 'disabled', '停用被翻回启用了');
  assert.ok(
    Number(rec.statusUpdatedAt) > OLD_STATUS,
    `statusUpdatedAt 往回退了：${rec.statusUpdatedAt}（停用时间应该 > ${OLD_STATUS}）`,
  );

  const check = new IdentityStore(file);
  await check.load();
  assert.equal(check.resolveUser('botA', OPENID_A), null, '停用之后不该还能解析出这个人');
  await a.close();
  await b.close();
  await check.close();
});

test('老 claim 没有 updatedAt 时，一条普通消息（touch）不能把解绑复活', async () => {
  /**
   * `lastSeenAt` 是心跳：`touch()` 收到一条消息就写它，不写 `updatedAt`。
   * 合并时如果拿它当回退时间，一个陈旧进程只要**收到这个人一条消息**，
   * 就能把 active 顶到解绑之后——表现是「解绑了，那人一说话又绑回来了」。
   */
  const file = tmpFile();
  // 旧格式：claim 上没有 updatedAt，lastSeenAt 是很久以前
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      updatedAt: 1000,
      users: {
        10001: {
          uin: '10001',
          status: 'active',
          updatedAt: 1000,
          createdAt: 1000,
          claims: [{ botId: 'botA', openid: OPENID_A, state: 'active', firstSeenAt: 1000, lastSeenAt: 1000 }],
        },
      },
      groups: {},
    }),
    'utf8',
  );

  const b = new IdentityStore(file);
  await b.load(); // b 看到 active

  const a = new IdentityStore(file);
  await a.load();
  await a.unbind({ kind: 'user', uin: '10001', botId: 'botA' });
  await a.flush();

  // b 收到这个人一条消息 → 心跳更新 → 落盘
  b.touch({ kind: 'user', uin: '10001', botId: 'botA' });
  await b.flush();

  const check = new IdentityStore(file);
  await check.load();
  assert.equal(check.resolveUser('botA', OPENID_A), null, '解绑被 touch 复活了');
  await a.close();
  await b.close();
  await check.close();
});
