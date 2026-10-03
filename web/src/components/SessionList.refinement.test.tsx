import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'
import { SessionListHeaderActions } from './SessionListHeaderActions'
import { loadNewTaskDraft } from '@/lib/new-task-draft'
import { markSessionUnread } from '@/lib/sessionLastSeen'

vi.mock('@/hooks/useNarrowViewport', () => ({ useNarrowViewport: () => true }))
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('hapi.sessionListView', 'recent') })
afterEach(cleanup)
function session(id: string, name: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return { id, active: false, thinking: false, activeAt: 0, updatedAt: 100, metadata: { name, path: '/work/hapi', flavor: 'codex', machineId: 'm1', agentSessionId: id }, metadataVersion: 0, agentStateVersion: 0,
        todosUpdatedAt: 0, todoProgress: null, pendingRequestsCount: 0, pendingRequestKinds: [], pendingRequests: [], backgroundTaskCount: 0, futureScheduledMessageCount: 0, nextScheduledAt: null, model: null, effort: null, ...overrides }
}
function mount(sessions: SessionSummary[], onStartTask = vi.fn()) {
    const onSelect = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return { onSelect, onStartTask, ...render(<QueryClientProvider client={client}><ToastProvider><I18nProvider>
        <SessionList sessions={sessions} onSelect={onSelect} onNewSession={vi.fn()} onStartTask={onStartTask} hub="list-test-hub"
            onRefresh={vi.fn()} isLoading={false} api={null} machineLabelsById={{ m1: 'Mint', m2: 'Teemo' }} />
    </I18nProvider></ToastProvider></QueryClientProvider>) }
}
function tabs(container: HTMLElement) { return within(container.querySelector('.app-session-mobile-tabs') as HTMLElement) }
describe('Refined phone list', () => {
    it('filters actual running/approval state and restores all sessions from Recent', () => {
        const { container } = mount([session('working', 'Working task', { active: true, thinking: true }), session('quiet', 'Quiet active', { active: true }), session('history', 'Old task'), session('approval', 'Approval task', { active: true, pendingRequestsCount: 1 })])
        fireEvent.click(tabs(container).getByRole('button', { name: 'Running 2' }))
        expect(screen.getByText('Working task')).toBeTruthy()
        expect(screen.getByText('Approval task')).toBeTruthy()
        expect(screen.queryByText('Quiet active')).toBeNull()
        expect(screen.queryByText('Old task')).toBeNull()
        fireEvent.click(tabs(container).getByRole('button', { name: 'Recent' }))
        expect(screen.getByText('Quiet active')).toBeTruthy()
        expect(screen.getByText('Old task')).toBeTruthy()
    })
    it('retains the hierarchy and expands the inline child count without selecting the parent', () => {
        const parent = session('parent', 'Parent task')
        const child = session('child', 'Child task', { metadata: { name: 'Child task', path: '/work/hapi', flavor: 'codex', machineId: 'm1', agentSessionId: 'child', codexParentThreadId: 'parent' } })
        const { container, onSelect } = mount([parent, child])
        expect(screen.queryByText('Child task')).toBeNull()
        const toggle = screen.getByRole('button', { name: 'Subagents (1)' })
        expect(toggle).toHaveClass('app-session-subagent-toggle')
        fireEvent.click(toggle)
        expect(onSelect).not.toHaveBeenCalled()
        expect(container.querySelector('[data-subagent-parent="parent"] [data-session-tree-id="child"]')).toBeTruthy()
        fireEvent.mouseDown(screen.getByText('Child task'), { button: 0 }); fireEvent.mouseUp(screen.getByText('Child task'), { button: 0 })
        expect(onSelect).toHaveBeenCalledWith('child')
    })
    it('uses the explicit selected machine for task options and keeps the typed draft', () => {
        localStorage.setItem('hapi-session-list-machine-filter', 'm2')
        const second = session('second', 'Second machine task', { metadata: { name: 'Second machine task', path: '/work/hapi', machineId: 'm2', agentSessionId: 'second' } })
        const { onStartTask } = mount([session('first', 'First machine task'), second])
        fireEvent.change(screen.getByRole('textbox', { name: 'New task' }), { target: { value: 'Inspect selected machine' } })
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        expect(onStartTask).toHaveBeenCalledWith('m2')
        expect(loadNewTaskDraft('list-test-hub')).toBe('Inspect selected machine')
    })
    it('leaves machine choice to the creation page when the list has no explicit machine filter', () => {
        const { onStartTask } = mount([session('one', 'One task')])
        fireEvent.click(screen.getByRole('button', { name: 'New session options' }))
        expect(onStartTask).toHaveBeenCalledWith(undefined)
    })
    it('keeps the labeled unread filter functional', () => {
        const unread = session('manually-unread', 'Unread task', { updatedAt: 100 })
        markSessionUnread(unread.id, unread.updatedAt)
        const { container } = mount([unread, session('read', 'Read task', { updatedAt: 0 })])
        fireEvent.click(tabs(container).getByRole('button', { name: /Unread/ }))
        expect(screen.getByText('Unread task')).toBeTruthy()
        expect(screen.queryByText('Read task')).toBeNull()
    })
})
describe('Phone header action menu', () => {
    it('offers labeled actions and closes on selection and Escape', () => {
        const switchSession = vi.fn(), settings = vi.fn()
        render(<I18nProvider><SessionListHeaderActions onSwitch={switchSession} onBrowse={vi.fn()} onSettings={settings} onNew={vi.fn()} /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        expect(screen.getByRole('button', { name: 'Browse' })).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Switch session' }))
        expect(switchSession).toHaveBeenCalledOnce()
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
        fireEvent.keyDown(screen.getByRole('button', { name: 'Settings' }), { key: 'Escape' })
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    })
})
