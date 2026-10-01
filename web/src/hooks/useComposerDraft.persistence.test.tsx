import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { AttachmentDraftInput } from '@/lib/composer-attachment-drafts'
import { useComposerDraft } from './useComposerDraft'

/** Transaction test double: rows survive module reloads, unlike the draft cache. */
function draftDatabase() {
    const rows = new Map<string, { sessionId: string; files: AttachmentDraftInput[] }>()
    const db = {
        close() {},
        transaction() {
            let pending = 0
            const schedule = (callback: () => void) => {
                pending += 1
                queueMicrotask(() => {
                    callback()
                    if (--pending === 0) transaction.oncomplete?.()
                })
            }
            const request = <T,>(read: () => T) => {
                const result = { result: undefined as T | undefined, onsuccess: null as (() => void) | null }
                schedule(() => {
                    result.result = read()
                    result.onsuccess?.()
                })
                return result
            }
            const transaction = {
                oncomplete: null as (() => void) | null,
                onerror: null,
                onabort: null,
                objectStore: () => ({
                    put: (row: { sessionId: string; files: AttachmentDraftInput[] }) => schedule(() => { rows.set(row.sessionId, row) }),
                    delete: (id: string) => schedule(() => { rows.delete(id) }),
                    get: (id: string) => request(() => rows.get(id)),
                    getAll: () => request(() => [...rows.values()]),
                }),
            }
            return transaction
        },
    }
    const indexedDB = {
        open: () => {
            const request = { result: db, onsuccess: null as (() => void) | null }
            queueMicrotask(() => request.onsuccess?.())
            return request
        },
    }
    return { rows, indexedDB }
}

async function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsText(file)
    })
}

describe('active attachment draft persistence', () => {
    afterEach(() => { vi.unstubAllGlobals() })

    it('stores an uploaded image before navigation and restores bytes and send metadata from a fresh cache', async () => {
        const database = draftDatabase()
        vi.stubGlobal('indexedDB', database.indexedDB)
        vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0))
        vi.stubGlobal('cancelAnimationFrame', clearTimeout)
        const sessionId = 'bug-04-persistence'
        const api = {
            uploadFile: vi.fn(async () => ({ success: true, path: '/uploads/draft.png' })),
            deleteUploadFile: vi.fn(async () => {}),
        }
        const { createAttachmentAdapter } = await import('@/lib/attachmentAdapter')
        const adapter = createAttachmentAdapter(api as unknown as ApiClient, sessionId)
        const file = new File(['image payload'], 'draft.png', { type: 'image/png', lastModified: 123 })
        const { result, rerender, unmount } = renderHook(
            ({ attachments }) => useComposerDraft(sessionId, 'unsent text', attachments, true, vi.fn(), vi.fn()),
            { initialProps: { attachments: [] as AttachmentDraftInput[] } },
        )
        await waitFor(() => expect(result.current.complete).toBe(true))

        // Exercise the production adapter's uploading → uploaded transitions.
        const additions = adapter.add({ file })
        if (!('next' in additions)) throw new Error('Expected the upload adapter to stream progress')
        for await (const attachment of additions) {
            rerender({ attachments: [attachment as AttachmentDraftInput] })
        }
        expect(api.uploadFile).toHaveBeenCalledTimes(1)
        // No hidden event or unmount: the row must already be committed.
        await waitFor(() => expect(database.rows.get(sessionId)?.files[0]).toMatchObject({
            id: expect.any(String), path: '/uploads/draft.png', uploadSessionId: sessionId,
        }))

        // Lose the in-memory caches as a refresh would, keeping only IDB rows.
        vi.resetModules()
        const freshDrafts = await import('@/lib/composer-attachment-drafts')
        const [restored] = await freshDrafts.getDraftAttachments(sessionId)
        expect(restored).toBeDefined()
        expect(await readFile(restored!)).toBe('image payload')
        expect(restored!.name).toBe('draft.png')
        expect(restored!.type).toBe('image/png')
        expect(restored!.lastModified).toBe(123)
        const freshAdapterModule = await import('@/lib/attachmentAdapter')
        const freshAdapter = freshAdapterModule.createAttachmentAdapter(api as unknown as ApiClient, sessionId)
        const restoredAttachments = []
        const restoredAdditions = freshAdapter.add({ file: restored! })
        if (!('next' in restoredAdditions)) throw new Error('Expected the restore adapter to stream attachments')
        for await (const attachment of restoredAdditions) restoredAttachments.push(attachment)
        expect(restoredAttachments).toHaveLength(1)
        expect(restoredAttachments[0]!.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
        expect(api.uploadFile).toHaveBeenCalledTimes(1)
        const sent = await freshAdapter.send(restoredAttachments[0]!)
        expect(sent.content).toEqual([{ type: 'text', text: expect.stringContaining('"path":"/uploads/draft.png"') }])

        // Assistant-ui removes attachments after send; the durable row must go.
        rerender({ attachments: [] })
        await waitFor(() => expect(database.rows.has(sessionId)).toBe(false))
        unmount()
        await waitFor(() => expect(database.rows.has(sessionId)).toBe(false))
    })
})
