import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionList } from './SessionList'

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    localStorage.removeItem('hapi.sessionListView')
    localStorage.removeItem('hapi-session-preview-limit')
    localStorage.removeItem('hapi-pin-in-progress-sessions')
})

beforeEach(() => {
    // jsdom has no matchMedia; the un-stubbed hook reports a wide viewport.
    localStorage.clear()
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

const sessions = [makeSession({
    id: 'session-1',
    updatedAt: 100,
    metadata: { path: '/work/hapi', name: 'Task', flavor: 'codex' },
})]

function renderList(onRefresh: () => Promise<unknown> | void) {
    return renderWithProviders(
        <SessionList
            sessions={sessions}
            selectedSessionId={null}
            onSelect={vi.fn()}
            onNewSession={vi.fn()}
            onRefresh={onRefresh}
            isLoading={false}
            renderHeader={false}
            api={null}
        />
    )
}

describe('SessionList desktop refresh button', () => {
    it('refreshes the list and reports progress', async () => {
        let finishRefresh!: () => void
        const onRefresh = vi.fn(() => new Promise<void>(resolve => { finishRefresh = resolve }))
        renderList(onRefresh)

        const refresh = screen.getByRole('button', { name: 'Refresh sessions' })
        expect(refresh).toBeEnabled()
        expect(refresh).toHaveAttribute('aria-busy', 'false')

        fireEvent.click(refresh)
        expect(onRefresh).toHaveBeenCalledTimes(1)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeDisabled())
        expect(screen.getByRole('button', { name: 'Refresh sessions' })).toHaveAttribute('aria-busy', 'true')
        expect(screen.getByText('Refreshing…')).toBeInTheDocument()

        // A second click while the request is in flight must not duplicate it.
        fireEvent.click(screen.getByRole('button', { name: 'Refresh sessions' }))
        expect(onRefresh).toHaveBeenCalledTimes(1)

        finishRefresh()
        await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeEnabled())
        expect(screen.queryByText('Refreshing…')).toBeNull()
    })

    it('stays available when the list is empty', () => {
        // The app always supplies header actions, so the toolbar (and its
        // refresh control) stays mounted while the list waits for its first rows.
        renderWithProviders(
            <SessionList sessions={[]} selectedSessionId={null} onSelect={vi.fn()} onNewSession={vi.fn()}
                onRefresh={vi.fn()} isLoading={false} renderHeader={false} api={null}
                headerActions={<button type="button">More</button>} />
        )
        expect(screen.getByRole('button', { name: 'Refresh sessions' })).toBeEnabled()
    })

    it('stays with the pull gesture on narrow viewports', () => {
        vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
            matches: query === '(max-width: 640px)',
            media: query,
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })))
        renderList(vi.fn())
        expect(screen.queryByRole('button', { name: 'Refresh sessions' })).toBeNull()
    })
})
