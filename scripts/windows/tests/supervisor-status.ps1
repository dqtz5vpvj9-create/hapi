$ErrorActionPreference='Stop'
$PSStyle.OutputRendering='PlainText'
$source=Join-Path $PSScriptRoot '..\supervise.ps1'
$tokens=$null;$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'Supervisor candidate did not parse'}
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-StateFile'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
$statement=$ast.Find({param($node) $node -is [Management.Automation.Language.TryStatementAst] -and $node.Body.Extent.Text -match "^\{\s*Write-StateFile 'D:\\hapi\\state\\supervisor.json'"},$true)
if(-not $statement){throw 'Status publication handler not found'}
$testPath='D:\hapi\temp\hapi-supervisor-status-test.json'
$invoke=[scriptblock]::Create($statement.Extent.Text.Replace('D:\hapi\state\supervisor.json',$testPath))
$healthy=$true;$restorePending=$false;$roleStatus=@{}
[IO.File]::WriteAllText($testPath,'{"old":true}')
$reader=[IO.File]::Open($testPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {& $invoke;if(-not (Get-Content -LiteralPath $testPath -Raw|ConvertFrom-Json).old){throw 'Locked status was overwritten'}}finally{$reader.Dispose()}
& $invoke
if((Get-Content -LiteralPath $testPath -Raw|ConvertFrom-Json).pid -ne $PID){throw 'Status did not recover after reader closed'}
# A checkpoint write failure must not be classified as a native RPC failure.
$probe=$ast.Find({param($node) $node -is [Management.Automation.Language.TryStatementAst] -and $node.Body.Extent.Text -match '^\{\s*if \(-not \$rpc\)'},$true)
if(-not $probe){throw 'Native probe handler not found'}
$rpc=[pscustomobject]@{}
$savedThreads=@();$snapshotFile=$testPath;$restorePending=$false;$healthy=$false
function Read-LoadedRoots { @('test-root') }
$reader=[IO.File]::Open($testPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    . ([scriptblock]::Create($probe.Extent.Text))
    if(-not $healthy){throw 'Checkpoint contention was mistaken for a native protocol failure'}
    if($savedThreads -notcontains 'test-root'){throw 'In-memory native roots were lost'}
} finally {$reader.Dispose()}
$eventPath='D:\hapi\temp\hapi-supervisor-event-test.log'
$event=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Write-Event'},$true)
. ([scriptblock]::Create($event.Extent.Text.Replace('D:\hapi\logs\supervisor.log',$eventPath)))
[IO.File]::WriteAllText($eventPath,'prior event')
$reader=[IO.File]::Open($eventPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {Write-Event 'locked event'} finally {$reader.Dispose()}
Write-Event 'recovered event'
if((Get-Content -LiteralPath $eventPath -Raw) -notmatch 'recovered event'){throw 'Event publication did not recover'}
@{parsed=$true;readerLockDidNotExit=$true;statusRecovered=$true;checkpointPreservedNativeHealth=$true;eventLockDidNotExit=$true}|ConvertTo-Json
Remove-Item -LiteralPath $testPath,"$testPath.new",$eventPath -Force -ErrorAction SilentlyContinue
