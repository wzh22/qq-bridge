// 长期语料采集编排器：到截止时间前，轮换调用已验证可用的三个采集脚本。
//
// 设计原则：**不重新实现采集逻辑**，只做调度——采集细节留在各自的 collect-*.mjs 里，
// 那边已经验证过能跑通，重写一遍只会引入新 bug（第一版就因为 searchVideos 返回
// {list} 而不是数组，白跑了 3 轮）。
//
// 用法：node longrun.mjs --until "2026-10-25T11:30:00+08:00"
import { spawn } from 'node:child_process';
import { runtimeDir, ROOT } from '../scripts/corpus-paths.mjs';
import { writeFileSync, appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { searchVideos } from '../../src/bilibili.js';

const DIR = runtimeDir();
const LOG = `${DIR}\\longrun.log`;
mkdirSync(DIR, { recursive: true });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const until = new Date(arg('until', '2026-10-25T11:30:00+08:00'));
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeLeft = () => until.getTime() - Date.now();

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n', 'utf8');
}

// 子进程跑完一个采集脚本，返回 { code, out }
function runScript(script, args) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [`${DIR}\\${script}`, ...args], {
      cwd: ROOT,
      windowsHide: true,
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d.toString('utf8'); });
    cp.stderr.on('data', (d) => { out += d.toString('utf8'); });
    cp.on('close', (code) => resolve({ code, out: out.trim() }));
    cp.on('error', (e) => resolve({ code: -1, out: String(e.message) }));
  });
}

// ── 轮换表 ──
const TIEBA_FORUMS = [
  ['孙笑川'], ['李毅'], ['抗压背锅'], ['考研'], ['弱智吧'],
  ['我的世界'], ['杀戮尖塔'], ['跑步', '健身'], ['西安'], ['大学生'],
  ['陕西师范大学'], ['长安大学'], ['西安电子科技大学'], ['西安交通大学'],
  ['内向'], ['职场'], ['生活'], ['情感'], ['原神'], ['steam'],
  ['单机游戏'], ['电影'], ['美食'], ['摄影'], ['猫'], ['汽车'],
  ['警察'], ['公务员'], ['求职'], ['宿舍'], ['高考'], ['英语'],
  ['编程'], ['键盘'], ['手机'], ['电脑'], ['足球'], ['篮球'],
];

const BILI_KEYWORDS = [
  '大学生日常', '宿舍 搞笑', '考研 上岸', '警校 公安 联考', '西安 生活',
  '我的世界 生电', '杀戮尖塔', '大学生 期末', '食堂', '早八',
  '期末 破防', '实习 打工', '校园 恋爱', '跑步 健身', '外卖',
  'AI 提问', 'deepseek', '游戏 吐槽', '沙雕 视频', '社恐',
  '打工人 日常', '毕业', '考公', '健身房', '夜跑',
];

let tiebaIdx = 0;
let biliIdx = 0;
let xhsRound = 0;
let biliQueue = [];
const totals = { tiebaRuns: 0, biliRuns: 0, xhsRuns: 0, failures: 0, biliSkippedDup: 0 };

// 已抓过的 BV 号。不同关键词的搜索结果高度重叠（实测 29 个唯一视频被抓了 47 次，
// 其中 18 个被抓 2~3 次），重复抓取不只是浪费配额：热门视频弹幕本来就多，
// 重复计入相当于给它加权 2~3 倍，让词频和句长分布系统性偏向头部视频。
// 用 Set 记住已抓的，跨关键词、跨轮次都生效。
const BILI_SEEN_FILE = `${DIR}\\bili-seen.json`;
const biliSeen = new Set();
try {
  if (existsSync(BILI_SEEN_FILE)) {
    for (const bv of JSON.parse(readFileSync(BILI_SEEN_FILE, 'utf8'))) biliSeen.add(bv);
  }
} catch { /* 文件损坏就当作空集，不影响采集 */ }
function saveBiliSeen() {
  try { writeFileSync(BILI_SEEN_FILE, JSON.stringify([...biliSeen]), 'utf8'); } catch { /* 落盘失败不阻断 */ }
}

// 清理多余标签页。
// 背景：collect-xhs-home.mjs 的 finally closeTab 偶发静默失败（closeTab 内部 catch 掉了），
// 标签页会一屏屏累积，最后把 CDP 拖到 Page.enable / Runtime.evaluate 超时——
// 之前踩过一次，整批采集全废。所以每轮开始前兜底扫一遍。
async function sweepTabs() {
  try {
    const ls = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(5000) })).json();
    const pages = (Array.isArray(ls) ? ls : []).filter((t) => t.type === 'page');
    if (pages.length <= 1) return;
    // 保留一个贴吧页（采集器自己会新开），其余全关
    const keep = pages.find((t) => String(t.url).includes('tieba.baidu.com')) || pages[0];
    let closed = 0;
    for (const p of pages) {
      if (p.id === keep.id) continue;
      try {
        await fetch(`http://127.0.0.1:9222/json/close/${p.id}`, { signal: AbortSignal.timeout(5000) });
        closed += 1;
      } catch { /* 单个关不掉不影响 */ }
    }
    if (closed) log(`清理标签页：关闭 ${closed} 个，保留 1 个`);
  } catch (e) {
    log(`清理标签页失败（忽略）：${e.message}`);
  }
}

// ── 贴吧 ──
async function stepTieba() {
  const forums = TIEBA_FORUMS[tiebaIdx % TIEBA_FORUMS.length].join(',');
  tiebaIdx += 1;
  log(`贴吧 → ${forums}`);
  const { code, out } = await runScript('collect-tieba.mjs', [
    '--forums', forums, '--threads', '2', '--floors', '25', '--max', '4',
    '--out', `tieba-auto-${stamp()}.json`,
  ]);
  const tail = out.split('\n').filter((l) => l.trim()).slice(-2).join(' | ');
  if (code === 0) { totals.tiebaRuns += 1; log(`贴吧 ✓ ${tail}`); }
  else { totals.failures += 1; log(`贴吧 ✗ exit=${code} ${tail}`); }
}

// ── B站 ──
async function stepBili() {
  if (!biliQueue.length) {
    // 搜索并挑出没抓过的。搜索结果的头部常年是同一批热门视频，
    // 所以一个关键词里的条目可能全都抓过了——这时换下一个关键词，
    // 而不是硬抓重复的。
    //
    // 两个实测量级的坑：
    //  1. searchVideos 一页实际返回 17~20 条，原来只取 slice(0,10) 白扔一半。
    //     现在全取，一个关键词能挖出更多没抓过的。
    //  2. 已经抓过 29 个视频后，前三个关键词全都是「未抓过 0 个」——
    //     因为 B 站搜索结果首页就那么几十个热门，早被扫光了。
    //     所以必须翻页（page 2、3）而不是死磕 page 1，否则采集会卡死在零产出。
    // 最多连试 6 次（够两个关键词各翻两页）：全空说明这批关键词确实挖干了，
    // 跳过本轮比无限空转安全。
    for (let tries = 0; tries < 6 && !biliQueue.length; tries += 1) {
      const kw = BILI_KEYWORDS[biliIdx % BILI_KEYWORDS.length];
      // 同一个关键词先看第 1 页，不够再看第 2 页
      const page = Math.floor(tries / 2) + 1;
      biliIdx += 1;
      log(`B站搜索 → ${kw}（第 ${page} 页）`);
      try {
        const res = await searchVideos(kw, { page });
        const list = Array.isArray(res) ? res : (res?.list || []);
        // 不再截断到 10：接口给多少要多少
        const all = list.map((v) => v.bvid).filter(Boolean);
        const fresh = all.filter((bv) => !biliSeen.has(bv));
        totals.biliSkippedDup += all.length - fresh.length;
        log(`B站搜索 ← 返回 ${all.length} 个，未抓过 ${fresh.length} 个`);
        biliQueue = fresh;
      } catch (e) {
        totals.failures += 1;
        log(`B站搜索 ✗ ${e.message}`);
        return;
      }
      if (!biliQueue.length) await sleep(2000);
    }
    if (!biliQueue.length) { log('B站 连续 6 次搜索都是已抓内容，跳过本轮'); return; }
    await sleep(2500);
  }
  const bvs = biliQueue.splice(0, 4);
  for (const bv of bvs) biliSeen.add(bv);
  saveBiliSeen();
  log(`B站 → ${bvs.join(',')}`);
  const { code, out } = await runScript('collect-bili.mjs', [
    '--bvs', bvs.join(','), '--comments', '30', '--segs', '4',
    '--out', `bili-auto-${stamp()}.json`,
  ]);
  const tail = out.split('\n').filter((l) => l.trim()).slice(-1)[0] || '';
  if (code === 0) { totals.biliRuns += 1; log(`B站 ✓ ${tail}`); }
  else { totals.failures += 1; log(`B站 ✗ exit=${code} ${tail}`); }
}

// ── 小红书 ──
async function stepXhs() {
  xhsRound += 1;
  log(`小红书 → 第 ${xhsRound} 轮`);
  const { code, out } = await runScript('collect-xhs-home.mjs', [
    '--rounds', '5', '--out', `xhs-auto-${stamp()}.json`,
  ]);
  const tail = out.split('\n').filter((l) => l.trim()).slice(-1)[0] || '';
  if (code === 0) { totals.xhsRuns += 1; log(`小红书 ✓ ${tail}`); }
  else { totals.failures += 1; log(`小红书 ✗ exit=${code} ${tail}`); }
}

// ── 主循环 ──
log(`=== 长期采集启动，截止 ${until.toLocaleString('zh-CN', { hour12: false })} ===`);
let round = 0;
while (timeLeft() > 0) {
  round += 1;
  const mins = Math.round(timeLeft() / 60000);
  log(`--- 第 ${round} 轮，剩余 ${mins} 分钟 ---`);
  await sweepTabs();
  // 比例：贴吧 2 : B站 2 : 小红书 1
  const step = round % 5;
  try {
    if (step === 1 || step === 3) await stepTieba();
    else if (step === 2 || step === 4) await stepBili();
    else await stepXhs();
  } catch (e) {
    totals.failures += 1;
    log(`本轮异常：${e.message}`);
  }
  writeFileSync(`${DIR}\\longrun-progress.json`, JSON.stringify({
    updatedAt: new Date().toISOString(), round, totals, until: until.toISOString(),
  }, null, 2), 'utf8');
  if (timeLeft() > 0) await sleep(15000 + Math.floor(Math.random() * 15000));
}
log(`=== 采集结束 === ${JSON.stringify(totals)}`);
