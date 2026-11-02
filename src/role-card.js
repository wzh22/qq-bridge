// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
// 以前靠 currentRoleHintV2() 对正文做「逐行猜测 + 正则过滤」，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
// 「〔全部〕」是显式声明「两种模式都要」：detectMode 本来就默认 all，所以它不改变结果，
// 但**必须能从标题里剥掉** —— 否则 `## 十、谁能指挥你 〔全部〕` 的标题会带着这串括号
// 参与比对，按「谁能指挥你」去找小节的提案就会找不到。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
  { mode: 'all', re: /[\[〔（(]\s*(?:全部|两种|both)\s*[\]〕）)]/gi },
];

// Persistent-section tag: a heading containing the CJK tag for "always on" is
// re-injected on EVERY wake, not only on the bootstrap turn.
// Reason: the full role card is injected once per session (bootstrap). After that
// each wake carries only a one-line "current role" hint, so the persona gets
// diluted by accumulated chat and the model ends up following only the preset's
// generic style rules. Picking a few sharp lines to repeat keeps the persona
// present without re-sending the whole card every turn.
const PERSIST_TAG_RE = /[\[\u3014\uff08(]\s*\u5e38\u9a7b\s*[\]\u3015\uff09)]/g;

export function isPersistentHeading(heading) {
  PERSIST_TAG_RE.lastIndex = 0;
  return PERSIST_TAG_RE.test(String(heading ?? ''));
}

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

/**
 * 去掉标题前的序号：`一、` `三·五、` `二.` `(3)` 等。
 *
 * 为什么需要单独这一步：人格卡的标题里**序号形态不统一**。实测「## 三·五、说话的硬度」
 * 这一节，早期实现的正则只认 `[一二三四五六七八九十\d]+`，碰到 `三·五` 里的 `·` 就只
 * 吃掉「三」，剩下的 `·五、说话的硬度…` 再也匹配不上 —— 于是按工具描述（"不含 ## 和
 * 「一、」这类序号"）写「说话的硬度：八条红线」的提案必然报「找不到小节」，
 * 等于一半提案注定失败，还很难看出是标题格式的锅。
 */
export function stripSectionOrdinal(raw) {
  let s = String(raw ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = s
      // 「三」「十一」「3」「三·五」「3.5」这类数字词，后面跟分隔符或空白
      .replace(/^第?[一二三四五六七八九十百零〇\d]+(?:[·・.．\-][一二三四五六七八九十百零〇\d]+)*(?:[、，,：:.．)）]|\s+)\s*/, '')
      // 「(3)」「（三）」
      .replace(/^[（(]\s*[一二三四五六七八九十百零〇\d]+\s*[)）]\s*/, '')
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

export function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  PERSIST_TAG_RE.lastIndex = 0;
  out = out.replace(PERSIST_TAG_RE, '');
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  // 必须先统一换行：Windows 下的 .md 是 CRLF，split('\n') 后每行结尾残留 \r，
  // 会让 /^(#{1,6})\s+(.*)$/ 全部失配 —— 结果是整张卡被当成一个「无标题小节」，
  // 模式标记（〔一代〕/〔二代〕）失效，且没有任何报错。
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  for (const line of normalized.split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = {
      mode: detectMode(heading[2]),
      persistent: isPersistentHeading(heading[2]),
      heading: title,
      lines: [`${heading[1]} ${title}`],
    };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Only the persistent sections, with mode tags already stripped. Used to
 * re-inject a compact persona reminder on non-bootstrap wakes.
 * @param {'v1'|'v2'} mode
 */
export function selectPersistentRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.persistent && (section.mode === 'all' || section.mode === want))
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    persistent: !!section.persistent,
    injected: section.mode === 'all' || section.mode === want,
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
    persistentV1: selectPersistentRoleText(source, 'v1').length,
    persistentV2: selectPersistentRoleText(source, 'v2').length,
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;

// 否定语境免删。
//
// 为什么：过滤器本意是删掉「用空格分条」这类一代操作指令。但它靠关键词匹配，不分肯定否定——
// 人格卡里「不要用空格断句」「严禁：用空格分词」这种禁止性规则也含「用空格」，
// 于是被当成一代指令一并删掉了。结果是：模型从来没看到「不要用空格」这条规则，
// 却因为模型本身的中文书写习惯一直用空格分句。
//
// 判据：整行含不/别/禁/勿/避/免/莫时，这行是约束而非操作指令，不过滤。
// 真正的一代指令（「用空格分条回答」「输出 [SILENT]」）不带否定词，仍会被删。
const NEGATION_BEFORE_RE = /[不别禁勿避免莫]/;

export function isGen1RoleLine(line) {
  const text = String(line ?? '');
  const m = text.match(GEN1_ROLE_LINE_RE);
  if (!m) return false;
  const before = text.slice(Math.max(0, m.index - 4), m.index);
  return !NEGATION_BEFORE_RE.test(before);
}
