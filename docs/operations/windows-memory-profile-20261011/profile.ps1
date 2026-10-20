$ErrorActionPreference='Stop'
try {
 $state=Get-Content -LiteralPath 'D:\hapi\state\supervisor.json' -Raw | ConvertFrom-Json
 $runner=Get-Content -LiteralPath 'D:\hapi\state\runner.state.json' -Raw | ConvertFrom-Json
 $all=@(Get-CimInstance Win32_Process)
 $roots=@($all | Where-Object { $_.ExecutablePath -like 'D:\hapi\*' -or $_.CommandLine -match 'D:\\hapi\\scripts\\(task-host|supervise|start-role|start-hapi|native-pipe)\.ps1' } | ForEach-Object { [int]$_.ProcessId })
 $included=[System.Collections.Generic.HashSet[int]]::new()
 foreach($processId in $roots){[void]$included.Add($processId)}
 do { $changed=$false; foreach($row in $all){if($included.Contains([int]$row.ParentProcessId) -and $included.Add([int]$row.ProcessId)){$changed=$true}} } while($changed)
 $records=@(foreach($row in $all){
   if(-not $included.Contains([int]$row.ProcessId) -and $row.Name -notmatch '^(pwsh|powershell|codex|hapi.*|ChatGPT|node|python.*)\.exe$'){continue}
   $label='other';$command=$row.CommandLine
   if($command -match 'task-host\.ps1'){$label='task-host'}
   elseif($command -match 'supervise\.ps1'){$label='supervisor'}
   elseif($command -match 'start-role\.ps1.*-Role\s+(\w+)'){$label='wrapper-'+$Matches[1]}
   elseif($command -match 'start-hapi\.ps1.*-Role\s+(\w+)'){$label='wrapper-'+$Matches[1]}
   elseif($command -match 'native-pipe\.ps1'){$label='pipe-relay'}
   elseif($command -match 'runner\s+start-sync'){$label='hapi-runner'}
   elseif($command -match '--native-daemon'){$label='hapi-native-bridge'}
   elseif($row.Name -match '^hapi'){$label='hapi-other'}
   elseif($command -match 'app-server'){$label='codex-app-server'}
   elseif($command -match 'mcp'){$label='mcp-tool'}
   elseif($row.Name -match '^codex'){$label='codex-other'}
   [pscustomobject]@{pid=[int]$row.ProcessId;parent=[int]$row.ParentProcessId;name=$row.Name;role=$label;hapiTree=$included.Contains([int]$row.ProcessId);session=[int]$row.SessionId;created=$row.CreationDate.ToUniversalTime().ToString('O');executable=$row.ExecutablePath}
 })
 $samples=@(for($sample=0;$sample -lt 4;$sample++){
   $perf=@{};foreach($counter in @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)){ $perf[[int]$counter.IDProcess]=$counter }
   $metrics=@(foreach($row in $records){$process=Get-Process -Id $row.pid -ErrorAction SilentlyContinue;if($null -eq $process){continue};$counter=$perf[$row.pid];[pscustomobject]@{pid=$row.pid;ws=$process.WorkingSet64;privateBytes=$process.PrivateMemorySize64;privateWs=if($null -ne $counter){[long]$counter.WorkingSetPrivate}else{$null};cpuSeconds=$process.CPU;handles=$process.HandleCount;threads=$process.Threads.Count}})
   [pscustomobject]@{utc=[DateTime]::UtcNow.ToString('O');metrics=$metrics}
   if($sample -lt 3){Start-Sleep -Seconds 3}
 })
 $loadedFile='D:\hapi\state\native-loaded-roots.json'
 $saved=if(Test-Path -LiteralPath $loadedFile){Get-Content -LiteralPath $loadedFile -Raw|ConvertFrom-Json}else{$null}
 $output=[pscustomobject]@{utc=[DateTime]::UtcNow.ToString('O');samplerPid=$PID;psVersion=$PSVersionTable.PSVersion.ToString();supervisor=$state;runnerPid=$runner.pid;processes=$records;samples=$samples;savedRootCount=@($saved.threadIds).Count}
 $json=$output|ConvertTo-Json -Depth 12
 $json|Set-Content -LiteralPath 'D:\hapi\temp\memory-profile-20261011.json' -Encoding utf8
 $json
 exit 0
} catch { Write-Error $_;exit 1 }
