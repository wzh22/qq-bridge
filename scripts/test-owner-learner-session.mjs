// 主人学习会话的创建与退役竞态回归。
// 直接抽取 bridge 中的真实函数，用内存 mock 执行；不创建目录、会话或网络请求。

import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const ensureFn = source.match(/async function ensureOwnerLearnerSession\(\) \{[\s\S]*?\n  \}/);
const invalidateFn = source.match(/function invalidateOwnerLearnerSession\(sessionId\) \{[\s\S]*?\n  \}/);

let pass = 0;
let fail = 0;
function ok(name, condition, detail = '') {
  if (condition) { console.log(`  ✅ ${name}`); pass += 1; }
  else { console.log(`  ❌ ${name}${detail ? ` → ${detail}` : ''}`); fail += 1; }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${actual}，预期 ${expected}`);
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

if (!ensureFn || !invalidateFn) {
  console.error('找不到 ensureOwnerLearnerSession / invalidateOwnerLearnerSession');
  process.exit(1);
}

function makeHarness(ids, ensureChatModel) {
  let createCount = 0;
  const api = {
    workspace: {
      create: async () => ({ result: { created: false, workspace: { workspaceId: 'workspace-test' } } }),
      rename: async () => ({}),
    },
    sessions: {
      create: async () => {
        const sessionId = ids[createCount] ?? `S${createCount + 1}`;
        createCount += 1;
        return { result: { sessionId } };
      },
    },
    events: { follow() {} },
  };
  const cfg = { ownerMemory: {}, slang: {}, agentPreset: 'safe-test-preset' };
  const factory = new Function('cfg', 'api', 'ensureChatModel', `
    let ownerLearnerSessionId = null;
    let ownerLearnerSessionPromise = null;
    const learnerSessions = new Set();
    const internalSessionLabels = new Map();
    const resolvePresetName = () => 'safe-test-preset';
    const path = { join: (...parts) => parts.join('/') };
    const STATE_DIR = 'unused';
    const fs = { mkdirSync() {} };
    const log = () => {};
    const unwrap = (value) => value?.result ?? value;
    ${invalidateFn[0]}
    ${ensureFn[0]}
    return {
      ensure: ensureOwnerLearnerSession,
      invalidate: invalidateOwnerLearnerSession,
      current: () => ownerLearnerSessionId,
    };
  `);
  const harness = factory(cfg, api, ensureChatModel);
  return { ...harness, creates: () => createCount };
}

console.log('=== 1. 并发首次创建必须共用同一个会话 ===');
{
  const gate = deferred();
  const h = makeHarness(['S'], () => gate.promise);
  const first = h.ensure();
  const second = h.ensure();
  await new Promise((resolve) => setImmediate(resolve));
  eq('并发期间只创建一次', h.creates(), 1);
  gate.resolve('applied');
  eq('第一个调用返回 S', await first, 'S');
  eq('第二个调用返回 S', await second, 'S');
  eq('当前句柄为 S', h.current(), 'S');
}

console.log('\n=== 2. 模型初始化失败不能发布未就绪句柄 ===');
{
  const h = makeHarness(['S', 'T'], async (id) => id === 'S' ? 'failed' : 'applied');
  let message = '';
  try { await h.ensure(); } catch (error) { message = String(error?.message ?? error); }
  ok('failed 返回值会转成失败', message.includes('模型初始化失败'), message);
  eq('失败后没有当前句柄', h.current(), null);
  eq('下一次创建并初始化新会话 T', await h.ensure(), 'T');
  eq('没有复用未初始化的 S', h.creates(), 2);
}

console.log('\n=== 3. 旧任务失败不能误清新会话 ===');
{
  const gate = deferred();
  const h = makeHarness(['S', 'T'], async (id) => id === 'T' ? gate.promise : 'applied');
  eq('先建立旧会话 S', await h.ensure(), 'S');
  h.invalidate('S');
  eq('旧会话正常退役', h.current(), null);

  const creating = h.ensure();
  await new Promise((resolve) => setImmediate(resolve));
  eq('新会话 T 正在初始化', h.creates(), 2);
  h.invalidate('S'); // 旧队列晚些失败：不能与 T 的创建发生竞争。
  gate.resolve('applied');
  eq('创建返回局部会话 T，而非全局空值', await creating, 'T');
  eq('T 初始化后成为当前句柄', h.current(), 'T');

  h.invalidate('S'); // 更晚到达的旧失败也不能清掉已就绪的 T。
  eq('旧失败不会清掉新句柄', h.current(), 'T');
  eq('后续仍复用 T', await h.ensure(), 'T');
  eq('没有多余第三次创建', h.creates(), 2);
}

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
