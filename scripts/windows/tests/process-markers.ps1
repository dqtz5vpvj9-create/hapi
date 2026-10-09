param(
    [Parameter(Mandatory=$true)][string]$Probe,
    [int]$TargetPid = 0,
    [string]$Report
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
    $samplePid = if ($TargetPid -gt 0) { $TargetPid } else { $PID }
    $processInfo = [Diagnostics.Process]::GetProcessById($samplePid)
    try { $creation = $processInfo.StartTime.ToUniversalTime() } finally { $processInfo.Dispose() }
    $expected = ([DateTime]::new($creation.Ticks - ($creation.Ticks % 10), [DateTimeKind]::Utc)).ToString('o')
    $durations = @()
    for ($iteration=0; $iteration -lt 100; $iteration++) {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $output = & $Probe ([string]$samplePid) '4294967295'
        $exitCode = $LASTEXITCODE
        $durations += $watch.Elapsed.TotalMilliseconds
        if ($exitCode -ne 0) { throw "Process probe exited $exitCode" }
        $rows = @($output | ConvertFrom-Json)
        # PowerShell 7 can parse ISO JSON strings into DateTime automatically.
        # Compare the raw serialized marker as well as the parsed PID.
        if ($rows.Count -ne 1 -or $rows[0].ProcessId -ne $samplePid -or !$output.Contains('"CreationDate":"' + $expected + '"')) {
            throw 'Native generation differs from the existing CIM marker format'
        }
    }
    # Retain the OS handle so the exited process object can still be opened.
    # This tests liveness independently of whether Windows has recycled its PID.
    $child = [Diagnostics.Process]::Start('C:\Windows\System32\cmd.exe', '/c exit 0')
    try {
        $retainedHandle = $child.SafeHandle
        $child.WaitForExit()
        $output = & $Probe ([string]$child.Id)
        if ($LASTEXITCODE -ne 0 -or @($output | ConvertFrom-Json).Count -ne 0) { throw 'Exited PID was accepted as live' }
    } finally { $child.Dispose() }
    # Reproduce a stale PID whose retained process object denies OpenProcess.
    # A live inaccessible process must fail; the same object after exit must
    # be excluded using the OS running-process snapshot.
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class HapiProbeAclFixture {
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool InitializeSecurityDescriptor(IntPtr descriptor, uint revision);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool InitializeAcl(IntPtr acl, uint size, uint revision);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetSecurityDescriptorDacl(IntPtr descriptor, bool present, IntPtr acl, bool defaulted);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle, uint info, IntPtr descriptor);
 public static void DenyQueries(Process child) {
  IntPtr descriptor=Marshal.AllocHGlobal(64), acl=Marshal.AllocHGlobal(8);
  try {
   if(!InitializeSecurityDescriptor(descriptor,1)||!InitializeAcl(acl,8,2)||!SetSecurityDescriptorDacl(descriptor,true,acl,false)||!SetKernelObjectSecurity(child.Handle,4,descriptor))
    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  } finally { Marshal.FreeHGlobal(descriptor); Marshal.FreeHGlobal(acl); }
 }
}
'@
    $restricted = [Diagnostics.Process]::Start((Get-Command pwsh.exe).Source, '-NoLogo -NoProfile -NonInteractive -Command Start-Sleep -Seconds 60')
    try {
        $held = $restricted.SafeHandle
        Start-Sleep -Seconds 1
        [HapiProbeAclFixture]::DenyQueries($restricted)
        $denied = & $Probe ([string]$restricted.Id)
        if ($LASTEXITCODE -eq 0 -or ($denied | ConvertFrom-Json).error -notmatch 'failed: 5') { throw ('Live inaccessible PID was accepted: '+$denied+' exited='+$restricted.HasExited) }
        $restricted.Kill(); $restricted.WaitForExit()
        $output = & $Probe ([string]$restricted.Id)
        if ($LASTEXITCODE -ne 0 -or @($output | ConvertFrom-Json).Count -ne 0) { throw 'Exited inaccessible PID blocks discovery' }
    } finally { if (!$restricted.HasExited) { $restricted.Kill() }; $restricted.Dispose() }
    $invalidOutput = & $Probe 'invalid' 2>$null
    if ($LASTEXITCODE -eq 0) { throw 'Invalid PID was accepted' }
    $ordered = @($durations | Sort-Object)
    $result = @{ passed=$true; pid=$samplePid; marker=$expected; coldMs=$durations[0]; p50Ms=$ordered[49]; p95Ms=$ordered[94]; maxMs=$ordered[-1]; count=$durations.Count; session=(Get-Process -Id $PID).SessionId }
    $json = $result | ConvertTo-Json
    if ($Report) { $json | Set-Content -LiteralPath $Report -Encoding utf8 }
    $json
    exit 0
} catch { Write-Error $_; exit 1 }
