import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { SessionListScrollAnchor } from './SessionListScrollAnchor'
import { observeRecentOffset } from './RecentSessionList'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('SessionListScrollAnchor observation', () => {
    it('publishes the actual compensation once and preserves the existing owner', () => {
        const onScrollRestored = vi.fn()
        const first = [] as SessionSummary[]
        const second = [] as SessionSummary[]
        const view = (sessions: SessionSummary[], y: number) => <div data-testid="scroller">
            <SessionListScrollAnchor sessions={sessions} className="" onScrollRestored={onScrollRestored}>
                <button className="session-list-item" data-session-scroll-anchor data-y={y}>Anchor</button>
            </SessionListScrollAnchor>
        </div>
        const { getByTestId, rerender } = render(view(first, 200))
        const scroller = getByTestId('scroller')
        scroller.scrollTop = 100
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const top = this.dataset.y ? Number(this.dataset.y) - scroller.scrollTop : 0
            const height = this === scroller ? 680 : 34
            return { top, bottom: top + height, left: 0, right: 320, width: 320, height, x: 0, y: top, toJSON() {} }
        })
        rerender(view(second, 236))
        expect(scroller.scrollTop).toBe(136)
        expect(onScrollRestored).toHaveBeenCalledExactlyOnceWith(136)
        rerender(view(second, 236))
        expect(onScrollRestored).toHaveBeenCalledTimes(1)
    })
    it('does not announce a nonexistent restoration while at the top', () => {
        const onScrollRestored = vi.fn()
        const view = (sessions: SessionSummary[]) => <div><SessionListScrollAnchor
            sessions={sessions} className="" onScrollRestored={onScrollRestored}>Rows</SessionListScrollAnchor></div>
        const { rerender } = render(view([]))
        rerender(view([]))
        expect(onScrollRestored).not.toHaveBeenCalled()
    })
})

describe('Recent resize offset observer lifetime', () => {
    it('ignores an already-queued resize callback after its instance retires', () => {
        const callbacks: (() => void)[] = []
        class Observer {
            constructor(callback: () => void) { callbacks.push(callback) }
            observe() {}
            disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', Observer)
        const element = document.createElement('div')
        const instance = { scrollElement: element, targetWindow: window, scrollOffset: 0,
            options: { isScrollingResetDelay: 150, useScrollendEvent: false } } as unknown as Parameters<typeof observeRecentOffset>[0]
        const oldCallback = vi.fn()
        const stop = observeRecentOffset(instance, oldCallback)
        stop?.()
        element.scrollTop = 250
        const nextCallback = vi.fn()
        const stopNext = observeRecentOffset(instance, nextCallback)
        expect(nextCallback).toHaveBeenCalledExactlyOnceWith(250, false)
        callbacks[0]()
        expect(oldCallback).not.toHaveBeenCalled()
        expect(nextCallback).toHaveBeenCalledTimes(1)
        stopNext?.()
    })
})
