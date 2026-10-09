import type { AttachmentAdapter, PendingAttachment, CompleteAttachment, Attachment } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata } from '@/types/api'
import { isImageMimeType } from '@/lib/fileAttachments'
import { randomId } from '@/lib/randomId'
import {
    completeDraftAttachmentUpload,
    getRestoredUploadMetadata,
    setRestoredUploadMetadata,
} from '@/lib/composer-attachment-drafts'
import type { AttachmentDraftHandoff } from '@/lib/composer-draft-transfer'

/** Composer / share upload ceiling — keep deep-link fetch in sync. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

type PendingUploadAttachment = PendingAttachment & {
    path?: string
    previewUrl?: string
    uploadSessionId?: string
}

type UploadTask = {
    cancelled: boolean
    result: Promise<Awaited<ReturnType<ApiClient['uploadFile']>>>
    cancel: () => Promise<void>
}

// Only in-flight requests live here. Completed paths belong to the existing
// composer draft store, so unmounting a pane does not restart its upload.
const pendingUploads = new WeakMap<ApiClient, Map<string, UploadTask>>()

function uploadAttachment(api: ApiClient, sessionId: string, id: string, file: File, previewUrl?: string): UploadTask {
    let uploads = pendingUploads.get(api)
    if (!uploads) pendingUploads.set(api, uploads = new Map())
    const key = JSON.stringify([sessionId, id])
    const existing = uploads.get(key)
    if (existing && !existing.cancelled) return existing

    let uploadedPath: string | undefined
    let cleanup: Promise<void> | undefined
    const deleteUploadedFile = () => {
        if (!uploadedPath) return Promise.resolve()
        return cleanup ??= api.deleteUploadFile(sessionId, uploadedPath).then(() => {}, () => {})
    }
    const task: UploadTask = {
        cancelled: false,
        cancel() {
            task.cancelled = true
            return deleteUploadedFile()
        },
        result: Promise.resolve().then(async () => {
            const content = previewUrl ? base64FromDataUrl(previewUrl) : await fileToBase64(file)
            if (task.cancelled) return { success: false }
            const result = await api.uploadFile(sessionId, file.name, content, file.type || 'application/octet-stream')
            if (result.success && result.path) {
                uploadedPath = result.path
                if (task.cancelled) await deleteUploadedFile()
                else {
                    const metadata = { id, path: result.path, previewUrl, uploadSessionId: sessionId }
                    setRestoredUploadMetadata(file, metadata)
                    completeDraftAttachmentUpload(sessionId, metadata)
                }
            }
            return result
        }).finally(() => {
            if (uploads.get(key) === task) uploads.delete(key)
        }),
    }
    uploads.set(key, task)
    return task
}

export function createAttachmentAdapter(
    api: ApiClient,
    sessionId: string,
    resolveSessionId?: () => Promise<string>,
    // Always hand off after resume merges into a new session id — even when
    // the pick is cancelled — so the caller can navigate off a deleted source.
    // Cancellation is re-checked at transfer save time via isCancelled().
    onSessionResolved?: (sessionId: string, pending: AttachmentDraftHandoff) => Promise<void>,
): AttachmentAdapter {
    const uploadAttempts = new Map<string, { cancelled: boolean; task?: UploadTask }>()

    const deleteUpload = async (path?: string, uploadSessionId = sessionId) => {
        if (!path) return
        try {
            await api.deleteUploadFile(uploadSessionId, path)
        } catch {
            // Best effort cleanup
        }
    }

    return {
        // assistant-ui uses the exact "*" sentinel for an allow-all adapter.
        // "*/*" is forwarded to MIME matching and rejects every file before
        // this adapter's add() method can run.
        accept: '*',

        async *add({ file }): AsyncGenerator<PendingAttachment> {
            // Upload paths are scoped to the session that created them. An
            // inactive composer may resume into a different session id, so its
            // persisted file must follow the normal resolve/transfer flow and
            // be uploaded again by the resumed composer. Pathless restored
            // metadata still supplies a stable id so draft merge cannot
            // duplicate the same File across persistence passes.
            const restored = getRestoredUploadMetadata(file)
            const id = restored?.id ?? randomId()
            // Cancellation belongs to an add attempt, not the stable identity:
            // a removed Scratchlist image can later be copied again. Older
            // in-flight uploads retain their own cancelled state.
            const attempt: { cancelled: boolean; task?: UploadTask } = { cancelled: false }
            if (!restored) setRestoredUploadMetadata(file, { id })
            if (!resolveSessionId && restored?.path) {
                yield {
                    id: restored.id,
                    type: 'file',
                    name: file.name,
                    contentType: file.type || 'application/octet-stream',
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: restored.path,
                    previewUrl: restored.previewUrl,
                    uploadSessionId: restored.uploadSessionId,
                } as PendingUploadAttachment
                return
            }

            uploadAttempts.set(id, attempt)
            const contentType = file.type || 'application/octet-stream'

            try {
                let previewUrl: string | undefined
                if (isImageMimeType(contentType) && file.size <= MAX_PREVIEW_BYTES) {
                    try {
                        previewUrl = await fileToDataUrl(file)
                    } catch {
                        // Preview generation is optional; retry the read for the upload payload below.
                    }
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 0 },
                    previewUrl
                } as PendingUploadAttachment

                if (attempt.cancelled) {
                    return
                }

                if (file.size > MAX_UPLOAD_BYTES) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                const uploadSessionId = resolveSessionId ? await resolveSessionId() : sessionId
                // Resume may already have merged the source session away. Always
                // hand off with a live cancellation predicate so transfer can
                // drop this id (even if already persisted on the source draft).
                if (uploadSessionId !== sessionId && onSessionResolved) {
                    await onSessionResolved(uploadSessionId, {
                        id,
                        file,
                        previewUrl,
                        isCancelled: () => attempt.cancelled,
                    })
                    return
                }
                if (attempt.cancelled) {
                    return
                }

                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'running', reason: 'uploading', progress: 50 },
                    previewUrl
                } as PendingUploadAttachment

                if (attempt.cancelled) return
                // An earlier mount may have finished while this one was
                // preparing its preview. Re-read before starting a request.
                const completed = !resolveSessionId ? getRestoredUploadMetadata(file) : undefined
                const result = completed?.path
                    ? { success: true, path: completed.path }
                    : await (attempt.task = uploadAttachment(api, uploadSessionId, id, file, previewUrl)).result
                if (attempt.cancelled || attempt.task?.cancelled) return

                if (!result.success || !result.path) {
                    yield {
                        id,
                        type: 'file',
                        name: file.name,
                        contentType,
                        file,
                        status: { type: 'incomplete', reason: 'error' }
                    }
                    return
                }

                setRestoredUploadMetadata(file, { id, path: result.path, previewUrl, uploadSessionId })
                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'requires-action', reason: 'composer-send' },
                    path: result.path,
                    previewUrl,
                    uploadSessionId,
                } as PendingUploadAttachment

            } catch {
                if (attempt.cancelled || attempt.task?.cancelled) return
                yield {
                    id,
                    type: 'file',
                    name: file.name,
                    contentType,
                    file,
                    status: { type: 'incomplete', reason: 'error' }
                }
            } finally {
                if (uploadAttempts.get(id) === attempt) uploadAttempts.delete(id)
            }
        },

        async remove(attachment: Attachment): Promise<void> {
            const attempt = uploadAttempts.get(attachment.id)
            if (attempt) attempt.cancelled = true
            // The runtime can replace its adapter while retaining attachments.
            // Removal must still reach the request owned by the prior adapter.
            const task = attempt?.task ?? pendingUploads.get(api)?.get(JSON.stringify([sessionId, attachment.id]))
            const metadata = attachment.file ? getRestoredUploadMetadata(attachment.file) : undefined
            const path = (attachment as PendingUploadAttachment).path ?? metadata?.path
            const uploadSessionId = (attachment as PendingUploadAttachment).uploadSessionId ?? metadata?.uploadSessionId
            if (attachment.file) setRestoredUploadMetadata(attachment.file, {
                id: attachment.id, path: undefined, previewUrl: undefined, uploadSessionId: undefined,
            })
            if (task) {
                await task.cancel()
                return
            }
            await deleteUpload(path, uploadSessionId)
        },

        async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
            const pending = attachment as PendingUploadAttachment
            const path = pending.path

            // Build AttachmentMetadata to be sent with the message
            const metadata: AttachmentMetadata | undefined = path ? {
                id: attachment.id,
                filename: attachment.name,
                mimeType: attachment.contentType ?? 'application/octet-stream',
                size: attachment.file?.size ?? 0,
                path,
                previewUrl: pending.previewUrl
            } : undefined

            return {
                id: attachment.id,
                type: attachment.type,
                name: attachment.name,
                contentType: attachment.contentType,
                status: { type: 'complete' },
                // Store metadata as JSON in the text content for extraction by assistant-runtime
                content: metadata ? [{ type: 'text', text: JSON.stringify({ __attachmentMetadata: metadata }) }] : []
            }
        }
    }
}

async function fileToBase64(file: File): Promise<string> {
    return base64FromDataUrl(await fileToDataUrl(file))
}

function base64FromDataUrl(dataUrl: string): string {
    const separatorIndex = dataUrl.indexOf(',')
    const base64 = separatorIndex >= 0 ? dataUrl.slice(separatorIndex + 1) : ''
    if (!base64) {
        throw new Error('Failed to read file')
    }
    return base64
}

async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            resolve(reader.result as string)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}
