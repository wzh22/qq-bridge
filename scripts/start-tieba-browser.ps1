# 启动一个「开着调试端口」的 Edge，供贴吧只读工具使用。
#
# 为什么要这个脚本：
#   贴吧对普通 HTTP 请求一律返回 403 + 百度人机验证（UA/浏览器头/移动端/cookie
#   预热/curl/headless 全部试过，都不行）。只有真实浏览器能正常访问。
#   所以合法路径是复用主人自己的浏览器会话，通过 Chrome DevTools Protocol 读
#   **渲染后的 DOM** —— 不伪造身份、不破解验证码、不绕过任何安全机制，
#   验证由主人的浏览器正常完成。
#
# 用法：
#   pwsh -File scripts\start-tieba-browser.ps1
#   （默认 9222 端口；可加 -Port 9333 换端口，但 MCP 工具默认认 9222）
#
# 安全提示：
#   调试端口开着时，本机任何程序都能通过它读取这个浏览器里的页面内容。
#   所以这里用**独立的数据目录**（state/edge-cdp-profile），不复用主人日常的
#   Edge 配置 —— 避免把登录态/收藏夹等暴露给调试端口。
#   不用的时候关掉这个浏览器窗口即可。

param(
  [int]$Port = 9222,
  [string]$ProfileDir = (Join-Path $PSScriptRoot '..\state\edge-cdp-profile')
)

$ErrorActionPreference = 'Stop'

# 解析出绝对路径并确认（不打印路径不操作）
$resolvedProfile = [System.IO.Path]::GetFullPath($ProfileDir)
Write-Output "调试端口 : $Port"
Write-Output "数据目录 : $resolvedProfile"
Write-Output ""

# 已经开着调试端口就直接复用
try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
  Write-Output "✅ 端口 $Port 已经有浏览器在跑：$($v.Browser)"
  Write-Output "   直接可用，无需再启动。"
  exit 0
} catch {
  Write-Output "端口 $Port 未监听，准备启动 Edge…"
}

if (-not (Test-Path -LiteralPath $resolvedProfile)) {
  New-Item -ItemType Directory -Path $resolvedProfile -Force | Out-Null
  Write-Output "已创建数据目录"
}

# 找 Edge
$edgeCandidates = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ }

if (-not $edgeCandidates) {
  Write-Output "❌ 没找到 msedge.exe。请确认 Edge 已安装，或手动用 Chrome 启动："
  Write-Output "   chrome.exe --remote-debugging-port=$Port --user-data-dir=`"$resolvedProfile`""
  exit 1
}

$edge = $edgeCandidates[0]
Write-Output "浏览器   : $edge"

Start-Process -FilePath $edge -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$resolvedProfile",
  'https://tieba.baidu.com'
) | Out-Null

# 等它起来（最多 15 秒）
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
    $ok = $true
    break
  } catch { }
}

if ($ok) {
  Write-Output ""
  Write-Output "✅ 已启动：$($v.Browser)"
  Write-Output "   端口 $Port 可用，贴吧工具现在能用了。"
  Write-Output ""
  Write-Output "💡 如果第一次打开贴吧出现人机验证，请在窗口里手动过一次，之后一般会记住。"
  Write-Output "   用完关掉这个浏览器窗口即可停止暴露调试端口。"
} else {
  Write-Output ""
  Write-Output "❌ Edge 启动了但调试端口没响应。可能是已有 Edge 实例占用了该数据目录。"
  Write-Output "   解决：先把所有 Edge 窗口关掉，再重跑本脚本。"
  exit 1
}
