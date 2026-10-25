$ErrorActionPreference = 'Stop'
$engineRoot = 'E:\dsh\qq-bridge\tools\gpt-sovits\GPT-SoVITS-v2pro-20250604'
if (Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue) {
  Write-Output 'Port 9880 already has a listener. No second service started.'
  exit 0
}
$env:PATH = "$engineRoot\runtime;$engineRoot;" + $env:PATH
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$process = Start-Process -FilePath "$engineRoot\runtime\python.exe" -ArgumentList '-I','api_v2.py','-a','127.0.0.1','-p','9880','-c','qq-tts.yaml' -WorkingDirectory $engineRoot -WindowStyle Hidden -RedirectStandardOutput "$engineRoot\qq-tts.stdout.log" -RedirectStandardError "$engineRoot\qq-tts.stderr.log" -PassThru
Write-Output "GPT-SoVITS process started: $($process.Id). Check the local API before enabling the provider."
