#!/usr/bin/env node
/**
 * 跑一个插件的命令，看它回了什么
 * ================================
 *
 *   npm run test:plugin -- dice roll
 *   npm run test:plugin -- dice roll "/roll 6"
 *   npm run test:plugin -- echo echo "你好"
 *
 * 不连 QQ、不开面板、不需要凭证：用 testkit 造一个假 ctx 和假 msg。
 * 想看全部命令就 `npm run test:plugin -- dice --list`。
 */
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runCommand, makeCtx } from '../src/plugin/testkit.js';

const [, , id, command, content] = process.argv;

if (!id) {
  console.log('用法：npm run test:plugin -- <插件id> <命令名|--list> ["完整消息"]');
  console.log('例如：npm run test:plugin -- dice roll "/roll 6"');
  process.exit(1);
}

const entry = pathToFileURL(path.resolve('plugins', id, 'index.js')).href;

let plugin;
try {
  plugin = (await import(entry)).default;
} catch (e) {
  console.error(`加载插件 ${id} 失败：${e.message}`);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
}
if (!plugin?.setup) {
  console.error(`plugins/${id}/index.js 没有默认导出 { setup }`);
  process.exit(1);
}

// --list：把命令和菜单列出来
if (!command || command === '--list') {
  const ctx = makeCtx({ id, config: plugin.config ?? {} });
  await plugin.setup(ctx);
  console.log(`插件 ${id}（${plugin.name ?? id} v${plugin.version ?? '0.0.0'}）`);
  console.log(`\n命令 ${ctx.__commands.size} 个：`);
  for (const name of ctx.__commands.keys()) console.log(`  /${name}`);
  if (ctx.__menus.length) {
    console.log('\n菜单：');
    for (const m of ctx.__menus) console.log(`  ${m.title}（${m.items.length} 条）`);
  }
  process.exit(0);
}

try {
  /**
   * 第三个参数可以只给「参数部分」：`dice roll 6` 等价于 `/roll 6`。
   *
   * 顺带绕开一个坑：Git Bash 会把以 / 开头的参数当路径转换
   * （`/roll 6` 变成 `C:/Program Files/Git/roll 6`），所以直接写参数更稳。
   */
  let body = content;
  if (body && !body.startsWith('/')) body = `/${command} ${body}`;

  const r = await runCommand(plugin, command, {
    content: body ?? `/${command}`,
    config: plugin.config ?? {},
  });
  console.log(`\n→ 回复 ${r.replies.length} 条${r.handled ? '' : '（但没标记 replied）'}：\n`);
  r.replies.forEach((t, i) => console.log(`[${i + 1}] ${t}\n`));
  if (!r.replies.length) {
    console.log('（没有回复）');
  }
} catch (e) {
  console.error(`执行失败：${e.message}`);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
