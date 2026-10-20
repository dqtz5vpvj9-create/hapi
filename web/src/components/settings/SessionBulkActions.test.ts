import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { runSessionBulkAction } from './SessionBulkActions'

const session = (id: string, overrides: Partial<SessionSummary> = {}) => ({
    id, active: true, thinking: false, metadata: { path: '/project', flavor: 'codex' }, ...overrides,
}) as SessionSummary

describe('bulk session controls', () => {
    it('changes only confirmed Fast tiers across machines and reports partial failures', async () => {
        const api = {
            getSessions: vi.fn().mockResolvedValue({ sessions: [session('fast', { serviceTier: 'fast' }), session('offline', { active: false, serviceTier: 'priority' }), session('standard', { serviceTier: 'standard' }), session('unset')] }),
            setServiceTier: vi.fn().mockImplementation(async (id: string) => { if (id === 'offline') throw new Error('Offline') }),
            abortSession: vi.fn(),
        }
        const result = await runSessionBulkAction(api, 'standard')
        expect(api.setServiceTier.mock.calls).toEqual([['fast', 'standard'], ['offline', 'standard']])
        expect(result).toMatchObject({ total: 2, succeeded: 1, failures: [{ id: 'offline', error: 'Offline' }] })
        expect(api.abortSession).not.toHaveBeenCalled()
    })
    it('stops running turns including children while leaving idle sessions alone', async () => {
        const api = {
            getSessions: vi.fn().mockResolvedValue({ sessions: [session('root', { thinking: true }), session('child', { thinking: true, metadata: { path: '/project', codexParentThreadId: 'root' } }), session('idle')] }),
            setServiceTier: vi.fn(), abortSession: vi.fn().mockResolvedValue(undefined),
        }
        expect(await runSessionBulkAction(api, 'pause')).toMatchObject({ total: 2, succeeded: 2, failures: [] })
        expect(api.abortSession.mock.calls).toEqual([['root'], ['child']])
        expect(api.setServiceTier).not.toHaveBeenCalled()
    })
    it('does not mutate anything if refreshing the session list fails', async () => {
        const api = { getSessions: vi.fn().mockRejectedValue(new Error('Disconnected')), setServiceTier: vi.fn(), abortSession: vi.fn() }
        await expect(runSessionBulkAction(api, 'pause')).rejects.toThrow('Disconnected')
        expect(api.abortSession).not.toHaveBeenCalled()
    })
})
