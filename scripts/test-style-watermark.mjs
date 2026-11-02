#!/usr/bin/env node
// 水位隔离测试：证明「事实提炼推进水位」不会让「风格同步」读不到素材。
//
// ## 为什么单独测这件事
//
// 实现时踩到过一个真实缺陷：事实提炼和风格同步最初共用同一个归档水位
// （ownerMeta.archiveOffsets[key]）。两者都读 OWNER_CHAT_ARCHIVE，而事实提炼
// 先跑并推进水位 —— 于是风格同步随后从新水位开始读，永远读到 0 条，
// 表现为「功能写好了但从没生效」，而且**没有任何报错**，只看日志根本发现不了。
//
// 修法是给每个消费者独立的键命名空间：
//   事实提炼 key / 日记 diary:key / 风格 style:key
//
// 这个测试用真实的归档读写函数跑一遍，钉住「独立水位」这个契约。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendArchiveLine, readArchiveSince } from '../src/owner-memory.js';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(detail ? `${name} :: ${detail}` : name);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-wm-'));
const archive = path.join(tmpDir, 'archive.jsonl');

// 造 40 条主人消息
const KEY = 'private:10001';
for (let i = 0; i < 40; i += 1) {
  appendArchiveLine(archive, {
    key: KEY,
    speaker: '主人',
    isSelf: false,
    text: `第 ${i} 条消息 别用鼠鼠`,
    time: Date.now() + i,
  });
}

// 模拟：事实提炼先跑完，把公共水位推到末尾
const FACT_KEY = KEY;
let factOffset = 0;
const factRead = readArchiveSince(archive, factOffset, { maxLines: 40 });
ok(factRead.records.length === 40, '事实提炼读到 40 条');
factOffset = factRead.nextOffset;
ok(factOffset === 40, '事实提炼推进水位到 40');

// 关键断言：风格同步用的是**独立**水位，因此仍能读到全部素材
const STYLE_KEY = `style:${KEY}`;
const styleStart = 0; // style:key 从未被写过 → 起点是 0
const styleRead = readArchiveSince(archive, styleStart, { maxLines: 40 });
const mine = styleRead.records.filter((m) => m && m.key === KEY && !m.isSelf && m.text);
ok(mine.length === 40, '风格同步仍能读到 40 条（不被事实提炼的水位挡住）', `实际 ${mine.length}`);

// 反证：如果误用公共水位（=40），风格同步就什么都读不到
const wrongRead = readArchiveSince(archive, factOffset, { maxLines: 40 });
const wrongMine = wrongRead.records.filter((m) => m && m.key === KEY && !m.isSelf && m.text);
ok(wrongMine.length === 0, '共用公共水位会读到 0 条（缺陷复现，证明测试有效）', `实际 ${wrongMine.length}`);

// 键命名空间互不干扰
const offsets = {};
function get(k) { return Math.max(0, Number(offsets[k]) || 0); }
function set(k, v) { offsets[k] = Math.max(0, Number(v) || 0); }
set(FACT_KEY, 40);
ok(get(STYLE_KEY) === 0, '写事实水位不影响风格水位');
set(STYLE_KEY, 20);
ok(get(FACT_KEY) === 40, '写风格水位不影响事实水位');
ok(get('diary:' + KEY) === 0, '写风格水位不影响日记水位');

// 多个会话互不干扰
set(`style:${KEY}`, 10);
ok(get('style:private:99999') === 0, '不同会话的风格水位独立');

// ── bridge 集成契约：这些路径不能只靠纯函数测试 ─────────────────────────
// runStyleExtraction 本身已经由 queueOwnerTask 串行执行。如果它内部再次
// queueOwnerTask 并等待 ownerTaskChain，就会等待“自己完成后才能执行”的写盘任务，
// 形成永久自等待。2026-10-26 审查发现该路径会让风格同步及后续主人记忆任务卡住。
const bridgeSource = fs.readFileSync(path.join(process.cwd(), 'src', 'bridge.js'), 'utf8');
const styleFn = bridgeSource.match(/async function runStyleExtraction\(key\) \{[\s\S]*?\n  \}/);
ok(Boolean(styleFn), 'bridge 中存在 runStyleExtraction');
if (styleFn) {
  ok(!/queueOwnerTask\s*\(/.test(styleFn[0]), '风格任务不在自己的串行链里二次排队（防死锁）');
  ok(!/await\s+ownerTaskChain/.test(styleFn[0]), '风格任务不等待包含自己的 ownerTaskChain（防死锁）');
  ok(/setOwnerArchiveOffset\(styleWatermarkKey\(key\),\s*nextOffset\)/.test(styleFn[0]),
    '风格水位只推进到本批实际读取位置，不跳过等待期间的新消息');
  ok(!/Number\(totalLines\)\s*\|\|\s*offset/.test(styleFn[0]),
    '风格水位不再跳到实时文件尾');
  ok(/readArchiveForKey\(/.test(styleFn[0]), '风格读取按 key 扫过稀疏归档，避免水位卡死');
  ok(!/candidates\.length\s*===\s*0\)\s*return/.test(styleFn[0]),
    '空候选也推进已完成批次，避免反复消耗 token');
}

const archiveFn = bridgeSource.match(/function archiveOwnerMessage\(key, msg\) \{[\s\S]*?\n  \}/);
ok(Boolean(archiveFn) && /!styleSyncEnabled\(\)/.test(archiveFn[0]),
  '仅开启 styleSync 时也会写归档');

const learnerFn = bridgeSource.match(/async function ensureOwnerLearnerSession\(\) \{[\s\S]*?\n  \}/);
ok(Boolean(learnerFn) && /if \(ownerLearnerSessionPromise\) return ownerLearnerSessionPromise;/.test(learnerFn[0]),
  '主人学习会话创建有 single-flight 防重复');

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n总计: ${pass + fail} 通过, ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('水位隔离全部通过');
