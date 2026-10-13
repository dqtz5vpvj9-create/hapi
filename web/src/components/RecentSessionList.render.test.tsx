import { createContext, useContext, useState, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { RecentSessionList, useRecentRowRetention } from './RecentSessionList'

afterEach(cleanup)

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
const Presentation = createContext('initial')

function mount(items: SessionSummary[], renderSession: (session: SessionSummary) => ReactNode, selectedRootId?: string, options: { narrow?: boolean; fillEdgeWindow?: boolean; timeFor?: typeof timeFor } = {}) {
    const scroller = document.createElement('div')
    Object.defineProperties(scroller, {
        clientHeight: { value: 360 }, offsetHeight: { value: 360 }, offsetWidth: { value: 320 },
    })
    document.body.append(scroller)
    const view = (nextItems = items, nextRender = renderSession, presentation = 'initial') => (
        <I18nProvider><Presentation.Provider value={presentation}>
            <RecentSessionList sessions={nextItems} scrollElement={scroller} narrow={options.narrow ?? false} fillEdgeWindow={options.fillEdgeWindow}
                selectedRootId={selectedRootId} timeFor={options.timeFor ?? timeFor} renderSession={nextRender} />
        </Presentation.Provider></I18nProvider>
    )
    const result = render(view(), { container: scroller })
    return {
        ...result,
        update: (nextItems = items, nextRender = renderSession, presentation = 'initial') => result.rerender(view(nextItems, nextRender, presentation)),
        scroll: (top: number) => { scroller.scrollTop = top; fireEvent.scroll(scroller) },
        mountedIds: () => new Set(Array.from(scroller.querySelectorAll<HTMLElement>('[data-recent-root]'), row => row.dataset.recentRoot!)),
    }
}

describe('Recent stable row content', () => {
    it.each([100, 1000])('renders only entering rows during forward/reverse scrolling with %i sessions', count => {
        const items = sessions(count)
        const renderSession = vi.fn((session: SessionSummary) => <span>{session.metadata?.name}</span>)
        const list = mount(items, renderSession, `row-${count - 1}`)
        list.scroll(1440)
        for (const offset of [1512, 1440]) {
            const before = list.mountedIds()
            renderSession.mockClear()
            list.scroll(offset)
            const after = list.mountedIds()
            const entering = [...after].filter(id => !before.has(id))
            const rendered = renderSession.mock.calls.map(([session]) => session.id)
            expect(after.has(`row-${count - 1}`)).toBe(true)
            expect([...after].some(id => before.has(id))).toBe(true)
            expect(entering.length).toBeGreaterThan(0)
            expect(new Set(rendered)).toEqual(new Set(entering))
            expect(rendered).toHaveLength(entering.length)
        }
    })

    it('reuses wrappers while scrolling within an unchanged edge window', () => {
        const items = sessions(20)
        const dateFor = vi.fn(timeFor)
        const renderSession = vi.fn((session: SessionSummary) => <span>{session.metadata?.name}</span>)
        const list = mount(items, renderSession, undefined, { narrow: true, fillEdgeWindow: true, timeFor: dateFor })
        const before = list.mountedIds()
        expect(before.size).toBe(items.length)
        dateFor.mockClear()
        renderSession.mockClear()
        for (const offset of [72, 144, 72, 0]) list.scroll(offset)
        expect(list.mountedIds()).toEqual(before)
        expect(dateFor).not.toHaveBeenCalled()
        expect(renderSession).not.toHaveBeenCalled()

        const changed = items.map((session, index) => index === 1 ? { ...session, updatedAt: 1 } : session)
        list.update(changed)
        expect(dateFor).toHaveBeenCalled()
        expect(renderSession.mock.calls.map(([session]) => session.id)).toEqual(['row-1'])
    })

    it('refreshes changed session data without remounting its row', () => {
        const items = sessions(1000)
        const renderSession = vi.fn((session: SessionSummary) => <span>{session.id}: {session.pendingRequestsCount}</span>)
        const list = mount(items, renderSession)
        const root = list.container.querySelector('[data-recent-root="row-0"]')
        renderSession.mockClear()
        list.update(items.map((session, index) => index === 0 ? { ...session, pendingRequestsCount: 2 } : session))
        expect(screen.getByText('row-0: 2')).toBeTruthy()
        expect(list.container.querySelector('[data-recent-root="row-0"]')).toBe(root)
        expect(renderSession.mock.calls.map(([session]) => session.id)).toEqual(['row-0'])
    })

    it('honors a new renderer when selection or presentation changes with the same sessions', () => {
        const items = sessions(100)
        const renderer = (selected: string) => (session: SessionSummary) => (
            <button aria-current={session.id === selected ? 'page' : undefined}>{session.metadata?.name}</button>
        )
        const list = mount(items, renderer('row-0'))
        list.update(items, renderer('row-1'))
        expect(screen.getByRole('button', { name: 'Row 0' })).not.toHaveAttribute('aria-current')
        expect(screen.getByRole('button', { name: 'Row 1' })).toHaveAttribute('aria-current', 'page')
    })

    it('allows local expansion and context updates through the memo boundary', () => {
        function StatefulRow() {
            const [expanded, setExpanded] = useState(false)
            const presentation = useContext(Presentation)
            return <><button onClick={() => setExpanded(value => !value)}>Toggle children</button>
                {expanded ? <span>Child: {presentation}</span> : null}</>
        }
        const items = sessions(1)
        const renderSession = vi.fn(() => <StatefulRow />)
        const list = mount(items, renderSession)
        fireEvent.click(screen.getByRole('button', { name: 'Toggle children' }))
        expect(screen.getByText('Child: initial')).toBeTruthy()
        renderSession.mockClear()
        list.update(items, renderSession, 'updated')
        expect(screen.getByText('Child: updated')).toBeTruthy()
        expect(renderSession).not.toHaveBeenCalled()
    })

    it('keeps a dialog owner mounted offscreen until the dialog closes', () => {
        function DialogRow({ session }: { session: SessionSummary }) {
            const [open, setOpen] = useState(false)
            useRecentRowRetention(session.id, open)
            return <><button onClick={() => setOpen(true)}>Open {session.id}</button>
                {open ? <div role="dialog"><button onClick={() => setOpen(false)}>Close dialog</button></div> : null}</>
        }
        const list = mount(sessions(1000), session => <DialogRow session={session} />)
        fireEvent.click(screen.getByRole('button', { name: 'Open row-0' }))
        const owner = list.container.querySelector('[data-recent-root="row-0"]')
        list.scroll(18000)
        expect(screen.getByRole('dialog')).toBeTruthy()
        expect(list.container.querySelector('[data-recent-root="row-0"]')).toBe(owner)
        fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(list.container.querySelector('[data-recent-root="row-0"]')).toBeNull()
    })
})
