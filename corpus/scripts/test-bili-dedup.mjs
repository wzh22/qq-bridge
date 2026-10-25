// B站去重与翻页逻辑自测。
//
// 为什么值得单独测：采集器最容易出现的失效不是崩溃，而是**静默地重复劳动**——
// 进程活着、日志写着「✓ 完成」、文件也在长，但抓回来的全是已经抓过的内容。
// 这种失效在日志上和正常采集长得一模一样，只能靠断言戳穿。
//
// 本次实测到的三件事，每件都写成了断言：
//  1. 29 个唯一视频被抓了 47 次（同一 BV 重复 2~3 次）→ 必须有 biliSeen 拦截
//  2. searchVideos 一页实际返回 17~20 条，原代码 slice(0,10) 白扔一半 → 不得截断
//  3. 抓过 29 个后，前 3 个关键词 page1 全是「未抓过 0 个」→ 必须能翻页
//
// 用法：node corpus/scripts/test-bili-dedup.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runtimeDir, COLLECT_DIR } from './corpus-paths.mjs';

// 两类文件，位置不同，必须分清（这里踩过）：
//   · longrun.mjs（采集器源码）——**已在版本库** corpus/collect/ 下。
//     读它才反映"仓库里的代码长什么样"，也才能在干净 clone 里跑通。
//   · bili-seen.json / bili-auto-*.json（运行时状态与抓回的语料）——
//     在 state/corpus/，天然不入库，没有数据时相关断言应跳过而非失败。
const D = runtimeDir();

// 优先读仓库里的采集器；旧布局（state/corpus/longrun.mjs）作为兜底。
const LONG_RUN = existsSync(path.join(COLLECT_DIR, 'longrun.mjs'))
  ? path.join(COLLECT_DIR, 'longrun.mjs')
  : path.join(D, 'longrun.mjs');
let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const src = readFileSync(LONG_RUN, 'utf8');

console.log('=== 1. 源码层面：去重与翻页必须真的实现，而不只是写了注释 ===');
check('存在持久化的已抓集合 bili-seen.json', /BILI_SEEN_FILE/.test(src) && /bili-seen\.json/.test(src));
check('抓取前用 biliSeen 过滤', /fresh\s*=\s*all\.filter\(\(bv\)\s*=>\s*!biliSeen\.has\(bv\)\)/.test(src));
check('抓取后把 BV 记入集合并落盘', /biliSeen\.add\(bv\)/.test(src) && /saveBiliSeen\(\)/.test(src));
// 这条针对一个具体的历史 bug：slice(0,10) 把接口返回的 17~20 条砍掉一半
check('不再把搜索结果截断到 10 条', !/list\.slice\(0,\s*10\)/.test(src));
check('搜索支持翻页（page 由 tries 推导）', /Math\.floor\(tries\s*\/\s*2\)\s*\+\s*1/.test(src));
check('翻页参数真的传给了 searchVideos', /searchVideos\(kw,\s*\{\s*page\s*\}\)/.test(src));

console.log('\n=== 2. 已抓集合本身必须干净可用 ===');
const seenFile = path.join(D, 'bili-seen.json');
// 第 2/3 组依赖"这台机器采到哪了"的运行时状态（bili-seen.json + bili-auto-*.json）。
// 那些文件天然不入库，所以干净 clone 里必然不存在 ——
// 此时它们不是"失败"，是"没有对象可验"。用 check() 判红会得出
// "clone 下来就红"的仓库，而红的原因是环境缺数据，不是代码坏了。
const hasRuntimeState = existsSync(seenFile);
if (!hasRuntimeState) {
  console.log(`  ⏭  跳过：没有 ${path.basename(seenFile)}（运行时状态不入库）`);
  console.log(`     位置：${D}`);
  console.log('     第 2、3 组需要"本机已采集过什么"的状态才能验证；干净 clone 里没有是正常的。');
  console.log('     有语料的环境（本机采集后）会自动跑这两组。');
} else {
  check('bili-seen.json 存在', true);
  let seen = [];
  try { seen = JSON.parse(readFileSync(seenFile, 'utf8')); } catch (e) { check('可解析为 JSON', false, e.message); }
  check('是数组', Array.isArray(seen));
  check('元素全是 BV 号格式', seen.every((s) => /^BV[0-9A-Za-z]{10}$/.test(String(s))), `异常项: ${seen.filter((s) => !/^BV[0-9A-Za-z]{10}$/.test(String(s))).slice(0, 3)}`);
  check('无重复项', new Set(seen).size === seen.length, `${seen.length} 项中有 ${seen.length - new Set(seen).size} 个重复`);
  check('已播种历史数据（≥29 条）', seen.length >= 29, `实际 ${seen.length} 条`);
}

console.log('\n=== 3. 历史语料里的重复必须真的被集合覆盖 ===');
// 这条是最关键的：集合若漏了历史 BV，采集器就会把那些视频再抓一遍。
// 用真实语料文件反查，而不是相信集合自己说得好听。
if (!hasRuntimeState) {
  console.log('  ⏭  跳过：无运行时状态（同上）');
} else {
  const histBvs = new Set();
  let corpusFileCount = 0;
  for (const f of readdirSync(D)) {
    if (!/^bili-auto-.*\.json$/.test(f)) continue;
    corpusFileCount += 1;
    try {
      const j = JSON.parse(readFileSync(path.join(D, f), 'utf8'));
      if (Array.isArray(j)) for (const v of j) { const bv = v.bv || v.bvid; if (bv) histBvs.add(String(bv)); }
    } catch { /* 坏文件跳过，不影响这条断言的主旨 */ }
  }
  const seen = new Set(JSON.parse(readFileSync(seenFile, 'utf8')));
  const missing = [...histBvs].filter((bv) => !seen.has(bv));
  check(
    `历史 ${histBvs.size} 个唯一 BV 全部在集合中`,
    missing.length === 0,
    `漏了 ${missing.length} 个: ${missing.slice(0, 5).join(',')}`,
  );
  // 反向：集合里不该有无中生有的项（会白白跳过本来能抓的视频）
  const phantom = [...seen].filter((bv) => !histBvs.has(bv));
  check(
    '集合中不存在语料里从没出现过的幽灵 BV',
    phantom.length === 0,
    `多出 ${phantom.length} 个: ${phantom.slice(0, 5).join(',')}`,
  );
}

console.log('\n=== 4. 真实搜索结果：翻页必须能拿到新的 BV ===');
// 调用真实接口。网络失败时不算失败（不能因为断网就让回归红），但要标出来。
{
  let ok = true;
  let err = '';
  let p1 = [];
  let p2 = [];
  try {
    const m = await import('../../src/bilibili.js');
    const kw = '大学生日常';
    const r1 = await m.searchVideos(kw, { page: 1 });
    p1 = (Array.isArray(r1) ? r1 : r1.list || []).map((v) => v.bvid).filter(Boolean);
    await new Promise((r) => setTimeout(r, 800));
    const r2 = await m.searchVideos(kw, { page: 2 });
    p2 = (Array.isArray(r2) ? r2 : r2.list || []).map((v) => v.bvid).filter(Boolean);
  } catch (e) { ok = false; err = e.message; }

  if (!ok) {
    console.log(`  ⚠️  跳过：接口不可用（${err}）——不算失败`);
  } else {
    check('第 1 页返回 >10 条（证明原 slice(0,10) 确实在丢数据）', p1.length > 10, `实际 ${p1.length} 条`);
    // 断言目标必须是「翻页有收益」，不能是「两页零重叠」。
    // 踩过一次：原断言要求 overlap === 0，采集器同时在搜同一批关键词时
    // 排位会微调，第二页顶部偶尔捞回一两条第一页的条目，于是偶发报红。
    // 但零重叠本来就不是 B 站搜索的契约——它只保证排名近似稳定，
    // 不保证分页边界绝对不交叉。断言过严 = 随机红灯 = 真问题被淹没。
    const overlap = p2.filter((bv) => p1.includes(bv)).length;
    const fresh = p2.filter((bv) => !p1.includes(bv)).length;
    // 阈值：新内容必须占第 2 页的多数（>50%）。
    // 最初写成「重叠 ≤ 一半」，反向验证时发现它在「第2页有一半是旧的」时仍判真，
    // 而「翻页基本没效果」正是要抓的情况 —— 阈值方向必须锚在 fresh 上，不是 overlap 上。
    check(
      '第 2 页以新内容为主（允许与第 1 页少量重叠）',
      p2.length > 0 && fresh > p2.length / 2,
      `新增 ${fresh} 条 / 重叠 ${overlap} 条（第2页共 ${p2.length} 条）`,
    );
  }
}

console.log('\n=== 5. 断言自身的判别力（纯离线，不依赖网络） ===');
// 为什么要有这组：上面第 4 组依赖真实接口，结果每次不一样，
// 改宽阈值后**没有任何办法确认它还有没有判别力**。
// 这里用构造数据把「该过的」和「该红的」都喂一遍，
// 保证断言不是永远绿的摆设。改阈值时必须让这组仍然全绿。
{
  const judge = (p1, p2) => p2.length > 0 && p2.filter((bv) => !p1.includes(bv)).length > p2.length / 2;
  const mk = (n, off) => Array.from({ length: n }, (_, i) => `BV${i + off}`);
  const cases = [
    ['两页完全不同 → 应通过', judge(mk(18, 0), mk(18, 18)), true],
    ['只有 1 条重叠 → 应通过', judge(mk(18, 0), ['BV0', ...mk(17, 18)]), true],
    ['第 2 页一半是旧的 → 应红', judge(mk(18, 0), mk(18, 9)), false],
    ['翻页完全没效果 → 应红', judge(mk(18, 0), mk(18, 0)), false],
    ['第 2 页为空 → 应红', judge(mk(18, 0), []), false],
    ['第 2 页只有 1 条新的 → 应红', judge(mk(18, 0), [...mk(17, 0), 'BVZ']), false],
  ];
  for (const [name, got, want] of cases) check(name, got === want, `got=${got} want=${want}`);
}

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
