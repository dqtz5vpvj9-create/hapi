$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$desktopSession = (Get-Process -Id $PID).SessionId
$package = Get-AppxPackage -Name 'OpenAI.Codex'
$application = @((Get-AppxPackageManifest -Package $package.PackageFullName).Package.Applications.Application)[0]
$results = @()
try {
    for ($round=1; $round -le 3; $round++) {
        $stateBefore=Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw | ConvertFrom-Json
        $processes=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'ChatGPT.exe' -and $_.SessionId -eq $desktopSession -and $_.ExecutablePath.StartsWith($package.InstallLocation, [StringComparison]::OrdinalIgnoreCase)})
        $ids=@($processes.ProcessId)
        $main=@($processes | Where-Object {$_.ParentProcessId -notin $ids})
        foreach ($row in $main) {
            $process=Get-Process -Id $row.ProcessId
            $closed=$process.CloseMainWindow()
            if (-not $closed -or -not $process.WaitForExit(8000)) { $process.Kill($true); [void]$process.WaitForExit(10000) }
        }
        Start-Sleep -Seconds 2
        # Activate the original package entry point, as Start menu does. Do not
        # inject an endpoint here: normal user-environment configuration is tested.
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\'+$package.PackageFamilyName+'!'+$application.Id)
        Start-Sleep -Seconds 12
        $new=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'ChatGPT.exe' -and $_.SessionId -eq $desktopSession -and $_.ExecutablePath.StartsWith($package.InstallLocation,[StringComparison]::OrdinalIgnoreCase)})
        $servers=@(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'codex.exe' -and $_.CommandLine -match 'app-server'})
        $stateAfter=Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw | ConvertFrom-Json
        $result=@{round=$round;desktopSession=$desktopSession;appStarted=$new.Count -gt 0;engineUnchanged=$stateBefore.roles.engine.pid -eq $stateAfter.roles.engine.pid;engineCount=$servers.Count;allServersInBackground=@($servers | Where-Object {$_.SessionId -ne 0}).Count -eq 0;nativeReady=$stateAfter.nativeReady}
        $results+=$result
        $results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath 'D:\hapi\logs\app-cycles.json'
        if (-not $result.appStarted -or -not $result.engineUnchanged -or $result.engineCount -ne 1 -or -not $result.allServersInBackground -or -not $result.nativeReady) { throw 'Official application restart failed' }
    }
} catch { @{error=$_.Exception.Message;results=$results} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath 'D:\hapi\logs\app-cycles.json'; exit 1 }
