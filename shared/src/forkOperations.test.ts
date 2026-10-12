import { describe, expect, it } from 'bun:test'
import { ForkConversationRequestSchema } from './apiTypes'
import { FORK_CLOSED_UNADMITTED_CODE, ForkOperationCloseRequestSchema, ForkOperationCloseResponseSchema, ForkOperationReceiptSchema, ForkOperationRpcRequestSchema, isForkOperationUnresolved, mergeForkOperationReceipt, type ForkOperationReceipt } from './forkOperations'

const identity = {
    operationId: '2a07e7d6-fdcb-446f-beb8-301662d59dfb', sourceSessionId: 'source',
    childSessionId: 'child', sourceRevision: 1, message: 'Fork result is unconfirmed', updatedAt: 10
}
const unknown: ForkOperationReceipt = { ...identity, status: 'indeterminate' }
const created: ForkOperationReceipt = { ...identity, status: 'created', nativeThreadId: 'native-child', binding: 'pending' }

describe('fork operation wire contract', () => {
    it('allows explicit close action without changing the immutable RPC epoch or boundary', () => {
        const request = { action: 'close-unadmitted', operationId: identity.operationId, sourceSessionId: 'source',
            sourceNativeThreadId: 'native-source', sourceMachineId: 'machine', sourceStoreId: '/canonical/store',
            childSessionId: 'child', sourceRevision: 2, fingerprint: 'original', messageLocalId: 'original-boundary' }
        expect(ForkOperationRpcRequestSchema.parse(request)).toEqual(request)
        expect(ForkOperationRpcRequestSchema.safeParse({ ...request, expectedForkRevision: 3 }).success).toBe(false)
        expect(ForkOperationCloseRequestSchema.parse({ expectedForkRevision: 2 })).toEqual({ expectedForkRevision: 2 })
        for (const invalid of [{}, { expectedForkRevision: -1 }, { expectedForkRevision: 2, operationId: identity.operationId },
            { expectedForkRevision: 2, messageLocalId: 'replacement' }]) {
            expect(ForkOperationCloseRequestSchema.safeParse(invalid).success).toBe(false)
        }
    })
    it('never labels an unknown result or generic rejection as a closed unadmitted request', () => {
        const response = { operation: unknown, sourceState: { revision: 3, operation: unknown }, closure: 'closed' }
        expect(ForkOperationCloseResponseSchema.safeParse(response).success).toBe(false)
        const rejected = { ...identity, status: 'rejected', rejectionProof: 'not_dispatched' }
        expect(ForkOperationCloseResponseSchema.safeParse({ ...response, operation: rejected }).success).toBe(false)
        expect(ForkOperationCloseResponseSchema.parse({ ...response, operation: { ...rejected, code: FORK_CLOSED_UNADMITTED_CODE } }))
            .toMatchObject({ closure: 'closed', sourceState: { revision: 3, operation: unknown } })
        expect(ForkOperationCloseResponseSchema.safeParse({ ...response, closure: 'already_resolved' }).success).toBe(false)
        expect(ForkOperationCloseResponseSchema.parse({ ...response, operation: rejected, closure: 'already_resolved' }).closure).toBe('already_resolved')
        expect(ForkOperationCloseResponseSchema.safeParse({ ...response, operation: rejected, closure: 'already_admitted' }).success).toBe(false)
        for (const closure of ['already_admitted', 'unavailable']) {
            expect(ForkOperationCloseResponseSchema.parse({ ...response, closure }).closure).toBe(closure)
        }
    })
    it('requires paired intent ID and captured source revision without changing legacy boundary payloads', () => {
        expect(ForkConversationRequestSchema.parse({})).toEqual({})
        expect(ForkConversationRequestSchema.parse({ messageLocalId: 'm' })).toEqual({ messageLocalId: 'm' })
        expect(ForkConversationRequestSchema.safeParse({ operationId: identity.operationId }).success).toBe(false)
        expect(ForkConversationRequestSchema.safeParse({ expectedForkRevision: 0 }).success).toBe(false)
        expect(ForkConversationRequestSchema.parse({ operationId: identity.operationId, expectedForkRevision: 0 })).toEqual({ operationId: identity.operationId, expectedForkRevision: 0 })
    })
    it('rejects unknown fields, malformed identity and ambiguous boundary without converting into current fork', () => {
        expect(ForkConversationRequestSchema.safeParse({ operationId: 'not-uuid', expectedForkRevision: 0 }).success).toBe(false)
        expect(ForkOperationRpcRequestSchema.safeParse({ ...identity, action: 'start', fingerprint: 'hash', operationId: identity.operationId, beforeTurnId: 'x' }).success).toBe(false)
        expect(ForkConversationRequestSchema.safeParse({ nativeBoundary: { threadId: 't', turnId: 't', itemId: 'i' }, messageLocalId: 'm' }).success).toBe(false)
    })
    it('requires explicit paired new identity for duplicate risk and inherits the original boundary server-side', () => {
        const duplicateRiskOf = '4e2995c4-4ca7-467e-86fc-049ac230c52c'
        const request = { operationId: identity.operationId, expectedForkRevision: 2, duplicateRiskOf }
        expect(ForkConversationRequestSchema.parse(request)).toEqual(request)
        expect(ForkConversationRequestSchema.safeParse({ duplicateRiskOf }).success).toBe(false)
        expect(ForkConversationRequestSchema.safeParse({ ...request, duplicateRiskOf: identity.operationId }).success).toBe(false)
        expect(ForkConversationRequestSchema.safeParse({ ...request, messageLocalId: 'original-message' }).success).toBe(false)
        expect(ForkConversationRequestSchema.safeParse({ ...request, nativeBoundary: { threadId: 'source-native', turnId: 'turn', itemId: 'item' } }).success).toBe(false)
        const rpc = { action: 'start', operationId: identity.operationId, duplicateRiskOf, sourceSessionId: 'source', sourceNativeThreadId: 'source-native', sourceMachineId: 'machine', childSessionId: 'child', sourceRevision: 3, fingerprint: 'fingerprint', nativeBoundary: { threadId: 'source-native', turnId: 'turn', itemId: 'item' } }
        expect(ForkOperationRpcRequestSchema.parse(rpc)).toEqual(rpc)
        expect(ForkOperationRpcRequestSchema.safeParse({ ...rpc, duplicateRiskOf: identity.operationId }).success).toBe(false)
    })
    it('keeps duplicate-risk ancestry immutable while merging only the same receipt', () => {
        const receipt = { ...unknown, duplicateRiskOf: '4e2995c4-4ca7-467e-86fc-049ac230c52c' }
        expect(mergeForkOperationReceipt(receipt, { ...created, duplicateRiskOf: receipt.duplicateRiskOf })).toMatchObject({ status: 'created', duplicateRiskOf: receipt.duplicateRiskOf })
        expect(() => mergeForkOperationReceipt(receipt, created)).toThrow('identity')
        expect(() => mergeForkOperationReceipt(unknown, receipt)).toThrow('identity')
    })
    it('cannot report created without exact native identity and binding phase', () => {
        expect(ForkOperationReceiptSchema.safeParse({ ...identity, status: 'created' }).success).toBe(false)
        expect(ForkOperationReceiptSchema.parse(created)).toEqual(created)
    })
    it('retains same identity when a late success upgrades unknown', () => {
        expect(mergeForkOperationReceipt(unknown, created)).toEqual(created)
        expect(() => mergeForkOperationReceipt(unknown, { ...created, childSessionId: 'other' })).toThrow('identity')
    })
    it('never regresses known creation or readiness from timeout and stale binding responses', () => {
        expect(mergeForkOperationReceipt(created, { ...unknown, updatedAt: 30 })).toEqual(created)
        const ready = { ...created, binding: 'ready' as const }
        expect(mergeForkOperationReceipt(ready, { ...created, binding: 'blocked', updatedAt: 30 })).toEqual(ready)
        expect(() => mergeForkOperationReceipt(created, { ...created, nativeThreadId: 'wrong' })).toThrow('identity')
    })
    it('does not replace newer binding evidence with an older pending receipt', () => {
        const blocked = { ...created, binding: 'blocked' as const, updatedAt: 20 }
        expect(mergeForkOperationReceipt(blocked, created)).toEqual(blocked)
        expect(mergeForkOperationReceipt(blocked, { ...created, binding: 'ready' })).toMatchObject({ binding: 'ready' })
    })
    it('keeps durable source fence until rejected or exact child binding is ready', () => {
        expect(isForkOperationUnresolved(unknown)).toBe(true)
        expect(isForkOperationUnresolved(created)).toBe(true)
        expect(isForkOperationUnresolved({ ...created, binding: 'ready' })).toBe(false)
        expect(isForkOperationUnresolved({ ...identity, status: 'rejected', rejectionProof: 'not_dispatched' })).toBe(false)
    })
    it('accepts causal unknown and proved no-dispatch progress despite a slower executor clock', () => {
        const running: ForkOperationReceipt = { ...identity, status: 'running', updatedAt: 30_000 }
        const earlierUnknown: ForkOperationReceipt = { ...unknown, updatedAt: 1 }
        const earlierRejected: ForkOperationReceipt = { ...identity, status: 'rejected', rejectionProof: 'not_dispatched', updatedAt: 1 }
        expect(mergeForkOperationReceipt(running, earlierUnknown)).toEqual(earlierUnknown)
        expect(mergeForkOperationReceipt(running, earlierRejected)).toEqual(earlierRejected)
        expect(mergeForkOperationReceipt({ ...unknown, updatedAt: 30_000 }, earlierRejected)).toEqual(earlierRejected)
        expect(mergeForkOperationReceipt({ ...created, binding: 'ready', updatedAt: 30_000 }, earlierUnknown)).toMatchObject({ status: 'created', binding: 'ready' })
        expect(mergeForkOperationReceipt({ ...created, binding: 'ready', updatedAt: 30_000 }, earlierRejected)).toMatchObject({ status: 'created', binding: 'ready' })
    })

    it('does not regress unknown to running or mutate rejected receipts', () => {
        expect(mergeForkOperationReceipt(unknown, { ...identity, status: 'running', updatedAt: 30 })).toEqual(unknown)
        const rejected: ForkOperationReceipt = { ...identity, status: 'rejected', rejectionProof: 'not_dispatched' }
        expect(mergeForkOperationReceipt(rejected, created)).toEqual(rejected)
    })
})
