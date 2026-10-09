import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../../store'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createWorkspacesRoutes } from './workspaces'
import { panes, type WorkspaceCommand, type WorkspaceDocument, type WorkspaceSnapshot, type WorkspaceUpdateRequest, type WorkspaceUpdateResult } from '@hapi/protocol/workspaces'
import type { SyncEvent } from '@hapi/protocol'

const secret = new TextEncoder().encode('workspace-test-secret')
const stores: Store[] = [], dirs: string[] = []
afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(path = ':memory:') {
    const store = new Store(path)
    stores.push(store)
    const a = store.sessions.getOrCreateSession('A', {}, null, 'alpha')
    const b = store.sessions.getOrCreateSession('B', {}, null, 'alpha')
    const foreign = store.sessions.getOrCreateSession('private', {}, null, 'beta')
    const events: SyncEvent[] = []
    const app = new Hono<WebAppEnv>()
    app.use('/api/*', createAuthMiddleware(secret))
    app.route('/api', createWorkspacesRoutes(store, event => events.push(event)))
    const document = (name: string, sessionId = a.id): WorkspaceDocument => ({
        id: crypto.randomUUID(), name, root: { type: 'pane', id: crypto.randomUUID(), resource: { kind: 'chat', sessionId } },
    })
    const headers = async (namespace: string) => ({
        authorization: `Bearer ${await new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)}`,
        'content-type': 'application/json',
    })
    const read = async (namespace = 'alpha') => (await (await app.request('/api/workspaces', { headers: await headers(namespace) })).json()) as WorkspaceSnapshot
    const post = async (request: WorkspaceUpdateRequest, namespace = 'alpha') => {
        const response = await app.request('/api/workspaces/operations', { method: 'POST', headers: await headers(namespace), body: JSON.stringify(request) })
        return { response, body: await response.json() as WorkspaceUpdateResult }
    }
    const write = (revision: number, command: WorkspaceCommand, namespace = 'alpha') => post({ expectedRevision: revision, operation: { id: crypto.randomUUID(), command } }, namespace)
    return { store, app, a, b, foreign, events, document, headers, read, post, write }
}

describe('shared workspace user tasks', () => {
    it('accepts a document from its source machine and rejects a forged machine identity', async () => {
        const f = fixture()
        const source = f.store.sessions.getOrCreateSession('document-source', { machineId: 'machine-a' }, null, 'alpha')
        const workspace = f.document('Documents', source.id)
        workspace.root = { type: 'pane', id: 'document-pane', resource: { kind: 'document', sessionId: source.id,
            document: { kind: 'file', machineId: 'machine-a', path: '/project/notes.md' } } }
        expect((await f.write(0, { type: 'create', workspace })).response.status).toBe(200)
        const forged = await f.write(1, { type: 'bind', paneId: 'document-pane', resource: {
            kind: 'document', sessionId: source.id, document: { kind: 'file', machineId: 'machine-b', path: '/project/notes.md' },
        }, expected: workspace.root.resource })
        expect(forged.response.status).toBe(403)
        expect(panes((await f.read()).workspaces[0].root)[0].resource).toEqual(workspace.root.resource)
    })

    it('accepts an authorized sidebar drop and resize, but rejects a cross-namespace drop', async () => {
        const f = fixture(), w = f.document('Development')
        await f.write(0, { type: 'create', workspace: w })
        const added = { type: 'pane' as const, id: 'drop-b', resource: { kind: 'chat' as const, sessionId: f.b.id } }
        const root = { type: 'split' as const, id: 'drop-split', axis: 'horizontal' as const, weights: [2, 1], children: [w.root, added] }
        const dropped = await f.write(1, { type: 'layout', workspaceId: w.id, basePaneIds: [w.root.id], root, added })
        expect(dropped.response.status).toBe(200)
        expect(dropped.body.snapshot.workspaces[0].root).toEqual(root)
        const foreign = { ...added, id: 'private', resource: { kind: 'chat' as const, sessionId: f.foreign.id } }
        const denied = await f.write(2, { type: 'layout', workspaceId: w.id, basePaneIds: [w.root.id, added.id], added: foreign,
            root: { ...root, children: [...root.children, foreign], weights: [2, 1, 1] } })
        expect(denied.response.status).toBe(404)
        expect((await f.read()).revision).toBe(2)
        // A subsequent stale geometry payload cannot replace the authorized binding.
        const resized = await f.write(2, { type: 'layout', workspaceId: w.id, basePaneIds: [w.root.id, added.id],
            root: { ...root, weights: [3, 1], children: [w.root, { ...added, resource: foreign.resource }] } })
        expect(resized.response.status).toBe(200)
        expect(panes(resized.body.snapshot.workspaces[0].root)[1].resource).toEqual(added.resource)
    })

    it('shares layout between authenticated devices without storing chat bodies or local focus', async () => {
        const f = fixture(), first = f.document('Development')
        const created = await f.write(0, { type: 'create', workspace: first })
        expect(created.response.status).toBe(200)
        const remote = await f.read()
        expect(remote.workspaces[0]).toEqual(first)
        expect(f.events).toEqual([{ type: 'workspaces-updated', namespace: 'alpha', revision: 1 }])
        const bodyWithLocalState = { ...first, focus: first.root.id, messages: [{ text: 'must stay in the chat store' }] }
        const invalid = await f.app.request('/api/workspaces/operations', {
            method: 'POST', headers: await f.headers('alpha'),
            body: JSON.stringify({ expectedRevision: 1, operation: { id: crypto.randomUUID(), command: { type: 'create', workspace: bodyWithLocalState } } }),
        })
        expect(invalid.status).toBe(400)
        expect((await f.read()).revision).toBe(1)
    })

    it('moves a live pane atomically after a conflicting device rename and does not lose either edit', async () => {
        const f = fixture(), a = f.document('Development'), b = f.document('Research', f.b.id)
        await f.write(0, { type: 'import', workspaces: [a, b] })
        await f.write(1, { type: 'rename', workspaceId: b.id, name: 'Paper review' })
        const operation = { id: crypto.randomUUID(), command: { type: 'move' as const, paneId: a.root.id, targetId: b.id, splitId: crypto.randomUUID(), replacementId: crypto.randomUUID() } }
        const conflict = await f.post({ expectedRevision: 1, operation })
        expect(conflict.response.status).toBe(409)
        expect(panes(conflict.body.snapshot.workspaces[0].root)[0].resource.kind).toBe('chat')
        const replay = await f.post({ expectedRevision: conflict.body.snapshot.revision, operation })
        expect(replay.response.status).toBe(200)
        const [source, target] = replay.body.snapshot.workspaces
        expect(panes(source.root)[0].resource.kind).toBe('empty')
        expect(target.name).toBe('Paper review')
        expect(panes(target.root).map(p => p.id)).toEqual([b.root.id, a.root.id])
        expect(f.store.sessions.getSession(f.a.id)).not.toBeNull()
    })

    it('acknowledges a lost response without recreating a subsequently closed workspace, even if the session was deleted', async () => {
        const f = fixture(), workspace = f.document('One task')
        const request = { expectedRevision: 0, operation: { id: crypto.randomUUID(), command: { type: 'create' as const, workspace } } }
        await f.post(request)
        await f.write(1, { type: 'close', workspaceId: workspace.id })
        f.store.sessions.deleteSession(f.a.id, 'alpha')
        const retry = await f.post(request)
        expect(retry.response.status).toBe(200)
        expect(retry.body.status).toBe('duplicate')
        expect(retry.body.snapshot).toMatchObject({ revision: 2, workspaces: [] })
        expect(f.events).toHaveLength(2)
    })

    it('does not resurrect a remotely closed pane with an offline geometry snapshot', async () => {
        const f = fixture(), a = f.document('Development'), added = f.document('Other', f.b.id).root
        expect(added.type).toBe('pane')
        await f.write(0, { type: 'create', workspace: a })
        const split = await f.write(1, { type: 'split', paneId: a.root.id, splitId: crypto.randomUUID(), axis: 'horizontal', added: added as Extract<typeof added, { type: 'pane' }> })
        const root = split.body.snapshot.workspaces[0].root
        await f.write(2, { type: 'remove', paneId: added.id, replacementId: crypto.randomUUID() })
        const result = await f.write(3, { type: 'layout', workspaceId: a.id, root, basePaneIds: [a.root.id, added.id] })
        expect(result.body.skipped).toBe('layout-membership-changed')
        expect(panes(result.body.snapshot.workspaces[0].root).map(p => p.id)).toEqual([a.root.id])
    })

    it('preserves the newer chat binding during a late resize and rejects a stale resume binding', async () => {
        const f = fixture(), a = f.document('Development')
        await f.write(0, { type: 'create', workspace: a })
        const original = panes(a.root)[0]
        await f.write(1, { type: 'bind', paneId: a.root.id, expected: original.resource, resource: { kind: 'chat', sessionId: f.b.id } })
        const resize = await f.write(2, { type: 'layout', workspaceId: a.id, root: a.root, basePaneIds: [a.root.id] })
        expect(panes(resize.body.snapshot.workspaces[0].root)[0].resource).toEqual({ kind: 'chat', sessionId: f.b.id })
        const late = await f.write(3, { type: 'bind', paneId: a.root.id, expected: original.resource, resource: { kind: 'empty' } })
        expect(late.body.skipped).toBe('pane-rebound')
        expect(panes(late.body.snapshot.workspaces[0].root)[0].resource).toEqual({ kind: 'chat', sessionId: f.b.id })
    })

    it('restores a workspace by reusing an already reopened chat instead of duplicating it', async () => {
        const f = fixture(), old = f.document('Old'), current = f.document('Current')
        await f.write(0, { type: 'create', workspace: old })
        await f.write(1, { type: 'close', workspaceId: old.id })
        await f.write(2, { type: 'create', workspace: current })
        const result = await f.write(3, { type: 'restore', workspace: old, index: 0, replacementId: crypto.randomUUID() })
        const [restored, other] = result.body.snapshot.workspaces
        expect(restored.id).toBe(old.id)
        expect(restored.root.id).toBe(current.root.id)
        expect(panes(other.root)[0].resource.kind).toBe('empty')
    })

    it('keeps namespace documents and referenced sessions private and rolls back invalid duplicate identities', async () => {
        const f = fixture(), a = f.document('Private alpha')
        expect((await f.app.request('/api/workspaces')).status).toBe(401)
        await f.write(0, { type: 'create', workspace: a })
        expect((await f.read('beta')).workspaces).toEqual([])
        expect((await f.write(0, { type: 'create', workspace: a }, 'beta')).response.status).toBe(404)
        const cross = await f.write(1, { type: 'bind', paneId: a.root.id, expected: panes(a.root)[0].resource, resource: { kind: 'chat', sessionId: f.foreign.id } })
        expect(cross.response.status).toBe(404)
        const duplicated = f.document('Duplicate', f.b.id)
        duplicated.root.id = a.root.id
        const invalid = await f.write(1, { type: 'create', workspace: duplicated })
        expect(invalid.response.status).toBe(400)
        expect((await f.read()).revision).toBe(1)
    })

    it('migrates a v28 database, retains native sessions, and persists layout plus acknowledgements across Hub restarts', async () => {
        const directory = mkdtempSync(join('/mnt/cache/data-cache', 'hapi-workspace-migration-'))
        dirs.push(directory)
        const path = join(directory, 'hub.db'), initial = fixture(path)
        initial.store.close()
        const db = new Database(path)
        db.exec('DROP TABLE workspace_collections; DROP TABLE workspace_operations; PRAGMA user_version=28;')
        db.close()
        const first = fixture(path), workspace = first.document('Persistent')
        const request = { expectedRevision: 0, operation: { id: crypto.randomUUID(), command: { type: 'create' as const, workspace } } }
        expect((await first.post(request)).response.status).toBe(200)
        first.store.close()
        const restarted = fixture(path)
        expect((await restarted.read()).workspaces).toEqual([workspace])
        expect((await restarted.post(request)).body.status).toBe('duplicate')
        expect(restarted.store.sessions.getSession(initial.a.id)).not.toBeNull()
        await restarted.write(1, { type: 'close', workspaceId: workspace.id })
        expect((await restarted.write(2, { type: 'import', workspaces: [workspace] })).body.skipped).toBe('already-initialized')
        expect((await restarted.read()).workspaces).toEqual([])
    })
})
