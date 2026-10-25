// 小红书搜索页采集（只读）：CDP 打开搜索页，读渲染后的卡片标题/作者/点赞。
import { connectCdp, openCdpSession } from '../../src/tieba.js';
import { runtimeDir } from '../scripts/corpus-paths.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIR = runtimeDir();

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const keywords = String(arg('kw', '校园生活')).split(',').map((s) => s.trim()).filter(Boolean);
const out = arg('out', 'xhs-batch1.json');

const cdp = await connectCdp(PORT);
const tab = await cdp.openTab('about:blank');
const session = await openCdpSession(tab.webSocketDebuggerUrl);

const results = [];
try {
  for (const kw of keywords) {
    const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&source=web_explore_feed`;
    await session.send('Page.navigate', { url });
    await sleep(5500);
    // 检查是否登录墙
    const state = await session.evaluate(`(() => {
      const t = document.body?.innerText || '';
      return { loginWall: /扫码登录|手机号登录/.test(t) && !/note-item/.test(document.body.className||''), len: t.length };
    })()`);
    // 滚动加载
    for (let i = 0; i < 3; i++) { await session.evaluate('window.scrollBy(0, window.innerHeight)'); await sleep(1600); }
    const cards = await session.evaluate(`(() => {
      const out = [];
      document.querySelectorAll('section.note-item, [class*="note-item"]').forEach((el, i) => {
        if (i >= 60) return;
        const title = (el.querySelector('[class*="title"], .title')?.innerText || '').replace(/\\s+/g,' ').trim();
        const author = (el.querySelector('[class*="author"], [class*="name"], [class*="user"]')?.innerText || '').replace(/\\s+/g,' ').trim();
        const like = (el.querySelector('[class*="like"]')?.innerText || '').replace(/\\s+/g,' ').trim();
        const full = (el.innerText || '').replace(/\\s+/g,' ').trim();
        if (full) out.push({ title, author, like, full: full.slice(0, 200) });
      });
      return out;
    })()`);
    console.log(`【${kw}】卡片 ${cards.length} 张 (loginWall=${state.loginWall})`);
    for (const c of cards.slice(0, 8)) console.log(`   · ${c.title || c.full.slice(0, 40)}`);
    results.push({ keyword: kw, cards });
  }
} finally {
  session.close();
  await cdp.closeTab(tab.id);
}

mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}\\${out}`, JSON.stringify(results, null, 2), 'utf8');
const total = results.reduce((n, r) => n + r.cards.length, 0);
console.log('---');
console.log(`完成：${results.length} 个关键词 / ${total} 张卡片`);
