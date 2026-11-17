/**
 * OneBot 独占模式下放行的内核命令（`src/onebot/keep.js`）。
 *
 * 这条规则守的是「独占 = 对话交给客户端」的语义：
 *   · 绑定四件套必须放行——客户端里是合成号，真号只能靠绑定表，堵了就没法映射
 *   · 其余内核命令（`/help`、`/ping`、`/admin` …）在群里回一句就是噪音，
 *     而且任何人发一句 `/help` 都能触发
 *
 * 为什么不写成「pluginId === '__core' 就放行」：绑定命令和 help 挂在同一个
 * 插件 id 下，按 id 判等于整组放行——第一版就是这么漏的。
 *
 * 跑法：node --test test/onebot-keep.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { onebotAllowsCore, ONEBOT_KEEP_COMMANDS } from '../src/onebot/keep.js';

test('绑定四件套全部放行', () => {
  for (const name of ['绑定qq', 'qq验证码', '绑定群号', '绑定成员']) {
    assert.equal(onebotAllowsCore(name), true, `该放行：${name}`);
  }
});

test('主菜单与其它内核命令一律静默', () => {
  for (const name of ['help', 'menu', 'ping', 'whoami', 'claim', 'status', 'stats',
    'admin', 'plugins', 'enable', 'disable', '群插件', 'reload']) {
    assert.equal(onebotAllowsCore(name), false, `该静默：${name}`);
  }
});

test('大小写与多余空格不影响判定', () => {
  assert.equal(onebotAllowsCore(' 绑定QQ '), true);
  assert.equal(onebotAllowsCore('QQ验证码'), true);
  assert.equal(onebotAllowsCore('HELP'), false);
});

test('空值 / null / 未注册命令都不放行', () => {
  for (const v of ['', ' ', null, undefined, '不存在的命令']) {
    assert.equal(onebotAllowsCore(v), false, `不该放行：${String(v)}`);
  }
});

test('白名单只有四条，别顺手加宽', () => {
  assert.deepEqual([...ONEBOT_KEEP_COMMANDS], ['绑定qq', 'qq验证码', '绑定群号', '绑定成员']);
  assert.ok(Object.isFrozen(ONEBOT_KEEP_COMMANDS), '白名单要冻结，防止运行期被 push');
});
