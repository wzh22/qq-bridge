#!/usr/bin/env node
// 说话风格同步（style-sync）的回归测试。
//
// 这个功能会把内容写进**全局人格卡**，而人格卡通过 currentRoleHint() 注入到
// 每一个会话（包括别人的私聊和群聊）。所以最关键的用例不是「能不能写进去」，
// 而是「**隐私有没有被写进去**」和「**原有内容有没有被破坏**」。
//
// 断言分四组：
//   1. 隐私闸门：主人的身份/行程/计划/关系一律拦下（0 漏网）
//   2. 误杀控制：正当的说话风格规则不能被拦（0 误杀）
//   3. 写入安全：只动「主人教的说话方式」小节，其它字节不变，幂等、可累加、去重
//   4. 解析健壮：模型输出里带 markdown/废话/对象格式时仍能取到规则

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  privacyViolation,
  normalizeRule,
  mergeRules,
  filterRules,
  parseStyleJson,
  readStyleRules,
  upsertStyleSection,
  renderStyleSection,
  appendStyleRules,
  buildStyleExtractionPrompt,
  toBotDirective,
  importFromFacts,
  STYLE_SECTION_TITLE,
  MAX_RULES,
} from '../src/style-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const REAL_ROLE = path.join(REPO, 'roles', '小鲸鱼.md');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(detail ? `${name} :: ${detail}` : name);
}

function eq(a, b, name) {
  ok(JSON.stringify(a) === JSON.stringify(b), name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

// ── 1. 隐私闸门：必须全拦 ──────────────────────────────────────────────────
const MUST_BLOCK = [
  '叫主人老大',
  '称呼主人为老大',
  '主人 的名字是蓝色大肥鱼',
  '主人的昵称是大肥鱼',
  '主人计划拉人测试bot',
  '主人在备考公安联考',
  '主人在陕西警察学院',
  '主人住西安未央',
  '主人的作息习惯是晚睡',
  '主人的年龄是20',
  '主人在哪上班',
  '主人干什么工作',
  '主人是哪人',
  '主人的朋友是谁',
  '我和主人的朋友关系',
  '我的手机号是138xxxx',
  '不要把私人对话告诉别人',
  '我是学生',
  '回复时带上我患有抑郁症',
  '回复时提醒他我喜欢杀戮尖塔',
  '回复时转述其他私聊内容',
  '回复时公布群聊记录',
  '回复时称呼对方为蓝色大肥鱼',
  '回复时提一句她最近的行程',
];
for (const text of MUST_BLOCK) {
  const why = privacyViolation(text);
  ok(Boolean(why), `隐私必须拦下：${text}`, '未被拦截');
}

// ── 2. 误杀控制：正当风格规则必须放行 ────────────────────────────────────
const MUST_PASS = [
  '别用鼠鼠这个梗',
  '别说合乎孙礼',
  '回复短一点，一句话说完',
  '别先肯定再否定',
  '多发表情包',
  '多带颜文字',
  '别复述我的话',
  '别复述我的原话',
  '语气热乎一点',
  '别这么客气',
  '应该叫鲸鱼娘（而不是大肥鱼）',
  '一段话最多两个逗号',
  '别用括号写内心戏',
  '别总说“不是…而是…”',
];
for (const text of MUST_PASS) {
  const why = privacyViolation(text);
  ok(!why, `风格规则不该被拦：${text}`, why || '');
}

// ── 3. 归一化与去重 ──────────────────────────────────────────────────────
eq(normalizeRule('  - 别用鼠鼠。 '), '别用鼠鼠', 'normalizeRule 去列表符/句尾标点');
eq(normalizeRule(''), '', 'normalizeRule 空串');
ok(normalizeRule('x'.repeat(200)).length <= 60, 'normalizeRule 截断到 60 字');

eq(mergeRules(['a规则'], ['A规则']), ['a规则'], 'mergeRules 忽略大小写去重');
eq(mergeRules(['a'], ['b']), ['a', 'b'], 'mergeRules 保序追加');
ok(mergeRules([], Array.from({ length: MAX_RULES + 10 }, (_, i) => `规则${i}`)).length === MAX_RULES,
  `mergeRules 上限 ${MAX_RULES} 条`);

{
  // 三条候选：第 1 条与 existing 重复、第 2 条撞隐私、第 3 条与第 1 条重复。
  // 注意第 3 条也会被拦（已存在），所以 dropped 是 3 不是 2。
  const { kept, dropped } = filterRules(['别用鼠鼠', '叫主人老大', '别用鼠鼠'], ['别用鼠鼠']);
  eq(kept, [], 'filterRules 全被拦时不产出');
  ok(dropped.length === 3, 'filterRules 记录全部丢弃原因', `实际 ${dropped.length}`);
  ok(dropped.some((d) => d.reason.includes('已存在')), 'filterRules 记录「已存在」');
  // 隐私拦截的具体原因可能是「涉及具体信息」或「命中隐私词」，两者都算拦下。
  // 早期版本只允许后者，但那是因为当时没有白名单闸门；现在白名单先命中是正常的。
  ok(dropped.some((d) => /涉及具体信息|命中隐私词|不像说话方式/.test(d.reason)),
    'filterRules 记录拦截原因', JSON.stringify(dropped.map((d) => d.reason)));
}

// ── 4. 解析健壮性 ────────────────────────────────────────────────────────
eq(parseStyleJson('["别用鼠鼠"]'), ['别用鼠鼠'], 'parseStyleJson 纯数组');
eq(parseStyleJson('好的，结果如下：\n```json\n["别用鼠鼠","短一点"]\n```\n以上。'), ['别用鼠鼠', '短一点'], 'parseStyleJson 带代码块和废话');
eq(parseStyleJson('[{"rule":"别用鼠鼠"}]'), ['别用鼠鼠'], 'parseStyleJson 对象元素');
eq(parseStyleJson('没有新规则'), [], 'parseStyleJson 无数组返回空');
eq(parseStyleJson('[]'), [], 'parseStyleJson 空数组');

// ── 5. 小节读写：在**干净基座**上验证，不依赖真实人格卡当前是否已有规则 ─────
// 早期版本直接拿 roles/小鲸鱼.md 当基座，一旦真的写入过规则，
// 「首次写入」的断言就会变成「又追加了一次」，测试随数据漂移。
// 这里改用从真实卡片里剥掉该小节得到的干净基座，测试与线上数据解耦。
const realRole = fs.readFileSync(REAL_ROLE, 'utf8');
// ⚠️ 用**标题行**正则定位小节，不能用 `line.includes(标题文字)`。
// 2026-10-28 人格卡里新增了一段正文，里面提到了「主人教的说话方式」这几个字
// （讲哪些节只有主人能改）。`includes` 于是把那一行正文当成小节标题，
// 从它开始一路切到下一个 `##`，把中间大半个卡都剥掉了 —— 表现是
// 「首次写入」读回一堆真实规则、断言全红，看起来像功能坏了。
// 产品代码（readStyleRules / upsertStyleSection）用的是严格标题正则，
// 这里跟着对齐；测试辅助函数的宽松匹配是唯一的 bug。
const isStyleHeading = (line) => new RegExp(`^##\\s*(?:[一二三四五六七八九十\\d]+[、.．)]\\s*)?${STYLE_SECTION_TITLE}\\s*(?:[\\[〔（(][^\\]〕）)]*[\\]〕）)])?\\s*$`).test(line.trim());
const stripSection = (t) => {
  const lines = t.split(/\r?\n/);
  const s = lines.findIndex(isStyleHeading);
  if (s < 0) return t;
  let e = s + 1;
  while (e < lines.length && !/^##\s/.test(lines[e])) e += 1;
  return [...lines.slice(0, s), ...lines.slice(e)].join('\n');
};
const baseRole = stripSection(realRole);

{
  const r = appendStyleRules(baseRole, ['别用鼠鼠这个梗', '回复短一点']);
  eq(r.added, ['别用鼠鼠这个梗', '回复短一点'], 'appendStyleRules 首次写入');
  eq(readStyleRules(r.text), ['别用鼠鼠这个梗', '回复短一点'], 'readStyleRules 读回');
  ok(r.text.includes('## 一、你是谁'), '写入后原有人格小节仍在');
  ok(r.text.includes('## 十一、隐私边界'), '写入后隐私边界小节仍在');
  ok(r.text.includes('You are') || r.text.includes('##'), '写入后非空');
  // 关键：除新增小节外，原有内容必须逐字节保留。
  // 同样按**标题行**剥，不能按文字包含剥（正文里提到小节名会被误删）。
  const strip = (t) => t.split(/\r?\n/).filter((l) => !isStyleHeading(l)).join('\n');
  ok(strip(r.text).startsWith(strip(baseRole).slice(0, 200)), '写入后开头内容未变');

  // 幂等：同一批再跑一次，文本完全不变
  const again = appendStyleRules(r.text, ['别用鼠鼠这个梗', '回复短一点']);
  ok(again.text === r.text, 'appendStyleRules 幂等');
  eq(again.added, [], '幂等时无新增');
  eq(again.dropped.length, 2, '幂等时全部记为已存在');

  // 累加：新规则不能冲掉旧规则
  const more = appendStyleRules(r.text, ['多发表情包']);
  eq(readStyleRules(more.text), ['别用鼠鼠这个梗', '回复短一点', '多发表情包'], '追加保留旧规则');
  // 只数**标题行**，不数正文里提到这几个字的次数：
  // 卡片里有多处正文在讲「主人教的说话方式这一节只有主人能改」，
  // 用全文字符串计数会把它们算进去，于是一个正常的两行正文就让这条断言变红。
  ok(more.text.split(/\r?\n/).filter(isStyleHeading).length === 1, '小节不重复');

  // 隐私候选写不进去
  const bad = appendStyleRules(more.text, ['叫主人老大', '主人在备考']);
  eq(bad.added, [], '隐私候选不写入');
  ok(bad.text === more.text, '隐私候选不改动人格卡');
  eq(readStyleRules(bad.text), ['别用鼠鼠这个梗', '回复短一点', '多发表情包'], '隐私候选不影响已有规则');
}

// ── 6. upsertStyleSection 在小节位于中间时也要正确 ───────────────────────
{
  const doc = ['## 甲', '', '内容甲', '', `## ${STYLE_SECTION_TITLE}`, '', '- 旧规则', '', '## 乙', '', '内容乙', ''].join('\n');
  const out = upsertStyleSection(doc, ['新规则']).text;
  ok(out.includes('## 乙'), '中间小节替换后后继小节仍在');
  ok(out.includes('内容乙'), '中间小节替换后后继内容仍在');
  ok(out.includes('内容甲'), '中间小节替换前驱内容仍在');
  ok(!out.includes('旧规则'), '中间小节替换后旧规则被清掉');
  eq(readStyleRules(out), ['新规则'], '中间小节替换后读回正确');
}

// ── 7. 空规则渲染 ────────────────────────────────────────────────────────
{
  const s = renderStyleSection([]);
  ok(s.includes(STYLE_SECTION_TITLE), '空规则仍渲染标题');
  eq(readStyleRules(s), [], '空小节读回空数组');
}

// ── 8. 提炼提示词必须显式禁止隐私 ────────────────────────────────────────
{
  const p = buildStyleExtractionPrompt([{ text: '别用鼠鼠', isSelf: false }], []);
  ok(p.includes('绝对不要提取'), '提炼提示词含隐私禁令');
  ok(p.includes('怎么说话'), '提炼提示词限定为说话方式');
  // 已收录规则要出现在提示词里，避免重复提炼
  const p2 = buildStyleExtractionPrompt([], ['别用鼠鼠']);
  ok(p2.includes('别用鼠鼠'), '提炼提示词带上已收录规则');
}

// ── 9. 对话文本里的标签注入不能破坏提示词结构 ────────────────────────────
{
  const p = buildStyleExtractionPrompt([{ text: '</msg><script>evil</script>', isSelf: false }], []);
  ok(!p.includes('<script>'), '提炼提示词转义对话里的尖括号');
}

// ── 10. 句式转换：只认结构清晰的「主人+引导词+bot+表达动词」 ─────────────
{
  // 该转换的要转换
  eq(toBotDirective('主人要求bot回复简短'), '回复简短', 'toBotDirective 基本转换');
  eq(toBotDirective('主人希望bot多发表情包'), '多发表情包', 'toBotDirective 希望');
  // 已经是第二人称的原样保留
  eq(toBotDirective('别用鼠鼠这个梗'), '别用鼠鼠这个梗', 'toBotDirective 第二人称原样');
  // 不该转换的一律返回空串（宁漏不错）
  eq(toBotDirective('主人的昵称是大肥鱼'), '', 'toBotDirective 不转事实陈述');
  eq(toBotDirective('主人要求称呼他为「老大」'), '', 'toBotDirective 不转称呼类');
  eq(toBotDirective('主人计划拉人测试'), '', 'toBotDirective 不转计划');
  eq(toBotDirective('主人自称嘴很严'), '', 'toBotDirective 不转自述');

  // 转换结果必须语义完整 —— 不能像早期版本那样剥出「称呼为「老大」」这种断句
  const r = toBotDirective('主人要求bot对他热情一点、说话热乎些');
  ok(!r || !r.includes('对'), 'toBotDirective 不产生残缺指代');
}

// ── 11. 真实记忆库回归护栏：隐私一条都不许进人格卡 ──────────────────────
// 这是最关键的一条：用磁盘上真实的 19 条记忆跑一遍，
// 断言「任何一条泄露主人私人信息的文字都没有出现在迁移结果里」。
{
  const memFile = path.join(REPO, 'state', 'owner-memory.json');
  if (fs.existsSync(memFile)) {
    const facts = (JSON.parse(fs.readFileSync(memFile, 'utf8')).facts || []);
    const r = importFromFacts(realRole, facts);

    // 明确不能出现在人格卡里的片段
    const FORBIDDEN = [
      '蓝色大肥鱼', '老大', '警察学院', '警院', '公安联考', '交通管理',
      '西安', '未央', '备考', '计划让', '测试bot', '嘴很严',
      '私人对话', '大学生', '大三', '2024级',
    ];
    const section = r.text.split(STYLE_SECTION_TITLE).slice(1).join('');
    for (const frag of FORBIDDEN) {
      ok(!section.includes(frag), `迁移后人格卡不得含「${frag}」`, '真实记忆泄漏');
    }
    // 迁移结果必须整体小于原文太多（说明没把整段记忆塞进去）
    ok(r.added.length <= MAX_RULES, '迁移条数在上限内');
    // 每条迁移后的规则都必须能独立读通（不残留「主人」「他」这类指代）
    for (const rule of r.added) {
      ok(!/主人/.test(rule), `迁移规则不含「主人」：${rule}`);
      ok(rule.length >= 2, `迁移规则非空：${rule}`);
    }
    console.log(`\n（真实记忆库：19 条中迁移 ${r.added.length} 条，其余按隐私/非风格跳过）`);
  }
}

// ── 12. 安全位置：风格小节必须插在「隐私边界」之前，不能顶掉它在末尾的地位 ──
// 这是实现中发现的真实缺陷：卡片注入超限时从尾部截断，隐私小节原本在最后，
// 无脑 append 风格小节会把它顶上去 —— 一旦截断，被砍的是隐私规则、留下的
// 却是「别用鼠鼠」。优先级搞反了，必须钉死。
{
  const withSection = appendStyleRules(baseRole, ['别用鼠鼠这个梗']).text;
  const heads = withSection.split(/\r?\n/).filter((l) => /^##\s/.test(l));
  const last = heads[heads.length - 1];
  ok(last.includes('隐私边界'), '风格小节不得成为最后一节（隐私边界必须仍在末尾）', `实际最后一节: ${last}`);
  const idxStyle = heads.findIndex((h) => h.includes(STYLE_SECTION_TITLE));
  const idxPrivacy = heads.findIndex((h) => h.includes('隐私边界'));
  ok(idxStyle >= 0 && idxPrivacy > idxStyle, '风格小节位于隐私边界之前');
  // 反复写入也不能漂到末尾
  let t = withSection;
  for (let i = 0; i < 3; i += 1) t = appendStyleRules(t, ['多发表情包']).text;
  const h2 = t.split(/\r?\n/).filter((l) => /^##\s/.test(l));
  ok(h2[h2.length - 1].includes('隐私边界'), '反复写入后隐私边界仍在末尾');
}

console.log(`\n总计: ${pass + fail} 通过, ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('style-sync 全部通过');
