// 守护「注入截断不会吃掉隐私小节」。
//
// 为什么需要它：桥接的 roleHintForMode() 用 truncateText 截断，保留的是**头部**。
// 隐私小节在卡片最后，一旦注入长度超过 role.maxInjectChars，最先被切掉的恰恰是
// 优先级最高的那节——而且不会报错，只会静默失效。
//
// 这个测试在「余量不足」时就失败，让人在加长卡片时被迫先想清楚。
//
// 用法：node test-role-inject-budget.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const ROLE = 'E:\\dsh\\qq-bridge\\roles\\小鲸鱼.md';
const CONFIG = 'E:\\dsh\\qq-bridge\\config.json';
const BRIDGE = 'E:\\dsh\\qq-bridge\\src\\bridge.js';
const role = readFileSync(ROLE, 'utf8');
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

// ⚠️ 这里不能再用 `config.role.maxInjectChars || 12000` 那种写法：
// 配置一旦被删/被清空，兜底值会和 bridge.js 的真实默认值偷偷分家，
// 测试于是拿一个过时的上限去量当前卡，红绿都不再说明问题。
// 正确做法：配置有值就用值，没有就读 bridge.js 里那份**唯一**默认值。
const codeDefault = (() => {
  const src = readFileSync(BRIDGE, 'utf8');
  const m = /const ROLE_INJECT_MAX_CHARS_DEFAULT\s*=\s*(\d+)/.exec(src);
  return m ? Number(m[1]) : NaN;
})();
const limit = Number(config?.role?.maxInjectChars) || codeDefault;

const { selectRoleText, roleCharStats } = await import('file:///E:/dsh/qq-bridge/src/role-card.js');

// 模拟 roleHintForMode 的截断（与 bridge.js 行为一致：保留头部）
function inject(mode) {
  const selected = selectRoleText(role, mode);
  return selected.length > limit ? selected.slice(0, limit) : selected;
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
}

console.log(`注入上限: ${limit} 字符`);

console.log('\n=== 1. 两种模式都不能超限（超限即截断） ===');
for (const mode of ['v1', 'v2']) {
  const stats = roleCharStats(role);
  const len = mode === 'v1' ? stats.v1 : stats.v2;
  check(`${mode} 注入 ${len} ≤ ${limit}`, len <= limit, `超出 ${len - limit} 字，会被截断`);
}

console.log('\n=== 2. 截断后隐私小节必须完整 ===');
const MUST_HAVE = [
  '隐私边界',
  '永远不进群聊',
  '不确认、不否认、不补细节',
  '只有一个特定的 QQ 私聊窗口',
  '本机上的任何信息都不说',
  '如果已经说漏了',
  '让他知道',
];
for (const mode of ['v1', 'v2']) {
  const text = inject(mode);
  for (const needle of MUST_HAVE) {
    check(`${mode} 注入含「${needle}」`, text.includes(needle));
  }
}

console.log('\n=== 3. 保留安全余量（建议 ≥ 300 字，留给后续小幅补充） ===');
for (const mode of ['v1', 'v2']) {
  const stats = roleCharStats(role);
  const len = mode === 'v1' ? stats.v1 : stats.v2;
  const margin = limit - len;
  check(`${mode} 余量 ${margin} 字 ≥ 300`, margin >= 300, `仅剩 ${margin} 字，再加内容就可能截到隐私节`);
}

console.log('\n=== 4. 隐私小节确实位于卡片末尾（说明本条测试的必要性） ===');
const headings = [...role.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
const last = headings[headings.length - 1];
check('最后一节是隐私小节', /隐私边界/.test(last || ''), `实际最后一节: ${last}`);
check('隐私小节在第二节之后（不会被前面的内容挤掉）', headings.length > 2);

console.log('\n=== 5. 配置值与 bridge.js 内置默认值一致 ===');
// 两处脱节时会很隐蔽：配置文件生效、代码默认值却悄悄回退，
// 表现为「换了机器/删了配置就突然截断」，所以直接断言两者相等。
const bridgeSrc = readFileSync(BRIDGE, 'utf8');
check('能从 bridge.js 读到 ROLE_INJECT_MAX_CHARS_DEFAULT', Number.isFinite(codeDefault), `实际 ${codeDefault}`);
check(
  `config.json(${limit}) === bridge.js 默认(${codeDefault})`,
  limit === codeDefault,
  '两边不一致：配置生效但代码默认值已回退',
);
// 区间也必须和代码里 applyRoleInjectLimit 的钳位一致——
// 早期这里写死 1000~20000，代码放宽到 40000 后测试仍在守着旧上界，
// 于是「配置值 30000」会被测试判成越界，而代码其实是接受的。
const clampMatch = /Math\.min\((\d+),\s*Math\.max\((\d+),\s*Math\.round\(n\)\)\)/.exec(bridgeSrc);
const clampMin = Number(clampMatch?.[2]);
const clampMax = Number(clampMatch?.[1]);
check('能从 applyRoleInjectLimit 读到钳位区间', Number.isFinite(clampMin) && Number.isFinite(clampMax), `实际 ${clampMin}~${clampMax}`);
check(
  `上限落在 applyRoleInjectLimit 允许区间 ${clampMin}~${clampMax}`,
  limit >= clampMin && limit <= clampMax,
  `配置 ${limit} 不在 ${clampMin}~${clampMax}`,
);
// 卡的**成长**空间：上调上限的直接目的就是给她留出可写的余地。
// 阈值取 2000 字——小于这个数，一次正常的「补一节新习惯」就会立刻顶到上限，
// 又会退回到「想加必须先删」的死循环，等于上限没加。
for (const mode of ['v1', 'v2']) {
  const stats = roleCharStats(role);
  const len = mode === 'v1' ? stats.v1 : stats.v2;
  check(`${mode} 成长空间 ${limit - len} 字 ≥ 2000（自主改卡需要余地）`, limit - len >= 2000, `仅剩 ${limit - len} 字`);
}

console.log('\n=== 6. 控制台输入框的取值范围必须和服务端钳位一致 ===');
// 为什么放在这里而不是只靠 test-console-ui：
// 那条 UI 测试需要 Playwright，本机没装 → 整个文件被 `⏭ 跳过`，等于**没测**。
// 而 HTML 里的 min/max 和服务端 applyRoleInjectLimit 的钳位是两份独立写死的数字，
// 一旦只改了一边（比如把上限从 20000 提到 40000 却忘了改 max="20000"），
// 控制台上就根本输不进新值——功能明明是好的，UI 却不让你用。
// 这里做纯静态比对，不需要浏览器，任何环境都能跑。
{
  const html = readFileSync('E:\\dsh\\qq-bridge\\public\\console.html', 'utf8');
  const tag = /<input[^>]*id="roleInjectMax"[^>]*>/.exec(html)?.[0] ?? '';
  const htmlMin = Number(/min="(\d+)"/.exec(tag)?.[1]);
  const htmlMax = Number(/max="(\d+)"/.exec(tag)?.[1]);
  check('能从 console.html 读到输入框范围', Number.isFinite(htmlMin) && Number.isFinite(htmlMax), `实际 ${htmlMin}~${htmlMax}`);
  check(
    `HTML 范围(${htmlMin}~${htmlMax}) === 服务端钳位(${clampMin}~${clampMax})`,
    htmlMin === clampMin && htmlMax === clampMax,
    '两边不一致：控制台会输不进服务端其实接受的值',
  );
}

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
