import { Fragment, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type Ref } from 'react'
import { ThreadPrimitive, unstable_useThreadMessageIds, useAuiState, getExternalStoreMessages } from '@assistant-ui/react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'

export type MessageListNavigation = {
    /** Absence from the DOM is different from absence from loaded data. */
    reveal: (messageId: string) => boolean
    contains: (messageId: string) => boolean
    pinReading: (messageId: string | null) => void
    releaseDestination: () => void
}

type Props = {
    scrollElement: HTMLDivElement | null
    navigationRef?: Ref<MessageListNavigation>
    savedAnchorId?: string | null
    onLayout?: () => void
    components: ComponentProps<typeof ThreadPrimitive.Unstable_MessageById>['components']
}

/** Payload ownership remains with the reader. Only the visible range, overscan
 * and the two identities owned by reading/navigation stay mounted. */
export function VirtualMessageList({ scrollElement, navigationRef, savedAnchorId, onLayout, components }: Props) {
    const ids = unstable_useThreadMessageIds()
    const messages = useAuiState(state => state.thread.messages)
    const partOwners = useMemo(() => {
        const owners = new Map<string, string>()
        for (const message of messages) {
            for (const part of message.content) {
                for (const source of getExternalStoreMessages<{ id?: string }>(part)) {
                    if (source.id) owners.set(`hapi-reading-${source.id}`, message.id)
                }
            }
        }
        return owners
    }, [messages])
    const ownerOf = useCallback((id: string) => partOwners.get(id) ?? id, [partOwners])
    const listRef = useRef<HTMLDivElement | null>(null)
    const [readingId, setReadingId] = useState(savedAnchorId ?? null)
    const [destinationId, setDestinationId] = useState<string | null>(null)
    const [scrollMargin, setScrollMargin] = useState(0)
    const getItemKey = useCallback((index: number) => ids[index], [ids])
    const pinned = [readingId, destinationId].map(id => id ? ids.indexOf(ownerOf(id)) : -1).filter(index => index >= 0)
    const rangeExtractor = useCallback((range: Parameters<typeof defaultRangeExtractor>[0]) =>
        [...new Set([...defaultRangeExtractor(range), ...pinned])].sort((a, b) => a - b),
    // Indices move with a prepend even while the logical identities stay fixed.
    [pinned.join(',')])
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: ids.length,
        getScrollElement: () => scrollElement,
        getItemKey,
        estimateSize: () => 96,
        overscan: 6,
        gap: 12,
        // CSS normal flow retains fractional heights, so its measurement must too.
        measureElement: (element, entry, instance) => {
            // Terminal view keeps the chat mounted under display:none. There
            // is no row layout to measure there; retain its measured size.
            if (element.getClientRects().length === 0) {
                const index = instance.indexFromElement(element)
                const key = instance.options.getItemKey(index)
                return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index)
            }
            return entry?.borderBoxSize?.[0]?.blockSize
                ?? Number.parseFloat(getComputedStyle(element).height)
        },
        scrollMargin,
        rangeExtractor,
        // Character anchoring, tail following and navigation have one owner.
        // Native scroll position is observed here, never independently replayed.
        anchorTo: 'start',
        followOnAppend: false,
    })
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false

    useLayoutEffect(() => { setReadingId(savedAnchorId ?? null) }, [savedAnchorId])
    useLayoutEffect(() => {
        const viewport = scrollElement, list = listRef.current
        if (!viewport || !list || list.getClientRects().length === 0) return
        const margin = list.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
        if (Math.abs(margin - scrollMargin) > 0.5) setScrollMargin(margin)
    })

    useImperativeHandle(navigationRef, () => ({
        contains: (id) => ids.includes(ownerOf(id)),
        pinReading: setReadingId,
        releaseDestination: () => setDestinationId(null),
        reveal: (id) => {
            // Pin first, including while its context is still in flight. Native
            // navigation starts only after the controller sees the mounted row.
            setDestinationId(id)
            return ids.includes(ownerOf(id))
        },
    }), [ids, ownerOf])

    const rows = virtualizer.getVirtualItems()
    useLayoutEffect(() => {
        const list = listRef.current
        if (!list || list.getClientRects().length === 0) return
        // A retained row can change while native scrolling is active. Measure
        // the committed content, including when the core skips its ref read.
        for (const element of list.querySelectorAll<HTMLElement>('[data-hapi-virtual-message]')) {
            virtualizer.resizeItem(Number(element.dataset.index), Number.parseFloat(getComputedStyle(element).height))
        }
    })
    const geometry = rows.map(row => `${row.key}:${row.start}:${row.size}`).join('|')
    useLayoutEffect(() => { onLayout?.() }, [geometry, onLayout])

    return (
        <div ref={listRef} data-hapi-list-count={ids.length} data-hapi-viewport-size={virtualizer.scrollRect?.height ?? 0} data-hapi-scroll-attached={Boolean(virtualizer.scrollElement)} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {rows.map((row, index) => {
                const previous = rows[index - 1]
                // Keep every keyed row under the same parent when pins join or
                // leave the visible range. Spacers retain unmounted intervals;
                // consecutive rows are laid out immediately by the browser.
                const space = previous
                    ? previous.index + 1 === row.index ? 12 : row.start - previous.end
                    : row.start - scrollMargin
                return (
                    <Fragment key={row.key}>
                        <div aria-hidden="true" style={{ height: Math.max(0, space) }} />
                        <div
                            data-index={row.index}
                            data-hapi-virtual-message={ids[row.index]}
                            ref={virtualizer.measureElement}
                            className="flow-root w-full"
                        >
                            <ThreadPrimitive.Unstable_MessageById messageId={ids[row.index]} components={components} />
                        </div>
                    </Fragment>
                )
            })}
        </div>
    )
}
