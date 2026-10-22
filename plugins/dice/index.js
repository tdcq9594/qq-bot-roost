/**
 * 示例插件：掷骰子
 * 演示四件事——带参数的命令、每用户状态、持久化存储、被动关键词触发。
 *
 * 被动触发是本例重点：群里有人说了句「掷骰子」，既没 @ 机器人也没用命令前缀，
 * 插件自己判断「这句我要管」，回应之后内核就不会再把它当噪音丢掉。
 */
export default {
  id: 'dice',
  name: '掷骰子',
  version: '1.1.0',
  description: '演示参数解析、玩家数据持久化与关键词被动触发',

  setup(ctx) {
    // 抽出来复用：命令和关键词走同一套逻辑
    async function roll(msg, faces) {
      const n = Math.max(2, Math.min(100000, faces || 100));
      const value = 1 + Math.floor(Math.random() * n);

      const key = `user:${msg.userId}`;
      const stat = (await ctx.storage.get(key)) ?? { rolls: 0, best: 0 };
      stat.rolls += 1;
      stat.best = Math.max(stat.best, value);
      await ctx.storage.set(key, stat);

      await msg.reply(`🎲 ${value} / ${n}\n你已掷 ${stat.rolls} 次，最高 ${stat.best}`);
      return true; // 明确告诉内核：这条我处理了
    }

    ctx.command('roll [面数]', { desc: '掷一次骰子，默认 100 面' }, async (msg) => {
      await roll(msg, Number(msg.args[0]));
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

    // 被动触发：群里有人直接说「掷骰子」，不用 @ 也不用命令前缀
    ctx.on('message', async (msg) => {
      if (msg.isCommand) return;
      if (msg.content === '掷骰子' || msg.content === 'roll') {
        return roll(msg, 100);
      }
      // 不返回 true 也不发消息 → 内核判定「无人回应」，静默丢弃
    });
  },
};
