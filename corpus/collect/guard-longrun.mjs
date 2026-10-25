// 采集守护：每 5 分钟检查一次 longrun 进程，挂了就按原参数重启。
//
// 为什么要它：longrun.mjs 内部每个采集步骤都有 try/catch，单轮失败只计数不退出；
// 但**进程级**故障（CDP 浏览器崩溃导致 fetch 全挂、Node 内存异常、被误杀）不在其覆盖范围内。
// 这次要连续跑 7 小时，中途静默断掉的话，表现是「日志不再更新」——
// 而人不会一直盯着日志，等发现时已经白等了几个小时。
//
// 守护自身只做三件事：探活 → 必要时重启 → 写一行日志。不改采集器代码。
//
// 用法：node guard-longrun.mjs            （前台运行）
//       node guard-longrun.mjs --until "2026-10-25T11:30:00+08:00"
import { spawn, execFileSync } from 'node:child_process';
import { runtimeDir, ROOT } from '../scripts/corpus-paths.mjs';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';

const DIR = runtimeDir();
const NODE = process.execPath;
const LOG = `${DIR}\\guard.log`;
const UNTIL = process.argv.includes('--until')
  ? process.argv[process.argv.indexOf('--until') + 1]
  : '2026-10-25T11:30:00+08:00';

const untilMs = new Date(UNTIL).getTime();
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + '\n', 'utf8'); } catch { /* 日志写不了不影响守护 */ }
}

// 用命令行匹配而非 PID 文件：采集器是自己重启的，PID 每次都会变；
// PID 文件一旦过期反而会误导守护去检查一个已死的进程。
//
// ⚠️ 这里踩过一个坑：匹配 `*longrun.mjs*` 会把**守护自己**也算进去
// （本文件名 guard-longrun.mjs 含 longrun.mjs 子串）。后果极其隐蔽——
// 守护永远能"看见"自己，于是判定采集器活着，真挂了也从不重启，
// 日志上还一切正常。所以必须同时排除 guard-longrun，并做一次完整路径校验。
const SELF_MARK = 'guard-longrun.mjs';
const COLLECTOR_RE = /[\\/]longrun\.mjs/i;
function findCollector() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*longrun*' } | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    );
    const hits = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [pid, ...rest] = line.split('\t');
      const cmd = rest.join('\t');
      if (!cmd || cmd.includes(SELF_MARK)) continue; // 排除守护自身
      if (!COLLECTOR_RE.test(cmd)) continue;
      hits.push(String(pid).trim());
    }
    return hits;
  } catch {
    return null; // 查询本身失败，不当作「进程已死」
  }
}

function startCollector() {
  log('采集器不在，重新拉起…');
  const child = spawn(NODE, [`${DIR}\\longrun.mjs`, '--until', UNTIL], {
    cwd: DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  log(`已拉起，PID ${child.pid}`);
}

// ── 浏览器存活检查（10-25 06:40 新增）──────────────────────────────────────
//
// 为什么加这个：06:30–06:35 出现了一次**采集器活着但浏览器死了**的故障。
// guard 只查 longrun.mjs 进程，看到 PID 46900 在跑就判定一切正常，
// 而那 4 分半里贴吧连失败 5 次、小红书失败 2 次，全部记成 exit=1。
// 采集器进程不会因此退出（longrun.mjs 内部对单轮失败只计数），
// 所以**守护完全看不见**，这正是最需要它管的那种静默劣化。
//
// 判定方式用 HTTP 探 /json/version，不用查进程名：
//   · 进程名匹配会把主人日常的 Edge 也当成「浏览器活着」；
//   · 端口探测直接问「9222 上有没有一个能应答的 CDP」，
//     这才是贴吧/小红书采集真正需要的东西。
//
// ⚠️ 为什么不直接调 scripts/start-tieba-browser.ps1（06:45 实测踩到的坑）：
//   那个 .ps1 是**无 BOM 的 UTF-8**，而本机只有 Windows PowerShell 5.1
//   （没有 pwsh 7）。5.1 读无 BOM 的 .ps1 会按 GBK 解码，中文字符串里的
//   引号被截断，直接 ParserError：
//     At start-tieba-browser.ps1:28 char:1  Unexpected token '}' ...
//     The string is missing the terminator: ".
//   也就是说那个脚本在任何 5.1 机器上都跑不了——我先前手动"启动成功"
//   其实是绕开脚本直接 Start-Process 的，脚本本身从未真正验证过。
//   这里改成**内联启动**，不依赖 .ps1、不碰编码、不依赖执行策略。
const CDP_PORT = 9222;
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const CDP_PROFILE = path.join(ROOT, 'state', 'edge-cdp-profile');

async function cdpAlive() {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureBrowser() {
  if (await cdpAlive()) return true;
  log(`⚠️ CDP 浏览器不在（端口 ${CDP_PORT} 无应答），尝试拉起…`);

  const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!edge) {
    log('❌ 找不到 msedge.exe，无法自动拉起');
    return false;
  }
  try {
    // detached + unref：Edge 必须活过 guard 这轮循环，不能是子进程
    const child = spawn(edge, [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CDP_PROFILE}`,
      'https://tieba.baidu.com',
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    log(`已发起启动：${edge}`);
  } catch (e) {
    log(`启动 Edge 失败：${String(e.message).slice(0, 200)}`);
    return false;
  }

  // 给它最多 30 秒起来（冷启动 Edge 比脚本里估的 15 秒慢）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await cdpAlive()) {
      log('✅ CDP 浏览器已恢复');
      return true;
    }
  }
  log('❌ CDP 浏览器仍未恢复，下一轮再试');
  return false;
}


log(`守护启动，截止 ${new Date(untilMs).toLocaleString('zh-CN', { hour12: false })}`);
let restarts = 0;
// 连续失败计数（与上面的 restarts 累计值区分）：
// restarts 只增不减，用于最后统计；consecutiveFailures 在采集器恢复时归零，
// 只有「连续」拉起仍失败才判定环境性问题。
let consecutiveFailures = 0;

while (Date.now() < untilMs) {
  const pids = findCollector();
  if (pids === null) {
    log('进程查询失败（不影响判断，下轮再试）');
  } else if (pids.length === 0) {
    restarts += 1;
    consecutiveFailures += 1;
    if (consecutiveFailures > 20) {
      log(`连续 ${consecutiveFailures} 次拉起后仍不见进程，判定为环境性问题，停止守护`);
      break;
    }
    startCollector();
  } else {
    // 采集器活着 —— 打断「连续失败」计数。
    // 原实现只有 restarts 一个只增不减的计数器，跑几小时后零星几次重启
    // 就会累加到 20 而永久退出，此时采集器其实好好的，保护机制反成单点故障。
    if (consecutiveFailures > 0) {
      log(`采集器恢复运行（此前连续拉起 ${consecutiveFailures} 次），计数归零`);
      consecutiveFailures = 0;
    }
    if (Date.now() % 600000 < 300000) {
      // 只在约一半的轮次打印，避免日志刷屏
      log(`采集器在运行 PID ${pids.join(',')}`);
    }
  }

  // 无论采集器在不在，都要确认浏览器活着。
  // 顺序有讲究：先补采集器再查浏览器——采集器挂了要立刻拉起，
  // 浏览器检查最多耗 20 秒，不该把它拖到前面。
  // 采集器活着但浏览器死了，正是 06:30 那次故障的形态，必须单独兜。
  await ensureBrowser();

  // 睡 5 分钟，但不超过截止时间
  const remain = untilMs - Date.now();
  if (remain <= 0) break;
  await new Promise((r) => setTimeout(r, Math.min(300000, remain)));
}

log(`守护结束（重启 ${restarts} 次）`);
