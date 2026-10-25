// 百度贴吧只读客户端。
//
// ── 设计原则（2026-10-25 实测定稿）────────────────────────────────────
//
//  ① **只读**。本文件不实现发帖、回帖、点赞、关注、收藏等任何写操作。
//     理由与 bilibili.js 同：QQ 机器人会在群里自主决定「我想学点什么」，
//     把写操作交给一个概率模型去操作真账号，等于把不可逆副作用外包给随机性。
//     所以这里只给「读」，一个写操作都不给。
//
//  ② **为什么必须走 CDP，而不是直接 fetch。**
//     实测（2026-10-25，西安电信 1.85.244.160）：tieba.baidu.com 对普通 HTTP 客户端
//     返回 403 + 百度 BIOC 人机验证页（window.BIOC_OPTIONS / subid=tb_pc_pb_bfe）。
//       - 换 UA / 完整浏览器头部 / 移动端 UA / 走代理   → 全部 403
//       - 先访问 baidu.com 拿 BAIDUID cookie 再请求      → 200 但只是 11060 字节空壳页
//       - curl、Invoke-WebRequest、node fetch          → 全部 403
//       - Edge --headless=new --dump-dom（含隐藏自动化特征）→ 百度安全验证
//     而**真实浏览器**能正常访问（用户可登录贴吧）。所以唯一不涉及「破解反爬」的
//     正当路径是：复用用户**自己**已经通过人机验证的浏览器会话。
//     Chrome DevTools Protocol 正是官方的调试接口，读的是渲染后的 DOM，
//     不解析、不伪造、不绕过任何验证 —— 验证由用户自己的浏览器正常完成。
//
//  ③ **强制只读的实现方式**：CDP 侧只调用 `Page.navigate` + `Runtime.evaluate`
//     读取 DOM，从不模拟点击「发帖」，也不携带任何写请求。
//
//  ④ **域名白名单**。只允许 tieba.baidu.com / www.baidu.com，避免本模块被当成
//     任意 URL 抓取器（那是 safe-fetch.js 的职责，它有 SSRF 防护）。
//
//  ⑤ **限速**。贴吧对高频访问会返回验证页；所有导航串行 + 间隔，并检测挑战页
//     后自动退避，绝不无限重试。

import fs from 'node:fs';
import path from 'node:path';
import { truncateText } from './md-to-plain.js';

export const TIEBA_HOSTS = ['tieba.baidu.com', 'www.baidu.com', 'tieba.com'];

/** 单条回复/正文的最大长度，防止超长楼层撑爆提示词。 */
export const POST_TEXT_MAX = 600;
export const TITLE_MAX = 120;

/** 导航间隔（毫秒）。贴吧对连续导航敏感，实测 1200ms 以上较稳。 */
const NAV_INTERVAL_MS = 1400;

function hostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  return TIEBA_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));
}

// ── CDP 最小客户端 ────────────────────────────────────────────────────
//
// 不引第三方依赖：Node 22+ 自带 WebSocket（全局 WebSocket 从 Node 21 起可用）。
// 这里只实现本模块用到的三个 Domain：Page / Runtime / Target。

/**
 * 连接到已经在运行的 Edge/Chrome 调试端点。
 * @param {number} port 默认 9222
 * @returns {Promise<{send:Function, close:Function, tabs:Function, openTab:Function, version:any}>}
 */
export async function connectCdp(port = 9222) {
  const base = `http://127.0.0.1:${port}`;
  let version;
  try {
    version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(6000) })).json();
  } catch (error) {
    throw new Error(
      `连不上浏览器调试端口 ${port}：${error?.message ?? error}。` +
      '请确认浏览器以 --remote-debugging-port=' + port + ' 启动（见 start-tieba-browser.ps1）。'
    );
  }

  const tabs = async () => {
    const list = await (await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(6000) })).json();
    return Array.isArray(list) ? list.filter((t) => t.type === 'page') : [];
  };

  const openTab = async (url = 'about:blank') => {
    const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`新建标签页失败：HTTP ${res.status}`);
    return res.json();
  };

  const closeTab = async (id) => {
    try {
      await fetch(`${base}/json/close/${id}`, { signal: AbortSignal.timeout(6000) });
    } catch { /* 关闭失败不影响主流程 */ }
  };

  return { base, version, tabs, openTab, closeTab };
}

/**
 * 在某个标签页上开一个 CDP 会话。
 * @param {string} wsUrl 标签页的 webSocketDebuggerUrl
 */
export async function openCdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? 'CDP 错误'} (${msg.error.code ?? '?'})`));
      else p.resolve(msg.result);
    }
  });

  await new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('CDP WebSocket 连接失败')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('CDP WebSocket 连接超时')); }, 10000);
    function cleanup() { clearTimeout(timer); ws.removeEventListener('open', onOpen); ws.removeEventListener('error', onErr); }
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onErr);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { pending.delete(id); reject(e); }
    // 单条命令超时：避免某个 hang 住的导航把整轮学习卡死
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 命令超时：${method}`)); }
    }, 30000);
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面脚本异常：${d.text ?? ''} ${d.exception?.description ?? ''}`.trim());
    }
    return r.result?.value;
  };

  const close = () => { try { ws.close(); } catch {} };

  return { send, evaluate, close };
}

// ── 导航与挑战页检测 ──────────────────────────────────────────────────

/** 检测是否为百度人机验证页。命中时应停止抓取并提示用户手动过一次验证。 */
export function isChallengePage(html) {
  const s = String(html ?? '');
  return /百度安全验证|BIOC_OPTIONS|wappass\.baidu\.com\/static\/captcha/.test(s);
}

/**
 * 在标签页里导航到某个 URL 并等待渲染完成。
 * @returns {Promise<{url:string,title:string,challenge:boolean,htmlLength:number}>}
 */
export async function navigate(session, url, { waitMs = 4200, timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  if (!hostAllowed(u.hostname)) throw new Error(`域名不在白名单内：${u.hostname}`);
  if (u.protocol !== 'https:') throw new Error(`只允许 https：${url}`);

  await session.send('Page.enable');
  await session.send('Page.navigate', { url });

  // 等待 document.readyState === 'complete' 或超时
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      const state = await session.evaluate('document.readyState');
      if (state === 'complete') {
        last = state;
        // 再给 SPA 一点渲染时间
        await new Promise((r) => setTimeout(r, Math.max(0, waitMs - 600)));
        break;
      }
    } catch { /* 导航中取不到，继续等 */ }
  }

  const info = await session.evaluate(`JSON.stringify({
    url: location.href,
    title: document.title || '',
    len: document.documentElement ? document.documentElement.outerHTML.length : 0,
    challenge: /百度安全验证|BIOC_OPTIONS/.test(document.documentElement ? document.documentElement.outerHTML : '')
  })`);
  const parsed = JSON.parse(info || '{}');
  return {
    url: parsed.url || url,
    title: parsed.title || '',
    challenge: Boolean(parsed.challenge),
    htmlLength: Number(parsed.len) || 0,
    readyState: last || 'unknown'
  };
}

// ── 页面解析 ──────────────────────────────────────────────────────────
//
// 解析全部在页面内用 JS 完成（Runtime.evaluate 返回结构化 JSON），
// 不在 Node 侧解析 HTML —— 贴吧是重度前端渲染，服务端只给骨架。

// ⚠️ 这里必须用 String.raw。
//
// 踩过的坑（两次，都是**静默失败**——不报错，只是数据悄悄变脏）：
//  1. 解析器原本写在普通模板字符串里，`split('\\n')` / `/^第\\d+楼$/` 被 JS 吃掉一层
//     反斜杠，到了页面里 regex 变成 /^第d+楼$/（匹配 "第d楼" 而非 "第3楼"），
//     楼层解析静默返回 0 条。
//  2. 早先按 innerText 切行猜结构，反复在「正文 / 楼中楼 / 作者名」边界上出错：
//     楼中楼作者名混进正文、正文吞掉楼中楼、MM-DD 日期未识别……
//     根因是 innerText 把不同层次压成同一串文本，边界信息已经丢失，再怎么补正则都是猜。
//
// 现在改成**元素级解析**（2026-10-25 实测 DOM）：
//   .pb-comment-item                       每个楼层
//     .head-line.user-info a.head-name     纯作者名（等级在相邻 span，不会混入）
//     .pb-rich-text                        纯净正文（长文/多段都在里面）
//     .comment-desc-left > span            [第N楼, 日期, IP属地]
//     .pb-lzl-item × N                     楼中楼，内部同样有 a.head-name + .pb-rich-text
//     .show-more-lzl                       「展开 N 条回复」
// 元素选择天然带边界，不再需要猜。
const THREAD_EXTRACTOR = String.raw`(() => {
  const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const txt = (el) => (el ? clean(el.innerText) : '');
  const DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}|\d+分钟前|\d+小时前|\d+秒前|刚刚|\d+天前|昨天|今天|前天)$/;

  const items = Array.from(document.querySelectorAll('.pb-comment-item'));
  const out = [];
  for (const it of items) {
    // 作者：a.head-name 只含昵称
    let author = txt(it.querySelector('.head-line.user-info a.head-name'));
    if (!author) author = clean(txt(it.querySelector(':scope > .head-line.user-info')).split(/\s+/)[0] || '');

    // 正文：只取**本楼直属**的 .pb-rich-text。
    // 楼层内部还嵌着楼中楼（.pb-lzl-item 里也有 .pb-rich-text），
    // 不加 :scope 限定会把楼中楼正文当成楼主正文。
    const contentEl = it.querySelector(':scope > .comment-content > .pb-rich-text')
      || it.querySelector(':scope > .comment-content .pb-rich-text');
    const content = txt(contentEl);

    // 楼层元数据：[第N楼, 日期, IP属地]
    const descSpans = Array.from(it.querySelectorAll(
      ':scope > .comment-content > .pc-pb-comments-desc > .comment-desc-left > span'
    )).map((e) => clean(e.innerText)).filter(Boolean);
    let floor = '';
    let date = '';
    let region = '';
    for (const d of descSpans) {
      if (/^第\d+楼$/.test(d)) { floor = d.replace(/\D/g, ''); continue; }
      if (DATE.test(d)) { date = d; continue; }
      if (!region && d.length <= 10) region = d;
    }

    // 楼中楼：每条 .pb-lzl-item 结构与本楼一致，直接取它的 .pb-rich-text
    // ⚠️ 纯数字（如 "3"）是**赞数**不是回复内容：贴吧在没有文字回复时会把点赞数
    //    渲染进 .pb-rich-text，早期不过滤导致语料里混进一堆 "3"。
    const replies = [];
    for (const lzl of it.querySelectorAll('.pb-lzl-item')) {
      const r = txt(lzl.querySelector('.pb-rich-text'));
      if (!r || r.length > 500) continue;
      if (/^\d+$/.test(r)) continue;
      replies.push(r);
    }

    if (!content) continue;  // 纯图片楼（无文字正文）跳过，别拿楼中楼作者名凑数
    out.push({ author, content, floor, date, region, replies });
    if (out.length >= __MAX__) break;
  }

  // 标题：优先主标题元素，其次 document.title（去掉「-百度贴吧」后缀）
  const h1 = document.querySelector('h1, .core_title_txt, [class*="thread-title"], .pb-title');
  let title = clean(h1 ? h1.innerText : '');
  if (!title) title = clean(document.title).replace(/[-_]百度贴吧$/, '');
  const forumName = clean((document.querySelector('[class*="forum-name"], .card_title_fname') || {}).innerText || '');
  return JSON.stringify({ title, forumName, floors: out, total: items.length });
})()`;

/**
 * 从帖子页提取楼层（楼主 + 回复）。
 * 结构（2026-10-25 实测）：每条楼层是 .pb-comment-item，
 * innerText 形如 [作者, 等级, 正文, 第N楼, 日期, IP属地, 赞数, 回复, ...楼中楼...]
 */
export async function extractThread(session, { maxFloors = 30 } = {}) {
  const expr = THREAD_EXTRACTOR.replace('__MAX__', String(Math.max(1, maxFloors)));
  const raw = await session.evaluate(expr);
  const data = JSON.parse(raw || '{}');
  return {
    title: truncateText(data.title || '', TITLE_MAX),
    forumName: data.forumName || '',
    total: Number(data.total) || 0,
    floors: Array.isArray(data.floors) ? data.floors.map((f) => ({
      author: truncateText(f.author, 40),
      content: truncateText(f.content, POST_TEXT_MAX),
      floor: f.floor,
      date: f.date,
      region: f.region,
      replies: (f.replies || []).map((r) => truncateText(r, 200)).filter(Boolean).slice(0, 20)
    })) : []
  };
}

/**
 * 从吧列表页提取帖子条目。
 */
const LIST_EXTRACTOR = String.raw`(() => {
  const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();

  // ⚠️ 2026-10-25 实测：贴吧列表页已改成卡片式布局（.thread-card-wrapper），
  //    旧的 'a.j_th_tit' / '.threadlist_title a' 选择器**一个都匹配不到**。
  //    而 a.thread-content-link 的 innerText 是整块卡片文本，形如：
  //      「作者 等级 回复于N分钟前 关注 标题 7 370 871」
  //    直接当标题用会把作者、等级、关注按钮全混进去。
  //    正确的标题在 .thread-title > .tb-richtext > span.text。
  const cards = Array.from(document.querySelectorAll('.thread-card-wrapper'));

  const pickTitle = (card) => {
    const t = card.querySelector('.thread-title .tb-richtext, .thread-title');
    let s = t ? clean(t.innerText) : '';
    if (!s) {
      // 兜底：拿内容链接的文本，但剥掉头部那一段
      const a = card.querySelector('a.thread-content-link');
      s = a ? clean(a.innerText) : '';
      const head = card.querySelector('.head-line');
      const headTxt = head ? clean(head.innerText) : '';
      if (headTxt && s.startsWith(headTxt)) s = clean(s.slice(headTxt.length));
    }
    // 去掉尾部的统计数字（阅读/回复/点赞），它们会粘在标题后面
    return s.replace(/\s+\d+\s+\d+\s+\d+\s*$/, '').trim();
  };

  const pickAuthor = (card) => clean((card.querySelector('a.head-name, .head-name') || {}).innerText || '');

  const pickStats = (card) => {
    const nums = Array.from(card.querySelectorAll('.action-bar-warp .item-warp, .action-bar-warp .action-number'))
      .map((e) => clean(e.innerText)).filter((x) => /^\d+$/.test(x)).slice(0, 3);
    return { reply: Number(nums[0]) || 0, like: Number(nums[2]) || 0 };
  };

  for (const card of cards) {
    const a = card.querySelector('a.thread-content-link[href*="/p/"]') || card.querySelector('a[href*="/p/"]');
    if (!a) continue;
    const m = (a.getAttribute('href') || '').match(/\/p\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    const title = pickTitle(card);
    if (!title || title.length < 4) continue;
    seen.add(id);
    const st = pickStats(card);
    out.push({
      id,
      title,
      author: pickAuthor(card),
      reply: st.reply,
      like: st.like,
      url: 'https://tieba.baidu.com/p/' + id
    });
    if (out.length >= __MAX__) break;
  }

  // 保住旧版布局的兜底路径（万一灰度回去）
  if (!out.length) {
    const links = Array.from(document.querySelectorAll('a.j_th_tit, .threadlist_title a'));
    for (const a of links) {
      const m = (a.getAttribute('href') || '').match(/\/p\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      const title = clean(a.innerText);
      if (title.length < 4) continue;
      seen.add(m[1]);
      out.push({ id: m[1], title, author: '', reply: 0, like: 0, url: 'https://tieba.baidu.com/p/' + m[1] });
      if (out.length >= __MAX__) break;
    }
  }

  const forumName = clean(
    (document.querySelector('.card_title_fname, .forum-name, [class*="forum-title"]') || {}).innerText ||
    document.title.replace(/[-_]百度贴吧.*$/, '') || ''
  );
  return JSON.stringify({ forumName, threads: out });
})()`;

export async function extractThreadList(session, { max = 30 } = {}) {
  const expr = LIST_EXTRACTOR.replace('__MAX__', String(Math.max(1, max)));
  const raw = await session.evaluate(expr);
  const data = JSON.parse(raw || '{}');
  return {
    forumName: data.forumName || '',
    threads: Array.isArray(data.threads) ? data.threads.map((t) => ({
      id: String(t.id),
      title: truncateText(t.title, TITLE_MAX),
      author: truncateText(t.author || '', 40),
      reply: Number(t.reply) || 0,
      like: Number(t.like) || 0,
      url: String(t.url)
    })) : []
  };
}

// ── 对外高层 API ──────────────────────────────────────────────────────

/**
 * 抓取一个贴吧的帖子列表。
 * @param {string} kw 吧名（中文，不需要带“吧”）
 */
export async function fetchForumThreads(kw, opts = {}) {
  const name = String(kw ?? '').replace(/吧$/, '').trim();
  if (!name) throw new Error('吧名不能为空');
  const port = Number(opts.port) || 9222;
  const cdp = await connectCdp(port);
  const tab = await cdp.openTab('about:blank');
  const session = await openCdpSession(tab.webSocketDebuggerUrl);
  try {
    const nav = await navigate(session, `https://tieba.baidu.com/f?kw=${encodeURIComponent(name)}`, opts);
    if (nav.challenge) {
      return { ok: false, reason: 'challenge', forumName: name, threads: [], detail: '贴吧要求人机验证，请在浏览器窗口里手动过一次验证后重试。' };
    }
    const list = await extractThreadList(session, opts);
    return { ok: true, reason: 'ok', forumName: list.forumName || name, threads: list.threads };
  } finally {
    session.close();
    await cdp.closeTab(tab.id);
  }
}

/**
 * 抓取一个主题帖的楼层。
 * @param {string|number} postId 帖子数字 id
 */
export async function fetchThread(postId, opts = {}) {
  const id = String(postId ?? '').match(/(\d{5,})/)?.[1];
  if (!id) throw new Error(`无法识别的帖子 id：${postId}`);
  const port = Number(opts.port) || 9222;
  const cdp = await connectCdp(port);
  const tab = await cdp.openTab('about:blank');
  const session = await openCdpSession(tab.webSocketDebuggerUrl);
  try {
    const nav = await navigate(session, `https://tieba.baidu.com/p/${id}`, opts);
    if (nav.challenge) {
      return { ok: false, reason: 'challenge', postId: id, floors: [], detail: '贴吧要求人机验证，请在浏览器窗口里手动过一次验证后重试。' };
    }
    const t = await extractThread(session, opts);
    return { ok: true, reason: 'ok', postId: id, url: nav.url, ...t };
  } finally {
    session.close();
    await cdp.closeTab(tab.id);
  }
}

/**
 * 采集一份「语料包」：若个吧 × 若个帖子的楼层正文，供风格学习。
 * 串行导航（贴吧对并发敏感），失败隔离：单个帖子失败不影响整体。
 *
 * @param {{forums?:string[], threadsPerForum?:number, floorsPerThread?:number, maxThreads?:number, port?:number, onProgress?:Function}} opts
 */
export async function collectCorpus(opts = {}) {
  const forums = (Array.isArray(opts.forums) && opts.forums.length ? opts.forums : ['孙笑川']).map((f) => String(f).replace(/吧$/, '').trim()).filter(Boolean);
  const threadsPerForum = Math.max(1, Math.min(10, Number(opts.threadsPerForum) || 3));
  const floorsPerThread = Math.max(1, Math.min(60, Number(opts.floorsPerThread) || 20));
  const maxThreads = Math.max(1, Math.min(30, Number(opts.maxThreads) || 12));
  const port = Number(opts.port) || 9222;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  const cdp = await connectCdp(port);
  const collected = [];
  const errors = [];
  let threadCount = 0;
  let challengeHit = false;

  const tab = await cdp.openTab('about:blank');
  const session = await openCdpSession(tab.webSocketDebuggerUrl);

  try {
    for (const forum of forums) {
      if (threadCount >= maxThreads || challengeHit) break;
      onProgress?.({ phase: 'forum', forum });

      let list;
      try {
        const nav = await navigate(session, `https://tieba.baidu.com/f?kw=${encodeURIComponent(forum)}`, opts);
        if (nav.challenge) {
          challengeHit = true;
          errors.push({ stage: 'forum', forum, error: '人机验证' });
          break;
        }
        list = await extractThreadList(session, { max: threadsPerForum * 3 });
      } catch (error) {
        errors.push({ stage: 'forum', forum, error: String(error?.message ?? error) });
        continue;
      }
      await new Promise((r) => setTimeout(r, NAV_INTERVAL_MS));

      const picked = list.threads.slice(0, threadsPerForum);
      for (const t of picked) {
        if (threadCount >= maxThreads || challengeHit) break;
        onProgress?.({ phase: 'thread', forum, title: t.title, done: threadCount, total: maxThreads });
        try {
          const nav = await navigate(session, t.url, opts);
          if (nav.challenge) {
            challengeHit = true;
            errors.push({ stage: 'thread', forum, id: t.id, error: '人机验证' });
            break;
          }
          const detail = await extractThread(session, { maxFloors: floorsPerThread });
          collected.push({
            forum,
            postId: t.id,
            url: t.url,
            title: detail.title || t.title,
            floors: detail.floors
          });
          threadCount += 1;
        } catch (error) {
          errors.push({ stage: 'thread', forum, id: t.id, error: String(error?.message ?? error) });
        }
        await new Promise((r) => setTimeout(r, NAV_INTERVAL_MS));
      }
      await new Promise((r) => setTimeout(r, NAV_INTERVAL_MS));
    }
  } finally {
    session.close();
    await cdp.closeTab(tab.id);
  }

  return {
    ok: collected.length > 0,
    challenge: challengeHit,
    forums,
    threads: collected,
    threadCount: collected.length,
    errors
  };
}

// ── 风格学习：语料 → 风格特征 ────────────────────────────────────────

/**
 * 把语料包压成「发给模型做风格分析」的纯文本。
 * 只保留真人发的内容（作者 + 正文 + 楼中楼短回复），去掉导航/按钮/等级标签。
 */
export function renderCorpusForLearning(corpus, { maxChars = 12000 } = {}) {
  const parts = [];
  let total = 0;
  for (const t of corpus?.threads || []) {
    const lines = [];
    lines.push(`【${t.forum}吧】${t.title}`);
    for (const f of t.floors || []) {
      if (f.content) lines.push(`${f.author}：${f.content}`);
      for (const r of f.replies || []) lines.push(`  ${r}`);
      if (total + lines.join('\n').length > maxChars) break;
    }
    const block = lines.join('\n');
    if (total + block.length > maxChars) {
      parts.push(block.slice(0, Math.max(0, maxChars - total)));
      break;
    }
    parts.push(block);
    total += block.length;
  }
  return parts.join('\n\n');
}

/** 统计语料规模，用于判断够不够学。 */
export function corpusStats(corpus) {
  let threads = 0; let floors = 0; let chars = 0; let replies = 0;
  for (const t of corpus?.threads || []) {
    threads += 1;
    for (const f of t.floors || []) {
      floors += 1;
      chars += String(f.content || '').length;
      replies += (f.replies || []).length;
      for (const r of f.replies || []) chars += String(r || '').length;
    }
  }
  return { threads, floors, replies, chars };
}

/**
 * 风格学习的提示词：从语料里提炼「贴吧人怎么说话」。
 * 注意：要求输出结构化风格特征，而不是整段原文照抄 —— 后者会把语料原样灌进
 * 群聊 prompt，既贵又容易让机器人变成复读机。
 */
export function buildStyleLearningPrompt(corpusText, { forumHint = '' } = {}) {
  return `你是中文网络社区语言风格研究员。下面是从百度贴吧真实抓取的帖子与回复语料${forumHint ? `（主要来自「${forumHint}吧」）` : ''}。

请分析**贴吧用户真实的说话方式**，输出可操作的风格特征。不要输出语料原文的复读。

分析维度：
1. 常用语气词与句尾（如：捏、嗷、吧、捏、捏…要按真实出现统计，不要编）
2. 自称与他称（如：鼠鼠、老哥、8u、吧友、lz 等，说明各自的使用场景差异）
3. 高频梗与固定搭配（如"爆金币""cy""打搅"等，说明含义和用法边界）
4. 句式特征（短句为主？反问多？省略号/括号用法？是否常用「绷不住了」式吐槽）
5. 标点与排版习惯（是否用空格断句、emoji 使用密度、脏话的替代写法如"**"）
6. 情绪表达（嘲讽、自嘲、阴阳怪气的具体说法）
7. **明确不该学的**（地域黑、人身攻击、违法违规、极端内容 —— 列出并说明为什么）

要求：
- 每条特征必须能在语料里找到依据；找不到依据的不要写。
- 区分「高频通用」和「特定圈子才用」，后者标注使用条件。
- 输出 JSON，格式：
{
  "toneSummary": "一段话概括整体语感（100字内）",
  "particles": [{"word":"捏","usage":"句尾，表轻松/卖萌","frequency":"高"}],
  "selfReference": [{"word":"鼠鼠","usage":"自嘲式自称，源于吧内文化","when":"吧内语境"}],
  "catchphrases": [{"phrase":"爆金币","meaning":"要求对方给钱/好处，玩梗式索要","usage":"调侃用，真实索要会冒犯"}],
  "sentencePatterns": ["…"],
  "punctuationHabits": ["…"],
  "emotionStyle": ["…"],
  "avoid": ["…"],
  "exampleLines": ["仿写3条符合该风格的短句（不要照抄语料）"]
}

只输出 JSON。

语料：
${corpusText}`;
}

/** 从模型输出里抠 JSON 对象（复用与 slang-learner 相同的稳健策略）。 */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch {}
  if (raw.length > 400_000) return null;
  let attempts = 0;
  for (let i = 0; i < raw.length && attempts < 64; i += 1) {
    if (raw[i] !== '{') continue;
    attempts += 1;
    let depth = 0; let inString = false; let escaped = false;
    for (let j = i; j < raw.length; j += 1) {
      const c = raw[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(i, j + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
          } catch {}
          break;
        }
      }
    }
  }
  return null;
}

/**
 * 把风格档案渲染成注入 QQ 群聊 prompt 的文本块。
 * 与 buildSlangContext 同构，但讲的是「怎么说话」而不是「词是什么意思」。
 */
export function buildStyleContext(profile, { maxItems = 12 } = {}) {
  if (!profile || typeof profile !== 'object') return '';
  const cut = (arr, n = maxItems) => (Array.isArray(arr) ? arr.slice(0, n) : []);
  const lines = [];
  if (profile.toneSummary) lines.push(`整体语感：${truncateText(profile.toneSummary, 300)}`);

  const parts = [];
  const add = (label, items, fmt) => {
    const list = cut(items).map(fmt).filter(Boolean);
    if (list.length) parts.push(`${label}：${list.join('；')}`);
  };
  add('语气词', profile.particles, (x) => (x?.word ? `${x.word}（${truncateText(x.usage || '', 60)}）` : ''));
  add('自称', profile.selfReference, (x) => (x?.word ? `${x.word}（${truncateText(x.usage || '', 60)}）` : ''));
  add('高频梗', profile.catchphrases, (x) => (x?.phrase ? `${x.phrase}=${truncateText(x.meaning || '', 60)}` : ''));
  add('句式', profile.sentencePatterns, (x) => truncateText(String(x ?? ''), 100));
  add('标点习惯', profile.punctuationHabits, (x) => truncateText(String(x ?? ''), 100));
  add('情绪表达', profile.emotionStyle, (x) => truncateText(String(x ?? ''), 100));

  if (!lines.length && !parts.length) return '';
  const body = [...lines, ...parts].join('\n');
  const avoid = cut(profile.avoid, 8).map((x) => truncateText(String(x ?? ''), 100)).filter(Boolean);
  const examples = cut(profile.exampleLines, 3).map((x) => truncateText(String(x ?? ''), 100)).filter(Boolean);

  let out = `【贴吧语言风格】参考贴吧用户的真实说话习惯（是语感参考，不是让你复读；按场合自然使用，别硬堆梗）：\n${body}`;
  if (examples.length) out += `\n参考句式：${examples.join(' / ')}`;
  if (avoid.length) out += `\n不要学：${avoid.join('；')}`;
  return out;
}

// ── 风格档案的持久化 ──────────────────────────────────────────────────

export const STYLE_STATUS = Object.freeze({ CANDIDATE: 'candidate', ACTIVE: 'active', ARCHIVED: 'archived' });

/** 规范化风格档案，裁剪字段长度，防止文件膨胀。 */
export function normalizeStyleProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const clip = (v, n) => truncateText(String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim(), n);
  const arr = (v, n, fn) => (Array.isArray(v) ? v.slice(0, n).map(fn).filter(Boolean) : []);
  // 对象类的词条必须要求「关键词非空」才收，否则模型偶尔返回 {"word":"","usage":"..."}
  // 会在提示词里渲染成「（句尾，轻松）」这种没有主体的残句。
  const words = (v, n, key, fields) => arr(v, n, (x) => {
    if (!x || typeof x !== 'object') return null;
    const k = clip(x[key], 30);
    if (!k) return null;
    const out = { [key]: k };
    for (const [f, len] of fields) { const val = clip(x[f], len); if (val) out[f] = val; }
    return out;
  });
  return {
    id: String(p.id || `style-${Date.now().toString(36)}`),
    toneSummary: clip(p.toneSummary, 300),
    particles: words(p.particles, 20, 'word', [['usage', 100], ['frequency', 10]]),
    selfReference: words(p.selfReference, 15, 'word', [['usage', 100], ['when', 60]]),
    catchphrases: words(p.catchphrases, 25, 'phrase', [['meaning', 120], ['usage', 100]]),
    sentencePatterns: arr(p.sentencePatterns, 15, (x) => clip(x, 150)),
    punctuationHabits: arr(p.punctuationHabits, 12, (x) => clip(x, 120)),
    emotionStyle: arr(p.emotionStyle, 15, (x) => clip(x, 120)),
    avoid: arr(p.avoid, 15, (x) => clip(x, 120)),
    exampleLines: arr(p.exampleLines, 8, (x) => clip(x, 120)),
    status: [STYLE_STATUS.CANDIDATE, STYLE_STATUS.ACTIVE, STYLE_STATUS.ARCHIVED].includes(p.status) ? p.status : STYLE_STATUS.CANDIDATE,
    forums: arr(p.forums, 10, (x) => clip(x, 20)),
    sampleCount: Math.max(0, Number(p.sampleCount) || 0),
    createdAt: String(p.createdAt || new Date().toISOString()),
    updatedAt: String(p.updatedAt || new Date().toISOString())
  };
}

export function loadStyle(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`贴吧风格库读取失败（${error?.code || 'unknown'}）：${error?.message ?? error}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) return null;
  try {
    return normalizeStyleProfile(JSON.parse(text));
  } catch (error) {
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try { fs.writeFileSync(quarantine, text, { encoding: 'utf8', mode: 0o600 }); } catch {}
    throw new Error(`贴吧风格库 JSON 损坏，原文已另存为 ${quarantine}：${error?.message ?? error}`);
  }
}

export function saveStyle(file, profile) {
  const normalized = normalizeStyleProfile(profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return normalized;
}
