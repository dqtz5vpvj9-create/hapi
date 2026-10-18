import type { PickedFile } from '@capawesome/capacitor-file-picker'
import { MAX_UPLOAD_BYTES } from '@/lib/attachmentAdapter'

export type NativeAttachmentSource = 'photos' | 'files'

export class NativeAttachmentError extends Error {
    constructor(
        readonly code: 'too-large' | 'unreadable' | 'busy',
        readonly fileName?: string,
        options?: ErrorOptions,
    ) {
        super(code, options)
        this.name = 'NativeAttachmentError'
    }
}

// The native plugin owns one outstanding picker call across all chat panes.
// A second call must not replace the first call's completion handler.
let pickerPending = false

export function isNativeAttachmentCancellation(error: unknown): boolean {
    // Pinned file-picker 8.1.0 uses this exact message on Android and iOS.
    // Its pickerDismissed event also fires before successful photo reads.
    return typeof error === 'object' && error !== null
        && 'message' in error && error.message === 'pickFiles canceled.'
}

function assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Attachment selection canceled', 'AbortError')
}

function assertSize(size: number, name: string): void {
    if (size > MAX_UPLOAD_BYTES) throw new NativeAttachmentError('too-large', name)
}

async function readSelectedFile(file: PickedFile, signal?: AbortSignal): Promise<File> {
    assertActive(signal)
    if (!file.webPath) throw new NativeAttachmentError('unreadable', file.name)

    try {
        // webPath is the plugin's local WebView URL. Never send hub credentials
        // to the device file server, or use native HTTP/base64 for file reads.
        const response = await fetch(file.webPath, { signal, credentials: 'omit' })
        if (!response.ok) throw new Error(`File read failed (${response.status})`)
        const contentLength = response.headers.get('Content-Length')
        if (contentLength !== null && Number(contentLength) > MAX_UPLOAD_BYTES) {
            await response.body?.cancel().catch(() => {})
            throw new NativeAttachmentError('too-large', file.name)
        }

        let blob: Blob
        if (response.body) {
            const reader = response.body.getReader()
            const chunks: BlobPart[] = []
            let size = 0
            try {
                for (;;) {
                    assertActive(signal)
                    const { done, value } = await reader.read()
                    if (done) break
                    size += value.byteLength
                    assertSize(size, file.name)
                    chunks.push(new Uint8Array(value))
                }
            } catch (error) {
                await reader.cancel().catch(() => {})
                throw error
            } finally {
                reader.releaseLock()
            }
            blob = new Blob(chunks, { type: response.headers.get('Content-Type') ?? '' })
        } else {
            // Older WebViews can omit a readable stream. Check the resulting
            // bytes as well as metadata, which document providers may omit.
            blob = await response.blob()
        }
        assertActive(signal)
        assertSize(blob.size, file.name)
        return new File([blob], file.name, {
            type: file.mimeType || blob.type || 'application/octet-stream',
            ...(Number.isFinite(file.modifiedAt) ? { lastModified: file.modifiedAt } : {}),
        })
    } catch (error) {
        if (error instanceof NativeAttachmentError || signal?.aborted) throw error
        throw new NativeAttachmentError('unreadable', file.name, { cause: error })
    }
}

export async function pickNativeAttachments(
    source: NativeAttachmentSource,
    signal?: AbortSignal,
): Promise<File[]> {
    assertActive(signal)
    if (pickerPending) throw new NativeAttachmentError('busy')
    pickerPending = true
    try {
        // Ordinary browsers keep their existing input and never load the plugin.
        const { FilePicker } = await import('@capawesome/capacitor-file-picker')
        assertActive(signal)
        const result = source === 'photos'
            ? await FilePicker.pickImages({ limit: 0, readData: false, skipTranscoding: true, ordered: true })
            : await FilePicker.pickFiles({ limit: 0, readData: false })
        assertActive(signal)

        // Reject the whole new selection before reading any data. Existing
        // composer attachments are owned by the upload/draft pipeline.
        for (const file of result.files) assertSize(file.size, file.name)
        const files: File[] = []
        for (const file of result.files) files.push(await readSelectedFile(file, signal))
        return files
    } catch (error) {
        if (isNativeAttachmentCancellation(error)) return []
        throw error
    } finally {
        pickerPending = false
    }
}
