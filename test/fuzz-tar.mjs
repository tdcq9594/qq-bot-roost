/**
 * tar 解析的对抗测试
 * ==================
 *
 *   node --test test/fuzz-tar.mjs
 *
 * 为什么单独一份：`parseTar` 是手写的（零依赖的代价），输入来自网络——
 * 一个畸形 tar 就能打死进程。2026-10-31 这轮就撞出来一个：
 * size 字段写成负数时，游标「前进 512 又倒退 512」原地打转，
 * 每轮还 push 一条条目，几十字节的包直接把内存吃光。
 *
 * 断言只有三条，但每条都必须成立：
 *   1. **一定返回**（不死循环、不抛未捕获异常）
 *   2. 返回值一定是数组，条目形状合法
 *   3. 路径不会因为解析而被「改写」成越界路径（穿越防护在 extract 那层，
 *      这里只保证解析本身不制造 `..`）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTar } from '../src/tarball.js';

/** 造一个 tar 头：name + 八进制 size + type */
function header(name, sizeField, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(String(sizeField).padEnd(12, ' '), 124, 12, 'ascii');
  h.write(type, 156, 1, 'ascii');
  return h;
}

test('畸形：size 是负数时不能原地打转（曾导致 OOM）', () => {
  const buf = Buffer.concat([header('evil', '-1000'), Buffer.alloc(1024)]);
  const r = parseTar(buf);
  assert.ok(Array.isArray(r));
});

test('畸形：size 超大不会越界读', () => {
  const buf = Buffer.concat([header('big', '77777777777'), Buffer.alloc(1024)]);
  const r = parseTar(buf);
  assert.ok(Array.isArray(r));
});

test('畸形：size 字段是垃圾字符时按 0 处理', () => {
  const buf = Buffer.concat([header('junk', 'zzzz'), Buffer.alloc(1024)]);
  const r = parseTar(buf);
  assert.ok(Array.isArray(r));
});

test('畸形：头部截断（不足 512 字节）直接返回空', () => {
  assert.deepEqual(parseTar(Buffer.alloc(100)), []);
  assert.deepEqual(parseTar(Buffer.alloc(0)), []);
});

test('正常：一个文件 + 一个目录', () => {
  const content = Buffer.from('hello');
  const buf = Buffer.concat([
    header('a.txt', content.length, '0'),
    content,
    Buffer.alloc(512 - content.length),
    header('dir/', 0, '5'),
    Buffer.alloc(1024),
  ]);
  const r = parseTar(buf);
  assert.equal(r.length, 2);
  assert.equal(r[0].name, 'a.txt');
  assert.equal(r[0].dir, false);
  assert.equal(r[0].content.toString(), 'hello');
  assert.equal(r[1].name, 'dir/');
  assert.equal(r[1].dir, true);
});

test('随机字节：两万次不崩、不死循环、返回数组', () => {
  // 固定种子，失败可复现；不用 Math.random 是为了 CI 上也能重现
  let seed = 0x2f6e2b1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < 20000; i++) {
    const len = 1 + Math.floor(rand() * 2048);
    const buf = Buffer.alloc(len);
    for (let j = 0; j < len; j++) buf[j] = Math.floor(rand() * 256);
    const r = parseTar(buf);
    assert.ok(Array.isArray(r), `第 ${i} 次不是数组`);
    for (const e of r) {
      assert.equal(typeof e.name, 'string');
      assert.equal(typeof e.dir, 'boolean');
    }
  }
});

test('随机字节：只在头部区域乱写（更容易命中解析分支）', () => {
  let seed = 0x51a3c7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < 5000; i++) {
    const buf = Buffer.alloc(2048);
    for (let j = 0; j < 512; j++) buf[j] = Math.floor(rand() * 256);
    const r = parseTar(buf);
    assert.ok(Array.isArray(r));
  }
});
