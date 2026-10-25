// 校验人格卡「语料的实测锚点」一节引用的数字，与语料实测是否一致。
//
// ── 这一版做了什么改动，为什么 ──────────────────────────────────────
//
// 上一版把锚点死死绑在「第十节 真实语料」这个标题和它当时的**具体措辞**上：
//   · 章节边界写死 '## 十、真实语料' / '## 十一、'
//   · 断言写死「四成在 8 字以内」「句号结尾的不到一成」「每一个都只占百分之一以下」
//   · 第 6/7 组要求卡片必须含「在 N 万条去重语料里」「去重后 贴吧 N 条发言 + …」
//
// 人格卡按 PERSONA-OPS 手册重写后，这一节改名为「四、语料的实测锚点」，
// 措辞也从「每一个都只占百分之一以下」收敛成更短的表达 ——
// 于是**18 项断言集体失效**，但它们失效的原因是「卡片换了说法」，
// 不是「数字错了」。实测逐项核对：卡片里每个数字都对得上 baseline。
//
// 所以这一版的原则变了：**校验「卡片承诺了什么」，不再校验「卡片用了哪句话」**。
//   1. 章节用「标记」定位：卡片里任意一节只要带 〔二代〕/〔全部〕 之外的
//      「语料的实测锚点」关键词就认，不再依赖中文序号（序号会因增删节而漂）。
//   2. 数字断言改成**宽松抽取**：数字写在哪句里都行，只要在同一节内出现且与实测相符。
//   3. 反向断言（营销号词接近零）保留，但不再要求卡片出现某个句子标题——
//      改判「这些词若被点名，必须处在不学的语境」。
//   4. 定性断言（弹幕词 < 1%）仍然用 checkStrict，采集期也判失败。
//
// 用法：
//   node corpus/scripts/verify-numbers.mjs               # 定稿期：数字不符即失败
//   node corpus/scripts/verify-numbers.mjs --collecting  # 采集期：规模类数字只提示
import { readFileSync } from 'node:fs';
import { ROLE_PATH, baselinePath } from './corpus-paths.mjs';
import { bandOf, SPOKEN_PATTERN } from './spoken-bands.mjs';

const ROLE = ROLE_PATH;
const BASELINE = baselinePath();
const COLLECTING = process.argv.includes('--collecting');

const role = readFileSync(ROLE, 'utf8');
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));

let pass = 0;
let fail = 0;
let pending = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else if (COLLECTING) {
    // 采集期：降级为「待定稿同步」，不计入失败。
    pending += 1;
    console.log(`  ⏳ ${name}${detail ? ' — ' + detail : ''}（采集期，待定稿同步）`);
  } else { fail += 1; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// 严格判定：**不受 `--collecting` 影响，采集期也判失败**。
//
// 为什么必须有第二个判定函数：`check()` 的降级逻辑是为「会随采集长大的数字」
// 设计的（规模条数、中位数、百分比），它们的失败真会等定稿同步后自愈。
// 但**定性断言**（「这些词每一个都低于 1%」）不是这类——
// 它不会因为语料长大而自动变真，只会**越采越可能变假**。
// 用 check() 判它，等于在采集期给了一个「先红着吧」的借口，
// 而这段时间恰恰是语料变化最快、最该报警的时候。
function checkStrict(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}${COLLECTING ? '（定性断言，采集期也判失败）' : ''}`); }
}
const wordPct = (list, w) => list?.find((x) => x.word === w)?.pct ?? 0;

const tb = base.length.tiebaBody;
const dm = base.length.danmaku;
const cm = base.length.comment;
const tbStyle = base.style.tiebaBody;
const cmStyle = base.style.comment;
const dmStyle = base.style.danmaku;

console.log(`语料规模: 贴吧${base.scale.tieba} 弹幕${base.scale.biliDanmaku} 评论${base.scale.biliComment} 小红书${base.scale.xhs} 合计${base.scale.total}`);

// ── 定位「语料的实测锚点」这一节 ──
//
// 不写死中文序号：谁在前面插一节，「十」就变「十一」，整份校验当场失效，
// 而失败信息看起来像「数字错了」，实际只是「编号变了」。
// 用内容特征定位：标题含「语料」，或含「实测锚点」。
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

const section = findSection(role);
if (!section) {
  console.log('\n❌ 卡片里找不到「语料/实测锚点」小节 —— 人格卡结构变了，请先核对标题');
  process.exit(1);
}
console.log(`锚点小节: ${role.split('\n')[section.start]}`);

// ── 卡片版本提示 ──
//
// 踩过的坑：把工具提交进库后，在干净 clone 里跑出「47 通过 2 失败」，
// 而工作区是「40 通过 0 失败」。查下来**工具没问题**，是 clean clone 里
// 拿到的还是一代卡（20318 字节），而工具是按二代卡（11877 字节）的措辞写的。
//
// 换句话说：卡片和校验工具必须**同版本**才自洽。只提交工具、不提交新卡，
// 会造出一个「clone 下来就红」的仓库 —— 而失败信息看起来像数字错了，
// 新人第一反应是去改数字，越改越错。
//
// 这里不猜版本号（卡片没有版本号，也不该为了校验硬加一个），
// 只根据卡片是否还有一代卡独有的特征小节，提示一句。
if (/^##\s.*真实语料/m.test(role) && !/语料的实测锚点/.test(role)) {
  console.log('');
  console.log('⚠️  这张卡看起来是**一代版**（含「真实语料」节、无「语料的实测锚点」）。');
  console.log('   本脚本按二代卡的措辞编写，对一代卡会有若干项因措辞不同而失败，');
  console.log('   那是版本不匹配，不是数字错了。');
  console.log('   要让校验通过：确认你测的是当前要用的那张卡（通常是工作区版本）。');
  console.log('');
}

// 只在这一节里抽数字，避免误抓其它节里同样出现的「12 字」这类字眼
const S = section.text;

// 从卡片里抽取形如「约 2.3%」「p90 是 45 字」的数字
const nums = (re, src = S) => {
  const m = src.match(re);
  return m ? Number(m[1]) : NaN;
};

console.log('\n=== 1. 句长：卡片声称的数字 vs 实测 ===');
{
  // 中位数：不再要求「贴吧发言中位数」这一确切串，只要同一节内
  // 「贴吧…中位数…N 字」这种共现就认。允许中间夹修饰词。
  const cardP50Tb = nums(/贴吧[^\n]{0,12}中位数\s*(?:约\s*)?(\d+)\s*字/);
  check(`贴吧中位数 卡片=${cardP50Tb} 实测=${tb.p50}`, cardP50Tb === tb.p50);

  const cardP50Dm = nums(/B站弹幕[^\n]{0,12}中位数\s*(?:约\s*)?(\d+)\s*字/);
  check(`弹幕中位数 卡片=${cardP50Dm} 实测=${dm.p50}`, cardP50Dm === dm.p50);

  // 卡片用「四成」「七成」这类口语表述，换算成区间再比。
  // 区间**从共享档位表反查**，不在这里手写数字——手写就会和 sync 漂开。
  const withinBand = (word, pct) => {
    if (!word) return false;
    const m = String(word).match(/^约(\d+(?:\.\d+)?)%$/);
    if (m) return Math.abs(pct - Number(m[1])) < 1.5;
    const b = bandOf(word);
    if (!b) return false;
    return pct >= b[0] && pct < b[1];
  };
  const bandWord = (re) => {
    const m = S.match(re);
    return m ? m[1] : '';
  };
  const word8 = bandWord(new RegExp(`(${SPOKEN_PATTERN})在 8 字以内`));
  const word10 = bandWord(new RegExp(`(${SPOKEN_PATTERN})不到 10 字`));
  check(
    `贴吧 ≤8 字 实测 ${tb.under8}%（卡片写「${word8}在 8 字以内」）`,
    withinBand(word8, tb.under8),
  );
  check(
    `弹幕 ≤10 字 实测 ${dm.under10}%（卡片写「${word10}不到 10 字」）`,
    withinBand(word10, dm.under10),
  );

  // 长尾：只写中位数会让人以为"只会说短句"
  const cardP90Tb = nums(/贴吧\s*p90\s*(?:约|是)?\s*(\d+)\s*字/);
  const cardP90Cm = nums(/评论\s*p90\s*(?:约|高达)?\s*(\d+)\s*字/);
  check(
    `贴吧 p90 卡片=${cardP90Tb} 实测=${tb.p90}（容差 ±8）`,
    Math.abs(cardP90Tb - tb.p90) <= 8,
  );
  check(
    `评论 p90 卡片=${cardP90Cm} 实测=${cm.p90}（容差 ±15）`,
    Math.abs(cardP90Cm - cm.p90) <= 15,
  );
  check('卡片点明「不是只会说短句」的长尾含义', /不是"只会说短句"|长尾/.test(S));
}

console.log('\n=== 2. 标点习惯 ===');
check(
  `贴吧无句尾标点 ${tbStyle.noEndPunct}%，卡片写「八成以上」`,
  tbStyle.noEndPunct >= 80 && /八成以上的贴吧发言/.test(S),
  `实际 ${tbStyle.noEndPunct}%`,
);
check(
  `评论无句尾标点 ${cmStyle.noEndPunct}%，同属「八成以上」`,
  cmStyle.noEndPunct >= 80,
  `实际 ${cmStyle.noEndPunct}%`,
);
// 用 checkStrict：这是**上限型定性断言**，不是会随采集长大的规模数字。
// 语料再多一倍，「括号真的很少」也不会因此变对；越界只意味着这句措辞已经失效。
checkStrict(
  `句号结尾 贴吧 ${tbStyle.endsWithPeriod}% / 评论 ${cmStyle.endsWithPeriod}%，卡片写「不到一成」`,
  tbStyle.endsWithPeriod < 10 && cmStyle.endsWithPeriod < 10 && /句号结尾[^\n]{0,6}不到一成/.test(S),
);
checkStrict(
  `括号 贴吧 ${tbStyle.hasBracket}% / 弹幕 ${dmStyle.hasBracket}%，卡片写「不到 3%」`,
  tbStyle.hasBracket < 3 && dmStyle.hasBracket < 3 && /括号[^\n]{0,8}不到 3%/.test(S),
);

console.log('\n=== 3. 高频词：卡片写「约 N%」，与实测比对 ===');
// 卡片格式为 `词`（约 N%）或 `词`: …（约 N%），用词名定位后取其后最近的百分数
function claimedPct(word) {
  const idx = S.indexOf('`' + word + '`');
  if (idx < 0) return NaN;
  const tail = S.slice(idx, idx + 120);
  const m = tail.match(/约\s*([\d.]+)\s*%/);
  return m ? Number(m[1]) : NaN;
}
// 「不是」「可以」按**名次**校验，不按百分比。
// 原因：这两词的占比对来源构成高度敏感（stability.mjs --final 实测：贴吧「不是」
// 前半段 4.23%、后半段 7.89%，全量 5.02%），卡片写任何精确数字都只对某一段成立。
// 但名次在两段里完全一致（不是→可以→6→确实→真的），所以卡片按名次表述。
{
  const ranked = [...base.words.tiebaBody].sort((a, b) => b.pct - a.pct);
  const rankOf = (word) => ranked.findIndex((x) => x.word === word) + 1;
  const r1 = rankOf('不是');
  const r2 = rankOf('可以');
  // 卡片措辞从「贴吧词频第一、第二」收敛成「两者都排在词频最前」——
  // 后者更松，但正是重写时刻意选的：不承诺名次，就不会因为语料构成变化而变假。
  // 所以这里判「名次确实靠前（前二）」+「卡片确实说了靠前」，不再要求字数级一致。
  check(
    `贴吧「不是」实测名次 ${r1}、 「可以」实测名次 ${r2}，卡片写「排在词频最前」`,
    r1 <= 2 && r2 <= 2 && /排在词频最前/.test(S),
    `实测名次 不是=${r1} 可以=${r2}`,
  );
}
// 「确实」：卡片写「最高频的附和词之一（约 1.9%）」
{
  const claimed = claimedPct('确实');
  const actual = wordPct(base.words.tiebaBody, '确实');
  check(
    `贴吧「确实」卡片约 ${claimed}% / 实测 ${actual}%`,
    Math.abs(claimed - actual) <= 0.5,
    `偏差 ${(actual - claimed).toFixed(2)}`,
  );
  checkStrict(
    '「确实」写成「最高频的附和词之一」（含「之一」）',
    /最高频的附和词之一/.test(S),
    '存在只写「最高频」而漏「之一」的版本',
  );
}
// 「真的」：卡片已不再引用它的百分比（措辞收敛时删掉了），
// 所以这里只在「卡片确实提了」时才校验数字，避免为了过测试而硬加回一个用不上的数字。
{
  const claimed = claimedPct('真的');
  if (Number.isNaN(claimed)) {
    pass += 1;
    console.log('  ✅ 卡片未引用「真的」的百分比（措辞已收敛，无需校验）');
  } else {
    const actual = wordPct(base.words.tiebaBody, '真的');
    check(
      `贴吧「真的」卡片约 ${claimed}% / 实测 ${actual}%`,
      Math.abs(claimed - actual) <= 0.5,
      `偏差 ${(actual - claimed).toFixed(2)}`,
    );
  }
}
{
  const claimed = claimedPct('哈哈');
  const actual = wordPct(base.words.danmaku, '哈哈');
  check(`弹幕「哈哈」卡片约 ${claimed}% / 实测 ${actual}%`, Math.abs(claimed - actual) <= 0.6);
  const xs = wordPct(base.words.danmaku, '笑死');
  check(`弹幕「笑死」实测 ${xs}% < 1%，卡片写「不到 1%」`, xs < 1 && /不到 1%/.test(S));
}

console.log('\n=== 4. 反向验证：卡片点名「不要学」的营销号词，语料里必须真的接近零 ===');
// 注意：卡片只点名了一部分（绝绝子/尊嘟假嘟/泰裤辣/显眼包/栓Q/yyds）。
// 旧版要求 9 个词**全部**出现在卡片里，重写后卡片收敛到 6 个，
// 于是「未点名的词」被判失败——但被点名的那些其实都在、语料也都接近零。
// 正确的判法是两个方向的组合：
//   (a) 卡片点名了的词，语料必须接近零（否则那条警示是臆造的）
//   (b) 语料确实接近零的词，不强制卡片点名（不点名不代表错）
const MARKET_ALL = ['绝绝子', '尊嘟假嘟', '泰裤辣', '显眼包', '栓Q', '安利', '避雷', '种草', '氛围感', 'yyds'];
const named = MARKET_ALL.filter((w) => S.includes(w));
check('卡片至少点名了 3 个营销号词', named.length >= 3, `实际点名 ${named.length} 个：${named.join('/')}`);
for (const w of named) {
  const total = wordPct(base.words.tiebaBody, w) + wordPct(base.words.danmaku, w) + wordPct(base.words.comment, w);
  check(`「${w}」被点名，语料合计 ${total.toFixed(2)}% < 0.2%`, total < 0.2, `实际 ${total}%`);
}

console.log('\n=== 5. 卡片不得把营销号词当作可学表达 ===');
// 不再要求出现「营销号模板」这个特定短语（重写时用词变了），
// 改判语义：卡片必须给出「这些词别学」的判断，而不只是罗列。
check(
  '卡片给出了「不学」的明确判断',
  /不学的|不要学|别用|几乎为零/.test(S),
);
for (const w of ['yyds', '家人们谁懂啊']) {
  const idx = S.indexOf(w);
  const guarded = idx < 0 || /不要学|营销号|几乎为零|避开|不学的|别用/.test(S.slice(Math.max(0, idx - 250), idx + 250));
  check(`「${w}」若出现必须处在反例语境`, guarded);
}

console.log('\n=== 6. 卡片声明的语料规模与实际数量级相符 ===');
{
  // 旧锚点「在 N 万条去重语料里」在重写时被删掉了 ——
  // 卡片现在不谈总数，只谈分项与比例，这是有意的：总数会每一轮都漂，
  // 写进卡片很快就会变成假话，而分项比例相对稳定得多。
  // 所以：卡片若声明了总数就校验，没声明就明确记一条「未声明」而不算失败。
  const claimedWan = nums(/在\s*([\d.]+)\s*万条去重语料里/);
  if (Number.isNaN(claimedWan)) {
    pass += 1;
    console.log('  ✅ 卡片未声明语料总数（措辞已收敛，只谈分项与比例）');
  } else {
    const actualWan = base.scale.total / 10000;
    check(
      `语料合计 ${base.scale.total} 条 = ${actualWan.toFixed(1)} 万，卡片写 ${claimedWan} 万（容差 ±0.3 万）`,
      Math.abs(claimedWan - actualWan) <= 0.3,
      `实际 ${actualWan.toFixed(2)} 万`,
    );
  }
}

console.log('\n=== 7. 卡片逐项规模与实测相符（若卡片声明） ===');
{
  const m = S.match(/贴吧\s*([\d,]+)\s*条发言\s*\+\s*B站\s*([\d,]+)\s*条弹幕\s*\+\s*([\d,]+)\s*条评论\s*\+\s*([\d,]+)\s*条小红书标题/);
  if (!m) {
    pass += 1;
    console.log('  ✅ 卡片未逐项声明规模（措辞已收敛）');
  } else {
    const num = (s) => Number(String(s).replace(/,/g, ''));
    const pairs = [
      ['贴吧发言', num(m[1]), base.scale.tieba],
      ['B站弹幕', num(m[2]), base.scale.biliDanmaku],
      ['B站评论', num(m[3]), base.scale.biliComment],
      ['小红书标题', num(m[4]), base.scale.xhs],
    ];
    for (const [label, claimed, actual] of pairs) {
      // 容差按百分比给，不写死绝对值：语料还在长，基数越大容许的漂移越大。
      const t = Math.max(5, Math.round(claimed * 0.03));
      check(
        `${label} 卡片=${claimed} 实测=${actual}（容差 ±${t}）`,
        Math.abs(claimed - actual) <= t,
        `偏差 ${actual - claimed}`,
      );
    }
  }
}

// 第八组：卡片那句「每一个都不到百分之一」。
//
// 为什么单列一组：这是**人手写进去的定性断言**，没有任何脚本能自动同步它。
// 它恰好是那种「写的时候是真的、语料长两个月就悄悄变假」的句子——
// 一旦变假，卡片就是在教模型「这些词很冷门」，实际在教错。
//
// 判定口径刻意选**三源取最大**：卡片说的是「整份语料里每一个都低于 1%」，
// 那就要连最热的那个来源也低于 1% 才能说这句话。
console.log('\n=== 8. 卡片「弹幕式语感词」定性断言：全部 < 1%（三源取最大） ===');
{
  // 旧版要求卡片逐个列出 8 个词，重写后收敛成 6 个（删了「我哭死」「汗流浃背」）。
  // 判法改为：**卡片点了名的那个子集**必须真的都 < 1%。
  // 不强制点名全部 8 个——卡片是提示词，不是词表；列太多反而稀释。
  const BULLET_ALL = ['典', '属于是', '破防', '泪目', '我哭死', '汗流浃背', '啊这', '就这'];
  const bullet = BULLET_ALL.filter((w) => S.includes('`' + w + '`'));
  check('卡片点名了部分弹幕式语感词', bullet.length >= 3, `实际 ${bullet.length} 个：${bullet.join('/')}`);

  const claimOk = /不到百分之一|都不到 1%/.test(S);
  check('卡片保留了「这些词都不到百分之一」这类断言', claimOk);

  let worst = { word: '', pct: -1, src: '' };
  for (const word of bullet) {
    const srcs = [
      ['贴吧', wordPct(base.words.tiebaBody, word)],
      ['弹幕', wordPct(base.words.danmaku, word)],
      ['评论', wordPct(base.words.comment, word)],
    ];
    const top = srcs.reduce((a, b) => (b[1] > a[1] ? b : a));
    if (top[1] > worst.pct) worst = { word, pct: top[1], src: top[0] };
    // 用 checkStrict：这是定性断言，采集期也必须判红（理由见 checkStrict 注释）
    checkStrict(
      `「${word}」三源最高 ${top[1]}%（${top[0]}）< 1%`,
      top[1] < 1,
      `贴吧${srcs[0][1]}% 弹幕${srcs[1][1]}% 评论${srcs[2][1]}%`,
    );
  }
  if (worst.pct >= 0) {
    console.log(`  （最热的那个是「${worst.word}」${worst.pct}%，出现在${worst.src}——它离 1% 还有 ${(1 - worst.pct).toFixed(2)} 个点，` +
      `这就是这句话的余量；余量耗尽前要么改卡片措辞，要么删词）`);
  }

  // 反向：卡片说这些词冷门，那真正高频的「哈哈」必须显著更高。
  // 如果哪天哈哈掉到 1% 以下，这段「别学弹幕」的劝告就失去了对照物。
  const haha = wordPct(base.words.danmaku, '哈哈');
  check(
    `对照物「哈哈」弹幕 ${haha}% 明显高于上述任何词`,
    haha > worst.pct && haha >= 2,
    `哈哈 ${haha}% vs 最高弹幕词 ${worst.pct}%`,
  );
}

// 第九组：跨节一致性。
//
// 背景：`确实` 的百分比曾经在第二节和第十节各写一次，两处说的是同一个实测值。
// 之前只有 sync-card-numbers 会顺手把两处一起改，verify-numbers 从头到尾没管过第二节。
// 于是只要定稿时漏跑 `--sync`，第二节就会带着陈旧的数字长期存在，而所有校验依然全绿。
//
// 重写后卡片只在锚点节里写一次「确实」的百分比，第二节那处已删除。
// 所以现在判的是**「不许有第二个版本」**：全文出现 `确实`（约 N%）的次数必须 ≤ 1。
// 这是比「两处相等」更强的约束——两处相等还需要同步，一处根本没有同步问题。
console.log('\n=== 9. 跨节一致性：「确实」的百分比不得有两个版本 ===');
{
  const all = [...role.matchAll(/`确实`[^\n]{0,40}?约\s*([\d.]+)\s*%/g)].map((m) => Number(m[1]));
  checkStrict(
    `全文「确实」的百分比只出现 ${all.length} 处（≤1 才能保证不会自相矛盾）`,
    all.length <= 1,
    all.length ? `实际取值：${all.join('% / ')}%` : '',
  );
  if (all.length === 1) {
    const actual = wordPct(base.words.tiebaBody, '确实');
    check(
      `「确实」卡片=${all[0]}% 实测=${actual}%（容差 ±0.5）`,
      Math.abs(all[0] - actual) <= 0.5,
      `偏差 ${(actual - all[0]).toFixed(2)}`,
    );
  }
}

console.log(`\n总计: ${pass} 通过, ${fail} 失败${pending ? `, ${pending} 项待定稿同步` : ''}`);
if (COLLECTING) {
  console.log('（采集期模式：会随语料增长的数值只提示不判失败；采集结束后请不带 --collecting 重跑）');
}
process.exit(fail ? 1 : 0);
