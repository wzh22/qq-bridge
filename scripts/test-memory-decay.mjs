// 记忆衰减模块（src/memory-decay.js）单元测试。
//
// 只测纯逻辑，不碰网络/DSH/真实 state。
// 重点覆盖几处「一改就静默坏掉」的行为：
//   1. 幂律衰减的半衰期语义（半衰期处必须正好掉一半）
//   2. 活跃日语义：停摆期不衰减（备考几天不聊，回来记忆不能全烂）
//   3. 5 星条目永不折叠（与 capEntries 的既有约定一致）
//   4. 折叠只是不逐条列，**原文不能被删除**
//   5. sidecar 损坏时降级为空状态，不能抛错拖垮桥接
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DECAY_DEFAULTS,
  activeDaysBetween,
  dayKeyOf,
  importanceStrength,
  loadDecayState,
  markActiveDay,
  memoryScore,
  pruneDecayState,
  renderFoldedSummary,
  retention,
  saveDecayState,
  shouldFold,
  touchEntries,
} from '../src/memory-decay.js';

const DAY = 86400000;
const NOW = new Date('2026-10-30T22:00:00+08:00').getTime();

function tmpFile(name = 'decay.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decay-test-'));
  return path.join(dir, name);
}

/** 造一个「从 now 往前数 n 天，每天都活跃」的活跃日集合。 */
function everyDayFor(n, now = NOW) {
  const set = new Set();
  for (let i = 0; i < n; i += 1) set.add(dayKeyOf(now - i * DAY));
  return set;
}

test('幂律衰减在半衰期处正好掉一半', () => {
  const H = 14;
  assert.ok(Math.abs(retention(H, H, 1) - 0.5) < 1e-9, `14 活跃日后应剩 50%，实际 ${retention(H, H, 1)}`);
  assert.ok(Math.abs(retention(0, H, 1) - 1) < 1e-9, '当天权重应为 1');
  assert.ok(Math.abs(retention(H * 2, H, 1) - 1 / 3) < 1e-9, '两个半衰期：幂律下是 1/3（不是指数式的 1/4）');
});

test('幂律尾巴比指数厚：久远的记忆不会掉到零', () => {
  const H = 14;
  const powerLaw = retention(365, H, 1);
  const exponential = Math.pow(0.5, 365 / H);
  assert.ok(powerLaw > exponential, '幂律保持率必须高于同半衰期的指数衰减');
  assert.ok(powerLaw > 0.01, `一年后仍应留有可辨识的权重，实际 ${powerLaw}`);
});

test('活跃日计数：停摆期不产生衰减', () => {
  // 30 自然日跨度，但只有 5 天真的聊过。
  const from = NOW - 30 * DAY;
  const activeDays = new Set([
    dayKeyOf(NOW), dayKeyOf(NOW - 1 * DAY), dayKeyOf(NOW - 2 * DAY),
    dayKeyOf(NOW - 20 * DAY), dayKeyOf(NOW - 29 * DAY),
  ]);
  assert.equal(activeDaysBetween(from, NOW, activeDays), 5, '只数活跃日，不数自然日');

  // 同样 30 天跨度，完全没互动 → 退回自然日兜底（有封顶）
  const none = activeDaysBetween(from, NOW, new Set());
  assert.ok(none >= 1, '完全无记录时退化为自然日');
  assert.ok(none <= DECAY_DEFAULTS.halfLifeDays * 2, '兜底值必须封顶，不能把旧记忆一次衰减到零');
});

test('停摆一周后，记忆强度几乎不掉', () => {
  const entry = { time: NOW - 30 * DAY, importance: 3 };
  // 场景 A：这 30 天每天都活跃
  const busy = memoryScore(entry, null, { now: NOW, activeDays: everyDayFor(30) });
  // 场景 B：这 30 天只有 3 天活跃（备考闭关，偶尔来看一眼）
  const idle = memoryScore(entry, null, {
    now: NOW,
    activeDays: [dayKeyOf(NOW), dayKeyOf(NOW - 15 * DAY), dayKeyOf(NOW - 29 * DAY)],
  });
  assert.ok(idle.score > busy.score, '活跃日少的记忆衰减更慢（闭关不该被当成遗忘）');
  assert.ok(idle.score / busy.score > 2, '差距要足够明显，否则这个设计没有意义');
});

test('重要度映射：3 分中性，5 分最高，1 分最低', () => {
  assert.ok(Math.abs(importanceStrength(3) - 1) < 1e-9);
  assert.ok(importanceStrength(5) > importanceStrength(4));
  assert.ok(importanceStrength(1) < importanceStrength(3));
  assert.equal(importanceStrength(99), importanceStrength(5), '越界要夹住');
  assert.equal(importanceStrength(0), importanceStrength(1), '越界要夹住');
});

test('召回次数提升强度，但是次线性的', () => {
  const entry = { time: NOW - 20 * DAY, importance: 3 };
  const days = everyDayFor(20);
  const cold = memoryScore(entry, { recallCount: 0, lastAccess: 0 }, { now: NOW, activeDays: days });
  const once = memoryScore(entry, { recallCount: 1, lastAccess: NOW - 10 * DAY }, { now: NOW, activeDays: days });
  const many = memoryScore(entry, { recallCount: 10, lastAccess: NOW - 10 * DAY }, { now: NOW, activeDays: days });
  assert.ok(once.score > cold.score, '被想起过应该更强');
  assert.ok(many.score > once.score, '想起更多次应该更强');
  const linear = once.score * 10;
  assert.ok(many.score < linear, '收益必须是次线性的，不能按次数线性放大');
});

test('5 星条目永不折叠', () => {
  const old = NOW - 400 * DAY;
  const entry = { time: old, importance: 5, body: '人生大事' };
  assert.equal(shouldFold(entry, null, { now: NOW, activeDays: everyDayFor(30) }), false);
});

test('近期窗口内的条目不折叠（刚说完的话不能忘）', () => {
  const entry = { time: NOW - 1 * DAY, importance: 1, body: '今天的小事' };
  assert.equal(shouldFold(entry, null, { now: NOW, recentDays: 7, activeDays: everyDayFor(30) }), false);
});

test('久未提及的低重要度条目会折叠，高频提及的不会', () => {
  const opts = { now: NOW, recentDays: 7, activeDays: everyDayFor(60) };
  const oldTrivial = { time: NOW - 60 * DAY, importance: 1, body: '很久以前的一件小事' };
  assert.equal(shouldFold(oldTrivial, null, opts), true, '又旧又不重要，该折叠');

  const oldTouched = { time: NOW - 60 * DAY, importance: 3, body: '常被提起的旧事' };
  const meta = { recallCount: 30, lastAccess: NOW - 1 * DAY };
  assert.equal(shouldFold(oldTouched, meta, opts), false, '被反复想起的事不该折叠');
});

test('折叠摘要给计数和标题，且不泄漏正文', () => {
  const folded = [
    { time: NOW - 100 * DAY, title: '语音被嫌难听', body: '很长的正文内容不该出现在摘要里' },
    { time: NOW - 90 * DAY, title: '分享可爱的图', body: '另一段很长的正文' },
  ];
  const line = renderFoldedSummary(folded);
  assert.ok(line.includes('2 件更早的小事'), `应给出计数，实际：${line}`);
  assert.ok(line.includes('语音被嫌难听'), '应列出标题');
  assert.ok(!line.includes('很长的正文内容'), '摘要不能带正文，否则等于没折叠');
  assert.ok(line.length < 260, '摘要必须是一行，长度受控');
});

test('折叠摘要标题过多时退化成只给计数', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    time: NOW - (100 + i) * DAY,
    title: `第${i}件比较长的小事标题`,
    body: 'x',
  }));
  const line = renderFoldedSummary(many, { summaryTitles: 6, summaryMaxChars: 120 });
  assert.ok(line.includes('40 件'), '计数必须准确');
  assert.ok(line.length <= 120, '超长必须退化，不能突破字符上限');
});

test('空输入返回空串（不产生空摘要行）', () => {
  assert.equal(renderFoldedSummary([]), '');
  assert.equal(renderFoldedSummary(null), '');
  assert.equal(renderFoldedSummary([{ title: '' }]), '');
});

test('sidecar 往返一致', () => {
  const file = tmpFile();
  const state = {
    entries: { a: { recallCount: 3, lastAccess: NOW } },
    activeDays: ['2026-10-30', '2026-10-29'],
  };
  assert.equal(saveDecayState(file, state).ok, true);
  const loaded = loadDecayState(file);
  assert.deepEqual(loaded.entries.a, { recallCount: 3, lastAccess: NOW });
  assert.deepEqual(loaded.activeDays, ['2026-10-30', '2026-10-29']);
});

test('sidecar 损坏/缺失时降级为空状态，绝不抛错', () => {
  assert.deepEqual(loadDecayState(tmpFile('nope.json')).entries, {}, '文件不存在');
  const broken = tmpFile('broken.json');
  fs.writeFileSync(broken, '{ this is not json', 'utf8');
  assert.deepEqual(loadDecayState(broken).entries, {}, 'JSON 损坏');
  const odd = tmpFile('odd.json');
  fs.writeFileSync(odd, 'null', 'utf8');
  assert.deepEqual(loadDecayState(odd).entries, {}, '内容为 null');
});

test('touchEntries 累加召回并刷新时间，且不改动其他条目', () => {
  const before = { entries: { a: { recallCount: 1, lastAccess: NOW - 10 * DAY } }, activeDays: ['2026-10-01'] };
  const after = touchEntries(before, ['a', 'b'], NOW);
  assert.equal(after.entries.a.recallCount, 2);
  assert.equal(after.entries.a.lastAccess, NOW);
  assert.equal(after.entries.b.recallCount, 1, '首次想起应从 0 记到 1');
  assert.deepEqual(before.entries.a.recallCount, 1, '不能原地改传入对象');
  assert.deepEqual(after.activeDays, ['2026-10-01'], 'touch 不该动活跃日');
});

test('pruneDecayState 丢掉已不存在的 id', () => {
  const state = {
    entries: { live: { recallCount: 1, lastAccess: NOW }, dead: { recallCount: 9, lastAccess: NOW } },
    activeDays: ['2026-10-30'],
  };
  const pruned = pruneDecayState(state, ['live']);
  assert.deepEqual(Object.keys(pruned.entries), ['live']);
});

test('markActiveDay 幂等且按保留期截断', () => {
  let state = { entries: {}, activeDays: [] };
  state.activeDays = markActiveDay(state, NOW);
  state.activeDays = markActiveDay(state, NOW);
  assert.equal(state.activeDays.length, 1, '同一天重复记只留一条');

  // 塞 200 天，保留期 120 → 只留最新 120 天
  const many = [];
  for (let i = 0; i < 200; i += 1) many.push(dayKeyOf(NOW - i * DAY));
  const trimmed = markActiveDay({ entries: {}, activeDays: many }, NOW, 120);
  assert.equal(trimmed.length, 120, '必须按保留期截断');
  assert.equal(trimmed[trimmed.length - 1], dayKeyOf(NOW), '保留的是最新的一端');
});
