// 小红书首页推荐流采集（只读）。
// 现状：搜索页与笔记详情页都要求登录，但 explore 首页推荐流免登录可读。
// 因此只能采「卡片标题 + 作者 + 点赞」——但标题恰好是小红书文案风格最集中的地方。
import { connectCdp, openCdpSession } from '../../src/tieba.js';
import { runtimeDir } from '../scripts/corpus-paths.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = runtimeDir();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const rounds = Number(arg('rounds', '6'));
const out = arg('out', 'xhs-home.json');

const cdp = await connectCdp(9222);
const tab = await cdp.openTab('https://www.xiaohongshu.com/explore');
const session = await openCdpSession(tab.webSocketDebuggerUrl);

const seen = new Map();
try {
  await sleep(6000);
  for (let r = 0; r < rounds; r++) {
    // 滚动若干屏
    for (let i = 0; i < 4; i++) {
      await session.evaluate('window.scrollBy(0, window.innerHeight)');
      await sleep(1500);
    }
    const cards = await session.evaluate(`(() => {
      const out = [];
      document.querySelectorAll('section.note-item, [class*="note-item"]').forEach((el) => {
        const title = (el.querySelector('[class*="title"], .title')?.innerText || '').replace(/\\s+/g, ' ').trim();
        const author = (el.querySelector('[class*="author"], [class*="name"]')?.innerText || '').replace(/\\s+/g, ' ').trim();
        const like = (el.querySelector('[class*="like"]')?.innerText || '').replace(/\\s+/g, ' ').trim();
        const href = el.querySelector('a[href*="/explore/"], a[href*="/search_result/"]')?.getAttribute('href') || '';
        if (title) out.push({ title, author, like, href });
      });
      return out;
    })()`);
    let added = 0;
    for (const c of cards) {
      // 取不到标题的卡片会被 innerText 拼成字符串 "undefined"，必须挡掉：
      // 早期版本漏过滤，4 条 "undefined" 被当成真实标题进了语料统计。
      const t = String(c?.title ?? '').trim();
      if (!t || t === 'undefined' || t === 'null') continue;
      const key = t + '|' + String(c?.author ?? '').trim();
      if (!seen.has(key)) { seen.set(key, { ...c, title: t }); added += 1; }
    }
    console.log(`第 ${r + 1} 轮：本屏 ${cards.length} 张，新增 ${added}，累计 ${seen.size}`);
    // 刷新换一批推荐
    await session.evaluate('window.scrollTo(0, 0)');
    await sleep(800);
    await session.send('Page.reload', { ignoreCache: false });
    await sleep(5000);
  }
} finally {
  session.close();
  await cdp.closeTab(tab.id);
}

const results = [...seen.values()];
mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}\\${out}`, JSON.stringify(results, null, 2), 'utf8');
console.log('---');
console.log(`完成：${results.length} 条标题，已写入 ${out}`);
