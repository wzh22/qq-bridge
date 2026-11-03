/**
 * memory-store.js 的回归测试。
 *
 * 跑法：node --test scripts/test-memory-store.mjs
 * 数据库落在 %TEMP%（mkdtemp），测试结束整个目录删掉。
 *
 * 重点覆盖中文检索那几个坑：FTS5 trigram 最小匹配长度 3、多词 AND 在应用层、
 * 交集为空才降级并集、会话隔离、prune 时必须同步删 msg_fts。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openMemoryStore,
  appendMessage,
  appendMessages,
  searchMessages,
  countMessages,
  pruneMessages,
  closeMemoryStore,
} from '../src/memory-store.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-store-'));

/** 所有开过的库都登记在此：某个用例断言失败提前中断时，after 也要把句柄收掉，
 *  否则 Windows 上 -wal/-shm 还占着文件，删临时目录会 EPERM。 */
const openStores = new Set();
function track(store) {
  openStores.add(store);
  return store;
}

after(() => {
  for (const store of openStores) {
    try { closeMemoryStore(store); } catch { /* 已关闭 */ }
  }
  openStores.clear();
  rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let seq = 0;
/** 每个用例一个独立库文件，互不污染。 */
function newStore(tag) {
  seq += 1;
  return track(openMemoryStore(path.join(TMP_ROOT, `${tag}-${seq}.sqlite`)));
}

const DAY = 86400 * 1000;
const NOW = Date.parse('2026-11-03T12:00:00+08:00');

function add(store, conv, text, extra = {}) {
  return appendMessage(store, {
    conv,
    messageId: extra.messageId ?? `m-${extra.seq ?? Math.random().toString(36).slice(2)}`,
    senderId: extra.senderId ?? '10001',
    senderName: extra.senderName ?? '阿明',
    isSelf: extra.isSelf ?? false,
    ts: extra.ts ?? NOW,
    kind: extra.kind ?? 'msg',
    source: extra.source ?? 'ws',
    ...extra,
    text,
  });
}

test('建库：文件落在 %TEMP%，重复 open 返回同一实例，WAL 已开', () => {
  const file = path.join(TMP_ROOT, 'open.sqlite');

  const a = track(openMemoryStore(file));
  const b = openMemoryStore(file);

  assert.equal(a, b, '幂等打开应返回同一 store 实例');
  assert.equal(a.path, file);
  assert.ok(existsSync(file), '库文件应已创建');

  const journal = a.db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(journal.journal_mode).toLowerCase(), 'wal', '必须启用 WAL');

  const cols = a.db.prepare('PRAGMA table_info(msg)').all().map((r) => r.name);
  for (const name of ['id', 'conv', 'message_id', 'sender_id', 'sender_name',
    'is_self', 'ts', 'kind', 'text', 'source']) {
    assert.ok(cols.includes(name), `msg 表缺少列 ${name}`);
  }

  assert.equal(countMessages(a), 0);

  // 关闭后可以重新打开（registry 里的死实例不能返回）
  assert.equal(closeMemoryStore(a), true);
  assert.equal(closeMemoryStore(a), false, 'close 应幂等');
  const c = track(openMemoryStore(file));
  assert.notEqual(c, a, '关闭后重新 open 应是新实例');
  assert.equal(countMessages(c), 0);
  closeMemoryStore(c);
});

test('appendMessage 幂等：同 (conv, message_id) 不重复插入', () => {
  const store = newStore('idem');

  const first = add(store, 'group:111', '第一条群消息', { messageId: '1001' });
  const again = add(store, 'group:111', '第一条群消息（重放）', { messageId: '1001' });

  assert.equal(first, true, '首次写入应返回 true');
  assert.equal(again, false, '重复 message_id 应返回 false');
  assert.equal(countMessages(store), 1, '重复写入不应增加行数');

  // 同文本、不同 message_id → 是两条不同的消息
  assert.equal(add(store, 'group:111', '第一条群消息', { messageId: '1002' }), true);
  assert.equal(countMessages(store), 2);

  // 空文本不落库
  assert.equal(add(store, 'group:111', '   ', { messageId: '1003' }), false);
  assert.equal(countMessages(store), 2);

  closeMemoryStore(store);
});

test('message_id 缺失：稳定键保证重放不重复', () => {
  const store = newStore('nomsgid');
  const base = { conv: 'group:222', senderId: '1234567890', senderName: '小周', ts: NOW, text: '没有消息号的一句话' };

  assert.equal(appendMessage(store, base), true);
  assert.equal(appendMessage(store, { ...base, source: 'backfill' }), false, '同内容重放应被稳定键挡住');
  assert.equal(countMessages(store), 1);

  // 文本不同 → 哈希不同 → 应该插入
  assert.equal(appendMessage(store, { ...base, text: '没有消息号的另一句话' }), true);
  assert.equal(countMessages(store), 2);

  // 缺失 message_id 也必须落成稳定键，不能是 NULL
  const row = store.db.prepare('SELECT message_id FROM msg ORDER BY id LIMIT 1').get();
  assert.match(String(row.message_id), /^h\d+_\d{4,}_[0-9a-f]{12}$/);

  closeMemoryStore(store);
});

test('中文 3 字以上：走 FTS5 能搜到', (t) => {
  const store = newStore('fts3');
  add(store, 'group:333', '这个测试用例很关键', { messageId: 'a1' });
  add(store, 'group:333', '晚上一起打副本', { messageId: 'a2' });

  const four = searchMessages(store, '测试用例');
  assert.equal(four.length, 1, '4 字词应命中 1 条');
  assert.equal(four[0].text, '这个测试用例很关键');
  assert.equal(four[0].senderName, '阿明');
  assert.equal(four[0].conv, 'group:333');
  assert.equal(typeof four[0].ts, 'number');

  const three = searchMessages(store, '测试用');
  assert.equal(three.length, 1, '3 字词是 trigram 的最小匹配长度，应命中');

  assert.equal(searchMessages(store, '找不到的词组').length, 0);

  t.diagnostic('以上命中均来自 FTS5 MATCH（词长 >= 3）');
  closeMemoryStore(store);
});

test('中文 2 字：必须能搜到（trigram 静默 0 命中的坑）', (t) => {
  const store = newStore('fts2');
  add(store, 'group:444', '你好测试一下', { messageId: 'b1' });
  add(store, 'group:444', '上海天气怎么样', { messageId: 'b2' });
  add(store, 'group:444', '今天中午吃什么', { messageId: 'b3' });

  for (const word of ['测试', '上海', '天气', '中午']) {
    const hits = searchMessages(store, word);
    assert.equal(hits.length, 1, `2 字词「${word}」应命中 1 条（不能静默 0）`);
  }
  assert.equal(searchMessages(store, '测试')[0].text, '你好测试一下');
  assert.equal(searchMessages(store, '上海')[0].text, '上海天气怎么样');

  // 记录一下上游行为：如果这条不再是 0，说明 SQLite trigram 的最小长度变了
  const raw = store.db
    .prepare('SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?')
    .all('"测试"');
  t.diagnostic(`FTS5 MATCH '"测试"' 原始命中 = ${raw.length} 条（0 即证实坑存在，靠 LIKE 兜底）`);

  closeMemoryStore(store);
});

test('多词 AND：每个词各自查、id 取交集（两字词混搭也能命中）', () => {
  const store = newStore('and');
  add(store, 'group:555', '上海天气怎么样', { messageId: 'c1' });
  add(store, 'group:555', '上海话学习笔记', { messageId: 'c2' });
  add(store, 'group:555', '北京天气不错', { messageId: 'c3' });

  const both = searchMessages(store, '上海 天气');
  assert.equal(both.length, 1, '两个 2 字词应 AND 命中唯一一条');
  assert.equal(both[0].text, '上海天气怎么样');

  // 写死成 MATCH '"上海 天气"' 的实现会在这里 0 命中
  const naive = store.db
    .prepare('SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?')
    .all('"上海 天气"');
  assert.equal(naive.length, 0, '整串 AND 塞进 MATCH 会静默 0 命中，所以必须应用层做');

  // 3 字以上词的 AND
  add(store, 'group:555', '人工智能技术分享', { messageId: 'c4' });
  add(store, 'group:555', '人工智能伦理讨论', { messageId: 'c5' });
  const ftsAnd = searchMessages(store, '人工智能 技术');
  assert.equal(ftsAnd.length, 1);
  assert.equal(ftsAnd[0].text, '人工智能技术分享');

  closeMemoryStore(store);
});

test('交集为空才降级并集（阈值是 0，不是「少于 N」）', () => {
  const store = newStore('union');
  add(store, 'group:666', '上海的雨天', { messageId: 'd1' });
  add(store, 'group:666', '期末考试安排', { messageId: 'd2' });
  add(store, 'group:666', '无关的一条消息', { messageId: 'd3' });

  const ids = searchMessages(store, '上海 考试');
  const texts = ids.map((r) => r.text).sort();
  assert.deepEqual(texts, ['上海的雨天', '期末考试安排'], '交集为空应降级并集，两条都回来');

  // 交集非空时不能被并集污染
  const strict = searchMessages(store, '上海 雨天');
  assert.equal(strict.length, 1);
  assert.equal(strict[0].text, '上海的雨天');

  closeMemoryStore(store);
});

test('会话隔离：group:A 搜不到 group:B 的原文', () => {
  const store = newStore('iso');
  add(store, 'group:A', '甲群专属暗号', { messageId: 'e1' });
  add(store, 'group:B', '乙群专属暗号', { messageId: 'e2' });
  add(store, 'private:10001', '私聊里的专属暗号', { messageId: 'e3' });

  const onlyA = searchMessages(store, '专属暗号', { conv: 'group:A' });
  assert.equal(onlyA.length, 1, '会话过滤生效，只应看到 group:A');
  assert.equal(onlyA[0].text, '甲群专属暗号');
  assert.equal(onlyA[0].conv, 'group:A');

  const onlyB = searchMessages(store, '专属暗号', { conv: 'group:B' });
  assert.equal(onlyB.length, 1);
  assert.equal(onlyB[0].text, '乙群专属暗号');

  const all = searchMessages(store, '专属暗号');
  assert.equal(all.length, 3, '不给 conv 时应跨会话召回');

  // 2 字词也要受 conv 约束（走 LIKE 路径）
  add(store, 'group:A', '上海话', { messageId: 'e4' });
  add(store, 'group:B', '上海菜', { messageId: 'e5' });
  assert.equal(searchMessages(store, '上海', { conv: 'group:A' }).length, 1);
  assert.equal(searchMessages(store, '上海', { conv: 'group:B' }).length, 1);
  assert.equal(searchMessages(store, '上海').length, 2);

  closeMemoryStore(store);
});

test('pruneMessages：按保留期删对条数', () => {
  const store = newStore('prune');
  const conv = 'group:777';

  // 3 条 10 天前，2 条 1 天前，1 条现在
  add(store, conv, '十天前的旧消息一', { messageId: 'p1', ts: NOW - 10 * DAY });
  add(store, conv, '十天前的旧消息二', { messageId: 'p2', ts: NOW - 10 * DAY });
  add(store, conv, '十天前的旧消息三', { messageId: 'p3', ts: NOW - 10 * DAY });
  add(store, conv, '昨天的消息甲', { messageId: 'p4', ts: NOW - 1 * DAY });
  add(store, conv, '昨天的消息乙', { messageId: 'p6', ts: NOW - 1 * DAY });
  add(store, conv, '今天的消息', { messageId: 'p5', ts: NOW });
  assert.equal(countMessages(store), 6);

  const deleted = pruneMessages(store, { keepDays: 7 });
  assert.equal(deleted, 3, '应只删掉 3 条超过 7 天的');
  assert.equal(countMessages(store), 3);
  assert.equal(countMessages(store, conv), 3);

  // 再来一次没有可删的 → 0
  assert.equal(pruneMessages(store, { keepDays: 7 }), 0);

  // keepDays=0 清空
  assert.equal(pruneMessages(store, { keepDays: 0 }), 3);
  assert.equal(countMessages(store), 0);

  // 非法参数
  assert.throws(() => pruneMessages(store, { keepDays: -1 }), /keepDays/);
  assert.throws(() => pruneMessages(store, { keepDays: 'x' }), /keepDays/);

  closeMemoryStore(store);
});

test('删除同步：prune 后 msg_fts 不留孤儿（否则「搜得到、点开空」）', () => {
  const store = newStore('fts-sync');
  const conv = 'group:888';

  add(store, conv, '这是一条会被清理的旧消息', { messageId: 'q1', ts: NOW - 30 * DAY });
  add(store, conv, '十天前的另一条旧消息', { messageId: 'q2', ts: NOW - 10 * DAY });
  add(store, conv, '这条消息要留下', { messageId: 'q3', ts: NOW });

  assert.equal(searchMessages(store, '会被清理').length, 1, '删之前应能搜到');
  assert.equal(searchMessages(store, '另一条旧').length, 1);

  const deleted = pruneMessages(store, { keepDays: 7 });
  assert.equal(deleted, 2);
  assert.equal(countMessages(store), 1);

  // 核心断言：主表与 FTS 索引行数必须一致
  const msgRows = Number(store.db.prepare('SELECT count(*) AS c FROM msg').get().c);
  const ftsRows = Number(store.db.prepare('SELECT count(*) AS c FROM msg_fts').get().c);
  assert.equal(ftsRows, msgRows, `msg_fts 有孤儿：fts=${ftsRows} msg=${msgRows}`);

  // 被删掉的原文必须搜不到
  assert.equal(searchMessages(store, '会被清理').length, 0, '已删原文不应还能搜到');
  assert.equal(searchMessages(store, '另一条旧').length, 0);
  assert.equal(searchMessages(store, '清理').length, 0, '2 字词也不能命中已删原文');

  // 留下的仍可检索
  assert.equal(searchMessages(store, '留下').length, 1);

  // 按会话清理同样要同步
  add(store, 'group:999', '另一个群的旧消息', { messageId: 'q4', ts: NOW - 20 * DAY });
  assert.equal(pruneMessages(store, { keepDays: 7, conv: 'group:999' }), 1);
  const msgRows2 = Number(store.db.prepare('SELECT count(*) AS c FROM msg').get().c);
  const ftsRows2 = Number(store.db.prepare('SELECT count(*) AS c FROM msg_fts').get().c);
  assert.equal(ftsRows2, msgRows2);
  assert.equal(countMessages(store), 1, '按会话清理不应动别的会话');

  closeMemoryStore(store);
});

test('只索引真对话：tool / think / system 不入检索', () => {
  const store = newStore('kind');
  const conv = 'group:aaa';

  add(store, conv, '正常聊天里提到的服务器部署', { messageId: 'k1' });
  add(store, conv, '工具返回的服务器部署日志', { messageId: 'k2', kind: 'tool' });
  add(store, conv, '思考链路里的服务器部署猜测', { messageId: 'k3', kind: 'think' });
  add(store, conv, '系统注入的服务器部署提示', { messageId: 'k4', kind: 'system' });

  assert.equal(countMessages(store), 4, '非对话 kind 照样入库留档');

  const hits = searchMessages(store, '服务器部署');
  assert.equal(hits.length, 1, '只应命中 kind=msg 的那条');
  assert.equal(hits[0].text, '正常聊天里提到的服务器部署');

  const ftsRows = Number(store.db.prepare('SELECT count(*) AS c FROM msg_fts').get().c);
  assert.equal(ftsRows, 1, '非对话 kind 不该进 FTS 索引');

  closeMemoryStore(store);
});

test('批量写入 appendMessages：单事务、统计准确', () => {
  const store = newStore('batch');
  const conv = 'group:bbb';
  const mk = (i, text) => ({
    conv,
    messageId: `batch-${i}`,
    senderId: '20002',
    senderName: '小李',
    ts: NOW + i,
    text,
  });

  const first = appendMessages(store, [mk(1, '批量第一条'), mk(2, '批量第二条'), mk(3, '批量第三条')]);
  assert.deepEqual(first, { inserted: 3, skipped: 0 });
  assert.equal(countMessages(store), 3);

  // 混一条重复 + 一条空文本
  const second = appendMessages(store, [mk(2, '批量第二条'), mk(4, ''), mk(5, '批量第四条')]);
  assert.deepEqual(second, { inserted: 1, skipped: 2 });
  assert.equal(countMessages(store), 4);

  closeMemoryStore(store);
});

test('切词与长句：整句检索仍能命中，停用词不误伤', () => {
  const store = newStore('terms');
  add(store, 'group:ccc', '我今天中午到底应该吃什么呢', { messageId: 't1' });
  add(store, 'group:ccc', '那个什么来着', { messageId: 't2' });

  // 长句 → 前 4 字 + 后 4 字 + 中段滑窗，全部 AND
  assert.equal(searchMessages(store, '我今天中午到底应该吃什么呢').length, 1);
  assert.equal(searchMessages(store, '中午到底应该吃').length, 1);

  // 纯停用词查询不炸、不返回垃圾
  assert.deepEqual(searchMessages(store, '什么'), []);
  assert.deepEqual(searchMessages(store, ''), []);
  assert.deepEqual(searchMessages(store, '   '), []);

  // 单字被丢成空词 → 空结果，但绝不抛错
  assert.deepEqual(searchMessages(store, '啊'), []);

  closeMemoryStore(store);
});

test('结果排序与 limit', () => {
  const store = newStore('order');
  const conv = 'group:ddd';
  for (let i = 0; i < 5; i += 1) {
    add(store, conv, `排序测试第${i}条`, { messageId: `o${i}`, ts: NOW + i * 1000 });
  }

  const hits = searchMessages(store, '排序测试');
  assert.equal(hits.length, 5);
  const tsList = hits.map((r) => r.ts);
  assert.deepEqual(tsList, [...tsList].sort((a, b) => b - a), '应按 ts 倒序');

  assert.equal(searchMessages(store, '排序测试', { limit: 2 }).length, 2);

  closeMemoryStore(store);
});

test('路径规则：相对路径按仓库根解析，非字符串参数报错', () => {
  const rel = 'state/tmp/test-memory-store-path/probe.sqlite';
  const absPath = path.join(REPO_ROOT, 'state', 'tmp', 'test-memory-store-path', 'probe.sqlite');
  let store;
  try {
    store = track(openMemoryStore(rel));
    assert.equal(store.path, absPath, '相对路径必须落在仓库根下并解析成绝对路径');
    assert.ok(path.isAbsolute(store.path));
    assert.equal(path.extname(store.path), '.sqlite');
  } finally {
    if (store) closeMemoryStore(store);
    rmSync(path.dirname(absPath), { recursive: true, force: true });
  }

  assert.throws(() => openMemoryStore(''), /非空字符串/);
  assert.throws(() => openMemoryStore(null), /非空字符串/);

  // 已关闭的库上继续用必须给出明确错误
  const dead = track(openMemoryStore(path.join(TMP_ROOT, 'dead.sqlite')));
  closeMemoryStore(dead);
  assert.throws(() => countMessages(dead), /已关闭/);
});

test('WAL 产物：库文件旁的 -wal / -shm 随 close 收敛', () => {
  const file = path.join(TMP_ROOT, 'wal.sqlite');
  const store = track(openMemoryStore(file));
  add(store, 'group:eee', 'WAL 测试消息', { messageId: 'w1' });
  const during = readdirSync(TMP_ROOT).filter((f) => f.startsWith('wal.sqlite'));
  assert.ok(during.includes('wal.sqlite-wal'), 'WAL 模式下应出现 -wal 文件');

  closeMemoryStore(store);
  const afterClose = readdirSync(TMP_ROOT).filter((f) => f.startsWith('wal.sqlite'));
  assert.ok(!afterClose.includes('wal.sqlite-wal'), 'close 后 -wal 应被 checkpoint 回收');
  assert.ok(afterClose.includes('wal.sqlite'));
});