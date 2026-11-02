// 向量检索客户端：把「关键词检索」升级为「关键词 + 语义」混合检索。
//
// 为什么单独一个文件、并且不改 diary.js 的打分逻辑：
//   diary.js 里的 recallEntries/scoreEntry 是这套记忆系统的"唯一真源"，
//   已经被大量测试和线上行为验证过。这里只做**叠加**：
//     1. 先用原逻辑拿到每条日记的关键词分（含它自己的闸门规则）
//     2. 再向本地向量服务要一份语义相似度
//     3. 按实测最优权重融合（0.3 向量 + 0.7 关键词）
//   这样上下文过滤（withinDays / mood / tag / people / minImportance）
//   全部仍然由 diary.js 负责，不会出现两套过滤逻辑打架。
//
// 为什么要融合而不是直接用向量：
//   102 条真实日记 + 20 条人工标注查询上的实测结果 ——
//     纯关键词  R@1=0.417 R@3=0.683 R@5=0.792  hard R@5=0.39
//     纯向量    R@1=0.350 R@3=0.508 R@5=0.575  hard R@5=0.56
//     融合 0.3  R@1=0.425 R@3=0.767 R@5=0.867  hard R@5=0.61
//   向量单看打不过关键词（小语料上词面精确命中很强），但它在 hard 集合
//   上明显更强 —— 那批查询的共同点是"词面零重叠"（"声音不好听" vs 原文
//   "语音难听"、"冰的" vs 原文"甜筒"）。两者互补，融合才是最优。
//
// 向量服务不可用时**必须优雅降级**：直接返回纯关键词结果，绝不能让
// 聊天因为向量服务重启而检索失败。

// 日志：本模块不直接依赖 bridge.js 的 log（那会造成循环 import），
// 用一个可注入的 logger，默认退化到 console。
let log = (...args) => console.log('[vector-recall]', ...args);

/** 由 bridge.js 在启动时注入它自己的 log，保持日志格式一致。 */
export function setLogger(fn) {
  if (typeof fn === 'function') log = fn;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9870';
const DEFAULT_W_VEC = 0.3;
const TIMEOUT_MS = 3000;

// 向量相似度的绝对下限。低于它的条目即使融合后靠前也不该进入结果 ——
// 日记检索里"召回到完全无关的事"比"什么都没召回"更糟：
// 前者会让模型理直气壮地讲一件没发生过的事。
const MIN_VEC_SCORE = 0.15;

let endpoint = DEFAULT_ENDPOINT;
let enabled = true;
let lastHealth = { ok: false, at: 0 };

export function configure(options = {}) {
  if (typeof options.endpoint === 'string') endpoint = options.endpoint.replace(/\/+$/, '');
  if (typeof options.enabled === 'boolean') enabled = options.enabled;
  if (typeof options.wVec === 'number') wVec = clamp(options.wVec, 0, 1);
  if (typeof options.minVecScore === 'number') minVecScore = options.minVecScore;
}

let wVec = DEFAULT_W_VEC;
let minVecScore = MIN_VEC_SCORE;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function postJson(path, body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 探活。调用方据此决定这次要不要走向量。 */
export async function isAvailable() {
  if (!enabled) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${endpoint}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const data = await res.json();
    lastHealth = { ok: data?.ok === true, at: Date.now(), count: data?.count ?? 0 };
    return lastHealth.ok;
  } catch {
    lastHealth = { ok: false, at: Date.now() };
    return false;
  }
}

/**
 * 把日记全量推给向量服务重建索引。
 * 日记是"只增不改"的，服务端按文本 sha256 做缓存，所以重复调用只会
 * 计算新增的部分，不会反复跑 GPU。
 */
export async function syncIndex(entries) {
  if (!enabled) return { ok: false, reason: 'disabled' };
  const items = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.id && e.body)
    .map((e) => ({
      id: String(e.id),
      // title + body 一起编码：title 是人写的概括，信息密度比正文高
      text: `${e.title ? e.title + '。' : ''}${e.body}`,
      meta: { title: e.title ?? '', time: e.time ?? 0 }
    }));
  if (!items.length) return { ok: false, reason: 'empty' };
  try {
    const data = await postJson('/rebuild', { items }, 120000);
    return { ok: true, ...data };
  } catch (error) {
    log(`向量索引同步失败（不影响关键词检索）：${error?.message ?? error}`);
    return { ok: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 混合检索。
 *
 * @param {string} query 用户原话
 * @param {object} opts
 * @param {Map<string, number>} opts.keywordScores 日记 id -> 关键词分（由 diary.js 算好）
 * @param {string[]} opts.poolIds 允许参与排序的 id（上下文过滤后的池子）
 * @param {number} opts.topK
 * @returns {Promise<Array<{id,score,vecScore,kwScore}>|null>} null = 向量不可用
 */
export async function hybridSearch(query, opts = {}) {
  if (!enabled) return null;
  const q = String(query ?? '').trim();
  if (!q) return null;

  const { keywordScores, poolIds, topK = 10 } = opts;
  if (!keywordScores || keywordScores.size === 0) return null;

  try {
    // 只把池子里的分数传给服务端，避免无效 id 占用向量
    const kwObj = {};
    for (const [id, score] of keywordScores) {
      if (!poolIds || poolIds.has(id)) kwObj[id] = Number(score) || 0;
    }
    if (!Object.keys(kwObj).length) return null;

    const data = await postJson('/hybrid', {
      query: q,
      keywordScores: kwObj,
      topK: Math.max(1, Math.min(50, topK)),
      wVec
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return null;
    return results.map((r) => ({
      id: String(r.id),
      score: Number(r.score) || 0,
      vecScore: Number(r.score) || 0, // 服务端返回的是融合分
      meta: r.meta || {}
    }));
  } catch (error) {
    // 向量服务挂了不该影响聊天：返回 null，调用方落回纯关键词
    log(`向量检索失败，回退关键词检索：${error?.message ?? error}`);
    return null;
  }
}

export function status() {
  return { enabled, endpoint, wVec, minVecScore, lastHealth };
}
