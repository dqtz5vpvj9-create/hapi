import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ScratchlistDrawer } from './ScratchlistPanel'
import type { ComponentProps } from 'react'

let serial = 0
function setup(overrides: Partial<ComponentProps<typeof ScratchlistDrawer>> = {}) {
    const props = {
        sessionId: `recovery-${++serial}`,
        api: {} as never,
        entries: [{ id: 'note', text: 'Keep my draft', createdAt: 1 }],
        onMove: vi.fn(), onDelete: vi.fn(async () => {}),
        onPromoteToComposer: vi.fn(async () => {}),
        onPromoteToQueue: vi.fn(async () => true), onQueueComplete: vi.fn(),
        ...overrides,
    }
    const mount = () => render(<I18nProvider><ScratchlistDrawer {...props} /></I18nProvider>)
    return { props, mount, ...mount() }
}
afterEach(cleanup)
describe('scratchlist exceptional paths', () => {
    it('distinguishes loading and failed loading from an empty list', async () => {
        const first = setup({ entries: [], isLoading: true })
        expect(screen.getByRole('status')).toHaveTextContent('Loading scratchlist')
        expect(screen.queryByText(/No entries/)).toBeNull()
        first.unmount()
        const retry = vi.fn(async () => {})
        setup({ entries: [], loadError: true, onRetryLoad: retry })
        expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh')
        fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }))
        await waitFor(() => expect(retry).toHaveBeenCalledTimes(1))
    })
    it('keeps a rejected send and shows actionable feedback', async () => {
        const { props } = setup({ onPromoteToQueue: vi.fn(async () => false) })
        fireEvent.click(screen.getByRole('button', { name: 'Send to queue' }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not sent'))
        expect(props.onDelete).not.toHaveBeenCalled()
        expect(props.onQueueComplete).not.toHaveBeenCalled()
        expect(screen.getByText('Keep my draft')).toBeVisible()
    })
    it('retries only cleanup after accepted send, even after closing and reopening', async () => {
        const remove = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
        const first = setup({ onDelete: remove })
        fireEvent.click(screen.getByRole('button', { name: 'Send to queue' }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Already sent'))
        expect(first.props.onQueueComplete).not.toHaveBeenCalled()
        first.unmount()
        first.mount()
        expect(screen.getByText('Already queued · cleanup pending')).toBeVisible()
        expect(screen.getByText('cleanup pending', { exact: true })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' }))
        await waitFor(() => expect(first.props.onQueueComplete).toHaveBeenCalledTimes(1))
        expect(first.props.onPromoteToQueue).toHaveBeenCalledTimes(1)
        expect(remove).toHaveBeenCalledTimes(2)
    })
    it('locks rapid clicks and waits for deletion before leaving the drawer', async () => {
        let release!: () => void
        const removal = new Promise<void>(resolve => { release = resolve })
        const { props } = setup({ onDelete: vi.fn(() => removal) })
        const send = screen.getByRole('button', { name: 'Send to queue' })
        fireEvent.click(send)
        fireEvent.click(send)
        await waitFor(() => expect(props.onDelete).toHaveBeenCalledTimes(1))
        expect(props.onPromoteToQueue).toHaveBeenCalledTimes(1)
        expect(props.onQueueComplete).not.toHaveBeenCalled()
        await act(async () => { release() })
        expect(props.onQueueComplete).toHaveBeenCalledTimes(1)
    })
    it('shows delete and copy failures without discarding the note', async () => {
        setup({ onDelete: vi.fn(async () => { throw new Error('offline') }) })
        fireEvent.click(screen.getByRole('button', { name: 'Delete entry' }))
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Your note is still here'))
        expect(screen.getByText('Keep my draft')).toBeVisible()
    })
})
