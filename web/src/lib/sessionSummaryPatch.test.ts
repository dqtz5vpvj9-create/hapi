import { describe, expect, it } from 'vitest'
import { toSessionSummary } from '@hapi/protocol'
import type { Session } from '@/types/api'
import { applySessionSummaryPatch, reconcileSessionSummary } from './sessionSummaryPatch'

const summary = () => toSessionSummary({ id: 'tier', active: true, thinking: false,
    activeAt: 1, updatedAt: 1, metadata: null, metadataVersion: 0,
    agentState: null, agentStateVersion: 0, model: 'fast-model', effort: null,
    serviceTier: 'fast' } as Session)

describe('summary service tier synchronization', () => {
    it('applies fast-to-standard and explicit clear without a detail query', () => {
        const standard = applySessionSummaryPatch(summary(), { serviceTier: 'standard' })
        expect(standard.serviceTier).toBe('standard')
        const cleared = applySessionSummaryPatch(standard, { serviceTier: null })
        expect(cleared.serviceTier).toBeNull()
        expect(applySessionSummaryPatch(cleared, { thinking: true }).serviceTier).toBeNull()
    })
    it('supports absent tier from older hubs without inventing Standard', () => {
        const old = { ...summary(), serviceTier: undefined }
        expect(applySessionSummaryPatch(old, { thinking: true }).serviceTier).toBeUndefined()
    })
    it('rejects stale execution tier updates and stale list refetches', () => {
        const current = { ...summary(), executionVersion: 5 }
        expect(applySessionSummaryPatch(current, { executionVersion: 4, serviceTier: 'standard' }).serviceTier).toBe('fast')
        expect(applySessionSummaryPatch(current, { executionVersion: 6, serviceTier: null }).serviceTier).toBeNull()
        expect(reconcileSessionSummary(current, { ...summary(), executionVersion: 4, serviceTier: 'standard' }).serviceTier).toBe('fast')
    })
})
