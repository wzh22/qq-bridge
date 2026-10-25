// B 站只读 API 客户端（供 mcp-bilibili-safe 与桥接共用）。
//
// 设计原则（2026-10-25 调研后定稿）：
//
//  ① **只读**。本文件不实现发弹幕、发评论、关注、投币、下载等任何写操作。
//     起因：GitHub 上现成的 bilibili-mcp-server 有 31 个工具，其中 bilibili_send_danmaku /
//     bilibili_reply / bilibili_user_follow 都是真账号上的不可逆动作。QQ 机器人在群聊里
//     自主决定「我要学习」，若还能顺手发弹幕/关注，等于把不可逆副作用交给一个概率模型。
//     所以这里只保留「读」，写操作一个都不给。
//
//  ② **字幕需要登录**（B 站 2022 年后的策略）。实测：
//       - 未登录：/x/player/wbi/v2 的 data.subtitle.subtitles 恒为 []，
//         且 data.need_login_subtitle = true；
//       - 换知识区/科普区/教程区十几个视频试过，未登录全是 0 条轨道。
//     因此不把「能看字幕」当成默认能力，而是：
//       - 配置了 SESSDATA ⇒ 走字幕（真正的逐字内容）；
//       - 没配置 ⇒ 退回「分P大纲 + 简介 + 高赞评论 + 弹幕」，仍是有信息量的结构化材料，
//         但会在返回里**明确标注**「未登录，没有逐字字幕」，绝不假装看懂了视频。
//
//  ③ **域名白名单**。只允许 api.bilibili.com / passport.bilibili.com / *.hdslb.com 等
//     固定后缀，避免这个模块被当成任意 URL 抓取器（那是 safe-fetch.js 的职责，它有 SSRF 防护）。
//
//  ④ 限速。B 站对未登录高频请求会返回 -352（风控）甚至短暂封 IP。所有请求串行 + 间隔，
//     并在 -352 时退避重试一次。
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// WBI 混淆表（自 2023-03 起未变；与 GitHub 上多个实现交叉核对一致）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

// 允许的域名（后缀匹配）。subtitle_url 指向 i0.hdslb.com 之类的 CDN。
const ALLOWED_HOSTS = [
  'api.bilibili.com',
  'api.biliapi.net',
  'passport.bilibili.com',
  'www.bilibili.com',
  'hdslb.com',
  'bilibili.com'
];

function hostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

// ── 限速：所有请求串行排队，默认间隔 350ms ────────────────────────────────
let chain = Promise.resolve();
let lastAt = 0;
const MIN_INTERVAL_MS = 350;

function throttle() {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * 受限 HTTP 抓取：只允许白名单域名，超时与体积上限可控。
 * @param {string} url
 * @param {{headers?:Record<string,string>, timeoutMs?:number, maxBytes?:number, binary?:boolean}} opts
 */
async function biliFetch(url, opts = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`只允许 https：${url}`);
  if (!hostAllowed(u.hostname)) throw new Error(`域名不在白名单内：${u.hostname}`);

  const timeoutMs = Number(opts.timeoutMs) || 15000;
  const maxBytes = Number(opts.maxBytes) || 4 * 1024 * 1024;

  const res = await fetch(u, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers || {})
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  });

  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new Error(`响应过大（${len} 字节）`);

  if (opts.binary) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`响应过大（${buf.length} 字节）`);
    return { status: res.status, buffer: buf, headers: res.headers };
  }

  const text = await res.text();
  if (text.length > maxBytes) throw new Error(`响应过大（${text.length} 字符）`);
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON，交给调用方判断 */ }
  return { status: res.status, text, json };
}

/** 取 JSON，并在 code !== 0 时抛错（B 站约定 code===0 为成功）。 */
async function biliJson(url, opts = {}) {
  const r = await biliFetch(url, opts);
  if (!r.json) throw new Error(`返回的不是 JSON（HTTP ${r.status}）：${String(r.text).slice(0, 120)}`);
  // ⚠️ 不是所有接口都带 code：字幕文件（*.hdslb.com/bfs/*subtitle*）直接返回
  //    {"body":[...],"font_size":...}，没有 code 字段。旧逻辑强制 code===0，
  //    于是永远抛 "code=undefined"，字幕明明拿到了也报错。
  //    约定：code 字段**不存在** 视为成功（资源型接口）；存在但不为 0 才抛。
  if (Object.hasOwn(r.json, 'code') && r.json.code !== 0) {
    const err = new Error(`B站接口错误 code=${r.json.code} ${r.json.message || ''}`.trim());
    err.biliCode = r.json.code;
    throw err;
  }
  // 有 data 就返回 data；资源型接口（无 data）返回整个 body
  return r.json.data ?? r.json;
}

// ── WBI 签名 ──────────────────────────────────────────────────────────────
const wbiCache = { mixin: null, at: 0, img: '', sub: '' };

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  let mixed = '';
  for (let i = 0; i < 32; i += 1) mixed += raw[MIXIN_KEY_ENC_TAB[i]] ?? '';
  return mixed;
}

/**
 * 取 WBI 密钥。未登录也能取到（nav 返回 -101 但 data.wbi_img 仍在）。
 * @param {string} cookie 可选的登录 cookie
 */
export async function getWbiKeys(cookie = '') {
  const now = Date.now();
  if (wbiCache.mixin && now - wbiCache.at < 3_600_000) return wbiCache;

  const r = await biliFetch('https://api.bilibili.com/x/web-interface/nav', { cookie, timeoutMs: 10000 });
  const nav = r.json || {};
  const wbi = nav?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) {
    throw new Error(`拿不到 WBI 密钥（nav code=${nav.code ?? '?'}）`);
  }
  const imgKey = String(wbi.img_url.split('/').pop() || '').replace(/\.png$/i, '');
  const subKey = String(wbi.sub_url.split('/').pop() || '').replace(/\.png$/i, '');

  wbiCache.mixin = getMixinKey(imgKey, subKey);
  wbiCache.at = now;
  wbiCache.img = imgKey;
  wbiCache.sub = subKey;
  // buvid3 是未登录请求的「浏览器指纹」，带上能显著降低 -352 风控
  wbiCache.buvid3 = nav?.data?.buvid3 || '';
  wbiCache.isLogin = nav?.data?.isLogin === true;
  return wbiCache;
}

/** 清缓存（遇到 -352 时用）。 */
export function clearWbiCache() {
  wbiCache.mixin = null;
  wbiCache.at = 0;
}

function encodeWbi(v) {
  return encodeURIComponent(String(v)).replace(/[!'()*]/g, '');
}

/** 对参数做 WBI 签名，返回带 wts / w_rid 的对象。 */
export function signWbi(params, mixin) {
  const all = { ...params, wts: String(Math.floor(Date.now() / 1000)) };
  const query = Object.keys(all).sort()
    .map((k) => `${encodeWbi(k)}=${encodeWbi(all[k])}`)
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixin, 'utf8').digest('hex');
  return { ...all, w_rid: wRid };
}

/**
 * 带 WBI 签名的 GET。遇到 -352 自动刷新密钥重试一次。
 */
async function wbiGet(path, params, opts = {}) {
  const cookie = opts.cookie || '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await throttle();
    const keys = await getWbiKeys(cookie);
    const signed = signWbi(params, keys.mixin);
    const qs = new URLSearchParams(signed).toString();
    const url = `https://api.bilibili.com${path}?${qs}`;
    // 未登录时补 buvid3，降低风控
    const ck = cookie || (keys.buvid3 ? `buvid3=${keys.buvid3}` : '');
    try {
      return await biliJson(url, { ...opts, cookie: ck });
    } catch (error) {
      if (error?.biliCode === -352 && attempt === 0) {
        clearWbiCache();
        continue;
      }
      throw error;
    }
  }
  throw new Error('WBI 签名重试后仍失败');
}

// ── 视频 ID 处理 ──────────────────────────────────────────────────────────

/** 从任意输入里提取 BV 号或 av 号。支持完整 URL、b23.tv 短链（短链需先解析）。 */
export function extractVideoId(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) return bv[0];
  const av = s.match(/av(\d+)/i);
  if (av) return `av${av[1]}`;
  // 纯数字当作 aid
  if (/^\d+$/.test(s)) return `av${s}`;
  return null;
}

/** 是否是 b23.tv 短链（需要跟随重定向拿到真实 BV）。 */
export function isShortLink(input) {
  return /^https?:\/\/b23\.tv\//i.test(String(input ?? '').trim());
}

/** 解析 b23.tv 短链为真实 URL。 */
export async function resolveShortLink(link) {
  const u = new URL(link);
  if (!/b23\.tv$/i.test(u.hostname)) throw new Error('不是 b23.tv 短链');
  await throttle();
  const res = await fetch(u, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(15000)
  });
  return res.url;
}

// ── 业务接口 ──────────────────────────────────────────────────────────────

/** 搜索视频。order: totalrank|click|pubdate|dm|stow|scores */
export async function searchVideos(keyword, opts = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('关键词为空');
  const data = await wbiGet('/x/web-interface/wbi/search/type', {
    search_type: 'video',
    keyword: kw,
    page: String(opts.page || 1),
    order: opts.order || 'totalrank',
    ...(opts.duration ? { duration: String(opts.duration) } : {})
  }, { cookie: opts.cookie });

  const list = (data.result || []).map((v) => {
    // 搜索接口的 duration 是 "12:34" 这种字符串，不是秒数；
    // 早期实现直接 Number() 会得到 NaN/0，界面上就显示成 ⏱0s。
    const dur = parseDuration(v.duration);
    return {
      bvid: v.bvid,
      aid: v.aid,
      title: String(v.title || '').replace(/<[^>]+>/g, ''),
      author: v.author,
      mid: v.mid,
      play: Number(v.play) || 0,
      danmaku: Number(v.danmaku || v.video_review) || 0,
      like: Number(v.like) || 0,
      favorite: Number(v.favorites) || 0,
      duration: dur,
      durationText: formatDurationText(dur),
      pubdate: Number(v.pubdate) || 0,
      typename: v.typename || v.cate_name || '',
      description: String(v.description || '').replace(/<[^>]+>/g, '').slice(0, 200),
      tag: v.tag || ''
    };
  });
  return { total: Number(data.numResults) || list.length, page: Number(data.page) || 1, list };
}

/** 把 "12:34" / "1:02:03" / 123(秒) 统一成秒数。 */
export function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  const s = String(v ?? '').trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  const parts = s.split(':').map((x) => Number(x) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

/** 秒数 → "12:34" / "1:02:03"。 */
export function formatDurationText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '未知';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

/** 视频详情（含分P列表 = 天然课程大纲）。 */
export async function getVideoInfo(videoId, opts = {}) {
  const id = extractVideoId(videoId);
  if (!id) throw new Error(`无法识别视频 ID：${videoId}`);
  const params = /^BV/i.test(id) ? { bvid: id } : { aid: id.replace(/^av/i, '') };
  const d = await wbiGet('/x/web-interface/wbi/view', params, { cookie: opts.cookie });

  const pages = (d.pages || []).map((p) => ({
    page: p.page, cid: p.cid, part: p.part, duration: p.duration
  }));
  // ⚠️ 多P场景：`d.duration` 是**整个合集的总时长**（实测 100P 的 Python 教程
  //    总时长 143894s，但第 1P 只有 164s），而 cid 指向的是**当前这一P**。
  //    字幕校验必须用「当前P的时长」，用总时长会把正确字幕判成错位。
  //    单P视频两者相等，取哪个都一样。
  const currentPage = pages.find((p) => String(p.cid) === String(d.cid));
  const pageDuration = Number(currentPage?.duration) || Number(d.duration) || 0;

  return {
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: d.title,
    desc: String(d.desc || ''),
    owner: { mid: d.owner?.mid, name: d.owner?.name },
    stat: {
      view: d.stat?.view, danmaku: d.stat?.danmaku, reply: d.stat?.reply,
      favorite: d.stat?.favorite, coin: d.stat?.coin, like: d.stat?.like, share: d.stat?.share
    },
    duration: d.duration,
    // 当前所看这一P的时长（单P视频等于 duration）
    pageDuration,
    pubdate: d.pubdate,
    tname: d.tname || d.tname_v2 || '',
    videos: Number(d.videos) || 1,
    tags: (d.tag || []).map((t) => t.tag_name).filter(Boolean),
    pages
  };
}

/** 视频章节/看点（部分视频有，未登录也可能拿到）。 */
export async function getViewPoints(bvid, cid, opts = {}) {
  try {
    const d = await wbiGet('/x/player/wbi/v2', { bvid, cid: String(cid) }, { cookie: opts.cookie });
    return {
      needLoginSubtitle: d.need_login_subtitle === true,
      subtitleCount: (d.subtitle?.subtitles || []).length,
      viewPoints: (d.view_points || []).map((v) => ({ from: v.from, to: v.to, content: v.content }))
    };
  } catch {
    return { needLoginSubtitle: null, subtitleCount: 0, viewPoints: [] };
  }
}

/**
 * 取字幕。**必须登录**（未登录恒为空）。
 *
 * ⚠️ 2026-10-25 实测踩了两个坑：
 *
 * ① 两个 player 接口的 subtitle 字段**不一致且不是子集**，必须都试：
 *    · `/x/player/wbi/v2` —— 新版，需 WBI 签名
 *    · `/x/player/v2`     —— 旧版，无需签名；实测比 wbi/v2 更常给字幕
 *
 * ② **B 站字幕接口是间歇性的**：同视频、同 cookie 连打 8 次 player/v2，
 *    `subtitles` 条数是 `0,0,1,1,1,0,0,1` —— 约一半返回空。
 *    所以「一次没拿到」**不能判定为没有字幕**，必须重试再下结论。
 *    这正是「明明有字幕却报没有字幕」的真正原因（不是代码 bug）。
 *
 * 另：字幕轨字段是 `subtitle_url`（不是 url），`//` 开头要补 `https:`。
 *
 * @returns {{ok:boolean, reason?:string, lang?:string, lines?:Array<{t:number,text:string}>}}
 */
export async function getSubtitle(bvid, cid, opts = {}) {
  const cookie = opts.cookie || '';
  if (!cookie) {
    return { ok: false, reason: '未配置 B 站登录 Cookie（SESSDATA）。未登录时 B 站不下发字幕，故无法取得逐字内容。' };
  }

  // 交替打两个接口 + 重试，任一次拿到非空字幕轨就停。
  // 试 6 次：按实测 ~50% 空返回，连空 6 次概率约 1.6%。
  const MAX_TRIES = 6;
  let subs = [];
  let lastError = '';
  for (let i = 0; i < MAX_TRIES && subs.length === 0; i += 1) {
    const useWbi = i % 2 === 0;
    try {
      await throttle();
      let body;
      if (useWbi) {
        const keys = await getWbiKeys(cookie);
        const signed = signWbi({ bvid, cid: String(cid) }, keys.mixin);
        body = await biliJson(
          `https://api.bilibili.com/x/player/wbi/v2?${new URLSearchParams(signed).toString()}`,
          { cookie }
        );
      } else {
        body = await biliJson(
          `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,
          { cookie }
        );
      }
      const list = body?.subtitle?.subtitles || [];
      if (list.length) subs = list;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    if (subs.length === 0 && i < MAX_TRIES - 1) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  if (!subs.length) {
    return {
      ok: false,
      reason: lastError
        ? `抓字幕接口出错（已登录，重试 ${MAX_TRIES} 次）：${lastError}`
        : `重试 ${MAX_TRIES} 次仍未取到字幕轨（该视频可能确实没字幕；B 站这个接口本身也会间歇性返回空）。`
    };
  }
  // ── 选字幕轨：用「URL 前缀 == aid+cid」判定归属（2026-10-25 实测发现的硬规律）──
  //
  // 背景：B 站 `player/v2` 的 `subtitle.subtitles` 会**混入别的视频的 AI 字幕**。
  // 同一个 cid 连打 10 次，返回的是 5 个完全不同的字幕文件，内容属于别的视频
  // （Rick Astley 的 MV 返回「把空吹轮带到另一个院子」、3B1B 线代返回「江南水乡种水稻」）。
  //
  // 判据：`ai_subtitle` 的字幕 URL 路径 = `<aid><cid><hash>`，
  // 即**前缀严格等于 aid 拼 cid**。实测 BV1rpWjevEip（aid=113006243481679,
  // cid=36010133667）拿到的正确字幕前缀正是 `11300624348167936010133667`；
  // 其余前缀对不上的全部是错位字幕。
  //
  // 官方字幕（lan=zh-CN 等，路径是 `bfs/subtitle/<hash>.json`）不走这个规律，
  // 但它们本身稳定可靠（实测同一视频 6 次全一致），所以：
  //   · 官方字幕：直接用
  //   · AI 字幕：必须前缀匹配 aid+cid 才用，否则丢弃
  const aidStr = String(opts.aid || '');
  const cidStr = String(cid || '');
  const expectPrefix = aidStr && cidStr ? `${aidStr}${cidStr}` : '';

  const isAi = (s) => String(s.lan || '').startsWith('ai-');
  const urlPath = (s) => String(s.subtitle_url || '').split('?')[0].split('/').pop();
  const belongsToThisVideo = (s) => {
    if (!isAi(s)) return true;              // 官方字幕默认可信
    if (!expectPrefix) return true;         // 没有 aid 信息时无法校验，交给时长校验
    return urlPath(s).startsWith(expectPrefix);
  };

  const official = ['zh-CN', 'zh-Hans', 'zh-Hant', 'zh-HK'];
  // 先把所有轨道按「官方优先 → 语言偏好 → 归属正确」排好
  const ranked = subs
    .filter((s) => s?.subtitle_url && belongsToThisVideo(s))
    .sort((a, b) => {
      const rank = (s) => {
        const lan = String(s.lan || '');
        if (lan === opts.lang) return 0;
        const oi = official.indexOf(lan);
        if (oi >= 0) return 1 + oi;
        if (lan === 'en-US') return 10;
        if (isAi(s)) return 20;
        return 15;
      };
      return rank(a) - rank(b);
    });

  let target = ranked[0];
  let droppedMisattributed = subs.filter((s) => !belongsToThisVideo(s)).length;

  // 如果所有 AI 字幕都被判为「不属于本视频」，且没有官方字幕，就明确报错，
  // 不要退而求其次拿一条错的。
  if (!target && droppedMisattributed > 0) {
    return {
      ok: false,
      reason:
        `B 站返回的 ${droppedMisattributed} 条 AI 字幕都不属于这个视频（URL 前缀与 aid+cid 不符），` +
        '已全部丢弃。这是 B 站 AI 字幕接口的已知问题：它会串到其他视频的字幕上。'
    };
  }
  if (!target) {
    return { ok: false, reason: '没有可用的字幕轨道。' };
  }
  if (!target?.subtitle_url) {
    return { ok: false, reason: `字幕轨道 ${target?.lan || '?'} 没有下载地址。` };
  }
  const url = target.subtitle_url.startsWith('//') ? `https:${target.subtitle_url}` : target.subtitle_url;
  await throttle();
  const sub = await biliJson(url, { cookie });
  const body = sub.body || [];
  const lines = body.map((x) => ({ t: Number(x.from) || 0, text: String(x.content || '') }));

  // ── 完整性/正确性校验（2026-10-25 实测加，防「给错字幕」）────────────────
  // 实测 B 站 ai-zh 字幕会**张冠李戴**：同一个 cid 反复请求返回不同文件，
  // 内容属于别的视频（Rick Astley 的 MV 返回「把空吹轮带到另一个院子」，
  // 3B1B 线代返回「江南水乡种水稻」）。这种内容喂给模型比没有更糟——不是噪声，
  // 是看起来像内容的错误事实。所以宁可判定失败，也不返回可疑字幕。
  // 校验依据：字幕时间轴应大致覆盖视频时长（容差 0.5x~1.6x）。
  const duration = Number(opts.duration) || 0;
  if (duration > 0 && lines.length) {
    const lastT = lines.reduce((max, l) => Math.max(max, l.t), 0);
    if (lastT < duration * 0.5 || lastT > duration * 1.6) {
      return {
        ok: false,
        reason:
          `取到的字幕时间轴与视频时长不符（视频 ${Math.round(duration)} 秒，字幕只到 ${Math.round(lastT)} 秒），` +
          '判定为错位字幕并丢弃。B 站 AI 字幕接口会返回其他视频的字幕，宁可不给也不给错。'
      };
    }
  } else if (lines.length < 5) {
    return { ok: false, reason: `取到的字幕只有 ${lines.length} 行，明显不完整，已丢弃。` };
  }

  return {
    ok: true,
    lang: target.lan,
    langDoc: target.lan_doc,
    lines
  };
}

/** 高赞评论（按热度排序）。 */
export async function getComments(aid, opts = {}) {
  const max = Math.min(Number(opts.max) || 20, 50);
  const d = await wbiGet('/x/v2/reply/wbi/main', {
    oid: String(aid), type: '1', mode: '3', pn: '1', ps: String(max)
  }, { cookie: opts.cookie });
  const replies = d.replies || [];
  return replies.map((r) => ({
    like: Number(r.like) || 0,
    user: r.member?.uname || '?',
    message: String(r.content?.message || '').replace(/\s+/g, ' ').slice(0, 300)
  }));
}

// ── 弹幕 protobuf 解析（不引第三方 protobuf 库） ──────────────────────────

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p];
    p += 1;
    result += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) return { value: result, pos: p };
    shift += 7;
    if (shift > 63) break;
  }
  return { value: result, pos: p };
}

/**
 * 解一条 DanmakuElem。
 *
 * 字段号必须严格按官方 proto 定义（bilibili-API-collect / dm.proto）：
 *   1 id(int64)  2 progress(int32, 毫秒)  3 mode  4 fontsize  5 color
 *   6 midHash    7 content(string)        8 ctime  9 weight
 *
 * ⚠️ 曾经踩过的坑：把 field 3 当成 progress 解，结果所有弹幕时间都是 0
 *   （field 3 实际是 mode，值恒为 1~8），弹幕时间轴全错。改回 field 2 才对。
 */
function parseDanmakuElem(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.pos;
    const field = Math.floor(key.value / 8);
    const wire = key.value & 7;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      if (field === 2) out.progress = v.value;      // 出现时间（毫秒）
      else if (field === 3) out.mode = v.value;     // 弹幕类型
      else if (field === 4) out.fontsize = v.value; // 字号
      else if (field === 5) out.color = v.value;    // 颜色
      else if (field === 8) out.ctime = v.value;    // 发送时间戳
    } else if (wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const chunk = buf.subarray(pos, pos + l.value);
      pos += l.value;
      if (field === 7) out.content = chunk.toString('utf8');
      else if (field === 6) out.midHash = chunk.toString('utf8');
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else break;
  }
  return out;
}

/**
 * 把一个 DmSegMobileReply 二进制包解析成弹幕列表。
 *
 * 单独抽出来（而不是留在 getDanmaku 里）是为了**能被离线确定性测试覆盖**：
 * 之前这个解析逻辑只存在于「联网抓一个视频的真实弹幕包」那条路径上，
 * 于是测试既依赖网络、又依赖那个视频还活着，失败了也说不清是网的问题还是解析的问题。
 *
 * 顶层结构：repeated DanmakuElem elems = 1;
 */
export function parseDanmakuSegment(buf) {
  if (!buf || !buf.length) return [];
  const items = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.pos;
    const field = Math.floor(key.value / 8);
    const wire = key.value & 7;
    if (wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const chunk = buf.subarray(pos, pos + l.value);
      pos += l.value;
      if (field === 1) {
        const d = parseDanmakuElem(chunk);
        if (d.content) items.push({ t: d.progress || 0, text: d.content });
      }
    } else if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
    } else break;
  }
  return items;
}

/** 取一页弹幕（每 6 分钟一段）。返回带时间点的弹幕列表。 */
export async function getDanmaku(cid, opts = {}) {
  const seg = Number(opts.segment) || 1;
  await throttle();
  const r = await biliFetch(
    `https://api.bilibili.com/x/v2/dm/web/seg.so?type=1&oid=${encodeURIComponent(cid)}&segment_index=${seg}`,
    { binary: true, maxBytes: 8 * 1024 * 1024, cookie: opts.cookie }
  );
  return parseDanmakuSegment(r.buffer);
}

// ── 学习材料聚合 ──────────────────────────────────────────────────────────

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

/**
 * 从弹幕/评论里抽高频词（粗粒度，只做「这视频在聊什么」的印象）。
 *
 * ⚠️ 弹幕噪声极大，实测常见的污染源：
 *   - 刷屏佛号/口号（「南无阿弥陀佛」这类，单条就能刷几百遍）
 *   - 颜文字/制表符（◢◤ ◥◣ 这种方块字符）
 *   - 无意义叠字（「哈哈哈哈」「233333」）
 *   - 求资料/报班广告（「讲义在哪买」「怎么报班」——是噪音不是内容）
 * 所以这里做三重过滤：字符集白名单 + 停用词 + 「单条弹幕不得重复计入同一词」，
 * 宁可关键词少几个，也不要给模型递一堆垃圾让它以为那就是视频内容。
 */
function topTerms(texts, limit = 15) {
  const stop = new Set([
    '这个', '那个', '什么', '怎么', '可以', '就是', '我们', '你们', '他们', '她们',
    '不是', '没有', '一个', '现在', '真的', '感觉', '老师', '时候', '这样', '那样',
    '知道', '觉得', '其实', '已经', '还是', '但是', '因为', '所以', '如果', '然后',
    '哈哈哈', '哈哈', '2333', '打卡', '前', '的', '了', '是', '在', '有', '我', '你',
    '讲义', '报班', '资料', '私信', '小号', '假冒', '谨防', '受骗'
  ]);
  // 只允许中文/字母/数字组成的词，挡掉颜文字、方块字符、符号串
  const wordLike = /^[\u4e00-\u9fa5A-Za-z0-9]+$/;
  // 中文刷屏语料：B 站弹幕里常见整段复读的经文/口号，单条就能刷上百遍。
  // 光靠词频过滤不掉（它们本身就是「高频词」），必须显式排除。
  const spamLike = /佛|菩萨|如来|南无|阿弥陀|波罗蜜|摩诃|僧|陀罗尼|唵|嘛呢叭/;

  const freq = new Map();
  for (const t of texts) {
    // 单条弹幕内先去重：同一句话里重复的词只算一次，避免刷屏放大
    const seen = new Set();
    for (const w of String(t).split(/[\s，。！？、,.!?~～；;：:""''()（）【】\[\]]+/)) {
      const s = w.trim();
      if (s.length < 2 || s.length > 8) continue;
      if (stop.has(s)) continue;
      if (!wordLike.test(s)) continue;
      if (spamLike.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      freq.set(s, (freq.get(s) || 0) + 1);
    }
  }
  // 出现次数 ≥2 才算「高频」，单次提及不算共识
  return [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w, c]) => ({ term: w, count: c }));
}

/**
 * 把一个视频抓成「可学习的材料」。
 *
 * 这是给 QQ 机器人「看视频学习」用的核心入口：一次调用尽量把能读的都读到，
 * 并如实标注哪些拿到了、哪些没拿到（尤其字幕）。
 *
 * @param {string} input BV号/av号/URL/b23短链
 * @param {{cookie?:string, maxComments?:number, danmakuSegments?:number}} opts
 */
export async function collectVideoMaterial(input, opts = {}) {
  let videoId = extractVideoId(input);
  if (!videoId && isShortLink(input)) {
    const real = await resolveShortLink(input);
    videoId = extractVideoId(real);
  }
  if (!videoId) throw new Error(`无法识别视频：${input}`);

  const info = await getVideoInfo(videoId, opts);
  const cookie = opts.cookie || '';

  // 字幕（需要登录）。传 duration + aid 供校验：
  //   · duration → 字幕时间轴必须与视频时长吻合。**必须用 pageDuration**：
  //                多P视频的 info.duration 是合集总时长（100P 的 Python 教程
  //                总 143894s，第 1P 只有 164s），拿总时长校验会把正确字幕判成错位。
  //   · aid      → AI 字幕的 URL 前缀必须等于 aid+cid，否则是串到别的视频的字幕
  // 详见 getSubtitle 注释。
  const subtitle = await getSubtitle(info.bvid, info.cid, {
    cookie,
    duration: info.pageDuration || info.duration,
    aid: info.aid
  });

  // 章节看点
  const vp = await getViewPoints(info.bvid, info.cid, { cookie });

  // 评论
  let comments = [];
  try {
    comments = await getComments(info.aid, { cookie, max: Math.min(Number(opts.maxComments) || 20, 30) });
  } catch { comments = []; }

  // 弹幕（第 1 段就够；多段会翻倍请求且信息重复度高）
  let danmaku = [];
  try {
    const segs = Math.min(Math.max(Number(opts.danmakuSegments) || 1, 1), 3);
    for (let i = 1; i <= segs; i += 1) {
      danmaku = danmaku.concat(await getDanmaku(info.cid, { cookie, segment: i }));
    }
  } catch { danmaku = []; }

  return {
    info,
    subtitle,
    needLoginSubtitle: vp.needLoginSubtitle,
    viewPoints: vp.viewPoints,
    comments,
    danmaku,
    topTerms: topTerms([...danmaku.map((d) => d.text), ...comments.map((c) => c.message)]),
    fmtTime
  };
}

/**
 * 把 collectVideoMaterial 的结果渲染成给模型看的纯文本。
 *
 * 关键：**分段标注数据来源与可信度**，让模型知道「哪些是视频真实内容（字幕）」、
 * 「哪些只是二手信号（评论/弹幕）」。不允许把二手信号当成视频内容来「学习」。
 */
export function renderMaterial(m, opts = {}) {
  const maxChars = Number(opts.maxChars) || 12000;
  const L = [];
  const it = m.info;

  L.push(`《${it.title}》`);
  L.push(`UP主：${it.owner.name}（uid:${it.owner.mid}）`);
  L.push(`时长：${fmtTime(it.duration)}　分P：${it.videos}　分区：${it.tname || '未知'}`);
  L.push(`播放 ${it.stat.view ?? '?'}　弹幕 ${it.stat.danmaku ?? '?'}　评论 ${it.stat.reply ?? '?'}　点赞 ${it.stat.like ?? '?'}`);
  L.push(`BV号：${it.bvid}`);
  if (it.tags.length) L.push(`标签：${it.tags.join('、')}`);
  if (it.desc) L.push(`\n【简介】\n${it.desc.slice(0, 800)}`);

  // ── 内容主体：字幕优先 ──
  if (m.subtitle.ok) {
    L.push(`\n【字幕·逐字内容（${m.subtitle.langDoc || m.subtitle.lang}）】`);
    let used = 0;
    for (const line of m.subtitle.lines) {
      const s = `[${fmtTime(line.t)}] ${line.text}`;
      if (used + s.length > maxChars) { L.push(`…（字幕过长，已截断，共 ${m.subtitle.lines.length} 条）`); break; }
      L.push(s);
      used += s.length;
    }
  } else {
    L.push(`\n【注意：没有逐字字幕】${m.subtitle.reason}`);
    if (m.needLoginSubtitle) L.push('（接口标记 need_login_subtitle=true，配置登录 Cookie 后可取）');
  }

  // ── 分P大纲 ──
  //
  // 100P 的教程如果全列出来会吃掉整个预算，把后面的评论/弹幕挤没。
  // 这里按总量自适应：P 多就少列（并提示模型可用 pages 参数看完整列表），
  // 保证「大纲 + 评论 + 弹幕」都在，而不是大纲一家独大。
  if (it.pages.length > 1) {
    const maxPages = Number(opts.maxPages) || (it.pages.length > 40 ? 25 : 60);
    L.push(`\n【分P大纲（共 ${it.pages.length} P，这是课程结构，可作为学习路径）】`);
    for (const p of it.pages.slice(0, maxPages)) {
      L.push(`  P${p.page} ${p.part}（${fmtTime(p.duration)}）`);
    }
    if (it.pages.length > maxPages) {
      L.push(`  … 还有 ${it.pages.length - maxPages} P 未列出`);
    }
  }

  // ── 章节看点 ──
  if (m.viewPoints.length) {
    L.push(`\n【章节看点】`);
    for (const v of m.viewPoints.slice(0, 20)) {
      L.push(`  [${fmtTime(v.from)}-${fmtTime(v.to)}] ${v.content}`);
    }
  }

  // ── 二手信号：评论 ──
  if (m.comments.length) {
    L.push(`\n【高赞评论（二手信号，不是视频内容）】`);
    for (const c of m.comments.slice(0, 12)) {
      L.push(`  👍${c.like} ${c.user}：${c.message.slice(0, 160)}`);
    }
  }

  // ── 二手信号：弹幕 ──
  if (m.danmaku.length) {
    // 弹幕噪声很大：刷屏复读、颜文字、求资料广告都会混进来。
    // 这里做「去重 + 过滤 + 均匀抽样」，给模型看的是有代表性的观众反应，
    // 而不是前 30 条恰好都是刷屏。
    const seen = new Set();
    const cleaned = [];
    for (const d of m.danmaku) {
      const t = String(d.text || '').trim();
      if (!t || t.length > 60) continue;
      // 只保留含中文/字母的（挡掉纯符号/颜文字）
      if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) continue;
      // 去掉与「求资料/报班/私信」相关的广告噪音
      if (/讲义|报班|资料|私信|小号|加微|领取|公众号/.test(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      cleaned.push(d);
    }
    if (cleaned.length) {
      // 按时间排序后再均匀采样：接口返回顺序大致是「按时间」但夹杂热门/置顶，
      // 不排序直接取前 N 条会全集中在开头几秒（实测全是 00:00 的弹幕）。
      cleaned.sort((a, b) => a.t - b.t);
      L.push(`\n【弹幕抽样（观众反应，二手信号；已去重去广告，共 ${cleaned.length} 条，按时间均匀取 20）】`);
      const step = Math.max(1, Math.floor(cleaned.length / 20));
      const picked = [];
      for (let i = 0; i < cleaned.length && picked.length < 20; i += step) picked.push(cleaned[i]);
      for (const d of picked) L.push(`  [${fmtTime(d.t / 1000)}] ${d.text}`);
    }
  }

  // ── 关键词 ──
  if (m.topTerms.length) {
    L.push(`\n【观众讨论高频词】${m.topTerms.map((t) => `${t.term}(${t.count})`).join('、')}`);
  }

  return L.join('\n');
}
