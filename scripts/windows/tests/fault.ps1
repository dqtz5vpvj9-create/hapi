param([Parameter(Mandatory)][ValidateSet('engine','pipe','native','runner','supervisor')][string]$Role)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$state=Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw | ConvertFrom-Json
if (([DateTime]::UtcNow-[DateTime]::Parse($state.timestamp)).TotalSeconds -gt 30) { throw 'Supervisor status is stale' }
$targetId=if($Role -eq 'supervisor'){$state.pid}else{$state.roles.$Role.pid}
$target=Get-CimInstance Win32_Process -Filter "ProcessId=$targetId"
if (-not $target -or $target.SessionId -ne 0) { throw 'Target is not the managed background role' }
if ($Role -eq 'supervisor') {
    if ($target.Name -ne 'pwsh.exe' -or $target.CommandLine -notmatch 'supervise.ps1') { throw 'Unexpected supervisor command' }
} elseif ($Role -eq 'runner' -and $target.ExecutablePath -eq 'D:\hapi\bin\hapi-20261004.exe' -and $target.CommandLine -match 'runner start-sync') {
    # The supervisor can adopt Runner after its original wrapper exits.
} elseif ($target.Name -ne 'pwsh.exe' -or $target.CommandLine -notmatch "start-role.ps1 -Role $Role") { throw 'Unexpected role command' }
$before=@(Get-CimInstance Win32_Process | Where-Object {$_.SessionId -eq 0 -and $_.Name -in @('codex.exe','hapi-20261004.exe')} | Select-Object Name,ProcessId)
$at=[DateTime]::UtcNow
Stop-Process -Id $targetId -Force
@{role=$Role;oldPid=$targetId;at=$at.ToString('o');before=$before}|ConvertTo-Json -Depth 5
