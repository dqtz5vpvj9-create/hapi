import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const windowsReplace = `param([string]$Source,[string]$Destination,[string]$ExpectedHash,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
try {
    # Check actual write access with the Windows API, including explicit deny ACLs.
    try { $handle=[IO.File]::Open($Destination,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)); $handle.Dispose() }
    catch [UnauthorizedAccessException] { exit 4 }
    if($CheckOnly){exit 0}
    # Process startup must not widen the revision-check window.
    $stream=[IO.File]::OpenRead($Destination)
    $sha=[Security.Cryptography.SHA256]::Create()
    try { $actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    if($actual -ne $ExpectedHash){exit 3}
    # ReplaceFile preserves the destination DACL and metadata. Ordinary rename does not.
    [IO.File]::Replace($Source,$Destination,[NullString]::Value,$false)
    exit 0
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`

async function runWindowsFileOperation(args: string[]): Promise<'saved' | 'conflict' | 'denied'> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-document-replace-'))
    try {
        const script = join(directory, 'replace.ps1')
        await writeFile(script, windowsReplace)
        try {
            await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, ...args],
            { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 })
            return 'saved'
        } catch (error) {
            if ((error as { code?: number }).code === 3) return 'conflict'
            if ((error as { code?: number }).code === 4) return 'denied'
            throw error
        }
    } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function canWriteWindowsDocument(path: string): Promise<boolean> {
    return await runWindowsFileOperation(['-Destination', path, '-CheckOnly']) === 'saved'
}

export async function replaceDocumentFile(source: string, destination: string, expectedHash: string): Promise<'saved' | 'conflict' | 'denied'> {
    if (process.platform !== 'win32') { await rename(source, destination); return 'saved' }
    return runWindowsFileOperation(['-Source', source, '-Destination', destination, '-ExpectedHash', expectedHash])
}
