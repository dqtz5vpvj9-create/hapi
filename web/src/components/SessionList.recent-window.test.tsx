import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const viewport = vi.hoisted(() => ({ narrow: false }))
vi.mock('@/hooks/useNarrowViewport', () => ({ useNarrowViewport: () => viewport.narrow }))
beforeEach(() => { viewport.narrow = false; localStorage.clear(); sessionStorage.clear(); localStorage.setItem('hapi.sessionListView', 'recent') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function session(id: string, name: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return { id, active: false, thinking: false, activeAt: 0, updatedAt: 100, metadata: { name, path: '/work/hapi', flavor: 'codex', machineId: 'm1', agentSessionId: id }, metadataVersion: 0, agentStateVersion: 0,
        todosUpdatedAt: 0, todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null, ...overrides }
}
function mount(sessions: SessionSummary[], onStartTask = vi.fn(), selectedSessionId?: string) {
    const onSelect = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    const view = (items: SessionSummary[]) => <QueryClientProvider client={client}><ToastProvider><I18nProvider>
        <SessionList sessions={items} selectedSessionId={selectedSessionId} onSelect={onSelect} onNewSession={vi.fn()} onStartTask={onStartTask} hub="list-test-hub"
            onRefresh={vi.fn()} isLoading={false} api={null} machineLabelsById={{ m1: 'Mint', m2: 'Teemo' }} />
    </I18nProvider></ToastProvider></QueryClientProvider>
    const rendered = render(view(sessions))
    return { onSelect, onStartTask, ...rendered, updateSessions: (items: SessionSummary[]) => rendered.rerender(view(items)) }
}

function scrollTo(container: HTMLElement, top: number) {
    const scroller = container.querySelector('.app-session-list-content') as HTMLElement
    scroller.scrollTop = top
    fireEvent.scroll(scroller)
    return scroller
}
function sessions(count: number) {
    return Array.from({ length: count }, (_, i) => session(`row-${i}`, `Row ${i}`, { updatedAt: 100000 - i }))
}
function rows(container: HTMLElement) { return container.querySelectorAll('[data-recent-root]') }

describe('Recent bounded mounting', () => {
    it('mounts the same viewport-sized window for 100 and 1000 flat roots', () => {
        let previousCount = 0
        for (const count of [100, 1000]) {
            const items = sessions(count)
            const dates = vi.spyOn(Date.prototype, 'toLocaleDateString')
            const { container, updateSessions, unmount } = mount(items)
            const mounted = rows(container).length
            expect(mounted).toBeGreaterThan(10)
            expect(mounted).toBeLessThan(85)
            if (previousCount) expect(mounted).toBe(previousCount)
            previousCount = mounted
            dates.mockClear()
            updateSessions(items)
            expect(dates).not.toHaveBeenCalled()
            expect(rows(container).length).toBe(mounted)
            unmount()
            dates.mockRestore()
        }
    })
    it('renders the destination immediately when scrolling down then back up', () => {
        const { container } = mount(sessions(1000))
        const scroller = scrollTo(container, 18000)
        expect(container.querySelector('[data-recent-root="row-500"]')).toBeTruthy()
        expect(container.querySelector('[data-recent-root="row-0"]')).toBeNull()
        expect(rows(container).length).toBeLessThan(120)
        scrollTo(container, 0)
        expect(container.querySelector('[data-recent-root="row-0"]')).toBeTruthy()
        expect(container.querySelector('[data-recent-root="row-500"]')).toBeNull()
        expect(scroller.scrollTop).toBe(0)
    })
    it('keeps selection mounted without moving the viewport', () => {
        const { container } = mount(sessions(1000), vi.fn(), 'row-900')
        expect(container.querySelector('[data-recent-root="row-900"] [aria-current="page"]')).toBeTruthy()
        const scroller = container.querySelector('.app-session-list-content') as HTMLElement
        expect(scroller.scrollTop).toBe(0)
        expect(rows(container).length).toBeLessThan(85)
    })
    it('observes the actual offset when returning from Folders without a scroll event', () => {
        const { container } = mount(sessions(1000))
        scrollTo(container, 18000)
        fireEvent.click(screen.getByRole('button', { name: 'Folders' }))
        fireEvent.click(screen.getByRole('button', { name: 'Recent' }))
        expect(container.querySelector('[data-recent-root="row-500"]')).toBeTruthy()
        expect(container.querySelector('[data-recent-root="row-0"]')).toBeNull()
    })
    it('keeps row identity and frozen order on a genuine offscreen summary update', () => {
        const items = sessions(1000)
        const { container, updateSessions } = mount(items)
        scrollTo(container, 18000)
        const before = container.querySelector('[data-recent-root="row-500"]')
        const offscreen = { ...items[900], active: true, thinking: true, updatedAt: 999999999 }
        updateSessions([offscreen, ...items.filter(item => item.id !== offscreen.id)])
        expect(container.querySelector('[data-recent-root="row-500"]')).toBe(before)
        expect((container.querySelector('.app-session-list-content') as HTMLElement).scrollTop).toBe(18000)
        expect(rows(container).length).toBeLessThan(120)
    })
    it('retains the focused row until focus leaves', () => {
        const { container } = mount(sessions(1000))
        const first = screen.getByText('Row 0').closest('button')!
        fireEvent.focus(first)
        scrollTo(container, 18000)
        expect(container.contains(first)).toBe(true)
        fireEvent.blur(first, { relatedTarget: document.body })
        expect(container.contains(first)).toBe(false)
    })
    it('keeps a context menu owner alive away from the viewport', () => {
        const { container } = mount(sessions(1000))
        const first = screen.getByText('Row 0').closest('button')!
        fireEvent.contextMenu(first, { clientX: 30, clientY: 30 })
        scrollTo(container, 18000)
        expect(container.contains(first)).toBe(true)
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(container.contains(first)).toBe(false)
    })
    it('reveals a newly pending child without remounting its retained root', () => {
        const items = sessions(1000)
        const child = session('child', 'Child needing approval', { metadata: {
            name: 'Child needing approval', path: '/work/hapi', flavor: 'codex', machineId: 'm1',
            agentSessionId: 'child', codexParentThreadId: 'row-0',
        } })
        const { container, updateSessions } = mount([...items, child], vi.fn(), 'row-0')
        const root = container.querySelector('[data-recent-root="row-0"]')
        expect(screen.queryByText('Child needing approval')).toBeNull()
        scrollTo(container, 18000)
        expect(container.querySelector('[data-recent-root="row-0"]')).toBe(root)
        updateSessions([...items, { ...child, pendingRequestsCount: 2 }])
        expect(container.querySelector('[data-recent-root="row-0"]')).toBe(root)
        expect(screen.getByText('Child needing approval')).toBeTruthy()
        expect(screen.getByRole('button', { name: /Subagents \(1\) 2 awaiting approval/ })).toHaveAttribute('aria-expanded', 'true')
        expect((container.querySelector('.app-session-list-content') as HTMLElement).scrollTop).toBe(18000)
    })
    it('restores expanded children when their root remounts', () => {
        const items = sessions(1000)
        const child = session('child', 'Child task', { metadata: { name: 'Child task', path: '/work/hapi', flavor: 'codex', machineId: 'm1', agentSessionId: 'child', codexParentThreadId: 'row-0' } })
        const { container } = mount([...items, child])
        fireEvent.click(screen.getByRole('button', { name: 'Subagents (1)' }))
        expect(screen.getByText('Child task')).toBeTruthy()
        scrollTo(container, 18000)
        expect(screen.queryByText('Child task')).toBeNull()
        scrollTo(container, 0)
        expect(screen.getByText('Child task')).toBeTruthy()
    })
    it('preserves first-day versus later-day mobile heading spacing', () => {
        viewport.narrow = true
        const { container } = mount([
            session('first-day', 'First day', { updatedAt: Date.UTC(2025, 0, 3) }),
            session('later-day', 'Later day', { updatedAt: Date.UTC(2025, 0, 2) }),
        ])
        const headings = container.querySelectorAll<HTMLElement>('.app-session-date-heading')
        expect(headings.length).toBe(2)
        expect(headings[0].style.paddingTop).toBe('')
        expect(headings[1].style.paddingTop).toBe('18px')
    })
    it('shows mobile day headings only at actual logical boundaries', () => {
        viewport.narrow = true
        const items = sessions(1000)
        const { container, updateSessions } = mount(items)
        expect(container.querySelectorAll('.app-session-date-heading').length).toBe(1)
        const dates = vi.spyOn(Date.prototype, 'toLocaleDateString')
        updateSessions(items)
        expect(dates).not.toHaveBeenCalled()
        scrollTo(container, 18000)
        expect(container.querySelectorAll('.app-session-date-heading').length).toBe(0)
        scrollTo(container, 0)
        expect(container.querySelectorAll('.app-session-date-heading').length).toBe(1)
    })
})

describe('Recent refresh owns its reordered projection', () => {
    beforeEach(() => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            const scroller = document.querySelector('.app-session-list-content') as HTMLElement | null
            const root = this.closest<HTMLElement>('[data-recent-root]')
            const isScroller = this.classList.contains('app-session-list-content')
            const isList = this.getAttribute('data-testid') === 'recent-session-list'
            const top = root ? Number(root.dataset.index) * 36 - (scroller?.scrollTop ?? 0)
                : isList ? -(scroller?.scrollTop ?? 0) : 0
            const height = isScroller ? 680 : isList ? parseFloat(this.style.height) || 680 : 34
            return { top, bottom: top + height, left: 0, right: 320, width: 320, height, x: 0, y: top, toJSON() {} }
        })
        vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
            return [this.getBoundingClientRect()] as unknown as DOMRectList
        })
    })
    it('preserves the reader when only recency snapshot changes, without another sessions response', () => {
        const initial = sessions(1000)
        const { container, updateSessions } = mount(initial)
        const scroller = scrollTo(container, 18000)
        const anchor = container.querySelector('[data-recent-root="row-500"]') as HTMLElement
        expect(anchor).toBeTruthy()
        expect(anchor.getBoundingClientRect().top).toBe(0)
        // This real summary update arrives first, but frozen recency keeps its
        // former seat. The explicit refresh below changes no sessions prop.
        const updated = initial.map(item => item.id === 'row-900' ? { ...item, updatedAt: 999999999 }
            : item.id === 'row-517' ? { ...item, updatedAt: 1000000000 } : item)
        updateSessions(updated)
        expect(anchor.getBoundingClientRect().top).toBe(0)
        fireEvent.click(screen.getByRole('button', { name: 'Recent' }))
        expect(container.querySelector('[data-recent-root="row-500"]')).toBe(anchor)
        expect(anchor.getBoundingClientRect().top).toBe(0)
        expect(scroller.scrollTop).toBe(18072)
        // The virtual observer sees that landing immediately; reverse input
        // remains native and reaches the preceding logical window.
        scrollTo(container, 17676)
        expect(container.querySelector('[data-recent-root="row-490"]')).toBeTruthy()
    })
    it.each(['promoted', 'removed'] as const)('uses the next visible survivor when the first row is %s out of the window', mode => {
        const initial = sessions(1000)
        const { container, updateSessions } = mount(initial)
        const scroller = scrollTo(container, 18000)
        const oldFirst = container.querySelector('[data-recent-root="row-500"]')
        const next = container.querySelector('[data-recent-root="row-501"]') as HTMLElement
        expect(next.getBoundingClientRect().top).toBe(36)
        if (mode === 'removed') {
            updateSessions(initial.filter(item => item.id !== 'row-500'))
        } else {
            updateSessions(initial.map(item => item.id === 'row-500' ? { ...item, updatedAt: 999999999 } : item))
            fireEvent.click(screen.getByRole('button', { name: 'Recent' }))
        }
        expect(container.contains(oldFirst)).toBe(false)
        expect(container.querySelector('[data-recent-root="row-501"]')).toBe(next)
        expect(next.getBoundingClientRect().top).toBe(36)
        expect(scroller.scrollTop).toBe(mode === 'removed' ? 17964 : 18000)
    })

    it('follows the first visible row when it is promoted but explicitly retained', () => {
        const initial = sessions(1000)
        const { container, updateSessions } = mount(initial, vi.fn(), 'row-500')
        const scroller = scrollTo(container, 18000)
        const anchor = container.querySelector('[data-recent-root="row-500"]') as HTMLElement
        expect(anchor.getBoundingClientRect().top).toBe(0)
        updateSessions(initial.map(item => item.id === 'row-500' ? { ...item, updatedAt: 999999999 } : item))
        fireEvent.click(screen.getByRole('button', { name: 'Recent' }))
        expect(container.querySelector('[data-recent-root="row-500"]')).toBe(anchor)
        expect(anchor.getBoundingClientRect().top).toBe(0)
        expect(scroller.scrollTop).toBe(0)
    })

})
