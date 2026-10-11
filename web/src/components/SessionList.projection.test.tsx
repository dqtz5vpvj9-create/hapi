import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { buildSessionHierarchy } from '@/lib/sessionHierarchy'
import { SessionList } from './SessionList'

vi.mock('@/hooks/useNarrowViewport', () => ({ useNarrowViewport: () => true }))
vi.mock('@/lib/sessionHierarchy', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/sessionHierarchy')>()
    return { ...actual, buildSessionHierarchy: vi.fn(actual.buildSessionHierarchy) }
})
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('hapi.sessionListView', 'recent') })
afterEach(() => { cleanup(); vi.clearAllMocks() })
function session(id: string, running = false, parent?: string): SessionSummary {
    return { id, active: running, thinking: running, activeAt: 0, updatedAt: 100,
        metadata: { name: id, path: '/work', flavor: 'codex', machineId: 'm', agentSessionId: id, codexParentThreadId: parent },
        metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, todoProgress: null,
        pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0,
        futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null }
}

describe('Session list unchanged-input projections', () => {
    it.each([100, 1000])('reuses hierarchy for unchanged %i-session parent renders and updates running roots', count => {
        const sessions = [session('parent', true), session('child', true, 'parent'),
            ...Array.from({ length: count - 2 }, (_, i) => session(`idle-${i}`))]
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const callbacks = { onSelect: vi.fn(), onNewSession: vi.fn(), onRefresh: vi.fn() }
        const labels = { m: 'Machine' }
        const tree = (items: SessionSummary[]) => <QueryClientProvider client={client}><ToastProvider><I18nProvider>
            <SessionList {...callbacks} sessions={items} hub="projection-test" isLoading={false} api={null} machineLabelsById={labels} />
        </I18nProvider></ToastProvider></QueryClientProvider>
        const view = render(tree(sessions))
        expect(screen.getByRole('button', { name: 'Running 1' })).toBeTruthy()
        const hierarchy = vi.mocked(buildSessionHierarchy)
        hierarchy.mockClear()
        view.rerender(tree(sessions))
        view.rerender(tree(sessions))
        expect(hierarchy).not.toHaveBeenCalled()
        const changed = [...sessions, session('new-running', true)]
        view.rerender(tree(changed))
        expect(hierarchy).toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Running 2' })).toBeTruthy()
        hierarchy.mockClear()
        view.rerender(tree(changed))
        expect(hierarchy).not.toHaveBeenCalled()
    })
})
