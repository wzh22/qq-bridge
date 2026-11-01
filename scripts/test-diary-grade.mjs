// 记忆分级（diary-grade）单测。
//
// 守的是一条线：**模型自评的重要度不能直接当权重**。
// 实盘证据是 85 条日记里 3★ 占 60%——模型永远选"一般"。
// 所以这里重点测「标签能不能把寒暄压下去」「硬标签能不能顶上来」。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOOST,
  CAP,
  FLOOR,
  HARD,
  KNOWN_TAGS,
  baseLevel,
  behaviorBoost,
  gradeByTags,
  gradeEntry,
  passCoreAdmission,
  ruleTags,
} from '../src/diary-grade.js';

// ---------------------------------------------------------------------------
// 标签兜底
// ---------------------------------------------------------------------------

test('兜底：否定边界能识别', () => {
  const tags = ruleTags('不许叫我主人');
  assert.ok(tags.includes('boundary'), `应识别为禁区，实际 ${tags}`);
});

test('兜底：约定能识别', () => {
  assert.ok(ruleTags('答应给他发一条QQ空间说说').includes('promise'));
  assert.ok(ruleTags('说好了要一起看').includes('promise'));
  assert.ok(ruleTags('这条我还欠着没发').includes('promise'), '「欠着」是承诺最可靠的表达');
});

test('兜底：断词「说好」不能误判为承诺（真实踩过的坑）', () => {
  // 第一版把「说好」当承诺词，在 88 条真实日记上误判 5/6。
  // 中文里「他说好伤心」「我顺着他的话说好」都会命中。
  const falseHits = [
    '他说好伤心，还想起了《可塑性记忆》',
    '我说以后就多跟他热乎，他说好，还说喜欢我',
    '我顺着他的话说好，他高兴地连说好啊好啊',
    '还纠正我别把没做的事说成我不接，直接说好的或行就行',
    '说他安排了几个朋友加我好友，我们已经聊了好多天',
  ];
  for (const text of falseHits) {
    assert.ok(!ruleTags(text).includes('promise'), `不该判成承诺：${text}`);
  }
});

test('兜底：寒暄能识别', () => {
  assert.ok(ruleTags('晚安').includes('routine'));
  assert.ok(ruleTags('吃了吗').includes('routine'));
});

test('兜底：约定压过寒暄（重要）', () => {
  // 「晚安 说好明天一起看」同时命中两者。如果留着 routine，
  // 这句会被 CAP 压到 2 级，约定就丢了。
  const tags = ruleTags('晚安 说好明天一起看');
  assert.ok(tags.includes('promise'), '约定必须保留');
  assert.ok(!tags.includes('routine'), `寒暄应被约定摘掉，实际 ${tags}`);
});

test('兜底：承诺存在时一次性时效被摘掉', () => {
  const tags = ruleTags('今天答应给你画个头像');
  assert.ok(tags.includes('promise'));
  assert.ok(!tags.includes('transient'), `transient 应被 promise 摘掉，实际 ${tags}`);
});

test('兜底：没有硬标签时寒暄保留（按寒暄处理）', () => {
  const tags = ruleTags('晚安 早点睡');
  assert.ok(tags.includes('routine'));
});

test('兜底：空文本返回空数组', () => {
  assert.deepEqual(ruleTags(''), []);
  assert.deepEqual(ruleTags(null), []);
});

// ---------------------------------------------------------------------------
// 基础档
// ---------------------------------------------------------------------------

test('基础档：合法值原样保留', () => {
  assert.equal(baseLevel(1), 1);
  assert.equal(baseLevel(3), 3);
  assert.equal(baseLevel(5), 5);
});

test('基础档：越界夹住而不是吞成默认值', () => {
  // 这是 congling 踩过的坑：`int(x or 3)` 把 0 变成 3，保护形同虚设
  assert.equal(baseLevel(0), 1, '0 应夹到 1，不能变成 3');
  assert.equal(baseLevel(99), 5);
  assert.equal(baseLevel(-5), 1);
});

test('基础档：缺失或非法回落 3', () => {
  assert.equal(baseLevel(undefined), 3);
  assert.equal(baseLevel(null), 3);
  assert.equal(baseLevel('abc'), 3);
});

// ---------------------------------------------------------------------------
// 分级：CAP 是核心
// ---------------------------------------------------------------------------

test('分级：寒暄被压到 2 级，不管模型给几星', () => {
  // 这是整套机制存在的理由：模型把「晚安」写成 5 星也不能进高优先级
  const r = gradeByTags(5, ['routine']);
  assert.equal(r.level, 2, `寒暄必须封顶 2 级，实际 ${r.level}`);
});

test('分级：一次性时效被压到 1 级', () => {
  const r = gradeByTags(5, ['transient']);
  assert.equal(r.level, 1);
});

test('分级：身份信息被抬到 4 级下限', () => {
  const r = gradeByTags(1, ['identity']);
  assert.ok(r.level >= 4, `身份信息至少 4 级，实际 ${r.level}`);
});

test('分级：偏好被抬到 4 级下限', () => {
  const r = gradeByTags(2, ['preference']);
  assert.ok(r.level >= 4);
});

test('分级：先加后夹，加成不能突破 CAP', () => {
  // promise(+1) 与 routine(封顶2) 同时存在时，结果仍被 routine 压住
  const r = gradeByTags(3, ['promise', 'routine']);
  assert.equal(r.level, 2, `CAP 放最后才能保证不被 BOOST 突破，实际 ${r.level}`);
});

test('分级：CAP 优先于 FLOOR（同时命中时按寒暄算）', () => {
  // 少记一条不重要的事，比把不该忘的事压在寒暄堆里强
  const r = gradeByTags(3, ['identity', 'routine']);
  assert.ok(r.level <= 2, `冲突时应偏向 CAP，实际 ${r.level}`);
});

// ---------------------------------------------------------------------------
// 分级：硬标签
// ---------------------------------------------------------------------------

test('分级：禁区直接定档最高级', () => {
  const r = gradeByTags(5, ['boundary']);
  assert.equal(r.level, HARD.boundary, '禁区压过模型给的一切');
  assert.equal(r.level, 5, '级别越大越重要，禁区必须是最高的');
});

test('分级：里程碑直接顶格', () => {
  const r = gradeByTags(1, ['milestone']);
  assert.equal(r.level, 5);
});

test('分级：禁区与里程碑都给 5，语义方向一致', () => {
  // 不能用低位数值表达「重要」：所有按数值排序的地方都会读反
  assert.equal(HARD.boundary, 5);
  assert.equal(HARD.milestone, 5);
});

test('分级：硬标签在 BOOST 之前生效（不会被再加）', () => {
  const r = gradeByTags(3, ['boundary', 'promise']);
  assert.equal(r.level, HARD.boundary, `硬标签定档后不应再被 BOOST 改动，实际 ${r.level}`);
});

// ---------------------------------------------------------------------------
// 分级：合法性
// ---------------------------------------------------------------------------

test('分级：不认识的标签被丢弃', () => {
  // 模型自创「重要」「关键」等于把自评放回来，必须挡掉
  const r = gradeByTags(3, ['重要', '关键', 'critical']);
  assert.equal(r.level, 3, '无有效标签时保持基础档');
  assert.deepEqual(r.tags, []);
});

test('分级：空标签保持基础档', () => {
  assert.equal(gradeByTags(4, []).level, 4);
  assert.equal(gradeByTags(4, null).level, 4);
});

test('分级：任何输入都落在 1..5', () => {
  for (const lv of [-99, 0, 1, 3, 5, 99, NaN]) {
    for (const tags of [[], ['routine'], ['identity'], ['boundary'], ['milestone'], ['promise', 'emotion']]) {
      const r = gradeByTags(lv, tags);
      assert.ok(r.level >= 1 && r.level <= 5, `级别越界：${lv} + ${tags} => ${r.level}`);
      assert.ok(Number.isInteger(r.level), '级别必须是整数');
    }
  }
});

test('分级：给出可解释的理由', () => {
  const r = gradeByTags(5, ['routine']);
  assert.match(r.why, /封顶/, `理由要说明为什么被压，实际：${r.why}`);
});

// ---------------------------------------------------------------------------
// 行为信号
// ---------------------------------------------------------------------------

test('行为：被反复想起会提级', () => {
  const r = behaviorBoost(2, { recallCount: 5 });
  assert.ok(r.level > 2);
});

test('行为：想起一两次不构成证据', () => {
  const r = behaviorBoost(2, { recallCount: 1 });
  assert.equal(r.level, 2, '次数太少不该提级，否则所有条目收益趋同');
});

test('行为：被纠正过会提级', () => {
  const r = behaviorBoost(2, { corrections: 1 });
  assert.ok(r.level > 2);
});

test('行为：话题复现会提级（最有价值的信号）', () => {
  const r = behaviorBoost(2, { recurrence: 4 });
  assert.ok(r.level > 2);
  assert.match(r.why, /复现/);
});

test('行为：多个信号叠加但不超过 5', () => {
  const r = behaviorBoost(4, { recallCount: 10, corrections: 2, recurrence: 5 });
  assert.equal(r.level, 5, '不能突破上限');
});

test('行为：空信号保持原值', () => {
  assert.equal(behaviorBoost(3, {}).level, 3);
  assert.equal(behaviorBoost(3, null).level, 3);
});

// ---------------------------------------------------------------------------
// 端到端分级
// ---------------------------------------------------------------------------

test('端到端：真实日记条目分级合理', () => {
  // 取自实盘 diary.jsonl 的真实条目
  const cases = [
    { title: '答应发QQ空间', body: '他问我什么时候发，我说答应过的会发。', importance: 2, expectMin: 3 },
    { title: '晚安', body: '跟他说了晚安，他回了个嗯。', importance: 5, expectMax: 2 },
    { title: '说话要带逗号', body: '他说我说话要带逗号，说好的。', importance: 3, expectMin: 3 },
  ];
  for (const c of cases) {
    const r = gradeEntry(c);
    if (c.expectMin !== undefined) {
      assert.ok(r.level >= c.expectMin, `${c.title} 应至少 ${c.expectMin} 级，实际 ${r.level}（${r.why}）`);
    }
    if (c.expectMax !== undefined) {
      assert.ok(r.level <= c.expectMax, `${c.title} 应至多 ${c.expectMax} 级，实际 ${r.level}（${r.why}）`);
    }
  }
});

test('端到端：模型自评 5 星的寒暄，分级后落到 2 级', () => {
  const r = gradeEntry({ title: '闲聊', body: '在吗 吃了吗 哈哈', importance: 5 });
  assert.equal(r.level, 2, `这就是问题的核心：模型给 5 星，实际是寒暄。实际 ${r.level}`);
});

test('端到端：模型自评 1 星的偏好，分级后提到 4 级', () => {
  const r = gradeEntry({ title: '喜好', body: '我最讨厌长篇大论的解释', importance: 1 });
  assert.ok(r.level >= 4, `偏好不该因为模型给低分就被埋没，实际 ${r.level}`);
});

// ---------------------------------------------------------------------------
// 核层准入
// ---------------------------------------------------------------------------

test('准入：寒暄不进核层', () => {
  const r = passCoreAdmission('晚安 早点睡');
  assert.equal(r.pass, false);
});

test('准入：一次性事件不进核层', () => {
  const r = passCoreAdmission('今天路上冻得够呛');
  assert.equal(r.pass, false);
});

test('准入：约定可以进核层', () => {
  const r = passCoreAdmission('答应给他发一条QQ空间说说');
  assert.equal(r.pass, true);
});

test('准入：边界可以进核层', () => {
  const r = passCoreAdmission('不许叫我主人');
  assert.equal(r.pass, true);
});

// ---------------------------------------------------------------------------
// 常量自检
// ---------------------------------------------------------------------------

test('常量：CAP 与 FLOOR 覆盖的标签都在白名单里', () => {
  for (const k of Object.keys(CAP)) assert.ok(KNOWN_TAGS.includes(k), `CAP 的 ${k} 不在白名单`);
  for (const k of Object.keys(FLOOR)) assert.ok(KNOWN_TAGS.includes(k), `FLOOR 的 ${k} 不在白名单`);
  for (const k of Object.keys(BOOST)) assert.ok(KNOWN_TAGS.includes(k), `BOOST 的 ${k} 不在白名单`);
  for (const k of Object.keys(HARD)) assert.ok(KNOWN_TAGS.includes(k), `HARD 的 ${k} 不在白名单`);
});
