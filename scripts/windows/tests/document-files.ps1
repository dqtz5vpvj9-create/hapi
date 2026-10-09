param([Parameter(Mandatory)][string]$ProbeExe, [Parameter(Mandatory)][string]$TestRoot)
$ErrorActionPreference='Stop'
$directory=Join-Path $TestRoot ('document-smoke-'+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $directory | Out-Null
$path=Join-Path $directory "notes 中文 ' `$file.txt"
try {
    Set-Content -LiteralPath $path -Value 'HAPI document release original' -Encoding utf8
    $acl=Get-Acl -LiteralPath $path
    $acl.SetAccessRuleProtection($true,$true)
    Set-Acl -LiteralPath $path -AclObject $acl
    $before=(Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    & $ProbeExe $path
    if($LASTEXITCODE -ne 0){throw 'File save/readback/conflict check failed'}
    $after=(Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if($before -ne $after){throw 'Explicit file ACL changed by save'}
    $deny=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'Write','Deny')
    $acl.AddAccessRule($deny)
    Set-Acl -LiteralPath $path -AclObject $acl
    try {
        $nativeDenied=$false
        try { $handle=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite); $handle.Dispose() }
        catch [UnauthorizedAccessException] { $nativeDenied=$true }
        if(!$nativeDenied){throw 'Invalid ACL fixture: .NET write-open should be denied'}
        & $ProbeExe $path --expect-denied
        if($LASTEXITCODE -ne 0){throw 'File write-denial check failed'}
    } finally { $acl.RemoveAccessRuleSpecific($deny); Set-Acl -LiteralPath $path -AclObject $acl }
    @{passed=$true;aclPreserved=$true;writeDenied=$true;account=[Security.Principal.WindowsIdentity]::GetCurrent().Name;session=(Get-Process -Id $PID).SessionId} | ConvertTo-Json
} finally {
    if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path}
    Remove-Item -LiteralPath $directory
}
