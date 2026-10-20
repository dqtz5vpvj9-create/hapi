import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react'
import type { ApiClient } from '@/api/client'
import type { SessionMetadataSummary } from '@/types/api'
import {
    createSubagentHistory,
    projectSubagentBlocks,
    SUBAGENT_FOLLOW_INTERVAL_MS,
    useSubagentRuntime,
    type SubagentSource,
} from '@/components/subagent'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { MessageSkeleton, THREAD_MESSAGE_COMPONENTS } from '@/components/AssistantChat/HappyThread'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { formatDuration } from '@/chat/presentation'
import { useTranslation } from '@/lib/use-translation'
import { nativeSubagentDurationMs, type NativeSubagentRow } from './nativeSubagents'
import { SubagentComposer } from './SubagentComposer'

function BackIcon() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

/** One-second tick for the open turn's elapsed time. */
function useDurationTick(active: boolean): number {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!active) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [active])
    return now
}

export function subagentReadOnlyNoticeKey(row: NativeSubagentRow): string {
    if (row.flavor === 'codex') return 'sessions.subagentReadOnlyCodex'
    if (row.mode === 'external') return 'sessions.subagentReadOnlyExternal'
    if (row.mode === 'one-shot') return 'sessions.subagentReadOnlyOneShot'
    return 'sessions.subagentReadOnly'
}

export function subagentBadges(row: NativeSubagentRow): string[] {
    const badges: string[] = [`sessions.subagentFlavor.${row.flavor}`]
    if (row.flavor === 'dsh') {
        if (row.mode) badges.push(`sessions.subagentMode.${row.mode}`)
        if (row.teamStatus) {
            badges.push(`sessions.subagentTeamStatus.${row.teamStatus}`)
        } else if (row.activity) {
            badges.push(`sessions.subagentActivity.${row.activity}`)
        }
    }
    return badges
}

export function SubagentConversation(props: {
    api: ApiClient
    parentSessionId: string
    metadata: SessionMetadataSummary | null
    parentTitle: string
    row: NativeSubagentRow
    source: SubagentSource
    onBack: () => void
}) {
    const { api, parentSessionId, metadata, parentTitle, row, source, onBack } = props
    const { t } = useTranslation()
    const { terminalToolDisplayMode } = useTerminalToolDisplayMode()
    const history = useMemo(() => createSubagentHistory(source), [source])
    const state = useSyncExternalStore(history.subscribe, history.get)

    // Poll only while the page is visible and online, matching the root chat.
    useEffect(() => {
        const synchronize = () => {
            const active = document.visibilityState !== 'hidden' && navigator.onLine !== false
            history.setActive(active)
            if (active) void history.refresh()
        }
        synchronize()
        const interval = setInterval(synchronize, SUBAGENT_FOLLOW_INTERVAL_MS)
        document.addEventListener('visibilitychange', synchronize)
        window.addEventListener('online', synchronize)
        window.addEventListener('offline', synchronize)
        return () => {
            clearInterval(interval)
            history.setActive(false)
            document.removeEventListener('visibilitychange', synchronize)
            window.removeEventListener('online', synchronize)
            window.removeEventListener('offline', synchronize)
        }
    }, [history])

    const blocks = useMemo(() => projectSubagentBlocks(state.page?.messages ?? []), [state.page?.messages])
    const running = row.teamStatus === 'running' || row.activity === 'running'
    const durationActive = row.flavor === 'dsh' && (row.openSince !== undefined || (row.settledMs ?? 0) > 0)
    const now = useDurationTick(durationActive)
    const durationMs = nativeSubagentDurationMs(row, now)
    const runtime = useSubagentRuntime({ blocks, running })
    const showComposer = row.flavor === 'dsh' && row.mode === 'continuable' && Boolean(source.prompt)

    const chatContext = useMemo<HappyChatContextValue>(() => ({
        api,
        sessionId: parentSessionId,
        metadata,
        terminalToolDisplayMode,
        showSessionSummaryInChat: false,
        disabled: true,
        onRefresh: () => {},
        hasMoreMessages: Boolean(state.page?.hasMore),
        isSyncingTail: false,
        isLoadingMoreMessages: state.loading,
        loadOlderMessagesPreservingScroll: async () => 'transient-stop',
    }), [api, parentSessionId, metadata, terminalToolDisplayMode, state.page?.hasMore, state.loading])

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]" data-subagent-conversation
            data-subagent-flavor={row.flavor} data-subagent-id={row.id}>
            <header className="flex flex-col gap-2 border-b border-[var(--app-border)] px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                    <button type="button" onClick={onBack}
                        aria-label={t('sessions.subagentBack')} title={t('sessions.subagentBack')}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                            <span className="truncate text-[var(--app-hint)]" title={parentTitle}>{parentTitle}</span>
                            <span aria-hidden="true" className="shrink-0 text-[var(--app-hint)]">→</span>
                            <span className="truncate" title={row.title}>{row.title}</span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--app-hint)]">
                            {subagentBadges(row).map(key => (
                                <span key={key} data-subagent-badge={key}
                                    className="inline-flex max-w-full items-center rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-1.5 py-0.5">
                                    {t(key)}
                                </span>
                            ))}
                            {durationMs !== null ? (
                                <span data-subagent-duration>
                                    {t('sessions.subagentDurationLabel')} · {formatDuration(durationMs)}
                                </span>
                            ) : null}
                        </div>
                    </div>
                    {state.loading ? <Spinner size="sm" label={null} /> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                    {state.page?.hasMore ? (
                        <Button size="sm" variant="outline" disabled={state.loading} onClick={() => void history.loadEarlier()}>
                            {t('sessions.subagentLoadEarlier')}
                        </Button>
                    ) : null}
                    <Button size="sm" variant="outline" disabled={state.loading} onClick={() => { void history.loadLatest() }}>
                        {t('sessions.subagentLatest')}
                    </Button>
                    <span className="text-[var(--app-hint)]" data-subagent-following={state.following || undefined}>
                        {t(state.following ? 'sessions.subagentFollowing' : 'sessions.subagentHistoryPaused')}
                    </span>
                </div>
                {state.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
                {state.bounded ? <p className="text-xs text-[var(--app-hint)]">{t('sessions.subagentBounded')}</p> : null}
                {state.restarted ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('sessions.subagentRestarted')}</p> : null}
            </header>
            <div className="min-h-0 flex-1 overflow-hidden">
                <HappyChatProvider value={chatContext}>
                    <AssistantRuntimeProvider runtime={runtime}>
                        <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
                            <ThreadPrimitive.Viewport className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3">
                                <ThreadPrimitive.Empty>
                                    <div className="flex h-full min-h-[8rem] flex-col items-center justify-center gap-2 text-center">
                                        {!state.page && state.loading
                                            ? <MessageSkeleton />
                                            : <span className="text-sm text-[var(--app-hint)]">{t('sessions.subagentEmpty')}</span>}
                                    </div>
                                </ThreadPrimitive.Empty>
                                <div className="flex flex-col gap-3">
                                    <ThreadPrimitive.Messages components={THREAD_MESSAGE_COMPONENTS} />
                                </div>
                            </ThreadPrimitive.Viewport>
                        </ThreadPrimitive.Root>
                    </AssistantRuntimeProvider>
                </HappyChatProvider>
            </div>
            {showComposer ? (
                <SubagentComposer source={source} running={running} />
            ) : (
                <p className="border-t border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-hint)]" data-subagent-readonly>
                    {t(subagentReadOnlyNoticeKey(row))}
                </p>
            )}
        </div>
    )
}
