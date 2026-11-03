// 自动会话轮换（2026-11-03）：触发条件 / 记忆优先 / 失败即不换 / 免打扰 / 重启恢复。
//
// 为什么要这套断言
// ----------------
// 这个功能会**主动把一段聊天记录的 DSH 会话退役**。写错方向的代价是不对称的：
//   · 该换没换 → 只是会话继续变大（延迟高一点，还能用）；
//   · 不该换却换了 → 这段对话连同没写进日记的细节一起丢掉，且不可恢复。
// 所以下面的用例几乎全在证明「什么时候**不**换」，只有一条走正常路径，并且那条
// 必须证明顺序是「先写记忆、等它写完，再退役」。
//
// 时间常数全部用毫秒级（idleMs = 10ms），不真等 20 分钟。
//
// 用法：node --test scripts/test-session-rotate.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const TOKEN = 'fixture-console-token';
const KEY = 'group:456';

// 一轮「整理日记」的模型输出（真实形状见 src/diary.js 的 buildDiaryWritePrompt）。
const DIARY_JSON = JSON.stringify([{
  title: '轮换前的记忆',
  body: '我们聊了很久，她说下次还来。',
  mood: 'calm',
  tags: ['测试'],
  people: [],
  quote: '',
  importance: 3
}]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configFor(rotation) {
  return {
    consoleToken: TOKEN,
    diary: { enabled: true, minMessages: 5, batchMessages: 30 },
    socialV2: {
      enabled: true,
      agentPreset: 'qq-chat-v2',
      proactive: { enabled: false, quietRanges: [] },
      rotation: {
        enabled: true,
        minTurns: 3,
        minMessages: 1000,
        idleMs: 10,
        checkIntervalMs: 30000,
        respectQuietHours: true,
        memoryFailureBackoffMs: 0,
        ...rotation
      }
    }
  };
}

async function fixture({ rotation = {}, files = {}, savedState = null } = {}) {
  const h = await bridgeHarness({ config: configFor(rotation), files, savedState });
  h.setMode('reserved2');
  const sessionId = await h.ensureSession(KEY);
  return { h, sessionId };
}

/** 归档里写几条这个会话的来信（日记通道的唯一输入）。 */
function seedArchive(h, count = 4) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      key: KEY,
      speaker: 'fixture-person',
      isSelf: i % 2 === 1,
      text: `第 ${i + 1} 句话`,
      time: Date.now() - (count - i) * 1000
    }));
  }
  fs.writeFileSync(path.join(h.temp, 'state/owner-chat.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

/** 模拟一个**正常收尾**的回合（turn/start → turn/end），pumpMux 的收尾动作也一并补上。 */
function completeTurn(h, sessionId, turn) {
  h.trackTurnEvent(sessionId, { type: 'turn/start', data: { turn } });
  const done = h.trackTurnEvent(sessionId, {
    type: 'turn/end',
    data: { turn, reason: { kind: 'completed' } }
  });
  // pumpMux 在 if (ended) 分支里删 v2TurnStartAt（见 trackTurnEvent 的注释），
  // 测试直接调 trackTurnEvent 时得自己补这一下，否则会话会被判成「还在跑」。
  h.v2TurnStartAt.delete(sessionId);
  return done;
}

function diaryText(h) {
  try { return fs.readFileSync(path.join(h.temp, 'state/diary-others.jsonl'), 'utf8'); }
  catch { return ''; }
}

function rotationStore(h) {
  try { return JSON.parse(fs.readFileSync(path.join(h.temp, 'state/session-rotation.json'), 'utf8')); }
  catch { return null; }
}

/**
 * 让「整理日记」成功完成：
 *   · 记录 prompts 调用（用于证明记忆通道真的被用过）；
 *   · 在 waitLearnerTurn 注册完 waiter 之后，把答案喂给那个 waiter。
 * （VM 里没有 pumpMux，学习会话的 turn/end 只能在测试侧模拟。）
 */
function installDiarySuccess(h, timeline) {
  const prompt = async (params) => {
    timeline.push({ what: 'diaryPrompt', at: Date.now(), sessionId: params.sessionId });
    setTimeout(() => {
      const waiters = h.learnerWaiters.get(params.sessionId) ?? [];
      const waiter = waiters.shift();
      if (waiters.length === 0) h.learnerWaiters.delete(params.sessionId);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(DIARY_JSON);
      }
    }, 20);
    return { result: { ok: true, value: {} } };
  };
  h.api.sessions.prompt = prompt;
}

/** 在「退役」发生的那一刻回头看一眼日记文件：它必须已经包含这次整理的成果。 */
function installArchiveProbe(h, timeline) {
  const original = h.api.workspace.archiveSession;
  let sawDiaryAtArchive = null;
  h.api.workspace.archiveSession = async ({ sessionId }) => {
    timeline.push({ what: 'archive', at: Date.now(), sessionId });
    sawDiaryAtArchive = diaryText(h).includes('轮换前的记忆');
    return original({ sessionId });
  };
  return () => sawDiaryAtArchive;
}

/** 取一段覆盖「此刻」的免打扰区间（±2 分钟，自动处理跨午夜）。 */
function quietRangeAroundNow() {
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = Date.now();
  return [{ start: clock(new Date(now - 2 * 60 * 1000)), end: clock(new Date(now + 2 * 60 * 1000)) }];
}

// ───────────────────────────────────────────────────────────────────────────
// 触发条件
// ───────────────────────────────────────────────────────────────────────────

test('不换：轮次和消息数都没到阈值', async () => {
  const { h, sessionId } = await fixture();
  try {
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, false);
    assert.equal(r.skipped, 'not-long-enough');
    assert.equal(h.state.sessions[KEY], sessionId, '会话映射不能被改动');
    assert.deepEqual(h.calls.archived, [], '没换会话就不该归档任何 DSH 会话');
    assert.equal(h.calls.prompts.length, 0, '条件不满足时连记忆整理都不该排');
  } finally { await h.close(); }
});

test('不换：刚说过话（不满足空闲窗口）', async () => {
  const { h, sessionId } = await fixture({ rotation: { idleMs: 60_000 } });
  try {
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    h.getSocialV2State(KEY).lastIncomingAt = Date.now(); // 刚刚还有人来消息
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, false);
    assert.equal(r.skipped, 'not-idle');
    assert.equal(h.state.sessions[KEY], sessionId);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('不换：还有一个回合没跑完（在跑）', async () => {
  const { h, sessionId } = await fixture();
  try {
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    // 第 4 轮只开始、不结束：模拟正在执行的 turn / 工具调用。
    // v2TurnStartAt 在真实链路由 pumpMux 的 turn/start 分支写入，测试直接调
    // trackTurnEvent 时要自己补（它是 isConversationBusyV2 判「忙」的依据）。
    h.trackTurnEvent(sessionId, { type: 'turn/start', data: { turn: 4 } });
    h.v2TurnStartAt.set(sessionId, Date.now());
    await delay(30); // 让空闲窗口过去，确保拦住它的是「在跑」而不是「不空闲」
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, false);
    assert.equal(r.skipped, 'busy');
    assert.equal(h.state.sessions[KEY], sessionId);
    assert.equal(h.calls.prompts.length, 0, '在跑的时候绝不能去排记忆整理');
  } finally { await h.close(); }
});

test('不换：还有未读消息没处理', async () => {
  const { h, sessionId } = await fixture();
  try {
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    h.appendSocialV2Message(KEY, 'fixture-person', '这条还没回', '这条还没回', false, false, '9001', [], '789', []);
    const st = h.getSocialV2State(KEY);
    // 来信会刷新「最后活跃时刻」；等过空闲窗口，确保拦住它的是「未读」而不是「不空闲」。
    await delay(30);
    st.lastIncomingAt = Date.now() - 10_000;
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, false);
    assert.equal(r.skipped, 'unread-pending');
    assert.equal(h.state.sessions[KEY], sessionId);
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('不换：免打扰时段内', async () => {
  const { h, sessionId } = await fixture({
    rotation: { quietRanges: quietRangeAroundNow(), respectQuietHours: true }
  });
  try {
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    await delay(30);
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, false);
    assert.equal(r.skipped, 'quiet-hours');
    assert.equal(h.state.sessions[KEY], sessionId);
    assert.equal(h.calls.prompts.length, 0, '免打扰时段不该触发记忆整理的模型调用');
  } finally { await h.close(); }
});

test('不换：功能关闭时连判定都不做', async () => {
  const { h, sessionId } = await fixture({ rotation: { enabled: false } });
  try {
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    await delay(30);
    const swept = await h.sweepSessionRotation();
    assert.equal(swept.skipped, 'disabled');
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.skipped, 'disabled');
    assert.equal(h.state.sessions[KEY], sessionId);
  } finally { await h.close(); }
});

test('不换：日记本关闭时（没有「先写记忆」这一步，就绝不换）', async () => {
  const { h, sessionId } = await fixture({ rotation: {} });
  try {
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    await delay(30);
    h.cfg.diary.enabled = false;
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, false);
    assert.equal(r.skipped, 'diary-disabled');
    assert.equal(h.state.sessions[KEY], sessionId);
    assert.deepEqual(h.calls.archived, []);
  } finally { await h.close(); }
});

test('轮换后新会话的计数从零开始，且轮换次数累计', async () => {
  const { h, sessionId } = await fixture();
  const timeline = [];
  try {
    seedArchive(h);
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    installDiarySuccess(h, timeline);
    installArchiveProbe(h, timeline);
    await delay(30);
    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, true, `${r.skipped} ${r.reason || ''}`);

    // 下一条消息到来（会新建会话）→ 计数重新从 0 起，轮换次数保留。
    const next = await h.ensureSession(KEY);
    assert.notEqual(next, sessionId, '轮换后应创建一条新会话');
    h.appendSocialV2Message(KEY, 'fixture-person', '换会话后的第一句', '换会话后的第一句', false, false, '9101', [], '789', []);
    const store = rotationStore(h);
    assert.equal(store.keys[KEY].sessionId, next);
    assert.equal(store.keys[KEY].messages, 1, '新会话的来信计数从 1 开始（不继承旧会话的累计）');
    assert.equal(store.keys[KEY].turns, 0);
    assert.equal(store.keys[KEY].rotations, 1);
  } finally { await h.close(); }
});

test('定时扫描（sweep）是自动路径的入口：条件满足时由它触发轮换', async () => {
  const { h, sessionId } = await fixture();
  const timeline = [];
  try {
    seedArchive(h);
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    installDiarySuccess(h, timeline);
    installArchiveProbe(h, timeline);
    await delay(30);
    const swept = await h.sweepSessionRotation();
    assert.equal(swept.checked, 1, '应当检查到 1 条仍有映射的会话');
    // 跨 VM realm 的数组原型不同，不要用 deepEqual。
    assert.equal(swept.rotated.length, 1);
    assert.equal(swept.rotated[0], KEY);
    assert.equal(h.state.sessions[KEY], undefined);
    assert.match(diaryText(h), /轮换前的记忆/);
  } finally { await h.close(); }
});

// ───────────────────────────────────────────────────────────────────────────
// 记忆优先（最重要的一组）
// ───────────────────────────────────────────────────────────────────────────

test('记忆写入失败 → 绝不换会话，并进入退避', async () => {
  const { h, sessionId } = await fixture({ rotation: { memoryFailureBackoffMs: 60_000 } });
  try {
    seedArchive(h);
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    await delay(30);
    // 让「他人日记整理会话」建不出来：这是最真实的记忆写入失败形态。
    h.api.sessions.create = async () => { throw new Error('fixture: 日记整理会话创建失败'); };

    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, false);
    assert.equal(r.skipped, 'memory-write-failed');
    assert.equal(r.memory.ok, false);
    assert.equal(r.memory.reason, 'session-create-failed');
    assert.equal(h.state.sessions[KEY], sessionId, '记忆没写成时会话映射必须原样保留');
    assert.deepEqual(h.calls.archived, [], '记忆没写成时绝不能归档（退役）任何会话');
    assert.equal(h.calls.prompts.length, 0, '失败发生在建会话阶段，不该再花一次模型调用');

    const store = rotationStore(h);
    assert.ok(store.keys[KEY].lastMemoryFailureAt > 0, '失败要落盘，重启后才知道该退避');
    assert.equal(store.keys[KEY].memoryFailureCount, 1);

    // 退避期内不再尝试（不重试到烧钱）。
    const second = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(second.rotated, false);
    assert.equal(second.skipped, 'memory-backoff');
    assert.equal(h.calls.prompts.length, 0);
  } finally { await h.close(); }
});

test('正常路径：先把记忆写进日记，等它写完，才退役旧会话', async () => {
  const { h, sessionId } = await fixture();
  const timeline = [];
  try {
    seedArchive(h);
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    installDiarySuccess(h, timeline);
    const sawDiaryAtArchive = installArchiveProbe(h, timeline);
    await delay(30);

    const r = await h.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, true, `应换会话，实际 ${r.skipped} ${r.reason || ''}`);
    assert.equal(r.ok, true);
    assert.equal(r.oldSessionId, sessionId);
    assert.equal(r.memory.ok, true);
    assert.equal(r.memory.written, 1, '本次应写入 1 条日记');
    assert.equal(r.memoryWritten, 1);

    // 记忆真的落到日记本里了（按 key 归属到 diary-others.jsonl）。
    assert.match(diaryText(h), /轮换前的记忆/, '旧会话退役前，日记里必须有这次整理的成果');

    // 退役后的停止/归档是异步发的（stopRetiredSessionWork 是 fire-and-forget），先等它落地。
    assert.ok(await waitFor(() => h.calls.archived.includes(sessionId)), '旧的 DSH 会话应被停止并归档');

    // 顺序：日记整理（模型调用）在前，归档（退役）在后。
    const promptIdx = timeline.findIndex((e) => e.what === 'diaryPrompt');
    const archiveIdx = timeline.findIndex((e) => e.what === 'archive');
    assert.ok(promptIdx >= 0, '必须先走日记整理通道');
    assert.ok(archiveIdx > promptIdx, `退役必须发生在记忆写入之后（prompt@${promptIdx} archive@${archiveIdx}）`);
    assert.equal(sawDiaryAtArchive(), true, '归档旧会话的那一刻，日记里必须已经有这条记忆');

    // 映射已撤销（下一条消息会建新会话）。
    assert.equal(h.state.sessions[KEY], undefined);
    assert.equal(h.state.sessionPolicies[KEY], undefined);

    // 记账：轮次归零、轮换次数 +1。
    const store = rotationStore(h);
    assert.equal(store.keys[KEY].turns, 0);
    assert.equal(store.keys[KEY].messages, 0);
    assert.equal(store.keys[KEY].rotations, 1);
    assert.ok(store.keys[KEY].lastRotatedAt > 0);
  } finally { await h.close(); }
});

test('控制台 POST /api/session/rotate：正常换会话返回 200，缺令牌 401', async () => {
  const { h, sessionId } = await fixture();
  const timeline = [];
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const post = (route, body, token = TOKEN) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        ...(token ? { 'x-console-token': token } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  try {
    seedArchive(h);
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(h, sessionId, turn);
    installDiarySuccess(h, timeline);
    installArchiveProbe(h, timeline);
    await delay(30);

    const denied = await post('/api/session/rotate', { key: KEY }, '');
    assert.equal(denied.status, 401, '轮换接口属于控制台管理面，必须鉴权');

    const ok = await post('/api/session/rotate', { key: KEY });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.rotated, true);
    assert.equal(ok.body.oldSessionId, sessionId);
    assert.equal(h.state.sessions[KEY], undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 重启恢复
// ───────────────────────────────────────────────────────────────────────────

test('重启后轮次计数恢复：新进程仍知道这个会话已经够长', async () => {
  const first = await fixture();
  let sessionsState;
  let rotationState;
  try {
    for (let turn = 1; turn <= 3; turn += 1) completeTurn(first.h, first.sessionId, turn);
    rotationState = rotationStore(first.h);
    assert.equal(rotationState.keys[KEY].turns, 3, '轮次必须落盘');
    sessionsState = JSON.parse(fs.readFileSync(path.join(first.h.temp, 'state/sessions.json'), 'utf8'));
    assert.equal(sessionsState.sessions[KEY], first.sessionId);
  } finally { await first.h.close(); }

  // 「新进程」：内存全丢，只带 state/ 下的两个文件。
  // mode.json 固定成 reserved2，否则启动期的 reconcileSessionPolicies（模式策略不匹配）
  // 会先把这条映射当成「权限变了」退役掉，这个用例就测不到轮换本身了。
  const restart = await bridgeHarness({
    config: configFor({}),
    savedState: sessionsState,
    files: {
      'state/mode.json': { mode: 'reserved2' },
      'state/session-rotation.json': rotationState
    }
  });
  restart.setMode('reserved2');
  const timeline = [];
  try {
    assert.equal(restart.state.sessions[KEY], sessionsState.sessions[KEY], '重启后旧会话映射应当还在');

    const status = restart.buildRotationStatus();
    assert.equal(status.keys[KEY].turns, 3, '重启后轮次计数必须是从磁盘恢复的 3');
    assert.equal(status.keys[KEY].messages, 0);
    assert.equal(status.keys[KEY].sessionId, sessionsState.sessions[KEY]);

    seedArchive(restart);
    installDiarySuccess(restart, timeline);
    installArchiveProbe(restart, timeline);
    await delay(30);
    const r = await restart.maybeRotateSession(KEY, { source: 'test' });
    assert.equal(r.rotated, true, `恢复后的计数应满足阈值（实际 ${r.skipped} ${r.reason || ''}）`);
    assert.equal(r.turns, 3, '轮换用的就是恢复出来的轮次');
    assert.equal(r.oldSessionId, sessionsState.sessions[KEY]);
    assert.equal(restart.state.sessions[KEY], undefined);
  } finally { await restart.close(); }
});

/** 等一个条件成立（异步归档发生在 retireSession 之后的微任务里）。 */
async function waitFor(check, { timeoutMs = 1000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > deadline) return false;
    await delay(stepMs);
  }
}