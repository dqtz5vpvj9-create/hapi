$ErrorActionPreference = 'Stop'
$env:TEMP = 'D:\hapi\temp'
$env:TMP = $env:TEMP
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'TaskHost.cs')
    exit [HapiTaskHost]::Run((Get-Command pwsh.exe).Source, '-NoLogo -NoProfile -NonInteractive -File D:\hapi\scripts\supervise.ps1', 'D:\hapi')
} catch {
    ('{0:o} {1}' -f [DateTime]::UtcNow, $_.Exception.ToString()) | Add-Content -LiteralPath 'D:\hapi\logs\task-host.log'
    exit 1
}
