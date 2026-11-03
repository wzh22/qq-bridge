/**
 * memory-store.js —— QQ 原文库（群聊 / 私聊消息原文的持久化 + 中文全文检索）
 *
 * 为什么需要它：`diary.js` 存的是「模型写下的日记摘要」，`bridge.js` 的
 * `recentLimit=100` 滑窗一过，群里说过的原话就永久消失。归档只覆盖私聊，
 * 群聊没有结构化原文留存 —— 这是记忆体系里唯一的结构性缺失。
 *
 * 本模块**只做存储层**，不接入 bridge / MCP。接入（采集点 + 检索工具）由 lead 做。
 *
 * 设计要点（都是踩过的坑，改动前请先读）：
 *
 * 1. FTS5 `tokenize='trigram'` 的最小匹配长度是 3。两字词（「测试」「上海」）
 *    塞进 MATCH **不报错、静默返回 0 条** —— 这是最阴的一个坑。所以 ≥3 字走
 *    FTS5 MATCH，2 字退回 `LIKE '%词%'`。
 * 2. MATCH 的左侧**不能用表别名**（`f MATCH ?` 会报 `no such column: f`），
 *    只能用 `msg_fts MATCH ?` 的子查询形式。
 * 3. 多词 AND 必须在应用层做。写成 `MATCH '词1 词2'` 时，只要其中一个词是
 *    2 字，整条 AND 就 0 命中且不报错。正确做法是每个词各自查（各自放宽到
 *    30 条）拿 id 集合再取交集。
 * 4. 交集为空才降级并集，阈值是 0（不是「少于 N」）—— 只命中 1 条往往才是对的。
 * 5. `conv` 是 UNINDEXED，只做会话过滤，不参与分词。
 * 6. 删除 `msg` **不会**级联删除 `msg_fts`（FTS5 不是 external content 表），
 *    必须显式同步删，否则会出现「搜得到、点开却是空的」幽灵结果。
 *
 * 依赖：仅 `node:sqlite` / `node:fs` / `node:path` / `node:crypto`，零 npm 依赖。
 * Node 版本：`node:sqlite` 自 Node 22.5 起内置（本机实测 v24.21.0 / SQLite 3.53.4，
 * 无需 `--experimental-sqlite`）。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 仓库根（本文件在 <repo>/src/ 下）。相对路径一律以它为基准解析。 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const DAY_MS = 86400 * 1000;

/** FTS5 trigram 的最小匹配长度：低于它 MATCH 会静默返回 0 条。 */
const FTS_MIN_CHARS = 3;
/** 单个词最多取多少条候选（AND/并集都在应用层做，放宽召回）。 */
const PER_TERM_LIMIT = 30;
/** 默认返回条数 / 上限。 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/** 一条查询最多拆出几个检索词。 */
const MAX_TERMS = 4;
/** 长句取中段 3 字滑窗的窗口宽度。 */
const MID_WINDOW = 3;

/**
 * 只检索真对话。这些 kind 的原文照样入库（留档、可审计），但不进 FTS、
 * 也不出现在检索结果里 —— tool 结果动辄几 KB，塞进 trigram 索引纯属浪费。
 */
const EXCLUDED_KINDS = Object.freeze(['tool', 'tool-result', 'think', 'system']);
const EXCLUDED_KINDS_SQL = EXCLUDED_KINDS.map((k) => `'${k}'`).join(', ');

/** 中文停用词：切词后整段与之相等就丢弃（只丢整段，不丢子串）。 */
const STOPWORDS = new Set([
  '好的', '那个', '什么', '怎么', '就是', '然后', '这个', '我们', '你们', '他们',
  '一下', '真的', '可以', '不是', '没有', '知道', '现在', '还是', '因为', '所以',
  '但是', '如果', '已经', '比较', '应该', '觉得', '时候', '一个', '这样', '那么',
]);

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS msg (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conv TEXT NOT NULL,
  message_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  kind TEXT,
  text TEXT NOT NULL,
  source TEXT,
  UNIQUE(conv, message_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_conv_ts ON msg(conv, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(text, conv UNINDEXED, tokenize='trigram');
`;

const REQUIRED_COLUMNS = [
  'id', 'conv', 'message_id', 'sender_id', 'sender_name',
  'is_self', 'ts', 'kind', 'text', 'source',
];

/** 已打开的库，按绝对路径去重 —— openMemoryStore 因此是幂等的。 */
const registry = new Map();

/** 每个库最多缓存多少条预编译语句（动态占位符 SQL 会按 id 数量分叉）。 */
const STMT_CACHE_MAX = 32;

// ── 内部工具 ────────────────────────────────────────────────────────────────

function fail(message) {
  throw new Error(`[memory-store] ${message}`);
}

/** 绝对路径原样返回；相对路径按仓库根解析。仅 `:memory:` 特判。 */
function resolveDbPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    fail('openMemoryStore(filePath) 需要非空字符串路径');
  }
  if (filePath === ':memory:') return ':memory:';
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(REPO_ROOT, filePath);
}

function requireStore(store) {
  if (!store || typeof store !== 'object' || !store.db) {
    fail('需要 openMemoryStore() 返回的 store 对象');
  }
  if (store.closed) fail(`库已关闭：${store.path}`);
  return store;
}

/** 预编译语句缓存（同一 SQL 只 prepare 一次）。 */
function stmt(store, sql) {
  let cached = store.stmts.get(sql);
  if (cached) return cached;
  cached = store.db.prepare(sql);
  if (store.stmts.size >= STMT_CACHE_MAX) store.stmts.clear();
  store.stmts.set(sql, cached);
  return cached;
}

/**
 * 显式事务。本身已经处在事务里（批量插入）时直接执行，不再嵌套
 * —— `BEGIN` 套 `BEGIN` 会报 "cannot start a transaction within a transaction"。
 */
function withTransaction(store, fn) {
  if (store.txDepth > 0) return fn();
  store.db.exec('BEGIN IMMEDIATE');
  store.txDepth += 1;
  try {
    const out = fn();
    store.db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      /* COMMIT 已失败 / 事务已被 SQLite 回滚，忽略 */
    }
    throw err;
  } finally {
    store.txDepth -= 1;
  }
}

function charCount(s) {
  return [...s].length;
}

/** 转义 LIKE 通配符，配合 `ESCAPE '\'` 使用，避免用户输入 `%` `_` 变通配。 */
function escapeLike(word) {
  return word.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** FTS5 短语查询：整词包成双引号，内部 `"` 双写转义。 */
function toFtsPhrase(word) {
  return `"${word.replace(/"/g, '""')}"`;
}

/** `message_id` 缺失时的稳定键：重放同一条消息不会重复入库。 */
function fallbackMessageId(row) {
  const tail = String(row.senderId ?? '').slice(-4) || 'anon';
  const digest = createHash('sha256').update(row.text).digest('hex').slice(0, 12);
  return `h${row.ts}_${tail}_${digest}`;
}

/** 秒级时间戳兜底转毫秒（1e11 ms ≈ 1973 年，真实毫秒值不可能更小）。 */
function normalizeTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  const v = Math.floor(n);
  return v < 1e11 ? v * 1000 : v;
}

/**
 * 把调用方传的消息规范成一行。返回 null 表示「没什么可存的」（空文本）。
 */
function normalizeMessage(msg) {
  const conv = String(msg?.conv ?? '').trim();
  if (!conv) fail('appendMessage 需要 conv，例如 "group:123456" / "private:10001"');

  const rawText = msg?.text == null ? '' : String(msg.text);
  if (!rawText.trim()) return null; // 纯空白不入库，也免得污染 FTS

  const ts = normalizeTs(msg?.ts);
  const senderId = msg?.senderId == null ? null : String(msg.senderId);
  const row = {
    conv,
    messageId: msg?.messageId == null || String(msg.messageId).trim() === ''
      ? null
      : String(msg.messageId).trim(),
    senderId,
    senderName: msg?.senderName == null ? null : String(msg.senderName),
    isSelf: msg?.isSelf ? 1 : 0,
    ts,
    kind: msg?.kind == null || String(msg.kind).trim() === '' ? 'msg' : String(msg.kind).trim(),
    text: rawText,
    source: msg?.source == null ? null : String(msg.source),
  };
  row.messageId = row.messageId ?? fallbackMessageId(row);
  return row;
}

function isIndexableKind(kind) {
  return !EXCLUDED_KINDS.includes(String(kind ?? 'msg'));
}

/**
 * 写入一行（两条语句，调用方负责事务）。返回是否真的插入。
 * `INSERT OR IGNORE` 撞 UNIQUE(conv, message_id) 时 changes=0。
 */
function insertOne(store, row) {
  const res = stmt(
    store,
    `INSERT OR IGNORE INTO msg
       (conv, message_id, sender_id, sender_name, is_self, ts, kind, text, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.conv, row.messageId, row.senderId, row.senderName,
    row.isSelf, row.ts, row.kind, row.text, row.source,
  );
  if (!res || Number(res.changes) === 0) return false;

  // msg_fts 是独立存储（非 external content），rowid 必须手工对齐 msg.id。
  if (isIndexableKind(row.kind)) {
    stmt(store, 'INSERT INTO msg_fts(rowid, text, conv) VALUES (?, ?, ?)')
      .run(Number(res.lastInsertRowid), row.text, row.conv);
  }
  return true;
}

/**
 * 中文切词（内部函数）：按标点/空白切段 → 丢掉 2 字以下碎片和停用词 →
 * 对超过 5 字的段取「前 4 字 + 后 4 字 + 中段 3 字滑窗」，总计最多 4 个词。
 *
 * 用 `[...s]` 而不是 `slice` 切，避免把 emoji 的代理对劈成半个字符。
 */
function extractTerms(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return [];
  const terms = [];
  const seen = new Set();
  const push = (word) => {
    const w = word.trim();
    if (!w || seen.has(w)) return;
    seen.add(w);
    terms.push(w);
  };

  for (const seg of raw.split(/[^\p{L}\p{N}]+/u)) {
    if (!seg) continue;
    const chars = [...seg];
    const n = chars.length;
    if (n < 2) continue; // 2 字以下碎片（含单字）丢掉
    if (STOPWORDS.has(seg)) continue;
    if (n <= 5) {
      push(seg);
    } else {
      push(chars.slice(0, 4).join(''));
      push(chars.slice(-4).join(''));
      // 中段滑窗：跳过首尾各 1~2 字，避免和「前 4」「后 4」重复
      for (let i = 2; i + MID_WINDOW <= n - 2; i += 2) {
        push(chars.slice(i, i + MID_WINDOW).join(''));
        if (terms.length >= MAX_TERMS) break;
      }
    }
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.slice(0, MAX_TERMS);
}

/** 单个词的候选 id（按 ts 倒序，最多 PER_TERM_LIMIT 条）。 */
function selectIdsForTerm(store, word, { conv }) {
  const convFilter = conv ? ' AND m.conv = ?' : '';
  const convArgs = conv ? [conv] : [];
  const kindFilter = `(m.kind IS NULL OR m.kind NOT IN (${EXCLUDED_KINDS_SQL}))`;

  if (charCount(word) >= FTS_MIN_CHARS) {
    // 注意：MATCH 左侧必须是表名，别名会报 "no such column: f"
    const ftsRows = stmt(
      store,
      `SELECT m.id AS id FROM msg m
         WHERE m.id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)
           AND ${kindFilter}${convFilter}
         ORDER BY m.ts DESC, m.id DESC
         LIMIT ?`,
    ).all(toFtsPhrase(word), ...convArgs, PER_TERM_LIMIT);
    if (ftsRows.length) return ftsRows.map((r) => Number(r.id));
    // 极少见：trigram 对含标点/符号的词可能切不出 trigram，防御性退回 LIKE
  }

  // 2 字词（以及 FTS 落空的长词）只能 LIKE —— trigram 的最小匹配长度是 3
  const likeRows = stmt(
    store,
    `SELECT m.id AS id FROM msg m
       WHERE m.text LIKE ? ESCAPE '\\'
         AND ${kindFilter}${convFilter}
       ORDER BY m.ts DESC, m.id DESC
       LIMIT ?`,
  ).all(`%${escapeLike(word)}%`, ...convArgs, PER_TERM_LIMIT);
  return likeRows.map((r) => Number(r.id));
}

/** 按 id 取回最终结果（TS 倒序）。 */
function fetchByIds(store, ids, { limit }) {
  const list = [...ids];
  if (!list.length) return [];
  const placeholders = list.map(() => '?').join(', ');
  const rows = stmt(
    store,
    `SELECT id, conv, sender_name, ts, text FROM msg
       WHERE id IN (${placeholders})
         AND (kind IS NULL OR kind NOT IN (${EXCLUDED_KINDS_SQL}))
       ORDER BY ts DESC, id DESC
       LIMIT ?`,
  ).all(...list, limit);
  return rows.map((r) => ({
    text: r.text,
    senderName: r.sender_name ?? '',
    ts: Number(r.ts),
    conv: r.conv,
  }));
}

/** 建库后校验：老库/残缺库要给出可操作的报错，而不是后面某个查询莫名失败。 */
function verifySchema(db, filePath) {
  let columns;
  try {
    columns = db.prepare('PRAGMA table_info(msg)').all().map((r) => r.name);
  } catch {
    columns = [];
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length) {
    fail(
      `库 ${filePath} 的 msg 表结构与预期不符，缺少列：${missing.join(', ')}。`
      + ' 若是旧版本残留，请先备份并删除该文件后重建。',
    );
  }
}

// ── 公开 API ────────────────────────────────────────────────────────────────

/**
 * 打开（或创建）原文库。同一路径重复调用返回同一个 store 实例。
 * @param {string} filePath 绝对路径；或相对仓库根的路径；或 ':memory:'
 * @returns {{path: string, db: DatabaseSync, closed: boolean}}
 */
export function openMemoryStore(filePath) {
  const abs = resolveDbPath(filePath);

  const cached = registry.get(abs);
  if (cached && !cached.closed) return cached;

  if (abs !== ':memory:') mkdirSync(path.dirname(abs), { recursive: true });

  let db;
  try {
    db = new DatabaseSync(abs);
    db.exec('PRAGMA journal_mode=WAL;');   // 读写并发：读不被写阻塞
    db.exec('PRAGMA synchronous=NORMAL;'); // WAL 下的常用折中（不丢已提交数据）
    db.exec('PRAGMA busy_timeout=5000;');  // 多进程/多连接抢写时等 5s 再报 SQLITE_BUSY
    db.exec(SCHEMA_SQL);
    db.exec('PRAGMA user_version=1;');
    verifySchema(db, abs);
  } catch (err) {
    try { db?.close(); } catch { /* 已经不可用 */ }
    fail(`打开 ${abs} 失败：${err?.message ?? err}`);
  }

  const store = {
    path: abs,
    db,
    closed: false,
    stmts: new Map(),
    txDepth: 0,
  };
  registry.set(abs, store);
  return store;
}

/**
 * 追加一条原文。幂等：同 (conv, message_id) 重复写入返回 false 而非报错。
 * 空文本返回 false（不入库）。
 *
 * @param {object} store
 * @param {{conv: string, messageId?: string|null, senderId?: string, senderName?: string,
 *          isSelf?: boolean, ts?: number, kind?: string, text: string, source?: string}} msg
 * @returns {boolean} 是否真的插入
 */
export function appendMessage(store, msg) {
  const s = requireStore(store);
  const row = normalizeMessage(msg);
  if (!row) return false;
  return withTransaction(s, () => insertOne(s, row));
}

/**
 * 批量追加（单事务）。接入时请优先用它：100 条消息逐条 append 是 100 个事务。
 * @returns {{inserted: number, skipped: number}}
 */
export function appendMessages(store, msgs) {
  const s = requireStore(store);
  const list = Array.isArray(msgs) ? msgs : [];
  let inserted = 0;
  let skipped = 0;
  withTransaction(s, () => {
    for (const msg of list) {
      const row = normalizeMessage(msg);
      if (!row) { skipped += 1; continue; }
      if (insertOne(s, row)) inserted += 1;
      else skipped += 1;
    }
  });
  return { inserted, skipped };
}

/**
 * 检索原文。
 *
 * 多词 AND 在应用层做：每个词各自查（各放宽到 30 条）→ 取 id 交集；
 * 交集为空才降级并集（阈值是 0），因为「只命中 1 条」往往才是对的。
 *
 * @param {object} store
 * @param {string} query
 * @param {{conv?: string, limit?: number}} [options]
 * @returns {Array<{text: string, senderName: string, ts: number, conv: string}>}
 */
export function searchMessages(store, query, options = {}) {
  const s = requireStore(store);
  const conv = options?.conv == null ? null : String(options.conv);
  const rawLimit = Number(options?.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const terms = extractTerms(query);
  if (!terms.length) return [];

  // 每个词一个候选 id 集合（保持 ts 倒序）
  const sets = terms.map((word) => new Set(selectIdsForTerm(s, word, { conv })));

  let ids;
  if (sets.length === 1) {
    ids = sets[0];
  } else {
    ids = new Set([...sets[0]].filter((id) => sets.every((set) => set.has(id))));
    if (ids.size === 0) {
      // 交集为空才降级并集 —— 不要用「结果少于 N」当条件
      ids = new Set(sets.flatMap((set) => [...set]));
    }
  }

  if (!ids.size) return [];
  return fetchByIds(s, ids, { limit });
}

/**
 * 原文条数。
 * @param {object} store
 * @param {string} [conv] 指定会话则只数该会话
 */
export function countMessages(store, conv) {
  const s = requireStore(store);
  if (conv == null || conv === '') {
    return Number(stmt(s, 'SELECT count(*) AS c FROM msg').get().c);
  }
  return Number(
    stmt(s, 'SELECT count(*) AS c FROM msg WHERE conv = ?').get(String(conv)).c,
  );
}

/**
 * 按保留期清理。**msg 与 msg_fts 必须同步删除**，否则会留下「搜得到、
 * 点开却是空的」幽灵命中。
 *
 * @param {object} store
 * @param {{keepDays: number, conv?: string}} options keepDays=0 表示清空
 * @returns {number} 实际删除的 msg 条数
 */
export function pruneMessages(store, options = {}) {
  const s = requireStore(store);
  const keepDays = Number(options?.keepDays);
  if (!Number.isFinite(keepDays) || keepDays < 0) {
    fail('pruneMessages 需要 keepDays >= 0 的数字');
  }
  const cutoff = Date.now() - Math.floor(keepDays) * DAY_MS;
  const conv = options?.conv == null ? null : String(options.conv);
  const convFilter = conv ? ' AND conv = ?' : '';
  const args = conv ? [cutoff, conv] : [cutoff];

  return withTransaction(s, () => {
    // 先删 FTS（此时 msg 还在，子查询拿得到 id 集合），再删主表
    stmt(
      s,
      `DELETE FROM msg_fts WHERE rowid IN (SELECT id FROM msg WHERE ts < ?${convFilter})`,
    ).run(...args);
    const res = stmt(s, `DELETE FROM msg WHERE ts < ?${convFilter}`).run(...args);
    return Number(res?.changes ?? 0);
  });
}

/**
 * 关闭库（幂等）。WAL 模式下 close 会做一次 checkpoint，之后 -wal 文件会被回收。
 */
export function closeMemoryStore(store) {
  if (!store || typeof store !== 'object') return false;
  if (store.closed) return false;
  store.closed = true;
  store.stmts.clear();
  try {
    store.db.close();
  } finally {
    if (registry.get(store.path) === store) registry.delete(store.path);
  }
  return true;
}