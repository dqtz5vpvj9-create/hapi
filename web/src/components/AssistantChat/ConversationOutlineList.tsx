import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'
import type { ConversationOutlineItem } from '@/chat/outline'
import { formatMessageTimestampTitle, formatOutlineTimestamp } from '@/chat/presentation'

const ROW_HEIGHT = 72

export function ConversationOutlineList({ items, query, onSelect, locale, onMissingFocus }: {
    items: readonly ConversationOutlineItem[]
    query: string
    onSelect: (item: ConversationOutlineItem) => void
    onMissingFocus: () => void
    locale: Parameters<typeof formatOutlineTimestamp>[1]
}) {
    const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
    const [focusedId, setFocusedId] = useState<string | null>(null)
    const [pendingFocus, setPendingFocus] = useState<string | null>(null)
    const priorFirst = useRef(items[0]?.id)
    const ownsFocus = useRef(false)
    const virtual = items.length > 40
    const focusedIndex = items.findIndex(item => item.id === focusedId)
    const getItemKey = useCallback((index: number) => items[index].id, [items])
    const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [...new Set([...defaultRangeExtractor(range), ...(focusedIndex >= 0 ? [focusedIndex] : [])])].sort((a, b) => a - b),
    [focusedIndex])
    const list = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
        count: virtual ? items.length : 0,
        getScrollElement: () => viewport,
        getItemKey,
        estimateSize: () => ROW_HEIGHT,
        overscan: 4,
        rangeExtractor,
    })

    useLayoutEffect(() => {
        const previous = priorFirst.current
        const first = items[0]?.id
        // Loading earlier explicitly reveals the newly loaded first entries.
        if (first !== previous && previous && items.some(item => item.id === previous)) {
            if (viewport) viewport.scrollTop = 0
        }
        priorFirst.current = first
        if (focusedId && focusedIndex < 0) {
            setFocusedId(null)
            setPendingFocus(null)
            if (ownsFocus.current && document.activeElement === document.body) onMissingFocus()
            ownsFocus.current = false
        }
    }, [items, viewport, focusedId, focusedIndex, onMissingFocus])
    useLayoutEffect(() => () => {
        if (viewport?.contains(document.activeElement)) onMissingFocus()
    }, [viewport, onMissingFocus])

    useLayoutEffect(() => {
        if (viewport) viewport.scrollTop = 0
        setFocusedId(null)
        setPendingFocus(null)
    }, [query, viewport])
    useLayoutEffect(() => {
        if (!pendingFocus || !viewport) return
        const button = Array.from(viewport.querySelectorAll<HTMLButtonElement>('[data-outline-id]'))
            .find(element => element.dataset.outlineId === pendingFocus)
        if (button) {
            button.focus({ preventScroll: true })
            setPendingFocus(null)
        }
    })

    function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        const step = Math.max(1, Math.floor((viewport?.clientHeight ?? ROW_HEIGHT) / ROW_HEIGHT))
        const target = event.key === 'ArrowDown' ? index + 1
            : event.key === 'ArrowUp' ? index - 1
            : event.key === 'Home' ? 0
            : event.key === 'End' ? items.length - 1
            : event.key === 'PageDown' ? index + step
            : event.key === 'PageUp' ? index - step : null
        if (target === null) return
        event.preventDefault()
        const next = Math.max(0, Math.min(items.length - 1, target))
        setFocusedId(items[next].id)
        setPendingFocus(items[next].id)
        if (virtual) list.scrollToIndex(next, { align: 'auto' })
        else viewport?.querySelectorAll<HTMLButtonElement>('[data-outline-id]')[next]?.scrollIntoView({ block: 'nearest' })
    }

    function row(item: ConversationOutlineItem, index: number, start?: number) {
        const createdAt = new Date(item.createdAt)
        return (
            <button key={item.id} type="button" data-outline-id={item.id}
                onClick={() => onSelect(item)} onFocus={() => setFocusedId(item.id)} onKeyDown={event => navigate(event, index)}
                className={`group block w-full min-w-0 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${virtual ? 'absolute left-0 top-0' : ''}`}
                style={{ height: ROW_HEIGHT, ...(start === undefined ? {} : { transform: `translateY(${start}px)` }) }}>
                <span className="flex min-w-0 items-center gap-2 text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--app-button)]" aria-hidden="true" />
                    <time dateTime={createdAt.toISOString()} title={formatMessageTimestampTitle(createdAt)} className="truncate">
                        {formatOutlineTimestamp(createdAt, locale)}
                    </time>
                </span>
                <span className="mt-0.5 line-clamp-2 pl-4 text-sm leading-snug text-[var(--app-fg)]">{item.label}</span>
            </button>
        )
    }

    return (
        <div ref={setViewport} className="app-scroll-y min-h-0 flex-1 p-2" data-outline-count={items.length}
            onFocusCapture={() => { ownsFocus.current = true }}
            onBlurCapture={event => { ownsFocus.current = event.relatedTarget instanceof Node && Boolean(viewport?.contains(event.relatedTarget)) }}>
            <div className="relative" style={virtual ? { height: list.getTotalSize() } : undefined}>
                {virtual ? list.getVirtualItems().map(item => row(items[item.index], item.index, item.start))
                    : items.map((item, index) => row(item, index))}
            </div>
        </div>
    )
}
