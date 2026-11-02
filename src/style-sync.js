// 说话风格同步（style sync）模块。
//
// ## 要解决的问题
//
// 主人会在私聊里纠正 bot 的说话方式（「别用鼠鼠」「太啰嗦了」「别 AI 腔」）。
// 这些纠正原本只落在 `owner-memory` 的事实库里，而事实库**只注入主人私聊**
// （见 bridge.js 的 withSlangContext：`isOwnerPrivateSession(key)` 才注入）。
// 结果是：主人在自己窗口里教出来的说话习惯，换到别人的会话里就丢了 ——
// 同一个 bot，对不同人两套脾气。
//
// 但「学到的」里混着两种东西，绝不能一起推给所有人：
//   - **怎么写**：别用某个梗、短一点、别先肯定再否定 —— 这是说话方式，对谁都说都成立。
//   - **关于谁**：主人叫什么、在备考、住哪、计划拉人测试 —— 这是隐私，推出去就是泄漏。
//
// 本模块只负责**前者**。后者一律不进人格卡（人格卡是全局注入的，见下）。
//
// ## 为什么写人格卡就等于「同步到所有会话」
//
// 人格卡（roles/<name>.md）由 bridge.js 的 currentRoleHint() 注入，
// 而那个函数在**每次**组装 prompt 时都调用、不区分会话（L12887/L12927/L12961 等多处）。
// 所以写进人格卡 = 下一条消息起对所有会话生效，且不需要重启 DSH
// （角色卡是每次读文件、带 mtime+size 缓存，改完即生效）。
//
// ## 安全设计（这一节比上面所有内容都重要）
//
// 1. **只收紧表达，不改变立场/身份**：提炼提示词明确禁止产出「你是谁」「你和主人什么关系」
//    一类内容，并要求每条规则必须能脱离具体人成立。
// 2. **隐私词表硬拦**（PRIVACY_PATTERNS）：落盘前逐条正则过一遍，
//    命中身份/行程/计划/联系方式/称呼的候选直接丢弃。这是**代码闸门**，不是提示词约定。
// 3. **独立小节**：只写 `## 主人教的说话方式`，用整节替换语义，天然幂等、可整体回滚；
//    不会碰到原人格的其它小节。
// 4. **条数上限 + 去重**：最多 MAX_RULES 条，同一规则不重复累积，防止人格卡无限膨胀。
// 5. **可整体关闭**：cfg.styleSync.enabled = false 即停，已写入的内容不受影响。
//
// 这一层的定位是「表达习惯」；凡涉及事实、身份、关系、计划的，一律留在 owner-memory，
// 只在主人私聊里可见。

const RULE_MAX_CHARS = 60;
export const MAX_RULES = 24;
export const STYLE_SECTION_TITLE = '主人教的说话方式';

// 隐私闸门。
//
// ## 为什么从「黑名单」改成「白名单优先」
//
// 第一版是纯黑名单（PRIVACY_PATTERNS 命中即拦），用真实记忆库复测时暴露了问题：
// 句式一变就漏。例如
//   「主人要求称呼他为『老大』」→ 旧词表只认「叫主人老大」，漏
//   「主人计划让几个人加 bot 好友，用来测试」→ 旧词表只认「计划拉人」，漏
// 黑名单面对自然语言永远是「补一条漏一条」，而这个功能的失败代价是
// **把主人的私事写进全局人格卡、念给所有人听**，不可接受。
//
// 所以改成两道串联的闸门：
//   ① 白名单（STYLE_ALLOW）：必须整体读起来像一条「怎么说」的指令才放行。
//      这是主闸门 —— 拿不准的一律不进。
//   ② 黑名单（PRIVACY_PATTERNS）：即使像风格规则，只要提到主人的具体信息也拦。
//      这是兜底层，专治「别用鼠鼠」里夹一句「我是西安人」这种混合句。

// ── 主闸门：白名单 ─────────────────────────────────────────────────────────
// 一条规则必须**整句**符合「对 bot 的表达方式提要求」，且不能包含任何
// 指向具体人或具体事实的名词。
//
// 允许的形态（举例）：
//   「别用鼠鼠这个梗」「回复短一点」「别先肯定再否定」「多发表情包」
//   「语气热乎一点」「别复述我的话」「应该叫鲸鱼娘」
// 不允许：
//   「主人要求称呼他为老大」——主语是主人、讲的是他本人
//   「主人计划拉人测试」——事实陈述，不是说话方式
const STYLE_VERB = /(别|不要|不许|不准|禁止|少|多|要|应该|必须|尽量|改|换|注意|记得|统一|维持|保持|避免|忌|请|可以|不必|无需|不要总|别再|以后|下次|说话|回复|语气|口吻|用词|称呼|叫法|句式|长度|字数|标点|分条|表情|颜文字|梗|腔|口癖)/;

// 指向具体人或具体事实的成分：一旦出现，说明这不是纯风格规则
const FACTUAL_TOKENS = /(主人|用户|他本人|你自己是谁|你是谁|他|她|对方|他人|别人|其他人|群友|私聊|群聊|聊天记录|聊天内容|对话记录|对话内容|名字|昵称|真名|年龄|生日|住址|住哪|老家|工作|上班|单位|学校|学院|专业|年级|备考|考试|复习|考研|考公|联考|计划|打算|准备去|朋友|同事|家人|对象|女朋友|男朋友|同学|疾病|病历|病史|抑郁|焦虑|残疾|血型|身高|体重|健康|用药|医院|微信|手机|电话|邮箱|密码|账号|身份证|作息|失眠|熬夜)/;

// ── 兜底层：黑名单（保留，专治混合句）──────────────────────────────────────
export const PRIVACY_PATTERNS = [
  /主人[\s的]*(名字|昵称|真名|称呼|身份|职业|学校|单位|住址|年龄|生日)/,
  // 「称呼他为老大」「称呼主人为老大」「叫他 X」
  /(称呼|叫|喊|管|称)[\s\S]{0,4}(他|她|主人)/,
  /(叫我|称呼我|管我叫|喊我|称我)/,
  /(我叫|我的名字|我姓|我是.{0,6}(学生|老师|警察|医生|工程师))/,
  // 关系
  /(我(的)?(朋友|同事|家人|对象|女朋友|男朋友|同学))/,
  /主人[\s的]*(朋友|同事|家人|对象|女朋友|男朋友|同学|亲人)/,
  /(主人|用户|他)[\s\S]{0,6}(是谁|叫什么|在哪儿|在哪|做什么|干什么|住哪|哪人)/,
  // 身份标识
  /(警察学院|警院|公安联考|交通管理|大三|2024\s*级)/,
  // 行程/位置/作息
  /(住在|家住|老家|搬到|在.{0,4}(西安|未央|上海|北京))/,
  /(作息|睡眠|失眠|熬夜|早起)的?(习惯|规律)/,
  // 计划/目标（含「计划让几个人加 bot 测试」这类真实句式）
  /(计划|打算|准备)[\s\S]{0,16}(拉|加|找|测试|考|报名|申请|让)/,
  /(备考|考研|考公|联考|复习)/,
  // 联系方式/凭据
  /(\d{5,})/,
  /(微信|QQ号|手机号|邮箱|密码|token|密钥|账号|身份证)/i,
  // 「不要把…告诉别人」这类约束本身也是关于主人的私事
  /(不要|别|不许).{0,8}(告诉|说给|透露给)/,
  // 自述性内容（「主人自称嘴很严」「主人对刚认识的人不会一上来就热情」）
  /(主人|他)(自称|自认|觉得|认为|希望|要求)/,
];

/**
 * 从**记忆库条目**（第三人称「主人要求…」）转换出第二人称指令。
 *
 * ## 这里为什么不做通用的正则改写
 *
 * 试过：剥掉「主人/要求/bot」等词做句式转换。实测失败得很彻底 ——
 *   「主人要求称呼他为『老大』」→「称呼为『老大」   （引号断裂、且这是隐私却漏放）
 *   「主人自称嘴很严，绝不会随便乱说话」→「嘴很严，绝不会随便乱说话」（语义已错却放行）
 * 正则剥离会**破坏语义**，而语义坏掉的规则写进全局人格卡，比不写更糟：
 * 模型会照着一句错话改变说话方式，且没人知道它从哪来。
 *
 * ## 所以本函数只做**保守的整句判定**
 *
 * 只接受恰好是「主人 要求/希望 + bot + <动词短语>」这种**结构清晰**的条目，
 * 且动词短语本身必须以一个明确的表达方式动词开头。其余一律返回空串（=不进人格卡）。
 *
 * 宁可漏掉几条正当规则（主人随时可以在控制台手工加），
 * 也不要让一条语义损坏或夹带隐私的规则进全局人格卡。
 *
 * @returns {string} 转换后的规则；判定不成功返回空串
 */
export function toBotDirective(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';

  // 已经是第二人称指令（不含「主人」）的，原样交给下游闸门判断。
  if (!raw.includes('主人')) return normalizeRule(raw);

  // 结构化的「主人 + 引导词 + bot/你 + 动作短语」才尝试转换。
  // 引导词收得比较全（要求/希望/喜欢/不喜欢/反感/觉得…），因为记忆库里的条目
  // 用的正是这些转述动词；但**动作短语必须以表达方式动词开头**，见下面的 EXPR_HEAD。
  const m = /^主人\s*(要求|希望|喜欢|不喜欢|不让|叫|让|反感|觉得|认为|明确要求|强调|说过|表示)\s*(?:bot|你)\s*([\s\S]+)$/.exec(raw);
  if (!m) return '';
  const phrase = m[2].trim();
  if (!phrase) return '';

  // 动作短语必须以**明确的表达方式动词**开头，才算「怎么说」。
  // 这一条同时挡掉了「把新加的测试好友当陌生人对待」（说的是处事，不是说话）
  // 和「叫『鲸鱼娘』」（说的是称呼主人之外的身份设定，交给下游再判）。
  const EXPR_HEAD = /^(回复|说话|语气|口吻|用词|称呼|叫法|句式|长度|字数|标点|分条|表情|颜文字|别|不要|少|多|要|应该|必须|尽量|注意|统一|保持|避免|忌)/;
  if (!EXPR_HEAD.test(phrase)) return '';

  return normalizeRule(phrase);
}

/**
 * 判断一条候选规则是否属于「纯说话方式」。
 *
 * 三道闸门串联，**任何一道拦下都不放行**：
 *   1. 必须提到表达方式（STYLE_VERB）
 *   2. 不能出现指向具体人或事实的成分（FACTUAL_TOKENS）
 *   3. 不能命中隐私黑名单（PRIVACY_PATTERNS）
 *
 * 调用前应先用 toBotDirective() 把「主人要求…」转成第二人称指令，
 * 否则「主人」二字会让闸门 2 拦掉全部正当规则。
 *
 * @returns {string} 命中的原因；空串表示安全
 */
export function privacyViolation(text) {
  const s = String(text ?? '').trim();
  if (!s) return '空规则';

  // 闸门 1：不像「怎么说」的指令，直接拦。
  // 这一条会拦掉大量事实陈述（「主人自称嘴很严」），正是我们要的。
  if (!STYLE_VERB.test(s)) return '不像说话方式的要求';

  // 只允许一条明确、完整且否定式的「别复述我的话」。其它第一人称内容
  // 都可能是把主人的自述/偏好写进全局人格，不能靠关键词黑名单碰运气。
  const allowedFirstPerson = /^(?:别|不要|不许|不准|禁止)(?:复述|重复)我的?(?:话|原话)$/;
  if (/我/.test(s) && !allowedFirstPerson.test(s)) return '含第一人称自述，不能确认是纯风格';

  // 闸门 2：提到具体人或具体事实，说明不是纯风格规则。
  const fm = FACTUAL_TOKENS.exec(s);
  if (fm) return `涉及具体信息「${fm[0]}」`;

  // 闸门 3：黑名单兜底（混合句、联系方式等）。
  for (const re of PRIVACY_PATTERNS) {
    const m = re.exec(s);
    if (m) return `命中隐私词「${m[0]}」`;
  }
  return '';
}

/**
 * 归一化一条风格规则：压空白、去列表符号、截断。
 * 不改变语义，只做清洗，便于去重与渲染。
 */
export function normalizeRule(raw) {
  let s = String(raw ?? '')
    .replace(/^[\s\-*•·]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 去掉模型爱加的包裹引号/代码符
  s = s.replace(/^["'`「『]|["'`」』]$/g, '').trim();
  if (!s) return '';
  // 统一成「不带句尾句号」的风格，避免同一规则因标点不同被当成两条
  s = s.replace(/[。！；;]+$/, '').trim();
  if (s.length > RULE_MAX_CHARS) s = s.slice(0, RULE_MAX_CHARS).trim();
  return s;
}

/** 去重用的键：忽略大小写与空白差异。 */
function ruleKey(s) {
  return String(s ?? '').toLowerCase().replace(/[\s，,。.!！?？、]/g, '');
}

/**
 * 合并新规则进旧列表：保序、去重、限长。
 * 新规则排在后面（老规则优先），超出 MAX_RULES 时丢最老的。
 */
export function mergeRules(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const r of [...(existing || []), ...(incoming || [])]) {
    const n = normalizeRule(r);
    if (!n) continue;
    const k = ruleKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out.slice(-MAX_RULES);
}

/**
 * 从一段对话里提炼「怎么写」的规则。
 *
 * 与 owner-memory 的 buildFactExtractionPrompt 的关键区别：
 * 这里**只要表达方式**，明确禁止输出任何关于主人本人的事实。
 * 提示词层面的限制是必要但不充分的 —— 真正的闸门是 privacyViolation()。
 */
export function buildStyleExtractionPrompt(messages, knownRules = []) {
  const chatLines = (messages || [])
    .map((m, i) => {
      const who = m.isSelf ? '我(bot)' : '用户';
      return `<msg id="${i + 1}" from="${who}">${String(m.text ?? m.plain ?? '').replace(/[<>]/g, '')}</msg>`;
    })
    .join('\n');

  const known = (knownRules || []).slice(0, MAX_RULES)
    .map((r, i) => `${i + 1}. ${r}`)
    .join('\n') || '（暂无）';

  return `你是一个「说话风格」提取器。请从下面这段对话里，找出**用户对 bot 说话方式的纠正或要求**，提炼成可复用的规则。

只提取「**怎么说话**」，例如：
- 别用某个词/梗（「别说鼠鼠」「别提合乎孙礼」）
- 长度要求（「别啰嗦」「一句话说完」「可以长一点」）
- 句式禁忌（「别先肯定再否定」「别复述我的话」）
- 语气要求（「热乎一点」「别这么客气」「多发表情包」）
- 称呼 bot 的方式（「你应该叫鲸鱼娘」）

**绝对不要提取**任何关于用户本人的信息：姓名、昵称、住哪、做什么工作、在备考什么、有什么计划、和谁的关系、作息、联系方式、以及「不要把某事告诉别人」这类约束。这些不属于说话风格，写进全局人格卡会泄露隐私。

已收录的规则（不要重复，只输出新增的）：
${known}

对话：
${chatLines}

输出要求：
- 只输出一个 JSON 数组，元素是字符串，例如 ["别用鼠鼠这个梗", "回复短一点"]。
- 每条不超过 40 字，以否定或要求开头，读起来像一条独立可执行的规则。
- 没有新的、可复用的规则就输出 []。不要为了凑数硬编。
- 不要输出 JSON 以外的任何文字。`;
}

/**
 * 从模型输出里解析规则数组。容忍 markdown 代码块与前后废话。
 */
export function parseStyleJson(text) {
  const raw = String(text ?? '');
  // 先找 ```json ... ``` 块
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed;
  try { parsed = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((x) => {
      // 允许元素是字符串，或 {rule: "..."} 这类对象
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') return String(x.rule ?? x.text ?? x.style ?? '');
      return '';
    })
    .map(normalizeRule)
    .filter(Boolean);
}

/**
 * 过滤候选：去隐私 + 去重。
 *
 * 注意：这里**不做**句式转换。提炼提示词已经要求模型直接输出第二人称指令
 * （「别用鼠鼠这个梗」），拿到的就应该是成品。
 * 句式转换（toBotDirective）只用于「把已有记忆库条目搬进人格卡」这种迁移场景，
 * 由调用方显式调用 —— 不能默认混进来，否则会把用户的正常指令也改写一遍。
 *
 * @returns {{kept: string[], dropped: {rule: string, reason: string}[]}}
 */
export function filterRules(candidates, existing = []) {
  const kept = [];
  const dropped = [];
  const seen = new Set((existing || []).map(ruleKey));
  for (const raw of candidates || []) {
    const rule = normalizeRule(raw);
    if (!rule) continue;
    const why = privacyViolation(rule);
    if (why) { dropped.push({ rule, reason: why }); continue; }
    const k = ruleKey(rule);
    if (seen.has(k)) { dropped.push({ rule, reason: '已存在' }); continue; }
    seen.add(k);
    kept.push(rule);
  }
  return { kept, dropped };
}

/**
 * 把记忆库条目迁移进人格卡：转句式 → 过滤 → 合并。
 *
 * 这是**一次性迁移**用的入口（把主人已经教过的东西立刻同步出去，
 * 而不是等她下次再纠正一遍）。日常增量走 appendStyleRules。
 *
 * @returns {{text: string, added: string[], skipped: {rule: string, reason: string}[]}}
 */
export function importFromFacts(roleText, facts) {
  const converted = [];
  const skipped = [];
  for (const f of facts || []) {
    const text = typeof f === 'string' ? f : f?.text;
    const rule = toBotDirective(text);
    if (!rule) {
      skipped.push({ rule: String(text ?? '').slice(0, 60), reason: '不是可迁移的说话方式' });
      continue;
    }
    converted.push(rule);
  }
  const result = appendStyleRules(roleText, converted);
  return { text: result.text, added: result.added, skipped: [...skipped, ...result.dropped] };
}

/**
 * 从人格卡文本里取出「主人教的说话方式」小节下的规则列表。
 * 小节不存在时返回空数组（不是错误——第一次写入前它本来就不存在）。
 */
export function readStyleRules(roleText) {
  const lines = String(roleText ?? '').split(/\r?\n/);
  // 标题可能带 〔全部〕/〔二代〕 这类模式标记（renderStyleSection 会写上去），
  // 也可能带「一、」这类序号前缀。两者都必须容忍，否则读回永远为空——
  // 那会导致「每次都认为没有旧规则」，规则无限重复堆积。
  const titleRe = new RegExp(`^##\\s*(?:[一二三四五六七八九十\\d]+[、.．)]\\s*)?${STYLE_SECTION_TITLE}\\s*(?:[\\[〔（(][^\\]〕）)]*[\\]〕）)])?\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (titleRe.test(lines[i].trim())) { start = i; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,6}\s+\S/.test(line)) break; // 下一个标题，小节结束
    const m = /^\s*[-*•]\s+(.+?)\s*$/.exec(line);
    if (m) out.push(normalizeRule(m[1]));
  }
  return out.filter(Boolean);
}

/**
 * 把规则列表渲染成一个人格卡小节（含标题）。
 *
 * 用「整节替换」的语义写入，所以这个函数的输出就是该小节的**全部**内容——
 * 幂等：同样的规则跑两遍，人格卡不变。
 */
export function renderStyleSection(rules) {
  const items = mergeRules([], rules);
  const head = `## ${STYLE_SECTION_TITLE} 〔全部〕`;
  if (items.length === 0) return `${head}\n`;
  const intro = '> 下面这些是主人亲自纠正过的说话方式，**对所有会话都适用**（包括和别人的私聊、群聊）。它们只讲「怎么说」，不改变你是谁。与别处冲突时以这里为准。';
  const body = items.map((r) => `- ${r}`).join('\n');
  return `${head}\n\n${intro}\n\n${body}\n`;
}

/**
 * 必须始终留在卡片末尾的「安全类」小节。
 *
 * 为什么要有这个列表：角色卡注入有字符上限（cfg.role.maxInjectChars，默认 12000），
 * 超限时是**从尾部截断**的。隐私边界那节原本在卡片最后，属于「万一被截，
 * 宁可少说几句风格也不能丢安全规则」的位置。
 *
 * 自动写入的说话风格如果无脑 append 到文末，就会把隐私小节顶到倒数第二 ——
 * 一旦某天卡片变长触发截断，被砍掉的就是隐私规则，而多出来的却是「别用鼠鼠」。
 * 这个优先级是错的，所以风格小节必须插在保护小节**之前**。
 */
export const PROTECTED_TAIL_SECTIONS = ['隐私边界'];

/**
 * 在卡片里找「第一个受保护的尾部小节」所在行下标；没有则返回 -1。
 */
function findProtectedTailStart(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s*(.+?)\s*$/.exec(lines[i].trim());
    if (!m) continue;
    const title = m[2].replace(/^[一二三四五六七八九十\d]+[、.．)]\s*/, '')
      .replace(/[\[〔（(][^\]〕）)]*[\]〕）)]/g, '').trim();
    if (PROTECTED_TAIL_SECTIONS.some((p) => title.startsWith(p))) return i;
  }
  return -1;
}

/**
 * 把「主人教的说话方式」小节写进人格卡文本。
 *
 * 三种情况：
 *   ① 已有该小节 → 原位整节替换
 *   ② 没有 → 插到受保护尾部小节（隐私边界）**之前**
 *   ③ 没有且没有保护小节 → 追加到文末
 *
 * **只动这一节**，其余字节原样保留。
 *
 * ⚠️ 语义：传入的 rules 就是该小节的**全部**内容，函数不自动并入旧规则。
 * 想让新规则累加到旧规则上，请先 readStyleRules() 再用 mergeRules() 合并，
 * 或者直接用 appendStyleRules()（它把这两步合起来了，推荐）。
 *
 * @returns {{text: string, changed: boolean}}
 */
export function upsertStyleSection(roleText, rules) {
  const original = String(roleText ?? '');
  const section = renderStyleSection(rules);
  const lines = original.split(/\r?\n/);
  const titleRe = new RegExp(`^#{1,6}\\s*(?:[一二三四五六七八九十\\d]+[、.．)]\\s*)?${STYLE_SECTION_TITLE}\\s*`);
  let start = -1;
  let level = 2;
  for (let i = 0; i < lines.length; i += 1) {
    const m = titleRe.exec(lines[i].trim());
    if (m) {
      start = i;
      level = (/^(#{1,6})/.exec(lines[i].trim()) || [null, '##'])[1].length;
      break;
    }
  }
  if (start < 0) {
    // 不存在：插到受保护尾部小节之前（保住隐私规则在最后），没有则追加到文末。
    const tail = findProtectedTailStart(lines);
    const at = tail >= 0 ? tail : lines.length;
    const head = lines.slice(0, at);
    const rest = lines.slice(at);
    const sectionLines = section.replace(/\s+$/, '').split('\n');
    // 头部若以空行结尾，压掉，避免插入处出现三连空行
    while (head.length && head[head.length - 1].trim() === '') head.pop();
    const rebuilt = [...head, '', ...sectionLines, '', ...rest];
    const text = rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    return { text, changed: true };
  }
  // 找到小节结束位置
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+\S/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  const sectionLines = section.replace(/\s+$/, '').split('\n');
  // 尾部多余空行先去掉，再把小节插回原位；最后统一压掉 3 个以上连续空行。
  const rebuilt = [...before, ...sectionLines, '', ...after];
  const text = rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  return { text, changed: true };
}

/**
 * 把新规则**累加**进人格卡（推荐入口）。
 *
 * 读旧规则 → 过滤隐私 → 合并去重 → 整节写回。
 * 这是唯一应该从业务代码调用的写入口：单用 upsertStyleSection 会覆盖掉旧规则。
 *
 * @returns {{text: string, added: string[], dropped: {rule: string, reason: string}[]}}
 */
export function appendStyleRules(roleText, candidates) {
  const current = readStyleRules(roleText);
  const { kept, dropped } = filterRules(candidates, current);
  if (kept.length === 0) {
    return { text: String(roleText ?? ''), added: [], dropped };
  }
  const merged = mergeRules(current, kept);
  const { text } = upsertStyleSection(roleText, merged);
  return { text, added: kept, dropped };
}
