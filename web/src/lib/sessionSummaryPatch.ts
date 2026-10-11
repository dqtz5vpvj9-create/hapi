import type { SessionPatch, SessionSummary } from '@/types/api'
import { computePendingRequestsCount, computePendingRequestKinds, computeBlockingRequestKinds, computePendingRequests,
    computeTodoProgress, toSessionSummaryMetadata, stripStaleExecutionPatch } from '@hapi/protocol'

export function applySessionSummaryPatch(current: SessionSummary, input: SessionPatch): SessionSummary {
    const patch = stripStaleExecutionPatch(current, input)
    const nextSummary: SessionSummary = {
        ...current,
        active: patch.active ?? current.active,
        thinking: patch.thinking ?? current.thinking,
        activeAt: patch.activeAt ?? current.activeAt,
        // Monotonic: stale versioned-patch replays can carry an
        // older updatedAt; never move the list clock backward.
        updatedAt: patch.updatedAt !== undefined
            ? Math.max(current.updatedAt, patch.updatedAt)
            : current.updatedAt,
        backgroundTaskCount: Object.prototype.hasOwnProperty.call(patch, 'backgroundTaskCount')
            ? patch.backgroundTaskCount ?? 0
            : current.backgroundTaskCount,
        model: Object.prototype.hasOwnProperty.call(patch, 'model') ? patch.model ?? null : current.model,
        modelReasoningEffort: Object.prototype.hasOwnProperty.call(patch, 'modelReasoningEffort')
            ? patch.modelReasoningEffort ?? null
            : current.modelReasoningEffort,
        effort: Object.prototype.hasOwnProperty.call(patch, 'effort') ? patch.effort ?? null : current.effort
    }

    // Gate versioned fields against THIS summary's watermarks —
    // not the detail query. Global SSE covers every session;
    // requiring detail would force O(N) /sessions invalidation.
    // teamState is a summary no-op (not rendered on the list).
    if (patch.todos !== undefined && patch.todos.version >= current.todosUpdatedAt) {
        nextSummary.todoProgress = computeTodoProgress(patch.todos.value)
        nextSummary.todosUpdatedAt = patch.todos.version
    }
    if (patch.agentState !== undefined && patch.agentState.version >= current.agentStateVersion) {
        nextSummary.pendingRequestsCount = computePendingRequestsCount(patch.agentState.value)
        nextSummary.pendingRequestKinds = computePendingRequestKinds(patch.agentState.value)
        nextSummary.pendingRequests = computePendingRequests(patch.agentState.value, nextSummary.updatedAt)
        nextSummary.agentStateVersion = patch.agentState.version
    }
    if (patch.metadata !== undefined && patch.metadata.version >= current.metadataVersion) {
        nextSummary.metadata = toSessionSummaryMetadata(patch.metadata.value)
        nextSummary.metadataVersion = patch.metadata.version
    }

    // Native activity is authoritative; connection/state patches use Hub wall time.
    if (nextSummary.metadata?.flavor === 'codex' && nextSummary.metadata.codexUpdatedAt !== undefined) {
        nextSummary.updatedAt = nextSummary.metadata.codexUpdatedAt
    }

    if (patch.executionVersion !== undefined) nextSummary.executionVersion = patch.executionVersion
    if (patch.execution !== undefined) nextSummary.execution = patch.execution
    if (patch.agentState && patch.agentState.version >= current.agentStateVersion) {
        nextSummary.blockingRequestKinds = computeBlockingRequestKinds(patch.agentState.value)
    }
    return nextSummary
}

export function reconcileSessionSummary(current: SessionSummary | undefined, incoming: SessionSummary): SessionSummary {
    if (!current) return incoming
    const next = { ...incoming }
    if ((current.executionVersion ?? 0) > (incoming.executionVersion ?? 0)) {
        for (const field of ['active','thinking','activeAt','execution','executionVersion','backgroundTaskCount','model','modelReasoningEffort','effort'] as const)
            Object.assign(next, { [field]: current[field] })
    }
    if (current.metadataVersion > incoming.metadataVersion) {
        next.metadata = current.metadata; next.metadataVersion = current.metadataVersion
    }
    if (current.agentStateVersion > incoming.agentStateVersion) {
        next.agentStateVersion = current.agentStateVersion
        next.pendingRequests = current.pendingRequests; next.pendingRequestsCount = current.pendingRequestsCount
        next.pendingRequestKinds = current.pendingRequestKinds; next.blockingRequestKinds = current.blockingRequestKinds
    }
    if (current.todosUpdatedAt > incoming.todosUpdatedAt) {
        next.todoProgress = current.todoProgress; next.todosUpdatedAt = current.todosUpdatedAt
    }
    next.updatedAt = next.metadata?.flavor === 'codex' && next.metadata.codexUpdatedAt !== undefined
        ? next.metadata.codexUpdatedAt : Math.max(current.updatedAt, incoming.updatedAt)
    return next
}
