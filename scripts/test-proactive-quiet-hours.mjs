// 「主动冒泡免打扰时段」的接线测试：跑真正的 bridge.js，而不是只测纯函数。
//
// 为什么必须有这一层：quiet-hours.js 的单测只能证明「判定函数对」，证明不了
// scheduleProactiveCheckV2 **真的调用了它**。真正的故障形态是——函数写得对、但
// 排期那段代码忘了接，于是半夜照样冒泡，而单测全绿。
//
// 做法：把 setTimeout 换成可控的假时钟，看排期时算出的延迟是否被顺延到免打扰之后。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`); }
}

// 可控时间：bridge.js 里大量直接读 Date.now()，这里整体替换成可拨动的假时钟。
function installFakeClock(DateCtor) {
  let now = DateCtor.now();
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  return {
    Date: FakeDate,
    set(ms) { now = ms; },
    advance(ms) { now += ms; },
  };
}

// 把「现在」钉在某一天的 21:50；22:00 起进入免打扰，次日 06:30 结束。
function atLocal(base, h, m) {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

await test('主动检查排在 22:00 免打扰之前时，会被顺延到 06:30 之后', async () => {
  // 21:50 + (30~90 分钟) 必然落在 22:00~06:30 里，所以应当被顺延到次日 6:30 之后。
  const clock = installFakeClock(Date);
  const base = clock.Date.now();
  const t0 = atLocal(base, 21, 50);
  clock.set(t0);

  const h_setTimeouts = [];
  const h = await bridgeHarness({
    globals: {
      Date: clock.Date,
      // 假时钟：记录每次 setTimeout 的延迟，不真正等待。
      setTimeout: (fn, ms) => { h_setTimeouts.push(ms); return { unref() {} }; },
      clearTimeout: () => {},
    },
  });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('private:123');
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true };
    h.scheduleProactiveCheckV2('private:123');
    assert.equal(h_setTimeouts.length, 1, `应当排了 1 个定时器，实际 ${h_setTimeouts.length}`);
    const delay = h_setTimeouts[0];
    // 21:50 -> 次日 06:30 是 8 小时 40 分 = 31200000ms；再加最多 10 分钟随机抖动。
    const minExpected = (8 * 60 + 40) * 60 * 1000;
    const maxExpected = minExpected + 10 * 60 * 1000 + 1000;
    assert.ok(
      delay >= minExpected && delay <= maxExpected,
      `应顺延到次日 06:30 之后（约 ${minExpected}~${maxExpected}ms），实际 ${delay}ms（${(delay / 3600000).toFixed(2)}h）`
    );
  } finally { await h.close(); }
});

await test('白天非免打扰时段：延迟仍在 30~90 分钟区间内，不被误顺延', async () => {
  const clock = installFakeClock(Date);
  const t0 = atLocal(clock.Date.now(), 15, 0); // 15:00，两段免打扰都不沾
  clock.set(t0);
  const delays = [];
  const h = await bridgeHarness({
    globals: {
      Date: clock.Date,
      setTimeout: (fn, ms) => { delays.push(ms); return { unref() {} }; },
      clearTimeout: () => {},
    },
  });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('private:123');
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true };
    h.scheduleProactiveCheckV2('private:123');
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 30 * 60 * 1000, `不应短于 30 分钟，实际 ${delays[0]}ms`);
    assert.ok(delays[0] <= 90 * 60 * 1000, `不应长于 90 分钟（说明被误顺延了），实际 ${delays[0]}ms`);
  } finally { await h.close(); }
});

await test('12:30 排期必然跨进 12:50~13:50 午休时，顺延到 13:50 之后', async () => {
  const clock = installFakeClock(Date);
  const t0 = atLocal(clock.Date.now(), 12, 30);
  clock.set(t0);
  const delays = [];
  const h = await bridgeHarness({
    // 固定 30 分钟间隔：12:30 + 30min = 13:00，必然落在 12:50~13:50 里。
    // 用随机区间的话，抽到 48 分钟就是 13:18 也可能落在区间里、抽到 28 分就落不进，
    // 断言会时绿时红——测试必须把随机性钉死。
    config: { socialV2: { proactive: { checkIntervalMinMs: 30 * 60 * 1000, checkIntervalMaxMs: 30 * 60 * 1000, quietJitterMs: 0 } } },
    globals: {
      Date: clock.Date,
      setTimeout: (fn, ms) => { delays.push(ms); return { unref() {} }; },
      clearTimeout: () => {},
    },
  });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('private:123');
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true };
    h.scheduleProactiveCheckV2('private:123');
    assert.equal(delays.length, 1);
    const delay = delays[0];
    // 12:30 -> 13:50 是 80 分钟。落在午休里的排期应推到 13:50 之后。
    const minExpected = 80 * 60 * 1000;
    assert.ok(delay >= minExpected, `应至少顺延到 13:50（${minExpected}ms），实际 ${delay}ms（${(delay / 60000).toFixed(1)}min）`);
    assert.ok(delay <= minExpected + 60 * 1000, `不该超过 13:51，实际 ${(delay / 60000).toFixed(1)}min`);
  } finally { await h.close(); }
});

await test('免打扰关闭（quietRanges 为空）时不顺延', async () => {
  const clock = installFakeClock(Date);
  const t0 = atLocal(clock.Date.now(), 23, 0); // 深夜，但配置里没有免打扰
  clock.set(t0);
  const delays = [];
  const h = await bridgeHarness({
    config: { socialV2: { proactive: { quietRanges: [], quietJitterMs: 0 } } },
    globals: {
      Date: clock.Date,
      setTimeout: (fn, ms) => { delays.push(ms); return { unref() {} }; },
      clearTimeout: () => {},
    },
  });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('private:123');
    st.wakeConfig = { ...(st.wakeConfig ?? {}), mode: 'diving', infinite: true };
    h.scheduleProactiveCheckV2('private:123');
    assert.ok(delays[0] <= 90 * 60 * 1000, `关掉免打扰后不该顺延，实际 ${delays[0]}ms`);
  } finally { await h.close(); }
});

await test('config.json 只写了 probability 时，默认免打扰时段不会被静默丢掉', async () => {
  // 这是本次真正踩到的坑：外层 `...(file.socialV2 ?? {})` 是浅 spread，
  // config.json 里只要出现 `proactive: { probability: 0.6 }`（控制台保存一次就会写），
  // 默认的 quietRanges 整块消失 —— 不报错、不告警，只是半夜开始冒泡。
  const h = await bridgeHarness({
    config: { socialV2: { proactive: { probability: 0.6 } } },
  });
  try {
    const active = h.cfg.socialV2.proactive;
    assert.equal(active.probability, 0.6, '用户配置的概率要生效');
    assert.ok(Array.isArray(active.quietRanges) && active.quietRanges.length === 2,
      `默认免打扰时段必须还在，实际 ${JSON.stringify(active.quietRanges)}`);
    assert.deepEqual(active.quietRanges.map((r) => `${r.start}-${r.end}`), ['22:00-06:30', '12:50-13:50']);
    assert.ok(active.checkIntervalMinMs > 0, '其它默认值也要有兜底');
  } finally { await h.close(); }
});

await test('显式配 quietRanges: [] 表示「不设免打扰」，不被兜底回默认值', async () => {
  const h = await bridgeHarness({
    config: { socialV2: { proactive: { quietRanges: [] } } },
  });
  try {
    assert.deepEqual(h.cfg.socialV2.proactive.quietRanges, [],
      '用户明确清空就是清空，不能偷偷塞回默认两段');
  } finally { await h.close(); }
});

await test('config.json 里写成文本形式的免打扰，加载时会被规范化成结构化数组', async () => {
  const h = await bridgeHarness({
    config: { socialV2: { proactive: { quietRanges: ['22:00-06:30', '垃圾', '12:50~13:50'] } } },
  });
  try {
    assert.deepEqual(h.cfg.socialV2.proactive.quietRanges, [
      { start: '22:00', end: '06:30' },
      { start: '12:50', end: '13:50' },
    ]);
  } finally { await h.close(); }
});

if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
