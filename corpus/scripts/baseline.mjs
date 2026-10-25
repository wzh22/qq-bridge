// 从全部语料重新生成「语感基线」报告，用于验证人格卡里的数字。
// 只读统计，不调模型。
//
// 路径不再写死：语料读取顺序、输出位置全部由 corpus-paths.mjs 决定。
// 迁移前的版本把 'E:\\dsh\\qq-bridge\\state\\corpus' 写死在文件头，
// 换机器或换盘符就整段失效，而且因为 state/ 被 .gitignore 忽略，
// 这个脚本本身也不在版本库里 —— 工具和语料一起消失。
//
// 用法：
//   node corpus/scripts/baseline.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { corpusFiles, readJson, ensureOut, OUT_DIR } from './corpus-paths.mjs';

const CJK = /[\u4e00-\u9fa5]/g;
const cjkLen = (s) => (String(s).match(CJK) || []).length;

// ── 读全部语料（含 longrun 增量）──
const rows = { tieba: [], danmaku: [], comment: [], xhs: [] };

// 非语料文件必须显式排除，否则会被当语料算进分布：
//   · bili-seen.json —— 去重追踪表，存的是 421 个 BV 号**字符串数组**。
//     它恰好满足下面的 `^bili.*\.json$` 与 Array.isArray 为 true，能走进 bili 分支。
//     当前元素是纯字符串，v.comments/v.danmaku 都取不到，实际贡献 0 条语料，
//     所以**现有数字没错**；但这是「碰巧安全」依赖追踪表是字符串数组 ——
//     哪天改成 [{bv, seenAt}] 这样的对象数组，就会瞬间变成一批空文本语料，
//     不报错、只让分母悄悄变大。用显式排除把隐患锁死。
//   · baseline*.json / _regress_* —— 本脚本自己的产物与回归快照，同样不是语料。
const SKIP = /^(analysis|sense-report|longrun-progress)\.json$|^bili-seen\.json$|^baseline.*\.json$|^_regress_/;

let scanned = 0;
for (const { name: f, full } of corpusFiles()) {
  if (SKIP.test(f)) continue;
  const d = readJson(full);
  if (d === null) continue;
  scanned += 1;

  if (/^tieba.*\.json$/.test(f) && d?.threads) {
    for (const t of d.threads) {
      // tid 用于识别「同一帖被重复抓取」；没有 tid 时退回 url/title
      const threadId = String(t.tid ?? t.id ?? t.url ?? t.title ?? '');
      rows.tieba.push({ text: t.title, kind: 'title', forum: t.forum, thread: threadId, floor: 'title' });
      for (const [fi, fl] of (t.floors || []).entries()) {
        const floorId = String(fl.pid ?? fl.floor ?? fl.author ?? '') + '#' + fi;
        if (fl.content) rows.tieba.push({ text: fl.content, kind: 'floor', forum: t.forum, thread: threadId, floor: floorId });
        for (const [ri, r] of (fl.replies || []).entries()) {
          rows.tieba.push({
            text: String(r).replace(/^回复\s*\S+\s*[:：]\s*/, ''),
            kind: 'reply', forum: t.forum, thread: threadId, floor: floorId + '-r' + ri,
          });
        }
      }
    }
  } else if (/^bili.*\.json$/.test(f) && Array.isArray(d)) {
    for (const v of d) {
      // bv 用于识别「同一视频被重复抓取」；弹幕/评论带上它，
      // 才能做到「剔除重抓但保留不同人的自然重复」
      const src = String(v.bv ?? v.bvid ?? v.title ?? '');
      for (const c of v.comments || []) rows.comment.push({ text: c.message, like: c.like || 0, source: src });
      for (const x of v.danmaku || []) rows.danmaku.push({ text: String(x), source: src });
    }
  } else if (/^xhs.*\.json$/.test(f) && Array.isArray(d)) {
    for (const c of d) {
      // 采集器早期版本会把取不到标题的卡片写成 undefined 字符串，直接跳过，
      // 否则会被当成一条真实标题计入语料（实测 4 条）。
      const t = String(c.title ?? '').trim();
      if (!t || t === 'undefined' || t === 'null') continue;
      rows.xhs.push({ text: t, source: String(c.href ?? c.author ?? '') });
    }
  }
}

// 跨文件去重：按**采集来源**去重，而不是按文本内容。
//
// 必须区分两种"重复"：
//  1. **同一对象被抓了多次** —— 同一帖、同一视频、同一条小红书笔记。这是采集器的重复，
//     不剔除会把同一条样本算很多遍（实测小红书单条笔记出现 9 次、B站同一视频抓了 3 次）。
//  2. **不同人对同一内容的自然重复** —— 一百个观众都发「哈哈」、五十六个人都发「太真实了」。
//     这不是冗余，**这就是真实分布本身**。按文本全局去重会把「太真实了」从 56 条压成 1 条，
//     系统性低估高频词——而高频词恰好是人格卡最核心的依据。第一版就是这么错的，必须修正。
//
// 所以：弹幕/评论按「所属视频 + 文本」去重（同视频重抓时文本相同才算重复），
// 贴吧按「帖子 + 楼层」、小红书按标题（推荐流重复刷到同一笔记）去重。
function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const r of items) {
    const key = keyFn(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
const dedupCounts = {};
for (const k of Object.keys(rows)) {
  const before = rows[k].length;
  if (k === 'danmaku' || k === 'comment') {
    // 同一条视频重复抓取：文本 + 所属视频 相同才算重复
    rows[k] = dedupeBy(rows[k], (r) => `${r.source ?? ''}\u0001${r.text}`);
  } else if (k === 'tieba') {
    // 同帖重抓：楼层唯一标识（作者+内容+帖子）
    rows[k] = dedupeBy(rows[k], (r) => `${r.thread ?? ''}\u0001${r.floor ?? ''}\u0001${r.text}`);
  } else {
    rows[k] = dedupeBy(rows[k], (r) => r.text);
  }
  dedupCounts[k] = before - rows[k].length;
}

// ── 统计 ──
function lengthProfile(items) {
  const lens = items.map((x) => cjkLen(x.text)).filter((n) => n > 0).sort((a, b) => a - b);
  if (!lens.length) return null;
  const q = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
  const pct = (f) => +((lens.filter(f).length / lens.length) * 100).toFixed(1);
  return {
    n: lens.length,
    mean: +(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1),
    p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9),
    under5: pct((n) => n <= 5),
    under8: pct((n) => n <= 8),
    under10: pct((n) => n <= 10),
    under15: pct((n) => n <= 15),
  };
}

function styleProfile(items) {
  const texts = items.map((x) => String(x.text).trim()).filter(Boolean);
  const n = texts.length || 1;
  const pct = (f) => +((texts.filter(f).length / n) * 100).toFixed(1);
  return {
    n: texts.length,
    noEndPunct: pct((t) => !/[。！？!?…~～]$/.test(t)),
    hasComma: pct((t) => /[，,]/.test(t)),
    hasEmoji: pct((t) => /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(t)),
    hasBracket: pct((t) => /[（(].{1,20}[)）]/.test(t)),
    endsWithPeriod: pct((t) => /。$/.test(t)),
  };
}

// 词频：只统计「整行等于 / 以它开头 / 以它结尾」，避免子串误命中
function wordFrequency(items, words) {
  const texts = items.map((x) => String(x.text).trim()).filter(Boolean);
  const n = texts.length || 1;
  const out = [];
  for (const w of words) {
    let exact = 0; let start = 0; let end = 0; let any = 0;
    for (const t of texts) {
      if (t === w) exact += 1;
      if (t.startsWith(w)) start += 1;
      if (t.endsWith(w)) end += 1;
      if (t.includes(w)) any += 1;
    }
    if (any) out.push({ word: w, exact, start, end, any, pct: +((any / n) * 100).toFixed(2) });
  }
  return out.sort((a, b) => b.any - a.any);
}

const WORDS = [
  '哈哈', '哈哈哈', '哈哈哈哈', '笑死', '绷不住', '难绷', '没绷住', '乐', '草', '典',
  '6', '666', '确实', '属于是', '离谱', '抽象', '逆天', '破防', '我哭死', '泪目',
  '麻了', '汗流浃背', '牛', '牛逼', '可以', '懂了', '谢谢', '加油', '真的', '我去',
  '我靠', '卧槽', '好家伙', '无语', '服了', '就这', '啊这', '绝了', '蹲', 'cy',
  '前排', '不是', '哥们', '兄弟', '家人们', '救命', '绷', '笑不活',
  // 营销号词（预期接近 0，用于反向验证）
  '绝绝子', '尊嘟假嘟', '泰裤辣', '显眼包', '栓Q', 'yyds', '安利', '避雷', '种草', '氛围感',
];

const report = {
  generatedAt: new Date().toISOString(),
  // 语料来源快照：记录这次统计到底读了哪些文件，避免「数字变了但不知道是多了哪批语料」。
  // 之前完全没有这个字段，于是卡片的数字和语料之间的对应关系只存在于跑脚本那个人的记忆里。
  sources: { filesScanned: scanned },
  scale: {
    tieba: rows.tieba.length,
    biliDanmaku: rows.danmaku.length,
    biliComment: rows.comment.length,
    xhs: rows.xhs.length,
    total: rows.tieba.length + rows.danmaku.length + rows.comment.length + rows.xhs.length,
  },
  deduped: dedupCounts,
  length: {
    tiebaBody: lengthProfile(rows.tieba.filter((r) => r.kind !== 'title')),
    tiebaTitle: lengthProfile(rows.tieba.filter((r) => r.kind === 'title')),
    danmaku: lengthProfile(rows.danmaku),
    comment: lengthProfile(rows.comment),
    xhsTitle: lengthProfile(rows.xhs),
  },
  style: {
    tiebaBody: styleProfile(rows.tieba.filter((r) => r.kind !== 'title')),
    danmaku: styleProfile(rows.danmaku),
    comment: styleProfile(rows.comment),
    xhsTitle: styleProfile(rows.xhs),
  },
  words: {
    tiebaBody: wordFrequency(rows.tieba.filter((r) => r.kind !== 'title'), WORDS),
    danmaku: wordFrequency(rows.danmaku, WORDS),
    comment: wordFrequency(rows.comment, WORDS),
  },
};

const outFile = path.join(ensureOut(), 'baseline.json');
writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

// ── 终端可读输出 ──
console.log(`语料文件 ${scanned} 个 → 输出 ${path.relative(process.cwd(), outFile)}`);
console.log('=== 规模 ===');
console.log(JSON.stringify(report.scale));
console.log(`去重移除: ${JSON.stringify(dedupCounts)}`);
console.log('\n=== 句长 ===');
for (const [k, v] of Object.entries(report.length)) {
  if (!v) continue;
  console.log(`${k.padEnd(12)} n=${String(v.n).padStart(6)} 中位${String(v.p50).padStart(3)}字  ≤8字${String(v.under8).padStart(5)}%  ≤10字${String(v.under10).padStart(5)}%  ≤15字${String(v.under15).padStart(5)}%`);
}
console.log('\n=== 标点 ===');
for (const [k, v] of Object.entries(report.style)) {
  console.log(`${k.padEnd(12)} 无句尾${String(v.noEndPunct).padStart(5)}%  句号${String(v.endsWithPeriod).padStart(5)}%  括号${String(v.hasBracket).padStart(5)}%`);
}
console.log('\n=== 词频（前 8）===');
for (const [k, v] of Object.entries(report.words)) {
  console.log(`${k.padEnd(12)} ${v.slice(0, 8).map((x) => `${x.word}${x.pct}%`).join(' ')}`);
}
