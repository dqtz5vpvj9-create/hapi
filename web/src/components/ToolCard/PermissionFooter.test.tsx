import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { PermissionFooter } from './PermissionFooter'
import { reconcilePermissionActions } from './permissionAction'
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
function fixture() {
    const held = deferred()
    const approvePermission = vi.fn().mockReturnValue(held.promise)
    const denyPermission = vi.fn().mockReturnValue(held.promise)
    const props = { api: { approvePermission, denyPermission } as unknown as ApiClient,
        sessionId: 'A', metadata: { flavor: 'codex', path: '/synthetic', host: 'fixture' } as const, disabled: false, onDone: vi.fn(),
        tool: { id: 'tool-distinct-from-request', name: 'Bash', input: { command: 'synthetic-only' }, state: 'pending',
            permission: { id: 'request-1', status: 'pending' } } as ChatToolCall }
    return { held, approvePermission, denyPermission, props }
}
const yes = () => screen.getByRole('button', { name: 'tool.yes' })
describe('PermissionFooter request ownership', () => {
    it.each(['tool.yes', 'tool.yesForSession', 'tool.abortLabel'])('preserves pending %s and prevents all repeat decisions across remount', async label => {
        const f = fixture(); const view = render(<PermissionFooter {...f.props} />)
        fireEvent.click(screen.getByRole('button', { name: label })); view.unmount()
        render(<PermissionFooter {...f.props} />)
        for (const button of screen.getAllByRole('button')) { expect(button).toBeDisabled(); fireEvent.click(button) }
        expect(f.approvePermission.mock.calls.length + f.denyPermission.mock.calls.length).toBe(1)
        await act(async () => { f.held.resolve(); await f.held.promise })
        expect(yes()).toBeDisabled() // ACK without authoritative agentState is still already submitted.
        expect(f.props.onDone).toHaveBeenCalledTimes(1)
    })
    it.each([
        ['Bash', 'tool.allow', undefined, false],
        ['Bash', 'tool.allowForSession', { allowTools: ['Bash(synthetic-only)'] }, false],
        ['Edit', 'tool.allowAll', 'acceptEdits', false],
        ['Bash', 'tool.deny', undefined, true],
    ] as const)('preserves Claude %s/%s payload and pending across remount', async (name, label, option, deny) => {
        const f = fixture()
        const props = { ...f.props, metadata: { ...f.props.metadata, flavor: 'claude' as const }, tool: { ...f.props.tool, name } }
        const view = render(<PermissionFooter {...props} />)
        fireEvent.click(screen.getByRole('button', { name: label })); view.unmount()
        render(<PermissionFooter {...props} />)
        for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
        const mock = deny ? f.denyPermission : f.approvePermission
        expect(mock).toHaveBeenCalledTimes(1)
        expect(mock.mock.calls[0]).toEqual(option === undefined ? ['A', 'request-1'] : ['A', 'request-1', option])
        await act(async () => { f.held.resolve(); await f.held.promise })
    })
    it('keeps a new request failure when the old request later succeeds', async () => {
        const f = fixture(); const view = render(<PermissionFooter {...f.props} />); fireEvent.click(yes())
        const next = deferred(); f.approvePermission.mockReturnValue(next.promise)
        view.rerender(<PermissionFooter {...f.props} tool={{ ...f.props.tool, permission: { id: 'request-2', status: 'pending' } }} />)
        fireEvent.click(yes())
        await act(async () => { next.reject(new Error('New failure remains')); await next.promise.catch(() => {}) })
        await act(async () => { f.held.resolve(); await f.held.promise })
        expect(screen.getByText('New failure remains')).toBeVisible(); expect(yes()).toBeEnabled()
    })
    it('shares a synchronous guard with another mounted card for the same request', () => {
        const f = fixture(); render(<><PermissionFooter {...f.props} /><PermissionFooter {...f.props} /></>)
        const buttons = screen.getAllByRole('button', { name: 'tool.yes' })
        act(() => { fireEvent.click(buttons[0]); fireEvent.click(buttons[1]) })
        expect(f.approvePermission).toHaveBeenCalledTimes(1)
        expect(f.approvePermission).toHaveBeenCalledWith('A', 'request-1', { decision: 'approved' })
    })
    it('preserves a hidden rejection and retries once with the same request identity', async () => {
        const f = fixture(); const view = render(<PermissionFooter {...f.props} />); fireEvent.click(yes()); view.unmount()
        await act(async () => { f.held.reject(new Error('Synthetic network rejection')); await f.held.promise.catch(() => {}) })
        render(<PermissionFooter {...f.props} />)
        expect(screen.getByText('Synthetic network rejection')).toBeVisible(); expect(yes()).toBeEnabled()
        f.approvePermission.mockResolvedValue(undefined); fireEvent.click(yes())
        await waitFor(() => expect(f.props.onDone).toHaveBeenCalledTimes(1)); expect(f.approvePermission).toHaveBeenCalledTimes(2)
    })
    it('isolates session, API and new request while a previous ACK is late', async () => {
        const f = fixture(); const view = render(<PermissionFooter {...f.props} />); fireEvent.click(yes())
        view.rerender(<PermissionFooter {...f.props} sessionId="B" />); expect(yes()).toBeEnabled()
        const other = fixture(); view.rerender(<PermissionFooter {...f.props} api={other.props.api} />); expect(yes()).toBeEnabled()
        const next = deferred(); f.approvePermission.mockReturnValue(next.promise)
        const nextProps = { ...f.props, tool: { ...f.props.tool, permission: { id: 'request-2', status: 'pending' as const } } }
        view.rerender(<PermissionFooter {...nextProps} />); fireEvent.click(yes())
        await act(async () => { f.held.resolve(); await f.held.promise }); expect(yes()).toBeDisabled()
        await act(async () => { next.reject(new Error('New request failed')); await next.promise.catch(() => {}) }); expect(yes()).toBeEnabled()
        expect(screen.getByText('New request failed')).toBeVisible()
    })
    it.each(['completed', 'missing'])('retires a %s request from authoritative full state before a late rejection', async kind => {
        const f = fixture(); const view = render(<PermissionFooter {...f.props} />); fireEvent.click(yes()); view.unmount()
        act(() => reconcilePermissionActions(f.props.api, 'A', kind === 'completed'
            ? { requests: { 'request-1': { tool: 'Bash', arguments: {} } }, completedRequests: { 'request-1': { tool: 'Bash', arguments: {}, status: 'approved' } } }
            : { requests: {}, completedRequests: {} }))
        // A later request lifetime cannot inherit or be unlocked by the retired lease.
        const next = deferred(); f.approvePermission.mockReturnValue(next.promise)
        render(<PermissionFooter {...f.props} />); expect(yes()).toBeEnabled(); fireEvent.click(yes())
        await act(async () => { f.held.reject(new Error('Late old rejection')); await f.held.promise.catch(() => {}) })
        expect(yes()).toBeDisabled(); expect(screen.queryByText('Late old rejection')).not.toBeInTheDocument()
        await act(async () => { next.resolve(); await next.promise }); expect(f.props.onDone).toHaveBeenCalledTimes(1)
    })
    it('does not clear a pending request on absent state or another session refresh', () => {
        const f = fixture(); const view = render(<PermissionFooter {...f.props} />); fireEvent.click(yes()); view.unmount()
        reconcilePermissionActions(f.props.api, 'A', null)
        reconcilePermissionActions(f.props.api, 'B', { requests: {}, completedRequests: {} })
        reconcilePermissionActions(f.props.api, 'A', { requests: { 'request-1': { tool: 'Bash', arguments: {} } } })
        render(<PermissionFooter {...f.props} />); expect(yes()).toBeDisabled()
    })
})
