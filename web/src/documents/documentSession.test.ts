import { describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import { EditorState } from '@codemirror/state'
import type { ApiClient } from '@/api/client'
import { bytesBase64, decodeDocumentText, encodeDocumentText, DocumentRegistry } from './documentSession'
import { documentKey, type DocumentResource } from '@hapi/protocol/documents'
import { panes, WorkspaceStore } from '@/workspace/workspaceStore'
const file = (path = '/project/notes.md', sessionId = 'A'): DocumentResource => ({ kind: 'document', sessionId, document: { kind: 'file', path, machineId: 'machine-A' } })

describe('document ownership', () => {
    it('previews HTML beyond the source editing limit without enabling large-file writes', async () => {
        const session = new DocumentRegistry(crypto.randomUUID()).get(file('/project/report.html'))
        const text = '<p>Readable report</p>' + ' '.repeat(4 * 1024 * 1024)
        const api = { readSessionFile: vi.fn().mockResolvedValue({ success: true, content: bytesBase64(new TextEncoder().encode(text)), writable: true, hash: 'a'.repeat(64) }) } as unknown as ApiClient
        // JSDOM's Blob lacks arrayBuffer(); use the platform implementation.
        vi.stubGlobal('Blob', NodeBlob)
        try {
            await session.load(api)
            expect(session.state).toMatchObject({ phase: 'ready', textual: true, writable: false, mode: 'preview' })
            expect(session.state.text).toBe(text)
        } finally { vi.unstubAllGlobals() }
    })
    it('opens Office from a range descriptor without downloading the complete preview or original', async () => {
        const session = new DocumentRegistry(crypto.randomUUID()).get(file('/project/slides.pptx'))
        const prepare = vi.fn().mockResolvedValue({ previewId: 'preview-1', length: 24_000_000, version: 'source-version', modified: 10, size: 25_000_000 })
        const api = { prepareDocumentPreview: prepare, getDocumentPreview: vi.fn(), readSessionFile: vi.fn() } as unknown as ApiClient
        await session.load(api)
        expect(session.state).toMatchObject({ phase: 'ready', preview: { id: 'preview-1', length: 24_000_000 }, hash: 'source-version' })
        expect(session.state.blob).toBeUndefined()
        expect(api.getDocumentPreview).not.toHaveBeenCalled()
        expect(api.readSessionFile).not.toHaveBeenCalled()
        await session.load(api)
        expect(prepare).toHaveBeenCalledTimes(1)
    })
    it('round-trips BOM, Chinese text and CRLF without adding or removing a final newline', () => {
        for (const source of ['\ufeff标题\r\n第二行\r\n', 'plain\ntext', '']) {
            const bytes = new TextEncoder().encode(source)
            const decoded = decodeDocumentText(bytes)!
            expect(encodeDocumentText(decoded.text, decoded.format)).toEqual(bytes)
        }
        expect(decodeDocumentText(new Uint8Array([0xff, 0xfe, 0x41, 0]))).toBeNull()
        const mixed = decodeDocumentText(new TextEncoder().encode('one\r\ntwo\nthree'))!
        expect(mixed.format.mixed).toBe(true)
        expect(() => encodeDocumentText(mixed.text, mixed.format)).toThrow('Mixed line endings')
    })
    it('opens beside the initiating chat even after focus has moved and reuses a clean preview', () => {
        const store = new WorkspaceStore(crypto.randomUUID())
        store.enter('A'); const source = store.focusedPane()!
        store.openSession('B', 'horizontal')
        store.openDocument(source.id, source.resource, file())
        const document = store.focusedPane()!
        expect(document.resource).toEqual(file())
        store.openDocument(source.id, source.resource, file('/project/second.md'))
        expect(store.focusedPane()!.id).toBe(document.id)
        expect(panes(store.active()!.root)).toHaveLength(3)
        store.documents.get(file('/project/second.md')).patch({ dirty: true, pinned: true })
        store.openDocument(source.id, source.resource, file('/project/third.md'))
        expect(panes(store.active()!.root)).toHaveLength(4)
    })
    it('protects dirty documents in hidden workspaces from remote closing', () => {
        const store = new WorkspaceStore(crypto.randomUUID())
        store.enter('A'); const source = store.focusedPane()!
        store.openDocument(source.id, source.resource, file())
        const first = store.active()!
        store.documents.get(file()).patch({ dirty: true })
        // Acknowledge local layout before observing a genuinely remote close.
        for (let next = store.nextRequest(); next; next = store.nextRequest()) {
            store.receive({ schemaVersion: 2, revision: store.revision() + 1, workspaces: store.get().workspaces }, next.operation.id)
        }
        store.create('Other')
        store.receive({ schemaVersion: 2, revision: store.revision() + 1, workspaces: [] })
        expect(store.isTemporary(first.id)).toBe(true)
        expect(store.get().workspaces.find(w => w.id === first.id)).toBeDefined()
    })
    it('returns to the initiating file browser without closing a pinned document or another chat', () => {
        const store = new WorkspaceStore(crypto.randomUUID())
        store.enter('A'); const source = store.focusedPane()!
        const tool = { view: 'directories' as const, query: 'notes' }
        store.setPaneTool(source.id, source.resource, tool)
        store.openDocument(source.id, source.resource, file(), false, tool)
        store.setPaneTool(source.id, source.resource, null)
        const document = store.focusedPane()!
        store.documents.get(file()).patch({ pinned: true })
        store.openSession('B', 'horizontal')
        expect(store.returnFromDocument(document.id)).toBe(true)
        expect(store.getPaneTools(source.id, source.resource)?.current).toEqual(tool)
        expect(store.focusedPane()!.id).toBe(source.id)
        expect(panes(store.active()!.root)).toHaveLength(3)
        expect(panes(store.active()!.root).find(p => p.id === document.id)?.resource).toEqual(file())
    })
    it('replaces a reused preview return target with its latest initiating browser', () => {
        const store = new WorkspaceStore(crypto.randomUUID())
        store.enter('A'); const a = store.focusedPane()!
        const toolA = { view: 'directories' as const, query: 'from A' }, toolB = { view: 'directories' as const, query: 'from B' }
        store.openDocument(a.id, a.resource, file(), false, toolA)
        const documentId = store.focusedPane()!.id
        store.openSession('B', 'horizontal'); const b = store.focusedPane()!
        store.openDocument(b.id, b.resource, file(), false, toolB)
        expect(store.returnFromDocument(documentId)).toBe(true)
        expect(store.getPaneTools(a.id, a.resource)?.current).toBeUndefined()
        expect(store.getPaneTools(b.id, b.resource)?.current).toEqual(toolB)
        expect(store.focusedPane()!.id).toBe(b.id)
    })
    it('does not restore a stale browser after its source is rebound or closed', () => {
        for (const action of ['rebind', 'close'] as const) {
            const store = new WorkspaceStore(crypto.randomUUID())
            store.enter('A'); const source = store.focusedPane()!
            store.setPaneTool(source.id, source.resource, { view: 'directories' })
            store.openDocument(source.id, source.resource, file(), false, { view: 'directories' })
            const documentId = store.focusedPane()!.id
            if (action === 'rebind') store.bind(source.id, { kind: 'chat', sessionId: 'B' })
            if (action === 'close') store.closePane(source.id)
            expect(store.returnFromDocument(documentId)).toBe(false)
            if (action === 'rebind') store.bind(source.id, source.resource)
            expect(store.returnFromDocument(documentId)).toBe(false)
            expect(store.getPaneTools(source.id, source.resource)?.current).toBeUndefined()
            expect(store.focusedPane()!.id).toBe(documentId)
        }
    })
    it('does not discard a dirty document when canceling close or rebinding the pane', () => {
        const store = new WorkspaceStore(crypto.randomUUID())
        store.enter('A'); const source = store.focusedPane()!
        store.openDocument(source.id, source.resource, file())
        const id = store.focusedPane()!.id
        store.documents.get(file()).patch({ dirty: true })
        store.bind(id, { kind: 'chat', sessionId: 'C' })
        expect(store.leaveRequest).toBeDefined()
        expect(store.focusedPane()!.resource).toEqual(file())
        store.leaveRequest!.finish(false)
        expect(store.focusedPane()!.resource).toEqual(file())
    })
    it('reuses one file across sessions while distinguishing machines and retaining its original request target on focus changes', () => {
        expect(documentKey(file())).toBe(documentKey(file('/project/notes.md', 'B')))
        expect(documentKey(file())).toBe(documentKey(file('/project/./sub/../notes.md')))
        expect(documentKey(file('C:\\project\\NOTES.md'))).toBe(documentKey(file('c:/project/notes.md')))
        const registry = new DocumentRegistry(crypto.randomUUID())
        expect(registry.get(file())).toBe(registry.get(file('/project/notes.md', 'B')))
        const other: DocumentResource = { ...file(), document: { kind: 'file', path: '/project/notes.md', machineId: 'machine-B' } }
        expect(registry.get(other)).not.toBe(registry.get(file()))
        expect(registry.get(file()).state.targetSessionId).toBe('A')
    })
    it('keeps edits typed during a save dirty against the version that was actually written', async () => {
        const session = new DocumentRegistry(crypto.randomUUID()).get(file())
        session.patch({ phase: 'ready', textual: true, writable: true, text: 'first edit', baseText: 'base', hash: 'old', dirty: true })
        vi.spyOn(session, 'persist').mockResolvedValue(undefined)
        let finish!: (value: { success: boolean; hash: string }) => void
        const write = vi.fn(() => new Promise<{ success: boolean; hash: string }>(resolve => { finish = resolve }))
        const pending = session.save({ writeSessionFile: write } as unknown as ApiClient)
        session.edit('second edit')
        finish({ success: true, hash: 'saved-first' })
        expect(await pending).toBe(true)
        expect(session.state).toMatchObject({ text: 'second edit', baseText: 'first edit', hash: 'saved-first', dirty: true, saving: false })
        expect(write).toHaveBeenCalledTimes(1)
    })
    it('notifies a metadata change without fetching bytes, replacing the reader, or losing a selection', async () => {
        vi.useFakeTimers()
        try {
            const session = new DocumentRegistry(crypto.randomUUID()).get(file())
            const selection = { kind: 'text' as const, from: 0, to: 4, lineStart: 1, lineEnd: 1, quote: 'read' }
            session.patch({ phase: 'ready', text: 'reading this version', selection })
            const info = vi.fn().mockResolvedValue({ success: true, entries: [{ size: 100, modified: 10 }] })
            const api = { getDocumentFileInfo: info, readSessionFile: vi.fn() } as unknown as ApiClient
            await session.checkUpdates(api)
            info.mockResolvedValue({ success: true, entries: [{ size: 120, modified: 20 }] })
            vi.advanceTimersByTime(5001)
            await session.checkUpdates(api)
            expect(session.state).toMatchObject({ changedOnDisk: true, text: 'reading this version', selection })
            expect(api.readSessionFile).not.toHaveBeenCalled()
        } finally { vi.useRealTimers() }
    })
    describe('reload and save ordering', () => {
        const read = (text: string, hash: string) => ({ success: true, content: bytesBase64(new TextEncoder().encode(text)), hash, writable: true })
        const deferred = <T,>() => {
            let resolve!: (value: T) => void, reject!: (error: Error) => void
            const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
            return { promise, resolve, reject }
        }
        const ready = (path = '/project/notes.md', registry = new DocumentRegistry(crypto.randomUUID())) => {
            const session = registry.get(file(path))
            session.patch({ phase: 'ready', textual: true, writable: true, text: 'draft', baseText: 'original', hash: 'old', dirty: true })
            vi.spyOn(session, 'persist').mockResolvedValue(undefined)
            return session
        }
        it('does not let a pre-save reload replace acknowledged text, hash, or a newer edit', async () => {
            vi.stubGlobal('Blob', NodeBlob)
            try {
                for (const editAfterSave of [false, true]) {
                    const session = ready()
                    const pendingRead = deferred<ReturnType<typeof read>>()
                    const api = { readSessionFile: vi.fn(() => pendingRead.promise), writeSessionFile: vi.fn().mockResolvedValue({ success: true, hash: 'saved' }) } as unknown as ApiClient
                    const reload = session.load(api, true)
                    expect(await session.save(api)).toBe(true)
                    if (editAfterSave) session.edit('newer edit')
                    const editor = EditorState.create({ doc: session.state.text })
                    session.editorState = editor
                    const selection = { kind: 'text' as const, from: 0, to: 5, lineStart: 1, lineEnd: 1, quote: session.state.text.slice(0, 5) }
                    session.patch({ selection })
                    const contentRevision = session.state.contentRevision
                    pendingRead.resolve(read('original', 'old'))
                    await reload
                    expect(session.state).toMatchObject({ phase: 'ready', text: editAfterSave ? 'newer edit' : 'draft', baseText: 'draft', hash: 'saved', dirty: editAfterSave, conflict: false })
                    expect(session.editorState).toBe(editor)
                    expect(session.state.selection).toBe(selection)
                    expect(session.state.contentRevision).toBe(contentRevision)
                    expect(await session.state.blob!.text()).toBe('draft')
                }
            } finally { vi.unstubAllGlobals() }
        })
        it('ignores a superseded read error but accepts a subsequent reload generation', async () => {
            vi.stubGlobal('Blob', NodeBlob)
            try {
                const session = ready()
                const pendingRead = deferred<ReturnType<typeof read>>()
                const readFile = vi.fn().mockImplementationOnce(() => pendingRead.promise).mockResolvedValueOnce(read('external later revision', 'later'))
                const api = { readSessionFile: readFile, writeSessionFile: vi.fn().mockResolvedValue({ success: true, hash: 'saved' }) } as unknown as ApiClient
                const reload = session.load(api, true)
                await session.save(api)
                pendingRead.reject(new Error('late read transport error'))
                await reload
                expect(session.state.error).toBeUndefined()
                expect(session.state).toMatchObject({ text: 'draft', hash: 'saved', dirty: false })
                await session.load(api, true)
                expect(session.state).toMatchObject({ text: 'external later revision', baseText: 'external later revision', hash: 'later', dirty: false })
                expect(readFile).toHaveBeenCalledTimes(2)
            } finally { vi.unstubAllGlobals() }
        })
        it('starts a genuinely new reload after save and does not let old cleanup clear it', async () => {
            vi.stubGlobal('Blob', NodeBlob)
            try {
                const session = ready()
                const older = deferred<ReturnType<typeof read>>(), newer = deferred<ReturnType<typeof read>>()
                const readFile = vi.fn().mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise)
                const api = { readSessionFile: readFile, writeSessionFile: vi.fn().mockResolvedValue({ success: true, hash: 'saved' }) } as unknown as ApiClient
                const oldReload = session.load(api, true)
                await session.save(api)
                const newReload = session.load(api, true)
                expect(readFile).toHaveBeenCalledTimes(2)
                older.resolve(read('original', 'old'))
                await oldReload
                const deduplicated = session.load(api, true)
                expect(readFile).toHaveBeenCalledTimes(2)
                newer.resolve(read('fresh post-save bytes', 'fresh'))
                await Promise.all([newReload, deduplicated])
                expect(session.state).toMatchObject({ text: 'fresh post-save bytes', hash: 'fresh', dirty: false })
            } finally { vi.unstubAllGlobals() }
        })
        it.each(['conflict', 'denied', 'throw'] as const)('keeps dirty reload conflict detection when save returns %s', async code => {
            vi.stubGlobal('Blob', NodeBlob)
            try {
                const session = ready()
                const pendingRead = deferred<ReturnType<typeof read>>()
                const write = code === 'throw' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue({ success: false, code, error: code })
                const api = { readSessionFile: vi.fn(() => pendingRead.promise), writeSessionFile: write } as unknown as ApiClient
                const reload = session.load(api, true)
                expect(await session.save(api)).toBe(false)
                pendingRead.resolve(read('changed externally', 'changed'))
                await reload
                expect(session.state).toMatchObject({ text: 'draft', baseText: 'original', hash: 'old', dirty: true, conflict: true })
                expect(await session.state.blob!.text()).toBe('changed externally')
            } finally { vi.unstubAllGlobals() }
        })
        it('scopes save generations to a file while another file has a pending read', async () => {
            vi.stubGlobal('Blob', NodeBlob)
            try {
                const registry = new DocumentRegistry(crypto.randomUUID())
                const first = ready('/project/first.md', registry), second = ready('/project/second.md', registry)
                second.patch({ text: 'original', dirty: false })
                const pendingRead = deferred<ReturnType<typeof read>>()
                const api = { readSessionFile: vi.fn(() => pendingRead.promise), writeSessionFile: vi.fn().mockResolvedValue({ success: true, hash: 'saved' }) } as unknown as ApiClient
                const reload = second.load(api, true)
                await first.save(api)
                pendingRead.resolve(read('second file refreshed', 'second-new'))
                await reload
                expect(second.state).toMatchObject({ text: 'second file refreshed', hash: 'second-new', dirty: false })
                expect(first.state).toMatchObject({ text: 'draft', hash: 'saved', dirty: false })
            } finally { vi.unstubAllGlobals() }
        })
        it('settles loading when a restored draft is saved before its initial read returns', async () => {
            vi.stubGlobal('Blob', NodeBlob)
            try {
                const session = ready()
                const pendingRead = deferred<ReturnType<typeof read>>()
                const api = { readSessionFile: vi.fn(() => pendingRead.promise), writeSessionFile: vi.fn().mockResolvedValue({ success: true, hash: 'saved' }) } as unknown as ApiClient
                const reload = session.load(api, true)
                // Draft recovery makes the save action available before the remote read finishes.
                session.patch({ phase: 'loading' })
                await session.save(api)
                pendingRead.resolve(read('original', 'old'))
                await reload
                expect(session.state).toMatchObject({ phase: 'ready', text: 'draft', hash: 'saved', dirty: false })
            } finally { vi.unstubAllGlobals() }
        })
    })

})
