// 验证语气锚点与常驻人设。
//
// 这两项解决的是同一个问题的两半：
//   · 常驻人设（persistentRoleText）：每轮都在场，防语气慢慢稀释。
//   · 语气锚点（TONE_ANCHOR）：一小段示范对话，把已经稀释的语气拉回来。
//
// 背景依据见 tone-anchor.js 顶部（ContextEcho: arXiv 2605.24279）。
// 这里锁住三条不能漂的约束：内容存在、成本受控、示范不含会被误接的具体事实。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TONE_ANCHOR, TONE_ANCHOR_CHARS } from '../src/tone-anchor.js';
import { selectPersistentRoleText, parseRoleSections } from '../src/role-card.js';

const ROLE_PATH = 'E:/dsh/qq-bridge/roles/小鲸鱼.md';

test('语气锚点存在且非空', () => {
  assert.ok(TONE_ANCHOR.length > 50, '锚点太短，起不到示范作用');
});

test('语气锚点必须明确声明「不是要发出去的内容」', () => {
  // 不声明的话，模型可能把示范当成真实对话复述/接话——那是新的出戏来源。
  assert.ok(/不是要发出去的内容/.test(TONE_ANCHOR), '缺少「不是要发出去」的声明');
  assert.ok(/别照抄/.test(TONE_ANCHOR), '缺少「别照抄」的约束');
});

test('语气锚点成本受控（ContextEcho 的量级是 ~110 token ≈ 150 汉字）', () => {
  assert.ok(TONE_ANCHOR_CHARS < 400, `锚点 ${TONE_ANCHOR_CHARS} 字符过长，会挤压真实上下文`);
  assert.ok(TONE_ANCHOR_CHARS > 80, '锚点过短，示范不足');
});

test('语气锚点示范的是短句+空格分句，不是 AI 腔', () => {
  // 抽查示范里不该出现的东西：客套收尾、复述对方。
  const banned = ['希望对你有所帮助', '有什么可以帮你', '确实', '有道理'];
  for (const b of banned) {
    assert.ok(!TONE_ANCHOR.includes(b), `示范里出现了 AI 腔词「${b}」，等于反向教学`);
  }
});

test('人格卡里必须至少有一个〔常驻〕小节', () => {
  // 没有常驻标记时，selectPersistentRoleText 返回空串，
  // 「每轮注入人设」的机制会静默空转——这是 2026-11-03 实测发现的真实故障。
  const raw = fs.readFileSync(ROLE_PATH, 'utf8');
  const sections = parseRoleSections(raw);
  const persistent = sections.filter((s) => s.persistent);
  assert.ok(persistent.length > 0, '没有人格小节打了〔常驻〕标记，每轮注入会是空的');
});

test('常驻人设内容在 bridge 的实际上限内（否则会被无声截断）', () => {
  const raw = fs.readFileSync(ROLE_PATH, 'utf8');
  const picked = selectPersistentRoleText(raw, 'v2');
  // 与 bridge.js 的 PERSISTENT_ROLE_MAX_CHARS 保持一致。
  // 2026-11-03：实测「禁用词表 + 主人教的说话方式」= 1409，原上限 1400 会截掉最后一条规则，
  // 因此 bridge 把上限调到 1500。这里跟着改，否则两边漂移。
  const LIMIT = 1500;
  assert.ok(picked.length > 0, '常驻内容是空的');
  assert.ok(
    picked.length <= LIMIT,
    `常驻内容 ${picked.length} 字符，超过 ${LIMIT} 上限会被截断，应精简或提高上限`
  );
});

test('常驻人设里包含禁用词表与主人教的规则', () => {
  const raw = fs.readFileSync(ROLE_PATH, 'utf8');
  const picked = selectPersistentRoleText(raw, 'v2');
  assert.ok(/禁用词表|别用/.test(picked), '常驻内容缺少禁用词表');
  assert.ok(/主人教的说话方式|别用鼠鼠|别像AI/.test(picked), '常驻内容缺少主人教的说话规则');
});