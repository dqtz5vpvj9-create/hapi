$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$action=New-ScheduledTaskAction -Execute (Get-Command pwsh.exe).Source -Argument '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File D:\hapi\scripts\launch-app.ps1' -WorkingDirectory 'D:\hapi'
Register-ScheduledTask -TaskName 'HAPI-desktop' -Action $action -Principal $principal -Settings $settings -Trigger $trigger -Force | Out-Null
# Keep the old task definitions for rollback, but never start a second engine.
foreach($name in @('HapiNativePreviewStart20261004','HapiNativePreviewPipe20261004','HapiNativePreviewApp20261004','HAPI-runner','HAPI-native')){
 if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){Disable-ScheduledTask -TaskName $name | Out-Null}
}
$previous=@{endpoint=[Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','User')}
if(-not(Test-Path 'D:\hapi\config\desktop-environment-before.json')){$previous|ConvertTo-Json|Set-Content 'D:\hapi\config\desktop-environment-before.json'}
[Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL','ws+unix://localhost/\./pipe/hapi-native-preview-20261004:/rpc','User')
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex + HAPI.lnk'))
$link.TargetPath=(Get-Command pwsh.exe).Source
$link.Arguments='-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File D:\hapi\scripts\launch-app.ps1'
$link.WorkingDirectory='D:\hapi';$link.Save()
foreach($name in @('HAPI-background','HAPI-desktop')){
 $t=Get-ScheduledTask -TaskName $name
 @{name=$name;state=[string]$t.State;triggers=@($t.Triggers).Count;user=$t.Principal.UserId;level=[string]$t.Principal.RunLevel;logon=[string]$t.Principal.LogonType;script=$t.Actions.Arguments}|ConvertTo-Json -Compress
}
