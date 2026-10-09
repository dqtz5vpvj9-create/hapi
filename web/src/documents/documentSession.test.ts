import { describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
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
})
