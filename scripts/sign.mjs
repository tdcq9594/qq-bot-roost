#!/usr/bin/env node
/**
 * 给清单文件签名
 * ==============
 *
 *   node scripts/sign.mjs index.json --key keys/trust-private.pem
 *   node scripts/sign.mjs SHA256SUMS --key keys/trust-private.pem
 *
 * 产出 `<文件>.sig`，内容是一行 JSON：`{"alg":"ed25519","keyId":"…","sig":"…"}`。
 *
 * 签什么：
 *   · `.json` → 解析后规范化（键排序、无空白），镜像站重新序列化也不会失效；
 *   · 其它   → CRLF 归一成 LF、去末尾空白后签名（`SHA256SUMS` 这类纯文本）。
 *
 * 验签方必须用同一套规则，见 `src/trust.js` 的 `canonicalize` / `normalizeText`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, normalizeText, signText, verifyText, publicKeyFrom } from '../src/trust.js';

const args = process.argv.slice(2);

/** 取位置参数时要跳过选项的值，否则 `--key keys/x.pem` 里的路径会被当成文件名 */
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--key' || args[i] === '--key-id') {
    i += 1;
    continue;
  }
  if (args[i].startsWith('--')) continue;
  positional.push(args[i]);
}

const file = positional[0];
const keyIdx = args.indexOf('--key');
const keyPath = keyIdx >= 0 ? args[keyIdx + 1] : 'keys/trust-private.pem';
const idIdx = args.indexOf('--key-id');
const keyId = idIdx >= 0 ? args[idIdx + 1] : '';

if (!file) {
  console.error('用法：node scripts/sign.mjs <文件> --key <私钥.pem> [--key-id 名称]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`文件不存在：${file}`);
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`私钥不存在：${keyPath}`);
  console.error('先跑 node scripts/keygen.mjs，或者把发版机上的私钥放到这个路径。');
  process.exit(1);
}

const raw = fs.readFileSync(file, 'utf8');
let payload;
if (path.extname(file).toLowerCase() === '.json') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`不是合法 JSON：${e.message}`);
    process.exit(1);
  }
  payload = canonicalize(parsed);
} else {
  payload = canonicalize(normalizeText(raw));
}

const privPem = fs.readFileSync(keyPath, 'utf8');
const sig = signText(payload, privPem);

/**
 * 自检：签完立刻用配对公钥验一次。
 *
 * 不验的话，「私钥和公钥不是一对」这种错要等到用户安装失败才发现，
 * 而那时候索引已经推出去了。
 */
const pubPath = path.join(path.dirname(keyPath), 'trust-public.pem');
if (fs.existsSync(pubPath)) {
  const pub = publicKeyFrom(fs.readFileSync(pubPath, 'utf8'));
  if (!pub || !verifyText(payload, sig, pub)) {
    console.error('自检失败：私钥与同目录的 trust-public.pem 不匹配，已中止。');
    process.exit(1);
  }
}

const out = `${file}.sig`;
fs.writeFileSync(out, JSON.stringify({ alg: 'ed25519', keyId, sig }) + '\n', 'utf8');
console.log(`已签名 ${file} → ${out}（${payload.length} 字节内容）`);
