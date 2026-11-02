// inner-life.js 的自测：作息、关系档位、生活推进。
//
// 这个模块的每一个输出都会进唤醒 prompt，直接影响她说得像不像人，所以边界必须钉死：
//   · 一天的每个整点都必须落到某个阶段，不能有空档（空档会让 prompt 缺一段）；
//   · 关系档位必须单调（消息越多档位只升不降），边界值不能穿档；
//   · 生活推进必须可重入（同一天推两次，第二次什么都不发生），且跨多天不丢事件。

import assert from 'node:assert/strict';
import {
  describeSelfState,
  weekdayText,
  relationTier,
  dayKey,
  daysBetween,
  initialLifeState,
  tickLife,
  farmSummary,
  buildInnerLifeLines,
  proactiveFactor,
  __internals
} from '../src/inner-life.js';

let passed = 0;
const ok = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
};

console.log('作息阶段');

ok('24 小时每个整点都能落到某个阶段', () => {
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30, 59]) {
      const s = describeSelfState(new Date(2026, 9, 28, h, m, 0));
      assert.ok(s && s.key && s.label, `${h}:${m} 没有阶段`);
      assert.equal(typeof s.energy, 'number');
      assert.equal(typeof s.proactive, 'number');
      assert.ok(s.voice.length > 0, `${h}:${m} 缺少语气描述`);
    }
  }
});

ok('区间首尾不重叠：每分钟只命中一个阶段', () => {
  for (let m = 0; m < 1440; m++) {
    const d = new Date(2026, 9, 28, 0, m, 0);
    const hits = __internals.DAY_PHASES.filter((p) => {
      const mm = d.getHours() * 60 + d.getMinutes();
      return mm >= p.from && mm < p.to;
    });
    assert.equal(hits.length, 1, `${m} 分钟命中 ${hits.length} 个阶段`);
  }
});

ok('半夜是睡着的，最省电', () => {
  const s = describeSelfState(new Date(2026, 9, 28, 3, 0, 0));
  assert.equal(s.key, 'asleep');
  assert.ok(s.energy <= 0.2);
  assert.ok(s.proactive <= 0.2);
});

ok('晚上精神最好', () => {
  const s = describeSelfState(new Date(2026, 9, 28, 21, 0, 0));
  assert.equal(s.key, 'evening');
  assert.equal(s.energy, 1);
});

ok('午睡档存在且覆盖 12:50~13:50', () => {
  assert.equal(describeSelfState(new Date(2026, 9, 28, 13, 0, 0)).key, 'nap');
  assert.equal(describeSelfState(new Date(2026, 9, 28, 12, 49, 0)).key, 'noon_drowsy');
  assert.equal(describeSelfState(new Date(2026, 9, 28, 13, 50, 0)).key, 'nap_wake');
});

ok('星期几说中文', () => {
  // 2026-10-28 是星期三
  assert.equal(weekdayText(new Date(2026, 9, 28, 12, 0, 0)), '星期三');
  assert.equal(weekdayText(new Date(2026, 9, 25, 12, 0, 0)), '星期日');
});

ok('主动系数随时段变化', () => {
  const night = proactiveFactor(new Date(2026, 9, 28, 3, 0, 0));
  const day = proactiveFactor(new Date(2026, 9, 28, 21, 0, 0));
  assert.ok(day > night);
  assert.ok(night >= 0 && day <= 1);
});

console.log('关系档位');

ok('档位边界：0 条是刚认识，无穷大是无话不说', () => {
  assert.equal(relationTier(0).name, '刚认识');
  assert.equal(relationTier(-5).name, '刚认识');
  assert.equal(relationTier(999999).name, '无话不说');
});

ok('档位单调：消息越多档位只升不降', () => {
  let last = -1;
  for (let n = 0; n <= 6000; n += 7) {
    const t = relationTier(n);
    assert.ok(t.index >= last, `${n} 条时档位回退了`);
    last = t.index;
  }
});

ok('边界值不穿档', () => {
  assert.equal(relationTier(29).name, '刚认识');
  assert.equal(relationTier(30).name, '眼熟');
  assert.equal(relationTier(99).name, '眼熟');
  assert.equal(relationTier(100).name, '聊得来');
  assert.equal(relationTier(1200).name, '好朋友');
  assert.equal(relationTier(5000).name, '无话不说');
});

ok('档位内进度在 0~1 之间', () => {
  for (const n of [0, 1, 15, 29, 30, 100, 2500, 5000, 999999]) {
    const t = relationTier(n);
    assert.ok(t.progress >= 0 && t.progress <= 1, `${n} 条进度 ${t.progress}`);
  }
});

ok('每一档都有语气描述（不能有档位没话说）', () => {
  for (const t of __internals.RELATION_TIERS) {
    assert.ok(t.name && t.stance && t.stance.length > 4, `档位 ${t.name} 缺少描述`);
  }
});

console.log('生活推进');

ok('第一次 tick 会建立初始状态并推进一天', () => {
  const { state, changed } = tickLife(null, new Date(2026, 9, 28, 20, 0, 0));
  assert.ok(changed);
  assert.equal(state.version, 1);
  assert.equal(state.farm.plots.length, 3);
  assert.ok(state.tower.floor >= 1);
});

ok('同一天推进两次，第二次什么都不做', () => {
  const d = new Date(2026, 9, 28, 20, 0, 0);
  const first = tickLife(null, d);
  const second = tickLife(first.state, d);
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first.state);
  assert.equal(second.events.length, 0);
});

ok('跨一天会推进，且作物会熟', () => {
  const d1 = new Date(2026, 9, 28, 20, 0, 0);
  const s1 = tickLife(null, d1);
  // 找一块最慢的地，等到超过它的天数
  const maxDays = Math.max(...s1.state.farm.plots.map((p) => Number(p.days) || 5));
  const d2 = new Date(2026, 9, 28 + maxDays + 1, 20, 0, 0);
  const s2 = tickLife(s1.state, d2);
  assert.ok(s2.changed);
  assert.ok(s2.state.farm.harvested >= 1, '过了生长周期至少该收一次');
});

ok('跨 30 天也不会崩、事件有上限', () => {
  const d1 = new Date(2026, 9, 1, 12, 0, 0);
  const s1 = tickLife(null, d1);
  const s2 = tickLife(s1.state, new Date(2026, 9, 31, 12, 0, 0));
  assert.ok(s2.changed);
  assert.ok(s2.state.recent.length <= 5, `recent 长度 ${s2.state.recent.length}`);
  assert.ok(s2.state.tower.runs >= 1);
  assert.ok(Number.isFinite(s2.state.tower.best));
});

ok('确定性：同样输入两次得到同样结果', () => {
  const d = new Date(2026, 9, 28, 9, 0, 0);
  const a = tickLife(null, d);
  const b = tickLife(null, d);
  assert.deepEqual(a.state, b.state);
});

ok('不修改传入的对象', () => {
  const d = new Date(2026, 9, 28, 9, 0, 0);
  const first = tickLife(null, d);
  const snapshot = JSON.stringify(first.state);
  tickLife(first.state, new Date(2026, 10, 5, 9, 0, 0));
  assert.equal(JSON.stringify(first.state), snapshot, 'tickLife 改动了调用方持有的状态');
});

ok('农场描述能反映成熟与等待', () => {
  const d = new Date(2026, 9, 28, 9, 0, 0);
  const s = tickLife(null, d);
  const text = farmSummary(s.state, new Date(2026, 10, 5, 9, 0, 0));
  assert.ok(text.length > 0);
});

ok('dayKey / daysBetween 正确', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59, 0)), '2026-01-05');
  assert.equal(daysBetween('2026-01-05', '2026-01-08'), 3);
  assert.equal(daysBetween('2026-01-05', '2026-01-05'), 0);
  assert.equal(daysBetween('bad', '2026-01-05'), 0);
});

console.log('prompt 组装');

ok('两段都有内容，且带上时间与关系', () => {
  const now = new Date(2026, 9, 28, 21, 30, 0);
  const { selfLine, relationLine } = buildInnerLifeLines({
    now,
    lifeState: tickLife(null, now).state,
    relationCount: 420,
    key: 'private:1',
    isOwner: true
  });
  assert.ok(selfLine.includes('21:30'));
  assert.ok(selfLine.includes('星期三'));
  assert.ok(selfLine.includes('【你自己的状态】'));
  assert.ok(relationLine.includes('【你们的关系：熟人'));
  assert.ok(relationLine.includes('420'));
});

ok('没有生活状态时也不报错，只是少一段', () => {
  const { selfLine } = buildInnerLifeLines({ now: new Date(2026, 9, 28, 21, 30, 0), lifeState: null });
  assert.ok(selfLine.includes('【你自己的状态】'));
  assert.ok(!selfLine.includes('小农场'));
});

ok('打招呼类会话也生成关系段（群聊）', () => {
  const { relationLine } = buildInnerLifeLines({ now: new Date(), lifeState: null, relationCount: 5, key: 'group:1' });
  assert.ok(relationLine.includes('刚认识'));
});

ok('凌晨不把「今天去海里」算成已经发生（那会儿她还没去）', () => {
  const night = new Date(2026, 9, 28, 3, 0, 0);
  const { selfLine } = buildInnerLifeLines({ now: night, lifeState: tickLife(null, night).state, relationCount: 10 });
  assert.ok(!selfLine.includes('今天去海里'), '凌晨不该说今天去海里游过');
  const evening = new Date(2026, 9, 28, 21, 0, 0);
  const { selfLine: s2 } = buildInnerLifeLines({ now: evening, lifeState: tickLife(null, evening).state, relationCount: 10 });
  assert.ok(!s2.includes('凌晨'), '白天不该出现凌晨的措辞');
});

ok('爬塔翻车回 1 层时不能说成「打到第 1 层（最好成绩 17）」这种自相矛盾的话', () => {
  const now = new Date(2026, 9, 28, 21, 0, 0);
  const base = tickLife(null, now).state;
  const lifeState = { ...base, tower: { floor: 1, best: 17, runs: 5 } };
  const { selfLine } = buildInnerLifeLines({ now, lifeState, relationCount: 10 });
  assert.ok(/重开|翻车/.test(selfLine), `回 1 层时应说明是重开，实际：${selfLine}`);
  // 正常进度仍然直说
  const lifeState2 = { ...base, tower: { floor: 12, best: 17, runs: 5 } };
  const { selfLine: s2 } = buildInnerLifeLines({ now, lifeState: lifeState2, relationCount: 10 });
  assert.ok(s2.includes('第 12 层'), `正常进度应直接写层数，实际：${s2}`);
});

ok('第一天上手就不是「三层地全今天种、爬塔第 1 层」的新手开局', () => {
  // 初始状态如果全从零开始，第一次注入 prompt 就像程序刚初始化，一看就假。
  const now = new Date(2026, 9, 28, 21, 0, 0);
  const s = initialLifeState(now);
  assert.ok(s.tower.floor > 1, `初始层数应大于 1，实际 ${s.tower.floor}`);
  assert.ok(s.tower.best >= s.tower.floor, '最好成绩不能低于当前层');
  const allToday = s.farm.plots.every((p) => p.plantedDay === dayKey(now));
  assert.ok(!allToday, '不该三块地都是今天刚种下的');
});

ok('prompt 里不出现「我保持沉默」这类会导致不说话的死指令', () => {  const { selfLine, relationLine } = buildInnerLifeLines({
    now: new Date(2026, 9, 28, 3, 0, 0),
    lifeState: tickLife(null, new Date(2026, 9, 28, 3, 0, 0)).state,
    relationCount: 10,
    key: 'private:1'
  });
  const all = selfLine + relationLine;
  assert.ok(!all.includes('不要回复'), '不能出现禁止回复的指令');
  assert.ok(!all.includes('必须潜水'));
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : ''}`);
