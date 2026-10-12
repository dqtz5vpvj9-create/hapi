import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ForkOperationController, ForkOperationView } from '@/lib/fork-operation'
import { ForkOperationBanner } from './ForkOperationBanner'

const operation = { operationId: '00000000-0000-4000-8000-000000000001', sourceSessionId: 'source',
    childSessionId: 'child', sourceRevision: 1, message: 'Server detail', updatedAt: 1 }
function show(view: Partial<ForkOperationView>, sourceActive = true) {
    const controller = { check: vi.fn(), reconcile: vi.fn(), open: vi.fn(), cancelNavigation: vi.fn(), sendOriginal: vi.fn(), openOriginalSource: vi.fn(), createAnother: vi.fn(async () => {}), closeUnadmitted: vi.fn(async () => {}) }
    render(<I18nProvider><ForkOperationBanner controller={controller as unknown as ForkOperationController}
        view={{ revision: 1, busy: false, sourceStateVerified: true, ...view }} sourceActive={sourceActive} /></I18nProvider>)
    return controller
}
beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('fork operation recovery banner', () => {
    it.each([
        { ...operation, status: 'indeterminate' as const },
        { ...operation, status: 'created' as const, nativeThreadId: 'native-child', binding: 'ready' as const },
        { ...operation, status: 'rejected' as const, rejectionProof: 'not_dispatched' as const, code: 'fork_source_unresolved' },
    ])('keeps the $status diagnostics on an opaque, wrapping notice surface', (receipt) => {
        show({ operation: receipt })
        const banner = screen.getByTestId('fork-operation-banner')
        // Real geometry/inset coverage lives in the actual-App browser suite;
        // jsdom protects the material choice that caused text to bleed through.
        expect(banner).toHaveClass('bg-[var(--app-dialog-bg)]', 'border', 'break-words')
        expect(banner).not.toHaveClass('bg-[var(--app-subtle-bg)]', 'truncate', 'overflow-hidden')
        expect(banner).toHaveTextContent('Server detail')
        expect(within(banner).getByRole('button', { name: 'Check result' })).toBeVisible()
        expect(banner).toHaveTextContent(`Request ID: ${operation.operationId}`)
    })
    it('labels identity-unknown honestly and only offers checking the result', () => {
        const controller = show({ operation: { ...operation, status: 'indeterminate' } })
        expect(screen.getByText('Fork result unconfirmed. This request will not be sent again automatically.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Check result' }))
        expect(controller.check).toHaveBeenCalledOnce()
        expect(screen.queryByRole('button', { name: /retry|fork again|recover|open fork/i })).not.toBeInTheDocument()
    })
    it('keeps a lost-response intent visible after reload without inventing a child', () => {
        show({ intent: { operationId: operation.operationId, expectedForkRevision: 0 }, error: 'offline' })
        expect(screen.getByRole('alert')).toHaveTextContent('offline')
        expect(screen.getByTestId('fork-operation-banner')).toHaveTextContent('result unconfirmed')
        expect(screen.queryByRole('button', { name: 'Open fork' })).not.toBeInTheDocument()
    })
    it('offers binding-only recovery for a known child', () => {
        const controller = show({ operation: { ...operation, status: 'created', nativeThreadId: 'native-child', binding: 'blocked' } })
        fireEvent.click(screen.getByRole('button', { name: 'Recover conversation binding' }))
        expect(controller.reconcile).toHaveBeenCalledOnce()
        expect(screen.queryByRole('button', { name: 'Open fork' })).not.toBeInTheDocument()
    })
    it('opens the ready child explicitly', () => {
        const controller = show({ operation: { ...operation, status: 'created', nativeThreadId: 'native-child', binding: 'ready' } })
        fireEvent.click(screen.getByRole('button', { name: 'Open fork' }))
        expect(controller.open).toHaveBeenCalledOnce()
    })
    it('offers staying in the source while a finite request is pending', () => {
        const controller = show({ busy: true, intent: { operationId: operation.operationId, expectedForkRevision: 0 } })
        expect(screen.getByRole('button', { name: 'Checking fork status…' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Stay in this conversation' }))
        expect(controller.cancelNavigation).toHaveBeenCalledOnce()
    })
    it('shows a copyable original request ID and reconnect guidance for an inactive source', () => {
        show({ operation: { ...operation, status: 'indeterminate' } }, false)
        expect(screen.getByText(`Request ID: ${operation.operationId}`)).toBeInTheDocument()
        expect(screen.getByText(/Reconnect the original source session/)).toBeInTheDocument()
    })
    it('does not claim that a fork was attempted when the initial state read failed', () => {
        show({ error: 'offline' })
        expect(screen.getByText(/Could not check fork state/)).toBeInTheDocument()
        expect(screen.queryByText(/Fork result unconfirmed/)).not.toBeInTheDocument()
    })

    it('offers an explicitly original-ID submission only after a missing-receipt check', () => {
        const controller = show({ intent: { operationId: operation.operationId, expectedForkRevision: 0 }, notObserved: true })
        expect(screen.getByText(/The server has not reported this request yet/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Send original request' }))
        expect(controller.sendOriginal).toHaveBeenCalledOnce()
    })
    it('never offers original-request submission for a known indeterminate operation', () => {
        show({ intent: { operationId: operation.operationId, expectedForkRevision: 0 }, operation: { ...operation, status: 'indeterminate' }, notObserved: true })
        expect(screen.queryByRole('button', { name: 'Send original request' })).not.toBeInTheDocument()
    })

    it('shows a separate original-source fence and navigation action without inventing a child', () => {
        const controller = show({ blockingSourceSessionId: 'original-source', sourceMessage: 'Check the original source.' })
        expect(screen.getByText('Check the original source.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Open original source' }))
        expect(controller.openOriginalSource).toHaveBeenCalledOnce()
        expect(screen.queryByRole('button', { name: 'Send original request' })).not.toBeInTheDocument()
    })

    it('requires a separate warning confirmation and cancel never dispatches', async () => {
        const controller = show({ operation: { ...operation, status: 'indeterminate' }, sourceHeadId: operation.operationId })
        fireEvent.click(screen.getByRole('button', { name: 'Create another fork anyway' }))
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText(/previous fork may already have succeeded/)).toBeInTheDocument()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(controller.createAnother).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Create another fork anyway' }))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create another fork anyway' }))
        await waitFor(() => expect(controller.createAnother).toHaveBeenCalledExactlyOnceWith({ operationId: operation.operationId, revision: 1 }))
    })
    it('does not expose risk creation for unverified or known-created receipts', () => {
        show({ operation: { ...operation, status: 'indeterminate' } })
        expect(screen.queryByRole('button', { name: 'Create another fork anyway' })).not.toBeInTheDocument()
    })

    it('requires a separate close confirmation, warns about the original request in transit, and cancel sends nothing', async () => {
        const controller = show({ operation: { ...operation, status: 'indeterminate' }, sourceHeadId: operation.operationId })
        fireEvent.click(screen.getByRole('button', { name: 'Close request if it has not started' }))
        let dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText('Close this request only if it has not started?')).toBeInTheDocument()
        expect(dialog).toHaveTextContent('can prevent an original request that is still on its way from starting')
        expect(dialog).toHaveTextContent('will not cancel a request that the source runtime has already accepted or dispatched')
        expect(dialog).toHaveTextContent(operation.operationId)
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(controller.closeUnadmitted).not.toHaveBeenCalled()
        expect(controller.createAnother).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Close request if it has not started' }))
        dialog = screen.getByRole('dialog')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close request if it has not started' }))
        await waitFor(() => expect(controller.closeUnadmitted).toHaveBeenCalledExactlyOnceWith({ operationId: operation.operationId, revision: 1 }))
        expect(controller.createAnother).not.toHaveBeenCalled()
        expect(controller.sendOriginal).not.toHaveBeenCalled()
    })

    it('retains the close dialog’s captured ID and revision if the current head changes', async () => {
        const controller = { closeUnadmitted: vi.fn(async () => {}) } as unknown as ForkOperationController
        const initial = { revision: 1, busy: false, sourceStateVerified: true, sourceHeadId: operation.operationId,
            operation: { ...operation, status: 'indeterminate' as const } }
        const { rerender } = render(<I18nProvider><ForkOperationBanner controller={controller} view={initial} /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Close request if it has not started' }))
        const nextId = '00000000-0000-4000-8000-000000000002'
        rerender(<I18nProvider><ForkOperationBanner controller={controller} view={{ ...initial, revision: 2,
            sourceHeadId: nextId, operation: { ...initial.operation, operationId: nextId } }} /></I18nProvider>)
        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveTextContent(operation.operationId)
        expect(dialog).not.toHaveTextContent(nextId)
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close request if it has not started' }))
        await waitFor(() => expect(controller.closeUnadmitted).toHaveBeenCalledExactlyOnceWith({ operationId: operation.operationId, revision: 1 }))
    })

    it.each([
        { operation: { ...operation, status: 'indeterminate' as const }, sourceStateVerified: false },
        { intent: { operationId: operation.operationId, expectedForkRevision: 0 } },
        { blockingSourceSessionId: 'other-source' },
        { operation: { ...operation, status: 'running' as const }, sourceHeadId: operation.operationId },
    ])('does not offer closing without a verified same-source indeterminate head (%j)', view => {
        show(view)
        expect(screen.queryByRole('button', { name: 'Close request if it has not started' })).not.toBeInTheDocument()
    })

    it.each([
        ['closed', 'This request was closed before the source runtime accepted it.'],
        ['already_admitted', 'It was not closed or cancelled.'],
        ['already_resolved', 'This request already has a definite result.'],
        ['unavailable', 'Could not confirm that this request can be closed.'],
    ] as const)('clearly explains the %s close outcome with its exact target and server reason', (result, text) => {
        show({ operation: { ...operation, status: 'indeterminate' }, closure: {
            operationId: '00000000-0000-4000-8000-000000000002', result, message: 'Specific source-runtime explanation.',
        } })
        const feedback = screen.getByTestId('fork-close-result')
        expect(feedback).toHaveTextContent(text)
        expect(feedback).toHaveTextContent('00000000-0000-4000-8000-000000000002')
        expect(feedback).toHaveTextContent('Specific source-runtime explanation.')
        expect(screen.getByTestId('fork-operation-banner')).toHaveClass('bg-[var(--app-dialog-bg)]')
    })

    it('explains an external terminal fork fence without pretending to recover or bypass it', () => {
        show({ operation: { ...operation, status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_source_unresolved',
            message: 'Original operation: terminal-operation-id; origin: native terminal.' }, sourceHeadId: operation.operationId })
        expect(screen.getByText(/Web cannot release that operation/)).toBeInTheDocument()
        expect(screen.getByText(/terminal-operation-id/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Create another fork anyway' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Send original request' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Recover conversation binding' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Close request if it has not started' })).not.toBeInTheDocument()
    })

})
