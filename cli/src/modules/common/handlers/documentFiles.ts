import { open, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { lock } from 'proper-lockfile'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, basename, join, resolve } from 'node:path'
import { MAX_DOCUMENT_FILE_BYTES, MAX_EDITABLE_FILE_BYTES, type FileWriteResponse } from '@hapi/protocol/documents'
import type { FileReadResponse } from '@hapi/protocol/apiTypes'
import { validatePath } from '../pathSecurity'
import { canWriteWindowsDocument, replaceDocumentFile } from './replaceDocumentFile'

const writes = new Map<string, Promise<unknown>>()
export const documentLockPath = (path: string) => join(dirname(path), `.${basename(path)}.hapi-document-lock`)
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function canWriteFile(path: string): Promise<boolean> {
    if (process.platform === 'win32') return canWriteWindowsDocument(path)
    try { const handle = await open(path, 'r+'); await handle.close(); return true }
    catch { return false }
}
async function authorizedPath(path: string, root: string, allowNew = false): Promise<string> {
    const validation = validatePath(path, root)
    if (!validation.valid) throw new Error(validation.error ?? 'Invalid file path')
    const lexical = resolve(root, path)
    const canonicalRoot = await realpath(root)
    let target: string
    try { target = await realpath(lexical) }
    catch (error) {
        if (!allowNew || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        target = join(await realpath(dirname(lexical)), basename(lexical))
    }
    const canonical = validatePath(target, canonicalRoot)
    if (!canonical.valid) throw new Error(canonical.error ?? 'File is outside this session')
    return target
}

export async function readDocumentFile(path: string, root: string): Promise<FileReadResponse> {
    const target = await authorizedPath(path, root)
    const handle = await open(target, 'r')
    try {
        const info = await handle.stat()
        if (!info.isFile()) return { success: false, error: 'This path is not a file' }
        if (info.size > MAX_DOCUMENT_FILE_BYTES) return { success: false, error: 'File exceeds the 64 MiB preview limit' }
        const bytes = await handle.readFile()
        if (bytes.length > MAX_DOCUMENT_FILE_BYTES) return { success: false, error: 'File exceeds the 64 MiB preview limit' }
        const writable = await canWriteFile(target)
        return { success: true, content: bytes.toString('base64'), size: bytes.length, modified: info.mtime.getTime(),
            hash: revision(bytes), path: target, writable: writable && bytes.length <= MAX_EDITABLE_FILE_BYTES }
    } finally { await handle.close() }
}

export async function writeDocumentFile(data: { path: string; content: string; expectedHash?: string | null }, root: string): Promise<FileWriteResponse> {
    const path = await authorizedPath(data.path, root, !data.expectedHash)
    const queueKey = process.platform === 'win32' ? path.toLowerCase() : path
    const previous = writes.get(queueKey) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async (): Promise<FileWriteResponse> => {
        // Independent CLI sessions can target the same file; a process-local queue alone
        // allows both to pass the revision check. Share an advisory lock on its real path.
        let compromised: Error | undefined
        let release: () => Promise<void>
        try {
            release = await lock(path, { realpath: false, lockfilePath: documentLockPath(path), onCompromised: error => { compromised = error } })
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return { success: false, code: 'conflict', error: 'Another HAPI session is saving this file. Your draft has been kept.' }
            throw error
        }
        try {
            const bytes = Buffer.from(data.content, 'base64')
            if (bytes.length > MAX_EDITABLE_FILE_BYTES) return { success: false, code: 'too-large', error: 'Text editing is limited to 4 MiB' }
            const current = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
            if (current ? revision(current) !== data.expectedHash : Boolean(data.expectedHash)) {
                return { success: false, code: 'conflict', error: 'The file changed on disk. Your draft has been kept; compare it before saving.' }
            }
            if (current && process.platform !== 'win32' && !await canWriteFile(path)) {
                return { success: false, code: 'denied', error: 'This file is read only. Your draft has been kept.' }
            }
            const mode = current ? (await stat(path)).mode : 0o600
            const temporary = join(dirname(path), `.${basename(path)}.hapi-${randomUUID()}`)
            const handle = await open(temporary, 'wx', mode)
            try {
                // open() applies the process umask; replacing an existing file must
                // retain its mode rather than silently dropping group permissions.
                if (current && process.platform !== 'win32') await handle.chmod(mode & 0o7777)
                await handle.writeFile(bytes)
                await handle.sync()
                await handle.close()
                // Editors outside HAPI do not participate in this queue. Recheck after writing
                // the temporary file; atomic rename prevents partially written originals, but
                // does not provide a filesystem CAS against uncooperative external writers.
                const latest = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
                if (latest ? revision(latest) !== data.expectedHash : Boolean(data.expectedHash)) {
                    return { success: false, code: 'conflict', error: 'The file changed while saving. Your draft has been kept.' }
                }
                if (compromised) return { success: false, code: 'conflict', error: 'File ownership changed during save. Retry after checking the disk version.' }
                if (!current) {
                    // Exclusive creation avoids replacing a file created during this request.
                    const created = await open(path, 'wx', mode)
                    try { await created.writeFile(bytes); await created.sync() } finally { await created.close() }
                } else {
                    const result = await replaceDocumentFile(temporary, path, data.expectedHash!)
                    if (result === 'conflict') return { success: false, code: 'conflict', error: 'The file changed while saving. Your draft has been kept.' }
                    if (result === 'denied') return { success: false, code: 'denied', error: 'This file is read only. Your draft has been kept.' }
                }
                return { success: true, hash: revision(bytes), modified: (await stat(path)).mtime.getTime() }
            } finally {
                await handle.close().catch(() => {})
                await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
            }
        } finally { await release() }
    })
    writes.set(queueKey, task)
    try { return await task } finally { if (writes.get(queueKey) === task) writes.delete(queueKey) }
}
