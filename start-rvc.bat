@echo off
chcp 65001 >nul
rem RVC 变声服务：把 GPT-SoVITS 合成的语音二次转换成目标音色。
rem
rem 顺序很重要：必须先启动这个服务，再让 qq-bridge 发语音；
rem 服务没起来时桥接会自动回退到未变声的原始音色（说得出话 > 音色像）。
rem
rem 注意：这里不能用 -I（隔离模式）。rvc_python 装在 tools\rvc-aux，
rem 是靠 runtime\Lib\site-packages\_dsh-rvc-aux.pth 注入的；
rem 实测 -I 下这套仍生效，但普通模式更保险，反正这个进程只给自己用。
set "AUX_ROOT=%~dp0..\tools\rvc-aux"
set "RUNTIME=%~dp0..\tools\gpt-sovits\GPT-SoVITS-v2pro-20250604"
set "PY=%RUNTIME%\runtime\python.exe"

if not exist "%PY%" (
  echo [错误] 找不到 Python：%PY%
  echo 请确认 GPT-SoVITS 已完整解压到 tools\gpt-sovits\。
  pause
  exit /b 1
)
if not exist "%AUX_ROOT%\rvc-server.py" (
  echo [错误] 找不到 rvc-server.py：%AUX_ROOT%\rvc-server.py
  pause
  exit /b 1
)

set "PATH=%RUNTIME%\runtime;%RUNTIME%;%PATH%"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
set "HF_HUB_OFFLINE=1"
set "TRANSFORMERS_OFFLINE=1"

echo 启动 RVC 变声服务 http://127.0.0.1:5050
echo 首次请求会加载模型（约 1~4 秒），之后热态 200~300ms。
"%PY%" "%AUX_ROOT%\rvc-server.py" 5050
echo RVC 服务已停止。请保留上面的错误信息以便排查。
pause
