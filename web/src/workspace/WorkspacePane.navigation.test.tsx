import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { WorkspacePane } from './WorkspacePane'
import { usePane, type PaneContextValue } from './PaneContext'
import { WorkspaceStore } from './workspaceStore'

const mocks = vi.hoisted(() => ({ routeNavigate: vi.fn(), navigate: null as PaneContextValue['navigate'] | null }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.routeNavigate }))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: null }) }))
vi.mock('@/hooks/queries/useSession', () => ({ useSession: (_api: unknown, id: string) => ({ session: { id, active: true, metadata: { path: '/synthetic/project', machineId: 'fixture-machine' } } }) }))
vi.mock('@/hooks/useSelectedSessionSeen', () => ({ useSelectedSessionSeen: () => {} }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/SessionWorkspace', () => ({
    SessionWorkspace: (props: { open: boolean; view: string; onSelect: (view: 'changes' | 'directories') => void; onClose: () => void; chat: ReactNode; panel: ReactNode }) => <div>
        {props.chat}
        <button onClick={() => props.onSelect('changes')}>Code changes</button>
        <button onClick={() => props.onSelect('directories')}>Project files</button>
        {props.open ? <section data-testid="tool" data-view={props.view}><button onClick={props.onClose}>Close project</button>{props.panel}</section> : null}
    </div>,
}))
vi.mock('@/components/SessionPaneController', () => ({
    SessionPaneController: () => { const pane = usePane()!; mocks.navigate = pane.navigate; return <div>Chat {pane.sessionId}</div> },
}))
vi.mock('@/routes/sessions/files', () => ({
    SessionFiles: (props: { search: { tab?: string; query?: string; target?: string }; revealKey?: number }) => <div data-testid="list" data-tab={props.search.tab} data-query={props.search.query ?? ''} data-target={props.search.target ?? ''} data-reveal={props.revealKey} />,
}))
vi.mock('@/routes/sessions/file', () => ({
    SessionFile: (props: { sessionId: string; search: { staged?: boolean }; onBack: () => void }) => <div data-testid="diff" data-session={props.sessionId} data-staged={String(props.search.staged)}><button onClick={props.onBack}>File Back</button></div>,
}))
vi.mock('@/routes/sessions/terminal', () => ({ SessionTerminal: () => null }))
vi.mock('@/documents/DocumentSurface', () => ({ DocumentSurface: () => <div>Document surface</div> }))

function setup() {
    const store = new WorkspaceStore('changes-test')
    store.enter('A')
    const pane = store.focusedPane()!
    const ui = (current = store.focusedPane()!) => <WorkspacePane pane={current} focused store={store} pickSession={() => {}} />
    const rendered = render(ui())
    return { store, pane, rerender: () => rendered.rerender(ui()) }
}
async function navigate(
    to: '/sessions/$sessionId/file' | '/sessions/$sessionId/files',
    search: { path?: string; staged?: boolean; tab?: 'changes' | 'directories'; query?: string; target?: string },
) {
    await act(async () => {
        if (to === '/sessions/$sessionId/file') {
            await mocks.navigate!({ to, params: { sessionId: 'A' }, search: { ...search, path: search.path ?? '' } })
        } else {
            await mocks.navigate!({ to, params: { sessionId: 'A' }, search: { tab: search.tab, query: search.query, target: search.target } })
        }
    })
}

beforeEach(() => { localStorage.clear(); mocks.routeNavigate.mockReset(); mocks.navigate = null })

describe('WorkspacePane diff return origin', () => {
    it('reveals and replaces unsupported file targets inside the originating pane', async () => {
        setup()
        await navigate('/sessions/$sessionId/files', { tab: 'directories', target: 'build/image.tar.gz' })
        expect(screen.getByTestId('list')).toHaveAttribute('data-target', 'build/image.tar.gz')
        expect(screen.getByTestId('list')).toHaveAttribute('data-tab', 'directories')
        const reveal = screen.getByTestId('list').getAttribute('data-reveal')
        await navigate('/sessions/$sessionId/files', { tab: 'directories', target: 'build/image.tar.gz' })
        expect(screen.getByTestId('list').getAttribute('data-reveal')).not.toBe(reveal)
        expect(screen.queryByText('Document surface')).toBeNull()
        expect(mocks.routeNavigate).not.toHaveBeenCalled()
        await navigate('/sessions/$sessionId/files', { tab: 'directories', target: 'other/image.custom' })
        expect(screen.getByTestId('list')).toHaveAttribute('data-target', 'other/image.custom')
        fireEvent.click(screen.getByRole('button', { name: 'Close project' }))
        fireEvent.click(screen.getByRole('button', { name: 'Project files' }))
        expect(screen.getByTestId('list')).toHaveAttribute('data-target', '')
    })

    it('retains the target across a diff and its Back action', async () => {
        setup()
        await navigate('/sessions/$sessionId/files', { tab: 'directories', target: 'build/image.tar.gz' })
        await navigate('/sessions/$sessionId/file', { path: btoa('README.md'), staged: false })
        fireEvent.click(screen.getByRole('button', { name: 'File Back' }))
        expect(screen.getByTestId('list')).toHaveAttribute('data-target', 'build/image.tar.gz')
    })
    it.each([true, false])('returns staged=%s diffs to their changes list', async staged => {
        setup()
        fireEvent.click(screen.getByRole('button', { name: 'Code changes' }))
        await navigate('/sessions/$sessionId/file', { path: btoa('shared.ts'), staged })
        expect(screen.getByTestId('diff')).toHaveAttribute('data-staged', String(staged))
        fireEvent.click(screen.getByRole('button', { name: 'File Back' }))
        expect(screen.getByTestId('list')).toHaveAttribute('data-tab', 'changes')
        expect(mocks.routeNavigate).not.toHaveBeenCalled()
    })

    it('preserves the list search that opened the diff', async () => {
        setup()
        await navigate('/sessions/$sessionId/files', { tab: 'changes', query: 'shared' })
        await navigate('/sessions/$sessionId/file', { path: btoa('shared.ts'), staged: false, query: 'shared' })
        fireEvent.click(screen.getByRole('button', { name: 'File Back' }))
        expect(screen.getByTestId('list')).toHaveAttribute('data-tab', 'changes')
        expect(screen.getByTestId('list')).toHaveAttribute('data-query', 'shared')
    })

    it('uses explicit directories origin and replaces it after close and reopen', async () => {
        setup()
        await navigate('/sessions/$sessionId/file', { path: btoa('shared.ts'), staged: false, tab: 'directories', query: 'shared' })
        fireEvent.click(screen.getByRole('button', { name: 'File Back' }))
        expect(screen.getByTestId('list')).toHaveAttribute('data-tab', 'directories')
        expect(screen.getByTestId('list')).toHaveAttribute('data-query', 'shared')
        fireEvent.click(screen.getByRole('button', { name: 'Close project' }))
        fireEvent.click(screen.getByRole('button', { name: 'Code changes' }))
        await navigate('/sessions/$sessionId/file', { path: btoa('other.ts'), staged: true })
        fireEvent.click(screen.getByRole('button', { name: 'File Back' }))
        expect(screen.getByTestId('list')).toHaveAttribute('data-tab', 'changes')
        expect(screen.getByTestId('list')).toHaveAttribute('data-query', '')
    })

    it('defaults direct diff navigation to changes and clears it when a session is rebound', async () => {
        const { store, pane, rerender } = setup()
        await navigate('/sessions/$sessionId/file', { path: btoa('shared.ts'), staged: false })
        fireEvent.click(screen.getByRole('button', { name: 'File Back' }))
        expect(screen.getByTestId('list')).toHaveAttribute('data-tab', 'changes')
        act(() => { store.bind(pane.id, { kind: 'chat', sessionId: 'B' }, 'A'); rerender() })
        expect(screen.queryByTestId('tool')).not.toBeInTheDocument()
        expect(screen.getByText('Chat B')).toBeInTheDocument()
    })

    it('keeps ordinary project files on the document navigation path', async () => {
        const { store, pane } = setup()
        const openDocument = vi.spyOn(store, 'openDocument')
        fireEvent.click(screen.getByRole('button', { name: 'Project files' }))
        await navigate('/sessions/$sessionId/file', { path: btoa('plain.ts'), tab: 'directories', query: 'plain' })
        expect(openDocument).toHaveBeenCalledWith(pane.id, pane.resource, { kind: 'document', sessionId: 'A', document: { kind: 'file', path: '/synthetic/project/plain.ts', machineId: 'fixture-machine' } })
        expect(screen.queryByTestId('diff')).not.toBeInTheDocument()
        expect(screen.queryByTestId('tool')).not.toBeInTheDocument()
    })
})
