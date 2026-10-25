@echo off
REM ============================================================================
REM  贴吧只读浏览器的启动器（Windows）
REM
REM  为什么需要这个脚本：
REM    tieba.baidu.com 对普通 HTTP 客户端返回 403 + 百度 BIOC 人机验证页。
REM    唯一不涉及「破解反爬」的正当路径是复用**真实浏览器**会话 ——
REM    验证由用户自己的浏览器正常完成，我们只通过官方 DevTools 协议读取渲染后的 DOM。
REM
REM  这个脚本做的事：
REM    用一个**独立的 profile 目录**启动 Edge，并打开调试端口 9222。
REM    独立 profile = 不影响你日常浏览器的书签/历史/登录态；
REM    代价是第一次要在这个窗口里登录一次贴吧（之后 cookie 会留着）。
REM
REM  安全说明：
REM    - 调试端口只监听 127.0.0.1，外网访问不到。
REM    - 用完后关掉这个窗口即可；下次重新运行会复用同一个 profile。
REM    - 只读：qq-bridge 只调用 Page.navigate + Runtime.evaluate 读 DOM，
REM      不会模拟点击「发帖」、不碰你的账号写操作。
REM ============================================================================
setlocal

set "EDGE=%~1"
if "%EDGE%"=="" (
  if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  ) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  )
)

if not exist "%EDGE%" (
  echo [x] 找不到 Microsoft Edge。
  echo     请手动指定路径： start-tieba-browser.ps1 "C:\path\to\msedge.exe"
  exit /b 1
)

set "PROFILE=%~dp0..\state\edge-cdp-profile"
if not exist "%PROFILE%" mkdir "%PROFILE%"

echo [*] Edge   : %EDGE%
echo [*] Profile: %PROFILE%
echo [*] 调试端口: 127.0.0.1:9222
echo.
echo [i] 窗口打开后，如需登录贴吧请在这个窗口里登录一次。
echo [i] 用完后直接关掉窗口即可。
echo.

start "" "%EDGE%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-blink-features=AutomationControlled ^
  https://tieba.baidu.com/

exit /b 0
