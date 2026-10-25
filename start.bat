@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem --- Locate a node executable -------------------------------------------
rem Why this block exists: node is often NOT on the system PATH here. The bridge
rem used to rely on the shell that DSH injects, so running restart.bat from a
rem plain cmd window failed with "'node' is not recognized as an internal or
rem external command" -- turning "restart" into "shut down".
rem Resolution order:
rem   1) QQBRIDGE_NODE env var (manual override)
rem   2) node on the system PATH (if it ever gets installed)
rem   3) the two node runtimes shipped with DSH
rem Once found, its directory is prepended to PATH so the rest of this script
rem can keep using a bare `node`.
rem
rem NOTE: this file MUST stay pure ASCII. It runs under `chcp 65001` but a
rem non-UTF-8 console would otherwise garble every byte; see
rem scripts/test-audit-setup-guards.mjs. Keep comments in English.
rem
rem NOTE: do not rewrite the candidates below as a parenthesised block that
rem assigns CAND then tests "%CAND%" -- a ( ) block expands %CAND% once at
rem parse time (to the old, empty value), so the test never matches. Each
rem candidate is inlined with its full path to sidestep delayed expansion.
set "NODE_EXE="
if defined QQBRIDGE_NODE if exist "%QQBRIDGE_NODE%" set "NODE_EXE=%QQBRIDGE_NODE%"
if not defined NODE_EXE (
    for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_EXE=%%~$PATH:I"
)
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE (
    echo [%date% %time%] Cannot find node.exe; the bridge cannot start.
    echo   Install Node.js, or set QQBRIDGE_NODE to the full path of node.exe.
    echo   Tried: PATH, DSH bundled runtimes, C:\Program Files\nodejs
    pause
    exit /b 1
)
echo [%date% %time%] Using node: %NODE_EXE%
for %%I in ("%NODE_EXE%") do set "PATH=%%~dpI;%PATH%"

rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
