import type { EditorState } from '@codemirror/state'
import { documentKey, documentName, MAX_EDITABLE_FILE_BYTES, type DocumentResource, type DocumentSelection } from '@hapi/protocol/documents'
import type { ApiClient } from '@/api/client'
import type { HtmlPreview } from './htmlPreview'
import { filePathSuffix, relocatedFilePath, sameFileMachine } from './filePaths'

export type TextFormat = { bom: boolean; eol: '\n' | '\r\n'; mixed?: boolean }
export function decodeDocumentText(bytes: Uint8Array): { text: string; format: TextFormat } | null {
    if (bytes.includes(0)) return null
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        const withoutCrLf = text.replaceAll('\r\n', '')
        const mixed = withoutCrLf.includes('\r') || (text.includes('\r\n') && withoutCrLf.includes('\n'))
        return { text: text.replaceAll('\r\n', '\n'), format: { bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, eol: text.includes('\r\n') ? '\r\n' : '\n', ...(mixed ? { mixed: true } : {}) } }
    } catch { return null }
}
export function encodeDocumentText(text: string, format: TextFormat): Uint8Array {
    if (format.mixed) throw new Error('Mixed line endings cannot be saved without changing the original format')
    return new TextEncoder().encode((format.bom ? '\ufeff' : '') + (format.eol === '\r\n' ? text.replaceAll('\n', '\r\n') : text))
}
export function base64Bytes(content: string): Uint8Array { return Uint8Array.from(atob(content), c => c.charCodeAt(0)) }
export function bytesBase64(bytes: Uint8Array): string {
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(text)
}
type Draft = { resource: DocumentResource; text: string; baseText: string; hash: string; format: TextFormat }
let database: Promise<IDBDatabase> | undefined
function draftDatabase(): Promise<IDBDatabase> {
    return database ??= new Promise((resolve, reject) => {
        const request = indexedDB.open('hapi-document-drafts', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('drafts')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => { database = undefined; reject(request.error) }
    })
}
async function draftRequest<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await draftDatabase()
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('drafts', mode)
        const request = fn(transaction.objectStore('drafts'))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error)
    })
}
export type DocumentState = {
    phase: 'idle' | 'loading' | 'ready' | 'error'; text: string; baseText: string; hash: string
    format: TextFormat; textual: boolean; writable: boolean; dirty: boolean; saving: boolean; error?: string; conflict: boolean
    persistenceError?: string; blob?: Blob; mode: 'preview' | 'edit'; pinned: boolean
    preview?: { id: string; length: number }
    selection?: DocumentSelection; targetSessionId: string
    changedOnDisk?: boolean; contentRevision: number; fileOperation?: boolean
}

/** Owns local editing state across pane moves, hidden workspaces and React remounts. */
export class DocumentSession {
    state: DocumentState
    editorState?: EditorState
    scrollTop = 0
    previewScrollTop = 0
    htmlPreview?: HtmlPreview
    page = 1
    zoom = 1
    users = 0
    touched = Date.now()
    private listeners = new Set<() => void>()
    private loading?: Promise<void>
    private loadingSavedRevision = 0
    private saving?: Promise<boolean>
    private savedRevision = 0
    private persistence?: Promise<void>
    private persistencePending = false
    private metadata?: string
    private checking = false
    private lastCheck = 0
    persistedDraft = false
    constructor(public resource: DocumentResource, private registry: DocumentRegistry) {
        this.state = { phase: 'idle', text: '', baseText: '', hash: '', format: { bom: false, eol: '\n' }, textual: false, writable: false,
            dirty: false, saving: false, conflict: false, mode: /\.(?:md|markdown|mdx|html?)$/i.test(documentName(resource.document)) ? 'preview' : 'edit',
            pinned: false, targetSessionId: resource.sessionId, contentRevision: 0 }
    }
    get = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    patch(patch: Partial<DocumentState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()) }
    get key() { return `${this.registry.scope}:${documentKey(this.resource)}` }
    get bytes() { return (this.state.blob?.size ?? 0) + (this.state.text.length + this.state.baseText.length) * 2 + (this.htmlPreview?.bytes ?? 0) }
    async load(api: ApiClient, refresh = false, requestSessionId = this.resource.sessionId): Promise<void> {
        if (this.state.fileOperation) return
        if (this.loading && this.loadingSavedRevision === this.savedRevision) return this.loading
        if (!refresh && this.state.phase === 'ready') return
        const savedRevision = this.savedRevision
        this.patch({ phase: this.state.phase === 'ready' ? 'ready' : 'loading', error: undefined })
        this.loadingSavedRevision = savedRevision
        const loading = (async () => {
            try {
                const ref = this.resource.document
                if (/\.(pptx?|docx?|od[tp])$/i.test(documentName(ref))) {
                    // PDF.js requests the first page's byte ranges, not the entire converted file.
                    const { previewId, length, version, modified, size } = await api.prepareDocumentPreview(requestSessionId, ref)
                    if (savedRevision !== this.savedRevision) return
                    this.metadata = modified === undefined ? undefined : `${size}:${modified}`
                    this.patch({ phase: 'ready', preview: { id: previewId, length }, hash: version, changedOnDisk: false, selection: undefined,
                        contentRevision: this.state.contentRevision + 1 })
                    this.registry.trim()
                    return
                }
                let draft: Draft | undefined
                if (this.state.phase !== 'ready' && !this.state.dirty) {
                    draft = await draftRequest('readonly', store => store.get(this.key)).catch(() => undefined)
                    if (savedRevision !== this.savedRevision) return
                    if (draft) this.patch({ text: draft.text, baseText: draft.baseText, hash: draft.hash, format: draft.format,
                        dirty: draft.text !== draft.baseText, pinned: true, textual: true,
                        writable: ref.kind === 'file' && !!draft.hash && !draft.format.mixed })
                }
                const result = ref.kind === 'file' ? await api.readSessionFile(requestSessionId, ref.path) : null
                if (result && (!result.success || result.content === undefined)) throw new Error(result.error ?? 'Unable to read file')
                const blob = result ? new Blob([base64Bytes(result.content!) as Uint8Array<ArrayBuffer>]) : await api.getArtifactBlob(requestSessionId, ref.kind === 'artifact' ? ref.artifactId : '')
                const decoded = blob.size <= MAX_EDITABLE_FILE_BYTES || /\.html?$/i.test(documentName(ref)) ? decodeDocumentText(new Uint8Array(await blob.arrayBuffer())) : null
                // A reload may have read its bytes before a concurrent save committed.
                // Its late response cannot replace the acknowledged text/hash baseline.
                if (savedRevision !== this.savedRevision) return
                const text = decoded?.text ?? ''
                const hash = result?.hash ?? ''
                this.metadata = result?.modified === undefined ? undefined : `${result.size}:${result.modified}`
                const local = this.state.dirty ? { text: this.state.text, baseText: this.state.baseText, hash: this.state.hash, format: this.state.format } : draft
                const conflict = !!local && local.hash !== hash
                // A failed/lost save response may already have committed this exact draft.
                const settled = !!local && local.text === text
                if (!local && this.state.text !== text) this.editorState = undefined
                this.patch({ phase: 'ready', blob, text: local && !settled ? local.text : text,
                    baseText: local && !settled ? local.baseText : text, hash: local && !settled ? local.hash : hash,
                    format: local && !settled ? local.format : decoded?.format ?? this.state.format,
                    textual: !!decoded, writable: ref.kind === 'file' && blob.size <= MAX_EDITABLE_FILE_BYTES && !!decoded && !decoded.format.mixed && !!hash && result?.writable === true,
                    dirty: !!local && !settled && local.text !== local.baseText, conflict: conflict && !settled,
                    pinned: this.state.pinned || !!local, changedOnDisk: false, selection: local && !settled ? this.state.selection : undefined,
                    contentRevision: this.state.contentRevision + (!decoded || ((!local || settled) && this.state.text !== text) || (refresh && /\.html?$/i.test(documentName(ref))) ? 1 : 0) })
                if (settled) await this.persist()
                if (draft && this.state.dirty) this.persistedDraft = true
                this.registry.trim()
            } catch (error) {
                if (savedRevision !== this.savedRevision) return
                this.patch({ phase: this.state.phase === 'ready' || this.state.dirty ? 'ready' : 'error', error: String(error) })
            }
        })().finally(() => { if (this.loading === loading) this.loading = undefined })
        this.loading = loading
        return loading
    }
    edit(text: string, editorState?: EditorState) {
        this.persistedDraft = false
        this.editorState = editorState
        this.patch({ text, dirty: text !== this.state.baseText, pinned: true, error: undefined })
        void this.persist()
    }
    async checkUpdates(api: ApiClient, requestSessionId = this.resource.sessionId) {
        const ref = this.resource.document
        if (ref.kind !== 'file' || this.state.fileOperation || this.checking || this.loading || this.state.saving || Date.now() - this.lastCheck < 5000) return
        const revision = this.savedRevision
        this.checking = true; this.lastCheck = Date.now()
        try {
            const result = await api.getDocumentFileInfo(requestSessionId, ref.path)
            if (!result.success || revision !== this.savedRevision || this.state.fileOperation) return
            const info = result.entries?.[0]
            if (info?.modified === undefined) { this.patch({ changedOnDisk: true }); return }
            const next = `${info.size}:${info.modified}`
            if (this.metadata !== undefined && next !== this.metadata) this.patch({ changedOnDisk: true })
            this.metadata ??= next
        } catch { /* Keep cached content readable; explicit Reload surfaces read errors. */ }
        finally { this.checking = false }
    }
    persist(): Promise<unknown> {
        this.registry.markDirty(this.resource, this.state.dirty)
        this.persistencePending = true
        if (this.persistence) return this.persistence
        // At most one write in flight and one latest snapshot, even on a slow disk.
        this.persistence = Promise.resolve().then(async () => {
            while (this.persistencePending) {
                this.persistencePending = false
                const snapshot = this.state
                if (snapshot.dirty) await draftRequest('readwrite', store => store.put({ resource: this.resource, text: snapshot.text, baseText: snapshot.baseText, hash: snapshot.hash, format: snapshot.format } satisfies Draft, this.key))
                else await draftRequest('readwrite', store => store.delete(this.key))
                this.persistedDraft = snapshot.text === this.state.text && snapshot.hash === this.state.hash
                if (this.state.persistenceError) this.patch({ persistenceError: undefined })
            }
        }).catch(error => { this.persistedDraft = false; this.patch({ persistenceError: `Draft could not be saved in this browser: ${String(error)}` }); throw error })
            .finally(() => { this.persistence = undefined; this.registry.trim() })
        // Surface failures without an unhandled rejection from keystroke persistence.
        this.persistence.catch(() => {})
        return this.persistence
    }
    save(api: ApiClient, requestSessionId = this.resource.sessionId): Promise<boolean> {
        if (this.state.fileOperation) return Promise.resolve(false)
        if (this.saving) return this.saving
        const state = this.state, ref = this.resource.document
        if (!state.dirty) return Promise.resolve(true)
        if (!state.writable || ref.kind !== 'file') return Promise.resolve(false)
        this.patch({ saving: true, error: undefined })
        this.saving = (async () => {
            try {
                const bytes = encodeDocumentText(state.text, state.format)
                const response = await api.writeSessionFile(requestSessionId, { path: ref.path, content: bytesBase64(bytes), expectedHash: state.hash })
                if (!response.success || !response.hash) { this.patch({ error: response.error ?? 'Save failed', conflict: response.code === 'conflict' }); return false }
                this.savedRevision++
                this.metadata = response.modified === undefined ? undefined : `${bytes.length}:${response.modified}`
                this.patch({ phase: 'ready', hash: response.hash, baseText: state.text, dirty: this.state.text !== state.text, conflict: false,
                    blob: new Blob([bytes as Uint8Array<ArrayBuffer>]), changedOnDisk: false })
                await this.persist()
                return true
            } catch (error) { this.patch({ error: String(error) }); return false }
            finally { this.patch({ saving: false }); this.saving = undefined }
        })()
        return this.saving
    }
    async discard() {
        this.editorState = undefined
        this.patch({ text: this.state.baseText, dirty: false, conflict: false, selection: undefined })
        await this.persist()
    }
    async restoreLocalDraft() {
        if (this.state.dirty || this.state.phase === 'ready') return
        const draft = await draftRequest<Draft | undefined>('readonly', store => store.get(this.key))
        if (!draft || this.state.dirty) return
        this.patch({ phase: 'ready', text: draft.text, baseText: draft.baseText, hash: draft.hash, format: draft.format,
            dirty: draft.text !== draft.baseText, textual: true, writable: !!draft.hash && !draft.format.mixed, pinned: true })
        this.persistedDraft = true
    }
    beginFileOperation() {
        if (this.state.saving || this.loading || this.state.fileOperation) throw new Error('Wait for the current file operation to finish.')
        this.savedRevision++
        this.patch({ fileOperation: true })
    }
    endFileOperation() { if (this.state.fileOperation) this.patch({ fileOperation: false }) }
    /** Disk identity changed. A kept draft remains local until the new bytes
     * have been read and compared; a clean cache cannot outlive a deleted file.
     */
    invalidateFile() {
        this.savedRevision++
        this.metadata = undefined
        this.lastCheck = 0
        this.htmlPreview = undefined
        if (!this.state.dirty) {
            this.editorState = undefined
            this.scrollTop = 0
            this.previewScrollTop = 0
        }
        this.patch({ phase: 'idle', blob: undefined, preview: undefined, error: undefined,
            changedOnDisk: true, selection: undefined, contentRevision: this.state.contentRevision + 1,
            ...(!this.state.dirty ? { text: '', baseText: '', hash: '', textual: false, writable: false, conflict: false } : {}) })
    }
    /** The server already moved the bytes. Keep the same editor, undo state and draft. */
    async relocate(resource: DocumentResource) {
        const previousKey = this.key
        if (this.persistence) await this.persistence.catch(() => {})
        this.resource = resource
        this.savedRevision++
        this.metadata = undefined
        this.lastCheck = 0
        // Local HTML assets resolve against the containing directory.
        this.htmlPreview = undefined
        this.patch({ contentRevision: this.state.contentRevision + (/\.html?$/i.test(documentName(resource.document)) ? 1 : 0) })
        if (this.state.dirty || this.persistedDraft) {
            // Retain the old durable copy until the new identity is safely written.
            await this.persist()
            if (previousKey !== this.key) await draftRequest('readwrite', store => store.delete(previousKey))
        }
    }
}

export class DocumentRegistry {
    private sessions = new Map<string, DocumentSession>()
    private dirty = new Set<string>()
    constructor(readonly scope: string) {
        try { this.dirty = new Set(JSON.parse(localStorage.getItem(`${scope}:document-dirty`) ?? '[]')) } catch { /* IndexedDB still owns the drafts. */ }
    }
    get(resource: DocumentResource) {
        const key = documentKey(resource)
        let session = this.sessions.get(key)
        if (!session) { session = new DocumentSession(resource, this); this.sessions.set(key, session) }
        session.touched = Date.now()
        return session
    }
    isDirty(resource: DocumentResource) { return this.sessions.get(documentKey(resource))?.state.dirty || this.dirty.has(documentKey(resource)) }
    fileSessions(owner: { sessionId: string; machineId?: string }, paths: string[]) {
        // Closed tabs can still have a durable draft. Materialize their owners so
        // directory moves and deletes include those drafts in the same guard.
        for (const key of this.dirty) {
            try {
                const [kind, identity, path] = JSON.parse(key)
                if (kind !== 'file' || identity !== (owner.machineId ?? owner.sessionId) || typeof path !== 'string'
                    || !paths.some(root => filePathSuffix(path, root) !== null)) continue
                this.get({ kind: 'document', sessionId: owner.sessionId, document: { kind: 'file', path, ...(owner.machineId ? { machineId: owner.machineId } : {}) } })
            } catch { /* Ignore malformed old draft identities. */ }
        }
        return [...this.sessions.values()].filter(session => sameFileMachine(session.resource, owner)
            && session.resource.document.kind === 'file' && paths.some(path => filePathSuffix(session.resource.document.kind === 'file' ? session.resource.document.path : '', path) !== null))
    }
    invalidateFiles(owner: { sessionId: string; machineId?: string }, paths: string[]) {
        for (const session of this.fileSessions(owner, paths)) session.invalidateFile()
    }
    async relocateFiles(owner: { sessionId: string; machineId?: string }, from: string, to: string) {
        const sessions = this.fileSessions(owner, [from])
        const failures: unknown[] = []
        for (const session of sessions) {
            const previous = session.resource
            if (previous.document.kind !== 'file') continue
            const path = relocatedFilePath(previous.document.path, from, to)
            if (path === null) continue
            const resource: DocumentResource = { ...previous, document: { ...previous.document, path } }
            const previousKey = documentKey(previous), nextKey = documentKey(resource)
            const collision = this.sessions.get(nextKey)
            if (collision && collision !== session && (collision.state.dirty || collision.state.saving)) throw new Error('The destination has an unsaved document.')
            this.sessions.delete(previousKey)
            this.sessions.set(nextKey, session)
            try {
                await session.relocate(resource)
                // Clear the old recovery identity only after the new draft is
                // durable. Typing while the move awaited its last write can
                // otherwise re-add the old key after an early removal.
                this.markDirty(previous, false)
                this.markDirty(resource, session.state.dirty)
            } catch (error) {
                this.markDirty(resource, session.state.dirty)
                failures.push(error)
            }
        }
        if (failures.length) throw new Error(`File moved; a local draft still needs to be saved: ${String(failures[0])}`)
    }
    markDirty(resource: DocumentResource, dirty: boolean) {
        if (this.dirty.has(documentKey(resource)) === dirty) return
        if (dirty) this.dirty.add(documentKey(resource)); else this.dirty.delete(documentKey(resource))
        try { localStorage.setItem(`${this.scope}:document-dirty`, JSON.stringify([...this.dirty])) } catch { /* Full draft persistence reports its own error. */ }
    }
    trim() {
        let bytes = [...this.sessions.values()].reduce((sum, session) => sum + session.bytes, 0)
        for (const [key, session] of [...this.sessions].sort((a, b) => a[1].touched - b[1].touched)) {
            if (bytes <= 64 * 1024 * 1024 && this.sessions.size <= 8) break
            if (session.users || (session.state.dirty && !session.persistedDraft) || session.state.saving || session.state.fileOperation) continue
            bytes -= session.bytes; this.sessions.delete(key)
        }
    }
}
