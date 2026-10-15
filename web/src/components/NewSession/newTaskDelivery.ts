import type { AttachmentMetadata } from '@/types/api'
import type { ApiClient } from '@/api/client'
import type { NewSessionFormDraft } from './newSessionFormDraft'
import { randomId } from '@/lib/randomId'

export type NewTaskLaunchInput = {
    machineId: string
    directory: string
    requestId?: string
} & Record<string, unknown>

export type NewTaskDelivery = {
    requestId: string
    localId: string
    sessionId?: string
    shareTransferId?: string
    text: string
    fileIds: string[]
    attachments?: AttachmentMetadata[]
    launch?: NewTaskLaunchInput
    form?: NewSessionFormDraft
}

const fallback = new Map<string, NewTaskDelivery>()
export function loadNewTaskDelivery(key: string): NewTaskDelivery | null {
    try {
        const raw = sessionStorage.getItem(`${key}:delivery`)
        if (!raw) return fallback.get(key) ?? null
        const value = JSON.parse(raw) as NewTaskDelivery
        return typeof value.requestId === 'string' && typeof value.localId === 'string'
            && typeof value.text === 'string' && Array.isArray(value.fileIds) ? value : null
    } catch { return fallback.get(key) ?? null }
}
export function saveNewTaskDelivery(key: string, value: NewTaskDelivery | null): void {
    if (value) fallback.set(key, value)
    else fallback.delete(key)
    try {
        if (value) sessionStorage.setItem(`${key}:delivery`, JSON.stringify(value))
        else sessionStorage.removeItem(`${key}:delivery`)
    } catch { /* Keep the exact attempt in memory if browser storage is disabled. */ }
}
export function createNewTaskDelivery(text: string, fileIds: string[]): NewTaskDelivery {
    return { requestId: randomId(), localId: randomId(), text, fileIds }
}

/** A retry always uses the same session and message identity. The hub deduplicates localId. */
export async function sendNewTaskDelivery(api: ApiClient, delivery: NewTaskDelivery, attachments: Parameters<ApiClient['sendMessage']>[3]): Promise<void> {
    if (!delivery.sessionId) throw new Error('Task session is not ready')
    await api.sendMessage(delivery.sessionId, delivery.text, delivery.localId, attachments)
}
