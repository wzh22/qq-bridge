// 主人长期记忆的端到端验证。
//
// 与 test-owner-memory.mjs（纯逻辑单测）不同，这里验证的是**接线**：
// 归档写入 -> 水位推进 -> 提炼合并 -> prompt 注入，整条链路是否连得起来。
//
// 不启动真实 DSH 会话（那需要完整环境的 LLM 调用），而是直接把归档文件
// 和提炼结果喂给模块，验证接线语义。速度快、可重复、不花钱。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendArchiveLine,
  readArchiveSince,
  loadOwnerMemory,
  saveOwnerMemory,
  mergeFacts,
  buildOwnerMemoryContext,
  buildFactExtractionPrompt,
  parseFactJson,
} from '../src/owner-memory.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed += 1; } catch (error) { failed += 1; failures.push({ name, error }); }
}

const ROOT = path.join(process.cwd(), 'state', 'tmp', `owner-memory-e2e-${process.pid}`);
fs.mkdirSync(ROOT, { recursive: true });
process.on('exit', () => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {} });

const ARCHIVE = path.join(ROOT, 'owner-chat.jsonl');
const MEMFILE = path.join(ROOT, 'owner-memory.json');
const KEY = 'private:2409281798';

// --- 场景 1：完整的一轮「归档 -> 提炼 -> 注入」 ---

test('端到端：归档 25 条主人消息后，能从水位 0 全部读出', () => {
  fs.writeFileSync(ARCHIVE, '', 'utf8');
  for (let i = 0; i < 25; i += 1) {
    appendArchiveLine(ARCHIVE, {
      key: KEY,
      speaker: '私聊',
      isSelf: false,
      text: `主人说的第${i}句话：我在备考公安联考`,
      time: Date.now() + i,
    });
  }
  const { records, totalLines } = readArchiveSince(ARCHIVE, 0, { maxLines: 100 });
  assert.equal(records.length, 25);
  assert.equal(totalLines, 25);
  assert.ok(records.every((r) => r.key === KEY));
});

test('端到端：提炼出事实并写入记忆库', () => {
  const { records } = readArchiveSince(ARCHIVE, 0, { maxLines: 100 });
  const prompt = buildFactExtractionPrompt(records, []);
  assert.ok(prompt.includes('备考公安联考'), '对话内容必须进入提示词');

  // 模拟模型返回
  const modelOutput = `提取完成：
[{"category":"goal","text":"主人在备考公安联考","replaces":""},
 {"category":"identity","text":"主人是陕西警察学院大三学生","replaces":""}]`;
  const candidates = parseFactJson(modelOutput);
  assert.equal(candidates.length, 2);

  const merged = mergeFacts([], candidates.map((c) => ({
    ...c,
    sources: [{ key: KEY, speaker: '私聊', text: '在备考公安联考', time: Date.now() }],
  })));
  assert.equal(merged.added, 2);
  saveOwnerMemory(MEMFILE, merged.facts, { archiveOffsets: { [KEY]: 25 } });

  const loaded = loadOwnerMemory(MEMFILE);
  assert.equal(loaded.facts.length, 2);
  assert.equal(loaded.meta.archiveOffsets[KEY], 25, '水位必须持久化，避免重复提炼');
});

test('端到端：注入的 prompt 含新事实且格式正确', () => {
  const { facts } = loadOwnerMemory(MEMFILE);
  const ctx = buildOwnerMemoryContext(facts);
  assert.ok(ctx.includes('【关于主人】'));
  assert.ok(ctx.includes('备考公安联考'));
  assert.ok(ctx.includes('陕西警察学院'));
});

// --- 场景 2：增量提炼不重复 ---

test('端到端：水位推进后，新增消息不重复提炼旧内容', () => {
  const { nextOffset } = readArchiveSince(ARCHIVE, 0, { maxLines: 100 });
  assert.equal(nextOffset, 25);

  // 再加 3 条新消息
  for (let i = 0; i < 3; i += 1) {
    appendArchiveLine(ARCHIVE, { key: KEY, text: `新消息${i}`, time: Date.now() });
  }
  const inc = readArchiveSince(ARCHIVE, nextOffset, { maxLines: 100 });
  assert.equal(inc.records.length, 3, '只应读到新增的 3 条');
  assert.ok(inc.records.every((r) => String(r.text).startsWith('新消息')));
});

test('端到端：重复提炼同一事实只加重权重，不重复入库', () => {
  const { facts } = loadOwnerMemory(MEMFILE);
  const again = mergeFacts(facts, [{ category: 'goal', text: '主人在备考公安联考' }]);
  assert.equal(again.facts.length, 2, '条目数不变');
  const goal = again.facts.find((f) => f.text.includes('备考'));
  assert.equal(goal.weight, 2, '权重应累加');
});

// --- 场景 3：只增不删的端到端保证 ---

test('端到端：事实更新后旧版本仍在磁盘上', () => {
  const { facts } = loadOwnerMemory(MEMFILE);
  const updated = mergeFacts(facts, [{
    category: 'identity',
    text: '主人是中国人民公安大学研究生',
    replaces: '主人是陕西警察学院大三学生',
  }]);
  saveOwnerMemory(MEMFILE, updated.facts, { archiveOffsets: { [KEY]: 28 } });

  // 直接读磁盘原文，确认旧事实的字符串还在文件里
  const raw = fs.readFileSync(MEMFILE, 'utf8');
  assert.ok(raw.includes('陕西警察学院'), '旧事实必须仍存在于磁盘（只增不删）');
  assert.ok(raw.includes('中国人民公安大学'), '新事实必须已写入');

  // 但注入时不带旧事实
  const { facts: reloaded } = loadOwnerMemory(MEMFILE);
  const ctx = buildOwnerMemoryContext(reloaded);
  assert.ok(!ctx.includes('陕西警察学院'), '已被取代的旧事实不应进 prompt');
});

// --- 场景 4：异常路径 ---

test('端到端：归档文件为空时不炸', () => {
  const emptyFile = path.join(ROOT, 'empty.jsonl');
  fs.writeFileSync(emptyFile, '', 'utf8');
  const r = readArchiveSince(emptyFile, 0);
  assert.deepEqual(r.records, []);
});

test('端到端：水位超过文件行数时安全收敛', () => {
  const r = readArchiveSince(ARCHIVE, 9999, { maxLines: 10 });
  assert.deepEqual(r.records, []);
  assert.ok(r.nextOffset <= r.totalLines + 1);
});

test('端到端：模型返回空数组时不写入任何事实', () => {
  const candidates = parseFactJson('[]');
  assert.equal(candidates.length, 0);
  const merged = mergeFacts([], candidates);
  assert.equal(merged.facts.length, 0);
});

test('端到端：记忆库损坏时不返回空库（防止下次保存覆盖）', () => {
  const broken = path.join(ROOT, 'broken.json');
  fs.writeFileSync(broken, 'not json at all', 'utf8');
  assert.throws(() => loadOwnerMemory(broken), /解析失败/);
});

console.log(`\n主人记忆端到端：${passed} 通过，${failed} 失败`);
if (failed > 0) {
  for (const f of failures) {
    console.error(`\n✗ ${f.name}`);
    console.error(`  ${f.error?.message ?? f.error}`);
  }
  process.exit(1);
}
