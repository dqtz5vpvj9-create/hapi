import { useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import type { ApiClient } from '@/api/client'
import type { MessageDeliveryMode } from '@hapi/protocol'
import type { AttachmentDraftInput } from './composer-attachment-drafts'

export type SessionSendError = {
    id: number
    text: string
    message: string
    code: string | null
    scheduledAt: number | null
    deliveryMode: MessageDeliveryMode
    mutationStarted: boolean
    restoreSuppressed: boolean
    attachmentDrafts?: AttachmentDraftInput[]
}
type Errors = Record<string, SessionSendError>
class SendErrors {
    private state: Errors = {}
    private sequence = 0
    private listeners = new Set<() => void>()
    get = () => this.state
    nextId = () => ++this.sequence
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    set = (value: SetStateAction<Errors>) => {
        const next = typeof value === 'function' ? value(this.state) : value
        if (next === this.state) return
        this.state = next
        this.listeners.forEach(listener => listener())
    }
}
const clients = new WeakMap<ApiClient, SendErrors>()

/** A late failure belongs to its conversation even after its pane is hidden. */
export function useSessionSendErrors(api: ApiClient) {
    const store = useMemo(() => {
        let store = clients.get(api)
        if (!store) { store = new SendErrors(); clients.set(api, store) }
        return store
    }, [api])
    return { sendErrors: useSyncExternalStore(store.subscribe, store.get), setSendErrors: store.set, nextSendErrorId: store.nextId }
}
