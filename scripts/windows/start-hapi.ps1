param([ValidateSet('runner','native')][string]$Role)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$config=Get-Content -LiteralPath 'D:\hapi\config\connection.json' -Raw | ConvertFrom-Json
$env:HAPI_API_URL=$config.hub
$env:CLI_API_TOKEN=$config.token
$env:HAPI_HOME='D:\hapi\state'
$env:TEMP='D:\hapi\temp';$env:TMP=$env:TEMP
. (Join-Path $PSScriptRoot 'resolve-codex.ps1')
$env:PATH=(Split-Path (Resolve-HapiCodex))+';C:\nvm4w\nodejs;C:\Program Files\Git\cmd;'+$env:PATH
Set-Location -LiteralPath $env:USERPROFILE
if($Role -eq 'runner'){
 & 'D:\hapi\bin\hapi-20261004.exe' runner start-sync --workspace-root 'C:\Users\lixinrui' --workspace-root 'D:\'
}else{
 & 'D:\hapi\bin\hapi-native-20261005.exe' codex --native-daemon 'ws+unix://localhost/\./pipe/hapi-native-preview-20261004:/rpc'
}
exit $LASTEXITCODE
