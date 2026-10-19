import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Blob as NodeBlob } from 'node:buffer'
import type { ApiClient } from '@/api/client'
import type { DocumentResource } from '@hapi/protocol/documents'
import { DocumentRegistry } from './documentSession'
import { WorkspaceStore, panes } from '@/workspace/workspaceStore'
import { documentRegistryFor } from './useDocumentRegistry'

const resource = (path: string, machineId = 'machine-a'): DocumentResource => ({ kind: 'document', sessionId: 'a', document: { kind: 'file', path, machineId } })
describe('file management and document ownership', () => {
    beforeEach(() => vi.stubGlobal('Blob', NodeBlob))
    afterEach(() => vi.unstubAllGlobals())
    it('keeps document bytes isolated when an API client is reused for another account', () => {
        const api = {}, firstScope = crypto.randomUUID(), secondScope = crypto.randomUUID()
        const first = documentRegistryFor(api, firstScope)
        first.get(resource('/project/file.txt')).patch({ dirty: true, text: 'private draft' })
        expect(documentRegistryFor(api, firstScope)).toBe(first)
        const second = documentRegistryFor(api, secondScope)
        expect(second).not.toBe(first)
        expect(second.get(resource('/project/file.txt')).state.text).toBe('')
    })
    it('blocks saving/reloading during a move and retargets the existing editor for the next save', async () => {
        const registry = new DocumentRegistry(crypto.randomUUID())
        const original = resource('/project/src/notes.md')
        const document = registry.get(original)
        document.patch({ phase: 'ready', textual: true, writable: true, dirty: true, text: 'local draft', baseText: 'base', hash: 'before' })
        vi.spyOn(document, 'persist').mockResolvedValue(undefined)
        const api = { readSessionFile: vi.fn(), writeSessionFile: vi.fn().mockResolvedValue({ success: true, hash: 'after' }) } as unknown as ApiClient
        document.beginFileOperation()
        expect(await document.save(api)).toBe(false)
        await document.load(api, true)
        expect(api.readSessionFile).not.toHaveBeenCalled()
        expect(api.writeSessionFile).not.toHaveBeenCalled()
        document.scrollTop = 92
        // No IndexedDB draft exists in this unit fixture; the browser suite
        // independently checks the durable dirty-draft migration.
        document.patch({ dirty: false })
        await registry.relocateFiles({ sessionId: 'a', machineId: 'machine-a' }, '/project/src', '/project/lib')
        document.patch({ dirty: true })
        expect(registry.get(resource('/project/lib/notes.md'))).toBe(document)
        expect(document.state.text).toBe('local draft')
        expect(document.scrollTop).toBe(92)
        document.endFileOperation()
        expect(await document.save(api)).toBe(true)
        expect(api.writeSessionFile).toHaveBeenCalledWith('a', expect.objectContaining({ path: '/project/lib/notes.md', expectedHash: 'before' }))
    })
    it('does not touch another machine or adjacent directory when preparing a subtree operation', () => {
        const registry = new DocumentRegistry(crypto.randomUUID())
        const affected = registry.get(resource('/project/src/a'))
        registry.get(resource('/project/src-other/a'))
        registry.get(resource('/project/src/a', 'machine-b'))
        expect(registry.fileSessions({ sessionId: 'a', machineId: 'machine-a' }, ['/project/src'])).toEqual([affected])
    })
    it('reads recreated files with their new bytes and hash instead of reusing a deleted clean document', async () => {
        const registry = new DocumentRegistry(crypto.randomUUID())
        const ref = resource('/project/src/file.txt')
        const document = registry.get(ref)
        document.patch({ phase: 'ready', text: 'deleted bytes', baseText: 'deleted bytes', hash: 'deleted-hash', textual: true, writable: true })
        const other = registry.get(resource('/project/src/file.txt', 'machine-b'))
        other.patch({ phase: 'ready', text: 'another machine' })
        registry.invalidateFiles({ sessionId: 'a', machineId: 'machine-a' }, ['/project/src'])
        expect(document.state.text).toBe('')
        expect(document.state.hash).toBe('')
        expect(other.state.text).toBe('another machine')
        const api = { readSessionFile: vi.fn().mockResolvedValue({ success: true, content: '', hash: 'new-empty-hash', writable: true }) } as unknown as ApiClient
        await registry.get(ref).load(api)
        expect(api.readSessionFile).toHaveBeenCalledWith('a', '/project/src/file.txt')
        expect(document.state).toMatchObject({ phase: 'ready', text: '', hash: 'new-empty-hash', dirty: false })
    })
    it('keeps an explicitly retained draft and compares it with the recreated file before saving', async () => {
        const registry = new DocumentRegistry(crypto.randomUUID())
        const document = registry.get(resource('/project/file.txt'))
        document.patch({ phase: 'ready', dirty: true, text: 'kept local draft', baseText: 'deleted bytes', hash: 'deleted-hash', textual: true, writable: true })
        registry.invalidateFiles({ sessionId: 'a', machineId: 'machine-a' }, ['/project/file.txt'])
        const api = { readSessionFile: vi.fn().mockResolvedValue({ success: true, content: '', hash: 'new-empty-hash', writable: true }) } as unknown as ApiClient
        await document.load(api)
        expect(document.state).toMatchObject({ phase: 'ready', text: 'kept local draft', hash: 'deleted-hash', dirty: true, conflict: true })
    })
    it('routes shared file reads and saves through the initiating conversation while keeping one editor owner', async () => {
        const registry = new DocumentRegistry(crypto.randomUUID())
        const document = registry.get(resource('/project/file.txt'))
        const second = { ...resource('/project/file.txt'), sessionId: 'b' }
        expect(registry.get(second)).toBe(document)
        const api = {
            readSessionFile: vi.fn().mockResolvedValue({ success: true, content: '', hash: 'new-empty-hash', writable: true }),
            writeSessionFile: vi.fn().mockResolvedValue({ success: true, hash: 'saved-hash' }),
        } as unknown as ApiClient
        await document.load(api, false, 'b')
        expect(api.readSessionFile).toHaveBeenCalledWith('b', '/project/file.txt')
        vi.spyOn(document, 'persist').mockResolvedValue(undefined)
        document.edit('shared draft')
        expect(await document.save(api, 'b')).toBe(true)
        expect(api.writeSessionFile).toHaveBeenCalledWith('b', expect.objectContaining({ path: '/project/file.txt', expectedHash: 'new-empty-hash' }))
        expect(document.resource.sessionId).toBe('a')
        expect(registry.get(second)).toBe(document)
    })
    it('updates all workspace document references after move and closes only deleted descendants', () => {
        const store = new WorkspaceStore(crypto.randomUUID())
        store.enter('a')
        const chat = store.focusedPane()!
        store.openDocument(chat.id, chat.resource, resource('/project/src/a'))
        store.openDocument(chat.id, chat.resource, resource('/project/src-other/a'), true)
        store.relocateDocuments({ sessionId: 'a', machineId: 'machine-a' }, '/project/src', '/project/lib')
        const refs = () => panes(store.active()!.root).map(pane => pane.resource).filter(item => item.kind === 'document')
        expect(refs()).toEqual([resource('/project/src-other/a'), resource('/project/lib/a')])
        store.removeDeletedDocuments({ sessionId: 'a', machineId: 'machine-a' }, ['/project/lib'])
        expect(refs()).toEqual([resource('/project/src-other/a')])
        expect(panes(store.active()!.root).some(pane => pane.resource.kind === 'chat')).toBe(true)
    })
})
