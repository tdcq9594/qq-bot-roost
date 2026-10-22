/**
 * 示例插件：回声
 * 演示最基础的两件事——注册命令、监听普通消息。
 */
export default {
  id: 'echo',
  name: '回声',
  version: '1.0.0',
  description: '复读机，演示命令与消息监听',

  setup(ctx) {
    // 1) 注册命令：/echo 你好世界
    ctx.command('echo <内容...>', { desc: '原样返回你说的内容' }, async (msg) => {
      const text = msg.args.join(' ');
      if (!text) return msg.reply(`用法: ${ctx.prefix}echo 随便说点什么`);
      await msg.reply(text);
    });

    // 2) 监听所有消息（不是命令的也会进来）
    ctx.on('message', async (msg) => {
      if (msg.isCommand) return; // 命令已由上面处理
      if (msg.content.includes('你好')) {
        await msg.reply(`你好呀，我是 ${ctx.name}。发 ${ctx.prefix}help 看命令。`);
      }
    });
  },
};
