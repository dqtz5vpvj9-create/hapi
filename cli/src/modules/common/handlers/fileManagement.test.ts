import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fsPromises from 'node:fs/promises'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lock } from 'proper-lockfile'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { inspectSessionPath, manageSessionFiles, registerFileManagementHandlers, uploadSessionFile } from './fileManagement'
import { moveManagedPath } from './moveManagedPath'

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, unlink: vi.fn(actual.unlink), readdir: vi.fn(actual.readdir) }
})

describe('guarded workspace file management', () => {
    let root: string
    beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'hapi-file-management-test-')) })
    afterEach(async () => {
        vi.restoreAllMocks()
        vi.mocked(fsPromises.unlink).mockReset()
        vi.mocked(fsPromises.readdir).mockReset()
        await rm(root, { recursive: true, force: true })
    })
    async function inspect(path: string) {
        const result = await inspectSessionPath({ path }, root)
        expect(result.success, result.error).toBe(true)
        return result.entry!
    }

    it('creates files and folders exclusively, preserving existing bytes', async () => {
        expect((await manageSessionFiles({ action: 'create-directory', path: 'src' }, root)).success).toBe(true)
        const result = await manageSessionFiles({ action: 'create-file', path: 'src/new.txt' }, root)
        expect(result).toMatchObject({ success: true, entry: { path: join(await realpath(root), 'src/new.txt'), size: 0, type: 'file' } })
        await writeFile(join(root, 'src/new.txt'), 'keep me')
        expect(await manageSessionFiles({ action: 'create-file', path: 'src/new.txt' }, root)).toMatchObject({ success: false, code: 'conflict' })
        expect(await manageSessionFiles({ action: 'create-directory', path: 'src' }, root)).toMatchObject({ success: false, code: 'conflict' })
        expect(await readFile(join(root, 'src/new.txt'), 'utf8')).toBe('keep me')
    })

    it('uploads binary bytes without overwriting and rejects malformed base64', async () => {
        const content = Buffer.from([0, 255, 10, 13, 0, 239, 187, 191])
        expect((await uploadSessionFile({ path: 'binary.bin', content: content.toString('base64') }, root)).success).toBe(true)
        expect(await readFile(join(root, 'binary.bin'))).toEqual(content)
        expect(await uploadSessionFile({ path: 'binary.bin', content: '' }, root)).toMatchObject({ success: false, code: 'conflict' })
        expect(await uploadSessionFile({ path: 'bad.bin', content: 'not valid base64' }, root)).toMatchObject({ success: false, code: 'invalid' })
        await expect(lstat(join(root, 'bad.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('requires a typed source revision and explicit recursive choice', async () => {
        await writeFile(join(root, 'source.txt'), 'source')
        for (const request of [
            { action: 'delete', path: 'source.txt', recursive: true },
            { action: 'delete', path: 'source.txt', expectedRevision: 'f'.repeat(64) },
            { action: 'copy', path: 'source.txt', destination: 'target.txt', expectedRevision: 'invalid' },
            { action: 'create-file', path: 'source.txt', overwrite: true },
            { action: 'shell', path: 'source.txt', command: 'rm -rf .' },
        ]) expect(await manageSessionFiles(request, root)).toMatchObject({ success: false, code: 'invalid' })
        expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('source')
    })

    it('rejects a same-size edit even when its original mtime was restored', async () => {
        const path = join(root, 'file.txt')
        await writeFile(path, 'before')
        const stats = await lstat(path)
        const entry = await inspect('file.txt')
        await writeFile(path, 'after!')
        await utimes(path, stats.atime, stats.mtime)
        expect(await manageSessionFiles({ action: 'delete', path: 'file.txt', expectedRevision: entry.revision, recursive: false }, root)).toMatchObject({ success: false, code: 'conflict' })
        expect(await readFile(path, 'utf8')).toBe('after!')
    })

    it('includes descendants in folder revisions and requires confirmation for a nonempty delete', async () => {
        await mkdir(join(root, 'folder/nested'), { recursive: true })
        await writeFile(join(root, 'folder/nested/file.txt'), 'before')
        const before = await inspect('folder')
        expect(before.entryCount).toBe(3)
        await writeFile(join(root, 'folder/nested/file.txt'), 'after')
        expect(await manageSessionFiles({ action: 'delete', path: 'folder', expectedRevision: before.revision, recursive: true }, root)).toMatchObject({ success: false, code: 'conflict' })
        const current = await inspect('folder')
        expect(await manageSessionFiles({ action: 'delete', path: 'folder', expectedRevision: current.revision, recursive: false }, root)).toMatchObject({ success: false, code: 'invalid' })
        expect((await manageSessionFiles({ action: 'delete', path: 'folder', expectedRevision: current.revision, recursive: true }, root)).success).toBe(true)
        await expect(lstat(join(root, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('reports verified partial deletions while preserving a concurrently edited sibling', async () => {
        await mkdir(join(root, 'folder'))
        await writeFile(join(root, 'folder/a.txt'), 'original')
        await writeFile(join(root, 'folder/b.txt'), 'delete this first')
        const entry = await inspect('folder')
        const { unlink } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        vi.mocked(fsPromises.unlink).mockImplementation(async path => {
            await unlink(path)
            if (String(path) === join(root, 'folder/b.txt')) await writeFile(join(root, 'folder/a.txt'), 'concurrent edit')
        })
        const result = await manageSessionFiles({ action: 'delete', path: 'folder', expectedRevision: entry.revision, recursive: true }, root)
        expect(result).toMatchObject({ success: false, code: 'conflict', deletedPaths: [join(await realpath(root), 'folder/b.txt')] })
        expect(await readFile(join(root, 'folder/a.txt'), 'utf8')).toBe('concurrent edit')
        await expect(lstat(join(root, 'folder/b.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it.skipIf(process.platform !== 'linux')('reports a committed move when the subsequent directory refresh fails', async () => {
        await mkdir(join(root, 'source'))
        await writeFile(join(root, 'source/file.txt'), 'kept')
        const entry = await inspect('source')
        const { readdir } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        vi.mocked(fsPromises.readdir).mockImplementation(((path: Parameters<typeof readdir>[0], ...options: unknown[]) => {
            if (String(path) === join(root, 'destination')) return Promise.reject(new Error('directory refresh failed'))
            return Reflect.apply(readdir, fsPromises, [path, ...options])
        }) as typeof readdir)
        const result = await manageSessionFiles({ action: 'move', path: 'source', destination: 'destination', expectedRevision: entry.revision }, root)
        expect(result).toMatchObject({ success: false, commit: { action: 'move', path: join(await realpath(root), 'source'), destination: join(await realpath(root), 'destination') } })
        expect(await readFile(join(root, 'destination/file.txt'), 'utf8')).toBe('kept')
        await expect(lstat(join(root, 'source'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('rejects traversal, root mutations, and destinations inside their source', async () => {
        await mkdir(join(root, 'source'))
        const source = await inspect('source')
        for (const path of ['../escape.txt', join(root, '..', 'escape.txt')]) {
            expect(await manageSessionFiles({ action: 'create-file', path }, root)).toMatchObject({ success: false, code: 'denied' })
            expect(await uploadSessionFile({ path, content: '' }, root)).toMatchObject({ success: false, code: 'denied' })
        }
        expect(await manageSessionFiles({ action: 'delete', path: '.', expectedRevision: 'a'.repeat(64), recursive: true }, root)).toMatchObject({ success: false, code: 'denied' })
        expect(await manageSessionFiles({ action: 'copy', path: 'source', destination: 'source/child', expectedRevision: source.revision }, root)).toMatchObject({ success: false, code: 'invalid' })
    })

    it.skipIf(process.platform === 'win32')('never traverses symlink parents, including a parent swapped after inspection', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'hapi-outside-test-'))
        try {
            await writeFile(join(outside, 'keep.txt'), 'outside bytes')
            await mkdir(join(root, 'folder'))
            await writeFile(join(root, 'folder/file.txt'), 'inside bytes')
            const entry = await inspect('folder/file.txt')
            await rm(join(root, 'folder'), { recursive: true })
            await symlink(outside, join(root, 'folder'))
            expect(await manageSessionFiles({ action: 'delete', path: 'folder/file.txt', expectedRevision: entry.revision, recursive: false }, root)).toMatchObject({ success: false, code: 'denied' })
            expect(await manageSessionFiles({ action: 'create-file', path: 'folder/new.txt' }, root)).toMatchObject({ success: false, code: 'denied' })
            expect(await uploadSessionFile({ path: 'folder/keep.txt', content: '' }, root)).toMatchObject({ success: false, code: 'denied' })
            expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('outside bytes')
            await expect(lstat(join(outside, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        } finally { await rm(outside, { recursive: true, force: true }) }
    })

    it.skipIf(process.platform === 'win32')('copies and deletes link leaves without following outside targets or cycles', async () => {
        await mkdir(join(root, 'source/nested'), { recursive: true })
        await writeFile(join(root, 'source/nested/file.bin'), Buffer.alloc(150_000, 0xa5))
        await symlink('/outside/does-not-exist', join(root, 'source/outside'))
        await symlink('.', join(root, 'source/cycle'))
        const entry = await inspect('source')
        expect(entry.entryCount).toBe(5)
        expect((await manageSessionFiles({ action: 'copy', path: 'source', destination: 'copy', expectedRevision: entry.revision }, root)).success).toBe(true)
        expect(await readFile(join(root, 'copy/nested/file.bin'))).toEqual(Buffer.alloc(150_000, 0xa5))
        expect(await readlink(join(root, 'copy/outside'))).toBe('/outside/does-not-exist')
        expect(await readlink(join(root, 'copy/cycle'))).toBe('.')
        await writeFile(join(root, 'copy/nested/file.bin'), 'independent')
        expect((await readFile(join(root, 'source/nested/file.bin'))).length).toBe(150_000)
        const copy = await inspect('copy')
        expect((await manageSessionFiles({ action: 'delete', path: 'copy', expectedRevision: copy.revision, recursive: true }, root)).success).toBe(true)
        expect((await inspect('source')).revision).toBe(entry.revision)
    })

    it.skipIf(process.platform === 'win32')('accepts a symlinked session root while containing canonical paths', async () => {
        const alias = root + '-alias'
        try {
            await symlink(root, alias)
            expect((await manageSessionFiles({ action: 'create-file', path: 'file.txt' }, alias)).success).toBe(true)
            const entry = (await inspectSessionPath({ path: join(await realpath(root), 'file.txt') }, alias)).entry
            expect(entry?.path).toBe(join(await realpath(root), 'file.txt'))
        } finally { await unlinkAlias(alias) }
    })

    it('does not clobber a destination file or an existing directory on copy', async () => {
        await writeFile(join(root, 'source.txt'), 'source')
        await writeFile(join(root, 'target.txt'), 'target')
        await mkdir(join(root, 'target-dir'))
        const entry = await inspect('source.txt')
        for (const destination of ['target.txt', 'target-dir']) {
            expect(await manageSessionFiles({ action: 'copy', path: 'source.txt', destination, expectedRevision: entry.revision }, root)).toMatchObject({ success: false, code: 'conflict' })
        }
        expect(await readFile(join(root, 'target.txt'), 'utf8')).toBe('target')
        expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('source')
    })

    it('serializes concurrent exclusive operations and respects another CLI process lock', async () => {
        const results = await Promise.all(['one', 'two'].map(content => uploadSessionFile({ path: 'same.txt', content: Buffer.from(content).toString('base64') }, root)))
        expect(results.filter(result => result.success)).toHaveLength(1)
        expect(results.find(result => !result.success)).toMatchObject({ code: 'conflict' })
        const release = await lock(root, { realpath: false, lockfilePath: join(root, '.hapi-file-management-lock') })
        try { expect(await manageSessionFiles({ action: 'create-file', path: 'blocked.txt' }, root)).toMatchObject({ success: false, code: 'conflict' }) }
        finally { await release() }
        await expect(lstat(join(root, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it.skipIf(process.platform !== 'linux')('moves a complete directory without replacing files or nesting inside a raced destination', async () => {
        await mkdir(join(root, 'folder'))
        await writeFile(join(root, 'folder/file.txt'), 'content')
        const entry = await inspect('folder')
        expect((await manageSessionFiles({ action: 'rename', path: 'folder', destination: 'renamed', expectedRevision: entry.revision }, root)).success).toBe(true)
        expect(await readFile(join(root, 'renamed/file.txt'), 'utf8')).toBe('content')
        await expect(lstat(join(root, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' })
        await mkdir(join(root, 'destination'))
        await expect(moveManagedPath(join(root, 'renamed'), join(root, 'destination'))).rejects.toMatchObject({ code: 'conflict' })
        expect(await readFile(join(root, 'renamed/file.txt'), 'utf8')).toBe('content')
        await expect(lstat(join(root, 'destination/renamed'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('validates the RPC boundary independently of the HTTP schema', async () => {
        const rpc = new RpcHandlerManager({ scopePrefix: 'session' })
        registerFileManagementHandlers(rpc, root)
        const response = await rpc.handleRequest({ method: 'session:manageSessionFiles', params: JSON.stringify({ action: 'delete', path: '.' }) })
        expect(JSON.parse(response)).toMatchObject({ success: false, code: 'invalid' })
    })
})

async function unlinkAlias(path: string): Promise<void> {
    // rm a link itself; never pass recursive on a workspace alias.
    const { unlink } = await import('node:fs/promises')
    await unlink(path).catch(() => {})
}
