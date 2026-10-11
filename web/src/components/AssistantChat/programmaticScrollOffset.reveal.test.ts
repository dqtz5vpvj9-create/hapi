import { describe, expect, it, vi } from 'vitest'
import { Virtualizer, type Rect, type VirtualizerOptions } from '@tanstack/react-virtual'
import { createProgrammaticScrollObserver } from './programmaticScrollOffset'

type OffsetObserver = VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementOffset']
type RectObserver = VirtualizerOptions<HTMLDivElement, HTMLDivElement>['observeElementRect']

function fixture() {
    const element = document.createElement('div')
    let top = 19_000
    const writes = vi.fn((value: number) => { top = value })
    Object.defineProperty(element, 'scrollTop', { get: () => top, set: writes })
    let offset!: Parameters<OffsetObserver>[1]
    let rect!: Parameters<RectObserver>[1]
    const deliveries: string[] = []
    const observeOffset: OffsetObserver = (_instance, callback) => { offset = callback; callback(top, false); return () => {} }
    const observeRect: RectObserver = (_instance, callback) => { rect = callback; callback({ width: 800, height: 400 }); return () => {} }
    const bridge = createProgrammaticScrollObserver(observeOffset, observeRect)
    const core = new Virtualizer<HTMLDivElement, HTMLDivElement>({
        count: 300, getScrollElement: () => element, estimateSize: () => 100,
        scrollToFn: vi.fn(),
        observeElementOffset: (instance, callback) => bridge.observeOffset(instance, (value, moving) => {
            deliveries.push(`offset:${value}:${moving}`); callback(value, moving)
        }),
        observeElementRect: (instance, callback) => bridge.observeRect(instance, value => {
            deliveries.push(`rect:${value.height}`); callback(value)
        }),
    })
    const dispose = core._didMount()
    core._willUpdate()
    core.getVirtualItems()
    return { core, bridge, writes, deliveries, dispose,
        setDOMTop(value: number) { top = value },
        offset(value: number, scrolling: boolean) { offset(value, scrolling) },
        rect(value: Rect) { rect(value) },
    }
}

describe('revealed scrollport offset observation', () => {
    it.each([true, false])('resamples actual DOM top before exposing a positive viewport (hidden scroll event=%s)', hiddenScroll => {
        const view = fixture()
        expect(view.core.range?.startIndex).toBe(190)
        view.rect({ width: 0, height: 0 })
        view.setDOMTop(0)
        if (hiddenScroll) view.offset(0, false)
        // Browser restoration/clamping happens without a native scroll event.
        view.setDOMTop(18_000)
        view.deliveries.length = 0
        view.rect({ width: 800, height: 400 })
        view.core.getVirtualItems()
        expect(view.deliveries).toEqual(['offset:18000:false', 'rect:400'])
        expect(view.core.scrollOffset).toBe(18_000)
        expect(view.core.range?.startIndex).toBe(180)
        expect(view.writes).not.toHaveBeenCalled()
        view.setDOMTop(17_900); view.offset(17_900, true)
        expect(view.core.scrollDirection).toBe('backward')
        expect(view.core.isScrolling).toBe(true)
        view.dispose()
    })

    it('deduplicates equal landings and leaves initial/ordinary positive resize attribution alone', () => {
        const view = fixture()
        view.offset(19_000, true)
        view.deliveries.length = 0
        view.setDOMTop(19_100)
        view.rect({ width: 900, height: 500 })
        expect(view.deliveries).toEqual(['rect:500'])
        expect(view.core.isScrolling).toBe(true)
        expect(view.core.scrollOffset).toBe(19_000)
        view.setDOMTop(19_000)
        view.rect({ width: 0, height: 0 })
        view.rect({ width: 0, height: 0 })
        view.deliveries.length = 0
        view.rect({ width: 800, height: 400 })
        expect(view.deliveries).toEqual(['rect:400'])
        expect(view.core.isScrolling).toBe(true)
        expect(view.writes).not.toHaveBeenCalled()
        view.dispose()
    })

    it('does not treat the first positive size as a reveal', () => {
        let rect!: Parameters<RectObserver>[1]
        const offset = vi.fn()
        const bridge = createProgrammaticScrollObserver(
            (_instance, callback) => { callback(0, true); return () => {} },
            (_instance, callback) => { rect = callback; return () => {} },
        )
        const instance = { scrollElement: { scrollTop: 900 } } as Parameters<OffsetObserver>[0]
        bridge.observeOffset(instance, offset)
        bridge.observeRect(instance, vi.fn())
        rect({ width: 800, height: 400 })
        expect(offset).toHaveBeenCalledExactlyOnceWith(0, true)
    })

    it('ignores old rectangle delivery and cleanup after reattachment', () => {
        const offsets: Parameters<OffsetObserver>[1][] = []
        const rectangles: Parameters<RectObserver>[1][] = []
        const bridge = createProgrammaticScrollObserver(
            (_instance, callback) => { offsets.push(callback); return () => {} },
            (_instance, callback) => { rectangles.push(callback); return () => {} },
        )
        const instance = (top: number) => ({ scrollElement: { scrollTop: top } }) as Parameters<OffsetObserver>[0]
        const first = instance(100), second = instance(900)
        const firstOffset = vi.fn(), secondOffset = vi.fn(), firstRect = vi.fn(), secondRect = vi.fn()
        const cleanupOffset = bridge.observeOffset(first, firstOffset)
        const cleanupRect = bridge.observeRect(first, firstRect)
        offsets[0](0, false); rectangles[0]({ width: 0, height: 0 })
        bridge.observeOffset(second, secondOffset); bridge.observeRect(second, secondRect)
        offsets[1](0, false); rectangles[1]({ width: 0, height: 0 })
        cleanupOffset?.(); cleanupRect?.()
        rectangles[0]({ width: 800, height: 400 })
        expect(firstRect).toHaveBeenCalledTimes(1)
        rectangles[1]({ width: 800, height: 400 })
        expect(secondOffset).toHaveBeenLastCalledWith(900, false)
        expect(bridge.getOffset()).toBe(900)
    })
})
