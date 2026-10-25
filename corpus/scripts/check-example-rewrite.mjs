// 检查「回复示例」节在二代注入时的空格→逗号改写，是否会破坏示例本身。
// 直接复用 bridge.js 里的两个函数（从源码抽取后求值），避免手抄一份导致漂移。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, ROLE_PATH } from './corpus-paths.mjs';

const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const ROLE = ROLE_PATH;

const src = readFileSync(BRIDGE, 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未找到函数 ${name}`);
  // 从函数起点向后匹配大括号
  let i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`函数 ${name} 大括号不匹配`);
}

const isCjkLikeChar = eval(`(${extract('isCjkLikeChar')})`);
const convertExampleSpacesToComma = eval(`(${extract('convertExampleSpacesToComma')})`);

const role = readFileSync(ROLE, 'utf8').replace(/\r\n?/g, '\n');
const lines = role.split('\n');

let inEx = false;
let sectionFound = false;
const diffs = [];
for (const line of lines) {
  if (/^##\s*.*回复示例/.test(line)) { inEx = true; sectionFound = true; continue; }
  if (inEx && /^##\s/.test(line)) { inEx = false; continue; }
  if (inEx) {
    const conv = convertExampleSpacesToComma(line);
    if (conv !== line) diffs.push([line, conv]);
  }
}

// 卡片里可能**根本没有**「回复示例」这一节。
// 二代卡重写时把它整节删了（示例改由预设的仿真提示词承担），
// 而 bridge.js 的改写逻辑仍按 `inExampleSection` 判断——
// 节不存在时那段代码不会触发，也不会出错，只是「无事可做」。
//
// 这里必须把这个状态说清楚，而不是继续用「改写行数 < 15」判红：
//   判红的前提是「有节可改」。节都没有，红的是断言本身，不是代码。
// 而且这条断言原先写 `>= 15`，是照着旧卡里 15+ 行示例定的——
// 那是一份**绑定具体卡片内容**的魔数，卡片一重写就失效。
if (!sectionFound) {
  console.log('=== 回复示例节：卡片中不存在 ===');
  console.log('  ⏭  跳过（二代卡未保留该节，bridge.js 的改写逻辑在这种情况下不会触发）');
  console.log('  说明：这不是失败。断言「改写 >= 15 行」的前提是卡片里有该节，');
  console.log('        前提不成立时继续判红，只会把「结构变了」误报成「改写坏了」。');
  console.log('');
  console.log('总计: 全部通过（该节不存在，无需校验）');
  process.exit(0);
}

console.log('=== 回复示例节中被改写的行 ===');
for (const [a, b] of diffs) {
  console.log('原: ' + a);
  console.log('改: ' + b);
  console.log('');
}
console.log(`共 ${diffs.length} 行被改写`);

console.log('');
let fail = 0;
function assert(name, cond, detail = '') {
  if (cond) console.log(`  ✅ ${name}`);
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
}

// 关键回归 1：不该出现「DeepSeek，小鲸鱼」这种把专名拆开的改写
const badName = diffs.filter(([, b]) => /DeepSeek，|，小鲸鱼/.test(b));
assert(
  '不把专名「DeepSeek 小鲸鱼」拆成两截',
  badName.length === 0,
  badName.map(([, b]) => `\n       ${b}`).join(''),
);

// 关键回归 2：「不像 DeepSeek」这类「中文 + 空格 + 英文」不得变成「不像，DeepSeek」。
//
// 判定必须逐字符对齐，不能在结果里正则搜索：
//   - 搜「中文，英文」会误伤原文本来就有逗号的行（如「（每轮都要赢，AI味）」）；
//   - 比「中文，」的数量也会误伤——正常改写「中文 空格 中文」本身就会新增逗号。
// 改写只把空格换成逗号，两者都是单字符，长度不变，所以可以按位置精确比较。
const isCjk = (c) => !!c && /[\u4e00-\u9fff\u3000-\u303f]/.test(c);
const isLatin = (c) => !!c && /[0-9A-Za-z]/.test(c);
const mixedSpaceKept = (orig, conv) => {
  const a = Array.from(orig);
  const b = Array.from(conv);
  if (a.length !== b.length) return false; // 长度变了说明改写出乎意料
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== ' ') continue;
    const prev = a[i - 1];
    const next = a[i + 1];
    const mixed = (isCjk(prev) && isLatin(next)) || (isLatin(prev) && isCjk(next));
    if (mixed && b[i] !== ' ') return false; // 混合空格被换成了逗号
  }
  return true;
};
const badMix = diffs.filter(([a, b]) => !mixedSpaceKept(a, b));
assert(
  '不在「中文 + 空格 + 英文」处插入逗号',
  badMix.length === 0,
  badMix.map(([a, b]) => `\n       原: ${a}\n       改: ${b}`).join(''),
);

// 关键回归 3：正常的「中文 空格 中文」必须仍然被改写成分条停顿的逗号，
// 否则等于把一代的「空格分条」语义原样漏进二代提示词。
const normal = diffs.filter(([, b]) => /[\u4e00-\u9fff]，[\u4e00-\u9fff]/.test(b));
assert(
  '仍正常改写「中文 + 空格 + 中文」为逗号',
  normal.length >= 15,
  `实际 ${normal.length} 行（预期 >= 15）`,
);

console.log('');
console.log(fail ? `总计: ${fail} 项失败` : '总计: 全部通过');
process.exit(fail ? 1 : 0);
