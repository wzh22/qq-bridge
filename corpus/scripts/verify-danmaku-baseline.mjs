// 核查：把「弹幕为 0 的历史文件」计入与否，会不会影响弹幕语感结论。
//
// 背景：bili-batch3 ~ batch10（含 bili-dm-1）共 9 个文件的 danmaku 全为空，
// 只有 comments。它们仍然贡献了评论语料，但弹幕贡献为 0。
// 需要确认：baseline 的弹幕指标是否被这批空文件干扰。
// （结论预期：不会——空数组不产生弹幕行，但要用数据证明，不能想当然。）
//
// 价值：这是**独立复算**，刻意不走 baseline.mjs 的代码路径。
// 如果两个实现各自算完还是对上，说明口径是真的稳，不是同一处 bug 自我印证。
import { readFileSync } from 'node:fs';
import { corpusFiles, readJson, baselinePath } from './corpus-paths.mjs';

const CJK = /[\u4e00-\u9fa5]/g;
const cjkLen = (s) => (String(s).match(CJK) || []).length;

const files = corpusFiles()
  .filter(({ name }) => /^bili.*\.json$/.test(name))
  .filter(({ name }) => !/^baseline|^bili-seen/.test(name));

const all = [];
let emptyFiles = 0;
const perFile = [];

for (const { name: f, full } of files) {
  const d = readJson(full);
  if (!Array.isArray(d)) continue;
  let dm = 0;
  for (const v of d) {
    const bv = String(v.bv ?? v.bvid ?? v.title ?? '');
    for (const x of v.danmaku || []) {
      all.push({ text: String(x), bv });
      dm += 1;
    }
  }
  if (dm === 0) emptyFiles += 1;
  perFile.push({ f, dm });
}

// 与 baseline 一致的去重：同一视频 + 同一文本 才算重复
function dedupeBy(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
const deduped = dedupeBy(all, (r) => `${r.bv}\u0001${r.text}`);

function stat(list, name) {
  const lens = list.map((r) => cjkLen(r.text)).filter((n) => n > 0).sort((a, b) => a - b);
  if (!lens.length) { console.log(`${name}: 样本为空`); return; }
  const p50 = lens[Math.floor(lens.length * 0.5)];
  const u8 = lens.filter((n) => n <= 8).length / lens.length * 100;
  const u10 = lens.filter((n) => n <= 10).length / lens.length * 100;
  const u15 = lens.filter((n) => n <= 15).length / lens.length * 100;
  const noEnd = list.filter((r) => !/[。！？!?…～~]$/.test(String(r.text).trim())).length / list.length * 100;
  console.log(
    `${name}: n=${list.length} 中位=${p50}字 ≤8字=${u8.toFixed(1)}% ≤10字=${u10.toFixed(1)}% ≤15字=${u15.toFixed(1)}% 无句尾标点=${noEnd.toFixed(1)}%`,
  );
}

console.log(`B站文件 ${files.length} 个，其中弹幕为空 ${emptyFiles} 个`);
console.log(`弹幕原始 ${all.length} 条 → 去重后 ${deduped.length} 条`);
console.log('');
stat(all, '未去重  ');
stat(deduped, '去重后  ');

// 对照 baseline.json 的实际值，确认口径一致
const base = JSON.parse(readFileSync(baselinePath(), 'utf8'));

// ── 前置检查：没语料 / 空基线时把话说清楚 ──────────────────────────
//
// 干净 clone 里跑过一次：无任何弹幕语料 + 一份被清零的 baseline，
// 于是 `base.length.danmaku` 为 null，崩在
// `Cannot read properties of null (reading 'n')`——
// 报错指不到"你没有语料"这个真因，只像脚本有 bug。
//
// 这个脚本的用途是"用独立实现复算，核对 baseline 口径"，
// 没有语料就无法复算；那不是失败，是**没有可核对的对象**。
// 用退出码 2 表示"跳过"（区别于 1 = 真的不一致）。
if (deduped.length === 0) {
  console.log('');
  console.log('⏭  跳过：没有可用的弹幕语料，无法独立复算');
  console.log('   查过的位置：corpus/data/ 与 state/corpus/（默认都不入库）');
  console.log('   这不代表 baseline 有问题，只是本机没有原始数据可供核对。');
  process.exit(2);
}
if (!base || !base.length || !base.length.danmaku) {
  console.log('');
  console.log('❌ baseline.json 缺少弹幕统计（可能是空基线）');
  console.log(`   文件：${baselinePath()}`);
  console.log('   恢复：git checkout -- corpus/out/baseline.json');
  process.exit(1);
}

console.log('');
console.log('=== 与 baseline.json 对照 ===');
const b = base.length.danmaku;
console.log(`baseline: n=${b.n} 中位=${b.p50}字 ≤8字=${b.under8}% ≤10字=${b.under10}% ≤15字=${b.under15}%`);
console.log(`baseline 无句尾标点=${base.style.danmaku.noEndPunct}%`);

const lens = deduped.map((r) => cjkLen(r.text)).filter((n) => n > 0).sort((a, b2) => a - b2);
const p50 = lens[Math.floor(lens.length * 0.5)];
const u8 = lens.filter((n) => n <= 8).length / lens.length * 100;
const u10 = lens.filter((n) => n <= 10).length / lens.length * 100;
const noEnd = deduped.filter((r) => !/[。！？!?…～~]$/.test(String(r.text).trim())).length / deduped.length * 100;

const ok = b.p50 === p50 && Math.abs(b.under8 - u8) < 0.6 && Math.abs(b.under10 - u10) < 0.6 && Math.abs(base.style.danmaku.noEndPunct - noEnd) < 0.6;
console.log('');
if (ok) {
  console.log('✅ 我用独立实现复算出的指标与 baseline 一致 —— 空弹幕文件未污染结论，baseline 可信。');
} else {
  console.log('❌ 复算结果与 baseline 不一致，需要排查统计口径：');
  console.log(`   p50 ${p50} vs ${b.p50}`);
  console.log(`   ≤8 ${u8.toFixed(1)} vs ${b.under8}`);
  console.log(`   ≤10 ${u10.toFixed(1)} vs ${b.under10}`);
  console.log(`   无标点 ${noEnd.toFixed(1)} vs ${base.style.danmaku.noEndPunct}`);
  process.exit(1);
}
