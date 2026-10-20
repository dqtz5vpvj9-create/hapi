param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9A-Za-z._-]+$')][string]$ReleaseLabel,
    [string]$CandidatePath,
    [switch]$UpdateRunner,
    [switch]$UpdateNative,
    [switch]$Rollback,
    [string]$Root = 'D:\hapi'
)
$ErrorActionPreference = 'Stop'
$PSStyle.OutputRendering = 'PlainText'

$rootPath = [IO.Path]::GetFullPath($Root)
$binPath = [IO.Path]::GetFullPath((Join-Path $rootPath 'bin'))
$configPath = Join-Path $rootPath 'config\windows-host.json'
$backup = Join-Path $rootPath "config\windows-host-before-$ReleaseLabel.json"
$receipt = Join-Path $rootPath "state\deployment-$ReleaseLabel.json"

if ($Rollback) {
    if (!(Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Rollback configuration is missing: $backup" }
    Copy-Item -LiteralPath $backup -Destination $configPath -Force
    Stop-ScheduledTask -TaskName 'HAPI-background' -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName 'HAPI-background'
    [ordered]@{ version=1; release=$ReleaseLabel; rolledBackAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
    exit 0
}

if (!$CandidatePath) { throw 'CandidatePath is required for activation' }
$candidate = [IO.Path]::GetFullPath($CandidatePath)
if (!$candidate.StartsWith($binPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Candidate executable must be staged inside the HAPI bin directory'
}
if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Candidate executable is missing: $candidate" }
if (!$UpdateRunner -and !$UpdateNative) { throw 'At least one Windows HAPI role must be selected' }

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$destination = Join-Path $binPath "hapi-$ReleaseLabel.exe"

Copy-Item -LiteralPath $configPath -Destination $backup
Move-Item -LiteralPath $candidate -Destination $destination
if ($UpdateRunner) { $config.roles.runner.executable = $destination }
if ($UpdateNative) { $config.roles.native.executable = $destination }
$nextConfig = "$configPath.next"
$config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $nextConfig -Encoding utf8NoBOM
Move-Item -LiteralPath $nextConfig -Destination $configPath -Force

try {
    Stop-ScheduledTask -TaskName 'HAPI-background'
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 500
        $task = Get-ScheduledTask -TaskName 'HAPI-background'
    } until ($task.State -ne 'Running' -or [DateTime]::UtcNow -ge $deadline)
    if ($task.State -eq 'Running') { throw 'HAPI-background did not stop within 45 seconds' }

    Start-ScheduledTask -TaskName 'HAPI-background'
    $statePath = Join-Path $rootPath 'state\supervisor.json'
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $state = $null
    do {
        Start-Sleep -Seconds 1
        if (Test-Path -LiteralPath $statePath) {
            $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        }
    } until (($state -and $state.nativeReady -and $state.roles.runner.pid -and $state.roles.native.pid) -or [DateTime]::UtcNow -ge $deadline)
    if (!$state -or !$state.nativeReady -or !$state.roles.runner.pid -or !$state.roles.native.pid) {
        throw 'Windows HAPI roles did not become ready within 90 seconds'
    }
    $result = [ordered]@{
        version = 1
        release = $ReleaseLabel
        deployedAt = [DateTime]::UtcNow.ToString('o')
        executable = $destination
        runnerPid = $state.roles.runner.pid
        nativePid = $state.roles.native.pid
        nativeReady = [bool]$state.nativeReady
    }
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding utf8NoBOM
    $result | ConvertTo-Json -Depth 5 -Compress
} catch {
    Copy-Item -LiteralPath $backup -Destination $configPath -Force
    Stop-ScheduledTask -TaskName 'HAPI-background' -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName 'HAPI-background'
    throw
}
