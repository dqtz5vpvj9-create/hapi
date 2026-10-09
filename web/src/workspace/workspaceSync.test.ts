import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWorkspaceCommand, panes, WorkspaceSnapshotSchema, type WorkspaceSnapshot, type WorkspaceUpdateRequest, type WorkspaceUpdateResult, type SplitNode, type PaneNode } from '@hapi/protocol/workspaces'
import { WorkspaceStore } from './workspaceStore'
import { WorkspaceSync } from './workspaceSync'

const clients: WorkspaceSync[] = []
beforeEach(() => { localStorage.clear(); vi.useFakeTimers() })
afterEach(() => { clients.splice(0).forEach(client => client.dispose()); vi.useRealTimers() })

// Transport fault injection; authenticated SQLite/API behavior is exercised in the Hub/browser suites.
function hub() {
    let snapshot: WorkspaceSnapshot = { schemaVersion: 2, revision: 0, workspaces: [] }
    const committed = new Set<string>()
    const requests: WorkspaceUpdateRequest[] = []
    let offline = false, loseResponse = false
    const transport = {
        async getWorkspaces() { if (offline) throw new TypeError('offline'); return structuredClone(snapshot) },
        async updateWorkspaces(request: WorkspaceUpdateRequest): Promise<WorkspaceUpdateResult> {
            if (offline) throw new TypeError('offline')
            requests.push(structuredClone(request))
            if (committed.has(request.operation.id)) return { status: 'duplicate', snapshot: structuredClone(snapshot) }
            if (request.expectedRevision !== snapshot.revision) return { status: 'conflict', snapshot: structuredClone(snapshot) }
            const result = applyWorkspaceCommand(snapshot.workspaces, request.operation.command)
            snapshot = WorkspaceSnapshotSchema.parse({ ...snapshot, revision: snapshot.revision + 1, workspaces: result.workspaces })
            committed.add(request.operation.id)
            if (loseResponse) { loseResponse = false; throw new TypeError('response lost after commit') }
            return { status: 'applied', snapshot: structuredClone(snapshot), skipped: result.skipped }
        },
    }
    return { transport, requests, read: () => structuredClone(snapshot), offline: (value: boolean) => { offline = value }, loseNextResponse: () => { loseResponse = true } }
}
function device(server: ReturnType<typeof hub>, key: string) {
    const store = new WorkspaceStore(key, localStorage, true)
    const sync = new WorkspaceSync(store, server.transport)
    clients.push(sync)
    return { store, sync }
}

describe('workspace synchronization tasks', () => {
    it('uses a write acknowledgement to satisfy its own SSE invalidation without fetching the layout again', async () => {
        const server = hub(), store = new WorkspaceStore('A', localStorage, true)
        const read = vi.fn(server.transport.getWorkspaces)
        const sync = new WorkspaceSync(store, { getWorkspaces: read, updateWorkspaces: async request => {
            const result = await server.transport.updateWorkspaces(request)
            sync.invalidate(result.snapshot.revision)
            return result
        } })
        clients.push(sync)
        await sync.flush(); store.enter('chat-1'); store.openSession('chat-2', 'horizontal'); await sync.flush()
        expect(server.requests).toHaveLength(3)
        expect(read).toHaveBeenCalledTimes(1)
        expect(store.get().sync).toMatchObject({ status: 'synced', pending: 0 })
    })

    it('rebases simultaneous rename and move while keeping each device focus and zoom local', async () => {
        const server = hub(), a = device(server, 'A'), b = device(server, 'B')
        await a.sync.flush()
        a.store.enter('chat-1'); a.store.openSession('chat-2', 'horizontal')
        const source = a.store.active()!.id, moving = a.store.focusedPane()!.id
        a.store.create('Research'); const target = a.store.active()!.id
        await a.sync.flush(); await b.sync.flush()
        b.store.activate(source); const focused = panes(b.store.active()!.root)[0].id
        b.store.focus(focused); b.store.zoom()
        a.store.rename(target, 'Paper review')
        b.store.movePane(moving, target)
        await a.sync.flush(); await b.sync.flush()
        a.sync.invalidate(); await a.sync.flush()
        expect(server.requests.some(r => r.expectedRevision < server.read().revision - 1)).toBe(true)
        const docs = server.read().workspaces
        expect(docs.find(w => w.id === target)).toMatchObject({ name: 'Paper review' })
        expect(panes(docs.find(w => w.id === source)!.root).map(p => p.id)).toEqual([focused])
        expect(panes(docs.find(w => w.id === target)!.root).map(p => p.id)).toEqual([moving])
        expect(a.store.get().workspaces).toEqual(b.store.get().workspaces)
        expect(a.store.get().zoomed[source]).toBeFalsy()
        expect(b.store.get().zoomed[source]).toBe(true)
        const writes = server.requests.length
        b.store.focus(focused); await b.sync.flush()
        expect(server.requests).toHaveLength(writes)
        expect(a.store.get().activeId).toBe(target)
        expect(b.store.get().activeId).toBe(source)
    })

    it('persists offline operations through reload and retries a lost acknowledgement without duplicating a workspace', async () => {
        const server = hub(), a = device(server, 'A')
        await a.sync.flush(); a.store.enter('chat-1'); await a.sync.flush()
        server.offline(true)
        a.store.create('Offline work'); a.store.openSession('chat-2')
        await a.sync.flush()
        expect(a.store.get().sync.status).toBe('offline')
        a.sync.dispose()
        const restored = device(server, 'A')
        server.offline(false); server.loseNextResponse()
        await restored.sync.flush()
        const first = server.requests.at(-1)!.operation
        expect(restored.store.hasPending()).toBe(true)
        restored.store.rename(restored.store.active()!.id, 'Renamed offline work')
        await restored.sync.flush()
        expect(server.requests.filter(r => r.operation.id === first.id).map(r => r.operation)).toEqual([first, first])
        expect(server.read().workspaces).toHaveLength(2)
        expect(server.read().workspaces.at(-1)).toMatchObject({ name: 'Renamed offline work' })
        expect(restored.store.hasPending()).toBe(false)
        expect(restored.store.focusedPane()!.resource).toEqual({ kind: 'chat', sessionId: 'chat-2' })
    })

    it('retains a locally edited pane after remote close without resurrecting it until explicitly saved', async () => {
        const server = hub(), a = device(server, 'A'), b = device(server, 'B')
        await a.sync.flush(); a.store.enter('chat-1'); await a.sync.flush(); await b.sync.flush()
        const workspace = a.store.active()!, pane = a.store.focusedPane()!
        a.store.editingCallbacks(pane.id).add(() => true)
        const beforeHide = vi.fn(); a.store.callbacks(pane.id).add(beforeHide)
        b.store.closeWorkspace(workspace.id); await b.sync.flush()
        a.sync.invalidate(); await a.sync.flush()
        expect(beforeHide).toHaveBeenCalled()
        expect(a.store.active()!.root).toBe(workspace.root)
        expect(a.store.get().temporaryIds).toEqual([workspace.id])
        expect(a.store.hasPending()).toBe(false)
        expect(server.read().workspaces).toEqual([])
        a.sync.dispose()
        const restored = device(server, 'A'); await restored.sync.flush()
        expect(restored.store.focusedPane()!.id).toBe(pane.id)
        restored.store.shareTemporary(workspace.id); await restored.sync.flush()
        expect(server.read().workspaces).toHaveLength(1)
        expect(server.read().workspaces[0].id).not.toBe(workspace.id)
        expect(restored.store.get().temporaryIds).toEqual([])
        expect(panes(server.read().workspaces[0].root)[0].resource).toEqual(pane.resource)
    })

    it('applies a remote rebind only after the local editor explicitly follows the shared layout', async () => {
        const server = hub(), a = device(server, 'A'), b = device(server, 'B')
        await a.sync.flush(); a.store.enter('chat-1'); await a.sync.flush(); await b.sync.flush()
        const workspace = a.store.active()!, pane = a.store.focusedPane()!
        a.store.editingCallbacks(pane.id).add(() => true)
        b.store.bind(pane.id, { kind: 'chat', sessionId: 'chat-2' }); await b.sync.flush()
        a.sync.invalidate(); await a.sync.flush()
        expect(a.store.focusedPane()!.resource).toEqual({ kind: 'chat', sessionId: 'chat-1' })
        a.store.dismissTemporary(workspace.id)
        expect(a.store.focusedPane()!.resource).toEqual({ kind: 'chat', sessionId: 'chat-2' })
        expect(a.store.hasPending()).toBe(false)
    })

    it('keeps two quick sidebar drops and subsequent resizing when their writes are coalesced', async () => {
        const server = hub(), a = device(server, 'A')
        await a.sync.flush(); a.store.enter('chat-1'); await a.sync.flush()
        const workspace = a.store.active()!, original = a.store.focusedPane()!
        const second: PaneNode = { type: 'pane', id: 'second', resource: { kind: 'chat', sessionId: 'chat-2' } }
        const third: PaneNode = { type: 'pane', id: 'third', resource: { kind: 'chat', sessionId: 'chat-3' } }
        const root: SplitNode = { type: 'split', id: 'split', axis: 'horizontal', weights: [1, 1], children: [original, second] }
        a.store.setRoot(workspace.id, root)
        a.store.setRoot(workspace.id, { ...root, weights: [2, 1] })
        a.store.setRoot(workspace.id, { ...root, weights: [2, 1, 1], children: [original, second, third] })
        await a.sync.flush()
        expect(panes(server.read().workspaces[0].root).map(p => p.id)).toEqual([original.id, second.id, third.id])
        expect(server.read().workspaces[0].root).toMatchObject({ weights: [2, 1, 1] })
        expect(a.store.get().sync.skipped).toBeUndefined()
    })
})
