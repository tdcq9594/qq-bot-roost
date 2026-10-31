#!/usr/bin/env node
/**
 * 生成供应链签名用的 Ed25519 密钥对
 * =================================
 *
 *   node scripts/keygen.mjs                 # 写到 keys/
 *   node scripts/keygen.mjs --out D:/keys   # 写到指定目录
 *
 * 三条硬规则（写在这里，因为出事时没人会去翻文档）：
 *   1. **私钥必须离线**。它只在发版机上出现，不进仓库、不进 CI 缓存、不发网盘。
 *   2. **两把**。主用 + 备用，分开介质存。丢私钥 = 以后再也发不了签名版本，
 *      只能靠「新旧公钥并存一版」轮换，代价是所有人都要升级两次。
 *   3. **生成后把公钥填进 `src/trust.js` 的 `EMBEDDED_PUBKEY`**，
 *      否则框架不知道拿什么验签。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : 'keys';

const privPath = path.join(outDir, 'trust-private.pem');
const pubPath = path.join(outDir, 'trust-public.pem');

for (const p of [privPath, pubPath]) {
  if (fs.existsSync(p)) {
    console.error(`拒绝覆盖已存在的密钥：${p}`);
    console.error('轮换密钥请另建目录，不要复用旧路径——旧公钥可能还在别人的框架里。');
    process.exit(1);
  }
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(privPath, privPem, { mode: 0o600 });
fs.writeFileSync(pubPath, pubPem, 'utf8');

/** 32 字节裸公钥，方便塞进 EMBEDDED_PUBKEY（比 PEM 短，不会把源码撑开） */
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

console.log(`私钥  ${privPath}（权限 600，务必离线备份）`);
console.log(`公钥  ${pubPath}`);
console.log('');
console.log('把下面这行填进 src/trust.js 的 EMBEDDED_PUBKEY：');
console.log(raw);
console.log('');
console.log('然后：node scripts/sign.mjs <文件> --key ' + privPath);
