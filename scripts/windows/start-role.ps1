param([Parameter(Mandatory)][ValidateSet('engine','pipe','runner','native')][string]$Role)
$ErrorActionPreference = 'Stop'
$env:TEMP = 'D:\hapi\temp'
$env:TMP = $env:TEMP
$log = "D:\hapi\logs\$Role-console.log"
try {
    if (Test-Path -LiteralPath $log) { Move-Item -LiteralPath $log -Destination "$log.previous" -Force }
    switch ($Role) {
        engine {
            . (Join-Path $PSScriptRoot 'resolve-codex.ps1')
            $executable = Resolve-HapiCodex
            Set-Location -LiteralPath 'D:\hapi\workspaces'
            & $executable -c features.code_mode_host=true app-server --listen unix:// *> $log
            exit $LASTEXITCODE
        }
        pipe { & (Join-Path $PSScriptRoot 'native-pipe.ps1') *> $log }
        default { & (Join-Path $PSScriptRoot 'start-hapi.ps1') -Role $Role *> $log }
    }
} catch {
    $_.Exception.ToString() | Add-Content -LiteralPath $log
    exit 1
}
