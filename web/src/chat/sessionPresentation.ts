import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'
import { isQueuedForInvocation } from '@/lib/messages'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { reconcileChatBlocks } from './reconcile'
import { NativeChatProjection } from './nativeProjection'
import type { ChatBlock, NormalizedMessage } from './types'
import { RECENT_SESSION_LIMIT } from '@/lib/recent-session-warmup'

export function buildGoalStateMessages(messages: DecryptedMessage[]): DecryptedMessage[] {
    return messages.filter(message => !(message.invokedAt == null && message.scheduledAt != null))
}

/** Derived state of one bounded window, independent of its mounted React view.
 * No DOM, callbacks, timers or network requests survive a session switch. */
export class SessionPresentation {
    readonly nativeProjection = new NativeChatProjection()
    private normalized = new Map<string, { source: DecryptedMessage; value: NormalizedMessage | null }>()
    private blocks = new Map<string, ChatBlock>()
    private previous?: {
        messages: DecryptedMessage[]
        agentState: Session['agentState']
        epoch: number | null
        value: {
            visibleMessages: DecryptedMessage[]
            normalizedMessages: NormalizedMessage[]
            reduced: ReturnType<typeof reduceChatBlocks>
            reconciled: ReturnType<typeof reconcileChatBlocks>
        }
    }

    read(messages: DecryptedMessage[], agentState: Session['agentState'], epoch: number | null) {
        const previous = this.previous
        if (previous?.messages === messages && previous.agentState === agentState && previous.epoch === epoch) return previous.value
        if (previous && previous.epoch !== epoch) {
            this.nativeProjection.resetViewState()
            this.normalized.clear()
            this.blocks.clear()
        }
        const normalizedMessages: NormalizedMessage[] = []
        const seen = new Set<string>()
        const normalize = (message: DecryptedMessage) => {
            seen.add(message.id)
            let entry = this.normalized.get(message.id)
            if (!entry || entry.source !== message) {
                entry = { source: message, value: normalizeDecryptedMessage(message) }
                this.normalized.set(message.id, entry)
            }
            return entry.value
        }
        const visibleMessages = messages.filter(message => !isQueuedForInvocation(message))
        for (const message of visibleMessages) {
            if (seen.has(message.id)) continue
            const value = normalize(message)
            if (value) normalizedMessages.push(value)
        }
        const goalStateMessages = buildGoalStateMessages(messages).flatMap(message => {
            const value = normalize(message)
            return value ? [value] : []
        })
        for (const id of this.normalized.keys()) if (!seen.has(id)) this.normalized.delete(id)
        const reduced = reduceChatBlocks(normalizedMessages, agentState, { goalStateMessages })
        const reconciled = reconcileChatBlocks(reduced.blocks, this.blocks)
        this.blocks = reconciled.byId
        const value = { visibleMessages, normalizedMessages, reduced, reconciled }
        this.previous = { messages, agentState, epoch, value }
        return value
    }
}

/** Keep a small working set of presentations, not every previously opened chat.
 * The ApiClient key follows the same authorization lifetime as history pages. */
const presentations = new WeakMap<ApiClient, Map<string, SessionPresentation>>()
const retained = new WeakMap<ApiClient, Map<string, number>>()
export const RECENT_SESSION_PRESENTATIONS = RECENT_SESSION_LIMIT

function evictIdlePresentations(api: ApiClient): void {
    const recent = presentations.get(api)
    if (!recent) return
    const leases = retained.get(api)
    const idle = [...recent.keys()].filter(id => !leases?.get(id))
    for (const id of idle.slice(0, Math.max(0, idle.length - RECENT_SESSION_PRESENTATIONS))) recent.delete(id)
}

/** Visible panes retain their presentation; the LRU budget applies to idle chats. */
export function retainSessionPresentation(api: ApiClient, sessionId: string, value: SessionPresentation): () => void {
    let leases = retained.get(api)
    if (!leases) { leases = new Map(); retained.set(api, leases) }
    leases.set(sessionId, (leases.get(sessionId) ?? 0) + 1)
    presentations.get(api)?.set(sessionId, value)
    return () => {
        const count = (leases.get(sessionId) ?? 1) - 1
        if (count) leases.set(sessionId, count)
        else leases.delete(sessionId)
        evictIdlePresentations(api)
    }
}

export function prepareCachedSessionPresentation(api: ApiClient, session: Session, messages: DecryptedMessage[], epoch: number | null): void {
    const cached = presentations.get(api)?.get(session.id)
    if (!cached) return
    const ready = cached.read(messages, session.agentState, epoch)
    cached.nativeProjection.update(ready.reconciled.blocks, ready.normalizedMessages)
    cached.nativeProjection.publish()
}

export function getSessionPresentation(api: ApiClient, sessionId: string): SessionPresentation {
    let recent = presentations.get(api)
    if (!recent) { recent = new Map(); presentations.set(api, recent) }
    const value = recent.get(sessionId) ?? new SessionPresentation()
    recent.delete(sessionId)
    recent.set(sessionId, value)
    evictIdlePresentations(api)
    return value
}

export function clearSessionPresentations(api: ApiClient): void {
    presentations.delete(api)
    retained.delete(api)
}
