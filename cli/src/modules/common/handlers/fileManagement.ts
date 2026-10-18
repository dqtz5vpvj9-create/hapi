import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rmdir, symlink, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { lock } from 'proper-lockfile'
import {
    FileManagementInspectRequestSchema,
    FileManagementRequestSchema,
    FileManagementUploadRequestSchema,
    MAX_FILE_MANAGEMENT_ENTRIES,
    MAX_FILE_TRANSFER_BYTES,
    type FileManagementEntry,
    type FileManagementResponse,
} from '@hapi/protocol/fileManagement'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { FileManagementError, resolveManagedPath, sameFilePath } from '../managedPaths'
import { validatePath } from '../pathSecurity'
import { moveManagedPath } from './moveManagedPath'

type SnapshotNode = { path: string; name: string; type: FileManagementEntry['type']; stats: BigIntStats; token: string; linkTarget?: string }
type Snapshot = { entry: FileManagementEntry; nodes: SnapshotNode[] }
const mutations = new Map<string, Promise<unknown>>()
const lockName = '.hapi-file-management-lock'

function statToken(info: BigIntStats): string {
    return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(':')
}

function identityMatches(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.isDirectory() === right.isDirectory() && left.isSymbolicLink() === right.isSymbolicLink()
}

function errorResponse(error: unknown): FileManagementResponse {
    if (error instanceof FileManagementError) return { success: false, code: error.code, error: error.message }
    const code = (error as NodeJS.ErrnoException)?.code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ENOENT') return { success: false, code: 'not-found', error: 'The item no longer exists. Refresh the file tree.' }
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ELOCKED') return { success: false, code: 'conflict', error: 'The destination exists or another file operation is in progress. Refresh and retry.' }
    if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return { success: false, code: 'denied', error: message }
    return { success: false, error: message }
}

async function snapshot(path: string, root: string): Promise<Snapshot> {
    const target = await resolveManagedPath(path, root, { allowFinalSymlink: true })
    const nodes: SnapshotNode[] = []
    const digest = createHash('sha256')
    let size = 0
    async function visit(current: string): Promise<void> {
        if (nodes.length >= MAX_FILE_MANAGEMENT_ENTRIES) throw new FileManagementError('too-large', `This operation is limited to ${MAX_FILE_MANAGEMENT_ENTRIES.toLocaleString('en-US')} entries. Select a smaller folder.`)
        await resolveManagedPath(current, root, { allowFinalSymlink: true })
        const stats = await lstat(current, { bigint: true })
        const type = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null
        if (!type) throw new FileManagementError('unsupported', 'Special filesystem entries are not supported')
        const linkTarget = type === 'symlink' ? await readlink(current) : undefined
        const node: SnapshotNode = { path: current, name: relative(target, current), type, stats, token: statToken(stats), linkTarget }
        nodes.push(node)
        if (type !== 'directory') size += Number(stats.size)
        digest.update(JSON.stringify([node.name, type, node.token, linkTarget]) + '\n')
        if (type === 'directory') {
            const names = (await readdir(current)).sort()
            for (const name of names) await visit(join(current, name))
        }
        // A scan is only useful as a revision if the entry stayed stable while it was read.
        if (statToken(await lstat(current, { bigint: true })) !== node.token) throw new FileManagementError('conflict', 'The item changed while inspecting it. Refresh and retry.')
    }
    await visit(target)
    const first = nodes[0]!
    return { entry: { path: target, name: basename(target), type: first.type, size, modified: Number(first.stats.mtimeMs), revision: digest.digest('hex'), entryCount: nodes.length }, nodes }
}

async function requireRevision(path: string, root: string, revision: string): Promise<Snapshot> {
    const result = await snapshot(path, root)
    if (result.entry.revision !== revision) throw new FileManagementError('conflict', 'The item changed since you selected it. Refresh and retry.')
    return result
}

async function withMutation<T>(root: string, operation: (checkLock: () => void) => Promise<T>): Promise<T> {
    const canonical = await realpath(root)
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    const previous = mutations.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
        let compromised: Error | undefined
        const release = await lock(canonical, { realpath: false, lockfilePath: join(canonical, lockName), onCompromised: error => { compromised = error } })
        try { return await operation(() => { if (compromised) throw new FileManagementError('conflict', 'The file operation lock changed. Refresh and retry.') }) }
        finally { await release() }
    })
    mutations.set(key, task)
    try { return await task }
    finally { if (mutations.get(key) === task) mutations.delete(key) }
}

async function mutablePath(path: string, root: string, allowMissing = false): Promise<string> {
    const target = await resolveManagedPath(path, root, { allowMissing, allowFinalSymlink: true })
    const canonical = await realpath(root)
    if (sameFilePath(target, canonical) || sameFilePath(target, join(canonical, lockName))) throw new FileManagementError('denied', 'The session directory itself cannot be changed')
    return target
}

async function requireAbsent(path: string): Promise<void> {
    try { await lstat(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    throw new FileManagementError('conflict', 'The destination already exists. Choose another name.')
}

async function createFile(path: string, bytes: Buffer): Promise<void> {
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(bytes); await file.sync() }
    catch (error) {
        const owned = await file.stat({ bigint: true })
        const current = await lstat(path, { bigint: true }).catch(() => null)
        if (current && identityMatches(owned, current) && statToken(owned) === statToken(current)) await unlink(path).catch(() => {})
        throw error
    }
    finally { await file.close() }
}

async function copySnapshot(source: Snapshot, destination: string, root: string, checkLock: () => void): Promise<void> {
    const created: Array<{ path: string; stats: BigIntStats; token: string }> = []
    try {
        for (const node of source.nodes) {
            checkLock()
            const target = node.name ? join(destination, node.name) : destination
            await resolveManagedPath(target, root, { allowMissing: true, allowFinalSymlink: true })
            await resolveManagedPath(node.path, root, { allowFinalSymlink: node.type === 'symlink' })
            if (statToken(await lstat(node.path, { bigint: true })) !== node.token) throw new FileManagementError('conflict', 'The source changed while copying. Refresh and retry.')
            if (node.type === 'directory') {
                await mkdir(target, { mode: Number(node.stats.mode & 0o777n) | 0o700 })
            } else if (node.type === 'symlink') {
                // Copy the link itself, including dangling links, without opening its target.
                await symlink(node.linkTarget!, target)
            } else {
                const input = await open(node.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
                let output
                try {
                    if (statToken(await input.stat({ bigint: true })) !== node.token) throw new FileManagementError('conflict', 'The source changed while copying')
                    output = await open(target, 'wx', Number(node.stats.mode & 0o777n))
                    const buffer = Buffer.allocUnsafe(64 * 1024)
                    let offset = 0
                    while (offset < Number(node.stats.size)) {
                        checkLock()
                        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(node.stats.size) - offset), offset)
                        if (bytesRead === 0) throw new FileManagementError('conflict', 'The source changed while copying')
                        await output.writeFile(buffer.subarray(0, bytesRead))
                        offset += bytesRead
                    }
                    await output.sync()
                    if (statToken(await input.stat({ bigint: true })) !== node.token) throw new FileManagementError('conflict', 'The source changed while copying')
                } finally {
                    // Record the exclusive destination even if copying failed partway, so cleanup
                    // can remove only the inode created by this request.
                    if (output) {
                        const info = await output.stat({ bigint: true })
                        created.push({ path: target, stats: info, token: statToken(info) })
                        await output.close()
                    }
                    await input.close()
                }
            }
            if (node.type !== 'file') {
                const info = await lstat(target, { bigint: true })
                created.push({ path: target, stats: info, token: statToken(info) })
            }
        }
        await requireRevision(source.entry.path, root, source.entry.revision)
        // Directories need owner write access during the copy; restore source modes after children.
        for (const node of [...source.nodes].reverse()) {
            if (node.type === 'directory' && process.platform !== 'win32') await chmod(node.name ? join(destination, node.name) : destination, Number(node.stats.mode & 0o777n))
        }
    } catch (error) {
        // Never rm(recursive) a destination: another writer may have added or edited something.
        // Only unchanged entries created here are eligible for cleanup.
        for (const node of created.reverse()) {
            try {
                await resolveManagedPath(node.path, root, { allowFinalSymlink: true })
                const info = await lstat(node.path, { bigint: true })
                if (!identityMatches(info, node.stats)) continue
                if (info.isDirectory()) await rmdir(node.path)
                else if (statToken(info) === node.token) await unlink(node.path)
            } catch { /* Leave changed/nonempty entries for the user rather than deleting them. */ }
        }
        throw error
    }
}

export async function inspectSessionPath(data: unknown, root: string): Promise<FileManagementResponse> {
    const parsed = FileManagementInspectRequestSchema.safeParse(data)
    if (!parsed.success) return { success: false, code: 'invalid', error: 'Invalid file path' }
    try { return { success: true, entry: (await snapshot(parsed.data.path, root)).entry } }
    catch (error) { return errorResponse(error) }
}

export async function manageSessionFiles(data: unknown, root: string): Promise<FileManagementResponse> {
    const parsed = FileManagementRequestSchema.safeParse(data)
    if (!parsed.success) return { success: false, code: 'invalid', error: 'Invalid file operation' }
    const deleted = new Set<string>()
    let commit: FileManagementResponse['commit']
    const committedChanges = () => ({
        ...(deleted.size > 0 ? { deletedPaths: [...deleted].filter(path => {
            for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
                if (deleted.has(parent)) return false
            }
            return true
        }) } : {}),
        ...(commit ? { commit } : {})
    })
    try {
        return await withMutation(root, async checkLock => {
            const request = parsed.data
            const sourcePath = await mutablePath(request.path, root, request.action === 'create-file' || request.action === 'create-directory')
            checkLock()
            if (request.action === 'create-file' || request.action === 'create-directory') {
                if (request.action === 'create-file') await createFile(sourcePath, Buffer.alloc(0))
                else await mkdir(sourcePath)
                return { success: true, entry: (await snapshot(sourcePath, root)).entry }
            }
            const source = await requireRevision(sourcePath, root, request.expectedRevision)
            if (request.action === 'delete') {
                if (source.entry.type === 'directory' && source.nodes.length > 1 && !request.recursive) throw new FileManagementError('invalid', 'Deleting a nonempty folder requires recursive confirmation')
                for (const node of [...source.nodes].reverse()) {
                    checkLock()
                    await resolveManagedPath(node.path, root, { allowFinalSymlink: true })
                    const current = await lstat(node.path, { bigint: true })
                    if (node.type === 'directory' ? !identityMatches(current, node.stats) : statToken(current) !== node.token) throw new FileManagementError('conflict', 'The item changed while deleting. Refresh the file tree.')
                    if (node.type === 'directory') await rmdir(node.path)
                    else await unlink(node.path)
                    deleted.add(node.path)
                }
                return { success: true, ...committedChanges() }
            }
            const destination = await mutablePath(request.destination, root, true)
            if (sameFilePath(sourcePath, destination) || (source.entry.type === 'directory' && validatePath(destination, sourcePath).valid)) throw new FileManagementError('invalid', 'Choose a destination outside the source folder')
            await requireAbsent(destination)
            checkLock()
            if (request.action === 'copy') await copySnapshot(source, destination, root, checkLock)
            else {
                await requireRevision(sourcePath, root, request.expectedRevision)
                await resolveManagedPath(destination, root, { allowMissing: true, allowFinalSymlink: true })
                await moveManagedPath(sourcePath, destination)
                commit = { action: request.action, path: sourcePath, destination }
            }
            return { success: true, entry: (await snapshot(destination, root)).entry, ...committedChanges() }
        })
    } catch (error) { return { ...errorResponse(error), ...committedChanges() } }
}

export async function uploadSessionFile(data: unknown, root: string): Promise<FileManagementResponse> {
    const parsed = FileManagementUploadRequestSchema.safeParse(data)
    if (!parsed.success) return { success: false, code: 'invalid', error: 'Invalid file upload' }
    try {
        const bytes = Buffer.from(parsed.data.content, 'base64')
        if (bytes.length > MAX_FILE_TRANSFER_BYTES) throw new FileManagementError('too-large', 'Files larger than 64 MiB cannot be uploaded')
        if (bytes.toString('base64') !== parsed.data.content) throw new FileManagementError('invalid', 'File content must be valid base64')
        return await withMutation(root, async checkLock => {
            const target = await mutablePath(parsed.data.path, root, true)
            checkLock()
            await createFile(target, bytes)
            return { success: true, entry: (await snapshot(target, root)).entry }
        })
    } catch (error) { return errorResponse(error) }
}

export function registerFileManagementHandlers(manager: RpcHandlerManager, root: string): void {
    manager.registerHandler(RPC_METHODS.InspectSessionPath, data => inspectSessionPath(data, root))
    manager.registerHandler(RPC_METHODS.ManageSessionFiles, data => manageSessionFiles(data, root))
    manager.registerHandler(RPC_METHODS.UploadSessionFile, data => uploadSessionFile(data, root))
}
