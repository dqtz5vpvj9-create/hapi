$ErrorActionPreference = 'Stop'
trap { ('{0:o} {1}' -f [DateTime]::UtcNow, $_.ToString()) | Add-Content -LiteralPath 'D:\hapi\logs\supervisor-fatal.log'; exit 1 }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$env:TEMP = 'D:\hapi\temp'
$env:TMP = $env:TEMP
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Refusing an administrative runtime token' }
Add-Type -Path (Join-Path $PSScriptRoot 'TaskHost.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'NativeRpc.cs')
$pwsh = (Get-Command pwsh.exe).Source
$roles = @{}
$rpc = $null
$healthy = $false
$lastHealthy = [DateTime]::UtcNow
$nextProbe = [DateTime]::MinValue
$restorePending = $true
$savedThreads = @()
$snapshotFile = 'D:\hapi\state\native-loaded-roots.json'
if (Test-Path -LiteralPath $snapshotFile) { $savedThreads = @((Get-Content -LiteralPath $snapshotFile -Raw | ConvertFrom-Json).threadIds) }

function Write-StateFile($Path, $Value) {
    [IO.File]::WriteAllText("$Path.new", ($Value | ConvertTo-Json -Depth 8))
    [IO.File]::Move("$Path.new", $Path, $true)
}
function Write-Event($Text) {
    $path = 'D:\hapi\logs\supervisor.log'
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 4MB) { Move-Item -LiteralPath $path -Destination "$path.previous" -Force }
    ('{0:o} {1}' -f [DateTime]::UtcNow, $Text) | Add-Content -LiteralPath $path
}
function Call-Native($Method, $Parameters) {
    $rpc.Request($Method, ($Parameters | ConvertTo-Json -Depth 8 -Compress)).GetAwaiter().GetResult() | ConvertFrom-Json
}
function Read-LoadedRoots {
    $loaded = @(); $cursor = $null
    do {
        $page = Call-Native 'thread/loaded/list' @{ cursor=$cursor }
        foreach ($threadId in $page.data) {
            $thread = (Call-Native 'thread/read' @{ threadId=$threadId; includeTurns=$false }).thread
            if (-not $thread.parentThreadId) { $loaded += $threadId }
        }
        $cursor = $page.nextCursor
    } while ($cursor)
    return $loaded
}
function Stop-Role($Name) {
    $entry = $roles[$Name]
    if ($entry -and $entry.process) { $entry.process.Dispose(); $entry.process=$null }
}
function Ensure-Role($Name) {
    if (-not $roles.ContainsKey($Name)) { $roles[$Name] = @{ process=$null; failures=0; started=[DateTime]::MinValue; retry=[DateTime]::MinValue } }
    $entry = $roles[$Name]
    if ($entry.process -and $entry.process.HasExited) {
        if ($Name -eq 'runner' -and (Test-Path -LiteralPath 'D:\hapi\state\runner.state.json')) {
            # Runner-owned agent sessions deliberately outlive Runner. Its wrapper
            # can exit during a version handoff or be killed independently.
            $runnerState = Get-Content -LiteralPath 'D:\hapi\state\runner.state.json' -Raw | ConvertFrom-Json
            $running = Get-Process -Id $runnerState.pid -ErrorAction SilentlyContinue
            if ($running -and $running.SessionId -eq 0 -and $running.Path -eq 'D:\hapi\bin\hapi-20261004.exe') {
                $row=Get-CimInstance Win32_Process -Filter "ProcessId=$($running.Id)"
                if ($row.CommandLine -match 'runner start-sync') {
                    $entry.process.Dispose(); $entry.process=$running
                    Write-Event "runner adopted ($($running.Id)); detached agent sessions retained"
                    return
                }
            }
        }
        Write-Event "$Name exited ($($entry.process.ExitCode))"
        $entry.process.Dispose(); $entry.process=$null
        $entry.failures = if (([DateTime]::UtcNow - $entry.started).TotalSeconds -gt 60) { 0 } else { [Math]::Min(5, $entry.failures + 1) }
        $entry.retry = [DateTime]::UtcNow.AddSeconds([Math]::Pow(2, $entry.failures))
    }
    if (-not $entry.process -and [DateTime]::UtcNow -ge $entry.retry) {
        $entry.process = [HapiTaskHost+OwnedProcess]::Start($pwsh, "-NoLogo -NoProfile -NonInteractive -File D:\hapi\scripts\start-role.ps1 -Role $Name", 'D:\hapi', ($Name -ne 'runner'))
        $entry.started = [DateTime]::UtcNow
        Write-Event "$Name started ($($entry.process.Id))"
    }
}

Write-Event "started in session $((Get-Process -Id $PID).SessionId) as $($identity.Name), non-administrative"
try {
    while ($true) {
        $oldEngine = if ($roles.engine.process) { $roles.engine.process.Id } else { $null }
        Ensure-Role engine
        Ensure-Role pipe
        Ensure-Role runner
        if ($roles.engine.process -and $oldEngine -ne $roles.engine.process.Id) {
            $restorePending = $true; $healthy = $false
            if ($rpc) { $rpc.Dispose(); $rpc=$null }
            $nextProbe = [DateTime]::MinValue; $lastHealthy = [DateTime]::UtcNow
        }
        if ([DateTime]::UtcNow -ge $nextProbe) {
            try {
                if (-not $rpc) { $rpc = [HapiNativeRpc]::Connect('hapi-native-preview-20261004').GetAwaiter().GetResult() }
                $loaded = @(Read-LoadedRoots)
                $restoreFailed = $false
                # Only reopen roots previously observed on this owned engine. Never
                # replay turn/start, queue/add or unconfirmed user submissions.
                if ($restorePending -and $savedThreads.Count) {
                    $saved = [Collections.Generic.HashSet[string]]::new()
                    $cursor = $null
                    do {
                        $page = Call-Native 'thread/list' @{ archived=$false; limit=100; cursor=$cursor; useStateDbOnly=$true; modelProviders=@(); sourceKinds=@('cli','vscode','exec','appServer','unknown') }
                        foreach ($thread in $page.data) { [void]$saved.Add($thread.id) }
                        $cursor = $page.nextCursor
                    } while ($cursor)
                    foreach ($threadId in $savedThreads) {
                        if ($loaded -contains $threadId -or -not $saved.Contains($threadId)) { continue }
                        try {
                            $thread = (Call-Native 'thread/read' @{ threadId=$threadId; includeTurns=$false }).thread
                            if ($thread.parentThreadId) { continue }
                            $null = Call-Native 'thread/resume' @{ threadId=$threadId; excludeTurns=$true }
                            Write-Event "restored native root $threadId"
                        } catch { Write-Event "native root restoration failed for ${threadId}: $($_.Exception.Message)"; $restoreFailed=$true }
                    }
                    $loaded = @(Read-LoadedRoots)
                }
                $restorePending = [bool]$restoreFailed
                $savedThreads = if ($restorePending) { @($savedThreads + $loaded | Select-Object -Unique) } else { $loaded }
                Write-StateFile $snapshotFile @{ threadIds=$savedThreads }
                $healthy = $true; $lastHealthy = [DateTime]::UtcNow
            } catch {
                $healthy = $false
                if ($rpc) { $rpc.Dispose(); $rpc=$null }
                Write-Event "native probe unavailable: $($_.Exception.Message)"
                if (([DateTime]::UtcNow - $lastHealthy).TotalSeconds -gt 120) {
                    Write-Event 'native protocol unavailable for 120 seconds; restarting owned engine and relay'
                    Stop-Role engine; Stop-Role pipe; $lastHealthy = [DateTime]::UtcNow
                }
            }
            $nextProbe = [DateTime]::UtcNow.AddSeconds(10)
        }
        if ($healthy) { Ensure-Role native }
        $roleStatus = @{}
        foreach ($name in $roles.Keys) { $roleStatus[$name] = @{ pid=if($roles[$name].process){$roles[$name].process.Id}else{$null}; failures=$roles[$name].failures } }
        Write-StateFile 'D:\hapi\state\supervisor.json' @{ timestamp=[DateTime]::UtcNow.ToString('o'); pid=$PID; session=(Get-Process -Id $PID).SessionId; nativeReady=$healthy; restorePending=$restorePending; roles=$roleStatus }
        Start-Sleep -Seconds 1
    }
} finally {
    if ($rpc) { $rpc.Dispose() }
    foreach ($name in @('native','runner','pipe','engine')) { Stop-Role $name }
}
