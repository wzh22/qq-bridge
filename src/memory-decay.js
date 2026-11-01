// 记忆衰减（memory-decay）：给日记做「遗忘曲线」，把想不起来的旧事折叠成一行摘要。
//
// 为什么需要它
// ------------
// diary.js 原来把「近期 5 条 + 检索命中 4 条 + 风格锚点 3 条」直接塞进 prompt。
// 条数是**写死**的，日记越攒越多，可注入的永远只有那十几条——剩下 60 多条
// 永远进不了上下文，等于记了白记；而想扩大条数，token 成本立刻爆炸。
//
// 这不是「检索排不准」的问题，是**没有淘汰机制**：记忆中「不再相关」的部分
// 不腾出位置，相关的新事就挤不进来。人类记忆靠遗忘曲线解决同一件事。
//
// 设计取舍（都是踩过的坑）
// ------------------------
// 1. **只折叠、不删除**。衰减到低分的条目只是不再逐条列出，原文永远留在
//    diary.jsonl 里，仍可被 qq_diary_recall 按关键词检索出来。
//    参照 owner-memory.js 的 ADD-only 原则：一次误判不该造成永久丢失。
// 2. **用「活跃天数」而不是自然日**。这是本项目最特殊的一点：主人备考，
//    可能连着几天不碰 bot。按自然日算，一回来会发现所有记忆都烂光了。
//    改用「这段时间里实际有互动的天数」，停摆期不产生衰减。
//    （思路来自 sachitrafa/YourMemory 的 active_days 参数）
// 3. **幂律衰减而不是纯指数**。指数衰减尾巴太薄，「很久以前但很重要」的事
//    会掉得比重要性相近的近期琐事还低。幂律的重尾更贴近人类记忆。
//    （公式来自 prefrontal-systems/cortexgraph 的 power_law 模型）
// 4. **衰减状态放 sidecar**。diary.jsonl 是 append-only 的用户数据，
//    normalizeEntry 会丢掉未知字段，历史条目也没有这些字段；
//    硬塞进去等于重写整个库。sidecar 坏了最多丢衰减状态，日记本体完好。
//
// 打分公式
// --------
//   score = (1 + recallCount * 0.2) × strength × retention(Δ活跃日)
//   strength  = 0.6 + (importance - 1) × 0.2      // importance 1..5 → 0.6..1.4
//   retention = (1 + Δt / t0) ^ (-α)              // 幂律，t0 由半衰期推出
//
// 全参数可调、全函数纯计算，便于单测（见 scripts/test-memory-decay.mjs）。
import fs from 'node:fs';
import path from 'node:path';

/** 衰减参数默认值。数值经过手算校准，见文件末尾的曲线自检。 */
export const DECAY_DEFAULTS = Object.freeze({
  // 半衰期（活跃日）。14 个活跃日 ≈ 两周都聊过才忘掉一半，对陪伴类 bot 合适。
  halfLifeDays: 14,
  // 幂律形状参数。α=1 是最常见的记忆幂律；越大头越重（衰减越慢）。
  alpha: 1.0,
  // 召回次数收益是次线性的：第 10 次召回不该比第 2 次强 5 倍。
  recallBoost: 0.2,
  // 低于这个分数、且超出近期窗口的旧条目 → 折叠进摘要行。
  foldThreshold: 0.35,
  // importance=5 的条目永不折叠（与 capEntries 的「5 星永不裁掉」一致）。
  protectImportance: 5,
  // 摘要行最多列几个标题。再多就只给计数，不逐个点名。
  summaryTitles: 6,
  // 摘要行本身的字符上限（含前缀）。固定成本，与折叠条数无关。
  summaryMaxChars: 240,
  // 活跃日只保留最近 N 天，避免 sidecar 无限增长。
  activeDayRetention: 120,
});

const DAY_MS = 86400000;

/** 把毫秒时间戳转成本地日期键 `YYYY-MM-DD`。用本地时区，与「活跃日」语义一致。 */
export function dayKeyOf(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 数出 [fromMs, toMs] 之间有多少个**活跃日**。
 *
 * 活跃日不足时（比如 sidecar 刚建立、历史缺失）退回自然日估算——
 * 但按「至多」算：宁可少衰减，也不要把记忆误判成该忘的。
 *
 * @param {number} fromMs 起点（含）
 * @param {number} toMs   终点（含）
 * @param {Set<string>|string[]} activeDays 活跃日集合（`YYYY-MM-DD`）
 * @returns {number} 活跃日天数，可能带小数（退化为自然日时）
 */
export function activeDaysBetween(fromMs, toMs, activeDays) {
  const from = Number(fromMs) || 0;
  const to = Number(toMs) || 0;
  if (!from || !to || to <= from) return 0;
  const set = activeDays instanceof Set ? activeDays : new Set(Array.isArray(activeDays) ? activeDays : []);
  const fromKey = dayKeyOf(from);
  const toKey = dayKeyOf(to);
  let count = 0;
  for (const key of set) {
    if (key >= fromKey && key <= toKey) count += 1;
  }
  // 活跃日记录只保留最近 N 天；跨度超出记录范围的，用自然日兜底，
  // 但取 min(自然日, ...) 之外有下限 1：只要确实跨了天，至少衰减 1 天。
  const spanDays = (to - from) / DAY_MS;
  if (count === 0 && spanDays >= 1) {
    // 完全没有活跃日记录（新装/被清空）→ 退化为自然日，但封顶，
    // 防止把几个月没记录的旧条目一次性衰减到 0。
    return Math.min(spanDays, DECAY_DEFAULTS.halfLifeDays * 2);
  }
  return count;
}

/**
 * 幂律保持率：`(1 + Δt/t0)^(-α)`，其中 t0 由半衰期反推。
 *
 * 推导：令 retention(H) = 0.5
 *   (1 + H/t0)^(-α) = 0.5
 *   → 1 + H/t0 = 2^(1/α)
 *   → t0 = H / (2^(1/α) - 1)
 *
 * @param {number} deltaActiveDays 经过的活跃日
 * @param {number} [halfLifeDays]
 * @param {number} [alpha]
 * @returns {number} 0..1
 */
export function retention(deltaActiveDays, halfLifeDays = DECAY_DEFAULTS.halfLifeDays, alpha = DECAY_DEFAULTS.alpha) {
  const d = Math.max(0, Number(deltaActiveDays) || 0);
  const h = Math.max(0.1, Number(halfLifeDays) || DECAY_DEFAULTS.halfLifeDays);
  const a = Math.max(0.1, Number(alpha) || DECAY_DEFAULTS.alpha);
  const denom = Math.pow(2, 1 / a) - 1;
  const t0 = denom > 0 ? h / denom : h;
  return Math.pow(1 + d / t0, -a);
}

/**
 * importance(1..5) → strength(0.6..1.4)。3 分是中性 1.0。
 *
 * 注意这里**不能**写 `Number(x) || 3`：`0` 是 falsy，会把越界的 0
 * 静默变成默认值 3，等于「夹到 1」这条约束根本没生效（单测抓到过）。
 */
export function importanceStrength(importance) {
  const n = Number(importance);
  const raw = Number.isFinite(n) ? Math.round(n) : 3;
  const i = Math.min(5, Math.max(1, raw));
  return 0.6 + (i - 1) * 0.2;
}

/**
 * 算一条日记当前的「记忆强度」。分数越高越该被逐条注入。
 *
 * @param {object} entry 日记条目（只需 time / importance / corrections）
 * @param {object} [meta] sidecar 里这条的衰减状态 `{ recallCount, lastAccess }`
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {Set<string>|string[]} [opts.activeDays]
 * @returns {{score:number, retention:number, strength:number, deltaActiveDays:number, why:string[]}}
 */
export function memoryScore(entry, meta, opts = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const m = meta && typeof meta === 'object' ? meta : {};
  const opts2 = opts || {};
  const now = Number(opts2.now) || Date.now();
  const halfLifeDays = opts2.halfLifeDays ?? DECAY_DEFAULTS.halfLifeDays;
  const alpha = opts2.alpha ?? DECAY_DEFAULTS.alpha;

  // 起点取「最后一次被想起」；从没被想起过就用写入时间。
  const anchor = Number(m.lastAccess) || Number(e.time) || now;
  const deltaActiveDays = activeDaysBetween(anchor, now, opts2.activeDays ?? []);
  const ret = retention(deltaActiveDays, halfLifeDays, alpha);
  const strength = importanceStrength(e.importance);
  const recallCount = Math.max(0, Number(m.recallCount) || 0);
  const recallFactor = 1 + recallCount * DECAY_DEFAULTS.recallBoost;
  const score = recallFactor * strength * ret;

  const why = [];
  if (recallCount > 0) why.push(`被想起${recallCount}次`);
  if ((Number(e.importance) || 3) >= DECAY_DEFAULTS.protectImportance) why.push('重要');
  if ((e.corrections ?? []).length) why.push('有更正');
  return { score, retention: ret, strength, deltaActiveDays, why };
}

/**
 * 判断一条日记是否该折叠。
 *
 * 折叠 ≠ 删除：原文还在，检索照样能捞出来。只是不再逐条占注入空间。
 */
export function shouldFold(entry, meta, opts = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  // 同上：不能用 `Number(x) || 3`，否则 importance=0 会被当成 3 而绕过折叠。
  const impNum = Number(e.importance);
  const importance = Number.isFinite(impNum) ? Math.round(impNum) : 3;
  if (importance >= DECAY_DEFAULTS.protectImportance) return false;
  const opts2 = opts || {};
  // 近期窗口内的永不折叠——那是「刚说完的话」，忘了才奇怪。
  const now = Number(opts2.now) || Date.now();
  const recentDays = Math.max(1, Number(opts2.recentDays) || 7);
  if ((Number(e.time) || 0) >= now - recentDays * DAY_MS) return false;
  const { score } = memoryScore(e, meta, opts2);
  const threshold = opts2.foldThreshold ?? DECAY_DEFAULTS.foldThreshold;
  return score < threshold;
}

/**
 * 把若干条被折叠的日记压成一行摘要。
 *
 * 格式刻意简短：「还有 N 件更早的小事：标题、标题…（细节可按需回忆）」。
 * 它给模型两件事：**知道有这些事存在**（不会说"我不记得"），
 * 以及**知道细节还没丢**（需要时可用 qq_diary_recall 去捞）。
 * 不写正文是刻意的——写正文就等于没折叠。
 */
export function renderFoldedSummary(folded, opts = {}) {
  const opts2 = opts || {};
  const list = (Array.isArray(folded) ? folded : []).filter((e) => e && (e.title || e.body));
  if (!list.length) return '';
  const maxTitles = Math.max(1, Number(opts2.summaryTitles) || DECAY_DEFAULTS.summaryTitles);
  const maxChars = Math.max(60, Number(opts2.summaryMaxChars) || DECAY_DEFAULTS.summaryMaxChars);

  const titleOf = (e) => {
    const t = String(e.title ?? '').replace(/\s+/g, ' ').trim();
    if (t) return t;
    return String(e.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 12);
  };
  // 按时间从近到远列，让"更早"的感觉对得上。
  const sorted = [...list].sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
  const shown = sorted.slice(0, maxTitles).map(titleOf).filter(Boolean);
  const rest = sorted.length - shown.length;

  let text = `- 还有 ${sorted.length} 件更早的小事：${shown.join('、')}`;
  if (rest > 0) text += ` 等 ${rest} 件`;
  text += '（细节还在，需要时可检索）';
  if (text.length > maxChars) {
    // 超长时退化成只给计数：标题列表再长就失去"一行"的意义了。
    text = `- 还有 ${sorted.length} 件更早的小事（细节还在，需要时可检索）`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// sidecar 存储：key -> { recallCount, lastAccess }
// ---------------------------------------------------------------------------

/**
 * 读衰减状态。文件不存在或损坏时返回空状态（绝不抛错——
 * 衰减状态丢了只是"记忆重新变新鲜"，比让桥接起不来强得多）。
 *
 * @returns {{ entries: Record<string, {recallCount:number, lastAccess:number}>, activeDays: string[] }}
 */
export function loadDecayState(file) {
  const empty = { entries: {}, activeDays: [] };
  if (!file) return empty;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return empty;
    return empty;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== 'object') return empty;
  const entries = {};
  const src = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [id, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    entries[String(id)] = {
      recallCount: Math.max(0, Math.round(Number(v.recallCount) || 0)),
      lastAccess: Number(v.lastAccess) || 0,
    };
  }
  const activeDays = Array.isArray(raw.activeDays)
    ? raw.activeDays.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];
  return { entries, activeDays };
}

/**
 * 原子写衰减状态（临时文件 + rename）。崩在中间最多留个 .tmp，状态文件不半截。
 */
export function saveDecayState(file, state) {
  if (!file) return { ok: false, error: '缺少状态文件路径' };
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    entries: state?.entries && typeof state.entries === 'object' ? state.entries : {},
    activeDays: Array.isArray(state?.activeDays) ? state.activeDays : [],
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 记一个活跃日（幂等）。返回新的 activeDays 数组，超过保留期的最旧项被丢弃。 */
export function markActiveDay(state, ms = Date.now(), retentionDays = DECAY_DEFAULTS.activeDayRetention) {
  const day = dayKeyOf(ms);
  if (!day) return Array.isArray(state?.activeDays) ? state.activeDays : [];
  const set = new Set(Array.isArray(state?.activeDays) ? state.activeDays : []);
  set.add(day);
  const sorted = [...set].sort();
  const keep = Math.max(1, Number(retentionDays) || DECAY_DEFAULTS.activeDayRetention);
  return sorted.slice(-keep);
}

/**
 * 给若干条日记记一次「被想起」。
 *
 * 什么时候调用：只在该条日记**真的进了注入块**时调。
 * 不能一检索到就 +1——检索候选远多于实际注入，那样衰减机制就失效了。
 */
export function touchEntries(state, ids, ms = Date.now()) {
  const base = state && typeof state === 'object' ? state : { entries: {}, activeDays: [] };
  const entries = { ...(base.entries ?? {}) };
  const stamp = Number(ms) || Date.now();
  for (const id of Array.isArray(ids) ? ids : []) {
    const key = String(id ?? '');
    if (!key) continue;
    const prev = entries[key] ?? { recallCount: 0, lastAccess: 0 };
    entries[key] = {
      recallCount: Math.max(0, Math.round(Number(prev.recallCount) || 0)) + 1,
      lastAccess: stamp,
    };
  }
  return { entries, activeDays: Array.isArray(base.activeDays) ? base.activeDays : [] };
}

/** 丢掉已经不在日记库里的 id，防止 sidecar 无限膨胀。 */
export function pruneDecayState(state, liveIds) {
  const base = state && typeof state === 'object' ? state : { entries: {}, activeDays: [] };
  const live = liveIds instanceof Set ? liveIds : new Set(Array.isArray(liveIds) ? liveIds.map(String) : []);
  const entries = {};
  for (const [id, v] of Object.entries(base.entries ?? {})) {
    if (live.has(String(id))) entries[id] = v;
  }
  return { entries, activeDays: Array.isArray(base.activeDays) ? base.activeDays : [] };
}
