// 记忆分级（diary-grade）：把「这条多重要」从模型自评里拿出来，改用两把尺子。
//
// 为什么必须做（实盘数据）
// ------------------------
// 85 条真实日记里，3★ 占 51 条（60%），5★ 只有 1 条。
// 模型写日记时天然倾向选「一般」——那最安全，不会被判错。
// 于是所有依赖 importance 的机制一起失效：
//   capEntries 的 pinned、shouldFold 的保护、memoryScore 的分层，全部退化成一条线。
//
// 结论：**模型自评重要度不可信，只能当"基础档"用，不能直接当权重。**
//
// 两把尺子
// --------
// 思路借鉴 LUOSHUI319/astrbot_plugin_congling 的 grade.py（无许可证，仅学思路、全部重写）：
//
//   · 第一把尺子是**标签**。模型说的「这很重要」无法验证，但「这句话里有"不许"」
//     是可以验证的。于是：模型给基础档 → 标签压上下限 → 硬标签直接定档。
//   · 第二把尺子是**行为信号**。被反复想起、被纠正过、主题反复出现，
//     这些是客观的，比模型的一句话可靠。
//
// 只看标签的漏洞：模型一句话说"这很重要"就能把寒暄顶成五级。
// 只看行为的漏洞：冷启动时没有任何行为数据，等于不分级。
// 所以两者都要，且标签负责**上下限**（防止越界），行为负责**微调**。
//
// 为什么级别是 1..5 而不是 0..5
// ----------------------------
// congling 用了 0 级表示「不可忘」，但它自己也在注释里记录了 `int(x or 3)` 把 0 吞成 3
// 的 bug。我们不重蹈覆辙：级别保持 1..5，**「不可忘」由 kind=boundary 表达**，
// 那是结构性的，不靠一个数值。数值越界问题从根上不存在。

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

/**
 * 标签白名单。模型给了不认识的标签一律丢掉——
 * 不丢的话模型会自创「重要」「关键」这类词，等于把自评又放回来。
 */
export const KNOWN_TAGS = Object.freeze([
  'promise',      // 约定承诺
  'boundary',     // 禁区底线
  'identity',     // 身份信息
  'preference',   // 明确喜好
  'milestone',    // 关系里程碑
  'stress',       // 对方明确强调「记住」
  'emotion',      // 情绪浓度高
  'routine',      // 日常寒暄
  'transient',    // 一次性时效
]);

export const TAG_LABELS = Object.freeze({
  promise: '约定承诺',
  boundary: '禁区底线',
  identity: '身份信息',
  preference: '明确喜好',
  milestone: '关系里程碑',
  stress: '对方强调',
  emotion: '情绪浓度',
  routine: '日常寒暄',
  transient: '一次性时效',
});

const VALID_TAGS = new Set(KNOWN_TAGS);

// ---------------------------------------------------------------------------
// 分级规则
// ---------------------------------------------------------------------------

/** 标签把级别**抬到**这个下限。身份与偏好不该被当成随口一说。 */
export const FLOOR = Object.freeze({
  identity: 4,
  preference: 4,
});

/**
 * 标签把级别**压到**这个上限。
 *
 * 这是整套机制里最重要的一组：没有它，模型每天发的「晚安」「吃了吗」
 * 会被写成一堆 3 星条目，把注入名额和核层预算全占掉，
 * 而真正重要的事被挤出去——这正是现在的实盘症状。
 */
export const CAP = Object.freeze({
  routine: 2,
  transient: 1,
});

/** 标签加一档（但不突破 FLOOR/CAP）。 */
export const BOOST = Object.freeze({
  promise: 1,
  stress: 1,
  emotion: 1,
});

/** 硬标签直接定档，压过模型给的基础档。 */
export const HARD = Object.freeze({
  // 禁区与里程碑都是「最高优先级」。级别越大越重要，所以两者都给 5——
  // 不要用低位数值去表达「重要」，那会让所有按数值排序的地方读反。
  boundary: 5,
  milestone: 5,
});

/**
 * 规则兜底：模型没给标签时，用关键词猜。
 *
 * 这张表是从真实日记与真实对话里攒的，不是通用词表——
 * 宁可比通用表窄，也不要宽到把什么都命中（那样等于没分级）。
 */
/**
 * 规则兜底：模型没给标签时，用关键词猜。
 *
 * 这张表是从真实日记与真实对话里攒的，不是通用词表——
 * 宁可比通用表窄，也不要宽到把什么都命中（那样等于没分级）。
 *
 * ## 断词陷阱（真实踩到的）
 *
 * 第一版从别的项目抄了「说好」当承诺词，结果在实盘 88 条日记上误判 5/6：
 *
 *   「他说好伤心」        ← 「说好」+「伤心」
 *   「他说好，还说喜欢我」 ← 「说好」是「好的」的变体，不是约定
 *   「我顺着他的话说好」   ← 同上
 *   「直接说好的或行就行」 ← 这甚至是在**讨论怎么说话**
 *
 * 只有「说好了」「说好的」才可能是承诺，而「说好伤心」这种更是纯误伤。
 * 所以这里改用更长、更具体的词，宁可漏判也不要错判——
 * 错判的代价是普通事件占掉核层位置，比漏判严重得多。
 */
export const RULES = Object.freeze([
  ['boundary', ['不许', '别碰', '不能提', '别提', '禁区', '底线', '不要叫', '不准', '不想再']],
  ['milestone', ['第一次', '纪念日', '一周年', '刚认识你那天', '从那天起']],
  ['identity', ['我叫', '我的名字', '我是做', '我住在', '我生日', '我今年', '我们学校']],
  ['preference', ['我最喜欢', '我最讨厌', '受不了', '我超爱', '根本不吃', '就爱', '不喜欢']],
  [
    'promise',
    [
      // 「答应 + 动作」：答应发、答应给、答应过、答应你
      // 注意不能只放「答应」两个字——「他答应得好勉强」不是承诺。
      // 用「答应」后接常见动作字的组合覆盖绝大多数真实说法。
      '答应发', '答应给', '答应过', '答应你', '答应他', '答应她', '答应做', '答应陪',
      '答应去', '答应帮', '答应改', '我答应', '他答应', '她说答应',
      // 「说好」的坑：中文里「他说好伤心」「我顺着他的话 说好」都会命中。
      // 只有后面跟了具体安排才可能是约定，所以只保留最明确的形态。
      '说好了要', '说好明天', '说好下次', '说好了的',
      '约定', '约好', '下次一起', '回头给', '一定给你', '保证给',
      // 「欠」是承诺最可靠的自然表达：欠着 = 还没兑现。
      // 只保留「欠」本身，不要放「没发」这种宽泛词——
      // 「他没发消息」不是承诺，误判会把普通事件塞进核层。
      '还欠', '欠着', '欠你', '欠他', '欠她',
    ],
  ],
  ['stress', ['记住', '别忘了', '很重要', '一定要', '千万']],
  ['emotion', ['崩溃', '难受死了', '气死', '开心死', '睡不着']],
  ['transient', ['今天', '刚才', '现在', '路上', '等下', '马上到', '这周', '刚刚']],
  ['routine', ['早安', '晚安', '在吗', '吃了吗', '哈哈', '在干嘛', '嗯嗯', '行吧']],
]);

// ---------------------------------------------------------------------------
// 分级
// ---------------------------------------------------------------------------

function clamp(n, low, high) {
  return Math.max(low, Math.min(high, n));
}

/**
 * 用关键词给文本打标签（模型不可用、或没给标签时的兜底）。
 *
 * 有一条刻意的冲突规则：**约定压过寒暄**。
 * 「晚安 说好明天一起看」同时命中 routine 和 promise，
 * 如果留着 routine，这句会被 CAP 压到 2 级，约定就丢了。
 * 所以只要同时命中了更硬的标签，就把 routine 摘掉。
 */
export function ruleTags(text) {
  const body = String(text ?? '');
  if (!body) return [];
  const hits = [];
  for (const [tag, words] of RULES) {
    if (words.some((w) => body.includes(w))) hits.push(tag);
  }
  const hard = ['promise', 'boundary', 'identity', 'milestone', 'preference', 'stress'];
  const hasHard = hits.some((t) => hard.includes(t));
  // 寒暄被更硬的标签涵盖时摘掉；一次性时效同理，但只在有承诺/边界时摘
  if (hasHard) {
    const i = hits.indexOf('routine');
    if (i >= 0) hits.splice(i, 1);
  }
  if (hits.includes('promise') || hits.includes('boundary')) {
    const j = hits.indexOf('transient');
    if (j >= 0) hits.splice(j, 1);
  }
  return hits;
}

/**
 * 从模型给的 importance(1..5) 推出「基础档」。
 *
 * 这一层不改数值，只做规范化：模型给的 1..5 就是基础档，
 * 越界或缺失才兜底。真正的修正交给标签与行为信号。
 */
export function baseLevel(importance) {
  // 注意不能写 `Number(importance) || 3`：0 是 falsy，会被静默吞成 3。
  // 这里是 congling 踩过的坑的同类（他们记在 atom.py 的 level_of 注释里）。
  // 先判 null/undefined/空串，再判有限性。
  if (importance === null || importance === undefined || importance === '') return 3;
  const n = Number(importance);
  if (!Number.isFinite(n)) return 3;
  return clamp(Math.round(n), 1, 5);
}

/**
 * 用标签把基础档修正成最终级别。返回级别与可解释的理由。
 *
 * 顺序是刻意的：基础档 → 硬标签定档 → BOOST 加成 → FLOOR/CAP 夹逼。
 * FLOOR/CAP 放最后，才能保证「不管前面怎么加，寒暄都上不去」。
 */
export function gradeByTags(level, tags) {
  const list = (Array.isArray(tags) ? tags : []).filter((t) => VALID_TAGS.has(t));
  const notes = [];
  let out = baseLevel(level);

  // 1) 硬标签直接定档，压过一切
  const hard = list.find((t) => Object.prototype.hasOwnProperty.call(HARD, t));
  if (hard) {
    out = HARD[hard];
    notes.push(`${TAG_LABELS[hard]}直接定档 ${out}`);
    return { level: out, why: notes.join('；'), tags: list };
  }

  // 2) BOOST 加成
  for (const t of list) {
    if (Object.prototype.hasOwnProperty.call(BOOST, t)) {
      out = clamp(out + BOOST[t], 1, 5);
      notes.push(`${TAG_LABELS[t]} +1`);
    }
  }

  // 3) FLOOR / CAP 夹逼（放最后，保证不被前面的加成突破）
  let floor = 1;
  let cap = 5;
  for (const t of list) {
    if (Object.prototype.hasOwnProperty.call(FLOOR, t)) {
      floor = Math.max(floor, FLOOR[t]);
      notes.push(`${TAG_LABELS[t]}至少 ${FLOOR[t]} 级`);
    }
    if (Object.prototype.hasOwnProperty.call(CAP, t)) {
      cap = Math.min(cap, CAP[t]);
      notes.push(`${TAG_LABELS[t]}封顶 ${CAP[t]} 级`);
    }
  }
  // CAP 优先于 FLOOR：同一句既像寒暄又像身份时，宁可信它是寒暄——
  // 少记一条不重要的事，比把不该忘的事压在寒暄堆里强。
  if (floor > cap) floor = cap;
  const before = out;
  out = clamp(out, floor, cap);
  if (before !== out) notes.push(`夹逼 ${before}→${out}`);

  return { level: out, why: notes.length ? notes.join('；') : '按内容判定', tags: list };
}

/**
 * 行为信号加成：客观证据把级别往上抬。
 *
 * 为什么行为信号要单独一层而不并进标签：
 * 标签看的是「这句话怎么写」，行为看的是「这件事后来怎么样了」。
 * 「膝盖疼」第一次说只是 transient，但连着三周说就成了长期事实——
 * 这个判断只能从行为来，任何词表都猜不到。
 */
export function behaviorBoost(level, signals = {}) {
  const s = signals && typeof signals === 'object' ? signals : {};
  const notes = [];
  let out = clamp(Math.round(Number(level) || 3), 1, 5);

  // 被反复想起：次线性加成，第 10 次不该比第 2 次强 5 倍
  const recall = Math.max(0, Number(s.recallCount) || 0);
  if (recall >= 3) {
    out = clamp(out + 1, 1, 5);
    notes.push(`被想起 ${recall} 次`);
  }

  // 被纠正过：说明这条被反复确认，是重要的
  if (Number(s.corrections) > 0) {
    out = clamp(out + 1, 1, 5);
    notes.push('有更正');
  }

  // 主题复现：同一话题在不同日期出现 ≥3 次 → 长期事实而非一次性事件
  // 这是最有价值的一条信号：模型不可能单看一句话知道「膝盖疼」说了三周。
  const recurrence = Math.max(0, Number(s.recurrence) || 0);
  if (recurrence >= 3) {
    out = clamp(out + 1, 1, 5);
    notes.push(`话题复现 ${recurrence} 次`);
  }

  return { level: out, why: notes.join('；') };
}

/**
 * 一步到位：给定重要度、标签、行为信号，算出最终级别。
 *
 * 供测试与调用方用；生产路径通常只用 gradeByTags（行为信号在别处算）。
 */
export function gradeEntry(entry, signals = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const hints = Array.isArray(e.tags) ? e.tags.filter((t) => VALID_TAGS.has(t)) : [];
  // 模型没给可用标签时，退回关键词兜底
  const tags = hints.length ? hints : ruleTags(`${e.title ?? ''} ${e.body ?? ''}`);
  const graded = gradeByTags(baseLevel(e.importance), tags);
  const boosted = behaviorBoost(graded.level, signals);
  return {
    level: boosted.level,
    why: [graded.why, boosted.why].filter(Boolean).join('；'),
    tags: graded.tags.length ? graded.tags : tags,
    fromRules: hints.length === 0 && tags.length > 0,
  };
}

/**
 * 核层准入判定：这条候选值不值得进「不该遗忘」那一层。
 *
 * 核层是每轮都要发给模型的固定成本，所以准入必须严：
 *   · 寒暄/一次性事件一律不进（它们连 3 级都到不了）
 *   · 标签分级的级别 < 3 的不进
 *
 * 注意 promise/boundary 走的是 kind 而不是级别——
 * 它们由 diary-core 的结构直接决定，不靠这里算。
 */
export function passCoreAdmission(text, { minLevel = 3 } = {}) {
  const tags = ruleTags(text);
  if (tags.includes('routine') || tags.includes('transient')) {
    return { pass: false, level: gradeByTags(3, tags).level, tags, why: '寒暄或一次性事件，不该进核层' };
  }
  const graded = gradeByTags(3, tags);
  if (graded.level < minLevel) {
    return { pass: false, level: graded.level, tags, why: `级别 ${graded.level} 低于准入门槛 ${minLevel}` };
  }
  return { pass: true, level: graded.level, tags, why: graded.why };
}
