import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { getMessageTailSyncError, getMessageWindowState, subscribeMessageWindow, syncTailMessages } from '@/lib/message-window-store'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

/** Message synchronization is separate from the agent's running state. */
export function MessageSyncStatus({ api, sessionId }: { api: ApiClient; sessionId: string }) {
    const state = useSyncExternalStore(
        useCallback(listener => subscribeMessageWindow(sessionId, listener), [sessionId]),
        useCallback(() => getMessageWindowState(sessionId), [sessionId])
    )
    const { t } = useTranslation()
    const [now, setNow] = useState(Date.now)
    const [showPending, setShowPending] = useState(false)
    const progress = state.tailSyncProgress
    const waiting = !state.isSyncingTail && Boolean(progress?.retryAt && progress.retryAt > now)
    const failed = !state.isSyncingTail && Boolean(getMessageTailSyncError(sessionId))
    const pending = state.isSyncingTail || waiting
    const visible = pending ? showPending && now - (progress?.startedAt ?? now) >= 1_000 : failed
    useEffect(() => {
        setShowPending(false)
        if (!pending) return
        const delay = Math.max(0, 1_000 - (Date.now() - (progress?.startedAt ?? Date.now())))
        const timer = setTimeout(() => { setNow(Date.now()); setShowPending(true) }, delay)
        return () => clearTimeout(timer)
    }, [pending, progress?.startedAt])
    useEffect(() => {
        if (!visible) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1_000)
        return () => clearInterval(timer)
    }, [visible, progress?.startedAt])
    if (!visible) return null
    const elapsed = Math.max(0, Math.floor((now - (progress?.startedAt ?? now)) / 1_000))
    const download = progress?.download
    const kb = download ? Math.round(download.bytes / 1024) : 0
    const speed = download ? (download.bytes / 1024 / Math.max(0.1, (Math.max(now, download.lastAt) - download.startedAt) / 1_000)).toFixed(1) : 0
    const percent = download?.total ? Math.min(100, Math.floor(download.bytes / download.total * 100)) : null
    const label = state.isSyncingTail
        ? t(download ? 'chat.sync.downloading' : state.messages.length ? 'chat.sync.updating' : 'chat.sync.loading')
        : waiting ? t('chat.sync.retrying', { attempt: progress?.retryAttempt ?? 1 }) : t('chat.sync.failed')
    return (
        <div role={failed && !waiting ? 'alert' : 'status'} data-message-sync-status
            className="absolute left-1/2 top-3 z-20 flex w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)]/95 px-3 py-1.5 text-xs text-[var(--app-hint)] shadow-sm backdrop-blur">
            {state.isSyncingTail || waiting ? <Spinner size="sm" label={null} className="shrink-0 text-current" /> : null}
            <div className="min-w-0">
                <div aria-live="polite">{label}</div>
                <div className="opacity-75 tabular-nums">
                    {state.isSyncingTail || waiting ? t('chat.sync.elapsed', { seconds: elapsed }) : t(state.messages.length ? 'chat.sync.cached' : 'chat.sync.empty')}
                    {state.isSyncingTail && download ? ` · ${kb} KB${percent !== null ? ` (${percent}%)` : ''} · ${t('chat.sync.speed', { kb: speed })}` : ''}
                    {progress && progress.pages > 0 && !download ? ` · ${t('chat.sync.received', { records: progress.records, pages: progress.pages })}` : ''}
                </div>
            </div>
            {failed || elapsed >= 5 ? (
                <button type="button" className="shrink-0 text-[var(--app-link)]"
                    onClick={() => { void syncTailMessages(api, sessionId, { restart: true }) }}>
                    {t(failed ? 'chat.sync.retry' : 'chat.sync.restart')}
                </button>
            ) : null}
        </div>
    )
}
