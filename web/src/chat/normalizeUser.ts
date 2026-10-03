import { ArtifactRefSchema, ChatContentPartSchema } from '@hapi/protocol/artifacts'
import type { NormalizedMessage } from '@/chat/types'
import type { AttachmentMetadata } from '@/types/api'
import { isObject } from '@hapi/protocol'

function parseAttachments(raw: unknown): AttachmentMetadata[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const attachments: AttachmentMetadata[] = []
    for (const item of raw) {
        if (
            isObject(item) &&
            typeof item.id === 'string' &&
            typeof item.filename === 'string' &&
            typeof item.mimeType === 'string' &&
            typeof item.size === 'number' &&
            typeof item.path === 'string'
        ) {
            attachments.push({
                id: item.id,
                filename: item.filename,
                mimeType: item.mimeType,
                size: item.size,
                path: item.path,
                previewUrl: typeof item.previewUrl === 'string' ? item.previewUrl : undefined,
                artifact: ArtifactRefSchema.safeParse(item.artifact).success ? ArtifactRefSchema.parse(item.artifact) : undefined
            })
        }
    }
    return attachments.length > 0 ? attachments : undefined
}

export function normalizeUserRecord(
    messageId: string,
    localId: string | null,
    createdAt: number,
    content: unknown,
    meta?: unknown,
): NormalizedMessage | null {
    if (typeof content === 'string') {
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content },
            isSidechain: false,
            meta
        }
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        const attachments = parseAttachments(content.attachments)
        return {
            id: messageId,
            localId,
            createdAt,
            role: 'user',
            content: { type: 'text', text: content.text, attachments, ...(Array.isArray(content.parts) ? { parts: content.parts.flatMap(part => { const parsed = ChatContentPartSchema.safeParse(part); return parsed.success ? [parsed.data] : [] }) } : {}) },
            isSidechain: false,
            meta
        }
    }

    return null
}
