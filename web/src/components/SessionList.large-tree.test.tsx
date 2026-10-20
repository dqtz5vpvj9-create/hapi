import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { projectSessionTreeRows } from '@/lib/sessionTreeRows'
import { SessionList } from './SessionList'
const viewport = vi.hoisted(() => ({ narrow: false }))
vi.mock('@/hooks/useNarrowViewport', () => ({ useNarrowViewport: () => viewport.narrow }))
vi.mock('@/lib/sessionTreeRows', async original => {
    const actual = await original<typeof import('@/lib/sessionTreeRows')>()
    return { ...actual, projectSessionTreeRows: vi.fn(actual.projectSessionTreeRows) }
})
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('hapi.sessionListView', 'recent'); viewport.narrow = false; vi.mocked(projectSessionTreeRows).mockClear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function session(id: string, parent?: string, updatedAt = 100): SessionSummary {
    return { id, active: false, thinking: false, activeAt: 0, updatedAt, metadata: { name: id, path: '/tree', flavor: 'codex', machineId: 'm', agentSessionId: id, codexParentThreadId: parent },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null }
}
function mount(items: SessionSummary[], selected?: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const onSelect = vi.fn()
    const view = (sessions: SessionSummary[], selectedSessionId = selected) => <QueryClientProvider client={client}><ToastProvider><I18nProvider>
        <SessionList sessions={sessions} selectedSessionId={selectedSessionId} onSelect={onSelect} onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} api={null} />
    </I18nProvider></ToastProvider></QueryClientProvider>
    const result = render(view(items))
    return { ...result, onSelect, update: (sessions: SessionSummary[], selectedSessionId = selected) => result.rerender(view(sessions, selectedSessionId)),
        scroll: (top: number) => { const e = result.container.querySelector('.app-session-list-content')!; e.scrollTop = top; fireEvent.scroll(e) },
        mounted: () => result.container.querySelectorAll('[data-session-tree-id]').length }
}
const toggle = (container: HTMLElement, id: string) => container.querySelector<HTMLButtonElement>(`[data-session-tree-id="${id}"] > .app-session-subagent-toggle`)!

describe('Recent huge subtree window', () => {
    it.each([100, 1000])('bounds a single expanded root and does not project on scroll (%i descendants)', count => {
        const items = [session('root'), ...Array.from({ length: count }, (_, i) => session(`child-${i}`, 'root'))]
        const list = mount(items)
        expect(list.mounted()).toBe(1)
        fireEvent.click(toggle(list.container, 'root'))
        expect(list.mounted()).toBeGreaterThan(10)
        expect(list.mounted()).toBeLessThan(125)
        vi.mocked(projectSessionTreeRows).mockClear()
        list.scroll(count === 100 ? 1700 : 17000)
        expect(list.mounted()).toBeLessThan(125)
        expect(projectSessionTreeRows).not.toHaveBeenCalled()
        list.scroll(0)
        expect(toggle(list.container, 'root')).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(toggle(list.container, 'root'))
        expect(list.mounted()).toBe(1)
    })
    it('pins only the exact selected descendant, not its thousand siblings', () => {
        const items = [session('root'), ...Array.from({ length: 1000 }, (_, i) => session(`child-${i}`, 'root'))]
        const list = mount(items, 'child-999')
        expect(list.container.querySelector('[data-session-tree-id="child-999"] [aria-current="page"]')).toBeTruthy()
        expect(list.mounted()).toBeLessThan(125)
        expect(list.container.querySelector('.app-session-list-content')?.scrollTop).toBe(0)
    })
    it('preserves manual selected-ancestor collapse across an unrelated summary update, then opens a new selected path', () => {
        const items = [session('root'), session('branch', 'root'), session('leaf', 'branch'), session('other', 'branch')]
        const list = mount(items, 'leaf')
        expect(screen.getByText('leaf')).toBeTruthy()
        fireEvent.click(toggle(list.container, 'root'))
        expect(screen.queryByText('leaf')).toBeNull()
        list.update(items.map(s => s.id === 'other' ? { ...s, updatedAt: 200 } : s))
        expect(toggle(list.container, 'root')).toHaveAttribute('aria-expanded', 'false')
        list.update(items, 'other')
        expect(screen.getByText('other')).toBeTruthy()
        expect(toggle(list.container, 'root')).toHaveAttribute('aria-expanded', 'true')
    })
    it('keeps a child context menu owner alive without pinning the subtree', () => {
        const items = [session('root'), ...Array.from({ length: 1000 }, (_, i) => session(`child-${i}`, 'root'))]
        const list = mount(items)
        fireEvent.click(toggle(list.container, 'root'))
        const child = screen.getByText('child-0').closest('button')!
        fireEvent.contextMenu(child, { clientX: 30, clientY: 30 })
        list.scroll(17000)
        expect(list.container.contains(child)).toBe(true)
        expect(list.mounted()).toBeLessThan(125)
        fireEvent.keyDown(document, { key: 'Escape' })
        expect(list.container.contains(child)).toBe(false)
    })
    it('shows mobile headings on root day boundaries only', () => {
        viewport.narrow = true
        const list = mount([session('a', undefined, new Date(2025, 0, 3).getTime()), session('child', 'a', new Date(2025, 0, 4).getTime()), session('b', undefined, new Date(2025, 0, 2).getTime())])
        fireEvent.click(toggle(list.container, 'a'))
        const headings = list.container.querySelectorAll('.app-session-date-heading')
        expect(headings).toHaveLength(2)
        expect(headings[0].textContent).toContain('Jan 3')
        expect(headings[1].textContent).toContain('Jan 2')
        expect(list.container.querySelector('[data-recent-root="child"] .app-session-date-heading')).toBeNull()
    })
})
