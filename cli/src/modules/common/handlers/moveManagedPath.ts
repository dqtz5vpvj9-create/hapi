import { execFile } from 'node:child_process'
import { lstat, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { FileManagementError } from '../managedPaths'

const execute = promisify(execFile)
const windowsMove = `param([string]$Source,[string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HapiFileMove { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileW(string source, string destination); }'
if ([HapiFileMove]::MoveFileW($Source,$Destination)) { exit 0 }
$errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($errorCode -eq 80 -or $errorCode -eq 183) { exit 3 }
if ($errorCode -eq 17) { exit 4 }
throw "MoveFile failed with Windows error $errorCode"
`

/**
 * Node rename can overwrite a raced destination. Use only fixed, no-clobber helpers and
 * verify the moved inode. Never fall back to copy-and-delete or ordinary rename.
 */
export async function moveManagedPath(source: string, destination: string): Promise<void> {
    const before = await lstat(source, { bigint: true })
    const parent = await stat(dirname(destination), { bigint: true })
    if (before.dev !== parent.dev) throw new FileManagementError('unsupported', 'Moving between filesystems is not supported. Copy the item, then delete the original.')
    let commandFailure: unknown
    if (process.platform === 'linux') {
        try {
            await execute('/bin/mv', ['--no-clobber', '--no-target-directory', '--', source, destination], { timeout: 30_000, maxBuffer: 16_384 })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new FileManagementError('unsupported', 'Safe moving requires a GNU-compatible /bin/mv')
            }
            // Newer GNU mv versions report a refused no-clobber operation with exit 1;
            // older versions report success. Verify filesystem state for either result.
            commandFailure = error
        }
    } else if (process.platform === 'win32') {
        const directory = await mkdtemp(join(tmpdir(), 'hapi-file-move-'))
        try {
            const script = join(directory, 'move.ps1')
            await writeFile(script, windowsMove)
            try {
                await execute('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Source', source, '-Destination', destination],
                    { windowsHide: true, timeout: 30_000, maxBuffer: 16_384 })
            } catch (error) {
                if ((error as { code?: number }).code === 3) throw new FileManagementError('conflict', 'The destination already exists')
                if ((error as { code?: number }).code === 4) throw new FileManagementError('unsupported', 'Moving between filesystems is not supported')
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileManagementError('unsupported', 'Safe moving requires PowerShell 7')
                throw error
            }
        } finally { await rm(directory, { recursive: true, force: true }) }
    } else {
        throw new FileManagementError('unsupported', 'Safe moving is not available on this platform. Copy the item, then delete the original.')
    }
    const after = await lstat(destination, { bigint: true }).catch(() => null)
    const remaining = await lstat(source, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    })
    if (commandFailure && !after) throw commandFailure
    if (after?.dev !== before.dev || after.ino !== before.ino || (remaining?.dev === before.dev && remaining.ino === before.ino)) {
        throw new FileManagementError('conflict', 'The destination already exists or the source changed. Refresh the file tree.')
    }
}
