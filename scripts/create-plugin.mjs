#!/usr/bin/env node
/**
 * 新建插件
 * ========
 *
 *   npm run create -- my-plugin "我的插件"
 *   npm run create                    # 交互式问
 *
 * 生成 plugins/<id>/index.js：带一个能跑的命令、一条菜单、配置项示例，
 * 以及 testkit 能直接用的结构。生成完立刻可以：
 *
 *   npm run test:plugin -- my-plugin hello
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

const TEMPLATE = (id, name) => `/**
 * ${name}
 * ${'='.repeat(name.length * 2)}
 *
 * 用 \`npm run test:plugin -- ${id} hello\` 直接跑，不用开机器人。
 */

export default {
  id: '${id}',
  name: '${name}',
  version: '0.1.0',
  description: '一句话说明这个插件干什么',

  // 面板「设置」页会按这里的默认值生成表单。
  // 想加校验就写成完整写法：{ default: 3, type: 'number', min: 1, max: 10, desc: '次数' }
  config: {
    greeting: '你好',
  },

  /** @param {RoostCtx} ctx */
  setup(ctx) {
    ctx.command('hello [名字]', { desc: '跟某人打招呼' }, async (msg) => {
      const who = msg.args[0] || msg.userName || '你';
      await msg.reply(\`\${ctx.config.greeting}，\${who}！\`);
    });

    // 非命令玩法也要进菜单，不然用户不知道有这功能
    ctx.menu('${name}', [
      { text: '/hello 名字', desc: '打个招呼' },
    ]);
  },
};
`;

async function main() {
  let id = process.argv[2];
  let name = process.argv[3];

  if (!id) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    id = (await rl.question('插件 id（小写字母、数字、横线）：')).trim();
    name = (await rl.question('显示名：')).trim();
    rl.close();
  }

  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(id ?? '')) {
    console.error('插件 id 不合法：只允许小写字母、数字、下划线、横线，长度 2-32');
    process.exit(1);
  }

  const dir = path.resolve('plugins', id);
  if (await fs.access(dir).then(() => true).catch(() => false)) {
    console.error(`plugins/${id} 已经存在了，换个 id 或先删掉它`);
    process.exit(1);
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.js'), TEMPLATE(id, name || id), 'utf8');

  console.log(`\n已生成 plugins/${id}/index.js\n`);
  console.log('下一步：');
  console.log(`  npm run test:plugin -- ${id} hello`);
  console.log('  npm run test:plugin -- ' + id + ' --list');
  console.log('\n热重载会自己捡到它，不用重启。');
}

main().catch((e) => {
  console.error('生成失败：', e.message);
  process.exit(1);
});
