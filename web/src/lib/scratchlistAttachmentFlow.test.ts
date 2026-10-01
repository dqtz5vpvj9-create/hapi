import { describe, expect, it, vi } from 'vitest'
import type { AttachmentMetadata } from '@/types/api'
import {
    attachmentsNeedScratchlistMigration,
    finalizeMigratedScratchlistParkCleanup,
    migrateChatPathAttachmentsToScratchlist,
    prepareScratchlistParkAttachments,
    type ParkAttachmentMetadata,
} from './scratchlistAttachmentFlow'

function chatAttachment(path = '/tmp/hapi-blobs/a.png'): AttachmentMetadata {
    return {
        id: 'att-1',
        filename: 'a.png',
        mimeType: 'image/png',
        size: 4,
        path,
        previewUrl: 'data:image/png;base64,aaaa',
    }
}

function hubAttachment(): AttachmentMetadata {
    return {
        id: 'hub-1',
        filename: 'a.png',
        mimeType: 'image/png',
        size: 4,
        path: 'hapi-hub:scratchlist/default/session-1/hub-1-a.png',
    }
}

describe('attachmentsNeedScratchlistMigration (#1226)', () => {
    it('is false for empty / already-hub payloads', () => {
        expect(attachmentsNeedScratchlistMigration(undefined)).toBe(false)
        expect(attachmentsNeedScratchlistMigration([])).toBe(false)
        expect(attachmentsNeedScratchlistMigration([hubAttachment()])).toBe(false)
    })

    it('is true when any attachment still has a chat upload path', () => {
        expect(attachmentsNeedScratchlistMigration([chatAttachment()])).toBe(true)
        expect(attachmentsNeedScratchlistMigration([hubAttachment(), chatAttachment()])).toBe(true)
    })
})

describe('migrateChatPathAttachmentsToScratchlist (#1226)', () => {
    it('re-uploads chat-path items via scratchlist/upload and leaves hub items alone', async () => {
        const migrated = {
            id: 'hub-new',
            filename: 'a.png',
            mimeType: 'image/png',
            size: 4,
            path: 'hapi-hub:scratchlist/default/session-1/hub-new-a.png',
        }
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: migrated,
        })
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const api = { uploadScratchlistAttachment, deleteUploadFile } as never

        const hub = hubAttachment()
        const chat = chatAttachment()
        const contentBase64 = 'iVBORw0KGgo='
        const result = await migrateChatPathAttachmentsToScratchlist(
            api,
            'session-1',
            [hub, chat],
            async (att) => {
                expect(att.path).toBe(chat.path)
                return contentBase64
            },
        )

        expect(uploadScratchlistAttachment).toHaveBeenCalledTimes(1)
        expect(uploadScratchlistAttachment).toHaveBeenCalledWith(
            'session-1',
            'a.png',
            contentBase64,
            'image/png',
        )
        // Chat-path delete is deferred until park succeeds.
        expect(deleteUploadFile).not.toHaveBeenCalled()
        expect(result).toEqual([
            hub,
            { ...migrated, previewUrl: chat.previewUrl, migratedFromPath: chat.path },
        ])
    })

    it('rolls back newly uploaded hub blobs and throws when one migrate fails', async () => {
        const uploadScratchlistAttachment = vi.fn()
            .mockResolvedValueOnce({
                success: true,
                attachment: {
                    id: 'hub-ok',
                    filename: 'a.png',
                    mimeType: 'image/png',
                    size: 1,
                    path: 'hapi-hub:scratchlist/default/session-1/hub-ok-a.png',
                },
            })
            .mockResolvedValueOnce({ success: false, error: 'too big' })
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const api = {
            uploadScratchlistAttachment,
            deleteScratchlistAttachment,
            deleteUploadFile,
        } as never

        await expect(migrateChatPathAttachmentsToScratchlist(
            api,
            'session-1',
            [chatAttachment('/tmp/a.png'), chatAttachment('/tmp/b.png')],
            async () => 'YmFzZTY0',
        )).rejects.toThrow(/too big|Failed to migrate/i)

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-ok')
    })
})

describe('prepareScratchlistParkAttachments (#1226)', () => {
    it('passes hub chips through and migrates chat-path chips without deleting the chat upload', async () => {
        const hubMeta = {
            id: 'hub-1',
            filename: 'hub.png',
            mimeType: 'image/png',
            size: 2,
            path: 'hapi-hub:scratchlist/default/session-1/hub-1-hub.png',
        }
        const migrated = {
            id: 'hub-new',
            filename: 'chat.png',
            mimeType: 'image/png',
            size: 1,
            path: 'hapi-hub:scratchlist/default/session-1/hub-new-chat.png',
        }
        const uploadScratchlistAttachment = vi.fn().mockResolvedValue({
            success: true,
            attachment: migrated,
        })
        const deleteUploadFile = vi.fn()
        const api = { uploadScratchlistAttachment, deleteUploadFile } as never
        const chatFile = new File([new Uint8Array([1])], 'chat.png', { type: 'image/png' })

        const result = await prepareScratchlistParkAttachments(api, 'session-1', [
            {
                id: 'chip-hub',
                name: 'hub.png',
                contentType: 'image/png',
                hubAttachment: hubMeta,
                previewUrl: 'data:image/png;base64,hub',
            },
            {
                id: 'chip-chat',
                name: 'chat.png',
                contentType: 'image/png',
                file: chatFile,
                path: '/tmp/hapi-blobs/chat.png',
                previewUrl: 'data:image/png;base64,chat',
            },
        ])

        expect(uploadScratchlistAttachment).toHaveBeenCalledTimes(1)
        expect(deleteUploadFile).not.toHaveBeenCalled()
        expect(result).toEqual([
            { ...hubMeta, previewUrl: 'data:image/png;base64,hub' },
            {
                ...migrated,
                previewUrl: 'data:image/png;base64,chat',
                migratedFromPath: '/tmp/hapi-blobs/chat.png',
            },
        ])
    })

    it('reuses a restored hub path without re-uploading', async () => {
        const uploadScratchlistAttachment = vi.fn()
        const api = { uploadScratchlistAttachment } as never
        const hubPath = 'hapi-hub:scratchlist/default/session-1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-photo.png'
        const file = new File([new Uint8Array([1, 2])], 'photo.png', { type: 'image/png' })

        const result = await prepareScratchlistParkAttachments(api, 'session-1', [
            {
                id: 'chip-restored',
                name: 'photo.png',
                contentType: 'image/png',
                file,
                path: hubPath,
                previewUrl: 'data:image/png;base64,x',
            },
        ])

        expect(uploadScratchlistAttachment).not.toHaveBeenCalled()
        expect(result).toEqual([{
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            filename: 'photo.png',
            mimeType: 'image/png',
            size: 2,
            path: hubPath,
            previewUrl: 'data:image/png;base64,x',
        }])
    })

    it('rolls back hub blobs when a later chip fails to migrate', async () => {
        const uploadScratchlistAttachment = vi.fn()
            .mockResolvedValueOnce({
                success: true,
                attachment: {
                    id: 'hub-ok',
                    filename: 'a.png',
                    mimeType: 'image/png',
                    size: 1,
                    path: 'hapi-hub:scratchlist/default/session-1/hub-ok-a.png',
                },
            })
            .mockResolvedValueOnce({ success: false, error: 'quota' })
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const api = { uploadScratchlistAttachment, deleteScratchlistAttachment } as never
        const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })

        await expect(prepareScratchlistParkAttachments(api, 'session-1', [
            { id: '1', name: 'a.png', contentType: 'image/png', file, path: '/tmp/a.png' },
            { id: '2', name: 'b.png', contentType: 'image/png', file, path: '/tmp/b.png' },
        ])).rejects.toThrow(/quota|Failed to migrate/i)

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-ok')
    })
})

describe('finalizeMigratedScratchlistParkCleanup (#1226)', () => {
    const hubPath = 'hapi-hub:scratchlist/default/session-1/hub-1-a.png'
    const chatPath = '/tmp/hapi-blobs/a.png'

    it('deletes chat uploads after accepted park', async () => {
        const deleteUploadFile = vi.fn().mockResolvedValue(undefined)
        const deleteScratchlistAttachment = vi.fn()
        const api = { deleteUploadFile, deleteScratchlistAttachment } as never

        await finalizeMigratedScratchlistParkCleanup(
            api,
            'session-1',
            [{
                id: 'hub-1',
                filename: 'a.png',
                mimeType: 'image/png',
                size: 1,
                path: hubPath,
                migratedFromPath: chatPath,
            } as ParkAttachmentMetadata],
            true,
        )

        expect(deleteUploadFile).toHaveBeenCalledWith('session-1', chatPath)
        expect(deleteScratchlistAttachment).not.toHaveBeenCalled()
    })

    it('deletes orphan hub blobs after rejected park so retry can remigrate', async () => {
        const deleteUploadFile = vi.fn()
        const deleteScratchlistAttachment = vi.fn().mockResolvedValue(undefined)
        const api = { deleteUploadFile, deleteScratchlistAttachment } as never

        await finalizeMigratedScratchlistParkCleanup(
            api,
            'session-1',
            [{
                id: 'hub-1',
                filename: 'a.png',
                mimeType: 'image/png',
                size: 1,
                path: hubPath,
                migratedFromPath: chatPath,
            } as ParkAttachmentMetadata],
            false,
        )

        expect(deleteScratchlistAttachment).toHaveBeenCalledWith('session-1', 'hub-1')
        expect(deleteUploadFile).not.toHaveBeenCalled()
    })

    it('no-ops when nothing was migrated from a chat path', async () => {
        const deleteUploadFile = vi.fn()
        const deleteScratchlistAttachment = vi.fn()
        const api = { deleteUploadFile, deleteScratchlistAttachment } as never

        await finalizeMigratedScratchlistParkCleanup(
            api,
            'session-1',
            [{
                id: 'hub-1',
                filename: 'a.png',
                mimeType: 'image/png',
                size: 1,
                path: hubPath,
            }],
            true,
        )

        expect(deleteUploadFile).not.toHaveBeenCalled()
        expect(deleteScratchlistAttachment).not.toHaveBeenCalled()
    })
})

describe('Scratchlist copies into the composer', () => {
    async function setupRestore() {
        const { createAttachmentAdapter } = await import('./attachmentAdapter')
        const { rehydrateScratchlistAttachmentsToComposer } = await import('./scratchlistAttachmentFlow')
        const { getDraftAttachments, getRestoredUploadMetadata, saveDraftAttachments, clearDraftAttachments } = await import('./composer-attachment-drafts')
        const api = {
            fetchScratchlistAttachmentBlob: vi.fn(async (_session: string, id: string) => new Blob([`image:${id}`], { type: 'image/png' })),
            uploadFile: vi.fn(async (_session: string, _name: string, content: string) => ({ success: true, path: `/uploads/${content}.png` })),
            deleteUploadFile: vi.fn(async () => {}),
        }
        const adapter = createAttachmentAdapter(api as never, 'restore-test')
        const visible: Array<import('@assistant-ui/react').PendingAttachment & { path?: string }> = []
        const composer = {
            getState: () => ({ attachments: visible }),
            addAttachment: vi.fn(async (file: File) => {
                const result = adapter.add({ file })
                if (!('next' in result)) throw new Error('Expected upload progress')
                for await (const attachment of result) {
                    const index = visible.findIndex((item) => item.id === attachment.id)
                    if (index < 0) visible.push(attachment)
                    else visible[index] = attachment
                }
            }),
        }
        const image = (id: string) => ({
            id, filename: 'same-name.png', mimeType: 'image/png', size: 8,
            path: `hapi-hub:scratchlist/default/restore-test/${id}-same-name.png`,
        })
        const restore = (attachments = [image('hub-image')]) => rehydrateScratchlistAttachmentsToComposer(
            api as never, 'restore-test', attachments, composer,
        )
        return { api, adapter, visible, composer, image, restore, getDraftAttachments, getRestoredUploadMetadata, saveDraftAttachments, clearDraftAttachments }
    }

    it('uploads from empty, deduplicates repeated copies by source identity and preserves distinct same-name images', async () => {
        const state = await setupRestore()
        await state.restore()
        const first = state.visible[0]!
        expect(first.name).toBe('same-name.png')
        expect(first.status).toEqual({ type: 'requires-action', reason: 'composer-send' })
        expect(state.api.uploadFile).toHaveBeenCalledWith('restore-test', 'same-name.png', expect.any(String), 'image/png')
        await state.restore()
        expect(state.visible).toHaveLength(1)
        expect(state.composer.addAttachment).toHaveBeenCalledTimes(1)
        expect(state.api.uploadFile).toHaveBeenCalledTimes(1)

        await state.restore([state.image('different-hub-image')])
        expect(state.visible).toHaveLength(2)
        expect(state.visible[0]!.id).not.toBe(state.visible[1]!.id)
        expect(state.visible.map((item) => item.name)).toEqual(['same-name.png', 'same-name.png'])

        // A persisted draft carries the source id through the existing blob
        // round-trip, so reopening it does not disable identity-based dedupe.
        state.saveDraftAttachments('restore-test', state.visible.map((item) => ({
            id: item.id, file: item.file!, path: item.path, uploadSessionId: 'restore-test',
        })))
        const files = await state.getDraftAttachments('restore-test')
        state.visible.splice(0)
        for (const file of files) await state.composer.addAttachment(file)
        await state.restore()
        expect(state.visible).toHaveLength(2)
        expect(state.api.uploadFile).toHaveBeenCalledTimes(2)
        expect(files.map((file) => state.getRestoredUploadMetadata(file)?.id)).toEqual(state.visible.map((item) => item.id))
        state.clearDraftAttachments('restore-test')
    })

    it('allows removing a restored image and copying it again without deleting its Scratchlist source', async () => {
        const state = await setupRestore()
        await state.restore()
        const removed = state.visible.shift()!
        await state.adapter.remove(removed)
        expect(state.api.deleteUploadFile).toHaveBeenCalledTimes(1)
        await state.restore()
        expect(state.visible).toHaveLength(1)
        expect(state.visible[0]!.id).toBe(removed.id)
        expect(state.api.uploadFile).toHaveBeenCalledTimes(2)
    })

    it('does not duplicate an image when another drawer copy starts during fetch, and permits retry after failure', async () => {
        const state = await setupRestore()
        let finish!: (blob: Blob) => void
        state.api.fetchScratchlistAttachmentBlob.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
        const first = state.restore()
        await state.restore()
        expect(state.api.fetchScratchlistAttachmentBlob).toHaveBeenCalledTimes(1)
        expect(state.composer.addAttachment).not.toHaveBeenCalled()
        finish(new Blob(['image'], { type: 'image/png' }))
        await first
        expect(state.visible).toHaveLength(1)

        state.api.fetchScratchlistAttachmentBlob.mockRejectedValueOnce(new Error('fetch failed'))
        await expect(state.restore([state.image('retry-image')])).rejects.toThrow('fetch failed')
        await state.restore([state.image('retry-image')])
        expect(state.visible).toHaveLength(2)
    })
})
