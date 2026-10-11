param(
    [Parameter(Mandatory)][string]$HostExecutable,
    [Parameter(Mandatory)][string]$FixtureExecutable,
    [string]$TemporaryRoot = 'D:\hapi\temp'
)
$ErrorActionPreference = 'Stop'
$PSStyle.OutputRendering = 'PlainText'
$runId = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$trial = Join-Path $TemporaryRoot "rust-$runId"
$taskName = "HAPI-Rust-Test-$runId"
$checks = [Collections.Generic.List[string]]::new()
$taskInstalled = $false
$productionBefore = if (Test-Path -LiteralPath 'D:\hapi\state\supervisor.json') {
    Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw | ConvertFrom-Json
} else { $null }

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $checks.Add($Message)
    Write-Host "PASS: $Message"
}
function Wait-Until([scriptblock]$Condition, [string]$Message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timeout: $Message"
}
function Read-State {
    $path = Join-Path $trial 'state\supervisor.json'
    if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
}
function Read-Identity([string]$Role) {
    $path = Join-Path $trial "state\$Role-identity.json"
    if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
}
function Is-Alive([int]$ProcessId) { $ProcessId -gt 0 -and $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) }

try {
    foreach ($directory in @('logs', 'state', 'temp', 'codex\fixture-version')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $trial $directory) | Out-Null
    }
    # Fake installed Codex directory: never resolve or start the user's engine.
    Copy-Item -LiteralPath $FixtureExecutable -Destination (Join-Path $trial 'codex\fixture-version\codex.exe')
    $fakeCodex = Join-Path $trial 'codex\fixture-version\codex.exe'
    $roleExe = Join-Path $trial 'hapi-host-fixture.exe'
    Copy-Item -LiteralPath $FixtureExecutable -Destination $roleExe
    $socket = Join-Path $trial 'native.sock'
    $roles = @{}
    foreach ($role in @('engine', 'runner', 'native')) {
        $roleArguments = if ($role -eq 'engine') { @('engine', $socket) } else { @($role, 'two words', '', 'quote"value', '中文路径', 'D:\space path\') }
        $roles[$role] = @{ executable=if($role -eq 'engine'){'@codex'}else{$roleExe}; arguments=$roleArguments; directory=$trial }
    }
    $config = @{ root=$trial; codexInstallRoot=(Join-Path $trial 'codex'); socketPath=$socket; pipeName="hapi-rust-$runId"; connectionFile=(Join-Path $trial 'unused.json'); pathPrefix=@(); roles=$roles }
    $configFile = Join-Path $trial 'host.json'
    $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configFile -Encoding utf8NoBOM
    @{ threadIds=@('restore-root','already-loaded','child-root','archived-root','deleted-root') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $trial 'state\native-loaded-roots.json') -Encoding utf8NoBOM
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
    $action = New-ScheduledTaskAction -Execute $HostExecutable -Argument "bootstrap --config `"$configFile`"" -WorkingDirectory $trial
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Principal $principal -Action $action -Settings $settings -Force | Out-Null
    $taskInstalled = $true
    Start-ScheduledTask -TaskName $taskName
    Wait-Until { $state = Read-State; $state -and $state.nativeReady -and $state.roles.native.pid } 'all isolated roles ready'
    $state = Read-State
    Assert-That ($state.session -eq 0) 'Supervisor runs in Session 0'
    foreach ($role in @('engine', 'runner', 'native')) {
        Wait-Until { $null -ne (Read-Identity $role) } "$role identity"
        $identity = Read-Identity $role
        Assert-That (-not $identity.administrator -and $identity.integrity -eq 8192 -and $identity.session -eq 0) "$role has medium, non-admin Session 0 token"
    }
    $processArgs = @('probe', '--config', $configFile)
    $probe = & $HostExecutable @processArgs
    if ($LASTEXITCODE -ne 0) { throw 'Native pipe/WebSocket probe failed' }
    $loaded = $probe | ConvertFrom-Json
    Assert-That ($loaded.data -contains 'restore-root') 'Same-user pipe and AF_UNIX relay perform WebSocket RPC'
    $requests = @(Get-Content -LiteralPath (Join-Path $trial 'state\requests.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    $resumes = @($requests | Where-Object method -eq 'thread/resume')
    Assert-That ($resumes.Count -eq 1 -and $resumes[0].params.threadId -eq 'restore-root' -and $resumes[0].params.excludeTurns) 'Only persisted root restored; loaded, child, archived and deleted roots skipped'
    Assert-That (@($requests | Where-Object { $_.method -in @('turn/start','thread/queue/add','tools/call') }).Count -eq 0) 'Recovery never submits a model turn, tool call or user message'
    $received = @(Get-Content -LiteralPath (Join-Path $trial 'state\native-arguments.json') -Raw | ConvertFrom-Json)
    Assert-That (($received | ConvertTo-Json -Compress) -eq (@('native', 'two words', '', 'quote"value', '中文路径', 'D:\space path\') | ConvertTo-Json -Compress)) 'Native argument boundaries preserve spaces, empty strings, quotes, Unicode and trailing slash'
    $clientArguments = @('clients', "\\.\pipe\hapi-rust-$runId")
    $clientResult = & $roleExe @clientArguments
    if ($LASTEXITCODE -ne 0) { throw 'Concurrent pipe fixture failed' }
    Assert-That (($clientResult | ConvertFrom-Json).concurrentClients -eq 32) '32 concurrent native clients receive RPC without exhausting the listener'

    # Repeated task dispatch and direct second-supervisor attempts must not
    # create a duplicate engine or replace the working pipe.
    $originalEngine = $state.roles.engine.pid
    1..3 | ForEach-Object { Start-ScheduledTask -TaskName $taskName }
    $duplicateArgs = @('supervise', '--config', $configFile)
    & $HostExecutable @duplicateArgs 2>$null
    $duplicateCode = $LASTEXITCODE
    Assert-That ($duplicateCode -ne 0 -and (Read-State).roles.engine.pid -eq $originalEngine) 'Duplicate supervisor/dispatch cannot launch another engine'

    # Handoff simulates Runner replacing itself while detached sessions live.
    $runnerLeaf = (Read-Identity 'runner-leaf').pid
    $oldRunner = (Read-State).roles.runner.pid
    New-Item -ItemType File -Path (Join-Path $trial 'state\runner-handoff') | Out-Null
    Wait-Until { $current = Read-State; $current.roles.runner.pid -ne $oldRunner -and $current.roles.runner.pid -eq (Read-Identity 'runner').pid } 'Runner handoff adoption'
    Assert-That (Is-Alive $runnerLeaf) 'Runner handoff retains existing detached session'
    $runnerNow = (Read-State).roles.runner.pid
    Stop-Process -Id $runnerNow -Force
    Wait-Until { $current = Read-State; $current.roles.runner.pid -and $current.roles.runner.pid -ne $runnerNow -and (Is-Alive $current.roles.runner.pid) } 'Runner fault recovery'
    Assert-That (Is-Alive $runnerLeaf) 'Runner restart retains existing detached session'

    $engineLeaf = (Read-Identity 'engine-leaf').pid
    Stop-Process -Id $originalEngine -Force
    Wait-Until { -not (Is-Alive $engineLeaf) } 'engine child cleanup'
    Wait-Until { $current = Read-State; $current.roles.engine.pid -and $current.roles.engine.pid -ne $originalEngine -and $current.nativeReady -and (Is-Alive $current.roles.engine.pid) } 'engine fault recovery'
    Assert-That (-not (Is-Alive $engineLeaf)) 'Engine fault kills owned descendants before recovery'
    $nativeNow = (Read-State).roles.native.pid
    $nativeLeaf = (Read-Identity 'native-leaf').pid
    Stop-Process -Id $nativeNow -Force
    Wait-Until { $current = Read-State; $current.roles.native.pid -and $current.roles.native.pid -ne $nativeNow -and (Is-Alive $current.roles.native.pid) } 'native bridge recovery'
    Wait-Until { -not (Is-Alive $nativeLeaf) } 'native child cleanup'
    Assert-That (-not (Is-Alive $nativeLeaf)) 'Native bridge fault cleans up its owned descendants'

    # Deny replacement of observational state. This must not kill live roles.
    $lockedState = [IO.File]::Open((Join-Path $trial 'state\supervisor.json'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { Start-Sleep -Seconds 3 } finally { $lockedState.Dispose() }
    Assert-That ((Is-Alive (Read-State).pid) -and (Read-State).nativeReady) 'Contended state publication does not terminate supervisor or engine'

    $hostRows = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $HostExecutable -and $_.CommandLine -like "*$configFile*" })
    Assert-That ($hostRows.Count -eq 2) 'Exactly two native resident hosts; no PowerShell role wrappers'
    $samples = foreach ($sampleNumber in 1..4) {
        $rows = @($hostRows | ForEach-Object { $process = Get-Process -Id $_.ProcessId; @{ pid=$process.Id; workingSet=$process.WorkingSet64; privateCommit=$process.PrivateMemorySize64; threads=$process.Threads.Count; handles=$process.HandleCount } })
        @{ hosts=$rows; workingSet=($rows.workingSet | Measure-Object -Sum).Sum; privateCommit=($rows.privateCommit | Measure-Object -Sum).Sum }
        Start-Sleep -Milliseconds 250
    }
    $ownedPids = @((Read-State).pid, (Read-State).roles.engine.pid, (Read-State).roles.runner.pid, (Read-State).roles.native.pid, $runnerLeaf, (Read-Identity 'engine-leaf').pid, (Read-Identity 'native-leaf').pid, (Read-Identity 'runner-leaf').pid)
    Assert-That (@($ownedPids | Where-Object { -not $_ }).Count -eq 0) 'Cleanup checks use recorded nonzero process identities'
    Stop-Process -Id (Read-State).pid -Force
    Wait-Until { @($ownedPids | Where-Object { Is-Alive $_ }).Count -eq 0 } 'outer job cleanup'
    Assert-That (@($ownedPids | Where-Object { Is-Alive $_ }).Count -eq 0) 'Supervisor crash leaves no owned backend process behind'
    Wait-Until { (Get-ScheduledTask -TaskName $taskName).State -ne 'Running' } 'bootstrap exits after supervisor fault'
    $leftovers = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -in @($roleExe, $fakeCodex) -or ($_.ExecutablePath -eq $HostExecutable -and $_.CommandLine -like "*$configFile*") })
    Assert-That ($leftovers.Count -eq 0) 'Complete isolated process inventory has no unrecorded orphan'

    if ($productionBefore) {
        $productionAfter = Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw | ConvertFrom-Json
        Assert-That ($productionAfter.pid -eq $productionBefore.pid -and $productionAfter.roles.engine.pid -eq $productionBefore.roles.engine.pid -and $productionAfter.roles.runner.pid -eq $productionBefore.roles.runner.pid -and $productionAfter.roles.native.pid -eq $productionBefore.roles.native.pid) 'Production supervisor, engine, Runner and bridge generations unchanged'
    }
    $report = @{ passed=$true; checks=$checks; memorySamples=$samples; trial=$trial; timestamp=[DateTime]::UtcNow.ToString('o') }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $trial 'report.json') -Encoding utf8NoBOM
    $report | ConvertTo-Json -Depth 8 -Compress
} catch {
    Write-Error $_ -ErrorAction Continue
    if (Test-Path -LiteralPath (Join-Path $trial 'logs\supervisor.log')) { Get-Content -LiteralPath (Join-Path $trial 'logs\supervisor.log') -Tail 12 }
    exit 1
} finally {
    if ($taskInstalled) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
}
