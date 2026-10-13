import { createContext, Fragment, memo, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { defaultRangeExtractor, observeElementOffset, observeElementRect, useVirtualizer } from '@tanstack/react-virtual'
import { useTranslation } from '@/lib/use-translation'
import { createProgrammaticScrollObserver } from './AssistantChat/programmaticScrollOffset'
import { SessionListViewRestoration } from './sessionListViewBookmark'


// Stable observers retain useful geometry while a split pane is hidden. A
// revealed/restored scroller can change offset without dispatching scroll.
const observeRecentRect: typeof observeElementRect<HTMLDivElement> = (instance, callback) => (
    observeElementRect(instance, rect => { if (rect.height > 0) callback(rect) })
)
export const observeRecentOffset: typeof observeElementOffset<HTMLDivElement> = (instance, callback) => {
    const element = instance.scrollElement
    if (!element) return
    let active = true
    const observeActual = () => {
        if (!active) return
        if (element.scrollTop !== instance.scrollOffset) callback(element.scrollTop, false)
    }
    observeActual()
    const stop = observeElementOffset(instance, callback)
    const ResizeObserverClass = element.ownerDocument.defaultView?.ResizeObserver
    const observer = ResizeObserverClass ? new ResizeObserverClass(observeActual) : null
    observer?.observe(element)
    return () => { active = false; stop?.(); observer?.disconnect() }
}

const RetainRecentRow = createContext<((id: string, active: boolean) => void) | null>(null)

/** Portalled menus/dialogs must keep their owning row alive outside the window. */
export function useRecentRowRetention(id: string, active: boolean) {
    const retain = useContext(RetainRecentRow)
    useEffect(() => {
        if (!retain || !active) return
        retain(id, true)
        return () => retain(id, false)
    }, [retain, id, active])
}

function RetainedRoot({ id, retain, children }: {
    id: string
    retain: (root: string, id: string, active: boolean) => void
    children: ReactNode
}) {
    const onRetain = useCallback((item: string, active: boolean) => retain(id, item, active), [id, retain])
    return <RetainRecentRow.Provider value={onRetain}>{children}</RetainRecentRow.Provider>
}

// Virtualizer range updates must not rerender unchanged session subtrees.
// Keep callback identity in the default shallow comparison: parent updates can
// change selection, hierarchy, or status options without changing the session.
const RecentRowContent = memo(function RecentRowContent<T extends { id: string }>({ session, renderSession }: {
    session: T
    renderSession: (session: T) => ReactNode
}) {
    return renderSession(session)
}) as <T extends { id: string }>(props: { session: T; renderSession: (session: T) => ReactNode }) => ReactNode

function DateHeading({ time, previousTime }: { time: number; previousTime?: number }) {
    const { t } = useTranslation()
    const locale = document.documentElement.lang || undefined
    const todayKey = new Date().toDateString()
    const label = useMemo(() => {
        const date = new Date(time)
        if (previousTime !== undefined && new Date(previousTime).toDateString() === date.toDateString()) return null
        const today = new Date(todayKey)
        const yesterday = new Date(today)
        yesterday.setDate(today.getDate() - 1)
        return date.toDateString() === todayKey ? t('sessions.task.today')
            : date.toDateString() === yesterday.toDateString() ? t('sessions.task.yesterday')
            : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
    }, [time, previousTime, todayKey, locale, t])
    // Each virtual block has its own parent, so CSS :first-child would also
    // shorten later days. Preserve the original 18px inter-day spacing.
    return label ? <div className="app-session-date-heading" style={previousTime === undefined ? undefined : { paddingTop: 18 }}>{label}</div> : null
}

/** Recent-only window. The existing SessionListScrollAnchor owns compensation;
 * this component observes scrolling and never writes scrollTop. The caller
 * supplies already projected tree rows; scroll updates do not walk the tree. */
export type RecentScrollObserver = { observeScroll: (offset: number) => void }

export function RecentSessionList<T extends { id: string }>({ sessions, scrollElement, scrollObserverRef, selectedRootId, narrow, timeFor, renderSession, gap = 2, estimateRowSize, fillEdgeWindow = false }: {
    sessions: readonly T[]
    scrollElement: HTMLDivElement | null
    scrollObserverRef?: Ref<RecentScrollObserver>
    selectedRootId?: string | null
    narrow: boolean
    gap?: number
    fillEdgeWindow?: boolean
    estimateRowSize?: (session: T, index: number, base: number) => number
    timeFor: (session: T) => number
    renderSession: (session: T) => ReactNode
}) {
    const listRef = useRef<HTMLDivElement>(null)
    const restoration = useContext(SessionListViewRestoration)
    const [scrollObserver] = useState(() => createProgrammaticScrollObserver(observeRecentOffset, observeRecentRect))
    useImperativeHandle(scrollObserverRef, () => ({ observeScroll: scrollObserver.observeLanding }), [scrollObserver])
    const [focusedId, setFocusedId] = useState<string | null>(null)
    const [pressedId, setPressedId] = useState<string | null>(null)
    const [draggedId, setDraggedId] = useState<string | null>(null)
    const [retained, setRetained] = useState<Map<string, string>>(() => new Map())
    const [scrollMargin, setScrollMargin] = useState(0)
    const indexes = useMemo(() => new Map(sessions.map((session, index) => [session.id, index])), [sessions])
    const retain = useCallback((root: string, id: string, active: boolean) => {
        setRetained(previous => {
            if (active ? previous.get(id) === root : !previous.has(id)) return previous
            const next = new Map(previous)
            if (active) next.set(id, root)
            else next.delete(id)
            return next
        })
    }, [])
    const pins = [...new Set([selectedRootId, focusedId, pressedId, draggedId, ...retained.values(),
        ...(restoration?.bookmark.anchors.map(anchor => anchor.rootId) ?? [])])]
        .flatMap(id => id && indexes.has(id) ? [indexes.get(id)!] : [])
    const pinKey = pins.join(',')
    const previousRange = useRef<number[]>([])
    const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) => {
        // At either end, reuse the otherwise clipped backward/forward budget.
        // This avoids incrementally mounting a small expanded tree during the
        // predicted first second of scrolling, without increasing the budget.
        const count = Math.min(range.count, range.endIndex - range.startIndex + 1 + range.overscan * 2)
        const start = Math.max(0, Math.min(range.startIndex - range.overscan, range.count - count))
        const window = fillEdgeWindow ? Array.from({ length: count }, (_, index) => start + index) : defaultRangeExtractor(range)
        const next = [...new Set([...window, ...pins])].sort((a, b) => a - b)
        const previous = previousRange.current
        if (next.length === previous.length && next.every((index, offset) => index === previous[offset])) return previous
        previousRange.current = next
        return next
    }, [pinKey, fillEdgeWindow]) // eslint-disable-line react-hooks/exhaustive-deps
    const estimate = narrow ? 72 : 34
    // Two screenfuls each way cover roughly one second at two screens/second.
    // No cap based on the total number of sessions, and no per-scroll projection.
    const viewportHeight = scrollElement?.clientHeight || 680
    const overscan = Math.ceil(viewportHeight * 2 / estimate)
    const getItemKey = useCallback((index: number) => sessions[index].id, [sessions])
    const virtualizer = useVirtualizer({
        count: sessions.length,
        getScrollElement: () => scrollElement,
        getItemKey,
        estimateSize: index => estimateRowSize?.(sessions[index], index, estimate) ?? estimate,
        initialRect: { width: 320, height: 680 },
        // Hidden split panes have no useful geometry; keep the last viewport
        // until they become visible instead of dropping every mounted row.
        observeElementRect: scrollObserver.observeRect,
        observeElementOffset: scrollObserver.observeOffset,
        overscan,
        gap,
        scrollMargin,
        rangeExtractor,
        anchorTo: 'start',
        followOnAppend: false,
        scrollToFn: () => {}, // Native input and SessionListScrollAnchor are the only scroll writers.
        measureElement: (element, entry, instance) => {
            if (element.getClientRects().length === 0) {
                const index = instance.indexFromElement(element)
                return instance.itemSizeCache.get(instance.options.getItemKey(index)) ?? instance.options.estimateSize(index)
            }
            return entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height
        },
    })
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
    const measureMargin = useCallback(() => {
        const viewport = scrollElement, list = listRef.current
        if (!viewport || !list || list.getClientRects().length === 0) return
        const margin = list.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
        setScrollMargin(previous => Math.abs(margin - previous) > 0.5 ? margin : previous)
    }, [scrollElement])
    // The parent passes a new renderer on its layout/content commits. Scroll
    // range updates are local to this component and cannot move the list origin.
    useLayoutEffect(measureMargin, [measureMargin, sessions, narrow, renderSession, timeFor])
    useLayoutEffect(() => {
        const ResizeObserverClass = scrollElement?.ownerDocument.defaultView?.ResizeObserver
        if (!scrollElement || !ResizeObserverClass) return
        let active = true
        const observer = new ResizeObserverClass(() => { if (active) measureMargin() })
        // Header resizing and pane reveal can change layout without a parent
        // commit. Row/list height changes remain the virtualizer's concern.
        observer.observe(scrollElement)
        return () => { active = false; observer.disconnect() }
    }, [scrollElement, measureMargin])
    useEffect(() => {
        if (!pressedId) return
        const release = () => setPressedId(null)
        window.addEventListener('pointerup', release)
        window.addEventListener('pointercancel', release)
        window.addEventListener('dragend', release)
        return () => {
            window.removeEventListener('pointerup', release)
            window.removeEventListener('pointercancel', release)
            window.removeEventListener('dragend', release)
        }
    }, [pressedId])
    const rootId = (target: EventTarget | null) => target instanceof Element
        ? target.closest<HTMLElement>('[data-recent-root]')?.dataset.recentRoot ?? null : null
    const rows = virtualizer.getVirtualItems()
    useLayoutEffect(() => {
        if (!restoration) return
        // Ref measurements can update the virtualizer before React commits
        // its next window. Only the owner may align a fully committed layout.
        const measured = virtualizer.getVirtualItems()
        const stable = listRef.current?.getClientRects().length !== 0 && (rows === measured || rows.length === measured.length && rows.every((row, index) => {
            const next = measured[index]
            return row.key === next.key && row.start === next.start && row.size === next.size
        }))
        restoration.onLayout(stable)
    })
    // Scrolling inside a retained edge window changes offsets, not its rows.
    // Reuse their elements too, so those events do not reconcile every wrapper.
    const renderedRows = useMemo(() => rows.map((row, index) => {
        const previous = rows[index - 1]
        const space = previous ? previous.index + 1 === row.index ? gap : row.start - previous.end : row.start - scrollMargin
        const session = sessions[row.index]
        return <Fragment key={row.key}>
            <div aria-hidden="true" data-recent-spacer style={{ height: Math.max(0, space), overflowAnchor: 'none' }} />
            <div data-index={row.index} data-recent-root={session.id} ref={virtualizer.measureElement} className="flow-root w-full">
                <RetainedRoot id={session.id} retain={retain}>
                    {narrow ? <DateHeading time={timeFor(session)} previousTime={row.index > 0 ? timeFor(sessions[row.index - 1]) : undefined} /> : null}
                    <RecentRowContent session={session} renderSession={renderSession} />
                </RetainedRoot>
            </div>
        </Fragment>
    }), [rows, sessions, gap, scrollMargin, narrow, timeFor, renderSession, retain, virtualizer])
    return <div ref={listRef} data-testid="recent-session-list" data-recent-total={sessions.length}
        style={{ height: virtualizer.getTotalSize() }}
        onFocusCapture={event => setFocusedId(rootId(event.target))}
        onBlurCapture={event => setFocusedId(rootId(event.relatedTarget))}
        onPointerDownCapture={event => setPressedId(rootId(event.target))}
        onDragStartCapture={event => setDraggedId(rootId(event.target))}
        onDragEndCapture={() => setDraggedId(null)}>
        {renderedRows}
    </div>
}
