/**
 * 邮件能力测试：全部走本地假 SMTP 服务器，不连任何真邮箱、不发任何外部请求。
 *
 * 覆盖：
 *   - 加密方式自动判定（含 BetterGI 的网易 587 特例）
 *   - 明文 / 隐式 TLS / STARTTLS 三种建连
 *   - AUTH PLAIN / LOGIN / 无认证 / 认证失败 / 收件人拒绝 / EHLO→HELO 降级
 *   - MIME（中文主题、发件人姓名、base64 正文、头部注入）
 *   - 验证码发放/核对/过期/限频/openid 隔离
 *   - 自助绑定命令的成功、冲突直接拒绝、发信失败撤销
 *   - MailService 脱敏、收件白名单、限频、测试发送
 *
 * 运行：node --test test/mail.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  sendSmtpMail, resolveSecurity, buildMimeMessage, parseRecipients,
  extractAddress, formatSmtpError,
} from '../src/mail/smtp.js';
import { MailService, createMailApi, setSharedMail, sharedMail } from '../src/mail/service.js';
import { VerifyStore, VERIFY_TTL_MS } from '../src/mail/verify.js';
import { parseUinArg, parseCodeArg, runBindQq, runVerifyQq } from '../src/mail/bind-commands.js';
import { capabilityPayload } from '../src/web/qq-call.js';

/* ------------------------------------------------------------------ */
/* 自签证书（只落在系统临时目录，不入库、不写死 PEM）                    */
/* ------------------------------------------------------------------ */

let tmpDir = '';
let tlsCtx = null;
let tlsKey = null;
let tlsCert = null;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-mail-'));
  const key = path.join(tmpDir, 'key.pem');
  const cert = path.join(tmpDir, 'cert.pem');
  const r = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  if (r.status === 0 && fs.existsSync(key) && fs.existsSync(cert)) {
    tlsKey = fs.readFileSync(key);
    tlsCert = fs.readFileSync(cert);
    tlsCtx = tls.createSecureContext({ key: tlsKey, cert: tlsCert });
  }
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 假 SMTP 服务器                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   mode: plain | tls | starttls
 *   caps: EHLO 宣告的能力行；authCode / rcptCode / ehloCode 可注入错误
 */
function startFake(o = {}) {
  const {
    mode = 'plain',
    caps = ['AUTH PLAIN LOGIN'],
    user = 'bot@example.com',
    pass = 'secret',
    authCode = 235,
    rcptCode = 250,
    ehloCode = 250,
  } = o;
  const state = { data: '', commands: [], envelope: [] };
  const sockets = new Set();

  const handler = (sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
    let io = sock;
    let buf = '';
    let inData = false;
    let loginStage = 0;

    const write = (s) => { try { io.write(s); } catch { /* 客户端已断开 */ } };

    const upgrade = () => {
      sock.removeListener('data', onData);
      const secure = new tls.TLSSocket(sock, { isServer: true, secureContext: tlsCtx });
      secure.on('error', () => {});
      io = secure;
      buf = '';
      secure.on('data', onData);
    };

    function handle(line) {
      if (inData) {
        if (line === '.') {
          inData = false;
          write('250 OK queued\r\n');
        } else {
          state.data += `${line}\r\n`;
        }
        return;
      }
      state.commands.push(line);

      if (/^EHLO\s/i.test(line)) {
        if (ehloCode !== 250) return write(`${ehloCode} Command unrecognized\r\n`);
        const lines = [...caps, ...(mode === 'starttls' ? ['STARTTLS'] : [])];
        write(`250-fake ESMTP\r\n${lines.map((c) => `250-${c}\r\n`).join('')}250 OK\r\n`);
        return;
      }
      if (/^HELO\s/i.test(line)) return write('250 fake ESMTP\r\n');
      if (line.toUpperCase() === 'STARTTLS') {
        write('220 Ready to start TLS\r\n');
        upgrade();
        return;
      }
      if (/^AUTH PLAIN\s/i.test(line)) {
        const raw = Buffer.from(line.split(/\s+/)[2] || '', 'base64').toString('utf8');
        const parts = raw.split('\0');
        const ok = parts[1] === user && parts[2] === pass;
        return write(`${authCode === 235 && ok ? 235 : 535} ${ok ? 'OK' : 'Auth failed'}\r\n`);
      }
      if (line.toUpperCase() === 'AUTH LOGIN') {
        loginStage = 1;
        return write('334 VXNlcm5hbWU6\r\n');
      }
      if (loginStage === 1) {
        loginStage = 2;
        return write('334 UGFzc3dvcmQ6\r\n');
      }
      if (loginStage === 2) {
        loginStage = 0;
        const got = Buffer.from(line, 'base64').toString('utf8');
        return write(`${authCode === 235 && got === pass ? 235 : 535} ${got === pass ? 'OK' : 'Auth failed'}\r\n`);
      }
      if (/^MAIL FROM/i.test(line)) { state.envelope.push(line); return write('250 OK\r\n'); }
      if (/^RCPT TO/i.test(line)) { state.envelope.push(line); return write(`${rcptCode} ${rcptCode === 250 ? 'OK' : 'No such user'}\r\n`); }
      if (line.toUpperCase() === 'DATA') { inData = true; return write('354 End with <CRLF>.<CRLF>\r\n'); }
      if (line.toUpperCase() === 'QUIT') { write('221 Bye\r\n'); io.end(); return; }
      write('250 OK\r\n');
    }

    function onData(chunk) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        handle(line);
      }
    }

    // tls.createServer 给进来的已经是 TLSSocket，write 会缓冲到握手完成后发出
    write('220 fake ESMTP ready\r\n');
    sock.on('data', onData);
  };

  const server = mode === 'tls'
    ? tls.createServer({ key: tlsKey, cert: tlsCert }, handler)
    : net.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state,
        async close() {
          for (const s of sockets) s.destroy();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

async function withFake(opts, fn) {
  const s = await startFake(opts);
  try { return await fn(s); } finally { await s.close(); }
}

const baseMail = (port, extra = {}) => ({
  host: '127.0.0.1', port, security: 'none',
  user: 'bot@example.com', pass: 'secret',
  from: 'bot@example.com', fromName: '栖',
  to: '123456@qq.com', subject: '测试主题', text: '你好，世界',
  ...extra,
});

/* ------------------------------------------------------------------ */
/* 1. 加密方式自动判定（BetterGI 规则）                                 */
/* ------------------------------------------------------------------ */

test('加密方式：端口映射 + 网易 587 特例 + 显式覆盖', () => {
  assert.equal(resolveSecurity('smtp.qq.com', 465), 'tls');
  assert.equal(resolveSecurity('smtp.qq.com', 587), 'starttls');
  assert.equal(resolveSecurity('mail.example.com', 25), 'none');
  assert.equal(resolveSecurity('mail.example.com', 2525), 'auto');
  // BetterGI IsKnownServerWithSpecialRequirements：网易系 587 其实是隐式 TLS
  assert.equal(resolveSecurity('smtp.163.com', 587), 'tls');
  assert.equal(resolveSecurity('smtp.126.com', 587), 'tls');
  assert.equal(resolveSecurity('smtp.yeah.net', 587), 'tls');
  // 网易的 465 本来就是 tls，QQ 的 587 不能误判
  assert.equal(resolveSecurity('smtp.163.com', 465), 'tls');
  assert.equal(resolveSecurity('smtp.qq.com', 587), 'starttls');
  // 显式配置优先
  assert.equal(resolveSecurity('smtp.qq.com', 587, 'tls'), 'tls');
  assert.equal(resolveSecurity('smtp.qq.com', 465, 'none'), 'none');
  assert.equal(resolveSecurity('x', 2525, 'ssl'), 'tls');
});

/* ------------------------------------------------------------------ */
/* 2. 地址与 MIME                                                      */
/* ------------------------------------------------------------------ */

test('地址解析：宽松支持内网地址、去重、剥显示名', () => {
  assert.equal(extractAddress('栖 <Bot@Example.com>'), 'Bot@Example.com');
  assert.equal(extractAddress('user@localhost'), 'user@localhost');
  assert.equal(extractAddress('不是邮箱'), null);
  assert.deepEqual(parseRecipients('a@qq.com, b@qq.com; a@qq.com\n<User@Host>'),
    ['a@qq.com', 'b@qq.com', 'User@Host']);
});

test('MIME：中文主题编码、发件人姓名、base64 正文、头部注入防护', () => {
  const mime = buildMimeMessage({
    from: 'bot@example.com', fromName: '栖 Roost',
    to: ['123456@qq.com'], subject: '绑定验证码\r\nBcc: evil@x.com',
    text: '验证码：123456',
  }, new Date('2026-01-01T00:00:00Z'));
  assert.match(mime, /^From: =\?UTF-8\?B\?/m);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/m);
  assert.ok(!mime.includes('Bcc: evil@x.com')); // 换行被清掉，注入失效
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  assert.ok(mime.includes(Buffer.from('验证码：123456', 'utf8').toString('base64')));
  assert.match(mime, /Message-ID: <[^>]+@example\.com>/);
});

test('错误分类：认证 / 连接 / 收件人 / 证书', () => {
  assert.equal(formatSmtpError({ responseCode: 535 }, 'h', 465).code, 'EAUTH');
  assert.equal(formatSmtpError({ cause: { code: 'ECONNREFUSED' } }, 'h', 587).code, 'ECONNREFUSED');
  assert.equal(formatSmtpError({ responseCode: 550, stage: 'RCPT' }, 'h', 25).code, 'ERCPT');
  assert.equal(formatSmtpError({ message: 'self-signed certificate' }).code, 'ECERT');
});

/* ------------------------------------------------------------------ */
/* 3. 协议实跑                                                         */
/* ------------------------------------------------------------------ */

test('明文 + AUTH PLAIN 全链路', async () => {
  await withFake({}, async (s) => {
    const out = await sendSmtpMail(baseMail(s.port));
    assert.equal(out.ok, true);
    assert.equal(out.auth, 'PLAIN');
    assert.equal(out.security, 'none');
    assert.equal(out.accepted, 1);
    assert.match(s.state.data, /To: <123456@qq\.com>/);
    assert.ok(s.state.commands.some((c) => /^AUTH PLAIN /.test(c)));
    assert.ok(s.state.commands.includes('DATA'));
  });
});

test('只宣告 LOGIN 时走 AUTH LOGIN', async () => {
  await withFake({ caps: ['AUTH LOGIN'] }, async (s) => {
    const out = await sendSmtpMail(baseMail(s.port));
    assert.equal(out.auth, 'LOGIN');
    assert.ok(s.state.commands.includes('AUTH LOGIN'));
  });
});

test('用户名为空 = 不认证（内网中继）', async () => {
  await withFake({ caps: [] }, async (s) => {
    const out = await sendSmtpMail(baseMail(s.port, { user: '', pass: '' }));
    assert.equal(out.auth, 'none');
    assert.ok(!s.state.commands.some((c) => /^AUTH /.test(c)));
  });
});

test('EHLO 被拒时能降级 HELO', async () => {
  await withFake({ ehloCode: 500 }, async (s) => {
    const out = await sendSmtpMail(baseMail(s.port));
    assert.equal(out.ok, true);
    assert.ok(s.state.commands.some((c) => /^HELO /.test(c)));
  });
});

test('EHLO 宣告 SIZE 超限时拒绝发送', async () => {
  await withFake({ caps: ['SIZE 10'] }, async (s) => {
    await assert.rejects(() => sendSmtpMail(baseMail(s.port)), /SIZE 限制/);
    assert.ok(!s.state.commands.some((c) => c === 'DATA'));
  });
});

test('认证失败给 EAUTH，不重试、不发 DATA', async () => {
  await withFake({ authCode: 535 }, async (s) => {
    await assert.rejects(
      () => sendSmtpMail(baseMail(s.port)),
      (e) => e.code === 'EREPLY' && e.responseCode === 535,
    );
    assert.equal(formatSmtpError({ responseCode: 535 }).code, 'EAUTH');
    assert.ok(!s.state.commands.includes('DATA'));
  });
});

test('收件人被拒给 ERCPT', async () => {
  await withFake({ rcptCode: 550 }, async (s) => {
    await assert.rejects(() => sendSmtpMail(baseMail(s.port)), (e) => e.stage === 'RCPT');
    assert.ok(!s.state.commands.includes('DATA'));
  });
});

test('隐式 TLS（465 风格）', async (t) => {
  if (!tlsCtx) return t.skip('openssl 不可用，跳过 TLS 实握手');
  await withFake({ mode: 'tls' }, async (s) => {
    const out = await sendSmtpMail(baseMail(s.port, {
      security: 'tls', rejectUnauthorized: false,
    }));
    assert.equal(out.security, 'tls');
    assert.equal(out.ok, true);
    assert.match(s.state.data, /Subject: =\?UTF-8\?B\?/);
  });
});

test('STARTTLS 能力协商升级', async (t) => {
  if (!tlsCtx) return t.skip('openssl 不可用，跳过 TLS 实握手');
  await withFake({ mode: 'starttls' }, async (s) => {
    const out = await sendSmtpMail(baseMail(s.port, {
      security: 'starttls', rejectUnauthorized: false,
    }));
    assert.equal(out.security, 'starttls');
    assert.ok(s.state.commands.includes('STARTTLS'));
    // 升级后要重新 EHLO，认证必须在加密通道里做
    assert.equal(s.state.commands.filter((c) => /^EHLO /.test(c)).length, 2);
  });
});

test('security=none 即使服务器宣告 STARTTLS 也不升级', async () => {
  await withFake({ mode: 'starttls' }, async (s) => {
    const out = await sendSmtpMail(baseMail(s.port, { security: 'none' }));
    assert.equal(out.security, 'none');
    assert.ok(!s.state.commands.includes('STARTTLS'));
  });
});

/* ------------------------------------------------------------------ */
/* 4. 验证码                                                           */
/* ------------------------------------------------------------------ */

test('验证码：发放 → 核对 → 一次性', () => {
  const v = new VerifyStore();
  const a = v.issue({ openid: 'OPENID_A', uin: '123456' });
  assert.match(a.code, /^\d{6}$/);
  assert.equal(a.to, '123456@qq.com');
  const rec = [...v.pending.values()][0];
  assert.ok(rec.hash && rec.hash !== a.code, '验证码只能以哈希形式留在内存');
  assert.ok(!Object.values(rec).includes(a.code), '明文验证码不能留在内存里');

  assert.throws(() => v.consume({ openid: 'OPENID_B', code: a.code }), /没有待验证/);
  assert.throws(() => v.consume({ openid: 'OPENID_A', code: '000000' }), /验证码不对/);
  const r = v.consume({ openid: 'OPENID_A', code: a.code });
  assert.equal(r.uin, '123456');
  assert.throws(() => v.consume({ openid: 'OPENID_A', code: a.code }), /没有待验证/);
});

test('验证码：5 次错误作废、过期、重发冷却、发信失败可撤销', () => {
  const now = { t: 1_000_000 };
  const v = new VerifyStore({ now: () => now.t });
  const a = v.issue({ openid: 'A', uin: '123456' });
  for (let i = 0; i < 4; i += 1) {
    assert.throws(() => v.consume({ openid: 'A', code: '000000' }));
  }
  assert.throws(() => v.consume({ openid: 'A', code: '000000' }), /错太多次/);
  assert.equal(v.has('A'), false);

  // 60 秒冷却（发信失败撤销记录后仍保留冷却，防刷）
  v.cancel('A');
  assert.throws(() => v.issue({ openid: 'A', uin: '123456' }), /发得太勤/);
  now.t += 60_001;
  const b = v.issue({ openid: 'A', uin: '123456' });
  assert.match(b.code, /^\d{6}$/);
  now.t += VERIFY_TTL_MS + 1;
  assert.throws(() => v.consume({ openid: 'A', code: b.code }), /已过期/);
});

test('验证码：同一 QQ 号每天最多 3 次', () => {
  const v = new VerifyStore();
  for (const oid of ['A', 'B', 'C']) v.issue({ openid: oid, uin: '999999' });
  assert.throws(() => v.issue({ openid: 'D', uin: '999999' }), /今天要验证码的次数用完/);
  assert.doesNotThrow(() => v.issue({ openid: 'D', uin: '888888' }));
});

/* ------------------------------------------------------------------ */
/* 5. 自助绑定命令                                                     */
/* ------------------------------------------------------------------ */

function fakeIdentity({ bound = null, holder = '', has = false } = {}) {
  return {
    async load() {},
    resolveUser: () => bound,
    openidOf: () => holder,
    has: () => has,
    bindCalls: [],
    async bind(args) { this.bindCalls.push(args); return {}; },
  };
}

function fakeMail({ fail = false } = {}) {
  return {
    sent: [],
    checkConfig: () => ({ ok: true, missing: [] }),
    async send(m) {
      if (fail) throw new Error('SMTP 连不上');
      this.sent.push(m);
      return { ok: true, to: m.to };
    },
  };
}

test('命令参数：只认 QQ 号 / 6 位验证码', () => {
  assert.equal(parseUinArg(['123456']), '123456');
  assert.equal(parseUinArg(['123456@qq.com']), '123456');
  assert.equal(parseUinArg(['abc']), '');
  assert.equal(parseCodeArg(['123456']), '123456');
  assert.equal(parseCodeArg(['12345', '654321']), '654321');
});

test('自助绑定：发码 → 核对 → 写入 identity（verifiedBy=email）', async () => {
  const verify = new VerifyStore();
  const mail = fakeMail();
  const identity = fakeIdentity();
  const msg = { userId: 'OPENID_ME', args: ['123456'] };
  const a = await runBindQq({ msg, mail, verify, identity, botId: 'main' });
  assert.equal(a.ok, true);
  assert.match(a.text, /123456@qq\.com/);
  assert.equal(mail.sent.length, 1);
  assert.match(mail.sent[0].text, /验证码：\d{6}/);

  const code = /验证码：(\d{6})/.exec(mail.sent[0].text)[1];
  const b = await runVerifyQq({ msg: { userId: 'OPENID_ME', args: [code] }, verify, identity, botId: 'main' });
  assert.equal(b.ok, true);
  assert.equal(identity.bindCalls.length, 1);
  assert.deepEqual(identity.bindCalls[0], {
    kind: 'user', uin: '123456', openid: 'OPENID_ME', botId: 'main', verifiedBy: 'email',
  });
});

test('拿别人邮箱里的验证码绑不上自己', async () => {
  const verify = new VerifyStore();
  const mail = fakeMail();
  const identity = fakeIdentity();
  await runBindQq({ msg: { userId: 'A', args: ['123456'] }, mail, verify, identity, botId: 'main' });
  const code = /验证码：(\d{6})/.exec(mail.sent[0].text)[1];
  const r = await runVerifyQq({ msg: { userId: 'B', args: [code] }, verify, identity, botId: 'main' });
  assert.equal(r.ok, false);
  assert.match(r.text, /没有待验证/);
  assert.equal(identity.bindCalls.length, 0);
});

test('冲突直接拒绝：已绑过 / 号属于别人 / 已有记录，都不发码不写入', async () => {
  for (const id of [
    fakeIdentity({ bound: { uin: '654321' } }),
    fakeIdentity({ holder: 'SOMEONE_ELSE' }),
    fakeIdentity({ has: true }),
  ]) {
    const verify = new VerifyStore();
    const mail = fakeMail();
    const r = await runBindQq({ msg: { userId: 'ME', args: ['123456'] }, mail, verify, identity: id, botId: 'main' });
    assert.equal(r.ok, false);
    assert.equal(mail.sent.length, 0);
    assert.equal(verify.has('ME'), false);
    assert.equal(id.bindCalls.length, 0);
  }
});

test('发信失败撤销验证码记录，不占冷却记录', async () => {
  const verify = new VerifyStore();
  const r = await runBindQq({
    msg: { userId: 'ME', args: ['123456'] },
    mail: fakeMail({ fail: true }), verify, identity: fakeIdentity(), botId: 'main',
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /没发出去/);
  assert.equal(verify.has('ME'), false);
});

test('没配邮箱时给代绑兜底提示，不报错', async () => {
  const r = await runBindQq({
    msg: { userId: 'ME', args: ['123456'] },
    mail: { checkConfig: () => ({ ok: false, missing: ['SMTP 服务器'] }) },
    verify: new VerifyStore(), identity: fakeIdentity(),
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /绑定成员/);
});

/* ------------------------------------------------------------------ */
/* 6. MailService                                                      */
/* ------------------------------------------------------------------ */

const makeService = (s, extra = {}) => new MailService({
  globalCfg: {
    notifications: {
      smtp: {
        enabled: true, host: '127.0.0.1', port: s.port, security: 'none',
        user: 'bot@example.com', pass: 'secret',
        from: 'bot@example.com', fromName: '栖', ownerEmail: 'owner@163.com',
        ...extra,
      },
    },
  },
  identity: { uinOf: () => '123456' },
});

test('MailService：GET 配置脱敏、只回 passSet', async () => {
  await withFake({}, async (s) => {
    const svc = makeService(s);
    const c = svc.publicConfig();
    assert.equal(c.pass, '');
    assert.equal(c.passSet, true);
    assert.equal(c.port, s.port);
    assert.equal(c.resolvedSecurity, 'none');
  });
});

test('MailService：收件人支持 QQ 号简写与任意邮箱', async () => {
  await withFake({}, async (s) => {
    const svc = makeService(s);
    assert.equal(svc.resolveRecipient({ uin: '123456' }), '123456@qq.com');
    assert.equal(svc.resolveRecipient({ target: '123456' }), '123456@qq.com');
    assert.equal(svc.resolveRecipient({ openid: 'OPENID' }), '123456@qq.com');
    assert.equal(svc.resolveRecipient({ to: 'owner@163.com' }), 'owner@163.com');
    assert.equal(svc.resolveRecipient({ to: 'someone@outlook.com' }), 'someone@outlook.com');
    assert.equal(svc.resolveRecipient({ uin: 'team@corp.example' }), 'team@corp.example');
    assert.equal(svc.resolveRecipient({ target: 'user@mail.local' }), 'user@mail.local'); // 内网邮箱
    assert.throws(() => svc.resolveRecipient({ to: '不是邮箱' }), /完整邮箱地址/);
    assert.throws(() => svc.resolveRecipient({ uin: '0123' }), /完整邮箱地址/);
    assert.throws(() => svc.resolveRecipient({}), /收件人不能为空/);
  });
});

test('MailService：非 QQ 邮箱能真正发出（信封收件人就是它）', async () => {
  await withFake({}, async (s) => {
    const svc = makeService(s);
    const out = await svc.sendTo('someone@outlook.com', '外部邮箱测试', '正文');
    assert.equal(out.to, 'someone@outlook.com');
    assert.ok(s.state.envelope.some((l) => /^RCPT TO:<someone@outlook\.com>$/.test(l)),
      '投递信封里必须是这个外部邮箱');
    assert.ok(!s.state.envelope.some((l) => /@qq\.com/.test(l)), '不该被改写成 QQ 邮箱');
  });
});

test('MailService：测试邮件发到主人邮箱，正文不含 SMTP 密码', async () => {
  await withFake({}, async (s) => {
    const svc = makeService(s);
    const out = await svc.test();
    assert.equal(out.to, 'owner@163.com');
    assert.ok(s.state.envelope.some((l) => l.includes('<owner@163.com>')));
    // 真正解码 MIME 正文再断言，别用「base64 里当然搜不到明文」这种恒真检查
    const b64 = s.state.data.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    const body = Buffer.from(b64, 'base64').toString('utf8');
    assert.match(body, /测试邮件/);
    assert.match(body, /smtp\.?/i);
    assert.ok(!body.includes('secret'), 'SMTP 密码不能出现在邮件正文里');
  });
});

test('MailService：每分钟限频生效', async () => {
  await withFake({}, async (s) => {
    const svc = makeService(s, { maxPerMinute: 1, dailyLimit: 50 });
    await svc.sendToUin('123456', '第一封', '正文');
    await assert.rejects(() => svc.sendToUin('123456', '第二封', '正文'), /发信太频繁/);
    assert.equal(s.state.envelope.filter((l) => /^RCPT/.test(l)).length, 1);
  });
});

test('MailService：未配置时明确报缺什么', async () => {
  const svc = new MailService({ globalCfg: {} });
  assert.equal(svc.checkConfig().ok, false);
  assert.match(svc.checkConfig().missing.join('、'), /启用邮箱通知/);
  await assert.rejects(() => svc.sendToUin('123456', 'x', 'y'), /邮箱还没配好/);
});

/* ------------------------------------------------------------------ */
/* 7. API 列表登记                                                     */
/* ------------------------------------------------------------------ */

test('框架接口 ctx.mail：QQ 号与任意邮箱都只传收件人 + 内容', async () => {
  const calls = [];
  const api = createMailApi(() => ({
    checkConfig: () => ({ ok: true, missing: [] }),
    async sendTo(target, subject, text, opts) {
      calls.push({ target, subject, text, opts });
      return {
        ok: true,
        to: String(target).includes('@') ? target : `${target}@qq.com`,
        messageId: '<x@y>',
      };
    },
  }));
  assert.equal(api.configured, true);
  const r = await api.send('123456', '你的任务完成了');
  assert.equal(r.to, '123456@qq.com');
  assert.deepEqual(calls[0], {
    target: '123456', subject: '【栖】消息通知', text: '你的任务完成了', opts: { html: false },
  });
  const r2 = await api.send('someone@163.com', '日报已生成');
  assert.equal(r2.to, 'someone@163.com');
  assert.equal(calls[1].target, 'someone@163.com');
  await api.send(654321, '<b>完成</b>', { subject: '任务提醒', html: true });
  assert.equal(calls[2].target, '654321');
  assert.equal(calls[2].subject, '任务提醒');
  assert.equal(calls[2].opts.html, true);
  await assert.rejects(() => api.send('123456', '   '), /邮件内容不能为空/);
});

test('框架接口 ctx.mail：服务未初始化时明确报错', async () => {
  const api = createMailApi(() => null);
  assert.equal(api.configured, false);
  await assert.rejects(() => api.send('123456', 'x'), /邮件服务还没初始化/);
});

test('进程级单例：setSharedMail / sharedMail / createMailApi 默认取单例', () => {
  const fake = { checkConfig: () => ({ ok: true, missing: [] }) };
  setSharedMail(fake);
  assert.equal(sharedMail(), fake);
  assert.equal(createMailApi().configured, true);
  setSharedMail(null); // 别污染其它用例
});

test('菜单：四条绑定指令单独成「绑定」组，与「管理」同级', () => {
  const src = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const block = /const CORE_SECTION = \{([\s\S]*?)\n  \};/.exec(src)?.[1] ?? '';
  assert.ok(block, '找不到 CORE_SECTION');
  for (const name of ['绑定群号', '绑定成员', '绑定qq', 'qq验证码']) {
    assert.match(block, new RegExp(`${name}: '绑定'`), `${name} 应归到「绑定」组`);
  }
  assert.match(block, /admin: '管理'/);
  assert.ok(!/绑定(群号|成员|qq): '管理'/.test(block), '绑定指令不该还留在「管理」组');
});

test('QQ 官方能力清单不含框架邮件接口', () => {
  const caps = capabilityPayload();
  assert.ok(Array.isArray(caps) && caps.every((c) => c.api && c.risk));
  assert.ok(caps.some((c) => c.api === 'sendGroup'));
  assert.ok(!caps.some((c) => /mail|notify/.test(c.api)), '邮件是框架接口，不该混进 QQ 官方接口清单');
});
