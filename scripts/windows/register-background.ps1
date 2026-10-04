$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$action = New-ScheduledTaskAction -Execute (Get-Command pwsh.exe).Source -Argument '-NoLogo -NoProfile -NonInteractive -File D:\hapi\scripts\task-host.ps1' -WorkingDirectory 'D:\hapi'
Register-ScheduledTask -TaskName 'HAPI-background' -Principal $principal -Action $action -Settings $settings -Trigger $triggers -Force | Out-Null
Start-ScheduledTask -TaskName 'HAPI-background'
Get-ScheduledTask -TaskName 'HAPI-background' | Select-Object TaskName,State | ConvertTo-Json
