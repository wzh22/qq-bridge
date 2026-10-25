// reserved2「正文兜底转发」接线测试。
//
// 要防的回归：reserved2（二代仿真）模式下 AI 的回合正文**不会**自动发到 QQ，
// 必须由它自己调用 qq_send_message。实测 2026-10-25 一小时内漏了 2 次，
// 且都发生在「用户提问 → AI 给出答案」之后，用户侧看到的就是「消息发不出去」。
//
// 修法是加一层兜底，但**只在该发的时候发**：
//   - 本轮开始时还有对方未回应的消息（replyExpected=true）→ 补发
//   - 纯自言自语 / 定时唤醒（replyExpected=false）→ 仍然丢弃
//
// 这个测试分两部分：
//   1. 源码契约：确认四个关键接线点都在（bridge.js 1.3 万行、起不来，
//      以前有过「逻辑写好了但某个 clear() 忘了加，状态残留导致误判」的先例）；
//   2. 行为模型：把判定逻辑按源码写法复刻成最小函数，验证真值表。
import fs from 'node:fs';

const BRIDGE = 'E:\\dsh\\qq-bridge\\src\\bridge.js';
let failed = 0;
function assert(cond, label) {
  if (cond) console.log(`✅ ${label}`);
  else { console.error(`❌ ${label}`); failed = 1; }
}

let src = '';
try {
  src = fs.readFileSync(BRIDGE, 'utf8');
} catch (error) {
  console.error(`❌ 读取 bridge.js 失败: ${error.message}`);
  process.exit(1);
}

// ── 1. 源码契约 ────────────────────────────────────────────────────────────
assert(/const v2TurnReplyableSessions = new Map\(\)/.test(src), '声明 v2TurnReplyableSessions');
assert(/v2TurnReplyableSessions\.set\(frame\.sessionId, true\)/.test(src), 'turn/start 时记录 replyExpected');
assert(/const replyExpected = v2TurnReplyableSessions\.get\(frame\.sessionId\) === true/.test(src), 'turn/end 时取出 replyExpected');
assert(/if \(replyExpected && !shouldBlockSilentReply\(key\)\)/.test(src), '兜底转发的触发条件正确');

// 生命周期清理：漏掉任何一处都会让标记跨 turn 残留，导致该丢的自言自语被误发出去。
const clearSites = [
  ['retireSession/forgetConversationCaches', /sendToolSucceededSessions\.delete\(sessionId\);\s*\n\s*v2TurnReplyableSessions\.delete\(sessionId\);/],
  ['会话批量退役', /sendToolSucceededSessions\.delete\(sid\);\s*\n\s*v2TurnReplyableSessions\.delete\(sid\);/],
  ['事件流断开重建', /sendToolSucceededSessions\.clear\(\);\s*\n\s*v2TurnReplyableSessions\.clear\(\);/],
  ['清空聊天工作区', /sendToolSucceededSessions\.clear\(\);\s*\n\s*v2TurnReplyableSessions\.clear\(\);/]
];
for (const [label, re] of clearSites) {
  assert(re.test(src), `清理点已接线：${label}`);
}

// 兜底路径必须过安全审计，不能把含令牌/本机路径的正文直接发出去。
assert(
  /if \(replyExpected && !shouldBlockSilentReply\(key\)\)[\s\S]{0,700}?SENSITIVE_RE\.test\(plain\)/.test(src),
  '兜底转发前执行敏感信息审计'
);
// 发送失败不能假装修复过（lastSendSucceeded 是现成的判定）。
assert(
  /await sendToQQ\(key, plain\);[\s\S]{0,200}?if \(lastSendSucceeded\(key\)\)/.test(src),
  '兜底发送后按实际送达情况更新状态'
);

// ── 2. 行为模型（按源码逻辑复刻）──────────────────────────────────────────
// 判定这一轮要不要兜底。
function shouldFallback({ mode, replyExpected, sendToolSucceeded, silentBlocked, text, knownToken }) {
  if (mode !== 'reserved2') return false;
  if (sendToolSucceeded) return false;          // 工具已发过，跳过自动转发
  if (!text || !text.trim()) return false;      // 无文本
  if (silentBlocked) return false;              // 静默模式
  return replyExpected === true;
}

// 审计是否拦截。
function blockedByAudit(text, knownToken) {
  const SENSITIVE_RE = /[A-Za-z]:\\|\/Users\/|token|secret/i;
  return SENSITIVE_RE.test(text) || knownToken;
}

const cases = [
  // [说明, 输入, 期望兜底]
  ['有人提问 → AI 只输出正文（真实事故场景）', { mode: 'reserved2', replyExpected: true, sendToolSucceeded: false, silentBlocked: false, text: '你都问我了' }, true],
  ['定时唤醒自言自语（不该外泄）', { mode: 'reserved2', replyExpected: false, sendToolSucceeded: false, silentBlocked: false, text: '管理员凌晨4点才睡下，我不打扰' }, false],
  ['AI 已经用工具发过了', { mode: 'reserved2', replyExpected: true, sendToolSucceeded: true, silentBlocked: false, text: '回复内容' }, false],
  ['静默模式拦截', { mode: 'reserved2', replyExpected: true, sendToolSucceeded: false, silentBlocked: true, text: '回复内容' }, false],
  ['空文本', { mode: 'reserved2', replyExpected: true, sendToolSucceeded: false, silentBlocked: false, text: '   ' }, false],
  ['旧版仿真模式不受影响', { mode: 'reserved', replyExpected: true, sendToolSucceeded: false, silentBlocked: false, text: '回复内容' }, false],
  ['普通 chat 模式不受影响', { mode: 'chat', replyExpected: true, sendToolSucceeded: false, silentBlocked: false, text: '回复内容' }, false]
];
for (const [label, input, expected] of cases) {
  const got = shouldFallback(input);
  assert(got === expected, `${label} → 兜底=${got}（期望 ${expected}）`);
}

assert(blockedByAudit('我的路径是 E:\\dsh\\qq-bridge', false) === true, '审计拦截本机路径');
assert(blockedByAudit('普通聊天内容', false) === false, '审计放行普通内容');
assert(blockedByAudit('普通聊天内容', true) === true, '审计拦截已知会话令牌');

if (failed) {
  console.error('\n❌ reserved2 兜底转发测试失败');
  process.exit(1);
}
console.log('\n🎉 reserved2 兜底转发接线测试通过');
