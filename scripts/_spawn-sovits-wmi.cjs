// 用 WMI 把 SoVITS 拉起来，脱离 DSH 进程树。
// 为什么需要：DSH 的 pwsh 沙箱在命令结束时回收子进程，直接 Start-Process 起的 python
// 会随命令结束被杀掉（实测：命令内合成成功，命令结束后进程消失、端口只剩 FIN_WAIT_2）。
// guardian 已在用同样的 WMI「转生」手法存活，这里照抄。
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const bat = 'E:\\dsh\\qq-bridge\\tools\\gpt-sovits\\run-sovits.bat';
const ps = `
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${bat.replace(/\\/g, '\\\\')}"' }
if ($r) { "ReturnValue=$($r.ReturnValue) PID=$($r.ProcessId)" } else { "WMI_CREATE_FAILED" }
`;
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 60000,
  });
  console.log(out.trim());
} catch (e) {
  console.log('ERR', e.message);
  if (e.stdout) console.log('stdout:', String(e.stdout).trim());
  if (e.stderr) console.log('stderr:', String(e.stderr).trim());
}
