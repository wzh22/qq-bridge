// B站语料采集（只读）：从多个视频抓「评论 + 弹幕」，这是最贴地的中文口语语料。
// 用法：node collect-bili.mjs --bvs "BV1x,BV2x" --out bili-1.json
import { collectVideoMaterial } from '../../src/bilibili.js';
import { runtimeDir } from '../scripts/corpus-paths.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const bvs = String(arg('bvs', '')).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const out = arg('out', 'bili-latest.json');
const DIR = runtimeDir();
const maxComments = Number(arg('comments', '30'));
const segs = Number(arg('segs', '3'));

if (!bvs.length) { console.error('需要 --bvs'); process.exit(1); }

const results = [];
for (const bv of bvs) {
  try {
    process.stdout.write(`采集中 ${bv} … `);
    const m = await collectVideoMaterial(bv, { maxComments, danmakuSegments: segs });
    results.push({
      bv,
      title: m.info.title,
      tname: m.info.tname,
      comments: m.comments,
      danmaku: m.danmaku.map((d) => d.text),
      topTerms: m.topTerms,
    });
    console.log(`《${m.info.title.slice(0, 24)}》 评论${m.comments.length} 弹幕${m.danmaku.length}`);
  } catch (e) {
    console.log(`失败：${e.message}`);
  }
}

mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}\\${out}`, JSON.stringify(results, null, 2), 'utf8');

const allComments = results.reduce((n, r) => n + r.comments.length, 0);
const allDanmaku = results.reduce((n, r) => n + r.danmaku.length, 0);
let chars = 0;
for (const r of results) {
  for (const c of r.comments) chars += c.message.length;
  for (const d of r.danmaku) chars += String(d).length;
}
console.log('---');
console.log(`完成：${results.length} 个视频 / 评论 ${allComments} / 弹幕 ${allDanmaku} / 约 ${chars} 字`);
