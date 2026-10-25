// test-preset-install-sync.mjs — 钉住「改了源，但线上没生效」这个隐形故障。
//
// ## 为什么需要这个脚本
//
// preset 的内容要跨三道关才真正影响机器人说话：
//
//   ① 源      dsh/agent-presets/<preset>/agent.cordis.yml      ← 人改这里
//   ② 生成物  plugins/qq-agent-presets/presets/<preset>.patch.yml ← build 脚本渲染
//   ③ 线上    运行中的 DSH 装载的那份                           ← 只在启动时读一次
//
// 每一道都有一种**静默失败**：不报错，不退出，只是你改的话没生效。
//
//   ①→② 忘了跑 build-agent-preset-patches.mjs：patch 还是旧的。
//        （test-agent-preset-patches.mjs 已经用 --check 钉住了这条，本脚本不重复。）
//
//   ②→③ 改了 patch 但没重启 DSH：**这是最坑的一条**。
//        patch 只在 DSH 启动时装配一次。改完文件当下看不出任何异常，
//        机器人照常说话，只是用的是旧人格/旧分条规则。
//        2026-10-25 就踩过：patch 20:22 改完，DSH 14:25 启动，线上一直是旧版；
//        直到测试报 `Unknown agent preset` 才被发现。
//
// 本脚本专治 ②→③：把「运行中的 DSH 到底装了什么」和「源文件里写的什么」直接对上。
//
// ## 怎么判断「线上装的是不是最新」
//
// 光比 mtime 不可靠（$touch 一下也会变，且 DSH 可能读的是别的副本）。
// 这里直接问运行中的 DSH：agentPresets/read 会把该 preset 的子行清单
// 渲染成 YAML 返回 —— 那就是它真正装载的内容。然后与源文件逐字比对。
//
// 所以本脚本能回答一个别的测试回答不了的问题：
//   「我现在改的这句话，机器人嘴里说的是这一版吗？」
//
// ## 三种运行模式
//
//   默认（DSH 在跑）  离线比对 + 线上比对。线上不一致 → 失败，并提示重启。
//   --offline         只做源↔生成物比对，不碰 DSH（CI / DSH 没起时用）。
//   DSH 没在跑        线上部分跳过，但仍做离线比对；不算失败（跳过≠通过）。
//
// ## 退出码
//   0 全部一致（或线上部分按规则跳过）
//   1 发现漂移
//
// 注意：本脚本**只读**。不重启 DSH，不改任何文件，不发任何消息。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { discoverDshSessionCookie } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PRESETS = ['qq-chat', 'qq-chat-v2'];

const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
// 允许显式指定端口；默认按运行上下文/常见端口探测。
const baseArgIdx = argv.indexOf('--base');
const EXPLICIT_BASE = baseArgIdx >= 0 ? argv[baseArgIdx + 1] : null;

let failures = 0;
let skips = 0;
function ok(cond, label, detail = '') {
  if (cond) {
    console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
  return cond;
}
function skip(label, why) {
  skips += 1;
  console.log(`⏭️  ${label} — ${why}`);
}

const read = (p) => fs.readFileSync(p, 'utf8');

// ── 定位运行中的 DSH ────────────────────────────────────────────────
// 桥接用的端口不是固定的（这次是 54989，脚本默认值 3080 已经过期）。
// 依次尝试：显式 --base → 环境变量 → 从 bridge.log 里捞 → 常见端口。
function candidateBases() {
  const out = [];
  if (EXPLICIT_BASE) out.push(EXPLICIT_BASE);
  if (process.env.DSH_BASE_URL) out.push(process.env.DSH_BASE_URL);

  // bridge.log 里会打印「本地控制台已启动：http://127.0.0.1:3100」之类，
  // 但那是桥接自己的控制台，不是 DSH。DSH 端口在 DSH 自己的日志/profile 里。
  // 这里退而求其次：扫 state/ 下最近的日志找 127.0.0.1:<port> 形态。
  try {
    const logFile = path.join(REPO_ROOT, 'state', 'bridge.log');
    if (fs.existsSync(logFile)) {
      const tail = read(logFile).split('\n').slice(-400).join('\n');
      for (const m of tail.matchAll(/127\.0\.0\.1:(\d{4,5})/g)) {
        const u = `http://127.0.0.1:${m[1]}`;
        if (!out.includes(u)) out.push(u);
      }
    }
  } catch { /* 日志读不到就算了 */ }

  for (const p of ['http://127.0.0.1:3080', 'http://127.0.0.1:54989']) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

async function rpc(base, cookie, method, args = {}) {
  const rpcId = `sync-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (res.status !== 200 || (body && body.error)) {
    throw new Error(`${method} 失败：HTTP ${res.status} ${body?.error?.message ?? text.slice(0, 160)}`);
  }
  return body?.result?.value;
}

/** 找到第一个能应答 agentPresets/list 的 base。找不到返回 null。 */
async function findLiveDsh() {
  for (const base of candidateBases()) {
    let cookie;
    try {
      cookie = discoverDshSessionCookie(base);
    } catch {
      continue;
    }
    if (!cookie) continue;
    try {
      const value = await rpc(base, cookie, 'agentPresets/list');
      if (Array.isArray(value?.presets)) return { base, cookie, presets: value.presets };
    } catch {
      // 这个端口不通，试下一个
    }
  }
  return null;
}

// ── 读取源文件（权威）──────────────────────────────────────────────
function loadSourceRows(preset) {
  const file = path.join(REPO_ROOT, 'dsh', 'agent-presets', preset, 'agent.cordis.yml');
  return { file, rows: yaml.load(read(file)) };
}

// ── 1. 源 ↔ 生成物（离线，纯文件比对）──────────────────────────────
// 注意方向：dsh/agent-presets/ 是**源**，patch.yml 是**生成物**。
// 早期注释把这层关系写反过，这里明确一次。
function checkSourceVsPatch(preset) {
  const { file: srcFile, rows } = loadSourceRows(preset);
  const patchFile = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'presets', `${preset}.patch.yml`);

  if (!ok(fs.existsSync(patchFile), `${preset}: patch 生成物存在`, path.relative(REPO_ROOT, patchFile))) return;

  const doc = yaml.load(read(patchFile));
  const row = doc?.[0]?.insert?.[0];
  const installed = row?.config?.plugins;
  if (!ok(Array.isArray(installed), `${preset}: patch 里有 config.plugins`)) return;

  // persona.prefix 是人格本体，也是「改了没生效」最常发生的地方。单独比对并给出长度，
  // 让 diff 一眼能看出是「整体截断」还是「局部改写」。
  const srcPersona = rows.find((r) => r.id === 'persona')?.config?.prefix ?? '';
  const gotPersona = installed.find((r) => r.id === 'persona')?.config?.prefix ?? '';
  const same = srcPersona === gotPersona;
  ok(same, `${preset}: 生成物 persona.prefix 与源一致`, `${srcPersona.length} vs ${gotPersona.length} 字符`);

  if (!same) {
    // 指出第一处不同，省得人肉 diff 一整个 13KB 的提示词。
    const n = Math.min(srcPersona.length, gotPersona.length);
    let i = 0;
    while (i < n && srcPersona[i] === gotPersona[i]) i += 1;
    const ctx = (s) => JSON.stringify(s.slice(Math.max(0, i - 30), i + 30));
    console.error(`   首个差异在第 ${i} 字符附近：`);
    console.error(`     源  : ${ctx(srcPersona)}`);
    console.error(`     patch: ${ctx(gotPersona)}`);
    console.error('   → 跑 node scripts/build-agent-preset-patches.mjs 重新生成');
  }
}

// ── 2. 生成物 ↔ 线上（需要 DSH 在跑）───────────────────────────────
// 这是本脚本的核心：直接问运行中的 DSH 它装载了什么。
async function checkLive(live, preset) {
  const { rows } = loadSourceRows(preset);
  const srcPersona = rows.find((r) => r.id === 'persona')?.config?.prefix ?? '';

  const listed = live.presets.find((p) => p.id === preset);
  if (!ok(listed !== undefined, `${preset}: 运行中的 DSH 有该 preset`)) return;

  if (listed.broken) {
    failures += 1;
    console.error(`❌ ${preset}: 挂载失败（broken）— ${JSON.stringify(listed.broken).slice(0, 300)}`);
    return;
  }
  ok(true, `${preset}: 运行中挂载无错`);

  const doc = await rpc(live.base, live.cookie, 'agentPresets/read', { agentPreset: preset });
  const content = typeof doc?.content === 'string' ? doc.content : '';
  if (!ok(content.length > 0, `${preset}: 能读回线上装载内容`)) return;

  // 线上内容是一段 YAML 文本；解析它是判断「线上到底是不是这一版」最直接的方式。
  let liveRows;
  try {
    liveRows = yaml.load(content);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${preset}: 线上内容不是合法 YAML — ${error.message}`);
    return;
  }
  const livePersona = liveRows?.find?.((r) => r.id === 'persona')?.config?.prefix ?? '';

  if (livePersona === srcPersona) {
    ok(true, `${preset}: 线上装载的人格与源逐字一致`, `${srcPersona.length} 字符`);
    return;
  }

  // 不一致 —— 这里必须说清楚是「没重启」还是「别的原因」，否则使用者只会看到
  // 一句「不一致」，然后去翻提示词找 bug。
  failures += 1;
  console.error(`❌ ${preset}: 线上人格与源不一致（源 ${srcPersona.length} 字符 / 线上 ${livePersona.length} 字符）`);
  const n = Math.min(srcPersona.length, livePersona.length);
  let i = 0;
  while (i < n && srcPersona[i] === livePersona[i]) i += 1;
  console.error(`   首个差异在第 ${i} 字符附近：`);
  console.error(`     源  : ${JSON.stringify(srcPersona.slice(Math.max(0, i - 40), i + 40))}`);
  console.error(`     线上: ${JSON.stringify(livePersona.slice(Math.max(0, i - 40), i + 40))}`);

  // 给出最可能的原因：源文件比 DSH 进程还新 ⇒ 几乎一定是没重启。
  const srcFile = path.join(REPO_ROOT, 'dsh', 'agent-presets', preset, 'agent.cordis.yml');
  try {
    const srcMtime = fs.statSync(srcFile).mtimeMs;
    const dshStart = live.dshStartTime ? live.dshStartTime.getTime() : null;
    if (dshStart !== null && srcMtime > dshStart) {
      console.error('   → 源文件比 DSH 进程启动更晚：patch 只在启动时装配，**需要重启 DSH**');
    } else {
      console.error('   → 源文件不比 DSH 启动新，原因可能不是没重启；请检查是否还有别的副本被装载');
    }
  } catch { /* 拿不到 mtime 就算了，不阻塞主要结论 */ }
}

// ── main ────────────────────────────────────────────────────────────
console.log('## 1. 源 → 生成物（离线）');
console.log('   源：dsh/agent-presets/<preset>/agent.cordis.yml（权威）');
console.log('   产物：plugins/qq-agent-presets/presets/<preset>.patch.yml（生成）');
for (const preset of PRESETS) {
  try {
    checkSourceVsPatch(preset);
  } catch (error) {
    failures += 1;
    console.error(`❌ ${preset}: 离线比对异常 — ${error?.message ?? error}`);
  }
}

if (OFFLINE) {
  console.log('\n## 2. 生成物 → 线上');
  skip('线上装载比对', '--offline 已指定，不访问 DSH');
} else {
  console.log('\n## 2. 生成物 → 线上（运行中的 DSH 实际装载了什么）');
  const live = await findLiveDsh();
  if (!live) {
    skip('线上装载比对', '连不上运行中的 DSH（没启动 / 端口变了）。用 --base 指定，或 --offline 明确跳过');
  } else {
    console.log(`   已连接 DSH：${live.base}`);
    console.log(`   已知 preset：${live.presets.map((p) => p.id).join(', ')}`);

    // DSH 主进程启动时间：用来解释「为什么线上是旧版」。
    try {
      const { execFileSync } = await import('node:child_process');
      const ps = execFileSync('pwsh', ['-NoProfile', '-Command',
        "(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | "
        + "Sort-Object StartTime | Select-Object -First 1).StartTime.ToString('o')"], { encoding: 'utf8' }).trim();
      if (ps) live.dshStartTime = new Date(ps);
    } catch { /* 拿不到不算失败 */ }

    for (const preset of PRESETS) {
      try {
        await checkLive(live, preset);
      } catch (error) {
        failures += 1;
        console.error(`❌ ${preset}: 线上比对异常 — ${error?.message ?? error}`);
      }
    }
  }
}

console.log('');
if (failures === 0) {
  console.log(`✅ preset 装配一致${skips ? `（${skips} 项跳过）` : ''}`);
} else {
  console.error(`❌ ${failures} 项不一致${skips ? `，${skips} 项跳过` : ''}`);
}
// 不用 process.exit：成功路径上 undici 的 keep-alive socket 还在关闭，
// 强行退出在 Windows 上会触发 libuv 断言，把成功跑成非 0。
process.exitCode = failures === 0 ? 0 : 1;
