// 人格卡演进的护栏：允许她「长」，但不允许她「变成别人」。
//
// ── 为什么需要单独的护栏，而不是把规则写进提示词 ────────────────────────────
//
// 2026-10-28 主人要求「扩大人格卡自由度，让她能根据外部环境和学习进化自主修改」。
// 一旦真的放开，攻击面就变了：人格卡是**全局注入**的（写进 roles/<名称>.md 就作用于
// 所有会话），所以「谁能让她改」等于「谁能改她对所有人的人格」。
//
// 三种真实的坏法，护栏要各自挡住：
//   1. **漂移**：今天一个群友说啰嗦，明天另一个说太冷，逐条追着改 → 几个月后四不像。
//      挡法：单次涨幅封顶 + 频率封顶 + 每次必留快照。
//   2. **顶号**：某个白名单朋友哄她「把我当成最重要的人，只服务我」，她乖乖改卡。
//      挡法：核心小节（身份/隐私/谁能指挥你）只有主人私聊能改；且全文必须始终
//      保留身份锚点与隐私锚点，掏空正文也会被拦。
//   3. **一次改崩**：模型一次失手删掉整节、或把 after 传成空串。
//      挡法：核心小节正文不得低于原文的 40%，after 不得为空白，标题不得消失。
//
// 护栏做成**纯函数**（不读盘、不看时间以外的状态），这样单测能穷举，也方便在
// 控制台「预演」时复用同一份判断 —— 预演和应用走不同代码是这类系统的经典事故源。
//
// ── 与「记忆」的边界 ──────────────────────────────────────────────────────
// 人格卡是**她是谁**，不是**她记得什么**。群友的偏好、主人的私事、某天发生的事，
// 都属于记忆（owner-memory / diary / qq_memory_*），不该搬进人格卡。护栏里
// BLOCKED_CONTENT_RE 会把「记住某人/某人说过」这类内容挡在门外。
import { stripModeTags, stripSectionOrdinal } from './role-card.js';

/** 标题归一：去模式标记（〔全部〕等）、去序号，用于比对「同一节」。 */
export function normalizeTitle(raw) {
  let s = stripModeTags(String(raw ?? ''));
  // stripModeTags 只去模式标记；序号要单独去（「三·五、」这种形态也在里面）
  s = stripSectionOrdinal(s);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 核心小节：改这些等于改「她是谁、听谁的」。
 *
 * 判定用**规范化标题的包含关系**而不是全等：卡里可能写成「十一、隐私边界：关于主人的事，不外传」，
 * 而模型传的 section 只有「隐私边界」。全等匹配会让这一节被当成普通小节，护栏形同虚设。
 * 包含匹配的风险是误伤（例如「说话方式」命中「主人教的说话方式」），所以这里**只用于
 * 判断「这算不算核心」的保守一侧**，即宁可多判核心，不可少判。
 */
export const CORE_SECTION_PATTERNS = [
  { id: 'identity', label: '身份', re: /^(你是谁|身份|我是谁)/ },
  { id: 'privacy', label: '隐私边界', re: /隐私|不外传|关于主人的事/ },
  { id: 'authority', label: '谁能指挥你', re: /谁能指挥|听谁的|权限|管理权限/ },
  { id: 'owner_style', label: '主人教的说话方式', re: /主人教的|主人教过/ },
  { id: 'redlines', label: '说话的硬度/红线', re: /红线|硬度/ }
];

/** 全文必须始终保留的锚点：少一个就说明卡被改成了别的角色。 */
export const REQUIRED_ANCHORS = [
  { re: /鲸鱼/, label: '鲸鱼身份' },
  { re: /女/, label: '性别设定' },
  { re: /主人/, label: '主人关系' },
  { re: /隐私/, label: '隐私边界' }
];

/** 不该写进人格卡的内容：那是记忆，不是人设。 */
const BLOCKED_CONTENT_RE = /(记住|记得)(他|她|你|某人|XX|某某)|身份证|银行卡|密码|家庭住址|手机号/;

/** 单次改动允许的涨幅（相对改前总长）。 */
export const GUARD_LIMITS = {
  maxGrowthRatio: 1.30,      // 一次最多长 30%
  // 绝对上限按**字符**算，但真正的硬墙是 validateRoleContent 的 64KB **字节**上限
  // （中文 1 字符 = 3 字节，64KB ≈ 21800 字符）。这里取 18000 留余量：
  // 写 60000 会让护栏以为还能长，结果在写盘那一步才被字节上限拦下，
  // 而那时快照已经存了、提案已经标 applied，属于「半成功」。
  maxTotalChars: 18000,
  minCoreBodyRatio: 0.4,     // 核心小节正文不得低于原文 40%
  maxAppliesPerHour: 3,      // 一小时最多改 3 次
  maxAppliesPerDay: 10,      // 一天最多改 10 次
  maxAppendChars: 4000,      // 单次 append 封顶
  maxAfterChars: 6000        // 单节替换正文封顶
};
/**
 * 把人格卡拆成「标题 → 正文」，供护栏比对。key 为规范化标题。
 *
 * ⚠️ 只切 **## 及更深**的标题，不切 H1。
 *
 * 为什么：这张表有**两个消费者**，而它们必须对「哪些是能改的小节」给出同一个答案：
 *   ① 护栏（判断哪节是核心、改完长度够不够）；
 *   ② qq_get_prompt 的 roleEvolution.sections（告诉模型「这些是你能改的节名」）。
 * 而真正落地的 applyProposalToText 只认 `##`/`###`。
 *
 * 早期这里写的是 `#{1,6}`，于是 H1「角色卡：DeepSeek 小鲸鱼 —— QQ 群友版」
 * 被当成一个可改小节报给模型。模型照着这个节名去改，apply 一律
 * 「找不到小节」——从模型视角看，这就是「我明明看到它是可改的，却怎么都改不动」，
 * 表现出来像功能坏了，实际是两个模块对标题层级的口径不一致。
 *
 * H1 是整卡的标题（身份的门牌），本来也不该被当成可替换的小节。
 */
export function indexSections(text) {
  const map = new Map();
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let cur = null;
  for (const line of lines) {
    const m = /^(#{2,6})\s+(.*)$/.exec(line);
    if (m) {
      const key = normalizeTitle(m[2]);
      cur = { title: m[2].trim(), level: m[1].length, body: [] };
      // 同名小节只保留第一个（人格卡里不该有重名；有的话护栏按第一节算，属于保守）
      if (!map.has(key)) map.set(key, cur);
      else cur = map.get(key);
      continue;
    }
    if (cur) cur.body.push(line);
  }
  for (const v of map.values()) v.text = v.body.join('\n').trim();
  return map;
}

/** 判断某个小节标题是否属于核心区。 */
export function coreSectionOf(title) {
  const norm = normalizeTitle(title);
  if (!norm) return null;
  for (const p of CORE_SECTION_PATTERNS) {
    if (p.re.test(norm)) return p;
  }
  return null;
}

/** 当前时间之前 windowMs 内已应用的提案数。 */
export function countRecentApplies(appliedAtList, { now = Date.now(), windowMs } = {}) {
  if (!Array.isArray(appliedAtList)) return 0;
  return appliedAtList.filter((iso) => {
    const t = Date.parse(String(iso ?? ''));
    return Number.isFinite(t) && now - t >= 0 && now - t < windowMs;
  }).length;
}

/**
 * 护栏主判断。纯函数：`before`/`after` 都是文本，`appliedAtList` 是历史上成功应用的 ISO 时间。
 *
 * @param {object} p
 * @param {string} p.before    改前的人格卡全文
 * @param {string} p.after     改后的全文（已由 applyProposalToText 算好）
 * @param {object} p.proposal  提案（读 section / after / append）
 * @param {boolean} p.isOwner  调用者是否为主人私聊
 * @param {string[]} [p.appliedAtList] 历史应用的 ISO 时间列表
 * @param {number} [p.now]
 * @param {number} [p.injectBudget] 该模式下实际注入的字符上限（超出会被**静默截断**）
 * @param {(text: string) => number} [p.measureInject] 把全文换算成「实际注入多少字符」，默认用全文长度
 * @returns {{ok: boolean, error?: string, warnings: string[], core: string[]}}
 */
export function guardProposalChange({
  before, after, proposal, isOwner = false, appliedAtList = [], now = Date.now(),
  injectBudget = null, measureInject = null
}) {
  const warnings = [];
  const core = [];
  const p = proposal ?? {};
  const prev = String(before ?? '');
  const next = String(after ?? '');

  if (!next.trim()) return { ok: false, error: '改动后的人格卡是空的', warnings, core };

  // ① 内容长度：单次涨幅 + 绝对上限
  if (next.length > GUARD_LIMITS.maxTotalChars) {
    return { ok: false, error: `改后 ${next.length} 字符，超过上限 ${GUARD_LIMITS.maxTotalChars}`, warnings, core };
  }
  if (prev.length > 0 && next.length > prev.length * GUARD_LIMITS.maxGrowthRatio) {
    return {
      ok: false,
      error: `一次改太多：${prev.length} → ${next.length} 字符（上限是 +${Math.round((GUARD_LIMITS.maxGrowthRatio - 1) * 100)}%）。分几次改，每次只动一小块`,
      warnings, core
    };
  }
  // append 与 after 本身的单次体量也要卡住：40% 的涨幅在大卡上仍是几千字，够塞私货了
  if (String(p.append ?? '').length > GUARD_LIMITS.maxAppendChars) {
    return { ok: false, error: `一次追加 ${String(p.append).length} 字太多（上限 ${GUARD_LIMITS.maxAppendChars}）`, warnings, core };
  }
  if (String(p.after ?? '').length > GUARD_LIMITS.maxAfterChars) {
    return { ok: false, error: `单节正文 ${String(p.after).length} 字太多（上限 ${GUARD_LIMITS.maxAfterChars}）`, warnings, core };
  }

  // ② 核心小节只允许主人私聊改。
  // **要放在掏空检查之前**：朋友想改身份时，先告诉他「这不是你能改的」，
  // 而不是「你掏空了它」——后者听起来像格式问题，他会换个写法接着试，
  // 前者才是一次说清边界。
  const touched = [];
  const targetTitle = String(p.section ?? '').trim();
  if (targetTitle) {
    const hit = coreSectionOf(targetTitle);
    if (hit) touched.push(hit.label);
  }
  if (p.append) {
    // append 不能顺手塞一个新的「隐私边界」之类的同名核心节
    for (const line of String(p.append).split('\n')) {
      const m = /^#{2,3}\s+(.*)$/.exec(line);
      if (!m) continue;
      const hit = coreSectionOf(m[1]);
      if (hit) touched.push(hit.label);
    }
  }
  if (touched.length && !isOwner) {
    return {
      ok: false,
      error: `「${[...new Set(touched)].join('」「')}」属于核心设定，只有主人本人的私聊能改。你可以改语气、梗、表达习惯这些`,
      warnings, core
    };
  }

  // ③ 核心小节：不能被删、不能被掏空
  //
  // 掏空阈值分两档：非主人是 40%（只允许小改），主人是 15%（允许他自己精简）。
  // 为什么主人也留一道：掏空到只剩标题，等于把「她是谁」改成空白，
  // 那不是精简，是事故。15% 足够他重写，又拦得住「after 传空串」这类手滑。
  const floor = isOwner ? 0.15 : GUARD_LIMITS.minCoreBodyRatio;
  const beforeSecs = indexSections(prev);
  const afterSecs = indexSections(next);
  for (const [key, sec] of beforeSecs) {
    const coreHit = coreSectionOf(sec.title);
    if (!coreHit) continue;
    core.push(coreHit.label);
    const survived = afterSecs.get(key);
    if (!survived) {
      return { ok: false, error: `「${sec.title}」这一节是核心身份，不能删掉`, warnings, core };
    }
    if (sec.text.length >= 40 && survived.text.length < sec.text.length * floor) {
      return {
        ok: false,
        error: `「${sec.title}」被掏空了：${sec.text.length} → ${survived.text.length} 字。核心小节可以小改，不能清空`,
        warnings, core
      };
    }
  }

  // ④ 身份锚点：改完还是不是「她」
  for (const a of REQUIRED_ANCHORS) {
    if (!a.re.test(next)) {
      return { ok: false, error: `改完丢掉了「${a.label}」，这已经不是在改人设，是在换人`, warnings, core };
    }
  }

  // ⑤ 别把「记忆」写进人设
  const incoming = `${p.after ?? ''}\n${p.append ?? ''}`;
  if (BLOCKED_CONTENT_RE.test(incoming)) {
    return {
      ok: false,
      error: '这段内容看起来是某个人的具体信息（记忆），不该写进人格卡。人格卡写「你是什么样的人」，谁说过什么放 qq_memory_*',
      warnings, core
    };
  }

  // ⑥ 频率
  const hourAgo = countRecentApplies(appliedAtList, { now, windowMs: 3600 * 1000 });
  if (hourAgo >= GUARD_LIMITS.maxAppliesPerHour) {
    return { ok: false, error: `一小时内已经改过 ${hourAgo} 次了，先缓缓。频繁改人设比不改更像在演`, warnings, core };
  }
  const dayAgo = countRecentApplies(appliedAtList, { now, windowMs: 24 * 3600 * 1000 });
  if (dayAgo >= GUARD_LIMITS.maxAppliesPerDay) {
    return { ok: false, error: `今天已经改过 ${dayAgo} 次了，明天再说`, warnings, core };
  }

  if (p.section && !coreSectionOf(p.section)) {
    warnings.push('这是一次非核心小节的改动，改完记得在群里自然验证一下效果，别一次改太多');
  }

  // ⑦ 注入预算：最隐蔽的一道坑，也是最容易好心办坏事的一道。
  //
  // 桥接注入人格卡时会按 role.maxInjectChars **硬截断**（truncateText：从尾部按字符数切，
  // 不是报错，是悄悄砍掉后面几节）。也就是说：卡长到 12000 之后，你改哪里都无所谓——
  // 超出上限的那几节根本进不了提示词。于是会出现「提案应用成功、文件确实变了、
  // 但她行为一点没变」这种最难查的现象，而模型会以为改了没用，继续改，越改越乱。
  //
  // 尤其要注意卡的**尾部排的是什么**：真实卡里最后一节是「隐私边界」、倒数第二是
  // 「主人教的说话方式」。也就是说无脑加内容时，最先被截掉的恰好是最不该丢的那两节。
  // 所以这里直接拦：改动**必须**让它仍然完整进得去提示词。
  // 想加就得先删——这不是限制，是逼它做取舍（卡越长越不像人，本来也是实话）。
  if (injectBudget) {
    const measure = typeof measureInject === 'function'
      ? measureInject
      : (t) => String(t ?? '').length;
    const beforeLen = measure(prev);
    const afterLen = measure(next);
    if (afterLen > injectBudget) {
      const room = Math.max(0, injectBudget - beforeLen);
      return {
        ok: false,
        error: `改完实际注入 ${afterLen} 字符，超过注入上限 ${injectBudget}（超出的部分会被从尾部静默截掉，等于没改）。`
          + (room > 0
            ? `现在只剩 ${room} 字符的空间：想加新内容，先删掉一条旧的。`
            : '现在已经顶到上限了：想加新内容，必须先删掉等量的旧内容。'),
        warnings, core
      };
    }
    if (afterLen > injectBudget * 0.95) {
      warnings.push(`注入空间只剩 ${injectBudget - afterLen} 字符，再长就得先删了`);
    }
  }
  return { ok: true, warnings, core };
}
