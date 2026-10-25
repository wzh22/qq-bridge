// 「主动冒泡免打扰时段」的单元测试。
//
// 覆盖重点（都是真会出事的边界，而不是形式上的覆盖率）：
//   · 22:00 / 06:30 两个端点恰好落在哪一侧（左闭右开）
//   · 跨午夜：23:00 的剩余时间应该是到**次日** 06:30，而不是负的
//   · 午休 12:50~13:50 的进出
//   · 配置脏数据（空串、垃圾、start===end、字符串形式）不能让人失手把免打扰取消
//
import assert from 'node:assert/strict';
import {
  formatClockMinutes,
  matchQuietRange,
  normalizeQuietRanges,
  parseClockMinutes,
  quietMillisLeft,
} from '../src/quiet-hours.js';

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

// 固定成「本地时间」构造，避免测试机时区影响：new Date(2026, 0, 15, 23, 0)
const at = (h, m, s = 0) => new Date(2026, 0, 15, h, m, s, 0);

const RANGES = [
  { start: '22:00', end: '06:30' },
  { start: '12:50', end: '13:50' },
];

test('parseClockMinutes 接受常见写法、拒绝垃圾', () => {
  assert.equal(parseClockMinutes('22:00'), 22 * 60);
  assert.equal(parseClockMinutes('6:30'), 6 * 60 + 30);
  assert.equal(parseClockMinutes('06：30'), 6 * 60 + 30); // 全角冒号
  assert.equal(parseClockMinutes('0630'), 6 * 60 + 30);
  assert.equal(parseClockMinutes(' 8:05 '), 8 * 60 + 5);
  assert.equal(parseClockMinutes(''), null);
  assert.equal(parseClockMinutes('24:00'), null);
  assert.equal(parseClockMinutes('12:60'), null);
  assert.equal(parseClockMinutes('abc'), null);
  assert.equal(parseClockMinutes(undefined), null);
});

test('formatClockMinutes 补零并回绕', () => {
  assert.equal(formatClockMinutes(0), '00:00');
  assert.equal(formatClockMinutes(390), '06:30');
  assert.equal(formatClockMinutes(1320), '22:00');
  assert.equal(formatClockMinutes(1440), '00:00');
});

test('22:00 恰好算在免打扰里（左闭）', () => {
  assert.ok(matchQuietRange(RANGES, at(22, 0)), '22:00 应当命中');
});

test('21:59 不算免打扰', () => {
  assert.equal(matchQuietRange(RANGES, at(21, 59)), null);
});

test('06:30 恰好不算免打扰（右开）', () => {
  assert.equal(matchQuietRange(RANGES, at(6, 30)), null);
  // 但 06:29 还在里面 —— 差一分钟就是两种结果，这正是端点必须测的理由
  assert.ok(matchQuietRange(RANGES, at(6, 29)));
});

test('跨午夜区间在午夜两侧都命中', () => {
  assert.ok(matchQuietRange(RANGES, at(23, 30)), '23:30 应命中');
  assert.ok(matchQuietRange(RANGES, at(0, 30)), '00:30 应命中');
  assert.ok(matchQuietRange(RANGES, at(3, 0)), '03:00 应命中');
});

test('白天正常时段不命中', () => {
  assert.equal(matchQuietRange(RANGES, at(10, 0)), null);
  assert.equal(matchQuietRange(RANGES, at(20, 0)), null);
  assert.equal(matchQuietRange(RANGES, at(15, 0)), null);
});

test('12:50~13:50 午休边界', () => {
  assert.equal(matchQuietRange(RANGES, at(12, 49)), null);
  assert.ok(matchQuietRange(RANGES, at(12, 50)), '12:50 应命中');
  assert.ok(matchQuietRange(RANGES, at(13, 20)), '13:20 应命中');
  assert.equal(matchQuietRange(RANGES, at(13, 50)), null, '13:50 应已放行');
});

test('跨午夜剩余时间算到次日 06:30，不是负值/当天过去时刻', () => {
  // 23:00 -> 次日 06:30 = 7 小时 30 分
  const left = quietMillisLeft(RANGES, at(23, 0));
  assert.equal(left, 7.5 * 3600 * 1000, `23:00 的剩余应为 7.5h，实际 ${left / 3600000}h`);
});

test('凌晨 03:00 剩余 3.5 小时', () => {
  assert.equal(quietMillisLeft(RANGES, at(3, 0)), 3.5 * 3600 * 1000);
});

test('区间外剩余为 0', () => {
  assert.equal(quietMillisLeft(RANGES, at(10, 0)), 0);
  assert.equal(quietMillisLeft(RANGES, at(6, 30)), 0);
});

test('带秒的时刻剩余不会因为对齐整分而少算', () => {
  // 22:59:40 -> 06:30 = 7h30m20s
  const left = quietMillisLeft(RANGES, at(22, 59, 40));
  assert.equal(left, (7 * 3600 + 30 * 60 + 20) * 1000);
});

test('午休剩余时间', () => {
  assert.equal(quietMillisLeft(RANGES, at(13, 0)), 50 * 60 * 1000);
});

test('空配置 / 非数组不拦（fail-open，不能把人卡死）', () => {
  assert.equal(matchQuietRange([], at(23, 0)), null);
  assert.equal(matchQuietRange(null, at(23, 0)), null);
  assert.equal(quietMillisLeft(undefined, at(23, 0)), 0);
});

test('start === end 视为无效，不当作 24 小时静音', () => {
  const r = [{ start: '22:00', end: '22:00' }];
  assert.equal(matchQuietRange(r, at(23, 0)), null, '整点相等不能等于全天静音');
  assert.equal(quietMillisLeft(r, at(23, 0)), 0);
});

test('normalizeQuietRanges 收敛标准数组并规范补零', () => {
  const out = normalizeQuietRanges([{ start: '22:0', end: '6:30' }]);
  // '22:0' 只有一位分钟，解析失败 -> 丢弃；这是有意的严格性，避免 22:0 被误读成 22:00 之外的时刻
  assert.deepEqual(out, []);
  assert.deepEqual(normalizeQuietRanges([{ start: '22:00', end: '06:30' }]), [
    { start: '22:00', end: '06:30' },
  ]);
});

test('normalizeQuietRanges 接受文本与分隔符写法', () => {
  assert.deepEqual(normalizeQuietRanges('22:00-06:30'), [{ start: '22:00', end: '06:30' }]);
  assert.deepEqual(normalizeQuietRanges(['22:00-06:30', '12:50~13:50']), [
    { start: '22:00', end: '06:30' },
    { start: '12:50', end: '13:50' },
  ]);
  assert.deepEqual(normalizeQuietRanges('22:00-06:30\n12:50-13:50'), [
    { start: '22:00', end: '06:30' },
    { start: '12:50', end: '13:50' },
  ]);
  assert.deepEqual(normalizeQuietRanges('22：00至06：30'), [{ start: '22:00', end: '06:30' }]);
});

test('normalizeQuietRanges 丢弃坏条目但保留好条目（配错一格不能全清）', () => {
  const out = normalizeQuietRanges(['垃圾', '22:00-06:30', '25:00-26:00', '13:00-13:00']);
  assert.deepEqual(out, [{ start: '22:00', end: '06:30' }]);
});

test('normalizeQuietRanges 上限 12 条，防配置被塞爆', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    start: `${String(i % 24).padStart(2, '0')}:00`,
    end: `${String((i + 1) % 24).padStart(2, '0')}:30`,
  }));
  assert.equal(normalizeQuietRanges(many).length, 12);
});

test('normalizeQuietRanges 对 null/undefined 返回空数组而不是抛错', () => {
  assert.deepEqual(normalizeQuietRanges(null), []);
  assert.deepEqual(normalizeQuietRanges(undefined), []);
  assert.deepEqual(normalizeQuietRanges(''), []);
});

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
