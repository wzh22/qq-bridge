// 定稿用：把人格卡「语料的实测锚点」一节里会随语料漂移的数字，
// 按 baseline.json 的实测值重写一遍。
//
// 为什么必须自动化：
//   10 个数字散落在 8 行里（规模 + 中位数 + p90 + 高频词百分比
//   + 若干「四成/七成/八成以上/不到一成」这类口语区间）。手工改一遍要 3~5 分钟，
//   而且只要漏一个，verify-numbers 就红，回头再查是哪一项更费时间。
//   更糟的是手改容易把 14966 写成 1496 这种一位之差的错误——数量级看着对，验证也能过。
//
// ── 这一版的根本改动：锚点「缺失」不再是失败 ──────────────────────
//
// 上一版把每个锚点都当成必须存在的：卡片里少一个「在 N 万条去重语料里」，
// 整个脚本就 exit 1 拒绝写入。人格卡按 PERSONA-OPS 手册重写后，
// 总数、逐项规模、`真的` 的百分比都被**有意删掉**了——因为会漂的数字写进提示词，
// 很快就会变成假话，而它们的价值远不如分项比例。
// 结果 sync 判定「锚点未命中」，一次都没写成功，而卡片其实是对的。
//
// 现在的规则：
//   · 锚点在卡片里 → 必须**恰好命中一处**，然后改写（命中 2 处才是真问题）
//   · 锚点不在卡片里 → 记一条「卡片未引用，跳过」，不算失败
//   · 只有在「实测已越界、但卡片还在用旧措辞」时才拒绝写入（那才是必须人工介入的）
//
// 设计原则：**只改能精确对准的锚点**，改完立刻把改了什么逐条打出来供人工复核。
// 不做模糊替换，不碰锚点节以外的任何内容（其它节的措辞是有意为之的）。
//
// 用法：
//   node corpus/scripts/sync-card-numbers.mjs            # 预演，只打印不写文件
//   node corpus/scripts/sync-card-numbers.mjs --write    # 真正写入（先备份）
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { ROLE_PATH, baselinePath, runtimeDir, ensureOut } from './corpus-paths.mjs';
import { spoken, SPOKEN_PATTERN } from './spoken-bands.mjs';

const ROLE = ROLE_PATH;
const BASELINE = baselinePath();
const WRITE = process.argv.includes('--write');

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
let role = readFileSync(ROLE, 'utf8');

// ── 定位锚点节（不写死中文序号）──
function findSection(text) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) && /语料|实测锚点/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

const sec = findSection(role);
if (!sec) {
  console.error('❌ 找不到「语料/实测锚点」小节，拒绝写入（人工检查卡片标题是否被改过）');
  process.exit(1);
}
const lines = role.split('\n');
const before = lines.slice(0, sec.start).join('\n') + (sec.start > 0 ? '\n' : '');
let section = sec.text;
const after = '\n' + lines.slice(sec.end).join('\n');

const tb = base.length.tiebaBody;
const dm = base.length.danmaku;
const cm = base.length.comment;
const tbStyle = base.style.tiebaBody;
const cmStyle = base.style.comment;
const w = (list, word) => list.find((x) => x.word === word)?.pct ?? 0;

// ── 替换清单 ──
// 每个条目：{ desc, re, to, onMissing: 'skip' | 'fail' | 'warn', guard? }
//   onMissing='skip'  —— 卡片没引用这一项，跳过（措辞收敛的结果，不是错误）
//   onMissing='fail'  —— 必须存在，缺失说明卡片结构被破坏
//   guard            —— 额外条件，返回 false 时记为 warn 并跳过
const edits = [];

function sub({ desc, re, to, onMissing = 'skip', guard }) {
  if (guard && !guard()) {
    edits.push({ ok: true, skipped: true, desc, detail: '条件不满足，跳过' });
    return;
  }
  const m = section.match(re);
  if (!m) {
    if (onMissing === 'fail') {
      edits.push({ ok: false, desc, detail: '锚点未命中（这一项应存在但找不到）' });
    } else {
      edits.push({ ok: true, skipped: true, desc, detail: '卡片未引用此项，跳过' });
    }
    return;
  }
  // 唯一性检查：同一个锚点命中多处，说明卡片里这个数字写了两遍，
  // 自动改写会只改第一处、留下第二处——那比不改更危险。
  const hits = section.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  if (hits && hits.length > 1) {
    edits.push({ ok: false, desc, detail: `锚点命中 ${hits.length} 处，不唯一` });
    return;
  }
  const toText = typeof to === 'function' ? to(m) : to;
  edits.push({
    ok: true,
    desc,
    detail: `${m[0].trim()} → ${toText.trim()}`,
    apply: () => { section = section.replace(re, () => toText); },
  });
}

// 1. 中位数（卡片写「中位数约 N 字」；「约」可选，兼容两种写法）
sub({
  desc: '依据：贴吧中位数',
  re: /(贴吧[^\n]{0,12}中位数\s*(?:约\s*)?)\d+(\s*字)/,
  to: (m) => `${m[1]}${tb.p50}${m[2]}`,
  onMissing: 'fail',
});
sub({
  desc: '依据：弹幕中位数',
  re: /(B站弹幕[^\n]{0,12}中位数\s*(?:约\s*)?)\d+(\s*字)/,
  to: (m) => `${m[1]}${dm.p50}${m[2]}`,
  onMissing: 'fail',
});

// 2. 「四成在 8 字以内」/「七成不到 10 字」
//    锚点必须是**口语档位词本身**，不能用 \S 硬吃（会把「字，」卷进来丢标点）。
//    正则覆盖 spoken() 可能返回的每一个说法，否则加了一档就「锚点未命中」。
sub({
  desc: `依据：贴吧≤8字 ${tb.under8}%`,
  re: new RegExp(`(${SPOKEN_PATTERN})(在\\s*8\\s*字以内)`),
  to: (m) => `${spoken(tb.under8)}${m[2]}`,
  onMissing: 'fail',
});
sub({
  desc: `依据：弹幕≤10字 ${dm.under10}%`,
  re: new RegExp(`(${SPOKEN_PATTERN})(不到\\s*10\\s*字)`),
  to: (m) => `${spoken(dm.under10)}${m[2]}`,
  onMissing: 'fail',
});

// 3. p90 长尾（卡片写「约 N 字」）
sub({
  desc: '依据：贴吧 p90',
  re: /(贴吧\s*p90\s*(?:约|是)\s*)\d+(\s*字)/,
  to: (m) => `${m[1]}${tb.p90}${m[2]}`,
  onMissing: 'fail',
});
sub({
  desc: '依据：评论 p90',
  re: /(评论\s*p90\s*(?:约|高达)\s*)\d+(\s*字)/,
  to: (m) => `${m[1]}${cm.p90}${m[2]}`,
  onMissing: 'fail',
});

// 4. 「八成以上的贴吧发言」——两个来源都要够八成才能这么写
//
// ⚠ 这里有个上一版留下的真 bug，靠旧卡片恰好写「八成**的**贴吧发言」掩盖了：
//   旧正则 `(\S{1,4})(以上的贴吧发言…)` 把「八成以上」整个吞进第一组，
//   第二组又从「以上的」开始，拼回去就成了「八成以上以上的贴吧发言」。
//   因为当时卡片写的是「八成」（不含「以上」），拼出来正好对，所以从没暴露。
//   人格卡重写成「**八成以上的贴吧发言**和 B站评论**没有句尾标点**」之后，
//   这个双写立刻显形 —— 而且它是**静默的**：sync 报 ✅，卡片被写坏。
//   改用共享档位正则精确定位区间词，第二组只吃「的贴吧发言…」，不再重复。
sub({
  desc: `依据：无句尾标点 贴吧${tbStyle.noEndPunct}% 评论${cmStyle.noEndPunct}%`,
  re: new RegExp(`(${SPOKEN_PATTERN})(的贴吧发言和\\s*B站评论)`),
  to: (m) => `${Math.min(tbStyle.noEndPunct, cmStyle.noEndPunct) >= 80 ? '八成以上' : spoken(Math.min(tbStyle.noEndPunct, cmStyle.noEndPunct))}${m[2]}`,
  onMissing: 'fail',
});

// 5. 高频词百分比。卡片写「`词`（约 N%）」，只替换括号里的数字。
//    「不是」「可以」不在此列：它们的占比对来源构成高度敏感
//    （stability.mjs --final 实测：贴吧「不是」前半段 4.23%、后半段 7.89%），
//    卡片改按名次表述（「都排在词频最前」），名次稳定而百分比不稳定。
const PCT_ITEMS = [
  { word: '确实', desc: '贴吧·确实', list: 'tiebaBody' },
  { word: '哈哈', desc: '弹幕·哈哈', list: 'danmaku' },
  { word: '真的', desc: '贴吧·真的', list: 'tiebaBody' },
];
for (const it of PCT_ITEMS) {
  sub({
    desc: `高频词 ${it.desc}`,
    // 定位 `词` 之后最近的「（约 N%）」，只吃数字部分
    re: new RegExp('(`' + it.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`[^\\n]{0,40}?（约\\s*)([\\d.]+)(%）)'),
    to: (m) => `${m[1]}${w(base.words[it.list], it.word).toFixed(1)}${m[3]}`,
    onMissing: 'skip', // 卡片可能已不引用该词百分比（有意收敛）
  });
}

// 6. 区间型表述（不到一成 / 不到 3% / 不到 1%）只核对，不改写。
//    这些是「量化上限」，写死成具体数字会失去「至少这么少」的意味。
//    越界说明实测已经翻到区间外，措辞必须人工改——这才是真正要拦住的情况。
const RANGE_CHECKS = [
  ['句号结尾 不到一成', /句号结尾[^\n]{0,6}不到一成/, Math.max(tbStyle.endsWithPeriod, cmStyle.endsWithPeriod) < 10],
  // 「括号 不到 3%」：评论括号率 3.3% 不在该句覆盖范围（卡片只谈贴吧与弹幕）
  ['括号 不到 3%', /括号[^\n]{0,8}不到 3%/, Math.max(tbStyle.hasBracket, base.style.danmaku.hasBracket) < 3],
  ['笑死 不到 1%', /不到 1%/, w(base.words.danmaku, '笑死') < 1],
];
for (const [label, re, inRange] of RANGE_CHECKS) {
  if (!re.test(section)) {
    edits.push({ ok: true, skipped: true, desc: `区间表述「${label}」`, detail: '卡片未引用，跳过' });
  } else if (!inRange) {
    edits.push({ ok: false, desc: `区间表述「${label}」`, detail: '实测已越界，需人工改写措辞' });
  } else {
    edits.push({ ok: true, skipped: true, desc: `区间表述「${label}」`, detail: '实测仍在区间内，无需改动' });
  }
}

console.log(`=== 卡片数字同步 ${WRITE ? '（写入模式）' : '（预演，不写文件）'} ===`);
console.log(`baseline: 贴吧${base.scale.tieba} 弹幕${base.scale.biliDanmaku} 评论${base.scale.biliComment} 小红书${base.scale.xhs} 合计${base.scale.total}`);
console.log(`锚点节: ${lines[sec.start]}`);
console.log('');

const bad = edits.filter((it) => !it.ok);
if (bad.length) {
  console.log('');
  for (const it of edits) {
    if (it.ok) console.log(`  ✅ ${it.desc}\n       ${it.detail}`);
    else console.log(`  ❌ ${it.desc} — ${it.detail}`);
  }
  console.log('');
  console.log(`❌ ${bad.length} 个锚点没对上，未写入任何内容。`);
  console.log('   说明卡片锚点节被改过结构，请人工核对后再跑。');
  process.exit(1);
}

// 【顺序要点，踩过一次】分两阶段执行，不能混在同一个循环里：
//   阶段 A：apply() 改的是锚点节切片 section；
//   阶段 B：**先把 section 拼回 role**，再做任何整篇级改动。
// 如果像最初那样循环里直接改 role，后面 `role = before + section + after`
// 会用旧的 before 把改动整个盖掉——不报错、不提示，只是静默丢改动，
// 而预演根本不写文件，看不出来。
for (const it of edits) if (it.apply) it.apply();
role = before + section + after;

let changed = 0;
for (const it of edits) {
  if (it.skipped) console.log(`  ⏭  ${it.desc} — ${it.detail}`);
  else { console.log(`  ✅ ${it.desc}\n       ${it.detail}`); changed += 1; }
}

if (WRITE) {
  // 备份放 state/ 下的独立目录：那是运行时区，不进版本库。
  // 若该目录不可写（ACL 收紧 / 沙箱只读），退到 corpus/out/backup 并明确告知，
  // 绝不静默跳过备份就写卡片 —— 卡片没有版本兜底时，备份是唯一的回退路径。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const candidates = [
    path.join(runtimeDir(), 'backup'),
    path.join(ensureOut(), 'backup'),
  ];
  let bak = null;
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `小鲸鱼-${stamp}.md`);
      copyFileSync(ROLE, target);
      bak = target;
      break;
    } catch { /* 换下一个候选 */ }
  }
  if (!bak) {
    console.error('\n❌ 无法创建备份，已中止写入（卡片没有版本兜底，不允许无备份覆盖）');
    process.exit(1);
  }
  try {
    writeFileSync(ROLE, role, 'utf8');
  } catch (err) {
    // roles/ 在 DSH 沙箱里带 Low Mandatory Level + NW（不可写）完整性标签。
    // 这是**对角色卡的有意保护**，不是权限配置错误：子进程写不进去，
    // 而宿主自己的文件写入通道可以。所以这里不该抛一坨 EPERM 堆栈，
    // 而要给出「下一步该怎么做」，否则读日志的人只会以为脚本坏了。
    console.error('');
    console.error(`❌ 写入被拒绝：${path.relative(process.cwd(), ROLE)}`);
    console.error(`   原因：${err.code} —— roles/ 目录带 Low 完整性标签且禁止写（DSH 沙箱对角色卡的保护）`);
    console.error(`   已生成的正文在内存里，未落盘；备份已存 ${bak}`);
    console.error('');
    console.error('   下一步（二选一）：');
    console.error('     · 在 DSH 会话里让 Agent 用文件编辑工具改卡片（它走宿主通道，不受沙箱限制）');
    console.error('     · 或在沙箱外（普通终端 / danger-full-access）重跑本命令');
    process.exit(1);
  }
  console.log('');
  console.log(`✅ 已写入 ${path.relative(process.cwd(), ROLE)}（改动 ${changed} 项）`);
  console.log(`   备份：${bak}`);
} else {
  console.log('');
  console.log(`（预演结束，未写文件。预计改动 ${changed} 项；确认无误后加 --write 执行）`);
}
