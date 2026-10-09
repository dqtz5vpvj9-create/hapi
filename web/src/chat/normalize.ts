import { NativeExecutionSchema } from '@hapi/protocol/nativeExecution'
import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import { safeStringify } from '@hapi/protocol'
import type { DecryptedMessage } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import { isCodexContent, isSkippableAgentContent, normalizeAgentRecord } from '@/chat/normalizeAgent'
import { normalizeUserRecord } from '@/chat/normalizeUser'

export function normalizeDecryptedMessage(message: DecryptedMessage): NormalizedMessage | null {
    let record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return {
            id: message.id,
            localId: message.localId,
            createdAt: message.createdAt,
            role: 'agent',
            isSidechain: false,
            content: [{ type: 'text', text: safeStringify(message.content), uuid: message.id, parentUUID: null }],
            status: message.status,
            originalText: message.originalText
        }
    }

    const body = isObject(record.content) && isObject(record.content.data) ? record.content.data : null
    const meta = isObject(record.meta) ? record.meta : {}
    const execution = NativeExecutionSchema.safeParse(meta.nativeExecution ?? body?.nativeExecution)
    if (execution.success) record = { ...record, meta: { ...meta, nativeExecution: execution.data, nativeSourceId: message.id, nativeSourceSeq: message.seq } }
    if (body?.type === 'native-turn' && execution.success) {
        return { id: message.id, localId: message.localId, createdAt: message.createdAt,
            role: 'event', content: { type: 'native-turn' }, isSidechain: false, meta: record.meta }
    }

    if (record.role === 'user') {
        const normalized = normalizeUserRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        return normalized
            ? { ...normalized, status: message.status, originalText: message.originalText, invokedAt: message.invokedAt, steered: message.steered }
            : {
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: safeStringify(record.content) },
                meta: record.meta,
                status: message.status,
                originalText: message.originalText,
                invokedAt: message.invokedAt,
                steered: message.steered
            }
    }
    if (record.role === 'agent') {
        if (isSkippableAgentContent(record.content)) {
            return null
        }
        const normalized = normalizeAgentRecord(message.id, message.localId, message.createdAt, record.content, record.meta)
        if (!normalized && isCodexContent(record.content)) {
            return null
        }
        return normalized
            ? { ...normalized, status: message.status, originalText: message.originalText, invokedAt: message.invokedAt }
            : {
                id: message.id,
                localId: message.localId,
                createdAt: message.createdAt,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
                meta: record.meta,
                status: message.status,
                originalText: message.originalText,
                invokedAt: message.invokedAt
            }
    }

    return {
        id: message.id,
        localId: message.localId,
        createdAt: message.createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text: safeStringify(record.content), uuid: message.id, parentUUID: null }],
        meta: record.meta,
        status: message.status,
        originalText: message.originalText,
        invokedAt: message.invokedAt
    }
}
