// 全量回归入口：跑遍 scripts/ 下所有 test-*.mjs，逐项记录 exit code。
//
// 为什么需要这个文件：
//   仓库里有 90+ 个 test-*.mjs，但 package.json 里全是零散的单测脚本，
//   没有「一次跑完」的入口。之前的台账里写着「全量回归 35 套 → 35/35」，
//   但仓库里搜不到任何产生这个数字的命令或日志——
//   它极可能是把 verify-numbers 的「35 通过」误记成了「35 套回归」。
//   这种数字最危险：写着「已验证」但没有一个人能复现。
//   所以改成由这个脚本现跑现统计，数字从哪来一目了然。
//
// 用法：
//   node run-all-tests.mjs              # 跑全部
//   node run-all-tests.mjs --fast       # 跳过已知的慢测（语音/GIF/浏览器类）
//   node run-all-tests.mjs --filter role
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const DIR = 'E:\\dsh\\qq-bridge\\scripts';
const NODE = process.execPath;
const argv = process.argv.slice(2);
const FAST = argv.includes('--fast');
const filterIdx = argv.indexOf('--filter');
const FILTER = filterIdx >= 0 ? argv[filterIdx + 1] : null;

// 这些测试要么依赖外部服务（语音合成、RVC、GIF 编解码），要么要起浏览器，
// 单跑几分钟且容易因环境缺件失败。--fast 时跳过，但**不算通过**，
// 单独列为 skipped 并在末尾明确报出来，避免「跳过」被读成「通过」。
const SLOW = new Set([
  'test-voice', 'test-voice-gui', 'test-voice-system', 'test-voice-synthesis',
  'test-voice-preview', 'test-voice-volume', 'test-gpt-sovits', 'test-rvc',
  'test-gif-e2e', 'test-media-search', 'test-vision-media', 'test-console-ui',
  'test-dsh-session-retire', 'test-mux-reconnect', 'test-onebot-connection',
  'test-snowluma-upstream-health', 'test-diary-e2e', 'test-owner-memory-e2e',
]);

let files = readdirSync(DIR).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
if (FILTER) files = files.filter((f) => f.includes(FILTER));

const results = [];
for (const file of files) {
  const base = file.replace(/\.mjs$/, '');
  if (FAST && SLOW.has(base)) {
    results.push({ file, status: 'skip' });
    continue;
  }
  const t0 = Date.now();
  // 超时必须**大于**测试内部的超时。踩过一次：test-tieba-mcp.mjs 内部单个 RPC 的
  // 超时是 180000ms，这里原先也写 180000 —— 两层同时到点，测试明明跑完
  // 「14 通过，0 失败」，外层却已经把它 SIGTERM 掉，记录成 exit=null 的失败。
  // 这种假失败最误导人：看起来像功能坏了，实际是跑测试的壳太紧。
  const r = spawnSync(NODE, [`${DIR}\\${file}`], {
    cwd: 'E:\\dsh\\qq-bridge',
    encoding: 'utf8',
    timeout: 300000,
  });
  const ms = Date.now() - t0;
  // 有些测试用 node:test，输出 TAP；有些自己打印「N 通过」。统一以 exit code 为准。
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const lines = out.split('\n').filter((l) => l.trim());
  const summary =
    [...lines].reverse().find((l) => /passed|通过|PASS |FAIL |^# (pass|fail)/.test(l)) ||
    lines.slice(-1)[0] || '';
  results.push({
    file,
    status: r.status === 0 ? 'pass' : 'fail',
    code: r.status,
    ms,
    summary: summary.trim().slice(0, 120),
    stderr: (r.stderr || '').trim(),
  });
  const mark = r.status === 0 ? '✅' : '❌';
  console.log(`${mark} ${file.padEnd(42)} ${String(ms).padStart(6)}ms  ${summary.trim().slice(0, 100)}`);
  if (r.status !== 0 && r.stderr) {
    console.log('   stderr: ' + r.stderr.trim().split('\n').slice(0, 4).join('\n           '));
  }
}

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail');
const skip = results.filter((r) => r.status === 'skip').length;

console.log('');
console.log(`=== 全量回归：${pass} 通过 / ${fail.length} 失败 / ${skip} 跳过（共 ${results.length} 个测试文件）===`);
if (skip) console.log(`注意：${skip} 个慢测被 --fast 跳过，它们**未经验证**，不等于通过。`);
if (fail.length) {
  console.log('失败清单：');
  for (const f of fail) console.log(`  - ${f.file} (exit ${f.code})`);
}
process.exit(fail.length ? 1 : 0);
