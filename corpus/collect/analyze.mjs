// 语料统计分析（不调模型，纯本地统计）：把三站语料汇总成可复用的「语感指标」。
// 用法：node analyze.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { runtimeDir } from '../scripts/corpus-paths.mjs';
import { parseRoleSections } from '../../src/role-card.js';

const DIR = runtimeDir();
const files = {
  tieba: ['tieba-batch1.json', 'tieba-batch2.json', 'tieba-batch3.json', 'tieba-batch4.json'],
  bili: ['bili-batch1.json', 'bili-batch2.json', 'bili-batch3.json'],
  xhs: ['xhs-home1.json', 'xhs-home2.json'],
};

// ── 收集 ──
const tiebaLines = [];
for (const f of files.tieba) {
  const p = `${DIR}\\${f}`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const t of d.threads || []) {
    tiebaLines.push({ src: 'tieba', forum: t.forum, kind: 'title', text: t.title });
    for (const fl of t.floors || []) {
      if (fl.content) tiebaLines.push({ src: 'tieba', forum: t.forum, kind: 'floor', text: fl.content });
      for (const r of fl.replies || []) tiebaLines.push({ src: 'tieba', forum: t.forum, kind: 'reply', text: r });
    }
  }
}

const biliComments = [];
const biliDanmaku = [];
for (const f of files.bili) {
  const p = `${DIR}\\${f}`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const v of d) {
    for (const c of v.comments || []) biliComments.push({ src: 'bili', kind: 'comment', text: c.message, like: c.like });
    for (const t of v.danmaku || []) biliDanmaku.push({ src: 'bili', kind: 'danmaku', text: String(t) });
  }
}

const xhsTitles = [];
for (const f of files.xhs) {
  const p = `${DIR}\\${f}`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const c of d) xhsTitles.push({ src: 'xhs', kind: 'title', text: c.title, like: c.like });
}

// ── 统计工具 ──
const CJK = /[\u4e00-\u9fa5]/g;
const cjkLen = (s) => (String(s).match(CJK) || []).length;

function lenStats(list) {
  const lens = list.map((x) => cjkLen(x.text)).filter((n) => n > 0).sort((a, b) => a - b);
  if (!lens.length) return null;
  const q = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
  return {
    n: lens.length,
    mean: +(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1),
    p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), max: lens[lens.length - 1],
    under10: +(lens.filter((n) => n <= 10).length / lens.length * 100).toFixed(1),
    under5: +(lens.filter((n) => n <= 5).length / lens.length * 100).toFixed(1),
  };
}

// 高频词（2~5 字的连续汉字片段，粗略但够看）
function topNgrams(items, n = 2, top = 60, minCount = 4) {
  const freq = new Map();
  for (const it of items) {
    const s = String(it.text || '').replace(/[^\u4e00-\u9fa5]+/g, '#');
    for (const seg of s.split('#')) {
      for (let i = 0; i + n <= seg.length; i += 1) {
        const g = seg.slice(i, i + n);
        freq.set(g, (freq.get(g) || 0) + 1);
      }
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([w, c]) => `${w}(${c})`);
}

// 标点与语气词
function punctuationProfile(items) {
  const all = items.map((x) => String(x.text || '')).join('\n');
  const chars = all.length;
  const count = (re) => (all.match(re) || []).length;
  const per1000 = (n) => +((n / chars) * 1000).toFixed(1);
  return {
    samples: items.length,
    chars,
    noPunctEnd: +(items.filter((x) => !/[。！？!?…~～]$/.test(String(x.text).trim())).length / items.length * 100).toFixed(1),
    questionMark: per1000(count(/[?？]/g)),
    exclaim: per1000(count(/[!！]/g)),
    ellipsis: per1000(count(/…|\.\.\./g)),
    tilde: per1000(count(/[~～]/g)),
    emoji: per1000(count(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu)),
    punctuation: per1000(count(/[，。！？；：、]/g)),
  };
}

// 语气词频率（句尾优先）
const PARTICLES = ['啊', '吧', '呢', '吗', '哦', '噢', '呀', '嘛', '呗', '咯', '捏', '捏捏', '哈', '诶', '欸', '哎', '唉', '草', '确实', '真的', '不是', '好家伙', '离谱'];
function particleProfile(items) {
  const out = {};
  for (const p of PARTICLES) {
    let n = 0;
    for (const it of items) if (String(it.text).includes(p)) n += 1;
    if (n > 0) out[p] = +(n / items.length * 100).toFixed(1);
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

const report = {
  generatedAt: new Date().toISOString(),
  scale: {
    tieba: { lines: tiebaLines.length, chars: tiebaLines.reduce((n, x) => n + cjkLen(x.text), 0) },
    bili: { comments: biliComments.length, danmaku: biliDanmaku.length, chars: [...biliComments, ...biliDanmaku].reduce((n, x) => n + cjkLen(x.text), 0) },
    xhs: { titles: xhsTitles.length, chars: xhsTitles.reduce((n, x) => n + cjkLen(x.text), 0) },
  },
  lengthBy: {
    tiebaFloor: lenStats(tiebaLines.filter((x) => x.kind === 'floor')),
    tiebaTitle: lenStats(tiebaLines.filter((x) => x.kind === 'title')),
    biliComment: lenStats(biliComments),
    biliDanmaku: lenStats(biliDanmaku),
    xhsTitle: lenStats(xhsTitles),
  },
  punctuation: {
    tieba: punctuationProfile(tiebaLines.filter((x) => x.kind !== 'title')),
    biliComment: punctuationProfile(biliComments),
    biliDanmaku: punctuationProfile(biliDanmaku),
  },
  particles: {
    tieba: particleProfile(tiebaLines.filter((x) => x.kind !== 'title')),
    biliComment: particleProfile(biliComments),
    biliDanmaku: particleProfile(biliDanmaku),
  },
  ngrams: {
    tieba2: topNgrams(tiebaLines.filter((x) => x.kind !== 'title'), 2, 70, 6),
    tieba3: topNgrams(tiebaLines.filter((x) => x.kind !== 'title'), 3, 50, 4),
    biliComment2: topNgrams(biliComments, 2, 60, 4),
    danmaku2: topNgrams(biliDanmaku, 2, 60, 8),
    xhsTitle2: topNgrams(xhsTitles, 2, 50, 3),
  },
};

writeFileSync(`${DIR}\\analysis.json`, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
