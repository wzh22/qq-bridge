/**
 * owner-inbox（B 方案：跨会话只给概括）的回归测试。
 *
 * 这一组断言的重点不是「功能能不能跑」，而是**边界守不守得住**：
 * 主人拿到的是话题，不是别人私聊的原文。
 */
import assert from 'node:assert/strict';

import {
  buildInboxSummaryPrompt,
  parseInboxSummary,
  renderInboxSummary,
  leaksOriginalText,
  maskQQ,
  MAX_SESSIONS_PER_SUMMARY,
} from '../src/owner-inbox.js';

let pass = 0;
const fail = [];
function ok(name, fn) {
  try { fn(); pass += 1; }
  catch (error) { fail.push(`${name}: ${error?.message ?? error}`); }
}

// ── 泄露检测：核心闸门 ──────────────────────────────────────────────────

ok('引用连续原文应判定为泄露', () => {
  const msgs = [{ text: '明天下午三点的车票我已经买好了' }];
  assert.equal(leaksOriginalText('他说他明天下午三点的车票已经买好了', msgs), true);
});

ok('话题级概括不应误判', () => {
  const msgs = [{ text: '明天下午三点的车票我已经买好了' }];
  assert.equal(leaksOriginalText('在聊出行安排', msgs), false);
});

ok('短句整条出现应判定为泄露', () => {
  const msgs = [{ text: '借我两百块' }];
  assert.equal(leaksOriginalText('对方想借钱', msgs), false);
  assert.equal(leaksOriginalText('他说借我两百块', msgs), true);
});

ok('语气词重复不应误杀正常转述', () => {
  const msgs = [{ text: '哈哈哈哈哈哈哈哈' }];
  assert.equal(leaksOriginalText('聊得挺开心', msgs), false);
});

ok('空内容不判定泄露', () => {
  assert.equal(leaksOriginalText('', [{ text: '随便什么内容都行' }]), false);
  assert.equal(leaksOriginalText('在聊备考', []), false);
});

// ── 解析与净化 ──────────────────────────────────────────────────────────

const sessions = [
  {
    key: 'private:2832632980',
    label: '…2980',
    lastAtText: '20:13',
    messages: [{ text: '我是不是你主人', isSelf: false }, { text: '我和你主人同名', isSelf: false }],
  },
];

ok('正常话题概括应被保留', () => {
  const out = parseInboxSummary(JSON.stringify([
    { who: '…2980', lastAtText: '20:13', topic: '身份确认', gist: '在开玩笑自称主人', replied: true, pending: false },
  ]), { sessions });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].topic, '身份确认');
  assert.equal(out.dropped.length, 0);
});

ok('抄了原话的条目必须被丢弃', () => {
  const out = parseInboxSummary(JSON.stringify([
    { who: '…2980', lastAtText: '20:13', topic: '身份确认', gist: '他说我是不是你主人', replied: true, pending: false },
  ]), { sessions });
  assert.equal(out.items.length, 0);
  assert.equal(out.dropped.length, 1);
  assert.match(out.dropped[0].reason, /原话/);
});

ok('缺少 who/gist 的条目应被丢弃而不是补默认值', () => {
  const out = parseInboxSummary(JSON.stringify([
    { topic: '身份确认', gist: '' },
  ]), { sessions });
  assert.equal(out.items.length, 0);
  assert.equal(out.dropped.length, 1);
});

ok('模型带前言后语时仍能抠出 JSON', () => {
  const raw = '好的，我整理了一下：\n[{"who":"…2980","topic":"闲聊","gist":"随便聊了聊","replied":true}]\n以上。';
  const out = parseInboxSummary(raw, { sessions });
  assert.equal(out.items.length, 1);
});

ok('条目数不超过上限', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ who: `人${i}`, gist: '闲聊' }));
  const out = parseInboxSummary(JSON.stringify(many), { sessions: [] });
  assert.ok(out.items.length <= MAX_SESSIONS_PER_SUMMARY);
});

ok('转述文本会被脱敏（token 之类不得带出）', () => {
  const out = parseInboxSummary(JSON.stringify([
    { who: '…2980', topic: '聊配置', gist: '提到了 sk-abcdefghijklmnopqrstuvwxyz123456 这个串' },
  ]), { sessions: [] });
  for (const it of out.items) {
    assert.ok(!it.gist.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  }
});

// ── 渲染 ────────────────────────────────────────────────────────────────

ok('没有动态时给一句人话，不是空串', () => {
  assert.match(renderInboxSummary([], {}), /没有/);
});

ok('渲染包含话题但不含原文', () => {
  const text = renderInboxSummary([
    { who: '…2980', topic: '身份确认', gist: '在开玩笑自称主人', replied: true, pending: false },
  ], { totalUnread: 2 });
  assert.match(text, /身份确认/);
  assert.match(text, /2 条未读/);
  assert.ok(!text.includes('我是不是你主人'));
});

// ── 提示词约束 ──────────────────────────────────────────────────────────

ok('提示词必须明确禁止引用原话与细节', () => {
  const p = buildInboxSummaryPrompt([
    { key: 'private:1', label: '…0001', lastAtText: '20:00', messages: [{ text: '你好', isSelf: false }] },
  ], { ownerKey: 'private:2409281798' });
  assert.match(p, /不要引用原话/);
  assert.match(p, /不可信文本/);
});

ok('提示词素材里带上会话与发送者标记', () => {
  const p = buildInboxSummaryPrompt([
    { key: 'private:1', label: '…0001', lastAtText: '20:00', messages: [{ text: '在吗', isSelf: false, sender: '小王' }] },
  ], {});
  assert.match(p, /peer="…0001"/);
  assert.match(p, /<msg from="小王">/);
});

// ── 号码脱敏 ────────────────────────────────────────────────────────────

ok('maskQQ 只留后四位', () => {
  assert.equal(maskQQ('private:2832632980'), '…2980');
  assert.equal(maskQQ('group:123456789'), '群…6789');
  assert.equal(maskQQ('bad'), 'bad');
});

if (fail.length) {
  console.error(`\n❌ owner-inbox 测试失败 ${fail.length} 条：`);
  for (const f of fail) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`✅ owner-inbox 测试通过：${pass} 条`);
