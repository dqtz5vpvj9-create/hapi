import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    getQueuedReconcileCandidateLocalIds,
    getMessageWindowState,
    getQueuedMessageAuthority,
    markMessagesConsumed,
    markMessagesIndeterminate,
    markMessagesDispatching,
    markMessagesRequeued,
    reconcileQueuedLocalIds,
    syncTailMessages,
} from './message-window-store'

const QUEUED_STATE_BATCH_SIZE = 1000
const latestRequests = new Map<string, object>()

function candidateRows(sessionId: string, candidates: ReadonlySet<string>): Map<string, Map<DecryptedMessage, object>> {
    const rows = new Map<string, Map<DecryptedMessage, object>>()
    for (const message of getMessageWindowState(sessionId).messages) {
        if (!message.localId || !candidates.has(message.localId)) continue
        const group = rows.get(message.localId) ?? new Map<DecryptedMessage, object>()
        group.set(message, getQueuedMessageAuthority(sessionId, message))
        rows.set(message.localId, group)
    }
    return rows
}

export async function reconcileQueuedStateAfterConnect(
    api: ApiClient,
    sessionId: string
): Promise<void> {
    const request = {}
    latestRequests.set(sessionId, request)
    try {
        await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
        if (latestRequests.get(sessionId) !== request) return
        const candidateLocalIds = getQueuedReconcileCandidateLocalIds(sessionId)
        if (candidateLocalIds.length === 0) {
            return
        }
        const candidates = new Set(candidateLocalIds)
        const baseline = candidateRows(sessionId, candidates)
        const queuedLocalIds: string[] = []
        const indeterminateLocalIds: string[] = []
        const dispatchingLocalIds: string[] = []
        const invokedLocalMessages: Array<{ localId: string; invokedAt: number }> = []
        for (let index = 0; index < candidateLocalIds.length; index += QUEUED_STATE_BATCH_SIZE) {
            const batch = candidateLocalIds.slice(index, index + QUEUED_STATE_BATCH_SIZE)
            const state = await api.getQueuedState(sessionId, batch)
            if (latestRequests.get(sessionId) !== request) return
            queuedLocalIds.push(...state.queuedLocalIds)
            dispatchingLocalIds.push(...(state.dispatchingLocalIds ?? []))
            indeterminateLocalIds.push(...(state.indeterminateLocalIds ?? []))
            invokedLocalMessages.push(...state.invokedLocalMessages)
        }
        const current = candidateRows(sessionId, candidates)
        const unchanged = new Set(candidateLocalIds.filter(localId => {
            const before = baseline.get(localId), after = current.get(localId)
            return before && after && before.size === after.size
                && [...after].every(([row, authority]) => before.get(row) === authority)
        }))
        const invokedByTimestamp = new Map<number, string[]>()
        for (const message of invokedLocalMessages) {
            if (!unchanged.has(message.localId)) continue
            const localIds = invokedByTimestamp.get(message.invokedAt) ?? []
            localIds.push(message.localId)
            invokedByTimestamp.set(message.invokedAt, localIds)
        }
        for (const [invokedAt, localIds] of invokedByTimestamp) {
            markMessagesConsumed(sessionId, localIds, invokedAt)
        }
        // Clear force-dismiss holds for rows that returned to ordinary FIFO while
        // SSE was down (#1839 queueDismissed).
        markMessagesRequeued(sessionId, queuedLocalIds.filter(localId => unchanged.has(localId)))
        markMessagesDispatching(sessionId, dispatchingLocalIds.filter(localId => unchanged.has(localId)))
        markMessagesIndeterminate(sessionId, indeterminateLocalIds.filter(localId => unchanged.has(localId)))
        reconcileQueuedLocalIds(sessionId, [...unchanged], [...queuedLocalIds, ...dispatchingLocalIds, ...indeterminateLocalIds])
    } finally {
        if (latestRequests.get(sessionId) === request) latestRequests.delete(sessionId)
    }
}
