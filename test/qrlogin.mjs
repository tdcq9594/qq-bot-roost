/**
 * 扫码建机器人的离线测试。
 *
 * 只测本地能确定的东西：URL 拼接、AES-256-GCM 解密的格式与容错。
 * **不联网**——q.qq.com 那两个接口只在真机验证，CI 里不能依赖外网。
 */

import assert from 'node:assert';
import { randomBytes, createCipheriv } from 'node:crypto';
import { decryptSecret, connectUrl, BIND_STATUS } from '../src/qq/qrlogin.js';

let pass = 0;
const fails = [];
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fails.push(name);
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

/** 按官方格式造一份密文：base64(nonce12 + ciphertext + tag16) */
function makeEncrypted(plain, key) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64');
}

ok('二维码内容是官方 connect 页 + task_id', () => {
  const u = connectUrl('abc-123');
  assert.equal(u, 'https://q.qq.com/qqbot/openclaw/connect.html?task_id=abc-123&_wv=2');
});

ok('task_id 会被 URL 编码', () => {
  assert.ok(connectUrl('a b&c').includes('task_id=a%20b%26c'));
});

ok('解密往返：拿回原文', () => {
  const key = randomBytes(32);
  const enc = makeEncrypted('my-app-secret', key);
  assert.equal(decryptSecret(enc, key.toString('base64')), 'my-app-secret');
});

ok('篡改密文必须解不开（GCM 认证）', () => {
  const key = randomBytes(32);
  const raw = Buffer.from(makeEncrypted('secret', key), 'base64');
  raw[raw.length - 20] ^= 1; // 动 ciphertext 里的一个字节
  assert.throws(() => decryptSecret(raw.toString('base64'), key.toString('base64')));
});

ok('bindKey 长度不对要报清楚', () => {
  // 密文用合法的 32 字节 key 造，但拿一个 16 字节的 key 去解
  const enc = makeEncrypted('x', randomBytes(32));
  assert.throws(() => decryptSecret(enc, randomBytes(16).toString('base64')), /32 字节/);
});

ok('密文太短要报清楚', () => {
  const key = randomBytes(32);
  assert.throws(() => decryptSecret(Buffer.alloc(10).toString('base64'), key.toString('base64')), /太短/);
});

ok('不是 base64 的密文不崩', () => {
  const key = randomBytes(32);
  assert.throws(() => decryptSecret('!!!not-base64!!!', key.toString('base64')));
});

ok('状态码常量和官方一致', () => {
  assert.deepEqual(BIND_STATUS, { NONE: 0, PENDING: 1, DONE: 2, EXPIRED: 3 });
});

console.log(`\n${pass}/${pass + fails.length} 通过`);
if (fails.length) {
  console.log('失败项:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exitCode = 1;
}
