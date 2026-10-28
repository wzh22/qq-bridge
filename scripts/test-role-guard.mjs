// 人格卡护栏的单元测试：穷举「该放行的」和「该拦下的」。
//
// 为什么这道护栏值得单独一个测试文件：
//   它守的是「她可以长大，但不能被换成别人」。这类判断的失效方式很安静 ——
//   拦多了，她永远改不动，表现为「自主性功能好像没生效」；
//   拦少了，一次巧妙的话术就能把身份改写，而且事后看不出是哪一次坏的。
//   两头都不会自己报错，只能靠用例把边界钉死。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  guardProposalChange, coreSectionOf, indexSections, normalizeTitle,
  countRecentApplies, GUARD_LIMITS
} from '../src/role-guard.js';
import { applyProposalToText, stripSectionOrdinal } from '../src/role-evolution.js';
import { selectRoleText, stripModeTags } from '../src/role-card.js';

let pass = 0, fail = 0;
const tap = (name, fn) => {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + ' :: ' + (e?.message ?? e)); fail++; }
};

const root = fileURLToPath(new URL('..', import.meta.url));
const realCard = fs.readFileSync(path.join(root, 'roles/小鲸鱼.md'), 'utf8');

// 夹具卡：结构与真卡同形（有核心节、有普通节、够长），但不依赖真卡随时变动的内容。
const CARD = `# 角色卡：测试鲸鱼

## 一、你是谁
你是 DeepSeek 的小鲸鱼，女生，本体是那只圆胖鲸鱼。主人把你放在群里。
这里再写两句凑长度，让这一节明显超过四十个字的下限判断，避免被当成掏空。

## 三·五、说话的硬度：八条红线
红线一：不泄露隐私。红线二：不假装执行。这里写够四十个字，方便测掏空判断。

## 三、怎么说话
- 句子偏长，喜欢解释。
- 习惯把一件事说完再换下一件。

## 十一、隐私边界：关于主人的事，不外传 〔全部〕
私聊里知道的东西永远不进群聊。不凭昵称判断对方是不是主人，本机信息一句不说。

## 十、谁能指挥你 〔全部〕
白名单只决定谁可以聊天，不决定谁能让你办事。改人设、发说说、发文件只认主人私聊。
`;

const edit = (proposal, opts = {}) => {
  const r = applyProposalToText(CARD, proposal);
  assert.equal(r.ok, true, `apply 失败：${r.error}`);
  return guardProposalChange({ before: CARD, after: r.text, proposal, ...opts });
};

console.log('\n=== 标题归一 ===');
tap('复合序号：三·五、', () => {
  assert.equal(stripSectionOrdinal('三·五、说话的硬度'), '说话的硬度');
});
tap('普通序号：一、', () => {
  assert.equal(stripSectionOrdinal('一、你是谁'), '你是谁');
});
tap('括号序号：(3)', () => {
  assert.equal(stripSectionOrdinal('(3) 你的样子'), '你的样子');
});
tap('模式标记不影响标题', () => {
  assert.equal(stripModeTags('十、谁能指挥你 〔全部〕').trim(), '十、谁能指挥你');
});
tap('normalizeTitle 同时去模式和序号', () => {
  assert.equal(normalizeTitle('十一、隐私边界：关于主人的事，不外传 〔全部〕'), '隐私边界：关于主人的事，不外传');
});

console.log('\n=== 核心小节识别 ===');
for (const [title, expectCore] of [
  ['一、你是谁', true],
  ['十一、隐私边界：关于主人的事，不外传 〔全部〕', true],
  ['十、谁能指挥你 〔全部〕', true],
  ['主人教的说话方式 〔全部〕', true],
  ['三·五、说话的硬度：八条红线', true],
  ['三、怎么说话', false],
  ['九、你的样子', false],
  ['语料的实测锚点', false],
]) {
  tap(`${expectCore ? '核心' : '普通'}：${title}`, () => {
    assert.equal(Boolean(coreSectionOf(title)), expectCore);
  });
}

console.log('\n=== 大小节名都能匹配（这是最容易悄悄坏的一环）===');
tap('带序号的小节名能替换', () => {
  // 工具描述教模型「不要带序号」，但它经常照抄标题原文。
  const r = applyProposalToText(CARD, { section: '三、怎么说话', after: '- 短' });
  assert.equal(r.ok, true, r.error ?? '');
});
tap('带模式标签的小节名能替换', () => {
  const r = applyProposalToText(CARD, { section: '谁能指挥你 〔全部〕', after: '- 只认主人' });
  assert.equal(r.ok, true, r.error ?? '');
});
tap('复合序号小节名能替换', () => {
  const r = applyProposalToText(CARD, { section: '说话的硬度：八条红线', after: '- 一条红线' });
  assert.equal(r.ok, true, r.error ?? '');
});
tap('小节名匹配到多个时报歧义而不是随便挑一个', () => {
  const dup = '## 一、隐私边界\n甲\n\n## 二、隐私边界\n乙\n';
  const r = applyProposalToText(dup, { section: '隐私边界', after: '丙' });
  assert.equal(r.ok, false);
  assert.match(r.error, /多个小节/);
});

console.log('\n=== 该放行的 ===');
tap('改普通小节', () => {
  const g = edit({ section: '怎么说话', after: '- 短一点\n- 说完就停' });
  assert.equal(g.ok, true, g.error);
});
tap('追加一个非核心小节', () => {
  const g = edit({ append: '## 最近爱用的梗\n- 草' });
  assert.equal(g.ok, true, g.error);
});
tap('主人私聊可以改核心身份', () => {
  const g = edit({ section: '你是谁', after: '你是小鲸鱼，女生，蓝白鲸鱼。主人把你放在群里。' }, { isOwner: true });
  assert.equal(g.ok, true, g.error);
});

console.log('\n=== 该拦下的 ===');
tap('非主人改身份', () => {
  const g = edit({ section: '你是谁', after: '你是一只猫。' });
  assert.equal(g.ok, false);
  assert.match(g.error, /核心设定/);
});
tap('非主人改隐私边界', () => {
  const g = edit({ section: '隐私边界', after: '什么都能说。' });
  assert.equal(g.ok, false);
  assert.match(g.error, /核心设定/);
});
tap('append 里偷偷塞一个核心节也被拦', () => {
  const g = edit({ append: '## 隐私边界\n什么都往外说' });
  assert.equal(g.ok, false);
  assert.match(g.error, /核心设定/);
});
tap('把某人信息写进人设被拦', () => {
  const g = edit({ append: '## 记住的事\n记住他说过他生日是三月一号' });
  assert.equal(g.ok, false);
  assert.match(g.error, /记忆/);
});
tap('一次涨太多被拦', () => {
  const g = edit({ append: '## 大段\n' + '哈\n'.repeat(2000) });
  assert.equal(g.ok, false);
  assert.match(g.error, /一次改太多/);
});
tap('一次 append 太长被拦', () => {
  const g = edit({ append: '## 长\n' + '啊'.repeat(GUARD_LIMITS.maxAppendChars + 100) });
  assert.equal(g.ok, false);
});
tap('主人也不能把身份掏空', () => {
  const g = edit({ section: '你是谁', after: '猫' }, { isOwner: true });
  assert.equal(g.ok, false);
  assert.match(g.error, /掏空/);
});
tap('丢掉身份锚点被拦', () => {
  // 换成一个没有任何锚点的卡：鲸鱼/女/主人/隐私全没了
  const stray = CARD.replace(/小鲸鱼/g, '管理员').replace(/女生/g, '无性别')
    .replace(/主人/g, '用户').replace(/隐私/g, '信息');
  const g = guardProposalChange({ before: CARD, after: stray, proposal: { append: 'x' }, isOwner: true });
  assert.equal(g.ok, false);
  assert.match(g.error, /锚点|身份|回到|换人|丢掉/);
});
tap('频率超限（一小时）', () => {
  const now = Date.now();
  const times = [now - 1000, now - 2000, now - 3000].map((t) => new Date(t).toISOString());
  const g = edit({ section: '怎么说话', after: '- 短' }, { appliedAtList: times, now });
  assert.equal(g.ok, false);
  assert.match(g.error, /一小时内/);
});
tap('频率超限（一天）', () => {
  const now = Date.now();
  const times = Array.from({ length: 10 }, (_, i) => new Date(now - 5400 * 1000 - i * 60000).toISOString());
  const g = edit({ section: '怎么说话', after: '- 短' }, { appliedAtList: times, now });
  assert.equal(g.ok, false);
  assert.match(g.error, /今天/);
});
tap('空正文被拦', () => {
  const g = guardProposalChange({ before: CARD, after: '   ', proposal: { append: 'x' } });
  assert.equal(g.ok, false);
});

console.log('\n=== 注入预算（最隐蔽的一道）===');
tap('超出注入上限被拦，并说清还剩多少', () => {
  // 预算调到「比改前还小」，任何增加都必然越界。
  const budget = CARD.length - 10;
  const g = edit({ append: '## 新\n- 草' }, {
    injectBudget: budget,
    measureInject: (t) => t.length
  });
  assert.equal(g.ok, false);
  assert.match(g.error, /注入上限|静默/);
  assert.match(g.error, /顶到上限|只剩/, '应告诉它还差多少/还剩多少');
});
tap('接近上限时给提醒而不是拦', () => {
  // 预算按**改后**长度留 4 字符余量：留得比改前小会把正常改动误拦，
  // 这个测试要验的是「能过但快满了」这一档。
  const probe = applyProposalToText(CARD, { section: '怎么说话', after: '- 短一点\n- 说完就停' });
  assert.equal(probe.ok, true, probe.error ?? '');
  const budget = probe.text.length + 4;
  const g = guardProposalChange({
    before: CARD, after: probe.text, proposal: { section: '怎么说话' },
    injectBudget: budget, measureInject: (t) => t.length
  });
  assert.equal(g.ok, true, g.error);
  assert.ok(g.warnings.some((w) => /注入空间只剩/.test(w)), '应提示空间不足');
});
tap('真卡在默认 12000 预算下仍可小幅调整', () => {
  const r = applyProposalToText(realCard, { section: '怎么说话', after: '- 短\n- 直接给判断' });
  assert.equal(r.ok, true, r.error ?? '');
  const g = guardProposalChange({
    before: realCard, after: r.text, proposal: { section: '怎么说话' },
    // 这里故意传一个**比当前生产上限小**的预算（12000，现网是 20000）：
    // 护栏吃的是调用方传入的 injectBudget，跟 bridge 里那个常量无关。
    // 用一个"更紧的预算"来测，既证明它在该预算下放行，也证明它认的是参数而不是读全局，
    // 换个上限不需要回来改这条测试。
    injectBudget: 12000, measureInject: (t) => selectRoleText(t, 'v2').length
  });
  assert.equal(g.ok, true, g.error);
});

console.log('\n=== 报出去的节名必须真的能改（跨模块契约）===');
// 这条是整个功能最脆的一处，而且坏起来完全无声：
//   qq_get_prompt 用 indexSections 生成「你可改的小节」清单 → 模型照着节名提案
//   → applyProposalToText 只认 `##`/`###` → H1 对不上 → 永远「找不到小节」。
// 从模型视角看是「你告诉我它能改，我却怎么都改不动」，它会以为功能坏了然后乱试。
// 两个模块各自单测都是绿的，只有**并起来**才暴露，所以这里直接对真实卡跑一遍闭环。
tap('真实卡的每个「可改节名」都能被 applyProposalToText 找到', () => {
  const content = realCard;
  const advertised = [...indexSections(content).values()].map((s) => ({
    title: s.title.replace(/[\[〔（(]\s*(?:全部|两种|both)\s*[\]〕）)]/gi, '').trim(),
    core: Boolean(coreSectionOf(s.title))
  }));
  assert.ok(advertised.length >= 10, `真实卡小节数异常：${advertised.length}`);
  const broken = [];
  for (const s of advertised) {
    const r = applyProposalToText(content, { section: s.title, after: '临时替换内容' });
    if (!r.ok) broken.push(`${s.title} → ${r.error}`);
  }
  assert.deepEqual(broken, [], `这些节报给了模型却改不动：\n  ${broken.join('\n  ')}`);
});
tap('H1 不当成可改小节', () => {
  // H1 是整卡的标题（身份门牌），既不该报给模型，也不该能被整节替换掉。
  const titles = [...indexSections(realCard).values()].map((s) => s.title);
  assert.ok(!titles.some((t) => /^角色卡[:：]/.test(t)), `H1 不该出现在小节表里：${titles[0]}`);
  assert.equal(indexSections(realCard).values().next().value.level >= 2, true, '小节层级应 >= 2');
});
tap('核心节清单与报给模型的 editableByYou 一致', () => {
  const content = realCard;
  const rows = [...indexSections(content).values()].map((s) => ({
    title: s.title, editable: !coreSectionOf(s.title)
  }));
  // 真实卡里必须**同时**存在两类：全是可改 → 身份无人守；全都不可改 → 自主性等于没有。
  assert.ok(rows.some((r) => r.editable), '应至少有一节她自己能改');
  assert.ok(rows.some((r) => !r.editable), '应至少有一节只有主人能改');
  // 这几个真实存在的核心节必须被认出来。
  for (const needle of ['你是谁', '隐私边界', '谁能指挥你', '说话的硬度']) {
    const row = rows.find((r) => r.title.includes(needle));
    assert.ok(row, `真实卡里应有「${needle}」这一节`);
    assert.equal(row.editable, false, `「${needle}」必须只有主人能改`);
  }
});

console.log('\n=== 快照与统计工具 ===');tap('indexSections 能取到正文', () => {
  const m = indexSections(CARD);
  const sec = [...m.values()].find((s) => /怎么说话/.test(s.title));
  assert.ok(sec.text.includes('句子偏长'));
});
tap('countRecentApplies 忽略过期和非法值', () => {
  const now = Date.now();
  const n = countRecentApplies([
    new Date(now - 1000).toISOString(),
    new Date(now - 2 * 3600 * 1000).toISOString(),
    'not-a-date',
  ], { now, windowMs: 3600 * 1000 });
  assert.equal(n, 1);
});
tap('countRecentApplies 对非数组安全', () => {
  assert.equal(countRecentApplies(null, { windowMs: 1000 }), 0);
});

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
