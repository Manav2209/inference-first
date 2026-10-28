param([string]$Destination = 'results/baseline/host-samples.jsonl', [string]$StopFile = 'work/stop-sampling')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
$logicalCPUs = [Environment]::ProcessorCount
$previousCPU = @{}
$previousTime = [DateTime]::UtcNow
while (-not (Test-Path -LiteralPath $StopFile)) {
    $now = [DateTime]::UtcNow
    $elapsed = ($now - $previousTime).TotalSeconds
    $processes = @(Get-Process -Name 'ollama','llama-server' -ErrorAction SilentlyContinue)
    $cpuSeconds = 0
    $rss = 0
    foreach ($process in $processes) {
        if ($previousCPU.ContainsKey($process.Id)) { $cpuSeconds += [Math]::Max(0, $process.CPU - $previousCPU[$process.Id]) }
        $previousCPU[$process.Id] = $process.CPU
        $rss += $process.WorkingSet64
    }
    $row = [ordered]@{ timestamp = $now.ToString('o'); interval_seconds = $elapsed; logical_cpus = $logicalCPUs
        inference_cpu_percent_of_machine = if ($elapsed -gt 0.5) { 100 * $cpuSeconds / $elapsed / $logicalCPUs } else { $null }
        inference_working_set_bytes = $rss; inference_process_count = $processes.Count }
    $row | ConvertTo-Json -Compress | Add-Content -LiteralPath $Destination -Encoding utf8
    $previousTime = $now
    Start-Sleep -Seconds 1
}
