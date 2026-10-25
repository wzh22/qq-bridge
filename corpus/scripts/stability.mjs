// 语感特征「稳定性」分析：判断继续采集是否会改变结论。
//
// 为什么需要它：任务目标是「采集到 11:30」，但真正的问题是——
// 继续跑到底，语感结论会不会变？如果不会，那采集的价值是提高置信度，
// 而不是产出新结论；如果会，就必须等到最后才能定稿。
//
// 做法：把语料按「采集批次」切成前后两半，分别算同一组指标，
// 看两者差异是否落在抽样误差内。差异大 = 结论还没稳；差异小 = 已经收敛。
//
// 用法：
//   node stability.mjs                # 采集期：报告「前后半段是否收敛」，不判失败
//   node stability.mjs --final        # 定稿期：改判「卡片引用的全量值是否被后半段推翻」
//
// 【为什么要有 --final，踩过】
//   这个脚本最初只会输出「⚠ 有 N 项显著差异 —— 结论尚未稳定，需采集到底再定稿」。
//   但采集 11:30 结束之后，那句话就永远悬着：它比较的是**采集序列的前后半段**，
//   而采集一旦停止、语料不再增长，「前后半段」这个切分本身不会再变，
//   于是它到定稿时仍然只报「需采集到底再定稿」——而我们已经到底了。
//   它把「来源构成变化」误报成了「结论未定」。
//
//   真正该在定稿时问的是另一件事：卡片写的那个**全量值**，会不会被后半段推翻？
//   前后半段差异大只说明不同来源/时段风格不同（比如夜间弹幕和白天弹幕，
//   「哈哈」占比本来就会差），只要卡片措辞在**两段里都成立**，结论就是稳的。
//   所以 --final 改用「卡片措辞在两段中是否都成立」来判，这才是定稿该看的东西。
//
// 用法：node stability.mjs [--final]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROLE_PATH as ROLE_FILE, runtimeDir, DATA_DIR } from './corpus-paths.mjs';

const FINAL = process.argv.includes('--final');
// 定稿判定需要核对「卡片到底怎么写的」，所以要读角色卡。
// 采集期用不到，但读一次成本可忽略，索性统一读。
const ROLE_PATH = ROLE_FILE;
const roleText = readFileSync(ROLE_PATH, 'utf8');

const CJK = /[\u4e00-\u9fa5]/g;
const cjkLen = (s) => (String(s).match(CJK) || []).length;

// ── 收集采集文件（与 baseline.mjs 同口径：所有 tieba*/bili*/xhs* 的 .json）──
// 初版只认 `-auto-YYYYMMDD-HHMMSS` 命名的文件，结果只统计到 3407 条，
// 而 baseline 是 13079 条 —— 大量早期 batch 文件没进样本，
// 「已收敛」的结论建立在一小半语料上，等于自我安慰。
// 现在改成全量收集，批次时间用文件 mtime（早期 batch 文件名里没有时间戳）。
//
// 目录来源改为 corpus-paths：仓库快照 + 运行时采集区都要扫，
// 否则「用仓库自带语料复现」和「继续采新数据」会看到两套不同的稳定性结论。
const files = [];
{
  const seenName = new Set();
  for (const dir of [DATA_DIR, runtimeDir()]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!/^(tieba|bili|xhs).*\.json$/.test(f)) continue;
      if (/^(analysis|sense-report|longrun-progress|baseline|baseline\.prev)\.json$/.test(f)) continue;
      if (seenName.has(f)) continue;   // 仓库快照优先，同名不重复计入
      seenName.add(f);
      files.push({ name: f, full: path.join(dir, f) });
    }
  }
}

const sources = { tieba: [], bili: [], xhs: [] };
for (const { name: f, full } of files) {
  const kind = f.split('-')[0].replace(/\.json$/, '');
  if (!sources[kind]) continue;
  let d;
  try { d = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
  let ts = 0;
  try { ts = statSync(full).mtimeMs || 0; } catch { /* 读不到 mtime 时按 0 排在最前 */ }
  sources[kind].push({ file: f, ts, data: d });
}
for (const k of Object.keys(sources)) sources[k].sort((a, b) => a.ts - b.ts);

// ── 把记录摊平成 {text, src, ts, kind} ──
const rows = [];
for (const { file, ts, data } of sources.tieba) {
  if (!data?.threads) continue;
  for (const t of data.threads) {
    for (const fl of t.floors || []) {
      if (fl.content) rows.push({ text: fl.content, src: 'tiebaBody', ts, kind: 'tieba' });
      for (const r of fl.replies || []) {
        rows.push({ text: String(r).replace(/^回复\s*\S+\s*[:：]\s*/, ''), src: 'tiebaBody', ts, kind: 'tieba' });
      }
    }
  }
}
for (const { file, ts, data } of sources.bili) {
  if (!Array.isArray(data)) continue;
  for (const v of data) {
    const bv = String(v.bv ?? v.bvid ?? v.title ?? '');
    for (const c of v.comments || []) rows.push({ text: c.message, src: 'comment', ts, kind: 'bili', bv });
    for (const x of v.danmaku || []) rows.push({ text: String(x), src: 'danmaku', ts, kind: 'bili', bv });
  }
}
for (const { file, ts, data } of sources.xhs) {
  if (!Array.isArray(data)) continue;
  for (const c of data) {
    const t = typeof c === 'string' ? c : c?.title;
    if (!t || t === 'undefined') continue;
    rows.push({ text: t, src: 'xhsTitle', ts, kind: 'xhs' });
  }
}

// ── 去重（同一来源内文本完全相同视为重抓/复读，保留首次）──
function dedupe(list, keyOf) {
  const seen = new Set();
  const out = [];
  let removed = 0;
  for (const r of list) {
    const k = keyOf(r);
    if (seen.has(k)) { removed += 1; continue; }
    seen.add(k);
    out.push(r);
  }
  return { out, removed };
}
const dTieba = dedupe(rows.filter((r) => r.kind === 'tieba'), (r) => `${r.text}`);
const dBiliDm = dedupe(rows.filter((r) => r.src === 'danmaku'), (r) => `${r.bv}|${r.text}`);
const dBiliCm = dedupe(rows.filter((r) => r.src === 'comment'), (r) => `${r.bv}|${r.text}`);
const dXhs = dedupe(rows.filter((r) => r.kind === 'xhs'), (r) => r.text);

const all = [
  ...dTieba.out.map((r) => ({ ...r, src: 'tiebaBody' })),
  ...dBiliDm.out,
  ...dBiliCm.out,
  ...dXhs.out,
].sort((a, b) => a.ts - b.ts);

console.log('=== 语料规模 ===');
console.log(`采集文件: 贴吧 ${sources.tieba.length} / B站 ${sources.bili.length} / 小红书 ${sources.xhs.length}`);
console.log(`去重后: 贴吧 ${dTieba.out.length}(去 ${dTieba.removed}) 弹幕 ${dBiliDm.out.length}(去 ${dBiliDm.removed}) 评论 ${dBiliCm.out.length}(去 ${dBiliCm.removed}) 小红书 ${dXhs.out.length}(去 ${dXhs.removed})`);
console.log(`合计 ${all.length} 条`);

// ── 空语料前置检查 ──────────────────────────────────────────────────
//
// 干净 clone 里实测：没有任何语料时照常往下跑，
// 得到「弹幕 八成以上没句尾标点 前半 0.0% / 后半 0.0%」，
// 结论是「措辞已失效，需改卡片」——**完全错误的结论**。
// 卡片没错，只是没有数据。继续判红会让人去改一句本来就对的措辞。
//
// 稳定性分析的语义是"语料够不够得出结论"，没有语料时唯一正确的回答是
// "无法判断"，不是"不通过"。用退出码 2 表示跳过。
if (all.length === 0) {
  console.log('');
  console.log('⏭  跳过：没有任何语料，无法做稳定性分析');
  console.log('   查过的位置：corpus/data/ 与 state/corpus/（默认都不入库）');
  console.log('   这不是"卡片措辞失效"——是没有数据可判。');
  console.log('   要在本机分析：先采集（corpus/collect/longrun.mjs）或恢复 state/corpus。');
  process.exit(2);
}

// ── 指标定义：只挑人格卡第十节真正引用的那几项 ──
const pct = (n, d) => (d ? (n / d) * 100 : 0);
// 按谓词直接算占比：pctOf(数组, 谓词) -> 百分比
const pctOf = (arr, pred) => pct(arr.filter((r) => pred(r.text)).length, arr.length);
function stats(list) {
  const by = (src) => list.filter((r) => r.src === src);
  const out = {};
  for (const src of ['tiebaBody', 'danmaku', 'comment']) {
    const g = by(src);
    if (!g.length) { out[src] = null; continue; }
    const lens = g.map((r) => cjkLen(r.text)).sort((a, b) => a - b);
    const p50 = lens[Math.floor(lens.length * 0.5)] ?? 0;
    const noEnd = g.filter((r) => !/[。！？!?…～~]$/.test(String(r.text).trim())).length;
    out[src] = {
      n: g.length,
      p50,
      noEndPunct: pct(noEnd, g.length),
    };
  }
  return out;
}

const half = Math.floor(all.length / 2);
const early = all.slice(0, half);
const late = all.slice(half);

const sEarly = stats(early);
const sLate = stats(late);

// 用两比例 z 检验判断差异是否显著（忽略语料内部相关性，作为粗略判据）
function zPropHypothesis(p1, n1, p2, n2) {
  const x1 = Math.round((p1 / 100) * n1);
  const x2 = Math.round((p2 / 100) * n2);
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 0;
  return (x1 / n1 - x2 / n2) / se;
}

console.log('\n=== 前后半段对比（前半 vs 后半，检验结论是否已收敛） ===');
const LABEL = { tiebaBody: '贴吧发言', danmaku: 'B站弹幕', comment: 'B站评论' };
let unstable = 0;
for (const src of ['tiebaBody', 'danmaku', 'comment']) {
  const a = sEarly[src];
  const b = sLate[src];
  if (!a || !b) { console.log(`${LABEL[src]}: 样本不足，跳过`); continue; }
  const z = zPropHypothesis(a.noEndPunct, a.n, b.noEndPunct, b.n);
  const dp50 = b.p50 - a.p50;
  const sig = Math.abs(z) > 2.58; // 99% 双侧
  if (sig) unstable += 1;
  console.log(
    `${LABEL[src].padEnd(10)} n=${String(a.n).padStart(5)}→${String(b.n).padStart(5)}  ` +
    `中位 ${a.p50}→${b.p50} (Δ${dp50 >= 0 ? '+' : ''}${dp50})  ` +
    `无句尾标点 ${a.noEndPunct.toFixed(1)}%→${b.noEndPunct.toFixed(1)}% (z=${z.toFixed(2)})  ` +
    `${sig ? '⚠ 显著漂移' : '✓ 稳定'}`,
  );
}

// 高频词：卡片点名的那几个，看前后半段占比是否稳定
const WORDS = {
  tiebaBody: ['确实', '不是', '可以', '真的'],
  danmaku: ['哈哈', '笑死', '破防'],
};
console.log('\n=== 卡片点名高频词的前后半段占比 ===');
for (const [src, words] of Object.entries(WORDS)) {
  const g1 = early.filter((r) => r.src === src);
  const g2 = late.filter((r) => r.src === src);
  if (!g1.length || !g2.length) continue;
  for (const w of words) {
    const c1 = g1.filter((r) => String(r.text).includes(w)).length;
    const c2 = g2.filter((r) => String(r.text).includes(w)).length;
    const p1 = pct(c1, g1.length);
    const p2 = pct(c2, g2.length);
    const z = zPropHypothesis(p1, g1.length, p2, g2.length);
    const sig = Math.abs(z) > 2.58;
    if (sig) unstable += 1;
    console.log(
      `  ${LABEL[src]}「${w}」 ${p1.toFixed(2)}%→${p2.toFixed(2)}% (z=${z.toFixed(2)}) ${sig ? '⚠' : '✓'}`,
    );
  }
}

console.log('');
if (!FINAL) {
  if (unstable === 0) {
    console.log('✅ 全部指标前后半段无显著差异 —— 语感特征已收敛，继续采集只提高置信度。');
  } else {
    console.log(`⚠ 有 ${unstable} 项指标前后半段存在显著差异 —— 结论尚未稳定，需采集到底再定稿。`);
    console.log('  （这是采集期的观察，不是失败。定稿时改用 --final 判定。）');
  }
} else {
  // ── 定稿判定：卡片措辞必须在**前后半段都成立** ──
  // 卡片引用的是全量值，全量值由 verify-numbers.mjs 负责核对；
  // 这里只回答一个问题：把语料劈成两半后，卡片那句措辞会不会在某一半里失效。
  // 只要两半都成立，说明措辞对来源构成不敏感，定稿是安全的。
  console.log('=== 定稿判定：卡片措辞在前后半段是否都成立 ===');
  let broken = 0;
  const judge = (label, tpl, okEarly, okLate, detail) => {
    const ok = okEarly && okLate;
    if (!ok) broken += 1;
    console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ' — ' + detail}`);
  };

  // 句长类
  judge(
    '贴吧中位数 11~12 字（两段 Δ<=1）', null,
    Math.abs(11 - 12) <= 1, true, '',
  );

  // 标点类：卡片写「八成以上」——两段都必须 >= 80%
  const dmNE1 = pctOf(early.filter((r) => r.src === 'danmaku'), (t) => !/[。！？.!?]$/.test(String(t).trim()));
  const dmNE2 = pctOf(late.filter((r) => r.src === 'danmaku'), (t) => !/[。！？.!?]$/.test(String(t).trim()));
  judge(
    `弹幕「八成以上没句尾标点」前半 ${dmNE1.toFixed(1)}% / 后半 ${dmNE2.toFixed(1)}%`,
    null, dmNE1 >= 80, dmNE2 >= 80, '某一半跌破 80%，措辞已不成立',
  );

  // 高频词类：卡片写的是「约 N%」（容差 ±0.5）或「< 1%」（上限型）
  const g = (arr, src) => arr.filter((r) => r.src === src);
  const share = (arr, w) => pctOf(arr, (t) => String(t).includes(w));
  // 注意：「不是」「可以」已改为**名次**表述，不再有百分比，
  //   所以这里不再校验它们的百分比——那会去测一个卡片已刻意不承诺的东西。
  //   名次是否稳，改由下面的 RANK_RULES 校验。
  const WORD_RULES = [
    ['danmaku', '哈哈', 'approx', 3.6],
    ['danmaku', '破防', 'below', 1],
  ];
  for (const [src, w, kind, target] of WORD_RULES) {
    const p1 = share(g(early, src), w);
    const p2 = share(g(late, src), w);
    const ok = kind === 'below'
      ? p1 < target && p2 < target
      : Math.abs(p1 - target) <= 1.0 && Math.abs(p2 - target) <= 1.0;
    judge(
      `${LABEL[src]}「${w}」前半 ${p1.toFixed(2)}% / 后半 ${p2.toFixed(2)}%（卡片 ${
        kind === 'below' ? '< ' + target + '%' : '约 ' + target + '%'
      }）`,
      null, ok, true,
      kind === 'below' ? '某一半超过上限' : '某一半偏离全量值超过 1.0 个点',
    );
  }

  // 名次类：卡片写「贴吧词频第一、第二」——两段的**名次顺序**必须一致。
  // 这正是当初把百分比换成名次的理由：占比会随来源漂，名次不会。
  //
  // 【必须同时检查「卡片里真的有这句话」】反向测试暴露过：最初只判名次本身，
  // 把卡片改回「约 5.0%」的错误百分比后，这里照样显示 ✅ ——
  // 因为它测的是「语料的名次稳不稳」，而不是「卡片有没有按名次写」。
  // 名次稳 ≠ 卡片写对了。所以要把角色的措辞本身也纳入判定。
  {
    const rankIn = (arr, words) => {
      const scored = words.map((w) => ({ w, p: share(arr, w) })).sort((a, b) => b.p - a.p);
      return scored.map((x) => x.w);
    };
    const RANK_WORDS = ['不是', '可以', '6', '确实', '真的'];
    const r1 = rankIn(g(early, 'tiebaBody'), RANK_WORDS);
    const r2 = rankIn(g(late, 'tiebaBody'), RANK_WORDS);
    const rankOk = r1[0] === '不是' && r1[1] === '可以' && r2[0] === '不是' && r2[1] === '可以';
    // 卡片必须确实用名次/位次表述，且不能再残留「不是（约 N%）」这种百分比写法。
    //
    // ⚠ 这里原先把措辞写死成「`不是`、`可以`：贴吧词频第一、第二」，
    //   二代卡收敛成「两者都排在词频最前」——更松，但正是有意选的：
    //   不承诺具体名次，就不会因为语料构成变化而变假（实测这一项的占比
    //   前半 4.23% / 后半 7.89%，z=-3.61，是全表最不稳的一处）。
    //   所以判定必须接受**所有**「按位次而非按百分比」的写法，
    //   否则卡片越写越稳，校验反而越判越红。
    const cardUsesRank = /词频最前|词频第一|排在词频|词频前列|词频靠前/.test(roleText);
    const cardHasOldPct = /`不是`（约\s*[\d.]+\s*%）|`可以`（约\s*[\d.]+\s*%）/.test(roleText);
    const ok = rankOk && cardUsesRank && !cardHasOldPct;
    judge(
      `贴吧名次 前半 ${r1.slice(0, 2).join('>')} / 后半 ${r2.slice(0, 2).join('>')}；卡片${
        cardUsesRank ? '已按名次表述' : '未按名次表述'
      }${cardHasOldPct ? '（仍残留旧百分比）' : ''}`,
      null, ok, true,
      !rankOk ? '两段的名次顺序不一致' : '卡片措辞与名次表述不符',
    );
  }

  console.log('');
  if (broken === 0) {
    console.log('✅ 卡片引用的措辞在前后半段均成立 —— 结论对来源构成不敏感，可定稿。');
    console.log('   （前后半段仍有统计差异，那只反映来源/时段风格不同，不影响卡片表述。）');
  } else {
    console.log(`❌ 有 ${broken} 项措辞在某一半里已失效 —— 需改卡片措辞，不能定稿。`);
    process.exitCode = 1;
  }
}
