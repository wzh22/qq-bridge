// 诊断：B站语料的来源构成随时间如何变化。
// 目的：判断 stability.mjs 里观察到的「弹幕/评论无句尾标点占比显著漂移」，
// 到底是语感本身在变，还是「采集来源结构变了」（早期只有少量视频、后期抽到大批新视频）。
import { readFileSync, readdirSync, statSync } from 'node:fs';

import { runtimeDir } from '../scripts/corpus-paths.mjs';
const D = runtimeDir();
const files = readdirSync(D)
  .filter((f) => /^bili.*\.json$/.test(f))
  .filter((f) => !/^baseline/.test(f))
  .map((f) => ({ f, t: statSync(`${D}\\${f}`).mtimeMs }))
  .sort((a, b) => a.t - b.t);

console.log('=== B站语料构成随时间变化 ===');
console.log('文件'.padEnd(34) + '视频  弹幕  评论  弹幕/视频');
let cumV = 0, cumD = 0, cumC = 0;
const seenBv = new Set();
for (const { f } of files) {
  let d;
  try { d = JSON.parse(readFileSync(`${D}\\${f}`, 'utf8')); } catch { continue; }
  if (!Array.isArray(d)) continue;
  let dm = 0, cm = 0, nv = 0;
  const newBv = [];
  for (const v of d) {
    const bv = String(v.bv ?? v.bvid ?? '');
    if (bv && !seenBv.has(bv)) { seenBv.add(bv); newBv.push(bv); }
    nv += 1;
    dm += (v.danmaku || []).length;
    cm += (v.comments || []).length;
  }
  if (dm + cm === 0) continue;
  cumV += nv; cumD += dm; cumC += cm;
  const ratio = nv ? (dm / nv).toFixed(0) : '-';
  console.log(
    f.padEnd(34) +
    String(nv).padStart(4) +
    String(dm).padStart(6) +
    String(cm).padStart(6) +
    String(ratio).padStart(9) +
    (newBv.length ? `   新增视频 ${newBv.length}` : '   全为已抓视频（重抓/补充）'),
  );
}
console.log('');
console.log(`累计：视频 ${cumV} 次抓取 / 唯一 ${seenBv.size} 个，弹幕 ${cumD}，评论 ${cumC}`);
