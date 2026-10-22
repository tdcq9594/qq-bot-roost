/**
 * 养鲲
 * ======
 * 玩法来自「开局一条鲲，进化全靠吞」：
 *   签到赚节操 → 买蛋 → 孵化出鲲 → 喂食增重 → 吞噬别人抢体重 → 幻化换品种
 *
 * 数据按玩家单独存：user:<openid>
 * 存在 data/bots/<机器人id>/plugins/kun.json（由 ctx.storage 管理）
 *
 * 所有写操作都走 ctx.storage.update —— 它对同一个 key 串行执行。
 * 直接用 get → 改 → set 的话，玩家连发两条命令会互相覆盖、丢更新。
 */

/** 品种池：稀有度决定孵化权重和成长系数 */
const SPECIES = {
  普通: {
    weight: 60,
    grow: 1.0,
    list: ['尘鲲', '土鲲', '沙鲲', '石鲲', '岩鲲', '菜虚鲲', '胖头鲲'],
  },
  稀有: {
    weight: 28,
    grow: 1.15,
    list: ['碧鲲', '蓝鲲', '橙鲲', '雪鲲', '虹鲲', '阳鲲', '靓鲲'],
  },
  史诗: {
    weight: 10,
    grow: 1.35,
    list: ['炎鲲', '冰鲲', '雷鲲', '铁头鲲', '钢背鲲', '剑鲲', '齿鲲', '铠鲲', '烈鲲', '阴鲲'],
  },
  传说: {
    weight: 2,
    grow: 1.6,
    list: [
      '帝鲲', '圣鲲', '灵鲲', '冥鲲', '玄鲲', '魔鲲', '鬼鲲', '妖鲲', '幻鲲', '诡鲲',
      '尸鲲', '血鲲', '骨鲲', '腐鲲', '毒鲲', '凶鲲', '恶鲲', '黑鲲', '暗鲲', '炫鲲',
    ],
  },
};

const COST = {
  蛋: 80, // 买一颗蛋
  喂食: 20, // 每次喂食
  幻化丹: 200,
};

/** 按稀有度权重抽一个品种 */
function rollSpecies() {
  const pool = [];
  for (const [rarity, def] of Object.entries(SPECIES)) {
    for (let i = 0; i < def.weight; i++) {
      for (const name of def.list) pool.push({ name, rarity });
    }
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

const growOf = (rarity) => SPECIES[rarity]?.grow ?? 1;

/** 用 openid + 日期算「今日运势」，同一天同一人结果固定 */
function fortuneOf(userId, dateKey) {
  let h = 0;
  const s = `${userId}:${dateKey}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return [
    { name: '大凶', mul: 0.5, tip: '今天别吞噬，会亏。' },
    { name: '小凶', mul: 0.8, tip: '适合窝着喂食。' },
    { name: '平', mul: 1.0, tip: '平常心，日常操作。' },
    { name: '小吉', mul: 1.2, tip: '运气不错，可以试试吞噬。' },
    { name: '大吉', mul: 1.5, tip: '冲！今天吞噬有加成。' },
  ][h % 5];
}

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export default {
  id: 'kun',
  name: '养鲲',
  version: '1.0.0',
  description: '开局一条鲲，进化全靠吞：签到、孵化、喂食、吞噬、幻化',

  setup(ctx) {
    const L = ctx.defineLevels({ 管理员: 0 });
    const keyOf = (uid) => `user:${uid}`;

    /** 新玩家初始状态：送一颗蛋，能自己孵 */
    const fresh = (uid, name) => ({
      name: name || uid.slice(0, 8),
      species: '未孵化',
      rarity: '—',
      weight: 1, // 千克
      points: 100, // 节操
      eggs: 1,
      pills: 0, // 幻化丹
      lastSign: '',
      kills: 0,
      deaths: 0,
      bornAt: Date.now(),
    });

    /** 原子读改写：fn 里直接改传入对象，或返回新对象；返回 null 表示不写入 */
    const mutate = (uid, name, fn) =>
      ctx.storage.update(keyOf(uid), (p) => {
        const cur = p ?? fresh(uid, name);
        return fn(cur) ?? cur;
      });

    const read = async (uid) => (await ctx.storage.get(keyOf(uid))) ?? null;

    const fmt = (p) =>
      p.species === '未孵化'
        ? `还没有鲲，有 ${p.eggs} 颗蛋。发 /孵化 开局。\n节操 ${p.points}`
        : [
            `【${p.species}】${p.rarity} · ${p.weight.toFixed(1)} 千克`,
            `节操 ${p.points} · 蛋 ${p.eggs} 颗 · 幻化丹 ${p.pills}`,
            `战绩 ${p.kills} 杀 ${p.deaths} 死`,
          ].join('\n');

    /* ---------------- 查看 ---------------- */

    async function show(msg) {
      const p = await mutate(msg.userId, msg.userName, (x) => x);
      const f = fortuneOf(msg.userId, dayKey());
      await msg.reply(
        `${p.name} 的鲲\n${fmt(p)}\n\n今日运势：${f.name}（体重收益 ×${f.mul}）\n${f.tip}`,
      );
    }

    ctx.command('kun', { desc: '看看我的鲲' }, show);

    /* ---------------- 签到 ---------------- */

    ctx.command('签到', { desc: '每日签到领节操，偶尔能捡到蛋' }, async (msg) => {
      const today = dayKey();
      const f = fortuneOf(msg.userId, today);
      const gain = Math.round((40 + Math.random() * 40) * f.mul);
      const gotEgg = Math.random() < 0.35;
      let signed = false;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (x.lastSign === today) return null; // 已签过，不写
        signed = true;
        x.points += gain;
        x.lastSign = today;
        if (gotEgg) x.eggs += 1;
        return x;
      });

      if (!signed) return msg.reply('今天已经签过了，明天再来。');
      await msg.reply(
        `签到成功，节操 +${gain}（${f.name}）${gotEgg ? '\n还捡到一颗蛋。' : ''}\n当前节操 ${p.points}`,
      );
    });

    /* ---------------- 买蛋 ---------------- */

    ctx.command('买蛋', { desc: `花 ${COST.蛋} 节操买一颗鲲蛋` }, async (msg) => {
      let ok = false;
      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (x.points < COST.蛋) return null;
        ok = true;
        x.points -= COST.蛋;
        x.eggs += 1;
        return x;
      });
      if (!ok) return msg.reply(`节操不够，还差 ${COST.蛋 - p.points}。发 /签到 去赚。`);
      await msg.reply(`买到一颗蛋，现在有 ${p.eggs} 颗。发 /孵化 试试手气。`);
    });

    /* ---------------- 孵化 ---------------- */

    ctx.command('孵化', { desc: '孵一颗蛋，随机得到一只鲲' }, async (msg) => {
      const sp = rollSpecies();
      let ok = false;

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (x.eggs < 1) return null;
        ok = true;
        x.eggs -= 1;
        x.species = sp.name;
        x.rarity = sp.rarity;
        // 换新鲲不继承体重，但给个保底，免得越玩越小
        x.weight = x.weight <= 1 ? 1 : Math.max(1, Math.round(x.weight * 0.5));
        return x;
      });

      if (!ok) return msg.reply('你没有蛋。发 /买蛋 买一颗，或者等签到捡。');
      await msg.reply(
        `蛋裂开了——是【${sp.name}】！稀有度：${sp.rarity}\n新鲲起步 ${p.weight.toFixed(1)} 千克。`,
      );
    });

    /* ---------------- 喂食 ---------------- */

    ctx.command('喂食', { desc: `花 ${COST.喂食} 节操把鲲喂胖一点` }, async (msg) => {
      const f = fortuneOf(msg.userId, dayKey());
      const base = 2 + Math.random() * 4;
      let reason = '';

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (x.species === '未孵化') {
          reason = 'nokun';
          return null;
        }
        if (x.points < COST.喂食) {
          reason = 'poor';
          return null;
        }
        x.points -= COST.喂食;
        x.weight += base * growOf(x.rarity) * f.mul;
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。先发 /孵化 开局。');
      if (reason === 'poor') return msg.reply(`节操不够，还差 ${COST.喂食 - p.points}。`);
      await msg.reply(
        `喂了一顿，体重 +${(base * growOf(p.rarity) * f.mul).toFixed(1)} 千克\n` +
          `现在 ${p.weight.toFixed(1)} 千克，剩 ${p.points} 节操。`,
      );
    });

    /* ---------------- 吞噬（PvP） ---------------- */

    ctx.command('吞噬', { desc: '吞噬 @某人 的鲲，赢家抢走对方一部分体重' }, async (msg) => {
      const target = msg.mentions?.[0]?.id;
      if (!target) return msg.reply('要吞噬谁？发 /吞噬 @某人');
      if (target === msg.userId) return msg.reply('不能吞自己。');

      const me = await read(msg.userId);
      if (!me || me.species === '未孵化') return msg.reply('你还没有鲲。先发 /孵化 开局。');
      const other = await read(target);
      if (!other || other.species === '未孵化') return msg.reply('对方还没有鲲，无从下口。');

      const f = fortuneOf(msg.userId, dayKey());
      // 体重差决定基础胜率，稀有度和运势加成，再加随机
      const myPower = me.weight * growOf(me.rarity) * f.mul;
      const otherPower = other.weight * growOf(other.rarity);
      const win = Math.random() < myPower / (myPower + otherPower);

      if (win) {
        const steal = other.weight * 0.15;
        const mine = await mutate(msg.userId, msg.userName, (x) => {
          x.weight += steal;
          x.kills += 1;
          return x;
        });
        const theirs = await mutate(target, other.name, (x) => {
          x.weight = Math.max(0.5, x.weight - steal);
          x.deaths += 1;
          return x;
        });
        return msg.reply(
          `你的【${mine.species}】吞了对方的【${theirs.species}】！\n` +
            `体重 +${steal.toFixed(1)} → ${mine.weight.toFixed(1)} 千克\n` +
            `对方剩 ${theirs.weight.toFixed(1)} 千克。`,
        );
      }

      const lose = me.weight * 0.1;
      const mine = await mutate(msg.userId, msg.userName, (x) => {
        x.weight = Math.max(0.5, x.weight - lose);
        x.deaths += 1;
        return x;
      });
      const theirs = await mutate(target, other.name, (x) => {
        x.weight += lose;
        x.kills += 1;
        return x;
      });
      await msg.reply(
        `你的【${mine.species}】被对方的【${theirs.species}】反杀了。\n` +
          `体重 -${lose.toFixed(1)} → ${mine.weight.toFixed(1)} 千克。\n` +
          `有仇不报非君子啊。`,
      );
    });

    /* ---------------- 幻化 ---------------- */

    ctx.command('幻化', { desc: `花 ${COST.幻化丹} 节操炼幻化丹，随机换品种` }, async (msg) => {
      const sp = rollSpecies();
      let oldName = '';
      let reason = '';

      const p = await mutate(msg.userId, msg.userName, (x) => {
        if (x.species === '未孵化') {
          reason = 'nokun';
          return null;
        }
        if (x.pills < 1) {
          if (x.points < COST.幻化丹) {
            reason = 'poor';
            return null;
          }
          x.points -= COST.幻化丹;
          x.pills += 1;
        }
        x.pills -= 1;
        oldName = x.species;
        x.species = sp.name;
        x.rarity = sp.rarity;
        return x;
      });

      if (reason === 'nokun') return msg.reply('还没有鲲。先发 /孵化 开局。');
      if (reason === 'poor') {
        return msg.reply(`炼一颗幻化丹要 ${COST.幻化丹} 节操，你还差 ${COST.幻化丹 - p.points}。`);
      }
      await msg.reply(`幻化成功：${oldName} → 【${sp.name}】（${sp.rarity}）\n体重不变。`);
    });

    /* ---------------- 排行 ---------------- */

    ctx.command('鲲榜', { desc: '体重排行前 5' }, async (msg) => {
      const all = await ctx.storage.all();
      const rows = Object.entries(all)
        .filter(([k]) => k.startsWith('user:'))
        .map(([k, v]) => ({ uid: k.slice(5), ...v }))
        .filter((r) => r.species && r.species !== '未孵化')
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 5);
      if (!rows.length) return msg.reply('还没有人养鲲。发 /kun 开局。');
      const lines = rows.map(
        (r, i) =>
          `${i + 1}. ${r.name || r.uid.slice(0, 8)} · ${r.species} · ${r.weight.toFixed(1)} 千克`,
      );
      await msg.reply(['鲲榜', ...lines].join('\n'));
    });

    /* ---------------- 菜单 ---------------- */

    ctx.menu('玩法', [
      { text: '我的鲲', desc: '群里直接说，不用加前缀' },
      { text: '签到', desc: '每天一次，赚节操和蛋' },
      { text: '吞噬 @某人', desc: '体重决定胜率，赢家抢体重' },
    ]);

    ctx.menu('说明', [
      { text: '节操来源：签到、吞噬获胜' },
      { text: `买蛋 ${COST.蛋} · 喂食 ${COST.喂食} · 幻化丹 ${COST.幻化丹}` },
      { text: '品种分普通 / 稀有 / 史诗 / 传说，稀有度影响成长速度' },
      { text: '每天运势会乘到体重收益上，大吉时吞噬最划算' },
    ]);

    /* ---------------- 被动触发 ---------------- */

    ctx.on('message', async (msg) => {
      if (msg.isCommand) return;
      if (msg.content === '我的鲲' || msg.content === '养鲲') {
        await show(msg);
        return true;
      }
    });

    /* ---------------- 管理 ---------------- */

    ctx.command('kunreset', { desc: '清空所有人的鲲（插件管理员）' }, async (msg) => {
      if (!(await ctx.can(msg, L.管理员))) {
        return msg.reply(`需要「养鲲」管理员权限（等级 ${L.管理员}）`);
      }
      const all = await ctx.storage.all();
      let n = 0;
      for (const k of Object.keys(all)) {
        if (k.startsWith('user:')) {
          await ctx.storage.delete(k);
          n++;
        }
      }
      await msg.reply(`已清空 ${n} 条养鲲记录。`);
    });
  },
};
