$ErrorActionPreference='Stop'
$env:TEMP='D:\hapi\temp'
$env:TMP=$env:TEMP
$env:CODEX_APP_SERVER_WS_URL='ws+unix://localhost/\./pipe/hapi-native-preview-20261004:/rpc'
Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HapiEnvironmentNotice {
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern IntPtr SendMessageTimeout(IntPtr hwnd,uint message,UIntPtr wparam,string lparam,uint flags,uint timeout,out UIntPtr result);
}
'@
$result=[UIntPtr]::Zero
[void][HapiEnvironmentNotice]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,5000,[ref]$result)
$desktopSession=(Get-Process -Id $PID).SessionId
if(Get-Process ChatGPT -ErrorAction SilentlyContinue | Where-Object {$_.SessionId -eq $desktopSession}){exit 0}
$deadline=[DateTime]::UtcNow.AddSeconds(60)
Add-Type -Path (Join-Path $PSScriptRoot 'NativeRpc.cs')
do {
 $client=$null
 try{$client=[HapiNativeRpc]::Connect('hapi-native-preview-20261004').GetAwaiter().GetResult();$ready=$true}catch{$ready=$false}finally{if($client){$client.Dispose()}}
 if(-not $ready){Start-Sleep -Milliseconds 500}
}while(-not $ready -and [DateTime]::UtcNow -lt $deadline)
if(-not $ready){throw 'Codex local relay is not ready'}
$package=Get-AppxPackage -Name 'OpenAI.Codex'
Start-Process -FilePath (Join-Path $package.InstallLocation 'app\ChatGPT.exe')
