/**
 * 跨会话关系记忆（relational memory）——「她跟每个人的相处史」。
 *
 * ── 这个模块解决什么 ────────────────────────────────────────────────────
 *
 * 已有三层记忆，但各管一段：
 *   inner-life.js   她**自己**的生活（种地、爬塔、看海）—— 跨会话共享
 *   style-sync.js   **怎么说**（别用某个梗、短一点）—— 跨会话共享
 *   diary.js        日记 —— 按 key 严格隔离，各人一本，互不可见
 *
 * 缺的是：**她跟某个具体的人相处到哪一步了**。
 * 现在每次开会话，她都像第一次见这个人 —— 不记得跟对方熟不熟、聊过哪类话题、
 * 上次是什么气氛收的尾。这不是隐私问题，是「没有关系连续性」。
 *
 * ── 与「跨对象转述」的区别（这条是硬界线）────────────────────────────────
 *
 * 本模块存的是**她自己的关系状态**，不是对方的原话：
 *   ✅ 允许：「跟…1798 聊过 12 次，熟络；常聊技术、备考；上次聊得挺开心」
 *   ❌ 禁止：「他昨天说膝盖疼」「他说要卸载语音插件」
 *
 * 换句话说：可以记「我们聊过什么类别」，不能记「他说了什么」。
 * 后者仍然只在对方自己的会话里，由 diary.js 按 key 隔离。
 *
 * ── 为什么代码要再做一道闸（不只是靠提示词）────────────────────────────
 *
 * 参照 owner-inbox.js 的教训：只写进 prompt 的「只输出概括」迟早会被模型的
 * 顺手引用击穿。所以落盘前逐条检查与原始消息的重合度，命中就丢。
 * 提示词是第一道防线，代码是第二道，缺一不可。
 *
 * ── 和 existing 的关系 ─────────────────────────────────────────────────
 *
 * 不替代 diary / owner-memory / style-sync，只补「关系维度」。
 * 关掉它（cfg.relationalMemory.enabled=false）不影响上述任何一层。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 上限（防止无限膨胀，也防止把上下文撑爆）──────────────────────────────
/** 每个对象最多保留多少条关系信号（超出丢最旧的低权重）。 */
export const MAX_SIGNALS_PER_PERSON = 12;
/** 最多跟踪多少个人/群。 */
export const MAX_PERSONS = 60;
/** 单条信号文本上限。 */
const SIGNAL_MAX = 80;
/** 关系摘要注入上限（字符）。 */
const INJECT_MAX_CHARS = 600;

/** 熟悉度的自然衰减半衰期（天）。久不联系会慢慢变陌生，符合真实关系。 */
const FAMILIARITY_HALF_LIFE_DAYS = 45;

const MOOD_LABELS = {
  warm: '聊得挺开心',
  calm: '平常',
  tense: '有点僵',
  brief: '没说几句'
};

function clip(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) : str;
}

// ── 话题词表（受控，不是自由文本）─────────────────────────────────────────
//
// 为什么用固定词表而不是让模型自由总结：
//   1. 自由总结必然带出原文细节，那是隐私事故的主要来源；
//   2. 词表命中是**确定性的**，可单测、可解释、零推理成本；
//   3. 注入时只需「常聊技术、备考」几个字，本来也不需要更细。
//
// 词表按这个人的实际生活范围设计（备考/游戏/技术/生活），
// 漏判的后果只是少记一个标签，不会记错 —— 这个方向的误差是安全的。
const TOPIC_VOCAB = Object.freeze([
  ['备考', ['联考', '备考', '复习', '考试', '行测', '申论', '报名', '上岸', '刷题']],
  ['技术', ['代码', '编程', '脚本', '配置', '部署', '模型', '插件', '接口', '报错', '调试', '服务器', 'token']],
  ['游戏', ['游戏', '我的世界', '杀戮尖塔', '联机', '打游戏', 'steam', '爬塔']],
  ['语音', ['语音', '声音', '音色', 'TTS', '念', '唱']],
  ['记忆', ['记忆', '日记', '想起', '记得', '忘记', '上下文']],
  ['跑步', ['跑步', '长跑', '跑操', '体测', '膝盖', '跑一千']],
  ['吃饭', ['吃', '饭', '炒面', '煎饼', '甜筒', '外卖', '食堂']],
  ['作息', ['睡', '熬夜', '困', '起床', '午睡', '晚安']],
  ['情绪', ['难受', '开心', '烦', '压力', '焦虑', '累', '委屈']],
  ['日常', ['上课', '宿舍', '学校', '回家', '天气', '冷', '热']]
]);

/**
 * 从一批消息里推断话题标签。
 *
 * 只看有没有命中词，不看上下文语义 —— 这是刻意的：
 * 语义理解需要模型，而模型会顺手把原话带出来。词表够用且绝对安全。
 */
export function inferTopics(texts) {
  const hay = String(Array.isArray(texts) ? texts.join(' ') : texts ?? '').toLowerCase();
  if (!hay) return [];
  const out = [];
  for (const [tag, words] of TOPIC_VOCAB) {
    if (words.some((w) => hay.includes(String(w).toLowerCase()))) out.push(tag);
  }
  return out.slice(0, 4);
}

/**
 * 推断这次互动的气氛。
 *
 * 同样是确定性规则。判不出来的默认 calm —— 宁可不猜。
 */
export function inferMood(texts) {
  const hay = String(Array.isArray(texts) ? texts.join(' ') : texts ?? '');
  if (!hay) return '';
  const warm = /(哈哈|笑死|好玩|太好了|谢谢|喜欢|开心|可爱|厉害|棒|赞)/;
  // 注意把「紧张」也算进 tense：备考场景里它是最常见的负面情绪，
  // 漏了它会让「考试好紧张」被误判成平静。
  const tense = /(烦|难受|生气|吵|算了|无语|不想|紧张|压力|累|焦虑|担心)/;
  const brief = hay.replace(/\s+/g, '').length <= 6;
  if (tense.test(hay)) return 'tense';
  if (warm.test(hay)) return 'warm';
  if (brief) return 'brief';
  return 'calm';
}

/**
 * 记一次互动 + 顺便推断话题与气氛。
 *
 * 这是 bridge 实际调用的入口：把「记账」和「推断标签」合成一步，
 * 避免调用方漏掉其中之一（漏了记账，熟悉度就永远是 0）。
 *
 * rawTexts 只参与推断，**不落盘**；落盘的是固定词表标签。
 */
export function recordMessage(store, key, { texts = [], label = '' } = {}) {
  const r = noteInteraction(store, key, { label, topics: [], mood: '' });
  if (!r.ok) return r;
  const topics = inferTopics(texts);
  const mood = inferMood(texts);
  const p = store.data.persons[String(key).trim()];
  if (p) {
    for (const t of topics) p.topics[t] = num(p.topics[t]) + 1;
    if (mood && MOOD_LABELS[mood]) p.moods[mood] = num(p.moods[mood]) + 1;
  }
  return { ok: true, topics, mood };
}

/**
 * 用会话最近的若干条消息，给关系记忆补一次话题与气氛（不重复计数互动）。
 *
 * 用于「事后回填」：比如一个会话聊完，用整段素材补一次更完整的标签。
 */
export function enrichFromMessages(store, key, { texts = [], label = '' } = {}) {
  const k = String(key ?? '').trim();
  if (!k || !store.data.persons[k]) return { ok: false, error: 'person 不存在' };
  const topics = inferTopics(texts);
  const mood = inferMood(texts);
  const p = store.data.persons[k];
  for (const t of topics) p.topics[t] = num(p.topics[t]) + 1;
  if (mood && MOOD_LABELS[mood]) p.moods[mood] = num(p.moods[mood]) + 1;
  if (label) p.label = clip(label, 24);
  return { ok: true, topics, mood };
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function nowMs() {
  return Date.now();
}

/**
 * 熟悉度衰减：久不联系 -> 变回「生」。指数衰减，45 天减半。
 * 这条很重要 —— 否则三年前聊过一次的人会一直显示「很熟」。
 */
export function decayFactor(lastAt, at = nowMs()) {
  const last = num(lastAt);
  if (!last) return 0;
  const days = Math.max(0, (at - last) / 86400000);
  return Math.pow(0.5, days / FAMILIARITY_HALF_LIFE_DAYS);
}

/**
 * 把「聊了多少次 + 多久没聊」换算成 0~1 的熟悉度。
 *
 * 用 log1p 做软饱和：聊 3 次和聊 4 次差别明显，聊 300 次和 301 次几乎没差。
 */
export function familiarityScore(person, at = nowMs()) {
  const n = num(person?.interactions);
  if (n <= 0) return 0;
  const base = Math.log1p(n) / Math.log1p(30); // 30 次约到 1.0
  return Math.min(1, base) * decayFactor(person?.lastAt, at);
}

function familiarityLabel(score) {
  if (score >= 0.75) return '很熟';
  if (score >= 0.5) return '比较熟';
  if (score >= 0.25) return '认识';
  if (score > 0) return '还不太熟';
  return '陌生';
}

// ── 隐私闸门 ────────────────────────────────────────────────────────────

/**
 * 绝不允许出现在关系记忆里的内容特征。
 *
 * 和 style-sync 的白名单思路一致：宁可漏记，不可误存。
 * 这些模式一旦命中，整条信号丢弃（不是打码，是丢弃 —— 打码后仍可能残留语义）。
 */
const FORBIDDEN_PATTERNS = [
  // 直接引语 / 转述标记。
  // 注意这里要拦**短句**：「他说：膝盖很疼」只有 7 个字，
  // 用「.{2,}」+「[。！？]$」的组合会漏（末尾没有标点）。
  // 所以改成「有人说 说他/她/你 + 冒号或引言」或「含成对引号」都算复述。
  /["“”「」『』].{1,}["“”「」『』]/,
  /(他说|她说|说你|说我|他说过|跟我说|告诉我|原话)[:：、]?/,
  /(说|讲|提到|说的是)[:：]/,
  // 联系方式与身份
  /\d{6,}/,                          // 长数字（QQ 号、手机号、身份证）
  /\d{4}[-年]\d{1,2}[-月]\d{1,2}/,   // 具体日期
  /(电话|手机|微信|身份证|地址|住址|门牌|学号|密码)/,
  // 健康 / 财务 / 家庭这类敏感事实
  /(生病|住院|手术|确诊|抑郁|焦虑症|欠债|借钱|工资|收入|分手|离婚|吵架|膝盖|疼|痛|药)/,
  // 主人的具体安排
  /(计划|准备|打算)(要|去|在)?/
];

/** 长度很短的原文窗口，用来做重合度检测。 */
function shingles(text, size = 6) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + size <= s.length; i += 1) out.add(s.slice(i, i + size));
  return out;
}

/**
 * 检查候选信号是否在「复述原话」。
 *
 * 参照 owner-inbox.js 的 leaksOriginalText：如果候选文本里的 6 字窗口
 * 有相当比例出现在原始消息里，判定为引用原文。
 * 阈值取 0.35 —— 中文 6 字连续重合已足够说明问题，再高会漏。
 */
export function leaksOriginalText(candidate, rawTexts, { threshold = 0.35 } = {}) {
  const cand = shingles(candidate);
  if (cand.size === 0) return false;
  const hay = String(Array.isArray(rawTexts) ? rawTexts.join('\n') : rawTexts ?? '').replace(/\s+/g, '');
  if (!hay) return false;
  let hit = 0;
  for (const sh of cand) if (hay.includes(sh)) hit += 1;
  return hit / cand.size >= threshold;
}

/**
 * 净化一条候选信号。返回 null 表示丢弃。
 * 第二道闸：提示词让模型不要写原话，这里再按代码判一次。
 */
export function sanitizeSignal(candidate, rawTexts = []) {
  const text = clip(candidate, SIGNAL_MAX);
  if (!text) return null;
  if (text.length < 2) return null;
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(text)) return null;
  }
  if (leaksOriginalText(text, rawTexts)) return null;
  return text;
}

// ── 存储 ────────────────────────────────────────────────────────────────

export function createStore(file) {
  return {
    file,
    data: { version: 1, persons: {}, updatedAt: 0 }
  };
}

export function loadStore(store, { onCorrupt } = {}) {
  try {
    if (!fs.existsSync(store.file)) return store;
    const raw = fs.readFileSync(store.file, 'utf8');
    if (!raw.trim()) return store;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.persons && typeof obj.persons === 'object') {
      store.data = {
        version: num(obj.version, 1),
        persons: obj.persons,
        updatedAt: num(obj.updatedAt)
      };
    }
  } catch (error) {
    // 损坏不覆盖：这条路和 diary/owner-memory 一致，宁可这次不记，也不能把历史冲掉
    if (typeof onCorrupt === 'function') onCorrupt(error?.message ?? String(error));
  }
  return store;
}

export function saveStore(store) {
  try {
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    store.data.updatedAt = nowMs();
    const tmp = `${store.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store.data, null, 2), 'utf8');
    fs.renameSync(tmp, store.file);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/**
 * 记一次互动。
 *
 * @param {object} store
 * @param {string} key      会话 key（private:xxx / group:xxx）
 * @param {object} info
 *   @param {string} info.label       显示名（可以只是「…1798」这种脱敏形式）
 *   @param {string[]} info.topics    话题标签（必须来自受控词表，见 TOPIC_VOCAB）
 *   @param {string} info.mood        warm|calm|tense|brief
 *   @param {string[]} info.rawTexts  该次会话的原始消息，仅用于重合度检测，**不落盘**
 */
export function noteInteraction(store, key, info = {}) {
  const k = String(key ?? '').trim();
  if (!k) return { ok: false, error: '缺少会话 key' };

  const now = nowMs();
  const persons = store.data.persons;
  let p = persons[k];
  if (!p) {
    // 超出上限时，淘汰熟悉度最低的那个
    if (Object.keys(persons).length >= MAX_PERSONS) {
      let worst = null;
      let worstScore = Infinity;
      for (const [pk, pv] of Object.entries(persons)) {
        const s = familiarityScore(pv, now);
        if (s < worstScore) {
          worstScore = s;
          worst = pk;
        }
      }
      if (worst) delete persons[worst];
    }
    p = { label: '', interactions: 0, firstAt: now, lastAt: 0, signals: [], topics: {}, moods: {} };
    persons[k] = p;
  }

  p.interactions = num(p.interactions) + 1;
  p.lastAt = now;
  if (!p.firstAt) p.firstAt = now;
  if (info.label) p.label = clip(info.label, 24);

  // 话题计数（受控词表，不是自由文本）
  for (const t of Array.isArray(info.topics) ? info.topics : []) {
    const tag = clip(t, 12);
    if (tag) p.topics[tag] = num(p.topics[tag]) + 1;
  }

  // 气氛计数
  const mood = String(info.mood ?? '');
  if (MOOD_LABELS[mood]) p.moods[mood] = num(p.moods[mood]) + 1;

  // 可选：一条净化过的关系信号
  if (info.signal) {
    const clean = sanitizeSignal(info.signal, info.rawTexts ?? []);
    if (clean) {
      p.signals.push({ text: clean, at: now });
      if (p.signals.length > MAX_SIGNALS_PER_PERSON) {
        p.signals = p.signals.slice(-MAX_SIGNALS_PER_PERSON);
      }
    }
  }

  return { ok: true, person: p };
}

/** 只保留出现次数最多的话题，避免噪音。 */
function topTopics(p, n = 3) {
  return Object.entries(p?.topics ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t]) => t);
}

function topMood(p) {
  const entries = Object.entries(p?.moods ?? {}).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries[0][0] : '';
}

/** 这个人对外的称呼：(脱敏标签或后四位) */
function displayLabel(key, p) {
  if (p?.label) return p.label;
  const m = /^(group|private):(\d+)$/.exec(String(key ?? ''));
  if (!m) return String(key ?? '');
  const tail = m[2].slice(-4);
  return m[1] === 'group' ? `群…${tail}` : `…${tail}`;
}

/**
 * 生成注入给模型的「关系记忆」段落。
 *
 * @param {object} store
 * @param {string} selfKey 当前会话 key（用来标出「这一个就是现在跟你说话的」）
 * @param {number} maxChars
 */
export function renderRelationalBlock(store, selfKey = '', { maxChars = INJECT_MAX_CHARS, maxPersons = 6 } = {}) {
  const now = nowMs();
  const persons = Object.entries(store.data.persons ?? {})
    .map(([k, p]) => ({ key: k, p, fam: familiarityScore(p, now) }))
    .filter((x) => x.fam > 0.02)
    .sort((a, b) => b.fam - a.fam)
    .slice(0, maxPersons);

  if (!persons.length) return '';

  const lines = [];
  for (const { key, p, fam } of persons) {
    const isSelf = key === selfKey;
    const label = displayLabel(key, p);
    const bits = [];
    bits.push(`${p.interactions} 次`);
    bits.push(familiarityLabel(fam));
    const topics = topTopics(p, 2);
    if (topics.length) bits.push(`常聊${topics.join('、')}`);
    const mood = topMood(p);
    if (mood && MOOD_LABELS[mood]) bits.push(MOOD_LABELS[mood]);

    // 最近一条净化过的信号（如果有）
    const last = Array.isArray(p.signals) && p.signals.length ? p.signals[p.signals.length - 1].text : '';
    const tail = last ? `；${last}` : '';
    lines.push(`- ${label}${isSelf ? '（就是现在这位）' : ''}：${bits.join('，')}${tail}`);
  }

  let body = lines.join('\n');
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}…`;

  return [
    '【你与这些人的相处史】',
    '下面是**你自己的**印象（不是他们说过的话），说话时自然带出，别逐条念、别当成档案念给他听：',
    body
  ].join('\n');
}

export { MOOD_LABELS };
/** 话题词表对外开放一份只读引用，供测试校验「不会在运行时被改」。 */
export const TOPIC_VOCAB_EXPORTED = TOPIC_VOCAB;
