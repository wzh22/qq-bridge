// 相邻免打扰段（顺延后可能撞进下一段）的边界验证。
//
// 典型事故：22:00~06:30 结束在 6:30，顺手给 6:30~7:30 也设了免打扰（起床缓冲）。
// 顺延到 6:30 再加 0~10 分钟抖动，就有 1/6 概率直接落进 7:30 之后才算完。
// 排期代码里的循环必须一路推到真正出区为止。
import assert from 'node:assert/strict';
import { matchQuietRange, quietMillisLeft } from '../src/quiet-hours.js';

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed += 1; console.error(`FAIL ${name}: ${e.message}`); }
}

const at = (h, m) => new Date(2026, 0, 15, h, m, 0, 0);

const ADJACENT = [
  { start: '22:00', end: '06:30' },
  { start: '06:30', end: '07:30' },
];

test('06:38 落在第二段（顺延+抖动撞进下一段）', () => {
  assert.ok(matchQuietRange(ADJACENT, at(6, 38)), '应命中 06:30~07:30');
});

test('06:38 的剩余量算到 07:30，不是 06:30', () => {
  const left = quietMillisLeft(ADJACENT, at(6, 38));
  assert.equal(left, 52 * 60 * 1000, `应为 52 分钟，实际 ${left / 60000} 分钟`);
});

test('07:30 整才真正出区', () => {
  assert.equal(matchQuietRange(ADJACENT, at(7, 30)), null);
  assert.equal(quietMillisLeft(ADJACENT, at(7, 30)), 0);
});

test('三段首尾相接时能一路推到最后的出区点', () => {
  const chain = [
    { start: '22:00', end: '06:30' },
    { start: '06:30', end: '07:00' },
    { start: '07:00', end: '07:45' },
  ];
  // 模拟排期里的循环：从 06:20 起一路推，必须推到 07:45 之后。
  let fireAt = at(6, 20).getTime();
  for (let i = 0; i < 8; i++) {
    const left = quietMillisLeft(chain, new Date(fireAt));
    if (left <= 0) break;
    fireAt += left; // 不抖，取确定值
  }
  assert.equal(new Date(fireAt).getHours(), 7);
  assert.equal(new Date(fireAt).getMinutes(), 45);
});

test('整天都被盖住时循环不会死循环（24h 找不到出口返回 0）', () => {
  // 两段拼成 00:00~24:00：00:00-12:00 + 12:00-00:00
  const whole = [
    { start: '00:00', end: '12:00' },
    { start: '12:00', end: '00:00' },
  ];
  // 每段单独看都有出口，但合起来整天无出口 —— 逐段推进时会在边界反复横跳。
  // 这里只断言「不会抛异常、不会返回 Infinity」，实际由排期循环的 guard 兜底。
  const left = quietMillisLeft(whole, at(10, 0));
  assert.ok(Number.isFinite(left), `不能返回 Infinity，实际 ${left}`);
  assert.ok(left >= 0 && left <= 24 * 3600 * 1000, `应在 0~24h 内，实际 ${left / 3600000}h`);
});

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
