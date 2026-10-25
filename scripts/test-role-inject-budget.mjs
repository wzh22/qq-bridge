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
const limit = Number(config?.role?.maxInjectChars) || 12000;

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
const m = bridgeSrc.match(/const ROLE_INJECT_MAX_CHARS_DEFAULT\s*=\s*(\d+)/);
const codeDefault = Number(m?.[1]);
check('能从 bridge.js 读到 ROLE_INJECT_MAX_CHARS_DEFAULT', Number.isFinite(codeDefault), `实际 ${m?.[1]}`);
check(
  `config.json(${limit}) === bridge.js 默认(${codeDefault})`,
  limit === codeDefault,
  '两边不一致：配置生效但代码默认值已回退',
);
check('上限处于 applyRoleInjectLimit 允许区间 1000~20000', limit >= 1000 && limit <= 20000);

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
