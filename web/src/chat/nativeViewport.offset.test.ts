import { afterEach, describe, expect, it, vi } from 'vitest'
import { Virtualizer } from '@tanstack/react-virtual'
import { NativeChatViewport } from './nativeViewport'
import type { NativeChatProjection } from './nativeProjection'
import { createProgrammaticScrollObserver } from '@/components/AssistantChat/programmaticScrollOffset'
import { registerCodeReadingSource, type ReadingRestoreOptions } from '@/lib/reading-anchor'
import type { ChatScrollPosition } from './dsh/types'
import { ScrollFollow } from './dsh/use-scroll-follow'

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); document.body.replaceChildren() })
function fixture(documentTop = 600, physicalFloor = 900) {
    const element = document.createElement('div')
    element.dataset.conversationScroll = 'true'
    const column = document.createElement('div')
    const row = document.createElement('div')
    row.id = 'actual-answer'; row.dataset.chatAnchorKey = 'answer'; row.dataset.chatNodeKey = 'answer'
    element.append(column); column.append(row); document.body.append(element)
    let top = 0
    const writes = vi.fn((value: number) => { top = Math.max(0, Math.min(physicalFloor, value)) })
    Object.defineProperties(element, {
        scrollTop: { get: () => top, set: writes },
        clientHeight: { value: 100 }, scrollHeight: { value: 1000 },
    })
    element.getBoundingClientRect = () => new DOMRect(0, 0, 800, 100)
    column.getBoundingClientRect = () => new DOMRect(0, -top, 800, 1000)
    row.getBoundingClientRect = () => new DOMRect(0, documentTop - top, 800, 80)
    const projection = { ownerOf: (id: string) => id, get: () => undefined, reveal: () => false } as unknown as NativeChatProjection
    const viewport = new NativeChatViewport(projection)
    viewport.attach(element, column)
    const bridge = createProgrammaticScrollObserver(
        (_instance, callback) => { nativeOffset = callback; callback(0, false); return () => {} },
        (_instance, callback) => { callback({ width: 800, height: 100 }); return () => {} },
    )
    let nativeOffset!: (offset: number, scrolling: boolean) => void
    const observed = vi.fn()
    const core = new Virtualizer<HTMLDivElement, HTMLDivElement>({
        count: 100, estimateSize: () => 100, getScrollElement: () => element,
        observeElementOffset: (instance, callback) => bridge.observeOffset(instance, (offset, moving) => { observed(offset, moving); callback(offset, moving) }),
        observeElementRect: bridge.observeRect, scrollToFn: vi.fn(),
    })
    const releaseCore = core._didMount(); core._willUpdate(); core.getVirtualItems()
    const notify = vi.fn((offset: number) => bridge.observeLanding(offset))
    const navigation = { contains: () => true, reveal: () => true, pinReading: vi.fn(), releaseDestination: vi.fn(),
        isLayoutReady: () => true, observeProgrammaticScroll: notify }
    viewport.navigation = navigation
    disposers.push(() => { viewport.detach(); releaseCore() })
    return { element, row, viewport, core, notify, navigation, nativeOffset, writes, observed }
}

describe('current-main actual landing reaches the virtual observer synchronously', () => {
    it('publishes clamped turn navigation before the next real scroll and preserves direction', () => {
        const value = fixture(1200, 880)
        value.viewport.updateTurns([{ turn: 1, anchorKey: 'answer' }])
        const landing = value.viewport.scrollToTurn(1)!
        expect(landing.metrics.top).toBe(880)
        expect(landing.position?.anchorKey).toBe('answer')
        expect(landing.position?.anchorTop).toBe(320)
        expect.soft(value.core.scrollOffset).toBe(880)
        expect.soft(value.notify).toHaveBeenLastCalledWith(880)
        expect(value.writes).toHaveBeenCalledExactlyOnceWith(900)
        value.element.scrollTop = 850; value.nativeOffset(850, true)
        expect.soft(value.core.scrollDirection).toBe('backward')
    })
    it('publishes successful semantic restore while retaining the exact bookmark', () => {
        const value = fixture()
        const position: ChatScrollPosition = { anchorKey: 'answer', anchorTop: 24, scrollTop: 0,
            reading: { id: 'actual-answer', topOffset: 24, disclosure: true } }
        const landing = value.viewport.restore(position)!
        expect(landing.metrics.top).toBe(576)
        expect(landing.position).toBe(position)
        expect.soft(value.core.scrollOffset).toBe(576)
        expect.soft(value.notify).toHaveBeenLastCalledWith(576)
        expect(value.viewport.restore(position)?.position).toBe(position)
        expect(value.writes).toHaveBeenCalledExactlyOnceWith(576)
        expect(value.observed.mock.calls).toEqual([[0, false], [576, false]])
    })
    it('publishes each actual asynchronous code landing without waiting for another DOM event', () => {
        const value = fixture()
        const code = document.createElement('div'); code.dataset.hapiLargeCode = 'true'; value.row.append(code)
        let options!: ReadingRestoreOptions
        disposers.push(registerCodeReadingSource(code, { positionAt: () => null, restore: (_element, _anchor, value) => { options = value } }))
        const position: ChatScrollPosition = { anchorKey: 'answer', anchorTop: 24, scrollTop: 0,
            reading: { id: 'actual-answer', topOffset: 24,
                code: { source: 0, position: 42, quote: 'retained code', quoteStart: 42, topOffset: 24 } } }
        expect(value.viewport.restore(position)).toBeNull()
        expect(options.isCurrent()).toBe(true)
        value.element.scrollTop = 470; options.onScroll()
        expect.soft(value.core.scrollOffset).toBe(470)
        expect.soft(value.notify).toHaveBeenLastCalledWith(470)
        options.onRestored(true)
        expect(value.viewport.restore(position)?.position).toBe(position)
        expect(value.writes).toHaveBeenCalledExactlyOnceWith(470)
        const count = value.notify.mock.calls.length
        value.viewport.detach()
        expect(options.isCurrent()).toBe(false)
        options.onScroll(); options.onRestored(true)
        expect(value.notify).toHaveBeenCalledTimes(count)
    })

    it('publishes instant bottom navigation using its actual clamped result', () => {
        const value = fixture(600, 880)
        expect(value.viewport.scrollToBottom(new ScrollFollow(true, 24))?.metrics.top).toBe(880)
        expect(value.core.scrollOffset).toBe(880)
        expect(value.writes).toHaveBeenCalledExactlyOnceWith(900)
    })

    it('does not notify when detached or when a requested semantic anchor is absent', () => {
        const value = fixture()
        value.row.remove()
        expect(value.viewport.restore({ anchorKey: 'missing', anchorTop: 24, scrollTop: 500 })).toBeNull()
        value.viewport.detach()
        expect(value.viewport.scrollToBottom(new ScrollFollow(true, 24))).toBeNull()
        expect(value.notify).not.toHaveBeenCalled()
        expect(value.writes).not.toHaveBeenCalled()
    })

    it('ignores a superseded code task while allowing the replacement to publish', () => {
        const value = fixture()
        const code = document.createElement('div'); code.dataset.hapiLargeCode = 'true'; value.row.append(code)
        const tasks: ReadingRestoreOptions[] = []
        disposers.push(registerCodeReadingSource(code, { positionAt: () => null, restore: (_element, _anchor, options) => { tasks.push(options) } }))
        const position = (at: number): ChatScrollPosition => ({ anchorKey: 'answer', anchorTop: 24, scrollTop: 0,
            reading: { id: 'actual-answer', topOffset: 24,
                code: { source: 0, position: at, quote: 'retained code', quoteStart: at, topOffset: 24 } } })
        value.viewport.restore(position(42)); value.viewport.restore(position(84))
        expect(tasks[0].isCurrent()).toBe(false)
        expect(tasks[1].isCurrent()).toBe(true)
        value.element.scrollTop = 320
        tasks[0].onScroll(); tasks[0].onRestored(true)
        expect(value.notify).not.toHaveBeenCalled()
        tasks[1].onScroll()
        expect(value.core.scrollOffset).toBe(320)
        expect(value.notify).toHaveBeenCalledExactlyOnceWith(320)
    })
})
