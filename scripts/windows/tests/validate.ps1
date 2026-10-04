$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$files=@('task-host.ps1','supervise.ps1','start-role.ps1','start-hapi.ps1','resolve-codex.ps1','register-background.ps1','persist-startup.ps1','launch-app.ps1','native-pipe.ps1')
foreach($file in $files){[void][scriptblock]::Create((Get-Content -LiteralPath (Join-Path 'D:\hapi\scripts' $file) -Raw))}
Add-Type -Path 'D:\hapi\scripts\TaskHost.cs'
Add-Type -Path 'D:\hapi\scripts\NativeRpc.cs'
$before=Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw|ConvertFrom-Json
1..10|ForEach-Object{Start-ScheduledTask -TaskName 'HAPI-background'}
Start-Sleep -Seconds 3
$after=Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw|ConvertFrom-Json
$instances=@(Get-CimInstance Win32_Process|Where-Object{$_.Name -eq 'pwsh.exe' -and $_.CommandLine -match '-File D:\\hapi\\scripts\\supervise.ps1'})
if($before.pid -ne $after.pid -or $instances.Count -ne 1){throw 'Repeated task dispatch created duplicate supervisors'}
$result=@{powershellScriptsParsed=$files.Count;csharpHelpersCompiled=2;repeatedDispatches=10;supervisors=$instances.Count;pidUnchanged=$before.pid -eq $after.pid;session=$after.session;nativeReady=$after.nativeReady}
$result|ConvertTo-Json|Set-Content -LiteralPath 'D:\hapi\logs\ha-validation.json'
$result|ConvertTo-Json
