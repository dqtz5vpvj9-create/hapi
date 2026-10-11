import type { NativeRuntimeState, Session, SessionPatch } from './schemas'
import type { SessionSummary } from './sessionSummary'

export const EXECUTION_FIELDS = ['active', 'activeAt', 'thinking', 'activeTurnStartedAt', 'execution',
    'backgroundTaskCount', 'model', 'modelReasoningEffort', 'effort', 'serviceTier', 'permissionMode',
    'collaborationMode', 'copilotAgentMode'] as const

/** Versioned execution patches are full snapshots, independent of delivery stream. */
export function executionPatchIsNewer(current: { executionVersion?: number }, patch: { executionVersion?: number }): boolean {
    return patch.executionVersion !== undefined
        ? patch.executionVersion > (current.executionVersion ?? 0)
        : current.executionVersion === undefined
}

export function reconcileSessionSnapshot(current: Session | undefined, incoming: Session): Session {
    if (!current) return incoming
    const next = { ...incoming }
    if ((current.executionVersion ?? 0) > (incoming.executionVersion ?? 0)) {
        for (const field of EXECUTION_FIELDS) Object.assign(next, { [field]: current[field] })
        next.executionVersion = current.executionVersion
    }
    if (current.metadataVersion > incoming.metadataVersion) {
        next.metadata = current.metadata; next.metadataVersion = current.metadataVersion
    }
    if (current.agentStateVersion > incoming.agentStateVersion) {
        next.agentState = current.agentState; next.agentStateVersion = current.agentStateVersion
    }
    if ((current.todosUpdatedAt ?? 0) > (incoming.todosUpdatedAt ?? 0)) {
        next.todos = current.todos; next.todosUpdatedAt = current.todosUpdatedAt
    }
    if ((current.teamStateUpdatedAt ?? 0) > (incoming.teamStateUpdatedAt ?? 0)) {
        next.teamState = current.teamState; next.teamStateUpdatedAt = current.teamStateUpdatedAt
    }
    next.updatedAt = Math.max(current.updatedAt, incoming.updatedAt)
    return next
}

export type SessionActivityInput = Pick<SessionSummary, 'active' | 'thinking' | 'pendingRequestKinds' | 'backgroundTaskCount'> & {
    execution?: NativeRuntimeState | null
    blockingRequestKinds?: SessionSummary['pendingRequestKinds']
}
export function classifySessionActivity(session: SessionActivityInput | undefined): {
    kind: 'offline' | 'permission' | 'input' | 'running' | 'background' | 'idle' | 'error'
    running: boolean
    connected: boolean
    pending: boolean
} {
    const connected = Boolean(session?.active && session.execution?.status !== 'disconnected')
    const pending = Boolean(session?.pendingRequestKinds?.length)
    if (!session || !connected) return { kind: 'offline', running: false, connected: false, pending }
    const blocking = session.blockingRequestKinds ?? session.pendingRequestKinds ?? []
    const waiting = session.execution?.waitingOn ?? []
    const running = session.execution ? session.execution.status === 'active' : session.thinking
    const kind = session.execution?.status === 'systemError' ? 'error'
        : waiting.includes('approval') || blocking.includes('permission') ? 'permission'
        : waiting.includes('input') || blocking.includes('input') ? 'input'
        : running ? 'running' : session.backgroundTaskCount > 0 ? 'background' : 'idle'
    return { kind, running: kind === 'running' || kind === 'background', connected, pending }
}

export function stripStaleExecutionPatch(current: { executionVersion?: number }, patch: SessionPatch): SessionPatch {
    if (executionPatchIsNewer(current, patch)) return patch
    const next = { ...patch }
    for (const field of EXECUTION_FIELDS) delete next[field]
    delete next.executionVersion
    return next
}
