import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps, PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: () => ({ machines: [] })
}))

vi.mock('@assistant-ui/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@assistant-ui/react')>()
    return {
        ...actual,
        useAuiState: (selector: (state: unknown) => unknown) => selector({
            thread: { extras: undefined, messages: [] }
        }),
        unstable_useThreadMessageIds: () => [],
        ThreadPrimitive: {
            ...actual.ThreadPrimitive,
            Root: ({ children, className }: PropsWithChildren<{ className?: string }>) => (
                <div className={className}>{children}</div>
            ),
            Viewport: ({ children }: PropsWithChildren) => children,
            Messages: () => null
        }
    }
})

import { HappyThread } from '@/components/AssistantChat/HappyThread'
import * as readingAnchors from '@/lib/reading-anchor'
import { getMessageReadingAnchor, setMessageViewMode } from '@/lib/message-window-store'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
let resizeCallbacks: Array<() => void> = []

class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
    }

    observe() {}

    unobserve() {}

    disconnect() {}
}

function renderThread(onViewModeChange = vi.fn(), unseenCount = 0, overrides: Partial<ComponentProps<typeof HappyThread>> = {}) {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    const renderHappyThread = (forceScrollToken: number) => (
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <HappyThread
                    api={{ getHubSettings: vi.fn().mockResolvedValue({ sessionSummaryContract: false, sessionSummaryInChat: false }) } as unknown as ApiClient}
                    session={{ metadata: {} } as Session}
                    sessionId="mobile-scroll-session"
                    metadata={null}
                    disabled={false}
                    onRefresh={vi.fn()}
                    onViewModeChange={onViewModeChange}
                    isSyncingTail={false}
                    messagesWarning={null}
                    hasMoreMessages={false}
                    isLoadingMoreMessages={false}
                    onLoadMore={vi.fn().mockResolvedValue({ status: 'exhausted' })}
                    onCancelLoadMore={vi.fn()}
                    unseenCount={unseenCount}
                    rawMessagesCount={1}
                    normalizedMessagesCount={1}
                    messagesVersion={1}
                    historyVersion={0}
                    forceScrollToken={forceScrollToken}
                    outlineOpen={false}
                    outlineItems={[]}
                    outlineEpoch={null}
                    onOutlineOpenChange={vi.fn()}
                    {...overrides}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
    const result = render(renderHappyThread(0))
    const viewport = result.container.querySelector<HTMLElement>('.chat-scroll-y')
    if (!viewport) {
        throw new Error('Chat viewport was not rendered')
    }
    Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 1_232 },
        clientHeight: { configurable: true, value: 530 },
        // JSDOM has no layout boxes; this harness represents a visible phone.
        getClientRects: { configurable: true, value: () => [new DOMRect(0, 0, 390, viewport.clientHeight)] }
    })
    act(() => {
        vi.advanceTimersByTime(0)
    })
    return {
        ...result,
        viewport,
        onViewModeChange,
        rerenderThread: (forceScrollToken: number) => result.rerender(renderHappyThread(forceScrollToken))
    }
}

beforeEach(() => {
    vi.useFakeTimers()
    resizeCallbacks = []
    Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        value: TestResizeObserver
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        configurable: true,
        writable: true,
        value(this: HTMLElement, options: ScrollToOptions | number, y?: number) {
            const requestedTop = typeof options === 'number' ? y ?? 0 : options.top ?? 0
            const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight)
            this.scrollTop = Math.min(Math.max(0, requestedTop), maxScrollTop)
        }
    })
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
    if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
    } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
    if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
    } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
    }
    if (originalResizeObserver) {
        Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver)
    } else {
        Reflect.deleteProperty(globalThis, 'ResizeObserver')
    }
})

function attachReadingRow(viewport: HTMLElement) {
    const row = document.createElement('div')
    row.id = 'hapi-message-reading-sample'
    row.textContent = 'The passage currently being read'
    viewport.querySelector('.happy-thread-messages')!.append(row)
    let contentTop = 800
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 390, 530))
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, contentTop - viewport.scrollTop, 390, 200))
    const sentinel = viewport.querySelector('.chat-scroll-content > [aria-hidden="true"]')!
    let coverage = false
    vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, coverage ? 0 : 2_000, 390, 1))
    return { row, setCoverage: (value: boolean) => { coverage = value }, prepend: () => { contentTop += 200 } }
}

describe('scroll reading samples', () => {
    it('shares the current passage within an event and saves a fresh bookmark on the next movement', () => {
        const id = 'event-reading-bookmark'
        const onViewModeChange = vi.fn(mode => setMessageViewMode(id, mode))
        const { viewport } = renderThread(onViewModeChange, 0, { sessionId: id })
        attachReadingRow(viewport)
        act(() => vi.advanceTimersByTime(2_000))
        const capture = vi.spyOn(readingAnchors, 'captureReadingAnchor')

        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        expect(capture).toHaveBeenCalledTimes(1)
        expect(getMessageReadingAnchor(id)?.topOffset).toBe(280)

        viewport.scrollTop = 480
        fireEvent.scroll(viewport)
        expect(capture).toHaveBeenCalledTimes(2)
        const persisted = JSON.parse(sessionStorage.getItem(`hapi:message-reader:v1:${id}`)!)
        expect(persisted.readingBookmark.topOffset).toBe(320)
        expect(persisted.viewMode).toBe('history')
    })

    it('shares pending-page sampling but captures again at publication before preserving the passage through prepend', async () => {
        const id = 'pending-reading-bookmark'
        let beforeApply!: (version: number) => boolean
        let finish!: (outcome: { kind: 'applied'; historyVersion: number; hasMore: boolean; addedRenderableCount: number }) => void
        const onLoadMore = vi.fn(callback => {
            beforeApply = callback
            return new Promise<{ kind: 'applied'; historyVersion: number; hasMore: boolean; addedRenderableCount: number }>(resolve => { finish = resolve })
        })
        const overrides = { sessionId: id, hasMoreMessages: true, onLoadMore, historyVersion: 0, messagesVersion: 1 }
        const { viewport, rerenderThread } = renderThread(vi.fn(mode => setMessageViewMode(id, mode)), 0, overrides)
        const reading = attachReadingRow(viewport)
        act(() => vi.advanceTimersByTime(2_000))
        reading.setCoverage(true)
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        const capture = vi.spyOn(readingAnchors, 'captureReadingAnchor')

        viewport.scrollTop = 480
        fireEvent.scroll(viewport)
        expect(capture).toHaveBeenCalledTimes(1)
        expect(getMessageReadingAnchor(id)?.topOffset).toBe(320)

        // Publication is a later callback with its own current DOM position.
        viewport.scrollTop = 460
        expect(beforeApply(1)).toBe(true)
        expect(capture).toHaveBeenCalledTimes(2)
        expect(capture.mock.results[1].value?.topOffset).toBe(340)
        reading.prepend()
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_432 })
        overrides.historyVersion = 1
        overrides.messagesVersion = 2
        await act(async () => {
            finish({ kind: 'applied', historyVersion: 1, hasMore: true, addedRenderableCount: 1 })
            await Promise.resolve()
            rerenderThread(0)
        })
        expect(viewport.scrollTop).toBe(660)
        expect(reading.row.getBoundingClientRect().top).toBe(340)
        fireEvent(window, new Event('pagehide'))
        expect(getMessageReadingAnchor(id)?.topOffset).toBe(340)
        const persisted = JSON.parse(sessionStorage.getItem(`hapi:message-reader:v1:${id}`)!)
        expect(persisted.readingBookmark.topOffset).toBe(340)
    })

    it('does not reuse a pre-load sample when a loading callback changes scroll synchronously', () => {
        const id = 'synchronous-loading-reading'
        let viewport!: HTMLElement
        const onLoadMore = vi.fn(() => {
            viewport.scrollTop = 400
            return new Promise<never>(() => {})
        })
        const rendered = renderThread(vi.fn(mode => setMessageViewMode(id, mode)), 0, { sessionId: id, hasMoreMessages: true, onLoadMore })
        viewport = rendered.viewport
        const reading = attachReadingRow(viewport)
        act(() => vi.advanceTimersByTime(2_000))
        reading.setCoverage(true)
        const capture = vi.spyOn(readingAnchors, 'captureReadingAnchor')
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        expect(onLoadMore).toHaveBeenCalledTimes(1)
        expect(capture).toHaveBeenCalledTimes(3)
        expect(viewport.scrollTop).toBe(400)
        expect(getMessageReadingAnchor(id)?.topOffset).toBe(400)
    })
})

describe('mobile initial scroll settling', () => {
    it('checks the final keyboard position before clearing intent at scrollend', () => {
        const { container, viewport } = renderThread()
        const sentinel = container.querySelector('.chat-scroll-content > [aria-hidden="true"]')!
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))
        fireEvent.keyDown(viewport, { key: 'Home' })
        fireEvent.keyUp(viewport, { key: 'Home' })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        viewport.scrollTop = 0
        fireEvent(viewport, new Event('scrollend'))
        act(() => {
            vi.advanceTimersByTime(1_800)
        })
        expect(viewport.scrollTop).toBe(0)
    })

    it.each([false, true])('keeps delayed keyboard intent only until scrollend (ended=%s)', (ended) => {
        const { container, viewport, onViewModeChange } = renderThread()
        const sentinel = container.querySelector('.chat-scroll-content > [aria-hidden="true"]')!
        vi.spyOn(sentinel, 'getBoundingClientRect').mockImplementation(() => ({
            top: -viewport.scrollTop,
            bottom: 1 - viewport.scrollTop
        } as DOMRect))

        fireEvent.keyDown(viewport, { key: 'Home' })
        fireEvent.keyUp(viewport, { key: 'Home' })
        act(() => {
            vi.advanceTimersByTime(1_000)
        })
        if (ended) fireEvent(viewport, new Event('scrollend'))
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(ended ? 702 : 520)
        if (!ended) expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('does not snap back after pointer cancellation ends a touch swipe', () => {
        const { viewport, onViewModeChange } = renderThread()
        expect(viewport.scrollTop).toBe(702)

        const pointerDown = new Event('pointerdown', { bubbles: true })
        Object.defineProperties(pointerDown, {
            button: { value: 0 },
            pointerType: { value: 'touch' }
        })
        fireEvent(viewport, pointerDown)
        const pointerCancel = new Event('pointercancel', { bubbles: true })
        Object.defineProperty(pointerCancel, 'pointerType', { value: 'touch' })
        fireEvent(viewport, pointerCancel)

        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(520)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('keeps settling for non-explicit non-zero layout movement', () => {
        const { viewport, onViewModeChange } = renderThread()

        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('does not snap back after a window-captured native scrollbar drag', () => {
        const { viewport, onViewModeChange } = renderThread()
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: 600
        } as DOMRect)

        fireEvent.mouseDown(window, { button: 0, clientX: 319, clientY: 200 })
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        fireEvent.mouseUp(window)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(520)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')
    })

    it('ignores captured mouse input outside the chat viewport', () => {
        const { viewport, onViewModeChange } = renderThread()
        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 320,
            bottom: 600
        } as DOMRect)

        fireEvent.mouseDown(window, { button: 0, clientX: 400, clientY: 200 })
        viewport.scrollTop = 520
        fireEvent.scroll(viewport)
        fireEvent.mouseUp(window)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })

    it('keeps settling after the runtime resets the viewport to the exact top', () => {
        const { viewport, onViewModeChange } = renderThread()

        viewport.scrollTop = 0
        fireEvent.scroll(viewport)
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        expect(viewport.scrollTop).toBe(702)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })
})

describe('explicit tail scrolling', () => {
    it('renders the unread count inside the compact bottom control', () => {
        const { container } = renderThread(vi.fn(), 7)
        const button = container.querySelector<HTMLButtonElement>('button[aria-label*="7"]')

        expect(button).not.toBeNull()
        expect(button).toHaveClass('rounded-full', 'h-6', 'w-6')
        expect(button).toHaveClass('bg-[var(--app-button)]', 'text-[var(--app-button-text)]')
        expect(button?.querySelector('span')).toHaveClass('translate-y-px')
        expect(button?.textContent).toContain('7')
    })

    it('uses the same smooth end-alignment scroll as outline navigation', () => {
        const scrollIntoView = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView
        })
        const { rerenderThread } = renderThread()

        rerenderThread(1)

        expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' })
    })

    it('finishes the native animation before retargeting a growing tail', () => {
        const scrollIntoView = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            writable: true,
            value: scrollIntoView
        })
        const { viewport, rerenderThread } = renderThread()

        rerenderThread(1)
        expect(scrollIntoView).toHaveBeenCalledTimes(1)

        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_400 })
        act(() => {
            resizeCallbacks.forEach(callback => callback())
            resizeCallbacks.forEach(callback => callback())
        })

        expect(scrollIntoView).toHaveBeenCalledTimes(1)
        fireEvent(viewport, new Event('scrollend'))
        expect(scrollIntoView).toHaveBeenCalledTimes(2)
        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'end', behavior: 'smooth' })
    })

    it('stays in tail mode through smooth-scroll progress and content growth', () => {
        const { viewport, onViewModeChange, rerenderThread } = renderThread()
        act(() => {
            vi.advanceTimersByTime(1_800)
        })

        viewport.scrollTop = 400
        fireEvent.scroll(viewport)
        expect(onViewModeChange).toHaveBeenLastCalledWith('history')

        Object.defineProperty(viewport, 'scrollTo', {
            configurable: true,
            value: vi.fn()
        })
        onViewModeChange.mockClear()
        rerenderThread(1)
        expect(onViewModeChange).toHaveBeenLastCalledWith('tail')

        viewport.scrollTop = 500
        fireEvent.scroll(viewport)
        Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1_400 })
        viewport.scrollTop = 650
        fireEvent.scroll(viewport)

        expect(onViewModeChange).not.toHaveBeenCalledWith('history')

        viewport.scrollTop = 870
        fireEvent.scroll(viewport)
        expect(onViewModeChange).not.toHaveBeenCalledWith('history')
    })
})
