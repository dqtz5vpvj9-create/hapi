import type { SubagentMessage } from '@hapi/protocol/apiTypes'

/**
 * Public contract of the generic native-subagent data layer (Codex + DSH).
 * `web/src/components/SubagentChat/**` compiles against these exact names, so
 * treat this file as the API boundary and keep existing fields stable.
 */

export type { SubagentMessage }

/** Codex native child thread (`codexSubagents`) or DSH child session (`dshSubagents`). */
export type NativeSubagentFlavor = 'codex' | 'dsh'

export type NativeSubagentMode = 'one-shot' | 'continuable' | 'external' | 'unknown'

export type NativeSubagentActivity = 'running' | 'inactive'

export type NativeSubagentTeamStatus = 'running' | 'inactive' | 'provisioning' | 'failed'

export type SubagentPromptDelivery = 'queue' | 'steer'

/**
 * One addressable child of a HAPI session. For Codex, `sessionId` is the child
 * thread id; for DSH it is the durable child DSH session id.
 */
export type NativeSubagentRef = {
    parentSessionId: string
    sessionId: string
    flavor: NativeSubagentFlavor
    label: string
    mode?: NativeSubagentMode
    activity?: NativeSubagentActivity
    /** Only DSH Agent Team members carry this. */
    teamStatus?: NativeSubagentTeamStatus
    /** Only DSH Agent Team members carry this (e.g. `spawn`). */
    provider?: string
    createdAt?: number
    settledMs?: number
    openSince?: number
    lastTurnCompleted?: boolean
}

export type SubagentReadOptions = {
    limit?: number
    before?: number
    after?: number
    /** DSH transcript epoch; required together with `after`. */
    epoch?: string
    signal?: AbortSignal
}

/**
 * One bounded read window over a child transcript. `sessionId` unifies the
 * Codex `threadId` and the DSH child session id.
 */
export type SubagentPage = {
    sessionId: string
    messages: SubagentMessage[]
    /** Cursor that continues towards older messages; `null` means the beginning. */
    before: number | null
    hasMore: boolean
    /** Cursor that continues towards newer messages. */
    after?: number
    epoch?: string
    hasLater?: boolean
    /** The child transcript changed (epoch reset); the window must be replaced. */
    reset?: boolean
    truncated?: boolean
}

export type SubagentSource = {
    ref: NativeSubagentRef
    read(options?: SubagentReadOptions): Promise<SubagentPage>
    /**
     * Only continuable DSH children expose this. `text` is forwarded as one
     * human message; the source mints the request id.
     */
    prompt?(text: string, delivery: SubagentPromptDelivery): Promise<void>
    interrupt?(): Promise<void>
    /** False when the API identity that created this source is no longer current. */
    isCurrent?(): boolean
}

export type SubagentHistoryState = {
    page: SubagentPage | null
    loading: boolean
    error: string | null
    following: boolean
    bounded: boolean
    restarted: boolean
}

/** Maps a transcript row to its pagination cursor (Codex byte offset / DSH transcript position). */
export type SubagentCursorOf = (message: SubagentMessage) => number | undefined
