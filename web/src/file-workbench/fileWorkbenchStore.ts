import { documentKey, DocumentRefSchema, type DocumentRef, type DocumentResource } from '@hapi/protocol/documents'
import { filePathSuffix, relocatedFilePath, sameFileMachine } from '@/documents/filePaths'

export type FileTab = { id: string; resource: DocumentResource }
export type FileWorkbenchState = { tabs: FileTab[]; activeId: string | null; treeWidth: number; error?: string }
type FileOwner = { sessionId: string; machineId?: string }
type FileWorkbenchReader = {
    key: string
    affected: (paths: string[], owner?: FileOwner) => FileTab[]
    close: (ids: string[]) => void
    relocate: (from: string, to: string, owner?: FileOwner) => void
}
export const MAX_FILE_TABS = 16

/** Per-account, per-session references only. DocumentRegistry owns content/drafts. */
export class FileWorkbenchStore {
    readonly key: string
    private state: FileWorkbenchState = { tabs: [], activeId: null, treeWidth: 320 }
    private listeners = new Set<() => void>()
    private storageSnapshot: string | null | undefined
    private unpersisted = false
    constructor(readonly scope: string, readonly sessionId: string) {
        this.key = `${scope}:files:v1:${encodeURIComponent(sessionId)}`
        try { this.storageSnapshot = localStorage.getItem(this.key) }
        catch { return }
        try {
            const saved = JSON.parse(this.storageSnapshot ?? 'null')
            if (saved?.version !== 1 || !Array.isArray(saved.tabs)) return
            const identities = new Set<string>(), ids = new Set<string>()
            const tabs: FileTab[] = []
            for (const entry of saved.tabs.slice(0, MAX_FILE_TABS)) {
                const ref = DocumentRefSchema.safeParse(entry?.resource?.document)
                if (!ref.success || typeof entry.id !== 'string' || entry.id.length > 256 || !entry.id
                    || entry.resource.sessionId !== sessionId || ids.has(entry.id)) continue
                const resource: DocumentResource = { kind: 'document', sessionId, document: ref.data }
                const identity = documentKey(resource)
                if (identities.has(identity)) continue
                identities.add(identity); ids.add(entry.id)
                tabs.push({ id: entry.id, resource })
            }
            this.state = { tabs, activeId: tabs.some(tab => tab.id === saved.activeId) ? saved.activeId : tabs.at(-1)?.id ?? null,
                treeWidth: Number.isFinite(saved.treeWidth) ? Math.max(180, Math.min(480, saved.treeWidth)) : 320 }
        } catch { /* An invalid layout never grants access to another session. */ }
    }
    static latestStoredLayout(previous: FileWorkbenchStore): { store: FileWorkbenchStore; persist: boolean } {
        const stored = new FileWorkbenchStore(previous.scope, previous.sessionId)
        // A missing or intentionally empty layout is authoritative. Only an
        // unavailable read, or an unchanged disk snapshot after our failed write,
        // warrants retaining the unmounted instance's in-memory references.
        if (stored.storageSnapshot === undefined) return { store: previous, persist: false }
        return { store: previous.unpersisted && previous.storageSnapshot === stored.storageSnapshot ? previous : stored, persist: true }
    }
    get = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private commit(state: FileWorkbenchState, persist = true) {
        this.state = state
        if (persist) try {
            const snapshot = JSON.stringify({ version: 1, tabs: state.tabs, activeId: state.activeId, treeWidth: state.treeWidth })
            localStorage.setItem(this.key, snapshot)
            this.storageSnapshot = snapshot
            this.unpersisted = false
        } catch { this.unpersisted = true; this.state = { ...state, error: 'File tabs could not be saved in this browser.' } }
        this.listeners.forEach(listener => listener())
    }
    open(ref: DocumentRef): string | undefined {
        const resource: DocumentResource = { kind: 'document', sessionId: this.sessionId, document: ref }
        const existing = this.state.tabs.find(tab => documentKey(tab.resource) === documentKey(resource))
        if (existing) { this.select(existing.id); return existing.id }
        if (this.state.tabs.length >= MAX_FILE_TABS) {
            this.commit({ ...this.state, error: `Up to ${MAX_FILE_TABS} files can be open. Close a tab before opening another file.` })
            return undefined
        }
        const tab = { id: crypto.randomUUID(), resource }
        this.commit({ ...this.state, tabs: [...this.state.tabs, tab], activeId: tab.id, error: undefined })
        return tab.id
    }
    select(id: string) {
        if (id === this.state.activeId || !this.state.tabs.some(tab => tab.id === id)) return
        this.commit({ ...this.state, activeId: id, error: undefined })
    }
    close(ids: string[], persist = true) {
        if (!this.state.tabs.some(tab => ids.includes(tab.id))) return
        const index = this.state.tabs.findIndex(tab => tab.id === this.state.activeId)
        const tabs = this.state.tabs.filter(tab => !ids.includes(tab.id))
        const activeId = tabs.some(tab => tab.id === this.state.activeId) ? this.state.activeId : tabs[Math.min(index, tabs.length - 1)]?.id ?? null
        this.commit({ ...this.state, tabs, activeId, error: undefined }, persist)
    }
    reorder(id: string, beforeId: string) {
        const tab = this.state.tabs.find(tab => tab.id === id)
        if (!tab || id === beforeId) return
        const tabs = this.state.tabs.filter(tab => tab.id !== id)
        const index = tabs.findIndex(tab => tab.id === beforeId)
        if (index < 0) return
        tabs.splice(index, 0, tab)
        this.commit({ ...this.state, tabs })
    }
    resize(width: number) {
        if (!Number.isFinite(width)) return
        this.commit({ ...this.state, treeWidth: Math.max(180, Math.min(480, Math.round(width))) })
    }
    affected(paths: string[], owner?: FileOwner) {
        return this.state.tabs.filter(tab => tab.resource.document.kind === 'file'
            && (!owner || sameFileMachine(tab.resource, owner))
            && paths.some(path => filePathSuffix(tab.resource.document.kind === 'file' ? tab.resource.document.path : '', path) !== null))
    }
    relocate(from: string, to: string, owner?: FileOwner, persist = true) {
        let changed = false
        const tabs = this.state.tabs.map(tab => {
            if (owner && !sameFileMachine(tab.resource, owner)) return tab
            const ref = tab.resource.document
            const path = ref.kind === 'file' ? relocatedFilePath(ref.path, from, to) : null
            if (path === null || (ref.kind === 'file' && path === ref.path)) return tab
            changed = true
            return { ...tab, resource: { ...tab.resource, document: { ...ref, path } as DocumentRef } }
        })
        if (changed) this.commit({ ...this.state, tabs }, persist)
    }
}

// Multiple retained workspace panes can show the same physical file. Keep
// their tab references synchronized with the shared DocumentRegistry owner.
const mounted = new WeakMap<object, Set<FileWorkbenchStore>>()
export function registerFileWorkbench(owner: object, store: FileWorkbenchStore) {
    let stores = mounted.get(owner)
    if (!stores) { stores = new Set(); mounted.set(owner, stores) }
    stores.add(store)
    return () => { stores.delete(store); if (!stores.size) mounted.delete(owner) }
}
export function fileWorkbenches(owner: object, current: FileWorkbenchStore): ReadonlySet<FileWorkbenchReader> {
    // An operation may settle after its initiating view unmounted. Its durable
    // tab references still need reconciliation, but a newer mount may already
    // have changed them. Each key has one durable layout but can have several
    // independent, mounted readers. Reconcile every reader without letting its
    // full tab list overwrite the latest durable layout.
    type Group = { previous: FileWorkbenchStore; live: FileWorkbenchStore[]; stored?: FileWorkbenchStore }
    const groups = new Map<string, Group>([[current.key, { previous: current, live: [] }]])
    for (const store of mounted.get(owner) ?? []) {
        if (store.scope !== current.scope) continue
        const group = groups.get(store.key)
        if (group) { group.previous = store; group.live.push(store) }
        else groups.set(store.key, { previous: store, live: [store] })
    }
    // Tabs in an inactive conversation are still open references. Reconcile
    // their scoped persisted layouts without keeping their editors mounted.
    const prefix = `${current.scope}:files:v1:`
    try {
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index)
            if (!key?.startsWith(prefix) || groups.has(key)) continue
            let sessionId: string
            try { sessionId = decodeURIComponent(key.slice(prefix.length)) } catch { continue }
            const stored = new FileWorkbenchStore(current.scope, sessionId)
            if (stored.key === key && stored.get().tabs.length) groups.set(key, { previous: stored, stored, live: [] })
        }
    } catch { /* Mounted readers remain available when browser storage is unavailable. */ }
    const readers = new Set<FileWorkbenchReader>()
    const reader = (store: FileWorkbenchStore, persist: boolean): FileWorkbenchReader => ({
        key: store.key,
        affected: (paths, machine) => store.affected(paths, machine),
        close: ids => store.close(ids, persist),
        relocate: (from, to, machine) => store.relocate(from, to, machine, persist),
    })
    for (const group of groups.values()) {
        const target = group.stored ? { store: group.stored, persist: true } : FileWorkbenchStore.latestStoredLayout(group.previous)
        readers.add(reader(target.store, target.persist))
        for (const live of group.live) {
            if (live !== target.store) readers.add(reader(live, false))
        }
    }
    return readers
}
