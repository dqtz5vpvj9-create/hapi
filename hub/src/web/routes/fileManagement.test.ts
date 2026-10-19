import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { MAX_FILE_TRANSFER_BYTES, type FileManagementEntry } from '@hapi/protocol/fileManagement'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createFileManagementRoutes } from './fileManagement'

const entry: FileManagementEntry = { path: '/workspace/project/file.txt', name: 'file.txt', type: 'file', size: 4, modified: 123, revision: 'a'.repeat(64), entryCount: 1 }
const access = { ok: true, sessionId: 'canonical-session', session: { active: true, metadata: { path: '/workspace/project' } } }

function app(engine: Record<string, unknown>) {
    const routes = new Hono<WebAppEnv>()
    routes.use('*', async (c, next) => { c.set('namespace', 'owner'); await next() })
    routes.route('/api', createFileManagementRoutes(() => engine as unknown as SyncEngine))
    return routes
}

function post(body: unknown) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } }

describe('session file management routes', () => {
    it('checks namespace access before inspecting, mutating, uploading or downloading', async () => {
        let calls = 0
        const namespaces: string[] = []
        const api = app({
            resolveSessionAccess: (_id: string, namespace: string) => { namespaces.push(namespace); return { ok: false, reason: 'access-denied' } },
            inspectSessionPath: () => { calls++ }, manageSessionFiles: () => { calls++ }, uploadSessionFile: () => { calls++ }, readSessionFile: () => { calls++ },
        })
        for (const [path, init] of [
            ['/filesystem/entry?path=file.txt', undefined],
            ['/filesystem', post({ action: 'create-file', path: 'file.txt' })],
            ['/filesystem/upload', post({ path: 'file.txt', content: '' })],
            ['/filesystem/download?path=file.txt', undefined],
        ] as const) expect((await api.request('/api/sessions/foreign' + path, init)).status).toBe(403)
        expect(calls).toBe(0)
        expect(namespaces).toEqual(['owner', 'owner', 'owner', 'owner'])
    })

    it('rejects offline sessions and sessions with no directory before RPC', async () => {
        let calls = 0
        for (const session of [{ active: false, metadata: { path: '/workspace/project' } }, { active: true }]) {
            const api = app({ resolveSessionAccess: () => ({ ...access, session }), manageSessionFiles: () => { calls++ } })
            expect((await api.request('/api/sessions/session/filesystem', post({ action: 'create-file', path: 'new.txt' }))).status).toBe(409)
        }
        expect(calls).toBe(0)
    })

    it('forwards a validated operation and source revision to the canonical authorized session', async () => {
        const calls: unknown[][] = []
        const request = { action: 'move', path: 'file.txt', destination: 'folder/new.txt', expectedRevision: entry.revision }
        const api = app({ resolveSessionAccess: () => access, manageSessionFiles: async (...args: unknown[]) => { calls.push(args); return { success: false, code: 'conflict', error: 'Source changed' } } })
        const response = await api.request('/api/sessions/alias/filesystem', post(request))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ success: false, code: 'conflict', error: 'Source changed' })
        expect(calls).toEqual([['canonical-session', request]])
    })

    it('rejects missing revisions, implicit recursive delete, extra overwrite flags and arbitrary commands', async () => {
        let calls = 0
        const api = app({ resolveSessionAccess: () => access, manageSessionFiles: () => { calls++ } })
        for (const request of [
            { action: 'delete', path: 'file.txt', recursive: true },
            { action: 'delete', path: 'file.txt', expectedRevision: entry.revision },
            { action: 'create-file', path: 'file.txt', overwrite: true },
            { action: 'shell', command: 'rm -rf .', path: '.' },
        ]) expect((await api.request('/api/sessions/session/filesystem', post(request))).status).toBe(400)
        expect(calls).toBe(0)
    })

    it('returns inspection metadata and keeps upload bytes and destination unchanged', async () => {
        const calls: unknown[][] = []
        const upload = { path: 'nested/二进制.bin', content: Buffer.from([0, 255, 13, 10]).toString('base64') }
        const api = app({ resolveSessionAccess: () => access,
            inspectSessionPath: async (...args: unknown[]) => { calls.push(args); return { success: true, entry } },
            uploadSessionFile: async (...args: unknown[]) => { calls.push(args); return { success: true, entry } },
        })
        expect(await (await api.request('/api/sessions/session/filesystem/entry?path=nested%2Ffile.txt')).json()).toEqual({ success: true, entry })
        expect((await api.request('/api/sessions/session/filesystem/upload', post(upload))).status).toBe(200)
        expect(calls).toEqual([['canonical-session', 'nested/file.txt'], ['canonical-session', upload]])
    })

    it('downloads the original binary bytes as a private attachment with an encoded filename', async () => {
        const bytes = Buffer.from([0, 255, 13, 10])
        const calls: unknown[][] = []
        const api = app({ resolveSessionAccess: () => access,
            inspectSessionPath: async () => ({ success: true, entry: { ...entry, name: '报告\n".bin' } }),
            readSessionFile: async (...args: unknown[]) => { calls.push(args); return { success: true, content: bytes.toString('base64') } },
        })
        const response = await api.request('/api/sessions/session/filesystem/download?path=file.txt')
        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
        expect(response.headers.get('Content-Disposition')).toBe("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%0A%22.bin")
        expect(response.headers.get('Cache-Control')).toBe('private, no-store')
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
        expect(calls).toEqual([['canonical-session', 'file.txt']])
    })

    it('does not read download bytes for links, directories, denied paths or oversized files', async () => {
        let reads = 0
        for (const [inspection, status] of [
            [{ success: true, entry: { ...entry, type: 'symlink' } }, 400],
            [{ success: true, entry: { ...entry, type: 'directory' } }, 400],
            [{ success: false, code: 'denied', error: 'Outside session' }, 403],
            [{ success: true, entry: { ...entry, size: MAX_FILE_TRANSFER_BYTES + 1 } }, 413],
        ] as const) {
            const api = app({ resolveSessionAccess: () => access, inspectSessionPath: async () => inspection, readSessionFile: () => { reads++ } })
            expect((await api.request('/api/sessions/session/filesystem/download?path=file.txt')).status).toBe(status)
        }
        expect(reads).toBe(0)
    })
})
