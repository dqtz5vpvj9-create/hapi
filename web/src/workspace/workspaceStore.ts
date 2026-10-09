import { DocumentRegistry, type DocumentSession } from '@/documents/documentSession'
import type { DocumentResource } from '@hapi/protocol/documents'
import {
    applyWorkspaceCommand, panes, removePane, sameResource,
    WorkspaceDocumentSchema, WorkspaceOperationSchema, WorkspaceSnapshotSchema,
    type PaneNode, type PaneResource, type SplitNode, type WorkspaceCommand,
    type WorkspaceDocument, type WorkspaceNode, type WorkspaceOperation, type WorkspaceSnapshot,
} from '@hapi/protocol/workspaces'
export { panes, removePane, updateNode } from '@hapi/protocol/workspaces'
export type { PaneNode, PaneResource, SplitNode, WorkspaceDocument, WorkspaceNode } from '@hapi/protocol/workspaces'

type PendingOperation = { operation: WorkspaceOperation; attempted: boolean }
export type WorkspaceState = {
    version: 1
    mode: 'single' | 'workspace'
    workspaces: WorkspaceDocument[]
    activeId: string | null
    focused: Record<string, string>
    zoomed: Record<string, boolean>
    lastChat: string | null
    temporaryIds: string[]
    sync: { status: 'local' | 'syncing' | 'synced' | 'offline' | 'error'; initialized: boolean; pending: number; error?: string; skipped?: string }
}
export const emptyPane = (): PaneNode => ({ type: 'pane', id: crypto.randomUUID(), resource: { kind: 'empty' } })
const initial = (synchronized: boolean): WorkspaceState => ({
    version: 1, mode: 'single', workspaces: [], activeId: null, focused: {}, zoomed: {}, lastChat: null,
    temporaryIds: [], sync: { status: synchronized ? 'syncing' : 'local', initialized: !synchronized, pending: 0 },
})
function sameTree(a: WorkspaceNode, b: WorkspaceNode): boolean {
    if (a === b) return true
    if (a.id !== b.id || a.type !== b.type) return false
    if (a.type === 'pane') return b.type === 'pane' && sameResource(a.resource, b.resource)
    return b.type === 'split' && a.axis === b.axis && a.children.length === b.children.length
        && a.weights.every((v, i) => v === b.weights[i]) && a.children.every((child, i) => sameTree(child, b.children[i]))
}
function cloneTree(node: WorkspaceNode): WorkspaceNode {
    return node.type === 'pane' ? { ...node, id: crypto.randomUUID() }
        : { ...node, id: crypto.randomUUID(), children: node.children.map(cloneTree) }
}

/** Shared intent + local presentation. This store never owns messages or execution processes. */
export class WorkspaceStore {
    readonly documents: DocumentRegistry
    leaveRequest?: { sessions: DocumentSession[]; finish: (leave: boolean) => void }
    private previewSlots = new Map<string, string>()
    private state: WorkspaceState
    private listeners = new Set<() => void>()
    private confirmed: WorkspaceSnapshot | null = null
    private pending: PendingOperation[] = []
    private temporary = new Map<string, WorkspaceDocument>()
    private enterAfterLoad: string | null | undefined
    private closed: { workspace: WorkspaceDocument; index: number } | null = null
    draggingSessionId: string | null = null
    readonly beforeHide = new Map<string, Set<() => void>>()
    readonly editing = new Map<string, Set<() => boolean>>()
    retrySync: () => void = () => {}
    constructor(private key: string, private storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage, synchronized = false) {
        this.documents = new DocumentRegistry(key)
        this.state = initial(synchronized)
        try {
            const saved = JSON.parse(storage?.getItem(key) ?? 'null')
            if (saved?.version === 1 && Array.isArray(saved.workspaces) && saved.workspaces.every((w: unknown) => WorkspaceDocumentSchema.safeParse(w).success)) {
                this.state = { ...this.state, mode: saved.mode, activeId: saved.activeId, lastChat: saved.lastChat,
                    workspaces: saved.workspaces, focused: saved.focused ?? {}, zoomed: saved.zoomed ?? {} }
                if (saved.synchronization) {
                    this.confirmed = saved.synchronization.confirmed ? WorkspaceSnapshotSchema.parse({ ...saved.synchronization.confirmed, schemaVersion: 2 }) : null
                    this.pending = saved.synchronization.pending.map((p: PendingOperation) => ({ operation: WorkspaceOperationSchema.parse(p.operation), attempted: p.attempted === true }))
                    for (const w of saved.synchronization.temporary ?? []) { const doc = WorkspaceDocumentSchema.parse(w); this.temporary.set(doc.id, doc) }
                } else if (saved.workspaces.length) {
                    // Only an empty Hub accepts a legacy browser layout. A second device must not overwrite it.
                    this.pending.push({ operation: { id: crypto.randomUUID(), command: { type: 'import', workspaces: saved.workspaces } }, attempted: false })
                }
                this.state.sync.initialized = !synchronized || this.confirmed !== null || this.state.workspaces.length > 0
                this.state.sync.pending = this.pending.length
                this.state.temporaryIds = [...this.temporary.keys()]
                this.repairFocus()
            }
        } catch { /* Unreadable layout cache does not affect the canonical chats. */ }
    }
    get = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    capture = () => {
        // Retained, hidden readers already saved their position before leaving.
        // A document hit-test there would instead sample the foreground chat.
        const active = this.active()
        if (active) for (const pane of panes(active.root)) for (const save of this.beforeHide.get(pane.id) ?? []) save()
    }
    active = () => this.state.workspaces.find(w => w.id === this.state.activeId)
    focusedPane = () => { const w = this.active(); return w ? panes(w.root).find(p => p.id === this.state.focused[w.id]) ?? panes(w.root)[0] : undefined }
    revision = () => this.confirmed?.revision ?? 0
    hasPending = () => this.pending.length > 0
    isTemporary = (id: string) => this.temporary.has(id)
    callbacks(id: string) { let set = this.beforeHide.get(id); if (!set) { set = new Set(); this.beforeHide.set(id, set) } return set }
    editingCallbacks(id: string) { let set = this.editing.get(id); if (!set) { set = new Set(); this.editing.set(id, set) } return set }
    private repairFocus() {
        if (!this.active()) this.state.activeId = this.state.workspaces[0]?.id ?? null
        for (const w of this.state.workspaces) {
            if (!panes(w.root).some(p => p.id === this.state.focused[w.id])) this.state.focused[w.id] = panes(w.root)[0].id
        }
    }
    private persist() {
        try { this.storage?.setItem(this.key, JSON.stringify({ ...this.state, synchronization: { confirmed: this.confirmed, pending: this.pending, temporary: [...this.temporary.values()] } })) }
        catch { /* Browser quota does not make an open editor unusable. */ }
    }
    private commit(next: WorkspaceState, capture = true) {
        if (capture) this.capture()
        const previous = this.focusedPane(), previousActive = this.state.activeId
        this.state = { ...next, focused: { ...next.focused }, zoomed: { ...next.zoomed }, temporaryIds: [...this.temporary.keys()], sync: { ...next.sync, pending: this.pending.length } }
        // A remotely moved focused pane keeps focus on this device; other devices' focus is never received.
        if (previous && this.state.activeId === previousActive) {
            const owner = this.state.workspaces.find(w => panes(w.root).some(p => p.id === previous.id && sameResource(p.resource, previous.resource)))
            if (owner && owner.id !== previousActive) { this.state.activeId = owner.id; this.state.focused[owner.id] = previous.id }
        }
        this.repairFocus()
        this.persist()
        this.listeners.forEach(listener => listener())
    }
    private sharedDocuments(): WorkspaceDocument[] {
        let docs = this.confirmed?.workspaces ?? []
        for (const { operation } of this.pending) {
            if (operation.command.type === 'import' && (this.confirmed?.revision ?? 0) > 0) continue
            docs = applyWorkspaceCommand(docs, operation.command).workspaces
        }
        return docs
    }
    private project(docs: WorkspaceDocument[]): WorkspaceDocument[] {
        let projected = docs
        for (const temporary of this.temporary.values()) {
            const localPanes = panes(temporary.root)
            // A protected editor has one DOM owner, including when the remote side reopens its chat elsewhere.
            projected = projected.map(w => {
                if (w.id === temporary.id) return temporary
                let root: WorkspaceNode | null = w.root
                for (const p of panes(w.root)) if (localPanes.some(local => local.id === p.id || (local.resource.kind !== 'empty' && sameResource(local.resource, p.resource)))) root = root ? removePane(root, p.id) : null
                return { ...w, root: root ?? { type: 'pane', id: `local-empty:${w.id}`, resource: { kind: 'empty' } } }
            })
            if (!projected.some(w => w.id === temporary.id)) projected = [...projected, temporary]
        }
        return projected.map(w => {
            const old = this.state.workspaces.find(old => old.id === w.id)
            return old && sameTree(old.root, w.root) ? (old.name === w.name ? old : { ...w, root: old.root }) : w
        })
    }
    setSyncStatus(status: WorkspaceState['sync']['status'], error?: string) {
        if (status === this.state.sync.status && error === this.state.sync.error) return
        this.commit({ ...this.state, sync: { ...this.state.sync, status, error } }, false)
    }
    /** A request's identity and payload are immutable once attempted, even if its response is lost. */
    nextRequest() {
        const item = this.pending[0]
        if (!item) return null
        item.attempted = true
        this.persist()
        return { expectedRevision: this.revision(), operation: item.operation }
    }
    receive(snapshot: WorkspaceSnapshot, acknowledged?: string, skipped?: string) {
        if (snapshot.revision < this.revision()) return
        const first = this.confirmed === null
        this.capture()
        if (acknowledged) this.pending = this.pending.filter(p => p.operation.id !== acknowledged)
        this.confirmed = snapshot
        const docs = this.sharedDocuments()
        for (const active of this.state.workspaces) {
            if (this.temporary.has(active.id)) continue
            const remotePanes = docs.flatMap(w => panes(w.root))
            const displaced = panes(active.root).some(p => {
                const next = remotePanes.find(n => n.id === p.id)
                return (!next || !sameResource(next.resource, p.resource)) && ((p.resource.kind === 'document' && this.documents.isDirty(p.resource)) || [...this.editingCallbacks(p.id)].some(editing => editing()))
            })
            if (displaced) this.temporary.set(active.id, active)
        }
        // Preserve an older device's unsynchronized layout as local views, rather than silently dropping it.
        if (first && snapshot.revision > 0) for (const p of this.pending) if (p.operation.command.type === 'import') {
            for (const w of p.operation.command.workspaces) if (!docs.some(d => d.id === w.id)) this.temporary.set(w.id, w)
        }
        this.commit({ ...this.state, workspaces: this.project(docs), sync: { status: this.pending.length ? 'syncing' : 'synced', initialized: true, pending: this.pending.length, skipped: skipped ?? this.state.sync.skipped } }, false)
        this.finishEntry()
    }
    initializeOffline() {
        this.commit({ ...this.state, sync: { ...this.state.sync, initialized: true } }, false)
        this.finishEntry()
    }
    private finishEntry() {
        if (this.enterAfterLoad === undefined) return
        const sessionId = this.enterAfterLoad
        this.enterAfterLoad = undefined
        this.enter(sessionId)
    }
    discardFailedOperation() {
        this.pending.shift()
        this.receive(this.confirmed ?? { schemaVersion: 2, revision: 0, workspaces: [] })
        this.retrySync()
    }
    clearSyncNotice() { this.commit({ ...this.state, sync: { ...this.state.sync, skipped: undefined } }, false) }
    private execute(command: WorkspaceCommand, patch: Partial<WorkspaceState> = {}, capture = true) {
        const source = 'workspaceId' in command ? command.workspaceId : 'paneId' in command ? this.state.workspaces.find(w => panes(w.root).some(p => p.id === command.paneId))?.id : undefined
        if (source && this.temporary.has(source)) {
            const result = applyWorkspaceCommand(this.state.workspaces, command)
            const temporary = result.workspaces.find(w => w.id === source)
            if (temporary) this.temporary.set(source, temporary)
            this.commit({ ...this.state, ...patch, workspaces: this.project(this.sharedDocuments()) }, capture)
            return
        }
        const result = applyWorkspaceCommand(this.sharedDocuments(), command)
        if (result.skipped) return
        const last = this.pending.at(-1)
        if (command.type === 'layout' && !command.added && last && !last.attempted && last.operation.command.type === 'layout' && last.operation.command.workspaceId === command.workspaceId) {
            // Keep the baseline membership of a coalesced drag/resize, including a sidebar drop.
            const previous = last.operation.command
            last.operation = { ...last.operation, command: { ...command, basePaneIds: previous.basePaneIds, added: previous.added ?? command.added } }
        } else this.pending.push({ operation: { id: crypto.randomUUID(), command }, attempted: false })
        this.commit({ ...this.state, ...patch, workspaces: this.project(result.workspaces), sync: { ...this.state.sync, status: this.state.sync.status === 'synced' ? 'syncing' : this.state.sync.status } }, capture)
    }
    enter(sessionId?: string | null) {
        if (!this.state.sync.initialized && !this.state.workspaces.length) {
            this.enterAfterLoad = sessionId ?? null
            this.commit({ ...this.state, mode: 'workspace' })
            return
        }
        if (!this.state.workspaces.length) this.create()
        this.commit({ ...this.state, mode: 'workspace' })
        if (sessionId && !this.state.lastChat) this.openSession(sessionId)
    }
    leave() {
        const resource = this.focusedPane()?.resource
        const id = resource?.kind === 'chat' ? resource.sessionId : this.state.lastChat
        this.capture()
        // Switching presentation does not close locally protected workspaces.
        this.commit({ ...this.state, mode: 'single', workspaces: this.project(this.sharedDocuments()) }, false)
        return id
    }
    create(name = `Window ${this.state.workspaces.length + 1}`) {
        const workspace = { id: crypto.randomUUID(), name, root: emptyPane() }
        this.execute({ type: 'create', workspace }, { mode: 'workspace', activeId: workspace.id })
    }
    activate(id: string) {
        if (!this.state.workspaces.some(w => w.id === id)) return
        this.commit({ ...this.state, activeId: id })
    }
    rename(workspaceId: string, name: string) { if (name.trim()) this.execute({ type: 'rename', workspaceId, name: name.trim() }, {}, false) }
    focus(id: string) {
        const w = this.state.workspaces.find(w => panes(w.root).some(p => p.id === id))
        if (!w || (this.state.activeId === w.id && this.state.focused[w.id] === id)) return
        const pane = panes(w.root).find(p => p.id === id)!
        this.commit({ ...this.state, activeId: w.id, focused: { ...this.state.focused, [w.id]: id }, lastChat: pane.resource.kind === 'chat' ? pane.resource.sessionId : this.state.lastChat })
    }
    zoom() { const w = this.active(); if (w) this.commit({ ...this.state, zoomed: { ...this.state.zoomed, [w.id]: !this.state.zoomed[w.id] } }) }
    setRoot(workspaceId: string, root: WorkspaceNode) {
        const w = this.state.workspaces.find(w => w.id === workspaceId)
        if (!w) return
        const basePaneIds = panes(w.root).map(p => p.id)
        const added = panes(root).find(p => !basePaneIds.includes(p.id))
        this.execute({ type: 'layout', workspaceId, root, basePaneIds, ...(added ? { added } : {}) })
    }
    private guarded(targets: PaneNode[], action: () => void) {
        const dirty = targets.filter(p => p.resource.kind === 'document' && this.documents.isDirty(p.resource))
        if (!dirty.length) { action(); return }
        if (this.leaveRequest) return
        this.leaveRequest = {
            sessions: dirty.map(p => this.documents.get(p.resource as DocumentResource)),
            finish: leave => {
                this.leaveRequest = undefined
                this.commit({ ...this.state }, false)
                // A remote rebind while the dialog was open invalidates this local intent.
                if (leave && targets.every(p => this.state.workspaces.flatMap(w => panes(w.root)).some(n => n.id === p.id && sameResource(n.resource, p.resource)))) action()
            },
        }
        this.commit({ ...this.state }, false)
    }
    openDocument(sourcePaneId: string, expected: PaneResource, resource: DocumentResource, beside = false) {
        const all = this.state.workspaces.flatMap(w => panes(w.root))
        const source = all.find(p => p.id === sourcePaneId)
        if (!source || !sameResource(source.resource, expected)) return
        const document = this.documents.get(resource)
        document.patch({ targetSessionId: expected.kind === 'empty' ? resource.sessionId : expected.sessionId })
        const existing = all.find(p => sameResource(p.resource, resource))
        if (existing) { this.focus(existing.id); return }
        const slot = all.find(p => p.id === this.previewSlots.get(resource.sessionId))
        if (!beside && slot?.resource.kind === 'document' && !this.documents.isDirty(slot.resource) && !this.documents.get(slot.resource).state.pinned) {
            this.bind(slot.id, resource); this.focus(slot.id); return
        }
        const w = this.state.workspaces.find(w => panes(w.root).some(p => p.id === sourcePaneId))!
        const added = { ...emptyPane(), resource }
        this.previewSlots.set(resource.sessionId, added.id)
        this.execute({ type: 'split', paneId: sourcePaneId, splitId: crypto.randomUUID(), axis: 'horizontal', added }, {
            activeId: w.id, focused: { ...this.state.focused, [w.id]: added.id }, zoomed: { ...this.state.zoomed, [w.id]: false },
        })
    }
    bind(id: string, resource: PaneResource, expectedSessionId?: string) {
        const w = this.state.workspaces.find(w => panes(w.root).some(p => p.id === id))
        if (!w) return
        const old = panes(w.root).find(p => p.id === id)!
        if (expectedSessionId && (old.resource.kind === 'empty' || old.resource.sessionId !== expectedSessionId)) return
        const existing = resource.kind !== 'empty' ? this.state.workspaces.flatMap(w => panes(w.root)).find(p => p.id !== id && sameResource(p.resource, resource)) : undefined
        if (existing) { this.guarded([old], () => { this.removePaneNow(id); this.focus(existing.id) }); return }
        this.guarded([old], () => this.execute({ type: 'bind', paneId: id, expected: old.resource, resource }, { lastChat: resource.kind === 'chat' && this.state.focused[w.id] === id ? resource.sessionId : this.state.lastChat }))
    }
    openSession(sessionId: string, beside?: 'horizontal' | 'vertical') {
        const existing = this.state.workspaces.flatMap(w => panes(w.root)).find(p => p.resource.kind === 'chat' && p.resource.sessionId === sessionId)
        if (existing) { this.focus(existing.id); return false }
        if (!this.active()) this.create()
        if (beside) this.split(beside, { kind: 'chat', sessionId })
        else { const id = this.focusedPane()!.id; this.bind(id, { kind: 'chat', sessionId }); this.focus(id) }
        return true
    }
    split(axis: SplitNode['axis'], resource: PaneResource = { kind: 'empty' }) {
        const w = this.active(), current = this.focusedPane()
        if (!w || !current) return
        const added = { ...emptyPane(), resource }
        this.execute({ type: 'split', paneId: current.id, splitId: crypto.randomUUID(), axis, added }, {
            focused: { ...this.state.focused, [w.id]: added.id }, zoomed: { ...this.state.zoomed, [w.id]: false }, lastChat: resource.kind === 'chat' ? resource.sessionId : this.state.lastChat,
        })
    }
    terminal(sessionId: string) { this.split('horizontal', { kind: 'terminal', sessionId, terminalId: `workspace-${crypto.randomUUID()}` }) }
    closePane(paneId: string) {
        const target = this.state.workspaces.flatMap(w => panes(w.root)).find(p => p.id === paneId)
        if (target) this.guarded([target], () => this.removePaneNow(paneId))
    }
    private removePaneNow(paneId: string) {
        this.execute({ type: 'remove', paneId, replacementId: crypto.randomUUID() })
        this.beforeHide.delete(paneId); this.editing.delete(paneId)
    }
    closeWorkspace(workspaceId: string) {
        const target = this.state.workspaces.find(w => w.id === workspaceId)
        if (target) this.guarded(panes(target.root), () => this.closeWorkspaceNow(workspaceId))
    }
    private closeWorkspaceNow(workspaceId: string) {
        const index = this.state.workspaces.findIndex(w => w.id === workspaceId)
        if (index < 0) return
        if (this.temporary.has(workspaceId)) { this.dismissTemporaryNow(workspaceId); return }
        this.closed = { workspace: this.state.workspaces[index], index }
        this.execute({ type: 'close', workspaceId })
        for (const p of panes(this.closed.workspace.root)) { this.beforeHide.delete(p.id); this.editing.delete(p.id) }
    }
    canUndo = () => this.closed !== null
    undoClose() {
        if (!this.closed) return
        const { workspace, index } = this.closed
        this.closed = null
        this.execute({ type: 'restore', workspace, index, replacementId: crypto.randomUUID() }, { activeId: workspace.id })
    }
    movePane(paneId: string, targetId: string) {
        const source = this.state.workspaces.find(w => panes(w.root).some(p => p.id === paneId))
        if (!source || this.temporary.has(source.id) || this.temporary.has(targetId)) return
        this.execute({ type: 'move', paneId, targetId, splitId: crypto.randomUUID(), replacementId: crypto.randomUUID() }, { activeId: targetId, focused: { ...this.state.focused, [targetId]: paneId } })
    }
    dismissTemporary(id: string) {
        const target = this.temporary.get(id)
        if (target) this.guarded(panes(target.root), () => this.dismissTemporaryNow(id))
    }
    private dismissTemporaryNow(id: string) {
        this.capture()
        this.temporary.delete(id)
        this.commit({ ...this.state, workspaces: this.project(this.sharedDocuments()) }, false)
    }
    shareTemporary(id: string) {
        const local = this.temporary.get(id)
        if (!local) return
        this.capture()
        this.temporary.delete(id)
        const workspace = { ...local, id: crypto.randomUUID(), root: cloneTree(local.root) }
        this.execute({ type: 'restore', workspace, index: this.sharedDocuments().length, replacementId: crypto.randomUUID() }, { activeId: workspace.id })
    }
}

// Used only to separate browser preferences. Authorization remains on the Hub.
export function workspaceStorageKey(baseUrl: string, token: string | null): string {
    let identity = 'anonymous'
    if (token) {
        try { const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); identity = JSON.stringify([claims.uid, claims.ns]) } catch { identity = 'local' }
    }
    return `hapi:workspaces:v1:${baseUrl}:${identity}`
}
