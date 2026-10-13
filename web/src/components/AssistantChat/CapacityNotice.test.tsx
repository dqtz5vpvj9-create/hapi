import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeRuntimeState } from '@hapi/protocol/schemas'
import { NativeRuntimeStateSchema } from '@hapi/protocol/schemas'
import { I18nProvider } from '@/lib/i18n-context'
import { CapacityNotice } from './CapacityNotice'

beforeEach(() => localStorage.clear())
afterEach(() => { cleanup(); vi.useRealTimers() })
const base: NativeRuntimeState = { owner: 'native', generation: 'connection', sequence: 1,
    status: 'systemError', waitingOn: [], turnId: 'failed-turn', startedAt: null, completedAt: null }
function show(execution: NativeRuntimeState, active = true, onCancel?: () => void) {
    return <I18nProvider><CapacityNotice active={active} execution={execution} onCancel={onCancel} /></I18nProvider>
}
describe('bridge-owned capacity recovery presentation', () => {
    it('shows native retry honestly without inventing a deadline', () => {
        render(show({ ...base, status: 'active', capacityRecovery: { turnId: base.turnId!, phase: 'retrying' } }))
        expect(screen.getByText(/Codex is retrying automatically/)).toBeInTheDocument()
        expect(screen.queryByText(/\d+s/)).toBeNull()
    })
    it('counts down the bridge timestamp, then waits for confirmation without invoking a retry', async () => {
        vi.useFakeTimers(); vi.setSystemTime(100_000)
        const onCancel = vi.fn()
        const execution = NativeRuntimeStateSchema.parse({ ...base,
            capacityRecovery: { turnId: base.turnId, phase: 'waiting', retryAt: 130_000, attempt: 1, maxAttempts: 5 } })
        render(show(execution, true, onCancel))
        expect(screen.getByText(/continue this conversation in 30s/)).toBeInTheDocument()
        await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
        expect(screen.getByText(/checking whether/)).toBeInTheDocument()
        expect(onCancel).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Cancel automatic continuation' }))
        expect(onCancel).toHaveBeenCalledTimes(1)
    })
    it('clears for older runtimes, disconnects, new turns, and confirmed cancellation', () => {
        const execution = { ...base, capacityRecovery: { turnId: base.turnId!, phase: 'waiting' as const, retryAt: Date.now() + 30_000 } }
        const view = render(show(execution))
        expect(screen.getByRole('status')).toBeInTheDocument()
        for (const state of [base, { ...execution, status: 'disconnected' as const },
            { ...execution, turnId: 'new' }, { ...execution, capacityRecovery: null }]) {
            view.rerender(show(state)); expect(screen.queryByRole('status')).toBeNull()
        }
        view.rerender(show(execution, false)); expect(screen.queryByRole('status')).toBeNull()
    })
    it('localizes the planned continuation and distinguishes unknown outcomes', () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        render(show({ ...base, capacityRecovery: { turnId: base.turnId!, phase: 'failed', reason: 'unconfirmed' } }))
        expect(screen.getByText(/结果尚未确认/)).toBeInTheDocument()
    })
})
