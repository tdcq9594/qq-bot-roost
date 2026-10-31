/**
 * 信任链（签名/验签）自测
 * ======================
 *
 *   node --test test/trust.mjs
 *
 * 覆盖四件事：
 *   1. 规范化稳定（键序变化不影响签名）
 *   2. 签名往返、篡改必失败、换密钥必失败
 *   3. `checkTrust` 的四种状态一个不少
 *   4. `blockReason` 的两段式行为（enforce 关 = 全放行；开 = 按白名单拦）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  canonicalize,
  normalizeText,
  publicKeyFrom,
  signText,
  verifyText,
  parseSig,
  resolveTrust,
  checkTrust,
  blockReason,
  EMBEDDED_PUBKEY,
  EMBEDDED_ENFORCE,
} from '../src/trust.js';
import { isOfficialSource, DEFAULT_INDEX_URL } from '../src/plugin/market.js';

function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
    raw: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
  };
}

const kp = newKeyPair();

test('canonicalize：键序不影响结果', () => {
  const a = { b: 2, a: 1, c: { z: 1, y: [3, 2] } };
  const b = { c: { y: [3, 2], z: 1 }, a: 1, b: 2 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize(a), '{"a":1,"b":2,"c":{"y":[3,2],"z":1}}');
});

test('canonicalize：数组保序（顺序是内容的一部分）', () => {
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
});

test('canonicalize：undefined 直接报错，不静默变 null', () => {
  assert.throws(() => canonicalize({ a: undefined }), /undefined/);
});

test('normalizeText：CRLF 归一 + 去末尾空白', () => {
  assert.equal(normalizeText('a\r\nb\r\n'), 'a\nb');
  assert.equal(normalizeText('a\nb\n\n'), 'a\nb');
});

test('签名往返', () => {
  const text = canonicalize({ plugins: [{ id: 'x', version: '1.0.0' }] });
  const sig = signText(text, kp.priv);
  assert.equal(verifyText(text, sig, kp.pub), true);
});

test('裸 32 字节 base64 公钥也能验', () => {
  const text = canonicalize({ a: 1 });
  const sig = signText(text, kp.priv);
  assert.equal(verifyText(text, sig, kp.raw), true);
});

test('改一个字节就失败', () => {
  const text = canonicalize({ a: 1 });
  const sig = signText(text, kp.priv);
  assert.equal(verifyText(canonicalize({ a: 2 }), sig, kp.pub), false);
});

test('换一对密钥就失败', () => {
  const other = newKeyPair();
  const text = canonicalize({ a: 1 });
  const sig = signText(text, kp.priv);
  assert.equal(verifyText(text, sig, other.pub), false);
});

test('parseSig：信封 / 裸 base64 / 垃圾', () => {
  assert.deepEqual(parseSig('{"alg":"ed25519","keyId":"k1","sig":"AAA"}'), { alg: 'ed25519', keyId: 'k1', sig: 'AAA' });
  assert.deepEqual(parseSig('AAA'), { alg: 'ed25519', keyId: '', sig: 'AAA' });
  assert.equal(parseSig(''), null);
  assert.equal(parseSig('{"alg":"ed25519"}'), null);
  assert.equal(parseSig('{坏 json'), null);
});

test('publicKeyFrom：PEM / raw / 垃圾', () => {
  assert.ok(publicKeyFrom(kp.pub));
  assert.ok(publicKeyFrom(kp.raw));
  assert.equal(publicKeyFrom(''), null);
  assert.equal(publicKeyFrom('不是密钥'), null);
});

test('checkTrust：四种状态', () => {
  const data = { plugins: [] };
  const sig = signText(canonicalize(data), kp.priv);
  const env = JSON.stringify({ alg: 'ed25519', keyId: 'k1', sig });

  assert.equal(checkTrust({ data, sigText: env, trust: { pubkey: kp.pub } }).status, 'ok');
  assert.equal(checkTrust({ data, sigText: '', trust: { pubkey: kp.pub } }).status, 'unsigned');
  assert.equal(checkTrust({ data: { plugins: [1] }, sigText: env, trust: { pubkey: kp.pub } }).status, 'bad');
  assert.equal(checkTrust({ data, sigText: env, trust: { pubkey: '' } }).status, 'unavailable');
});

test('checkTrust：公钥配错但格式合法 → bad，不是 unavailable', () => {
  const other = newKeyPair();
  const data = { plugins: [] };
  const env = JSON.stringify({ alg: 'ed25519', sig: signText(canonicalize(data), kp.priv) });
  assert.equal(checkTrust({ data, sigText: env, trust: { pubkey: other.pub } }).status, 'bad');
});

test('resolveTrust：缺省用内置公钥与内置开关', () => {
  assert.deepEqual(resolveTrust({}), {
    pubkey: EMBEDDED_PUBKEY,
    enforce: EMBEDDED_ENFORCE,
    allowUnsigned: [],
    officialUrls: [],
  });
  const t = resolveTrust({ security: { trust: { pubkey: 'x', enforce: true, allowUnsigned: ['a'] } } });
  assert.equal(t.enforce, true);
  assert.deepEqual(t.allowUnsigned, ['a']);
});

test('resolveTrust：配置能覆盖内置开关（面板开关优先于常量）', () => {
  const off = resolveTrust({ security: { trust: { enforce: false } } });
  assert.equal(off.enforce, false);
  const on = resolveTrust({ security: { trust: { enforce: true } } });
  assert.equal(on.enforce, true);
});

test('blockReason：自定义源一律放行（用户自己的信任决定）', () => {
  const t = { enforce: true, allowUnsigned: [] };
  assert.equal(blockReason(t, 'unsigned', 'x', { official: false }), null);
  assert.equal(blockReason(t, 'bad', 'x', { official: false }), null);
  assert.match(blockReason(t, 'bad', 'x', { official: true }), /签名校验失败/);
});

test('blockReason：enforce 关 → 一律放行（N 版两段式的第一段）', () => {
  const t = { enforce: false, allowUnsigned: [] };
  for (const s of ['ok', 'unsigned', 'bad', 'unavailable']) {
    assert.equal(blockReason(t, s, 'x'), null);
  }
});

test('blockReason：enforce 开 → 按状态与白名单拦', () => {
  const t = { enforce: true, allowUnsigned: ['legacy'] };
  assert.equal(blockReason(t, 'ok', 'x'), null);
  assert.equal(blockReason(t, 'unavailable', 'x'), null); // 没配公钥不能拦，否则全员断供
  assert.equal(blockReason(t, 'unsigned', 'legacy'), null);
  assert.match(blockReason(t, 'unsigned', 'other'), /没有签名/);
  assert.match(blockReason(t, 'bad', 'legacy'), /签名校验失败/);
});

test('checkTrust：配了坏公钥是 invalid，不是 unavailable', () => {
  const data = { plugins: [] };
  const r = checkTrust({ data, sigText: '', trust: { pubkey: '这不是公钥' } });
  assert.equal(r.status, 'invalid');
});

test('blockReason：invalid 在强制模式下必须拦（否则是假保护）', () => {
  const t = { enforce: true, allowUnsigned: [] };
  assert.match(blockReason(t, 'invalid', 'x'), /公钥无法解析/);
  // 对照：真的没配公钥时放行，避免全员断供
  assert.equal(blockReason(t, 'unavailable', 'x'), null);
});

test('isOfficialSource：只认官方地址和显式声明过的', () => {
  assert.equal(isOfficialSource(undefined), true);
  assert.equal(isOfficialSource(DEFAULT_INDEX_URL), true);
  assert.equal(isOfficialSource('https://example.com/index.json'), false);
  assert.equal(
    isOfficialSource('https://example.com/i.json', {
      security: { trust: { officialUrls: ['https://example.com/i.json'] } },
    }),
    true,
  );
});
