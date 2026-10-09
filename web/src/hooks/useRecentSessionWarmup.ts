import { useEffect, useMemo, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionResponse } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { clearRecentSessionWarmup, getRecentSessionWarmup, type RecentSessionWarmup } from '@/lib/recent-session-warmup'
import { prepareCachedSessionPresentation } from '@/chat/sessionPresentation'

export function useRecentSessionWarmup(api: ApiClient | null, selectedSessionId: string | null, visibleSessionIds?: readonly string[]) {
    const router = useRouter()
    const queryClient = useQueryClient()
    const current = useRef<RecentSessionWarmup | null>(null)

    useEffect(() => {
        if (!api) return
        const warmup = getRecentSessionWarmup(api)
        current.current = warmup
        warmup.prepare = id => {
            const session = queryClient.getQueryData<SessionResponse>(queryKeys.session(id))?.session
            const window = getMessageWindowState(id)
            if (session && window.viewMode === 'tail') prepareCachedSessionPresentation(api, session, window.messages, window.epoch)
        }
        const unsubscribe = router.subscribe('onBeforeNavigate', event => {
            const target = /^\/sessions\/([^/]+)\/?$/.exec(event.toLocation.pathname)?.[1]
            const source = /^\/sessions\/([^/]+)/.exec(event.fromLocation?.pathname ?? '')?.[1]
            // Returning from files/terminal within one session keeps its reader;
            // choosing a session from elsewhere opens the latest content.
            if (target && target !== 'new' && target !== 'workspace' && source !== 'workspace' && target !== source) warmup.switchTo(decodeURIComponent(target))
        })
        const connection = (navigator as Navigator & { connection?: EventTarget }).connection
        const changed = () => warmup.environmentChanged()
        window.addEventListener('online', changed)
        window.addEventListener('offline', changed)
        document.addEventListener('visibilitychange', changed)
        connection?.addEventListener('change', changed)
        return () => {
            unsubscribe()
            window.removeEventListener('online', changed)
            window.removeEventListener('offline', changed)
            document.removeEventListener('visibilitychange', changed)
            connection?.removeEventListener('change', changed)
            clearRecentSessionWarmup(api)
            current.current = null
        }
    }, [api, queryClient, router])

    useEffect(() => {
        const warmup = current.current
        const ids = visibleSessionIds ?? (selectedSessionId ? [selectedSessionId] : [])
        warmup?.setVisible(ids)
        const unsubscribe = warmup ? ids.map(id => subscribeMessageWindow(id, warmup.schedule)) : []
        return () => unsubscribe.forEach(stop => stop())
    }, [api, selectedSessionId, visibleSessionIds])
    return useMemo(() => ({
        event: (event: Parameters<RecentSessionWarmup['event']>[0]) => current.current?.event(event),
        refresh: () => current.current?.refresh()
    }), [])
}
