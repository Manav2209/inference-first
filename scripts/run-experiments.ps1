param([string]$ResultsDirectory = 'results/baseline')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (Test-Path -LiteralPath (Join-Path $ResultsDirectory 'requests.jsonl')) { throw 'Choose a fresh results directory; existing benchmark evidence is never overwritten.' }
New-Item -ItemType Directory -Path 'work' -Force | Out-Null
& "$PSScriptRoot/capture-host.ps1" -Destination (Join-Path $ResultsDirectory 'host.json')
$env:OLLAMA_URL = 'http://127.0.0.1:11435'
$env:GATEWAY_URL = 'http://127.0.0.1:3000'
$env:MODEL = 'inference-lab:qwen05-cpu'
$env:RESULTS_DIR = $ResultsDirectory
$stopFile = 'work/stop-sampling-' + [Guid]::NewGuid().ToString('N')
$sampleFile = Join-Path $ResultsDirectory 'host-samples.jsonl'
$pwshExe = (Get-Process -Id $PID).Path
$sampler = Start-Process -FilePath $pwshExe -ArgumentList @('-NoProfile','-File','scripts/sample-host.ps1','-Destination', ('"' + $sampleFile + '"'),'-StopFile', $stopFile) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput 'work/sampler.stdout.log' -RedirectStandardError 'work/sampler.stderr.log' -PassThru
try {
    & node bench/run.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Benchmark failed; inspect raw results. No complete summary will be generated.' }
    & node bench/summarize.mjs $ResultsDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Summary failed' }
} finally {
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    if (-not $sampler.WaitForExit(5000)) { Stop-Process -Id $sampler.Id }
}
