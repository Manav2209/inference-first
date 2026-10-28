param([string]$Destination = 'results/baseline/host.json')
$ErrorActionPreference = 'Stop'
$systemInfo = Get-CimInstance Win32_ComputerSystem
$osInfo = Get-CimInstance Win32_OperatingSystem
$cpuInfo = Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors
$gpuInfo = Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion
$hostInfo = [ordered]@{
    captured_at = [DateTime]::UtcNow.ToString('o')
    os = $osInfo.Caption
    os_build = $osInfo.BuildNumber
    total_memory_bytes = $systemInfo.TotalPhysicalMemory
    available_memory_bytes = $osInfo.FreePhysicalMemory * 1KB
    cpu = $cpuInfo
    gpu = $gpuInfo
    node_version = (& node --version)
    note = 'No host name, account name, IP address or credentials collected.'
}
$targetDirectory = Split-Path -Parent $Destination
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$hostInfo | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Destination -Encoding utf8
Write-Output "Saved host metadata to $Destination"
