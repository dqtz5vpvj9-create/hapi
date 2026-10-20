import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

const SEARCH_LABEL = 'Search sessions (title, path, Agent, machine name, ID, and more)'
const SEARCH_PLACEHOLDER = 'Search title/path/Agent/machine/ID…'

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi.sessionListView')
    localStorage.removeItem('hapi-session-preview-limit')
    localStorage.removeItem('hapi-pin-in-progress-sessions')
})

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

function renderWithProviders(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        }
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>
                    {children}
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

const all = [
    makeSession({ id: 'parent', active: true, updatedAt: 200, metadata: { name: 'Main task', path: '/project', flavor: 'codex', machineId: 'm', agentSessionId: 'native-parent' } }),
    makeSession({ id: 'child', active: true, thinking: true, updatedAt: 300, metadata: { name: 'Inspect layout', path: '/different', flavor: 'codex', machineId: 'm', agentSessionId: 'native-child', codexParentThreadId: 'native-parent', codexAgentNickname: 'Ada', codexAgentRole: 'reviewer' } }),
    makeSession({ id: 'grandchild', active: true, updatedAt: 400, metadata: { name: 'Check mobile', path: '/different', flavor: 'codex', machineId: 'm', agentSessionId: 'native-grandchild', codexParentThreadId: 'native-child' } }),
    makeSession({ id: 'fork', active: true, updatedAt: 500, metadata: { name: 'Independent branch', path: '/project', flavor: 'codex', machineId: 'm', agentSessionId: 'native-fork' } }),
]
function mount(selectedSessionId?: string, sessions = all, api: ApiClient | null = null) {
    const onSelect = vi.fn()
    const onOpenSubagent = vi.fn()
    const element = <SessionList sessions={sessions} selectedSessionId={selectedSessionId} onSelect={onSelect}
        onOpenSubagent={onOpenSubagent}
        onNewSession={vi.fn()} onRefresh={vi.fn()} isLoading={false} api={api} />
    return { onSelect, onOpenSubagent, ...renderWithProviders(element) }
}
describe('SessionList native subagents', () => {
    const nativeRoot = makeSession({ id: 'parent', active: true, updatedAt: 200, metadata: {
        name: 'Main task', path: '/project', flavor: 'codex', machineId: 'm', agentSessionId: 'native-parent',
        codexSubagents: [
            { threadId: 'native-child', parentThreadId: 'native-parent', nickname: 'Native Ada', role: 'reviewer', status: 'unknown' },
            { threadId: 'native-grandchild', parentThreadId: 'native-child', nickname: 'Native Mobile', status: 'unknown' },
        ],
    } })
    it('shows native children without independent HAPI rows and opens their exact thread under the original parent', () => {
        const { onSelect, onOpenSubagent } = mount(undefined, [nativeRoot], {} as ApiClient)
        fireEvent.click(screen.getByRole('button', { name: 'Subagents (1)' }))
        fireEvent.click(screen.getByText('Native Ada'))
        expect(onOpenSubagent).toHaveBeenLastCalledWith('parent', 'native-child')
        expect(onSelect).not.toHaveBeenCalled()
        fireEvent.click(screen.getAllByRole('button', { name: 'Subagents (1)' })[1])
        expect(screen.getByText('Native Mobile')).toBeTruthy()
    })
    it('lists DSH children with their flavor, mode and team status and opens the shared subagent route', () => {
        const dshRoot = makeSession({ id: 'dsh-parent', active: true, updatedAt: 200, metadata: {
            name: 'DSH task', path: '/project', flavor: 'dsh', machineId: 'm',
            dshSubagents: [
                { sessionId: 'session-ada', name: 'Ada', mode: 'continuable', activity: 'running', teamStatus: 'running', provider: 'spawn', createdAt: 1, settledMs: 1200 },
                { sessionId: 'session-ops', label: 'ops one-shot', mode: 'one-shot', activity: 'inactive', createdAt: 2 },
            ],
        } })
        const { onOpenSubagent, container } = mount(undefined, [dshRoot], {} as ApiClient)
        fireEvent.click(screen.getByRole('button', { name: 'Subagents (2)' }))
        const ada = container.querySelector('[data-native-subagent-id="session-ada"]')!
        expect(ada.getAttribute('data-subagent-flavor')).toBe('dsh')
        expect(ada.getAttribute('data-subagent-status')).toBe('running')
        expect(screen.getByText('Ada')).toBeTruthy()
        expect(screen.getByText('ops one-shot')).toBeTruthy()
        expect(ada.textContent).toContain('DSH · Continuable · Running')
        expect(container.querySelector('[data-native-subagent-id="session-ops"]')!.textContent).toContain('One-shot')
        fireEvent.click(screen.getByText('Ada'))
        expect(onOpenSubagent).toHaveBeenLastCalledWith('dsh-parent', 'session-ada')
        fireEvent.click(screen.getByText('ops one-shot'))
        expect(onOpenSubagent).toHaveBeenLastCalledWith('dsh-parent', 'session-ops')
    })
    it('folds DSH children under the parent in the Recent view', () => {
        const dshRoot = makeSession({ id: 'dsh-parent', active: true, updatedAt: 200, metadata: {
            name: 'DSH task', path: '/project', flavor: 'dsh', machineId: 'm',
            dshSubagents: [{ sessionId: 'session-ada', name: 'Ada', mode: 'continuable', activity: 'inactive', createdAt: 1 }],
        } })
        const { onOpenSubagent } = mount(undefined, [dshRoot], {} as ApiClient)
        fireEvent.click(screen.getByRole('button', { name: 'Recent' }))
        expect(screen.queryByText('Ada')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Subagents (1)' }))
        fireEvent.click(screen.getByText('Ada'))
        expect(onOpenSubagent).toHaveBeenLastCalledWith('dsh-parent', 'session-ada')
    })
    it('finds a native child nickname and retains its root even though the child has no HAPI row', () => {
        mount(undefined, [nativeRoot, all[3]])
        fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
        fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'Native Mobile' } })
        expect(screen.getByText('Main task')).toBeTruthy()
        expect(screen.getByText('Native Mobile')).toBeTruthy()
        expect(screen.queryByText('Independent branch')).toBeNull()
    })
    it.each(['Recent', 'Folders'])('folds children under the parent in %s view and opens the exact child', view => {
        const { onSelect, container } = mount()
        fireEvent.click(screen.getByRole('button', { name: view }))
        expect(screen.queryByText('Inspect layout')).toBeNull()
        expect(screen.getByText('Independent branch')).toBeTruthy()
        const toggle = screen.getByRole('button', { name: 'Subagents (1)' })
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        fireEvent.click(toggle)
        expect(screen.getByText('Inspect layout')).toBeTruthy()
        expect(container.querySelector(view === 'Recent' ? '[data-session-tree-depth="1"] [data-session-tree-id="child"]' : '[data-subagent-parent="parent"] [data-session-tree-id="child"]')).toBeTruthy()
        fireEvent.mouseDown(screen.getByText('Inspect layout'), { button: 0 })
        fireEvent.mouseUp(screen.getByText('Inspect layout'), { button: 0 })
        expect(onSelect).toHaveBeenLastCalledWith('child')
        fireEvent.click(toggle)
        expect(screen.queryByText('Inspect layout')).toBeNull()
    })
    it('automatically reveals the selected grandchild and keeps its ancestors in active-only view', () => {
        localStorage.setItem('hapi-show-active-sessions-only', 'true')
        const { container } = mount('grandchild', all.map(s => s.id === 'parent' ? { ...s, active: false } : s))
        expect(screen.getByText('Main task')).toBeTruthy()
        expect(screen.getByText('Check mobile')).toBeTruthy()
        expect(container.querySelector('[data-subagent-parent="child"] [data-session-tree-id="grandchild"]')).toBeTruthy()
        localStorage.removeItem('hapi-show-active-sessions-only')
    })
    it('searches inside children and shows the complete parent chain without unrelated siblings', () => {
        mount()
        fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
        fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'Check mobile' } })
        expect(screen.getByText('Main task')).toBeTruthy()
        expect(screen.getByText('Inspect layout')).toBeTruthy()
        expect(screen.getByText('Check mobile')).toBeTruthy()
        expect(screen.queryByText('Independent branch')).toBeNull()
    })
    it('reveals approval requests in nested children even with compact status and an inactive parent', () => {
        mount(undefined, all.map(s => s.id === 'grandchild' ? { ...s, pendingRequestsCount: 2 } : s.id === 'parent' ? { ...s, active: false } : s))
        expect(screen.getAllByText('2 awaiting approval')).toHaveLength(2)
        expect(screen.getByText('Check mobile')).toBeTruthy()
        expect(screen.getAllByRole('button', { name: /Subagents \(1\) 2 awaiting approval/ }).every(button => button.getAttribute('aria-expanded') === 'true')).toBe(true)
    })
    it.each(['Ada', 'reviewer'])('finds a child by its %s identity and reveals its parent', term => {
        mount()
        fireEvent.click(screen.getByRole('button', { name: SEARCH_LABEL }))
        fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: term } })
        expect(screen.getByText('Main task')).toBeTruthy()
        expect(screen.getByText('Inspect layout')).toBeTruthy()
        expect(screen.queryByText('Independent branch')).toBeNull()
    })
    it('labels an orphan as a subagent while keeping it accessible', () => {
        const { onSelect } = mount(undefined, [all[1]])
        expect(screen.getByText('Inspect layout')).toBeTruthy()
        expect(screen.getByText('Subagent · Ada · reviewer')).toBeTruthy()
        fireEvent.mouseDown(screen.getByText('Inspect layout'), { button: 0 })
        fireEvent.mouseUp(screen.getByText('Inspect layout'), { button: 0 })
        expect(onSelect).toHaveBeenCalledWith('child')
    })
})
