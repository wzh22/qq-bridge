// 内部独白检测的测试。
// 两条真实泄露文本来自 bridge.log（21:54:54 / 22:22:47），必须全部拦下；
// 下面「正常回复」那批必须全部放行 —— 误杀的代价比漏放更大。
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectNarration, detectNarrationFeatures, MIN_HITS } from '../src/narration-guard.js';

// ── 真实发生过的泄露（原文照抄自 bridge.log）──────────────────────────────
const REAL_LEAKS = [
  '他应了句“好啊”，早点睡这事就算说定了。我没再多说，观察满五分钟就收尾了。',
  '他说“你发一个语音”，我就录了一句发过去，说的是“早点躺吧，别又熬到十二点了”。他没再接话，观察满五分钟就收尾了。',
  // 2026-11-03 07:03 真实泄露：第一版规则漏放了它（只命中 1 项，低于阈值）
  '他这么早又让我发语音，我再发了一条，刚醒，声音还有点发懵。他没回，估计听了就去忙。 不知道这次声音他听着怎么样。'
];

// ── 类似形态的独白（应当也拦下）──────────────────────────────────────────
const SYNTHETIC_LEAKS = [
  '他没再回，我这边也继续待着，观察满五分钟收尾。',
  '我又问了一句，他没应，所以就先这样。',
  '她应了声好，我就没再多说，继续等下一轮。',
  '过了两小时没人说话，我先把话收在这里。',
  '他这两天一直没出现，我这边也继续待着。'
];

// ── 完全正常的回复（必须全部放行）────────────────────────────────────────
const NORMAL = [
  '早点躺吧，别又熬到十二点了',
  '嗯？怎么突然这么问',
  '好啊，那我记下了',
  '哈哈这个我也觉得好玩',
  '他说他要考联考，我哪敢打扰',
  '他咋不理我了',
  '你说的是那个吧',
  '刚才发了张图片挺可爱的',
  '他说过要请我吃饭，别忘了',
  '我等了你好久',
  '她这个人还挺有意思的',
  '你发我一句就行',
  '我看了你说的那个',
  '他说躺一会就起来',
  '行，那你去忙',
  '晚安，早点睡',
  '这个我不太懂，你教教我',
  '联考加油啊',
  // 以下 6 条专门针对第二组特征（第三人称/推测/自我评估）——
  // 它们都含「他」「估计」「声音」这类词，是第二组最容易误杀的形态。
  '他咋不理我了',
  '他估计在忙吧',
  '可能是他手机没电了',
  '你声音听着挺好啊',
  '估计你也累了',
  '这两天他都这样'
];

test('真实泄露文本全部被拦（回归测试）', () => {
  for (const t of REAL_LEAKS) {
    const r = detectNarration(t);
    assert.equal(r.isNarration, true, `应拦截却放行：${t}\n命中=${r.hits.join(',')}`);
    assert.ok(r.score >= 4, `真实泄露命中应 >=4，实际 ${r.score}`);
  }
});

test('同形态的合成独白也被拦', () => {
  for (const t of SYNTHETIC_LEAKS) {
    const r = detectNarration(t);
    assert.equal(r.isNarration, true, `应拦截却放行：${t}\n命中=${r.hits.join(',')}`);
  }
});

test('正常回复一条都不能误杀（误杀代价更大）', () => {
  const killed = [];
  for (const t of NORMAL) {
    const r = detectNarration(t);
    if (r.isNarration) killed.push(`${t}  [命中 ${r.hits.join(',')}]`);
  }
  assert.deepEqual(killed, [], `误杀了 ${killed.length} 条正常回复:\n${killed.join('\n')}`);
});

test('正常回复最高分不超过阈值-1，留有安全余量', () => {
  for (const t of NORMAL) {
    const r = detectNarration(t);
    assert.ok(
      r.score <= MIN_HITS - 1,
      `「${t}」命中 ${r.score} 项，太接近阈值 ${MIN_HITS}（命中: ${r.hits.join(',')}）`
    );
  }
});

test('空输入不判为独白', () => {
  assert.equal(detectNarration('').isNarration, false);
  assert.equal(detectNarration('   ').isNarration, false);
  assert.equal(detectNarration(null).isNarration, false);
});

test('特征可解释：返回具体 id 便于日志排查', () => {
  const hits = detectNarrationFeatures(REAL_LEAKS[0]);
  assert.ok(hits.includes('metaTime'), '应识别出「满五分钟」');
  assert.ok(hits.includes('metaAction') || hits.includes('wrapUp'));
});

test('单一特征不构成独白（阈值生效）', () => {
  // 只带一个「他说」，不该被拦
  const r = detectNarration('他说他要考联考');
  assert.equal(r.isNarration, false);
  assert.equal(r.score, 1);
});

test('minHits 可覆盖（测试与灰度调节用）', () => {
  const t = '他说他要考联考';
  assert.equal(detectNarration(t).isNarration, false);
  assert.equal(detectNarration(t, { minHits: 1 }).isNarration, true);
});
