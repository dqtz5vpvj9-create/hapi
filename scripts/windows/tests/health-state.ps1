$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$state=Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw | ConvertFrom-Json
$processes=@(Get-CimInstance Win32_Process | Where-Object {($_.Name -eq 'codex.exe' -and $_.CommandLine -match 'app-server') -or $_.Name -eq 'hapi-20261004.exe'} | ForEach-Object {@{name=$_.Name;pid=$_.ProcessId;session=$_.SessionId;listens=$_.CommandLine -match '--listen';role=if($_.CommandLine -match 'runner start-sync'){'runner'}elseif($_.CommandLine -match '--native-daemon'){'native'}else{'engine'}}})
@{state=$state;processes=$processes} | ConvertTo-Json -Depth 8 -Compress
