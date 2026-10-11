import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'
import { markAllSessionsSeen, markSessionSeen, markSessionUnread } from '@/lib/sessionLastSeen'

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

const seenKey = 'hapi.sessionLastSeen.v1'
const unreadKey = 'hapi.sessionManualUnread.v1'
function attention(container: HTMLElement, id: string) {
    return container.querySelector(`[data-session-tree-id="${id}"]`)
        ?.querySelector('.session-list-item')?.querySelector('[data-session-status="unread"]') ?? null
}

describe('Session list shared read-state snapshot', () => {
    it('does not amplify populated storage reads/parses across 100 or 1000 rows or scroll mounts', () => {
        let initialReads: number | undefined
        for (const count of [100, 1000]) {
            const items = sessions(count)
            const seen = JSON.stringify(Object.fromEntries(items.map(item => [item.id, item.updatedAt])))
            const unread = JSON.stringify(Object.fromEntries(items.map(item => [item.id, item.updatedAt - 1])))
            localStorage.setItem(seenKey, seen)
            localStorage.setItem(unreadKey, unread)
            const reads = vi.spyOn(Storage.prototype, 'getItem')
            const parses = vi.spyOn(JSON, 'parse')
            const { container, unmount } = mount(items)
            const readCalls = () => reads.mock.calls.filter(([key]) => key === seenKey || key === unreadKey).length
            const parseCalls = () => parses.mock.calls.filter(([raw]) => raw === seen || raw === unread).length
            expect(rows(container).length).toBeGreaterThan(10)
            // Includes initial parent renders and the existing unread-count batch.
            // The bound excludes the former four storage reads per mounted row.
            expect(readCalls()).toBeLessThan(20)
            expect(parseCalls()).toBe(readCalls())
            if (initialReads !== undefined) expect(readCalls()).toBe(initialReads)
            initialReads = readCalls()
            reads.mockClear()
            parses.mockClear()
            scrollTo(container, 1800)
            expect(container.querySelector('[data-recent-root="row-50"]')).toBeTruthy()
            expect(readCalls()).toBe(0)
            expect(parseCalls()).toBe(0)
            unmount()
            reads.mockRestore()
            parses.mockRestore()
        }
    })

    it('refreshes selected and expanded-child unread badges after same-tab operations', () => {
        const parent = session('parent', 'Parent')
        const child = session('child', 'Child', { metadata: { name: 'Child', path: '/work/hapi', flavor: 'codex', machineId: 'm1', agentSessionId: 'child', codexParentThreadId: 'parent' } })
        localStorage.setItem(seenKey, JSON.stringify({ parent: 100, child: 100 }))
        const { container } = mount([parent, child], vi.fn(), 'parent')
        fireEvent.click(screen.getByRole('button', { name: 'Subagents (1)' }))
        expect(attention(container, 'parent')).toBeNull()
        expect(attention(container, 'child')).toBeNull()
        act(() => { markSessionUnread('parent', 100); markSessionUnread('child', 100) })
        expect(attention(container, 'parent')).toBeTruthy()
        expect(attention(container, 'child')).toBeTruthy()
        const parentRow = container.querySelector('[data-session-tree-id="parent"] > .session-list-item')
        const tooltipId = parentRow?.getAttribute('aria-describedby')?.split(' ')[0]
        expect(tooltipId).toBeTruthy()
        expect(document.getElementById(tooltipId!)).toHaveTextContent('New activity')
        act(() => markSessionSeen('parent', 100))
        expect(attention(container, 'parent')).toBeNull()
        expect(attention(container, 'child')).toBeTruthy()
        act(() => markAllSessionsSeen([parent, child]))
        expect(attention(container, 'child')).toBeNull()
    })

    it('refreshes on cross-tab key changes/removal and a parent render after direct clear', () => {
        const items = [session('a', 'A')]
        localStorage.setItem(seenKey, JSON.stringify({ a: 100 }))
        const { container, updateSessions } = mount(items)
        expect(attention(container, 'a')).toBeNull()
        act(() => {
            localStorage.removeItem(seenKey)
            window.dispatchEvent(new StorageEvent('storage', { key: seenKey }))
        })
        expect(attention(container, 'a')).toBeTruthy()
        act(() => {
            localStorage.setItem(seenKey, JSON.stringify({ a: 100 }))
            window.dispatchEvent(new StorageEvent('storage', { key: seenKey }))
        })
        expect(attention(container, 'a')).toBeNull()
        localStorage.clear()
        // No new notification contract: direct clear is observed on parent render.
        updateSessions(items)
        expect(attention(container, 'a')).toBeTruthy()
    })

    it('keeps persisted unread badges when writes fail, including partial success', () => {
        markSessionUnread('a', 100)
        const { container } = mount([session('a', 'A')], vi.fn(), 'a')
        const originalSetItem = Storage.prototype.setItem
        const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
        act(() => markSessionSeen('a', 100))
        expect(attention(container, 'a')).toBeTruthy()
        write.mockImplementation(function (this: Storage, key, value) {
            if (key === unreadKey) throw new Error('quota exceeded')
            originalSetItem.call(this, key, value)
        })
        act(() => markSessionSeen('a', 100))
        expect(attention(container, 'a')).toBeTruthy()
        write.mockRestore()
        act(() => markSessionSeen('a', 100))
        expect(attention(container, 'a')).toBeNull()
    })
})
