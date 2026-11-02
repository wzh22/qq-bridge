@echo off
chcp 65001 >nul
rem ===========================================================================
rem 向量检索服务（Qwen3-Embedding-0.6B）
rem
rem 复用 GPT-SoVITS 的 Python runtime —— 那里已经有 torch 2.0.0+cu118，
rem 不需要另装环境。隔离的 tokenizers/transformers 在 vecsvc\pylibs，
rem 由 vec_server.py 自己前置到 sys.path，只对本进程生效。
rem
rem 注意：不要用 -I（隔离模式）。pylibs 的注入依赖正常的 sys.path 行为。
rem ===========================================================================
set "RUNTIME=%~dp0..\tools\gpt-sovits\GPT-SoVITS-v2pro-20250604"
set "PY=%RUNTIME%\runtime\python.exe"
set "SVC=%~dp0..\tools\vecsvc"

if not exist "%PY%" (
  echo [错误] 找不到 Python: %PY%
  echo 请确认 GPT-SoVITS 已解压到 tools\gpt-sovits\。
  exit /b 1
)
if not exist "%SVC%\vec_server.py" (
  echo [错误] 找不到 vec_server.py: %SVC%\vec_server.py
  exit /b 1
)

set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"

"%PY%" "%SVC%\vec_server.py" --port 9870
