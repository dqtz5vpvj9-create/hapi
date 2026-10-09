import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import type { ApiClient } from '@/api/client'
import { getHistoryPreloadRequest, subscribeMessageWindow } from '@/lib/message-window-store'
import { getHistoryPageRepository } from '@/lib/history-page-repository'

type Direction = 'before' | 'after'
const PRELOAD_INPUT_WINDOW_MS = 1000

/** Keep one adjacent page ready. Warm-up never publishes into the reader or
 * walks beyond its current window, so idle sessions cannot scan history. */
export function useHistoryPreload(api: ApiClient, sessionId: string, viewportRef: RefObject<HTMLDivElement | null>, warmInitial = false) {
    const owner = useRef({ api, sessionId })
    const state = useRef({ direction: null as Direction | null, inputAt: 0, velocity: 0,
        scrollTop: 0, pointerActive: false, pointerUntil: 0, frame: 0, attempted: '', pending: null as object | null })
    useLayoutEffect(() => {
        owner.current = { api, sessionId }
        state.current = { direction: null, inputAt: 0, velocity: 0, scrollTop: viewportRef.current?.scrollTop ?? 0,
            pointerActive: false, pointerUntil: 0, frame: 0, attempted: '', pending: null }
        return () => {
            if (state.current.frame) cancelAnimationFrame(state.current.frame)
            state.current.direction = null
        }
    }, [api, sessionId, viewportRef])

    const check = useCallback((): void => {
        const intent = state.current
        const { api, sessionId } = owner.current
        intent.frame = 0
        const viewport = viewportRef.current
        if (!viewport || !intent.direction || performance.now() - intent.inputAt > PRELOAD_INPUT_WINDOW_MS || intent.pending) return
        // Fast movement gets more lead distance, bounded by the loaded window.
        const lead = Math.max(viewport.clientHeight * 3, Math.min(viewport.scrollHeight * 0.75, intent.velocity * 800))
        if (intent.direction === 'before' ? viewport.scrollTop > lead
            : viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > lead) return
        const request = getHistoryPreloadRequest(sessionId, intent.direction)
        if (!request) return
        const key = JSON.stringify(request)
        if (intent.attempted === key) return
        intent.attempted = key
        const repository = getHistoryPageRepository(api)
        if (repository.getCached(sessionId, request)) return
        const pending = {}
        intent.pending = pending
        // The foreground loader owns errors/retries. A failed warm-up neither
        // changes reader state nor loops while the same boundary is approached.
        void repository.read(sessionId, request).catch(() => {}).finally(() => {
            if (state.current === intent && intent.pending === pending) {
                intent.pending = null
                // The reader may have consumed this page while its request was
                // pending. Re-evaluate the new boundary without requiring an
                // additional wheel/touch event.
                if (!intent.frame) intent.frame = requestAnimationFrame(check)
            }
        })
    }, [viewportRef])
    const schedule = useCallback(() => {
        if (!state.current.frame) state.current.frame = requestAnimationFrame(check)
    }, [check])
    useLayoutEffect(() => {
        let initial = warmInitial
        const changed = () => {
            if (initial) {
                const request = getHistoryPreloadRequest(sessionId, 'before')
                if (!request) return
                initial = false
                // The first reading window can be only one viewport tall.
                // Waiting for input leaves no runway for its first page.
                void getHistoryPageRepository(api).read(sessionId, request).catch(() => {})
            } else {
                schedule()
            }
        }
        changed()
        return subscribeMessageWindow(sessionId, changed)
    }, [api, sessionId, schedule, warmInitial])
    const input = useCallback((direction: Direction, distance = 0) => {
        const intent = state.current, now = performance.now()
        const elapsed = intent.direction === direction && now - intent.inputAt < 250 ? Math.max(16, now - intent.inputAt) : 100
        intent.velocity = Math.abs(distance) / elapsed
        intent.direction = direction
        intent.inputAt = now
        intent.scrollTop = viewportRef.current?.scrollTop ?? 0
        schedule()
    }, [schedule, viewportRef])
    const pointer = useCallback((active: boolean) => {
        // A global pointerup outside the reader is not a reader gesture.
        if (!active && !state.current.pointerActive) return
        state.current.pointerActive = active
        state.current.pointerUntil = active ? 0 : performance.now() + 750
        state.current.scrollTop = viewportRef.current?.scrollTop ?? 0
    }, [viewportRef])
    const scroll = useCallback((restoring = false) => {
        const intent = state.current, top = viewportRef.current?.scrollTop ?? 0
        const delta = top - intent.scrollTop
        intent.scrollTop = top
        if (restoring) return
        if (delta !== 0 && (intent.pointerActive || performance.now() < intent.pointerUntil)) {
            input(delta < 0 ? 'before' : 'after', delta)
            return
        }
        if (performance.now() - intent.inputAt > PRELOAD_INPUT_WINDOW_MS || !intent.direction) return
        if ((intent.direction === 'before' && delta < 0) || (intent.direction === 'after' && delta > 0)) {
            // Inertial scrolling remains part of the reader's gesture. The
            // timeout applies after movement stops, not after finger release.
            intent.inputAt = performance.now()
            schedule()
        }
    }, [input, schedule, viewportRef])
    return { input, scroll, pointer }
}
