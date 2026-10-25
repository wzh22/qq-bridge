// 语料工程回归：一次性跑完 corpus/scripts 下所有校验脚本，汇总结果。
//
// 为什么需要它：这些脚本散落在目录里，之前靠人工逐个敲。
// 定稿时要跑 6 个脚本，漏掉任何一个都可能让错误数字进卡片。
// 而「漏跑」这种失误没有任何症状 —— 少跑一个校验，输出依然全是 ✅。
//
// 用法：
//   node corpus/scripts/run-corpus-checks.mjs                # 定稿模式（漂移即失败）
//   node corpus/scripts/run-corpus-checks.mjs --collecting   # 采集期（规模漂移只提示）
//   node corpus/scripts/run-corpus-checks.mjs --sync         # 定稿 + 顺手把数字同步进卡片
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const collecting = process.argv.includes('--collecting');
// --no-spawn：在当前进程里顺序 import() 每个脚本，而不是起子进程。
//
// 为什么需要：DSH 沙箱禁止「子进程再起进程」，spawnSync 一律 EPERM。
// 于是这个汇总入口在会话里根本用不了 —— 而它恰恰是定稿时该跑的那一个。
// 但脚本之间是**互相独立的校验**，不是同一进程的连续状态，所以顺序 import 是安全的：
// 唯一的差异是 process.exit() 会直接结束本进程，因此每个脚本的退出码要靠
// 「包一层 try + 临时替换 process.exit」来捕获。
const NO_SPAWN = process.argv.includes('--no-spawn');
// --quiet：只打汇总行，不把每个脚本的完整输出刷到屏幕上。
// 进程内模式尤其需要它：所有脚本都往同一个 stdout 写，不加过滤时
// 一屏几百行，真正失败的那一行反而被淹没 —— 而"看见失败"是这个入口的全部意义。
const QUIET = process.argv.includes('--quiet');

/** 脚本所在目录：默认 scripts/，采集器自测在 collect/ */
const dirOf = (item) => (item.dir ? path.join(HERE, '..', item.dir) : HERE);

/**
 * 在当前进程里跑一个脚本，返回它的退出码。
 * 必须临时接管 process.exit：这些脚本大量用 process.exit(1) 表达失败，
 * 若直接透传会把整个汇总进程干掉，只剩下第一个失败、看不到其余的。
 */
async function runInProcess(file, dir) {
  const origExit = process.exit;
  const origExitCode = process.exitCode;
  let code = 0;
  process.exit = ((c) => {
    code = typeof c === 'number' ? c : (c ? 1 : 0);
    throw new Error(`__EXIT__${code}`); // 用异常中断该脚本剩余逻辑
  });
  try {
    await import(pathToFileURL(path.join(dir || HERE, file)).href);
    // 没调 process.exit：以 process.exitCode 为准（有些脚本用 process.exitCode = 1）
    if (code === 0 && process.exitCode) code = Number(process.exitCode) || 1;
  } catch (e) {
    if (!String(e && e.message).startsWith('__EXIT__')) {
      console.log(`   ⚠️ 未捕获异常：${e && e.message}`);
      code = code || 1;
    }
  } finally {
    process.exit = origExit;
    process.exitCode = origExitCode;
  }
  return code;
}

const SUITE = [
  { file: 'baseline.mjs', desc: '重建语感基线（写 corpus/out/baseline.json）', write: true },
  { file: 'verify-danmaku-baseline.mjs', desc: '独立复算弹幕指标，核对 baseline 口径' },
  { file: 'verify-numbers.mjs', desc: '卡片数字 vs 实测（第 6/7 组为规模断言）', args: collecting ? ['--collecting'] : [] },
  { file: 'check-example-rewrite.mjs', desc: '回复示例空格改写不破坏专名' },
  // 这个脚本要打真实 B 站接口，断网时标「跳过」而非失败（理由见脚本内注释）
  { file: 'test-bili-dedup.mjs', desc: 'B站去重与翻页（含真实接口）' },
  // 采集器侧的自测，在 ../collect 下（它们不是"校验卡片"，而是"校验采集工具本身"）
  { file: 'test-guard.mjs', dir: 'collect', desc: '采集守护 findCollector 的自我排除' },
  // 定稿期要加 --final：采集期它比较「前后半段是否收敛」，采完就永远只会说
  // 「需采集到底再定稿」。定稿期真正该问的是「卡片措辞在前后半段是否都成立」。
  { file: 'stability.mjs', desc: collecting ? '前后半段稳定性（仅报告）' : '定稿判定：卡片措辞在两半是否都成立', args: collecting ? [] : ['--final'] },
];

// 定稿模式的正确顺序：**先重建 baseline，再同步卡片，最后校验**。
//
// 这个顺序踩过一次：最初把 sync 放在最前面，它读到的是上一轮的旧 baseline
// （贴吧 1493），而紧接着 baseline.mjs 一重跑就变成 1507 ——
// 卡片刚写完就已经落后，verify 立刻红一项。
// 采集期语料一直在长，任何「先改卡片后重算基线」的顺序都必然错位。
// 而且这个错位**只在采集进行中暴露**，等采集停了再跑反而是对的，
// 所以一旦没在采集期试过，就会带着一个看起来没问题的脚本上定稿台。
const doSync = !collecting && process.argv.includes('--sync');

console.log(`=== 语料工程校验（${collecting ? '采集期' : '定稿期'}）===`);
console.log('');

const results = [];
for (const item of SUITE) {
  const args = [item.file, ...(item.args || [])];
  const t0 = Date.now();

  if (NO_SPAWN) {
    // 进程内模式：把子脚本要读的 argv 临时换掉（它们靠 process.argv 判断 --final / --collecting）
    const origArgv = process.argv;
    process.argv = [origArgv[0], path.join(dirOf(item), item.file), ...(item.args || [])];

    // 静音：临时把 console.log 换成空函数，避免各脚本的输出糊满屏幕。
    // 只吞 log/info，error 仍然放行 —— 真出异常时要看得见原因。
    const origLog = console.log;
    const origInfo = console.info;
    let captured = '';
    if (QUIET) {
      console.log = (...a) => { captured += a.join(' ') + '\n'; };
      console.info = console.log;
    }
    let code = 0;
    try {
      code = await runInProcess(item.file, dirOf(item));
    } finally {
      if (QUIET) { console.log = origLog; console.info = origInfo; }
      process.argv = origArgv;
    }
    const ms = Date.now() - t0;

    // 从被吞掉的输出里挑一行摘要，否则连「跑出了什么」都不知道。
    let tail = code === 0 ? '通过' : (code === 2 ? '跳过（本机缺数据）' : `退出码 ${code}`);
    const lines = captured.split('\n').filter((l) => l.trim());
    const hit = [...lines].reverse().find((l) => /总计|全部通过|❌ |跳过|拒绝写/.test(l));
    if (hit) tail = hit.trim();
    if (code !== 0 && QUIET) {
      // 失败时补打该脚本的输出尾部，不然只剩一句"退出码 1"，没法排查
      const head = lines.filter((l) => /❌ |Error|异常/.test(l)).slice(0, 6);
      if (head.length) tail += '\n     ' + head.join('\n     ');
    }

    results.push({ ...item, code, ok: code === 0, skipped: code === 2, ms, tail });
    // 退出码 2 = 「本机缺数据，跳过」而不是失败。
    // 这个区分是必需的：干净 clone 里没有语料，若把跳过算失败，
    // 仓库就永远是红的，红得没有信息量，真问题来了也没人看。
    const mark = code === 0 ? '✅' : (code === 2 ? '⏭ ' : '❌');
    console.log(`${mark} ${item.file.padEnd(32)} ${String(ms).padStart(6)}ms  ${tail}`);
    if (doSync && item.file === 'baseline.mjs' && code === 0) {
      console.log('');
      console.log('=== 同步卡片数字（--sync）===');
      const sc = await runInProcess('sync-card-numbers.mjs');
      console.log(sc === 0 ? '（sync 完成）' : `（sync 退出码 ${sc}，通常是在沙箱内无法写 roles/）`);
      console.log('');
    }
    continue;
  }

  const r = spawnSync(NODE, args, {
    // 采集器自测在 collect/ 下，用它们的目录作为 cwd；其余沿用 scripts/。
    // 两者都靠相对 import 找 corpus-paths.mjs，cwd 必须是脚本自己那一层。
    cwd: dirOf(item),
    encoding: 'utf8',
    timeout: 300000,
  });
  const ms = Date.now() - t0;

  // ⚠ 沙箱注意：本进程通过 spawnSync 起子 node 进程。
  // 在 DSH 沙箱内这会被拒（EPERM：禁止子进程再起进程）。
  // 那种情况下 r.status 为 null、r.error 有值——必须把它和「脚本真的失败」区分开，
  // 否则会报一堆莫名其妙的 ❌，让人以为是脚本坏了。
  if (r.error) {
    console.log(`⚠️  ${item.file.padEnd(32)}      无法启动（${r.error.code || r.error.message}）`);
    results.push({ ...item, code: null, ok: false, spawnFailed: true, ms, tail: 'spawn 被拒' });
    continue;
  }

  const code = r.status;
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  const ok = code === 0;

  // 抽摘要行：优先取带「总计 / 全部通过 / ✅」的行，没有就取最后一行
  const lines = stdout.split('\n').filter((l) => l.trim());
  let summaryLine = '';
  if (item.file === 'baseline.mjs') {
    // baseline.mjs 末尾是词频罗列，取「=== 规模 ===」下一行的 JSON 更能代表它跑出了什么
    const i = lines.findIndex((l) => l.includes('=== 规模 ==='));
    summaryLine = i >= 0 && lines[i + 1] ? `规模 ${lines[i + 1].trim()}` : '';
  }
  if (!summaryLine) {
    summaryLine =
      [...lines].reverse().find((l) => /总计|全部通过|✅ |❌ |跳过/.test(l)) ||
      lines.slice(-1)[0] ||
      '';
  }
  results.push({ ...item, code, ok, ms, tail: summaryLine.trim() });

  const mark = ok ? '✅' : '❌';
  console.log(`${mark} ${item.file.padEnd(32)} ${String(ms).padStart(6)}ms  ${summaryLine.trim()}`);

  if (!ok && stderr) {
    console.log('   stderr: ' + stderr.split('\n').slice(0, 5).join('\n   '));
  }

  // baseline 刚重建完，紧接着同步卡片，再让 verify-numbers 去校验。
  // 插在这里而不是循环外，就是为了保证 sync 读到的一定是**本次刚算出的**基线。
  if (doSync && item.file === 'baseline.mjs' && ok) {
    console.log('');
    console.log('=== 同步卡片数字（--sync：用刚重建的 baseline）===');
    const sr = spawnSync(NODE, ['sync-card-numbers.mjs', '--write'], { cwd: HERE, encoding: 'utf8', timeout: 120000 });
    if (sr.error) {
      console.log(`⚠️  sync 无法启动：${sr.error.code || sr.error.message}`);
    } else {
      console.log((sr.stdout || '').trim());
      const se = (sr.stderr || '').trim();
      if (se) console.log(se.split('\n').slice(-4).join('\n'));
      if (sr.status !== 0) {
        console.log('❌ sync-card-numbers 失败，中止后续校验');
        process.exit(1);
      }
    }
    console.log('');
  }
}

const failed = results.filter((r) => !r.ok && !r.skipped);
const skipped = results.filter((r) => r.skipped);
const spawnBlocked = results.filter((r) => r.spawnFailed);

console.log('');
if (failed.length === 0) {
  if (skipped.length) {
    console.log(`通过（${results.length} 个脚本，其中 ${skipped.length} 个因本机缺数据跳过）：`);
    for (const s of skipped) console.log(`   ⏭ ${s.file}`);
    console.log('   跳过不等于通过 —— 这些项在本机没有验证过。');
    if (skipped.some((s) => s.file === 'baseline.mjs')) {
      console.log('   注意：baseline.mjs 被跳过说明没有语料，corpus/out/baseline.json 未被重算。');
    }
  } else {
    console.log(`全部通过（${results.length} 个脚本）`);
  }
  if (collecting) {
    console.log('注：采集期模式下，卡片规模数字的漂移只提示不判失败；');
    console.log('    采集结束后必须不带 --collecting 重跑，届时漂移会判失败。');
  }
  process.exit(0);
}

// spawn 全被拒 = 环境限制，不是代码问题。要说清楚，不能让人去查不存在的 bug。
if (spawnBlocked.length === results.length) {
  console.log('⚠️  全部脚本都无法启动（EPERM）：当前在 DSH 沙箱内，禁止子进程再起进程。');
  console.log('    这不是脚本失败。加 --no-spawn 可在本进程内顺序执行：');
  console.log('      node corpus/scripts/run-corpus-checks.mjs --no-spawn');
  console.log('    或在沙箱外（普通终端 / danger-full-access）重跑原命令。');
  process.exit(2);
}

console.log(`${failed.length}/${results.length} 个脚本失败：${failed.map((f) => f.file).join(', ')}`);
process.exit(1);
