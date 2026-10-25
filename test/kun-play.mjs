/**
 * 养鲲通关脚本
 * =============
 *
 * 不是断言测试（那个在 selftest.mjs 里），而是**把整局玩一遍**：
 * 两个玩家从零开始签到、孵化、喂食、磨炼、幻化、渡劫、互殴、拍卖、打 BOSS，
 * 每条回复都打印出来，人眼过一遍。
 *
 *   node test/kun-play.mjs
 *
 * 随机数用固定种子，同样的种子跑出来完全一样，方便对比改动前后。
 */
import { makeCtx, runCommand, runListeners, makeMsg } from '../src/plugin/testkit.js';

const plugin = (await import('../plugins/kun/index.js')).default;

let seed = 777;
globalThis.__kunRng = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const ctx = makeCtx({ id: 'kun' });
const G = 'g-play';
const A = 'userAAAA';
const B = 'userBBBB';

/** 剥掉 markdown 外壳，看「玩家实际看到的字」 */
const stripMd = (s) =>
  String(s ?? '')
    .replace(/<qqbot-at-user id="([^"]+)" \/>/g, '<@$1>')
    .replace(/\*\*/g, '')
    .replace(/\u200B/g, '');

const problems = [];

/** 以某个身份发一条指令 */
async function play(who, text, opts = {}) {
  const uid = opts.uid ?? (who === 'B' ? B : A);
  const name = opts.uid ? '阿丙' : who === 'B' ? '阿乙' : '阿甲';
  if (!opts.keepCd) {
    await ctx.storage.update(`p:${G}:${uid}`, (p) => (p ? { ...p, lu: 0 } : p));
  }
  const r = await runCommand(plugin, 'kun', {
    content: `/kun ${text}`,
    userId: uid,
    userName: name,
    groupId: G,
    ctx,
    mentioned: opts.mentioned,
    mentions: opts.mentions,
    raw: opts.raw,
    kind: opts.kind,
  });
  const plain = r.replies.map(stripMd);
  const tag = `${who} /kun ${text}`;
  if (!plain.length) {
    problems.push(`${tag} → 无回复`);
    console.log(`\n【${tag}】✗ 无回复`);
  } else {
    console.log(`\n【${tag}】`);
    for (const t of plain) console.log(t.replace(/^/gm, '  '));
  }
  return plain;
}

const setP = (uid, patch) =>
  ctx.storage.update(`p:${G}:${uid}`, (p) => ({
    nm: '', n: '', a: '', w: 0, e: 0, j: 0, s: 0, p: 0, h: 0, r: 0, l: 0,
    dc: 0, dk: '', dw: 0, li: 0, sg: '', lu: 0, tl: 0, bo: 0,
    ...(p ?? {}),
    ...patch,
  }));

const setG = (patch) =>
  ctx.storage.update(`g:${G}`, (g) => {
    const base = g ?? {
      on: '', au: { se: '', bu: '', bd: 0, at: 0 },
      gm: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, x: 0, y: 0, ques: '', ans: '', rw: 0, pn: 0, sl: 0, game: 0, t1: '', t2: '', t3: '', t4: '', t5: '' },
      bs: { rd: 0, w: 0, al: '', bo: '', kl: '', dl: '' },
    };
    return { ...base, ...patch, gm: { ...base.gm, ...(patch.gm ?? {}) } };
  });

// 开局给点家底，让每个指令都能真的执行
await setP(A, { nm: '阿甲', e: 30, j: 500, s: 5, p: 5, h: 5, r: 5 });
await setP(B, { nm: '阿乙', e: 30, j: 500, s: 5, p: 5, h: 5, r: 5 });

console.log('========== 开局 ==========');
await play('A', '菜单');
await play('A', '签到');
await play('B', '签到');
await play('A', '买蛋 3');
await play('A', '砸蛋 2');
await play('A', '孵化');
await play('B', '孵化');
await play('A', '查询');
await play('A', '喂食 3');
await play('A', '喝鸡汤 2');
await play('A', '磨炼 20');
await play('A', '今日运势');
await play('A', '查阅属性');
await play('A', '排行');

console.log('\n========== 幻化 / 渡劫 ==========');
await play('A', '幻化');
await play('A', '渡劫');

console.log('\n========== 对抗 ==========');
await play('A', '吞噬', { mentions: [{ id: B, isBot: false }] });
await play('A', '攻击', { mentions: [{ id: B, isBot: false }] });
await play('A', '强袭', { mentions: [{ id: B, isBot: false }] });
await play('A', '扔蛋', { mentions: [{ id: B, isBot: false }] });
await play('A', '查询');
await play('B', '查询');

console.log('\n========== 拍卖行 ==========');
await play('A', '出售 100');
await play('B', '出价 150');
await play('A', '拍卖行');
await play('A', '成交');

console.log('\n========== 小游戏 ==========');
await play('A', '小游戏开', { mentioned: true, raw: { author: { member_role: 'admin' } } });
await play('A', '当前游戏');
await play('A', '抽群主一个大嘴巴');
await play('A', '单挑群主');

console.log('\n========== BOSS ==========');
await play('A', 'BOSS菜单');
await play('A', '刷新BOSS', { raw: { author: { member_role: 'owner' } } });
await play('A', '查询BOSS');
await play('A', '攻击BOSS');
await play('A', '强袭BOSS');
await play('A', '吞噬BOSS');
await play('A', '阵亡名单');

console.log('\n========== 生存 ==========');
await play('A', '复活');
await play('B', '复活');
await play('B', '放生');
await play('A', '查看群主指令');
await play('A', 'OP');

console.log('\n========== 私聊 ==========');
await play('C', '绑定 ' + G, { uid: 'userCCCC', kind: 'c2c' });
await play('C', '磨炼 10', { uid: 'userCCCC', kind: 'c2c' });

console.log('\n========== *指令（不 @ 的写法） ==========');
{
  const msg = makeMsg({ content: '*查询', userId: A, userName: '阿甲', groupId: G });
  await ctx.storage.update(`p:${G}:${A}`, (p) => (p ? { ...p, lu: 0 } : p));
  const handled = await runListeners(plugin, msg, ctx);
  console.log(`\n【A *查询】 handled=${handled}`);
  console.log(msg.replies.map(stripMd).join('\n').replace(/^/gm, '  ') || '  ✗ 无回复');
  if (!msg.replies.length) problems.push('A *查询 → 无回复');
}

console.log('\n========== 数据清除 ==========');
await play('A', '数据清除', { mentioned: true, raw: { author: { member_role: 'owner' } } });
await play('A', '查询');

console.log('\n========== 汇总 ==========');
if (!problems.length) console.log('✓ 全部指令都有回复，没有静默失败');
else problems.forEach((p) => console.log('✗ ' + p));

globalThis.__kunRng = undefined;
