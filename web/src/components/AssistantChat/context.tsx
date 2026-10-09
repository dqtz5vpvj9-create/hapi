import type { ReactNode } from 'react'
import { createContext, useContext, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { ApiClient } from '@/api/client'
import type { TerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import type { SessionMetadataSummary } from '@/types/api'

export type OlderHistoryLoadResult = 'loaded' | 'transient-stop' | 'terminal-stop'

export type HappyChatContextValue = {
    api: ApiClient
    sessionId: string
    metadata: SessionMetadataSummary | null
    terminalToolDisplayMode: TerminalToolDisplayMode
    /** Hub-wide AGENT_NOTIFY_SUMMARY chat display; polled once at chat shell. */
    showSessionSummaryInChat: boolean
    disclosureState?: Map<string, boolean>
    activeExecutionToolId?: string | null
    disabled: boolean
    onRefresh: () => void
    codexPlanProposalId?: string | null
    onContinuePlan?: (planId: string) => void
    continuedPlanIds?: ReadonlySet<string>
    onRetryMessage?: (localId: string) => void
    onDiscardFailedMessage?: (localId: string) => void
    historyActionPending?: boolean
    onForkConversation?: (messageLocalId?: string) => Promise<void>
    onRewindConversation?: (messageLocalId: string) => Promise<void>
    isLatestCompletedBoundary?: (messageId: string) => boolean
    onShareTurn?: (
        messageElement: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: { html: string; text: string; role?: 'user' | 'assistant' }
    ) => void
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
    onNestedScrollFollowChange?: (followLatest: boolean) => void
    loadOlderMessagesPreservingScroll: () => Promise<OlderHistoryLoadResult>
}

const HappyChatContext = createContext<HappyChatContextValue | null>(null)

export function HappyChatProvider(props: { value: HappyChatContextValue; children: ReactNode }) {
    // Keep dismissal outside virtualized cards so recycling cannot revive a menu.
    const [continued, setContinued] = useState<{ sessionId: string; ids: ReadonlySet<string> }>({
        sessionId: props.value.sessionId, ids: new Set()
    })
    const ids = continued.sessionId === props.value.sessionId ? continued.ids : new Set<string>()
    const value = useMemo<HappyChatContextValue>(() => ({
        ...props.value,
        continuedPlanIds: ids,
        onContinuePlan: props.value.onContinuePlan ? (planId) => {
            if (props.value.disabled || props.value.codexPlanProposalId !== planId || ids.has(planId)) return
            setContinued({ sessionId: props.value.sessionId, ids: new Set([...ids, planId]) })
            props.value.onContinuePlan?.(planId)
        } : undefined
    }), [props.value, ids])
    return (
        <HappyChatContext.Provider value={value}>
            {props.children}
        </HappyChatContext.Provider>
    )
}

export function useOptionalHappyChatContext(): HappyChatContextValue | null {
    return useContext(HappyChatContext)
}

export function useHappyChatContext(): HappyChatContextValue {
    const ctx = useOptionalHappyChatContext()
    if (!ctx) {
        throw new Error('HappyChatContext is missing')
    }
    return ctx
}

/** Native view state survives virtual unmounts, bounded by the current window. */
export function useChatDisclosure(key: string, initial: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
    const map = useOptionalHappyChatContext()?.disclosureState
    const [open, setOpen] = useState(() => map?.get(key) ?? initial)
    return [open, value => setOpen(previous => {
        const next = typeof value === 'function' ? value(previous) : value
        map?.set(key, next)
        return next
    })]
}
