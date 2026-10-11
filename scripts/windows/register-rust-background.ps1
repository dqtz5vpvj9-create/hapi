param(
    [Parameter(Mandatory)][string]$Executable,
    [string]$Config = 'D:\hapi\config\windows-host.json',
    [switch]$Start
)
$ErrorActionPreference = 'Stop'
$existing = Get-ScheduledTask -TaskName 'HAPI-background' -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') {
    throw 'The background task is running. Drain active sessions and stop it explicitly before replacing its ownership tree. This installer never kills Codex.'
}
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Native host executable not found' }
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Native host configuration not found' }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $user),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$action = New-ScheduledTaskAction -Execute $Executable -Argument "bootstrap --config `"$Config`"" -WorkingDirectory (Split-Path (Split-Path $Config))
Register-ScheduledTask -TaskName 'HAPI-background' -Principal $principal -Action $action -Settings $settings -Trigger $triggers -Force | Out-Null
if ($Start) { Start-ScheduledTask -TaskName 'HAPI-background' }
Get-ScheduledTask -TaskName 'HAPI-background' | Select-Object TaskName,State | ConvertTo-Json
