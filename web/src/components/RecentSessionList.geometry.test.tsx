import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { RecentSessionList } from './RecentSessionList'

// Keep the real virtualizer and observe the margin that drives its range.
vi.mock('@tanstack/react-virtual', async importOriginal => {
    const actual = await importOriginal<typeof import('@tanstack/react-virtual')>()
    return { ...actual, useVirtualizer: vi.fn(actual.useVirtualizer) }
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function sessions(count: number): SessionSummary[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `row-${i}`, active: false, thinking: false, activeAt: 0, updatedAt: 100000 - i,
        metadata: { name: `Row ${i}`, path: '/work/hapi', flavor: 'codex', machineId: 'm1', agentSessionId: `row-${i}` },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null,
    }))
}

const timeFor = (session: SessionSummary) => session.updatedAt
const rowContent = (session: SessionSummary) => <span>{session.id}</span>
const latestMargin = () => vi.mocked(useVirtualizer).mock.lastCall?.[0].scrollMargin

function mount(count = 1000, initiallyVisible = true, initiallyNarrow = false) {
    const geometry = { origin: 24, top: 100, width: 320, height: 360, visible: initiallyVisible, scrollTop: 0 }
    const marginReads = vi.fn()
    const writes = vi.fn((top: number) => { geometry.scrollTop = top })
    const observers: Observer[] = []
    class Observer {
        readonly targets = new Set<Element>()
        constructor(readonly callback: ResizeObserverCallback) { observers.push(this) }
        observe(target: Element) { this.targets.add(target) }
        unobserve(target: Element) { this.targets.delete(target) }
        disconnect() { this.targets.clear() }
    }
    vi.stubGlobal('ResizeObserver', Observer)
    const scroller = document.createElement('div')
    Object.defineProperties(scroller, {
        clientHeight: { get: () => geometry.visible ? geometry.height : 0 },
        offsetHeight: { get: () => geometry.visible ? geometry.height : 0 },
        offsetWidth: { get: () => geometry.visible ? geometry.width : 0 },
        scrollTop: { get: () => geometry.scrollTop, set: writes },
    })
    document.body.append(scroller)
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => (
        geometry.visible ? [{}] : []
    ) as unknown as DOMRectList)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const isList = this.dataset.testid === 'recent-session-list'
        if (this === scroller || isList) marginReads(this)
        const top = isList ? geometry.top + geometry.origin - geometry.scrollTop : geometry.top
        const height = this === scroller ? geometry.height : 34
        return { top, bottom: top + height, left: 0, right: geometry.width, width: geometry.width, height,
            x: 0, y: top, toJSON() {} }
    })
    const items = sessions(count)
    const view = (narrow = initiallyNarrow, renderer = rowContent) => <I18nProvider>
        <RecentSessionList sessions={items} scrollElement={scroller} narrow={narrow}
            timeFor={timeFor} renderSession={renderer} />
    </I18nProvider>
    const result = render(view(), { container: scroller })
    const viewportObservers = () => observers.filter(observer => observer.targets.has(scroller))
    const entry = () => ({ target: scroller, borderBoxSize: [{
        inlineSize: geometry.visible ? geometry.width : 0,
        blockSize: geometry.visible ? geometry.height : 0,
    }] }) as unknown as ResizeObserverEntry
    const deliver = (targets = viewportObservers()) => act(() => {
        for (const observer of targets) observer.callback([entry()], observer as unknown as ResizeObserver)
    })
    return {
        ...result, geometry, marginReads, writes, viewportObservers, deliver,
        update: (narrow = initiallyNarrow, renderer = rowContent) => result.rerender(view(narrow, renderer)),
        scroll: (top: number) => { geometry.scrollTop = top; fireEvent.scroll(scroller) },
        mounted: () => [...scroller.querySelectorAll<HTMLElement>('[data-recent-root]')].map(row => row.dataset.recentRoot),
        resizeRow: (id: string, height: number) => act(() => {
            const target = scroller.querySelector(`[data-recent-root="${id}"]`)!
            for (const observer of observers.filter(item => item.targets.has(target))) {
                observer.callback([{ target, borderBoxSize: [{ inlineSize: geometry.width, blockSize: height }] } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver)
            }
        }),
    }
}

describe('Recent margin invalidation', () => {
    it.each([100, 1000])('does not reread list/viewport rects on virtualizer-only scrolls (%i rows)', count => {
        const list = mount(count)
        list.deliver()
        expect(latestMargin()).toBe(24)
        const initial = list.mounted()
        list.marginReads.mockClear()
        for (const offset of [1440, 1512, 1440, 0]) list.scroll(offset)
        expect(list.marginReads).not.toHaveBeenCalled()
        expect(list.mounted()).toEqual(initial)
        list.scroll(1800)
        expect(list.mounted()).not.toEqual(initial)
        expect(list.marginReads).not.toHaveBeenCalled()
        expect(list.writes).not.toHaveBeenCalled()
    })

    it('remeasures an origin changed by a parent commit with stable sessions', () => {
        const list = mount()
        list.scroll(3600)
        list.geometry.origin = 744
        list.marginReads.mockClear()
        // SessionList deliberately supplies a new renderer on parent commits.
        list.update(false, session => <span>{session.id}</span>)
        expect(latestMargin()).toBe(744)
        expect(list.marginReads).toHaveBeenCalledTimes(2)
        expect(list.geometry.scrollTop).toBe(3600)
        expect(list.writes).not.toHaveBeenCalled()
    })

    it('remeasures on narrow layout changes without a renderer change', () => {
        const list = mount()
        list.geometry.origin = 48
        list.update(true)
        expect(latestMargin()).toBe(48)
        expect(list.container.querySelector('.app-session-date-heading')).toBeTruthy()
        expect(list.writes).not.toHaveBeenCalled()
    })

    it('handles viewport/header resizing without a parent commit or scroll', () => {
        const list = mount()
        list.geometry.origin = 88
        list.geometry.top = 160
        list.geometry.height = 300
        list.geometry.width = 400
        list.deliver()
        expect(latestMargin()).toBe(88)
        const calls = vi.mocked(useVirtualizer).mock.calls.length
        list.deliver()
        expect(latestMargin()).toBe(88)
        // An equal measurement must settle, not feed a render/resize loop.
        expect(vi.mocked(useVirtualizer).mock.calls.length - calls).toBeLessThanOrEqual(1)
        expect(list.writes).not.toHaveBeenCalled()
    })

    it('leaves mobile heading/subtree height updates to row measurement', () => {
        const list = mount(1000, true, true)
        const content = list.getByTestId('recent-session-list')
        const previousHeight = parseFloat(content.style.height)
        list.marginReads.mockClear()
        list.resizeRow('row-0', 134)
        expect(parseFloat(content.style.height)).toBe(previousHeight + 100)
        expect(latestMargin()).toBe(24)
        expect(list.marginReads).not.toHaveBeenCalled()
        expect(list.writes).not.toHaveBeenCalled()
    })

    it('measures an initially display-none pane on reveal', () => {
        const list = mount(1000, false)
        expect(latestMargin()).toBe(0)
        expect(list.marginReads).not.toHaveBeenCalled()
        list.geometry.visible = true
        list.geometry.origin = 120
        list.geometry.scrollTop = 3600
        list.deliver()
        expect(latestMargin()).toBe(120)
        expect(list.mounted()).toContain('row-100')
        expect(list.mounted()).not.toContain('row-0')
        expect(list.writes).not.toHaveBeenCalled()
    })

    it('retains margin while hidden and observes the restored DOM top without a scroll event', () => {
        const list = mount()
        list.scroll(3600)
        list.geometry.visible = false
        list.scroll(0)
        list.deliver()
        expect(latestMargin()).toBe(24)
        list.geometry.visible = true
        list.geometry.origin = 144
        list.geometry.scrollTop = 7200
        list.deliver()
        expect(latestMargin()).toBe(144)
        expect(list.mounted()).toContain('row-200')
        expect(list.mounted()).not.toContain('row-0')
        expect(list.geometry.scrollTop).toBe(7200)
        expect(list.writes).not.toHaveBeenCalled()
    })

    it('ignores queued viewport deliveries after unmount', () => {
        const list = mount()
        const retired = list.viewportObservers()
        expect(retired.length).toBeGreaterThan(0)
        list.unmount()
        list.marginReads.mockClear()
        list.geometry.origin = 500
        list.deliver(retired)
        expect(list.marginReads).not.toHaveBeenCalled()
        expect(list.writes).not.toHaveBeenCalled()
    })
})
