import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { NativeRuntimeState } from '@hapi/protocol/schemas'
import { WorkspaceActivity } from './WorkspaceActivity'

afterEach(cleanup)
describe('workspace authoritative status', () => {
    it('uses execution and waiting state before a legacy thinking hint', () => {
        localStorage.clear()
        const renderStatus = (status: NativeRuntimeState['status'], waitingOn: NativeRuntimeState['waitingOn'] = []) =>
            <I18nProvider><WorkspaceActivity label session={{ active: true, thinking: true,
                pendingRequestKinds: [], backgroundTaskCount: 0,
                execution: { status, waitingOn, owner: 'm', generation: 'g', sequence: 1, turnId: null, startedAt: null, completedAt: null } }} /></I18nProvider>
        const view = render(renderStatus('active'))
        expect(screen.getByText('Running').closest('[data-state]')).toHaveAttribute('data-state', 'running')
        view.rerender(renderStatus('idle'))
        expect(screen.getByText('online').closest('[data-state]')).toHaveAttribute('data-state', 'idle')
        view.rerender(renderStatus('systemError'))
        expect(screen.getByText('Execution error').closest('[data-state]')).toHaveAttribute('data-state', 'error')
        view.rerender(renderStatus('active', ['approval']))
        expect(screen.getByText('permission required').closest('[data-state]')).toHaveAttribute('data-state', 'permission')
        view.rerender(renderStatus('disconnected'))
        expect(screen.getByText('offline').closest('[data-state]')).toHaveAttribute('data-state', 'offline')
    })
})
