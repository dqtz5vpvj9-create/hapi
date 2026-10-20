import type { CodexSubagent, DshSubagent } from '@hapi/protocol/schemas'
import type { SessionMetadataSummary } from '@/types/api'

export type NativeSubagentFlavor = 'codex' | 'dsh'

/**
 * Sidebar row state. Codex only tells us whether a child was archived, so its
 * rows stay `unknown` and rely on the flavor marker instead of an activity pill.
 */
export type NativeSubagentStatus = 'running' | 'inactive' | 'provisioning' | 'failed' | 'unknown'

/**
 * One native child rendered by the session sidebar and by the subagent chat
 * header. Codex identities are thread ids, DSH identities are session ids; the
 * `flavor` field keeps the two catalogs apart without mixing their shapes.
 */
export type NativeSubagentRow = {
    flavor: NativeSubagentFlavor
    id: string
    title: string
    /** Codex thread parent. DSH catalog entries are direct children of the HAPI session. */
    parentId?: string
    status: NativeSubagentStatus
    /** Codex catalog identity, shown next to the title. */
    role?: string
    path?: string
    /** DSH catalog fields. */
    mode?: DshSubagent['mode']
    activity?: DshSubagent['activity']
    teamStatus?: DshSubagent['teamStatus']
    label?: string
    name?: string
    provider?: string
    createdAt?: number
    settledMs?: number
    openSince?: number
    lastTurnCompleted?: boolean
}

type DshSubagentMetadata = Pick<SessionMetadataSummary, 'codexSubagents' | 'dshSubagents'>

export function shortSubagentId(id: string): string {
    return id.slice(0, 8)
}

export function codexNativeSubagentRow(agent: CodexSubagent): NativeSubagentRow {
    return {
        flavor: 'codex',
        id: agent.threadId,
        parentId: agent.parentThreadId,
        status: 'unknown',
        title: agent.nickname || agent.role || shortSubagentId(agent.threadId),
        role: agent.role,
        path: agent.path,
    }
}

export function dshNativeSubagentRow(agent: DshSubagent): NativeSubagentRow {
    return {
        flavor: 'dsh',
        id: agent.sessionId,
        status: agent.teamStatus ?? agent.activity,
        title: agent.name || agent.label || shortSubagentId(agent.sessionId),
        mode: agent.mode,
        activity: agent.activity,
        teamStatus: agent.teamStatus,
        label: agent.label,
        name: agent.name,
        provider: agent.provider,
        createdAt: agent.createdAt,
        settledMs: agent.settledMs,
        openSince: agent.openSince,
        lastTurnCompleted: agent.lastTurnCompleted,
    }
}

/** Codex children follow `parentThreadId`; DSH entries are direct children. */
export function nativeSubagentRows(metadata: DshSubagentMetadata | null | undefined): NativeSubagentRow[] {
    if (!metadata) {
        return []
    }
    const rows: NativeSubagentRow[] = []
    for (const agent of metadata.codexSubagents ?? []) {
        rows.push(codexNativeSubagentRow(agent))
    }
    for (const agent of metadata.dshSubagents ?? []) {
        rows.push(dshNativeSubagentRow(agent))
    }
    return rows
}

/**
 * Native rows owned directly by one HAPI session: Codex threads whose parent is
 * the session's native thread, plus every DSH catalog entry. A Codex thread
 * already mirrored as its own HAPI session is excluded so the tree never
 * renders the same child twice.
 */
export function directNativeChildRows(
    rows: readonly NativeSubagentRow[],
    agentSessionId: string | undefined,
    hapiChildAgentIds: ReadonlySet<string>,
): NativeSubagentRow[] {
    return rows.filter(row => {
        if (row.flavor === 'dsh') {
            return true
        }
        return row.parentId === agentSessionId && !hapiChildAgentIds.has(row.id)
    })
}

export function nestedNativeChildRows(rows: readonly NativeSubagentRow[], parentId: string): NativeSubagentRow[] {
    return rows.filter(row => row.flavor === 'codex' && row.parentId === parentId)
}

export function findNativeSubagentRow(
    metadata: DshSubagentMetadata | null | undefined,
    subagentId: string,
): NativeSubagentRow | null {
    if (!metadata) {
        return null
    }
    const dsh = (metadata.dshSubagents ?? []).find(agent => agent.sessionId === subagentId)
    if (dsh) {
        return dshNativeSubagentRow(dsh)
    }
    const codex = (metadata.codexSubagents ?? []).find(agent => agent.threadId === subagentId)
    return codex ? codexNativeSubagentRow(codex) : null
}

/** Accumulated turn time; the parent re-renders once per second while a turn is open. */
export function nativeSubagentDurationMs(row: NativeSubagentRow, now: number): number | null {
    if (row.flavor !== 'dsh') {
        return null
    }
    const settled = row.settledMs ?? 0
    const open = row.openSince !== undefined ? Math.max(0, now - row.openSince) : 0
    if (settled <= 0 && open <= 0) {
        return null
    }
    return settled + open
}
