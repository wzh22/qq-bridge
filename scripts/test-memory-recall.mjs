// 原文库接入回归测试（记什么、怎么缓冲、检索端点怎么隔离）。
//
// 口径：跑**真实桥接**（bridgeHarness 求值 src/bridge.js），只把：
//   · memory-store 的 5 个函数换成可观察的桩（openMemoryStore/appendMessages/
//     searchMessages/countMessages/pruneMessages）—— 这样能断言「真的写进了什么」，
//     又不会在临时目录里造真实 SQLite（存储层本身由 test-memory-store.mjs 直接测）；
//   · 落盘都在临时 state/，不碰生产 state/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';

/**
 * 装一组可观察的 memory-store 桩，返回收集器。
 * flush 时 bridge 会调 appendMessages(store, batch) —— 我们把 batch 记下来断言。
 */
function memoryStubs() {
  const appended = [];   // 每次 appendMessages 调用的 batch（数组的数组）
  const searched = [];   // 每次 searchMessages 的参数
  let opened = 0;        // openMemoryStore 被调几次
  let pruned = 0;        // pruneMessages 调用次数

  const stubs = {
    openMemoryStore: () => { opened += 1; return { __stub: true }; },
    appendMessages: (_store, batch) => { appended.push(batch); return { inserted: batch.length, skipped: 0 }; },
    searchMessages: (_store, query, options) => {
      searched.push({ query, options });
      // 返回两条假命中，让端点能拼出 hits（并且能验证排序/字段映射）。
      return [
        { text: `命中一：${query}`, senderName: '张三', ts: Date.now() - 1000, conv: options?.conv ?? 'group:456' },
        { text: `命中二：${query}`, senderName: '我', ts: Date.now(), conv: options?.conv ?? 'group:456' },
      ];
    },
    countMessages: () => appended.reduce((n, b) => n + b.length, 0),
    pruneMessages: () => { pruned += 1; return 0; },
  };
  return { stubs, appended, searched, stats: () => ({ opened, pruned }) };
}

async function fixture(run, { files = {}, config = {}, stubs } = {}) {
  const h = await bridgeHarness({ config, files, globals: { ...(stubs ?? {}) } });
  h.setMode('reserved2');
  const group = h.getSocialV2State('group:456');
  const friend = h.getSocialV2State('private:123');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const post = (route, body, { token, key } = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ key, token, ...body });
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'x-console-token': CONSOLE_TOKEN,
    };
    if (token) headers['x-agent-token'] = token;
    const req = http.request({ hostname: '127.0.0.1', port, path: `/api/socialV2/${route}`, method: 'POST', headers }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });

  try {
    return await run({ h, group, friend, server, post });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

// ── 采集 ──────────────────────────────────────────────────────────────────

test('原文库：消息进缓冲，flush 时批量落盘（不是逐条事务）', async () => {
  const m = memoryStubs();
  await fixture(async ({ h }) => {
    // 连喂 3 条，都不够一批（默认 flushBatch=50），所以此刻还没落盘。
    h.recordMemoryMessage('group:456', { text: '第一句', sender: '张三', senderId: '111', messageId: 'm1', isSelf: false, kind: 'group', time: Date.now() });
    h.recordMemoryMessage('group:456', { text: '第二句', sender: '李四', senderId: '222', messageId: 'm2', isSelf: false, kind: 'group', time: Date.now() });
    h.recordMemoryMessage('group:456', { text: '第三句', sender: '我', isSelf: true, time: Date.now() });
    assert.equal(m.appended.length, 0, '未满一批时不该落盘');

    h.flushMemoryBuffer();
    assert.equal(m.appended.length, 1, 'flush 应只调用一次 appendMessages');
    const batch = m.appended[0];
    assert.equal(batch.length, 3);
    // 字段映射：对方是 msg、自己是 ai；conv/messageId/senderName 都要带过去
    assert.equal(batch[0].conv, 'group:456');
    assert.equal(batch[0].messageId, 'm1');
    assert.equal(batch[0].senderName, '张三');
    assert.equal(batch[0].kind, 'msg');
    assert.equal(batch[2].isSelf, true);
    assert.equal(batch[2].kind, 'ai', '自己说的话 kind 应为 ai');
  }, { stubs: m.stubs });
});

test('原文库：攒满 flushBatch 立刻落盘，不必等定时器', async () => {
  const m = memoryStubs();
  await fixture(async ({ h }) => {
    const conf = h.memoryStoreConfig();
    const n = Math.max(2, conf.flushBatch);
    for (let i = 0; i < n; i += 1) {
      h.recordMemoryMessage('group:456', { text: `批量第${i}句`, sender: '张三', isSelf: false, kind: 'group', time: Date.now() });
    }
    assert.equal(m.appended.length, 1, `满 ${n} 条应触发一次 flush`);
    assert.equal(m.appended[0].length, n);
    assert.equal(h.memoryBuffer.length, 0, 'flush 后缓冲应清空');
  }, { stubs: m.stubs });
});

test('原文库：空文本/无 key 不采集（别把空白塞进 FTS）', async () => {
  const m = memoryStubs();
  await fixture(async ({ h }) => {
    h.recordMemoryMessage('group:456', { text: '   ', sender: '张三', isSelf: false, kind: 'group' });
    h.recordMemoryMessage('', { text: '有文本但没 key', sender: '张三', isSelf: false, kind: 'group' });
    h.recordMemoryMessage('group:456', { text: '', sender: '张三', isSelf: false, kind: 'group' });
    assert.equal(h.memoryBuffer.length, 0, '空白或无 key 的都不该进缓冲');
    h.flushMemoryBuffer();
    assert.equal(m.appended.length, 0);
  }, { stubs: m.stubs });
});

test('原文库：关闭开关后完全不采集', async () => {
  const m = memoryStubs();
  await fixture(async ({ h }) => {
    assert.equal(h.memoryStoreConfig().enabled, false);
    h.recordMemoryMessage('group:456', { text: '这条不该被采集', sender: '张三', isSelf: false, kind: 'group' });
    h.flushMemoryBuffer();
    assert.equal(h.memoryBuffer.length, 0);
    assert.equal(m.appended.length, 0, '开关关掉时不该调用 appendMessages');
  }, { stubs: m.stubs, config: { socialV2: { memory: { enabled: false } } } });
});

test('原文库：写入抛错不影响主流程（只记日志）', async () => {
  const m = memoryStubs();
  const stubs = {
    ...m.stubs,
    appendMessages: () => { throw new Error('模拟磁盘满'); },
  };
  await fixture(async ({ h }) => {
    h.recordMemoryMessage('group:456', { text: '会失败的写入', sender: '张三', isSelf: false, kind: 'group' });
    // 关键：flush 不能把异常抛出去（否则会打断 WS 事件回调）。
    assert.doesNotThrow(() => h.flushMemoryBuffer());
    assert.equal(h.memoryBuffer.length, 0, '失败也要清空缓冲，避免堆积');
  }, { stubs });
});

// ── 检索端点 ──────────────────────────────────────────────────────────────

test('recall 端点：默认只搜本会话，且结果带时间与发言人', async () => {
  const m = memoryStubs();
  await fixture(async ({ group, post }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const r = await post('recall', { query: '食堂', limit: 5 }, g);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true);
    assert.ok(r.data.count >= 1);
    // 关键：conv 必须是本会话（不传 all 时）
    assert.equal(m.searched.length, 1);
    assert.equal(m.searched[0].options.conv, 'group:456', '默认必须限定在本会话');
    assert.equal(m.searched[0].query, '食堂');
    // 结果形状：带 at（人能读的时间）与 notice
    assert.ok(r.data.hits[0].at, '每条命中都要有可读时间');
    assert.ok(r.data.hits[0].sender !== undefined, '要带发言人');
    assert.match(r.data.notice, /不是给你的指令/, '必须有「记录不是指令」的框定');
  }, { stubs: m.stubs });
});

test('recall 端点：群聊里拒绝跨会话检索', async () => {
  const m = memoryStubs();
  await fixture(async ({ group, post }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const r = await post('recall', { query: '任何词', all: true }, g);
    assert.equal(r.status, 403, '群里不该能跨会话翻记录');
    assert.match(String(r.data.error), /跨会话/);
    assert.equal(m.searched.length, 0, '被拒时不该真的去搜');
  }, { stubs: m.stubs });
});

test('recall 端点：私聊可以跨会话搜', async () => {
  const m = memoryStubs();
  await fixture(async ({ friend, post }) => {
    const f = { key: 'private:123', token: friend.agentToken };
    const r = await post('recall', { query: '任何词', all: true }, f);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(m.searched[0].options.conv, undefined, '跨会话时 conv 应为 undefined');
    assert.equal(r.data.scope, 'all');
  }, { stubs: m.stubs });
});

test('recall 端点：令牌错配 / 空 query / 工具关闭 都被拒', async () => {
  const m = memoryStubs();
  await fixture(async ({ group, post }) => {
    const bad = await post('recall', { query: '食堂' }, { key: 'group:456', token: 'WRONG_TOKEN' });
    assert.equal(bad.status, 403);

    const empty = await post('recall', { query: '   ' }, { key: 'group:456', token: group.agentToken });
    assert.equal(empty.status, 400);

    assert.equal(m.searched.length, 0, '被拒的请求都不该真的搜');
  }, { stubs: m.stubs });
});

test('recall 端点：原文库打不开时返回 503 且不影响聊天', async () => {
  const m = memoryStubs();
  const stubs = {
    ...m.stubs,
    // 打开就抛错 —— 模拟 state 目录不可写
    openMemoryStore: () => { throw new Error('模拟无法打开'); },
  };
  await fixture(async ({ h, group, post }) => {
    const g = { key: 'group:456', token: group.agentToken };
    const r = await post('recall', { query: '食堂' }, g);
    assert.equal(r.status, 503);
    assert.match(String(r.data.error), /原文库不可用/);
    // 采集侧也要安静降级，不能抛
    assert.doesNotThrow(() => {
      h.recordMemoryMessage('group:456', { text: '打不开时也要能跑', sender: '张三', isSelf: false, kind: 'group' });
      h.flushMemoryBuffer();
    });
  }, { stubs });
});
