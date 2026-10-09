import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createGitRoutes } from './git'

const access = { ok: true, sessionId: 'authorized-session', session: { active: true, metadata: { path: '/project' } } }
const write = { path: '/project/notes.md', content: Buffer.from('用户修改\n').toString('base64'), expectedHash: 'a'.repeat(64) }
function app(engine: Record<string, unknown>) {
    const result = new Hono<WebAppEnv>()
    result.use('*', async (c, next) => { c.set('namespace', 'test-owner'); await next() })
    result.route('/api', createGitRoutes(() => engine as unknown as SyncEngine))
    return result
}
const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('document API authorization and revision boundary', () => {
    it('rejects a foreign session before reading or writing original bytes', async () => {
        let calls = 0
        const api = app({ resolveSessionAccess: () => ({ ok: false, reason: 'access-denied' }),
            writeSessionFile: () => { calls++ }, readSessionFile: () => { calls++ } })
        expect((await api.request('/api/sessions/foreign/file', json('PUT', write))).status).toBe(403)
        expect((await api.request('/api/sessions/foreign/document-preview', json('POST', { document: { kind: 'file', path: '/project/slides.pptx' } }))).status).toBe(403)
        expect((await api.request('/api/sessions/foreign/document-preview/known-preview', { headers: { Range: 'bytes=0-63' } })).status).toBe(403)
        expect(calls).toBe(0)
    })
    it('reports an evicted preview without returning another document or reading the source again', async () => {
        let reads = 0
        const api = app({ resolveSessionAccess: () => access, readSessionFile: () => { reads++ } })
        const response = await api.request('/api/sessions/source/document-preview/expired-preview', { headers: { Range: 'bytes=0-63' } })
        expect(response.status).toBe(410)
        expect(await response.json()).toMatchObject({ error: 'This preview expired. Reload the document to prepare it again.' })
        expect(reads).toBe(0)
    })
    it('writes only through the resolved session and returns the original conflict without retrying', async () => {
        const calls: unknown[][] = []
        const api = app({ resolveSessionAccess: () => access, writeSessionFile: async (...args: unknown[]) => {
            calls.push(args); return { success: false, code: 'conflict', error: 'changed on disk' }
        } })
        const response = await api.request('/api/sessions/alias/file', json('PUT', write))
        expect(await response.json()).toEqual({ success: false, code: 'conflict', error: 'changed on disk' })
        expect(calls).toEqual([['authorized-session', write]])
    })
    it('requires a revision and rejects fields that attempt to select a different machine', async () => {
        let calls = 0
        const api = app({ resolveSessionAccess: () => access, writeSessionFile: () => { calls++ } })
        const { expectedHash: _, ...withoutRevision } = write
        for (const invalid of [withoutRevision, { ...write, machineId: 'other' }, { ...write, expectedHash: 'invalid' }]) {
            expect((await api.request('/api/sessions/source/file', json('PUT', invalid))).status).toBe(400)
        }
        expect(calls).toBe(0)
    })
    it('does not convert a newer file under an old page selection revision', async () => {
        const api = app({ resolveSessionAccess: () => access,
            readSessionFile: async () => ({ success: true, content: '', hash: 'b'.repeat(64) }) })
        const response = await api.request('/api/sessions/source/document-preview', json('POST', {
            document: { kind: 'file', path: '/project/slides.pptx' }, version: 'a'.repeat(64),
        }))
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ error: 'The original file changed. Reload it before previewing.' })
    })
    it('accepts document references only, never a remote conversion URL', async () => {
        const api = app({ resolveSessionAccess: () => access })
        expect((await api.request('/api/sessions/source/document-preview', json('POST', {
            document: { kind: 'url', url: 'http://internal/secret.pptx' },
        }))).status).toBe(400)
    })
    it('checks only metadata on revisits without reading or converting the file body', async () => {
        const calls: unknown[][] = []
        const api = app({ resolveSessionAccess: () => access, statFiles: async (...args: unknown[]) => {
            calls.push(args); return { success: true, entries: [{ path: '/project/report.pptx', size: 1024, modified: 123 }] }
        } })
        const response = await api.request('/api/sessions/alias/file-info?path=%2Fproject%2Freport.pptx')
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ success: true, entries: [{ size: 1024, modified: 123 }] })
        expect(calls).toEqual([['authorized-session', ['/project/report.pptx']]])
    })
})
