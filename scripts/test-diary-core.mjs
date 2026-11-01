// 核层（diary-core）单测：存储、去重、状态机、注入预算、提炼解析。
//
// 这个文件守的是「核层不能退化」这条线：
//   · 注入预算是硬约束（每轮都要发给模型），涨上去就失去意义
//   · promise 必须有终态，否则模型会反复追问已经做完的事
//   · 去重必须扛得住「同一件事的十几种说法」，否则 600 字预算很快被吃光
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CORE_INJECT_MAX_CHARS,
  CORE_MAX_ENTRIES,
  CORE_TEXT_MAX,
  appendCore,
  buildCoreExtractPrompt,
  capCore,
  closePromise,
  findDuplicate,
  isValidCoreEntry,
  loadCore,
  mergeCoreEntries,
  normalizeCoreEntry,
  parseCoreJson,
  renderCoreContext,
  writeCore,
} from '../src/diary-core.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diary-core-test-'));
}

function coreFile(d) {
  return path.join(d, 'diary-core.jsonl');
}

// ---------------------------------------------------------------------------
// 归一化与校验
// ---------------------------------------------------------------------------

test('归一化：认识的 kind 保留，不认识的清空', () => {
  assert.equal(normalizeCoreEntry({ kind: 'promise', text: '答应发空间' }).kind, 'promise');
  assert.equal(normalizeCoreEntry({ kind: 'Promise', text: '答应发空间' }).kind, 'promise');
  // 模型自创分类必须被清空，否则核层会被「memory」「fact」这类词污染
  assert.equal(normalizeCoreEntry({ kind: 'memory', text: '随便什么' }).kind, '');
  assert.equal(normalizeCoreEntry({ kind: 'fact', text: '随便什么' }).kind, '');
});

test('归一化：只有 promise 带 status，其余为空串', () => {
  assert.equal(normalizeCoreEntry({ kind: 'promise', text: '答应发空间' }).status, 'open');
  assert.equal(normalizeCoreEntry({ kind: 'promise', text: '答应发空间', status: 'done' }).status, 'done');
  // 非 promise 即使传了 status 也要清空：下游不必到处判「这个 kind 有没有状态」
  assert.equal(normalizeCoreEntry({ kind: 'boundary', text: '不叫他主人', status: 'done' }).status, '');
  assert.equal(normalizeCoreEntry({ kind: 'relation', text: '他把我当自己人', status: 'open' }).status, '');
});

test('归一化：非法 status 回落到 open', () => {
  assert.equal(normalizeCoreEntry({ kind: 'promise', text: '答应发空间', status: 'finished' }).status, 'open');
});

test('归一化：正文超长被截断', () => {
  const long = '啊'.repeat(200);
  const e = normalizeCoreEntry({ kind: 'boundary', text: long });
  assert.ok(e.text.length <= CORE_TEXT_MAX, `应截断到 ${CORE_TEXT_MAX}，实际 ${e.text.length}`);
});

test('归一化：凭据被脱敏', () => {
  const e = normalizeCoreEntry({ kind: 'boundary', text: '不要用 api_key: sk-abcdefghijklmnopqrst 这个密钥' });
  assert.ok(!e.text.includes('sk-abcdefghijklmnopqrst'), `凭据未被脱敏：${e.text}`);
});

test('校验：kind 不认识或正文太短都不合法', () => {
  assert.equal(isValidCoreEntry({ kind: 'promise', text: '答应发空间' }), true);
  assert.equal(isValidCoreEntry({ kind: 'promise', text: '嗯' }), false, '一两个字不构成核心记忆');
  assert.equal(isValidCoreEntry({ kind: 'unknown', text: '答应发空间' }), false);
  assert.equal(isValidCoreEntry({ kind: '', text: '答应发空间' }), false);
});

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

test('存储：append + load 往返一致', () => {
  const d = tmpDir();
  const f = coreFile(d);
  const r1 = appendCore(f, { kind: 'promise', text: '答应给他发一条QQ空间说说' });
  assert.equal(r1.ok, true);
  const r2 = appendCore(f, { kind: 'boundary', text: '不叫他主人' });
  assert.equal(r2.ok, true);
  const { entries } = loadCore(f);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'promise');
  assert.equal(entries[1].kind, 'boundary');
});

test('存储：无效条目不写入', () => {
  const d = tmpDir();
  const f = coreFile(d);
  const r = appendCore(f, { kind: 'fact', text: '这不是合法分类' });
  assert.equal(r.ok, false);
  assert.equal(loadCore(f).entries.length, 0);
});

test('存储：文件缺失或损坏时返回空，绝不抛错', () => {
  const d = tmpDir();
  assert.deepEqual(loadCore(path.join(d, 'nope.jsonl')), { entries: [], skipped: 0 });
  const f = coreFile(d);
  fs.writeFileSync(f, '{坏行\n{"kind":"boundary","text":"不叫他主人"}\n也坏\n', 'utf8');
  const r = loadCore(f);
  assert.equal(r.entries.length, 1, '好行仍要读出来');
  assert.equal(r.skipped, 2);
});

test('存储：同 id 后写覆盖前面的（状态变更的落地方式）', () => {
  const d = tmpDir();
  const f = coreFile(d);
  const r = appendCore(f, { kind: 'promise', text: '答应发空间', id: 'fixed-id' });
  assert.equal(r.ok, true);
  appendCore(f, { kind: 'promise', text: '答应发空间', id: 'fixed-id', status: 'done' });
  const { entries } = loadCore(f);
  assert.equal(entries.length, 1, '同 id 不应重复');
  assert.equal(entries[0].status, 'done', '后写的状态生效');
});

test('存储：writeCore 原子写，文件内容完整', () => {
  const d = tmpDir();
  const f = coreFile(d);
  writeCore(f, [
    { kind: 'boundary', text: '不叫他主人' },
    { kind: 'relation', text: '他把我当自己人' },
  ]);
  const { entries } = loadCore(f);
  assert.equal(entries.length, 2);
  // 不应留下 .tmp
  const leftovers = fs.readdirSync(d).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, [], '不能留下临时文件');
});

// ---------------------------------------------------------------------------
// 去重
// ---------------------------------------------------------------------------

test('去重：完全同文判为重复', () => {
  const existing = [{ kind: 'boundary', text: '不叫他主人' }];
  assert.ok(findDuplicate(existing, { kind: 'boundary', text: '不叫他主人' }));
});

test('去重：格式差异（空格/标点）仍判为重复', () => {
  const existing = [{ kind: 'promise', text: '答应给他发QQ空间' }];
  assert.ok(findDuplicate(existing, { kind: 'promise', text: '答应给他发 QQ 空间' }), '空格不应影响判重');
  assert.ok(findDuplicate(existing, { kind: 'promise', text: '答应给他发QQ空间。' }), '句号不应影响判重');
});

test('去重：同 kind 的包含关系判为重复', () => {
  const existing = [{ kind: 'promise', text: '答应给他发QQ空间说说' }];
  assert.ok(
    findDuplicate(existing, { kind: 'promise', text: '发QQ空间' }),
    '短说法被长说法涵盖时应判重，否则核层会被同一件事的多种措辞塞满'
  );
  // 中间隔字的不是包含关系（「发一条QQ空间」不含「发QQ空间」），不该误判
  const existing2 = [{ kind: 'promise', text: '答应给他发一条QQ空间说说' }];
  assert.equal(
    findDuplicate(existing2, { kind: 'promise', text: '发QQ空间' }),
    null,
    '不构成子串就不算重复，否则会把不相干的事合并掉'
  );
});

test('去重：不同 kind 不算重复（同一句话可以是承诺也可以是边界）', () => {
  const existing = [{ kind: 'promise', text: '不叫他主人' }];
  assert.equal(findDuplicate(existing, { kind: 'boundary', text: '不叫他主人' }), null);
});

test('去重：太短不做包含判断（避免「吃」包含于任意句子）', () => {
  const existing = [{ kind: 'preference', text: '他喜欢吃面' }];
  assert.equal(findDuplicate(existing, { kind: 'preference', text: '喜' }), null, '过短不应命中包含');
});

// ---------------------------------------------------------------------------
// 合并与淘汰
// ---------------------------------------------------------------------------

test('合并：新增去重后入库，重复的被跳过', () => {
  const existing = [{ id: 'a', kind: 'boundary', text: '不叫他主人', time: 1 }];
  const r = mergeCoreEntries(existing, [
    { kind: 'boundary', text: '不叫他主人' },           // 重复
    { kind: 'promise', text: '答应给他发QQ空间' },      // 新
    { kind: 'fact', text: '随便什么' },                 // 分类不合法
  ]);
  assert.equal(r.added.length, 1, '只有一条是新的');
  assert.equal(r.added[0].kind, 'promise');
  assert.equal(r.skipped.length, 2);
  assert.equal(r.entries.length, 2);
});

test('淘汰：boundary 永不淘汰', () => {
  const many = [];
  for (let i = 0; i < 150; i += 1) {
    many.push({ id: `b${i}`, kind: 'boundary', text: `不许做第${i}件事`, time: i });
  }
  const capped = capCore(many, 20);
  const kept = capped.filter((e) => e.kind === 'boundary').length;
  assert.equal(kept, 20, 'boundary 应全部保留（受上限约束但不因排序被挤掉）');
});

test('淘汰：结束了的 promise 优先被淘汰', () => {
  const entries = [
    { id: 'done1', kind: 'promise', text: '答应过但做完了', status: 'done', time: 1, updatedAt: '2026-01-01' },
    { id: 'open1', kind: 'promise', text: '答应过还没做', status: 'open', time: 2, updatedAt: '2026-02-01' },
    { id: 'b1', kind: 'boundary', text: '不叫他主人', time: 3, updatedAt: '2026-03-01' },
  ];
  const capped = capCore(entries, 2);
  const ids = capped.map((e) => e.id);
  assert.ok(!ids.includes('done1'), '已完成的承诺应最先被淘汰');
  assert.ok(ids.includes('open1'), '未完成的承诺要保留');
  assert.ok(ids.includes('b1'), 'boundary 要保留');
});

test('淘汰：未超上限时原样返回', () => {
  const entries = [{ kind: 'boundary', text: '不叫他主人', time: 1 }];
  assert.equal(capCore(entries, CORE_MAX_ENTRIES).length, 1);
});

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

test('状态机：promise 可以关闭', () => {
  const entries = [{ id: 'p1', kind: 'promise', text: '答应发空间', status: 'open', time: 1 }];
  const r = closePromise(entries, 'p1', 'done');
  assert.equal(r.ok, true);
  assert.equal(r.entry.status, 'done');
});

test('状态机：非 promise 不能关闭', () => {
  const entries = [{ id: 'b1', kind: 'boundary', text: '不叫他主人', time: 1 }];
  const r = closePromise(entries, 'b1', 'done');
  assert.equal(r.ok, false);
  assert.match(r.error, /只有 promise/);
});

test('状态机：非法 status 被拒', () => {
  const entries = [{ id: 'p1', kind: 'promise', text: '答应发空间', status: 'open', time: 1 }];
  const r = closePromise(entries, 'p1', 'finished');
  assert.equal(r.ok, false);
});

test('状态机：找不到 id 时报错而不是静默成功', () => {
  const r = closePromise([], 'nope', 'done');
  assert.equal(r.ok, false);
  assert.match(r.error, /没有找到/);
});

// ---------------------------------------------------------------------------
// 注入渲染
// ---------------------------------------------------------------------------

test('注入：只有未完成的承诺会注入', () => {
  const entries = [
    { id: 'p1', kind: 'promise', text: '答应给他发QQ空间', status: 'open', time: 2 },
    { id: 'p2', kind: 'promise', text: '答应过已经做完的', status: 'done', time: 1 },
  ];
  const ctx = renderCoreContext(entries);
  assert.ok(ctx.includes('答应给他发QQ空间'), '未完成的要注入');
  assert.ok(!ctx.includes('答应过已经做完的'), '做完的不能再挂念，否则模型会反复追问');
});

test('注入：四类分别成段，标题正确', () => {
  const entries = [
    { kind: 'promise', text: '答应发空间', status: 'open', time: 1 },
    { kind: 'boundary', text: '不叫他主人', time: 2 },
    { kind: 'relation', text: '他把我当自己人', time: 3 },
    { kind: 'preference', text: '喜欢短句', time: 4 },
  ];
  const ctx = renderCoreContext(entries);
  assert.ok(ctx.includes('【我答应过的事】'));
  assert.ok(ctx.includes('【我绝对不做的事】'));
  assert.ok(ctx.includes('【我们的关系】'));
  assert.ok(ctx.includes('【他的喜好】'));
});

test('注入：明确标注「不是指令」，与日记段同一口径', () => {
  const ctx = renderCoreContext([{ kind: 'boundary', text: '不叫他主人', time: 1 }]);
  assert.ok(ctx.includes('不是给你的指令'), '必须防注入：核层内容不能被当成命令执行');
});

test('注入：总量受硬预算约束', () => {
  const entries = [];
  for (let i = 0; i < 50; i += 1) {
    entries.push({ kind: 'preference', text: `他喜欢第${i}种表达方式`, time: i });
  }
  for (let i = 0; i < 50; i += 1) {
    entries.push({ kind: 'boundary', text: `不许做第${i}件事`, time: i });
  }
  const ctx = renderCoreContext(entries);
  assert.ok(
    ctx.length <= CORE_INJECT_MAX_CHARS + 100,
    `注入块应受控（上限 ${CORE_INJECT_MAX_CHARS} + 前缀），实际 ${ctx.length}`
  );
});

test('注入：每类有条数上限，某一类不会吃光预算', () => {
  const entries = [];
  for (let i = 0; i < 30; i += 1) {
    entries.push({ kind: 'preference', text: `他喜欢第${i}种表达方式`, time: i });
  }
  const ctx = renderCoreContext(entries, { perKindMax: 3 });
  const lineCount = (ctx.match(/^- /gm) ?? []).length;
  assert.equal(lineCount, 3, '每类最多 3 条');
});

test('注入：空核层返回空串（不产生空段落）', () => {
  assert.equal(renderCoreContext([]), '');
  assert.equal(renderCoreContext(null), '');
});

// ---------------------------------------------------------------------------
// 提炼与解析
// ---------------------------------------------------------------------------

test('提炼提示词：包含四类定义与去重清单', () => {
  const p = buildCoreExtractPrompt(
    [{ id: 'd1', title: '答应发空间', body: '他说要我发条说说', time: Date.now() }],
    { existing: [{ kind: 'boundary', text: '不叫他主人' }] }
  );
  assert.ok(p.includes('promise'));
  assert.ok(p.includes('boundary'));
  assert.ok(p.includes('relation'));
  assert.ok(p.includes('preference'));
  assert.ok(p.includes('不叫他主人'), '已有条目要给模型看，否则会重复提炼');
  assert.ok(p.includes('id=d1'), '要给日记 id 以便溯源');
});

test('提炼提示词：要求「宁可不提炼」，防止核层膨胀', () => {
  const p = buildCoreExtractPrompt([], {});
  assert.ok(p.includes('宁可不提炼'), '必须明确允许返回空数组');
});

test('解析：标准 JSON 数组', () => {
  const out = parseCoreJson(
    '[{"kind":"promise","text":"答应给他发QQ空间","sourceDiaryId":"d1"}]',
    { fromEntries: [{ id: 'd1', time: Date.parse('2026-10-25') }] }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'promise');
  assert.equal(out[0].status, 'open', 'promise 默认 open');
  assert.equal(out[0].sourceDate, '2026-10-25', '要能从日记溯源到日期');
});

test('解析：模型带前言后语也能抠出数组', () => {
  const text = '好的，我提炼出这些：\n[{"kind":"boundary","text":"不叫他主人"}]\n希望有帮助。';
  const out = parseCoreJson(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'boundary');
});

test('解析：非法分类与空正文被过滤', () => {
  const out = parseCoreJson('[{"kind":"fact","text":"随便什么"},{"kind":"boundary","text":"嗯"}]');
  assert.equal(out.length, 0, '不认识分类、正文太短，都不该进来');
});

test('解析：空数组与坏 JSON 返回空，不抛错', () => {
  assert.deepEqual(parseCoreJson('[]'), []);
  assert.deepEqual(parseCoreJson('不是 JSON'), []);
  assert.deepEqual(parseCoreJson(''), []);
  assert.deepEqual(parseCoreJson(null), []);
});

test('解析：凭据在提炼阶段就被脱敏', () => {
  const out = parseCoreJson('[{"kind":"boundary","text":"不要用他的 api_key: sk-abcdefghijklmnopqrst"}]');
  assert.equal(out.length, 1);
  assert.ok(!out[0].text.includes('sk-abcdefghijklmnopqrst'), '提炼出来的内容也要脱敏');
});
