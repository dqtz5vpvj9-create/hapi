import { lstat, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { FileManagementErrorCode } from '@hapi/protocol/fileManagement'
import { validatePath } from './pathSecurity'

export class FileManagementError extends Error {
    constructor(readonly code: FileManagementErrorCode, message: string) { super(message) }
}

export function sameFilePath(left: string, right: string): boolean {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Resolve the workspace itself, but never traverse a symlink below it. A final link is a leaf. */
export async function resolveManagedPath(path: string, root: string, options: { allowMissing?: boolean; allowFinalSymlink?: boolean } = {}): Promise<string> {
    if (!path || path.includes('\0')) throw new FileManagementError('invalid', 'Invalid file path')
    const lexicalRoot = resolve(root)
    const lexical = resolve(lexicalRoot, path)
    const canonicalRoot = await realpath(lexicalRoot)
    const checked = validatePath(lexical, lexicalRoot)
    const canonicalCheck = validatePath(lexical, canonicalRoot)
    if (!checked.valid && !canonicalCheck.valid) throw new FileManagementError('denied', checked.error ?? 'Path is outside the session directory')
    const parts = relative(checked.valid ? lexicalRoot : canonicalRoot, lexical).split(sep).filter(Boolean)
    let target = canonicalRoot
    for (let index = 0; index < parts.length; index++) {
        target = join(target, parts[index]!)
        const last = index === parts.length - 1
        let info
        try { info = await lstat(target) }
        catch (error) {
            if (last && options.allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return target
            throw error
        }
        if (info.isSymbolicLink()) {
            if (last && options.allowFinalSymlink) return target
            throw new FileManagementError('denied', 'File management does not traverse symbolic links')
        }
        if (!last && !info.isDirectory()) throw new FileManagementError('invalid', 'A parent path is not a directory')
        const canonical = await realpath(target)
        if (!validatePath(canonical, canonicalRoot).valid || !sameFilePath(canonical, target)) {
            throw new FileManagementError('denied', 'The path changed or is outside the session directory')
        }
    }
    return target
}
