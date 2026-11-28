import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginFilterOf } from '../src/bot.js';

test('safeMode 只放行内建插件（无 plugin.json）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-safe-'));
  try {
    fs.mkdirSync(path.join(dir, 'builtin'));
    fs.writeFileSync(path.join(dir, 'builtin', 'index.js'), '');
    fs.mkdirSync(path.join(dir, 'external'));
    fs.writeFileSync(path.join(dir, 'external', 'plugin.json'), '{}');

    const normal = pluginFilterOf({ mode: 'all' }, dir);
    assert.equal(normal('builtin'), true);
    assert.equal(normal('external'), true, '普通模式外部插件照常加载');

    const safe = pluginFilterOf({ mode: 'all', safeMode: true }, dir);
    assert.equal(safe('builtin'), true, '安全模式内建插件仍加载');
    assert.equal(safe('external'), false, '安全模式外部插件必须跳过');

    // 与 include/exclude 叠加：safeMode 是额外硬过滤
    const safeInc = pluginFilterOf({ mode: 'include', list: ['external', 'builtin'], safeMode: true }, dir);
    assert.equal(safeInc('builtin'), true);
    assert.equal(safeInc('external'), false);

    // 读不到目录时宁可少加载
    const safeMissing = pluginFilterOf({ mode: 'all', safeMode: true }, dir);
    assert.equal(safeMissing('no-such-dir'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
