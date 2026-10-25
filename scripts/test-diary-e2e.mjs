// 日记本端到端测试：真的起一个桥接控制台 API，走 HTTP 验证读写与隐私闸门。
//
// 与 test-diary.mjs 的分工：
//   test-diary.mjs      —— 纯逻辑（不需要桥接进程，毫秒级）
//   本文件              —— 真实 HTTP + 真实文件，验证接线是否接对
//
// 为什么必须单独测接线：纯逻辑全绿但路由写错路径/漏鉴权/漏隐私闸门，
// 是这类功能最典型的"看起来做完了其实没接上"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';

import { appendEntry, loadDiary, buildDiaryContext, recallEntries } from '../src/diary.js';

const DAY = 86400000;

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-e2e-'));
  return path.join(dir, 'diary.jsonl');
}

// ── 直接验证模块边界的三个关键行为 ────────────────────────────────────────

test('E2E: 写入 → 重启（重新加载）→ 内容还在', () => {
  const file = tmpFile();
  appendEntry(file, { body: '今天陪主人复习到很晚', mood: 'tired', importance: 4, quote: '早点睡吧 别熬了' });
  // 模拟进程重启：完全重新读盘
  const { entries } = loadDiary(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mood, 'tired');
  assert.equal(entries[0].quote, '早点睡吧 别熬了', '风格锚点的原话必须持久化');
});

test('E2E: 跨「会话」保持风格 —— 新会话能拿到旧原话', () => {
  const file = tmpFile();
  appendEntry(file, { body: '聊了联考', quote: '行吧 那就这么定', mood: 'calm', importance: 4, time: Date.now() - 30 * DAY });
  const { entries } = loadDiary(file);
  // 新会话第一次对话：query 与旧日记无关，但风格锚点仍应命中
  const block = buildDiaryContext(entries, { query: '今天天气怎么样', now: Date.now() });
  assert.ok(block.includes('【说话风格参考】'), '新会话必须拿到风格锚点');
  assert.ok(block.includes('行吧 那就这么定'));
});

test('E2E: 想起更久远的事 —— 半年前的事能被关键词捞出来', () => {
  const file = tmpFile();
  appendEntry(file, { body: '那次聊到凌晨三点，说起了公安联考的报名', time: Date.now() - 180 * DAY, importance: 3 });
  appendEntry(file, { body: '今天吃了顿好的', time: Date.now() - 1 * DAY, importance: 2 });
  const { entries } = loadDiary(file);
  const hits = recallEntries(entries, { q: '联考报名', limit: 5 });
  assert.equal(hits.length, 1, '半年前的事必须能被捞到');
  assert.match(hits[0].entry.body, /凌晨三点/);
});

test('E2E: 注入体积有界 —— 日记再多也不会撑爆 prompt', () => {
  const file = tmpFile();
  for (let i = 0; i < 300; i += 1) {
    appendEntry(file, {
      body: `第 ${i} 天的日记，聊了很多事情，内容会比较长一点点来模拟真实情况。`,
      time: Date.now() - i * 1000,
      importance: 3,
      quote: i % 3 === 0 ? `原话 ${i}` : '',
    });
  }
  const { entries } = loadDiary(file);
  assert.equal(entries.length, 300);
  const block = buildDiaryContext(entries, { query: '聊天', now: Date.now() });
  assert.ok(block.length < 4000, `注入内容必须受限，实际 ${block.length} 字符`);
  // 但也不能空：近期/相关/风格三段至少要有内容
  assert.ok(block.length > 200);
});

// ── 真实 HTTP 接线验证（用一个最小复刻的路由，验证契约形状） ───────────────

/**
 * 这里刻意**不复刻整个 bridge.js**（它有 1.3 万行，起不来也跑不动）。
 * 而是把 /api/socialV2/diary 的路由逻辑按 bridge.js 的写法复刻一份最小实现，
 * 验证「请求形状 → 响应形状」这个契约。
 *
 * 局限要说清楚：它不能证明 bridge.js 里那段代码写对了（那需要真跑桥接），
 * 但能证明**这套契约本身自洽**，且能在改动路由时快速发现形状漂移。
 */
function startFakeDiaryServer(file, { ownerQQ = '2409281798' } = {}) {
  const isOwnerPrivate = (key) => new RegExp(`^private:${ownerQQ}$`).test(String(key));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname !== '/api/socialV2/diary') { send({ ok: false, error: 'not found' }, 404); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
    const key = String(req.method === 'POST' ? (body.key ?? '') : (url.searchParams.get('key') ?? '')).trim();
    if (!key) { send({ ok: false, error: 'key 不能为空' }, 400); return; }
    if (!isOwnerPrivate(key)) { send({ ok: false, error: '日记本只能在主人本人的私聊中读写' }, 403); return; }
    if (req.method === 'POST') {
      const r = appendEntry(file, { ...body, key });
      if (!r.ok) { send({ ok: false, error: r.error }, 400); return; }
      send({ ok: true, entry: { id: r.entry.id, title: r.entry.title } });
      return;
    }
    const { entries } = loadDiary(file);
    const q = String(url.searchParams.get('q') ?? '').trim();
    if (!q) { send({ ok: true, total: entries.length, entries: entries.slice(-20) }); return; }
    const hits = recallEntries(entries, { q, limit: 20 });
    send({ ok: true, total: entries.length, matched: hits.length, entries: hits.map((h) => h.entry) });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

test('E2E HTTP: 主人私聊可写可读', async () => {
  const file = tmpFile();
  const { server, port } = await startFakeDiaryServer(file);
  try {
    const w = await request(port, '/api/socialV2/diary', {
      method: 'POST',
      body: { key: 'private:2409281798', body: '写了一条测试日记', mood: 'happy', importance: 3 },
    });
    assert.equal(w.status, 200);
    assert.equal(w.body.ok, true);

    const r = await request(port, `/api/socialV2/diary?key=private:2409281798&q=${encodeURIComponent('测试')}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.matched, 1);
  } finally {
    server.close();
  }
});

test('E2E HTTP: 群聊被拒绝（隐私闸门）', async () => {
  const file = tmpFile();
  const { server, port } = await startFakeDiaryServer(file);
  try {
    const w = await request(port, '/api/socialV2/diary', {
      method: 'POST',
      body: { key: 'group:123456', body: '想往群里写日记' },
    });
    assert.equal(w.status, 403, '群聊写入必须被拒');
    assert.match(w.body.error, /私聊/);

    const r = await request(port, '/api/socialV2/diary?key=group:123456');
    assert.equal(r.status, 403, '群聊读取必须被拒');

    // 最关键：被拒之后库里不能留下任何痕迹
    const { entries } = loadDiary(file);
    assert.equal(entries.length, 0, '被拒的写入不能落盘');
  } finally {
    server.close();
  }
});

test('E2E HTTP: 别人的私聊也被拒绝', async () => {
  const file = tmpFile();
  const { server, port } = await startFakeDiaryServer(file);
  try {
    const r = await request(port, '/api/socialV2/diary?key=private:99999999');
    assert.equal(r.status, 403, '非主人的私聊不能读');
  } finally {
    server.close();
  }
});
