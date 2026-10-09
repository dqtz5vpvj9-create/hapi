import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexSessionSyncDialog } from './CodexSessionSyncDialog'
import type { CodexLocalSessionSummary } from '@/types/api'

function renderDialog(
    sessions: CodexLocalSessionSummary[] = [],
    onConfirm = vi.fn(async () => {}),
    currentCodexSessionId: string | null = null,
    onRestartCodexDesktop = vi.fn(async () => {}),
    currentWorkDirectory: string | null = null
) {
    const view = render(
        <I18nProvider>
            <CodexSessionSyncDialog
                isOpen={true}
                onClose={vi.fn()}
                sessions={sessions}
                currentCodexSessionId={currentCodexSessionId}
                currentWorkDirectory={currentWorkDirectory}
                onConfirm={onConfirm}
                onRestartCodexDesktop={onRestartCodexDesktop}
                isPending={false}
                isRestartingCodexDesktop={false}
                isLoading={false}
            />
        </I18nProvider>
    )
    return { ...view, onConfirm, onRestartCodexDesktop }
}

describe('CodexSessionSyncDialog', () => {
    afterEach(() => {
        cleanup()
        window.localStorage.clear()
    })

    it('offers to resume a saved session and confirms its native ID', async () => {
        const onConfirm = vi.fn(async () => {})
        render(<I18nProvider><CodexSessionSyncDialog
            isOpen onClose={vi.fn()} mode="connect" selectionMode="single"
            sessions={[{ id: 'saved-thread', title: 'o-debug', cwd: '/android', file: 'saved.jsonl', modifiedAt: Date.now(), connectionState: 'history' }]}
            currentCodexSessionId={null} onConfirm={onConfirm} isPending={false} isLoading={false}
            onRestartCodexDesktop={vi.fn(async () => {})} isRestartingCodexDesktop={false}
        /></I18nProvider>)
        expect(screen.getByText('Saved session · resumes when opened')).toBeInTheDocument()
        fireEvent.click(screen.getByText('o-debug'))
        fireEvent.click(screen.getByRole('button', { name: 'Resume and open' }))
        await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(['saved-thread']))
    })

    it('keeps remote search editable while loading and after an empty result, and offers the next page', () => {
        const search = vi.fn()
        const more = vi.fn()
        const props = { isOpen: true, onClose: vi.fn(), sessions: [], currentCodexSessionId: null,
            onConfirm: vi.fn(), onRestartCodexDesktop: vi.fn(), isPending: false,
            isRestartingCodexDesktop: false, isLoading: true, onSearchChange: search, hasMore: true, onLoadMore: more }
        const view = render(<I18nProvider><CodexSessionSyncDialog {...props} /></I18nProvider>)
        const input = screen.getByRole('searchbox')
        expect(input).toBeEnabled()
        fireEvent.change(input, { target: { value: 'o-debug' } })
        expect(search).toHaveBeenCalledWith('o-debug', null)
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} isLoading={false} /></I18nProvider>)
        expect(screen.getByRole('searchbox')).toHaveValue('o-debug')
        expect(screen.getByText('No Codex sessions match this search')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
        expect(more).toHaveBeenCalledOnce()
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
        expect(search).toHaveBeenLastCalledWith('', null)
    })

    it('loads older sessions near the end of the list and waits for the current page to finish', () => {
        const more = vi.fn()
        const props = { isOpen: true, onClose: vi.fn(), sessions: [], currentCodexSessionId: null,
            onConfirm: vi.fn(), onRestartCodexDesktop: vi.fn(), isPending: false,
            isRestartingCodexDesktop: false, isLoading: false, hasMore: true, onLoadMore: more }
        const view = render(<I18nProvider><CodexSessionSyncDialog {...props} /></I18nProvider>)
        const list = screen.getByTestId('codex-session-scroll')
        Object.defineProperties(list, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } })
        fireEvent.scroll(list, { target: { scrollTop: 100 } })
        expect(more).not.toHaveBeenCalled()
        fireEvent.scroll(list, { target: { scrollTop: 550 } })
        expect(more).toHaveBeenCalledOnce()
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} isLoading /></I18nProvider>)
        fireEvent.scroll(list, { target: { scrollTop: 600 } })
        expect(more).toHaveBeenCalledOnce()
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} hasMore={false} /></I18nProvider>)
        fireEvent.scroll(list, { target: { scrollTop: 600 } })
        expect(more).toHaveBeenCalledOnce()
    })

    it('shows list failures with a retry action instead of an empty list', () => {
        const retry = vi.fn()
        render(<I18nProvider><CodexSessionSyncDialog isOpen onClose={vi.fn()} sessions={[]} currentCodexSessionId={null}
            onConfirm={vi.fn()} onRestartCodexDesktop={vi.fn()} isPending={false} isRestartingCodexDesktop={false}
            isLoading={false} error="Runner unavailable" onRetry={retry} /></I18nProvider>)
        expect(screen.getByRole('alert')).toHaveTextContent('Runner unavailable')
        expect(screen.queryByText('No local Codex sessions found')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(retry).toHaveBeenCalledOnce()
        expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    })

    it('drops a selection removed from the current list and prevents connecting it', () => {
        const onConfirm = vi.fn(async () => {})
        const session = { id: 'native-1', title: 'Windows thread', file: 'thread.jsonl', modifiedAt: 1, connectionState: 'attached' as const }
        const props = { isOpen: true, onClose: vi.fn(), mode: 'connect' as const, selectionMode: 'single' as const,
            currentCodexSessionId: null, onConfirm, onRestartCodexDesktop: vi.fn(), isPending: false,
            isRestartingCodexDesktop: false, isLoading: false }
        const view = render(<I18nProvider><CodexSessionSyncDialog {...props} sessions={[session]} /></I18nProvider>)
        fireEvent.click(screen.getByRole('radio', { name: session.title }))
        expect(screen.getByRole('button', { name: 'Connect and open' })).toBeEnabled()
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} sessions={[]} /></I18nProvider>)
        expect(screen.getByText('0 sessions selected')).toBeInTheDocument()
        const confirm = screen.getByRole('button', { name: 'Connect and open' })
        expect(confirm).toBeDisabled()
        fireEvent.click(confirm)
        expect(onConfirm).not.toHaveBeenCalled()
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} sessions={[session]} /></I18nProvider>)
        expect(screen.getByRole('radio', { name: session.title })).not.toBeChecked()
    })

    it('keeps a selected earlier page while loading more and rejects a thread that becomes unavailable', () => {
        const session = { id: 'native-1', title: 'Windows thread', file: 'thread.jsonl', modifiedAt: 1, connectionState: 'attached' as const }
        const props = { isOpen: true, onClose: vi.fn(), mode: 'connect' as const, selectionMode: 'single' as const,
            currentCodexSessionId: null, onConfirm: vi.fn(), onRestartCodexDesktop: vi.fn(), isPending: false,
            isRestartingCodexDesktop: false }
        const view = render(<I18nProvider><CodexSessionSyncDialog {...props} sessions={[session]} isLoading={false} /></I18nProvider>)
        fireEvent.click(screen.getByRole('radio', { name: session.title }))
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} sessions={[session]} isLoading /></I18nProvider>)
        expect(screen.getByRole('radio', { name: session.title })).toBeChecked()
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} sessions={[session, { ...session, id: 'native-2', title: 'Older thread' }]} isLoading={false} /></I18nProvider>)
        expect(screen.getByRole('button', { name: 'Connect and open' })).toBeEnabled()
        view.rerender(<I18nProvider><CodexSessionSyncDialog {...props} sessions={[{ ...session, connectionState: 'unavailable' }]} isLoading={false} /></I18nProvider>)
        expect(screen.getByText('0 sessions selected')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Connect and open' })).toBeDisabled()
    })

    it('shows the working directory for local Codex sessions', () => {
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Session title',
                lastUserMessage: 'Last prompt',
                cwd: '/home/user/project',
                file: '/home/user/.codex/sessions/session.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                originator: 'codex_cli',
                cliVersion: '0.124.0'
            }
        ])

        expect(screen.getByText('Working directory')).toBeInTheDocument()
        expect(screen.getAllByText('/home/user/project')).toHaveLength(2)
    })


    it('defaults the work directory filter to the current session directory when available', () => {
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.codex/sessions/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'codex-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.codex/sessions/two.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5)
            }
        ], undefined, null, undefined, '/home/user/project-two')

        expect(screen.queryByText('Project one')).not.toBeInTheDocument()
        expect(screen.getByText('Project two')).toBeInTheDocument()
        expect(screen.getByLabelText('Work directory')).toHaveValue('/home/user/project-two')
    })

    it('keeps all work directories when the current session directory is not in Codex sessions', () => {
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.codex/sessions/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            }
        ], undefined, null, undefined, '/home/user/project-missing')

        expect(screen.getByText('Project one')).toBeInTheDocument()
        expect(screen.getByLabelText('Work directory')).toHaveValue('__all__')
    })

    it('filters sessions by working directory', () => {
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.codex/sessions/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'codex-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.codex/sessions/two.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5)
            }
        ])

        fireEvent.change(screen.getByLabelText('Work directory'), {
            target: { value: '/home/user/project-two' }
        })

        expect(screen.queryByText('Project one')).not.toBeInTheDocument()
        expect(screen.getByText('Project two')).toBeInTheDocument()
    })

    it('selects only filtered sessions when selecting all', async () => {
        const onConfirm = vi.fn(async () => {})
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.codex/sessions/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'codex-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.codex/sessions/two.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5)
            }
        ], onConfirm)

        fireEvent.change(screen.getByLabelText('Work directory'), {
            target: { value: '/home/user/project-two' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Select all' }))

        await waitFor(() => {
            expect(screen.getByText('1 sessions selected')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()
        })

        fireEvent.click(screen.getByRole('button', { name: 'Import' }))

        expect(onConfirm).toHaveBeenCalledWith(['codex-session-2'])
    })

    it('replaces hidden selections when selecting all filtered sessions', async () => {
        const onConfirm = vi.fn(async () => {})
        renderDialog([
            {
                id: 'codex-session-1',
                title: 'Project one',
                cwd: '/home/user/project-one',
                file: '/home/user/.codex/sessions/one.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
            },
            {
                id: 'codex-session-2',
                title: 'Project two',
                cwd: '/home/user/project-two',
                file: '/home/user/.codex/sessions/two.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5)
            }
        ], onConfirm, 'codex-session-1')

        await waitFor(() => {
            expect(screen.getByText('1 sessions selected')).toBeInTheDocument()
        })

        fireEvent.change(screen.getByLabelText('Work directory'), {
            target: { value: '/home/user/project-two' }
        })
        fireEvent.click(screen.getByRole('button', { name: 'Select all' }))

        await waitFor(() => {
            expect(screen.getByText('1 sessions selected')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()
        })

        fireEvent.click(screen.getByRole('button', { name: 'Import' }))

        expect(onConfirm).toHaveBeenCalledWith(['codex-session-2'])
    })


    it('opens archive menu on context menu and archives the selected Codex session', async () => {
        const onArchiveSession = vi.fn(async () => {})
        render(
            <I18nProvider>
                <CodexSessionSyncDialog
                    isOpen={true}
                    onClose={vi.fn()}
                    sessions={[
                        {
                            id: 'codex-session-1',
                            title: 'Session title',
                            cwd: '/home/user/project',
                            file: '/home/user/.codex/sessions/session.jsonl',
                            modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5)
                        }
                    ]}
                    currentCodexSessionId={null}
                    onConfirm={vi.fn(async () => {})}
                    onRestartCodexDesktop={vi.fn(async () => {})}
                    onArchiveSession={onArchiveSession}
                    isPending={false}
                    isRestartingCodexDesktop={false}
                    isLoading={false}
                />
            </I18nProvider>
        )

        fireEvent.contextMenu(screen.getByText('Session title'))
        fireEvent.click(await screen.findByRole('button', { name: 'Archive in Codex' }))

        await waitFor(() => {
            expect(onArchiveSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'codex-session-1' }))
        })
    })

    it('keeps the restart control clear of the close button area', () => {
        renderDialog()

        const header = screen.getByTestId('codex-import-dialog-header')
        expect(header).toHaveClass('flex')
        expect(header).toHaveClass('flex-col', 'sm:flex-row')
        expect(screen.getByRole('button', { name: 'Restart Codex client' })).toHaveClass('shrink-0')
    })

    it('restarts Codex Desktop from the header control', () => {
        const onRestartCodexDesktop = vi.fn(async () => {})
        renderDialog([], undefined, null, onRestartCodexDesktop)

        fireEvent.click(screen.getByRole('button', { name: 'Restart Codex client' }))

        expect(onRestartCodexDesktop).toHaveBeenCalledTimes(1)
    })

    it('shows imported badge on original session and fork badge on forked session', () => {
        window.localStorage.setItem('hapi.codexImportedSessions', JSON.stringify({
            'original-session-id': Date.now()
        }))

        renderDialog([
            {
                id: 'fork-session-id',
                title: 'Fork session',
                cwd: '/home/user/project',
                file: '/home/user/.codex/sessions/fork.jsonl',
                modifiedAt: Date.UTC(2026, 0, 3, 3, 4, 5),
                originator: 'hapi-codex-client',
                cliVersion: '0.142.3',
                source: 'vscode',
                forkedFromId: 'original-session-id'
            },
            {
                id: 'original-session-id',
                title: 'Original session',
                cwd: '/home/user/project',
                file: '/home/user/.codex/sessions/original.jsonl',
                modifiedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                originator: 'Codex Desktop',
                cliVersion: '0.142.2',
                source: 'vscode',
                threadSource: 'user'
            }
        ])

        expect(screen.getByText('Original')).toBeInTheDocument()
        expect(screen.getByText('Imported')).toBeInTheDocument()
        expect(screen.getByText('Fork')).toBeInTheDocument()
    })
})
