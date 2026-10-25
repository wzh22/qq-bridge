// 对全部语料做「语感特征」归纳，输出可直接改人格卡的结构化结果。
// 不调模型：用规则 + 人工可读的抽样来支撑。
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

import { runtimeDir } from '../scripts/corpus-paths.mjs';
const D = runtimeDir();

// ── 读入 ──
const tieba = [];
for (let i = 1; i <= 8; i++) {
  const p = `${D}\\tieba-batch${i}.json`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const t of d.threads || []) {
    tieba.push({ kind: 'title', forum: t.forum, text: t.title });
    for (const f of t.floors || []) {
      if (f.content) tieba.push({ kind: 'floor', forum: t.forum, text: f.content });
      for (const r of f.replies || []) if (r) tieba.push({ kind: 'reply', forum: t.forum, text: r.replace(/^回复\s*\S+\s*[:：]\s*/, '') });
    }
  }
}

const biliComments = [];
let biliVideos = 0;
for (let i = 1; i <= 8; i++) {
  const p = `${D}\\bili-batch${i}.json`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const v of d) {
    biliVideos += 1;
    for (const c of v.comments || []) biliComments.push({ text: c.message, like: c.like || 0 });
  }
}

const xhs = [];
for (let i = 1; i <= 4; i++) {
  const p = `${D}\\xhs-home${i}.json`;
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  for (const c of d) xhs.push(c.title);
}

const CJK = /[\u4e00-\u9fa5]/g;
const cjkLen = (s) => (String(s).match(CJK) || []).length;

function profile(items) {
  const texts = items.map((x) => String(x.text ?? x)).map((s) => s.trim()).filter(Boolean);
  const lens = texts.map(cjkLen).filter((n) => n > 0);
  const sorted = [...lens].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return {
    n: texts.length,
    meanLen: +(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length)).toFixed(1),
    p50: q(0.5), p75: q(0.75), p90: q(0.9),
    under8: +(lens.filter((n) => n <= 8).length / Math.max(1, lens.length) * 100).toFixed(1),
    under15: +(lens.filter((n) => n <= 15).length / Math.max(1, lens.length) * 100).toFixed(1),
    noEndPunct: +(texts.filter((t) => !/[。！？!?…~～]$/.test(t)).length / Math.max(1, texts.length) * 100).toFixed(1),
    hasComma: +(texts.filter((t) => /[，,]/.test(t)).length / Math.max(1, texts.length) * 100).toFixed(1),
    hasEmoji: +(texts.filter((t) => /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(t)).length / Math.max(1, texts.length) * 100).toFixed(1),
    hasBracket: +(texts.filter((t) => /[（(].{1,20}[)）]/.test(t)).length / Math.max(1, texts.length) * 100).toFixed(1),
  };
}

// 词频：2-4 字 n-gram，过滤常见虚词开头
const STOP = new Set(['回复', '就是', '都是', '什么', '这个', '那个', '我们', '你们', '他们', '自己', '一个', '可以', '没有', '不是', '真的', '现在', '已经', '还是', '所以', '但是', '因为', '如果', '觉得', '知道', '时候', '一下', '这样', '那样', '怎么', '为什么', '还有', '而且', '然后', '不过', '其实', '应该', '可能', '需要', '问题', '东西', '地方', '时候']);
function ngrams(items, n, top, min) {
  const freq = new Map();
  for (const it of items) {
    const s = String(it.text ?? it).replace(/[^\u4e00-\u9fa5]+/g, '#');
    for (const seg of s.split('#')) {
      for (let i = 0; i + n <= seg.length; i++) {
        const g = seg.slice(i, i + n);
        if (STOP.has(g)) continue;
        freq.set(g, (freq.get(g) || 0) + 1);
      }
    }
  }
  return [...freq.entries()].filter(([, c]) => c >= min).sort((a, b) => b[1] - a[1]).slice(0, top);
}

const tiebaBody = tieba.filter((x) => x.kind !== 'title');
const out = {
  generatedAt: new Date().toISOString(),
  scale: {
    tiebaLines: tiebaBody.length,
    tiebaChars: tiebaBody.reduce((n, x) => n + cjkLen(x.text), 0),
    biliVideos,
    biliComments: biliComments.length,
    xhsTitles: xhs.length,
  },
  profiles: {
    tiebaBody: profile(tiebaBody),
    tiebaTitle: profile(tieba.filter((x) => x.kind === 'title')),
    biliComment: profile(biliComments),
    xhsTitle: profile(xhs.map((t) => ({ text: t }))),
  },
  words: {
    tieba2: ngrams(tiebaBody, 2, 45, 5),
    tieba3: ngrams(tiebaBody, 3, 30, 4),
    bili2: ngrams(biliComments, 2, 40, 6),
    bili3: ngrams(biliComments, 3, 30, 4),
    xhs2: ngrams(xhs.map((t) => ({ text: t })), 2, 30, 3),
  },
};

writeFileSync(`${D}\\sense-report.json`, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));
