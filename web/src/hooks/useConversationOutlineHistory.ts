import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, type ApiClient } from '@/api/client'
import type { ConversationOutlineItem } from '@/chat/outline'
import type { HistoryPosition } from '@/lib/history-page-repository'
import { getMessageWindowState, getMessageTailSyncError, subscribeMessageWindow, syncTailMessages } from '@/lib/message-window-store'

// Only labels live here. Selecting a label loads its context through the reader.
export function useConversationOutlineHistory(api: ApiClient, sessionId: string, currentItems: readonly ConversationOutlineItem[], itemsEpoch: number | null, enabled: boolean) {
    const windowState = useSyncExternalStore(
        useCallback(listener => subscribeMessageWindow(sessionId, listener), [sessionId]),
        useCallback(() => getMessageWindowState(sessionId), [sessionId]),
    )
    const scope = useMemo(() => ({
        items: new Map<string, ConversationOutlineItem>(),
        positions: new Map<string, HistoryPosition>(),
        cursor: null as HistoryPosition | null,
        hasMore: false, loading: false, indexing: false, partial: false,
        error: null as string | null,
        denied: false, stale: false, retryOlder: false, generation: 0, active: false,
        timer: null as ReturnType<typeof setTimeout> | null,
    }), [api, sessionId, windowState.epoch])
    const visibleItems = useRef({ items: currentItems, epoch: itemsEpoch })
    visibleItems.current = { items: currentItems, epoch: itemsEpoch }
    const [, render] = useState(0)
    const refresh = useCallback(async (older: boolean, generation: number) => {
        const epoch = windowState.epoch
        if (epoch === null || !scope.active || scope.denied || scope.loading) return
        const current = () => scope.active && scope.generation === generation && getMessageWindowState(sessionId).epoch === epoch
        scope.loading = true
        scope.error = null
        scope.retryOlder = older
        render(value => value + 1)
        try {
            // A manual earlier action skips pages containing only labels already
            // displayed. This is metadata-only; the reader never fetches bodies.
            // Reopening always starts a fresh cursor chain so new head pages
            // cannot leave a gap before the retained labels.
            while (current()) {
                const known = new Set(scope.items.keys())
                if (visibleItems.current.epoch === epoch) {
                    for (const item of visibleItems.current.items) known.add(item.id)
                }
                const result = await api.getMessageOutline(sessionId, {
                    epoch, limit: 100, ...(older && scope.cursor ? { before: scope.cursor } : {}),
                })
                if (!current()) return
                if (result.page.reset || result.page.epoch !== epoch) {
                    scope.items.clear()
                    scope.positions.clear()
                    scope.cursor = null
                    scope.hasMore = false
                    scope.stale = true
                    scope.retryOlder = false
                    await syncTailMessages(api, sessionId, { ensureAfterCurrent: true })
                    if (!current()) return
                    const error = getMessageTailSyncError(sessionId)
                    if (error) throw error
                    return
                }
                // While a legacy scan is incomplete its latest page can change.
                // Publish each fresh snapshot, and enable paging once scanning ends.
                if (!older && scope.indexing) {
                    scope.items.clear()
                    scope.positions.clear()
                }
                for (const entry of result.entries) {
                    const targetMessageId = `user-text:${entry.messageId}`
                    const id = `outline:${targetMessageId}`
                    scope.items.set(id, { id, targetMessageId, kind: 'user', label: entry.label, createdAt: entry.createdAt })
                    scope.positions.set(targetMessageId, { at: entry.at, seq: entry.seq })
                }
                scope.stale = false
                scope.cursor = result.page.beforeCursor
                scope.hasMore = result.page.hasMore
                scope.indexing = result.page.scannedThrough < result.page.headSeq
                scope.partial = result.page.unreadable
                if (scope.indexing) {
                    scope.timer = setTimeout(() => { scope.timer = null; void refresh(false, generation) }, 500)
                }
                const added = result.entries.some(entry => !known.has(`outline:user-text:${entry.messageId}`))
                if (!older || added || scope.indexing || !scope.hasMore || !scope.cursor) break
            }
        } catch (error) {
            if (current()) {
                if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                    scope.items.clear()
                    scope.positions.clear()
                    scope.cursor = null
                    scope.hasMore = false
                    scope.denied = true
                }
                scope.indexing = false
                scope.error = error instanceof Error ? error.message : String(error)
            }
        } finally {
            if (current()) { scope.loading = false; render(value => value + 1) }
        }
    }, [api, sessionId, scope, windowState.epoch])
    useEffect(() => {
        scope.active = enabled
        const generation = ++scope.generation
        scope.loading = false
        if (enabled) void refresh(false, generation)
        return () => {
            scope.active = false
            scope.generation++
            if (scope.timer) clearTimeout(scope.timer)
            scope.timer = null
        }
    }, [enabled, scope, refresh])
    const loadMore = useCallback(() => refresh(scope.error ? scope.retryOlder : Boolean(scope.cursor), scope.generation), [refresh, scope])
    const items = new Map(scope.items)
    const positions = new Map(scope.positions)
    if (!scope.denied && !scope.stale && itemsEpoch === windowState.epoch) {
        // Failed local user messages are visible even without an invokedAt value.
        for (const item of currentItems) items.set(item.id, item)
        for (const row of windowState.messages) {
            if (row.seq !== null) positions.set(`user-text:${row.id}`, { at: row.invokedAt ?? row.createdAt, seq: row.seq })
        }
    }
    return { items: [...items.values()].sort((a, b) => {
            const first = positions.get(a.targetMessageId), second = positions.get(b.targetMessageId)
            return (first?.at ?? a.createdAt) - (second?.at ?? b.createdAt)
                || (first && second ? first.seq - second.seq : 0)
        }),
        positions,
        readingNotice: windowState.readingNotice,
        readerMode: windowState.viewMode,
        readerHasMoreAfter: windowState.hasMoreAfter,
        hasMore: !scope.denied && (scope.hasMore || Boolean(scope.error)),
        isLoading: scope.loading || scope.indexing,
        isIndexing: scope.indexing, partial: scope.partial,
        error: scope.error, loadMore }
}
