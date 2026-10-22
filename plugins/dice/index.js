/**
 * 示例插件：掷骰子
 * 演示三件事——带参数的命令、每用户状态、持久化存储。
 * 后续写斗罗这类游戏插件时，套路完全一样，只是数据模型更复杂。
 */
export default {
  id: 'dice',
  name: '掷骰子',
  version: '1.0.0',
  description: '演示参数解析与玩家数据持久化',

  setup(ctx) {
    ctx.command('roll [面数]', { desc: '掷一次骰子，默认 100 面' }, async (msg) => {
      const faces = Math.max(2, Math.min(100000, Number(msg.args[0]) || 100));
      const value = 1 + Math.floor(Math.random() * faces);

      // 每个玩家独立计数，存在 data/plugins/dice.json
      const key = `user:${msg.userId}`;
      const stat = (await ctx.storage.get(key)) ?? { rolls: 0, best: 0 };
      stat.rolls += 1;
      stat.best = Math.max(stat.best, value);
      await ctx.storage.set(key, stat);

      await msg.reply(`🎲 ${value} / ${faces}\n你已掷 ${stat.rolls} 次，最高 ${stat.best}`);
    });

    ctx.command('rank', { desc: '查看掷骰子排行榜（前 5）' }, async (msg) => {
      const all = await ctx.storage.all();
      const rows = Object.entries(all)
        .filter(([k]) => k.startsWith('user:'))
        .map(([k, v]) => ({ uid: k.slice(5), ...v }))
        .sort((a, b) => b.best - a.best)
        .slice(0, 5);

      if (!rows.length) return msg.reply('还没有人掷过骰子。');
      const lines = rows.map((r, i) => `${i + 1}. ${r.uid.slice(0, 8)}… 最高 ${r.best}（${r.rolls} 次）`);
      await msg.reply(['🏆 排行榜', ...lines].join('\n'));
    });
  },
};
