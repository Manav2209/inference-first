$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath 'work/lab-pids.json')) { Write-Output 'No lab process record found.'; return }
$record = Get-Content -LiteralPath 'work/lab-pids.json' -Raw | ConvertFrom-Json
$recordedStart = if ($record.started_at -is [DateTime]) {
    $record.started_at.ToUniversalTime()
} else {
    [DateTime]::Parse([string]$record.started_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}
foreach ($entry in @(@{ id = $record.gateway_pid; path = $record.node_exe }, @{ id = $record.ollama_pid; path = $record.ollama_exe })) {
    $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if ($process) {
        if ($process.Path -ne $entry.path -or $process.StartTime.ToUniversalTime() -lt $recordedStart.AddMinutes(-2)) {
            throw 'Process identity changed; refusing to stop a different process.'
        }
        Stop-Process -Id $process.Id
    }
}
Write-Output 'Stopped the recorded lab processes.'
