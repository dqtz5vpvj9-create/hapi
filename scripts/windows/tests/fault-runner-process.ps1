$ErrorActionPreference='Stop'
$state=Get-Content -LiteralPath 'D:\hapi\state\runner.state.json' -Raw|ConvertFrom-Json
$target=Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
if(-not $target -or $target.ExecutablePath -ne 'D:\hapi\bin\hapi-20261004.exe' -or $target.CommandLine -notmatch 'runner start-sync' -or $target.SessionId -ne 0){throw 'Runner identity mismatch'}
Stop-Process -Id $state.pid -Force
@{oldPid=$state.pid;at=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json
