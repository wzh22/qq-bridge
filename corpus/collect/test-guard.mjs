// 注：本文件里的 E:\dsh\... 是**测试输入数据**（模拟的进程命令行），
// 故意保留绝对路径形态，不要替换成 ROOT/runtimeDir——
// 换成动态路径会让测试输入随部署变化，度量意义就没了。
// 守护逻辑自测：证明 findCollector 真的能区分「采集器活着」「只有守护自己」「都死了」。
//
// 为什么值得单独测：守护这类程序最危险的失效不是崩溃，而是**误判**——
// 它以为自己看见了采集器，于是永远不重启，日志还一切正常。
// 第一版就是这样：正则 `*longrun.mjs*` 匹配到了 guard-longrun.mjs 自己。
// 这个测试直接跑真实的进程枚举，三条断言覆盖三种状态。
//
// 用法：node test-guard.mjs
import { execFileSync } from 'node:child_process';

const SELF_MARK = 'guard-longrun.mjs';
const COLLECTOR_RE = /[\\/]longrun\.mjs/i;

// 与 guard-longrun.mjs 中完全一致的实现（复制而非 import，避免守护的顶层循环被触发）
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
      if (!cmd || cmd.includes(SELF_MARK)) continue;
      if (!COLLECTOR_RE.test(cmd)) continue;
      hits.push(String(pid).trim());
    }
    return hits;
  } catch {
    return null;
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

console.log('=== 1. 真实枚举：必须能看见当前在跑的采集器 ===');
const pids = findCollector();
// 枚举本身失败（null）有两种完全不同的原因，必须分开报：
//   a) 沙箱禁止起 powershell.exe → 环境限制，**不是**匹配逻辑坏了
//   b) 真跑了却解析不出 → 才是代码问题
// 混在一起报 ❌ 会让人去查一个不存在的 bug；这一条在 DSH 沙箱里必然走 a。
if (pids === null) {
  console.log('  ⏭  跳过：无法枚举进程（沙箱禁止 spawn powershell.exe，EPERM）');
  console.log('     这不能判断匹配逻辑好坏。请在沙箱外重跑本脚本以验证第 1 组。');
} else {
  check('枚举没有抛错（返回数组而非 null）', Array.isArray(pids), `实际 ${pids}`);
  if (Array.isArray(pids)) {
    check(`找到采集器（${pids.length} 个）`, pids.length >= 1, '没找到——若采集器确实在跑，说明匹配逻辑坏了');
    // 逐个核对：不能是守护自己
    const selfPid = String(process.pid);
    check('结果里不含本进程 PID', !pids.includes(selfPid), `误把自己算进去了: ${selfPid}`);
  }
}

console.log('\n=== 2. 自我排除：模拟只有守护在场时必须返回空 ===');
// 直接构造假命令行验证过滤规则，不依赖机器上真实跑了什么
const FAKE = [
  { pid: '111', cmd: '"node.exe" E:\\dsh\\qq-bridge\\state\\corpus\\guard-longrun.mjs --until 2026-10-25T11:30:00+08:00' },
  { pid: '222', cmd: '"node.exe" E:\\dsh\\qq-bridge\\state\\corpus\\longrun.mjs --until 2026-10-25T11:30:00+08:00' },
  { pid: '333', cmd: '"node.exe" E:\\dsh\\qq-bridge\\src\\bridge.js' },
];
function simulate(lines) {
  const hits = [];
  for (const { pid, cmd } of lines) {
    if (cmd.includes(SELF_MARK)) continue;
    if (!COLLECTOR_RE.test(cmd)) continue;
    hits.push(pid);
  }
  return hits;
}
check('守护自己不匹配', simulate([FAKE[0]]).length === 0);
check('采集器匹配', simulate([FAKE[1]]).join() === '222');
check('无关进程不匹配', simulate([FAKE[2]]).length === 0);
check('守护 + 采集器混合，只返回采集器', simulate(FAKE).join() === '222');

console.log('\n=== 3. 子串陷阱回归：guard-longrun 不得被当成采集器 ===');
check(
  'guard-longrun.mjs 含 longrun.mjs 子串（说明该陷阱真实存在）',
  'guard-longrun.mjs'.includes('longrun.mjs'),
);
check(
  '但 SELF_MARK 排除后不再命中',
  simulate([{ pid: '1', cmd: 'x\\guard-longrun.mjs' }]).length === 0,
);

console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
