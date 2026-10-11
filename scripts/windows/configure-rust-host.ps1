param(
    [string]$Root = 'D:\hapi',
    [string]$RunnerExecutable = 'D:\hapi\bin\hapi-20261004.exe',
    [string]$NativeExecutable = 'D:\hapi\bin\hapi-admission-20261009.exe',
    [string[]]$WorkspaceRoots = @($env:USERPROFILE, 'D:\', 'E:\', 'F:\')
)
$ErrorActionPreference = 'Stop'
$runnerArguments = @('runner', 'start-sync')
foreach ($workspace in $WorkspaceRoots) { $runnerArguments += @('--workspace-root', $workspace) }
$config = @{
    root = $Root
    codexInstallRoot = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')
    socketPath = (Join-Path $env:USERPROFILE '.codex\app-server-control\app-server-control.sock')
    pipeName = 'hapi-native-preview-20261004'
    connectionFile = (Join-Path $Root 'config\connection.json')
    pathPrefix = @('C:\nvm4w\nodejs', 'C:\Program Files\Git\cmd')
    roles = @{
        engine = @{ executable='@codex'; arguments=@('-c','features.code_mode_host=true','app-server','--listen','unix://'); directory=(Join-Path $Root 'workspaces') }
        runner = @{ executable=$RunnerExecutable; arguments=$runnerArguments; directory=$env:USERPROFILE; hubCredentials=$true }
        native = @{ executable=$NativeExecutable; arguments=@('codex','--native-daemon','ws+unix://localhost/\./pipe/hapi-native-preview-20261004:/rpc'); directory=$env:USERPROFILE; hubCredentials=$true }
    }
}
$destination = Join-Path $Root 'config\windows-host.json'
$config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $destination -Encoding utf8NoBOM
Write-Output "Configuration written: $destination. No task or process was changed."
