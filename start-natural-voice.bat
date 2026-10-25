@echo off
chcp 65001 >nul
set "VOICE_ROOT=%~dp0tools\gpt-sovits\GPT-SoVITS-v2pro-20250604"
cd /d "%VOICE_ROOT%"
set "PATH=%VOICE_ROOT%\runtime;%VOICE_ROOT%;%PATH%"
set "HF_HUB_OFFLINE=1"
set "TRANSFORMERS_OFFLINE=1"
set "PYTHONIOENCODING=utf-8"
echo Starting local Chinese voice service at http://127.0.0.1:9880
echo Keep this window open while using natural voice.
runtime\python.exe -I api_v2.py -a 127.0.0.1 -p 9880 -c qq-tts.yaml
echo Voice service has stopped. Please keep any error text for diagnosis.
pause
