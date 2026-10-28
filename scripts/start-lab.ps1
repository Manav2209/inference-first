$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path 'work' -Force | Out-Null
$ollamaCommand = Get-Command ollama -ErrorAction SilentlyContinue
$ollamaExe = if ($ollamaCommand) { $ollamaCommand.Source } else { Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
if (-not (Test-Path -LiteralPath $ollamaExe)) { throw 'Install Ollama and reopen PowerShell first.' }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 3000,11435 -ErrorAction SilentlyContinue)
if ($listeners.Count) { throw 'Port 3000 or 11435 is already in use. Stop the previous lab before starting.' }
$env:OLLAMA_HOST = '127.0.0.1:11435'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_CONTEXT_LENGTH = '2048'
$env:OLLAMA_KEEP_ALIVE = '5m'
$env:UPSTREAM_BASE_URL = 'http://127.0.0.1:11435/v1'
$env:MODEL = 'inference-lab:qwen05-cpu'
$env:MAX_INFLIGHT = '3'
$env:REQUEST_TIMEOUT_MS = '120000'
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$ollamaServer = Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput 'work/ollama.stdout.log' -RedirectStandardError 'work/ollama.stderr.log' -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try { Invoke-RestMethod -Uri 'http://127.0.0.1:11435/api/version' -TimeoutSec 1 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'Ollama did not start; inspect work/ollama.stderr.log' }
    & $ollamaExe create $env:MODEL -f Modelfile
    if ($LASTEXITCODE -ne 0) { throw 'Model creation failed. Run ollama pull qwen2.5:0.5b first.' }
    $gateway = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'src/server.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput 'work/gateway.stdout.log' -RedirectStandardError 'work/gateway.stderr.log' -PassThru
    @{ ollama_pid = $ollamaServer.Id; gateway_pid = $gateway.Id; project_root = $projectRoot; ollama_exe = $ollamaExe; node_exe = (Get-Command node).Source; started_at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content 'work/lab-pids.json' -Encoding utf8
    Write-Output 'Lab started: gateway http://127.0.0.1:3000; dedicated Ollama http://127.0.0.1:11435; engine parallelism 1.'
} catch {
    if (-not $ollamaServer.HasExited) { Stop-Process -Id $ollamaServer.Id }
    throw
}
