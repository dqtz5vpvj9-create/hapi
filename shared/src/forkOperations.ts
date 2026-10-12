import { z } from 'zod'
import { NativeForkBoundarySchema } from './apiTypes'

export const ForkOperationIdSchema = z.string().uuid()
const ForkOperationBaseSchema = z.object({
    operationId: ForkOperationIdSchema,
    duplicateRiskOf: ForkOperationIdSchema.optional(),
    sourceSessionId: z.string().min(1),
    childSessionId: z.string().min(1),
    sourceRevision: z.number().int().positive(),
    code: z.string().min(1).optional(),
    message: z.string(),
    updatedAt: z.number().int().nonnegative()
})
export const ForkOperationReceiptSchema = z.discriminatedUnion('status', [
    ForkOperationBaseSchema.extend({ status: z.literal('running') }),
    ForkOperationBaseSchema.extend({ status: z.literal('indeterminate') }),
    ForkOperationBaseSchema.extend({ status: z.literal('rejected'), rejectionProof: z.literal('not_dispatched') }),
    ForkOperationBaseSchema.extend({
        status: z.literal('created'),
        nativeThreadId: z.string().min(1),
        binding: z.enum(['pending', 'ready', 'blocked'])
    })
])
export type ForkOperationReceipt = z.infer<typeof ForkOperationReceiptSchema>
export const ForkSourceStateSchema = z.object({
    revision: z.number().int().nonnegative(),
    operation: ForkOperationReceiptSchema.optional(),
    blockingSourceSessionId: z.string().min(1).optional(),
    message: z.string().optional()
})
export type ForkSourceState = z.infer<typeof ForkSourceStateSchema>
export const FORK_CLOSED_UNADMITTED_CODE = 'fork_closed_unadmitted'
export const ForkOperationCloseRequestSchema = z.object({
    expectedForkRevision: z.number().int().nonnegative()
}).strict()
export type ForkOperationCloseRequest = z.infer<typeof ForkOperationCloseRequestSchema>
export const ForkOperationCloseResponseSchema = z.object({
    operation: ForkOperationReceiptSchema,
    sourceState: ForkSourceStateSchema,
    closure: z.enum(['closed', 'already_admitted', 'already_resolved', 'unavailable']),
    message: z.string().optional()
}).strict().refine(value => value.closure !== 'closed'
    || value.operation.status === 'rejected' && value.operation.rejectionProof === 'not_dispatched'
        && value.operation.code === FORK_CLOSED_UNADMITTED_CODE, {
    message: 'Closure requires the exact durable unadmitted-operation proof', path: ['closure']
}).refine(value => value.closure !== 'already_resolved'
    || value.operation.status === 'rejected' && value.operation.code !== FORK_CLOSED_UNADMITTED_CODE, {
    message: 'An already-resolved request requires its existing no-dispatch result', path: ['closure']
}).refine(value => value.closure !== 'already_admitted' || value.operation.status !== 'rejected', {
    message: 'An admitted request cannot be represented by a rejected receipt', path: ['closure']
})
export type ForkOperationCloseResponse = z.infer<typeof ForkOperationCloseResponseSchema>
export const ForkOperationRpcRequestSchema = z.object({
    action: z.enum(['start', 'read', 'reconcile', 'close-unadmitted']),
    operationId: ForkOperationIdSchema,
    duplicateRiskOf: ForkOperationIdSchema.optional(),
    sourceSessionId: z.string().min(1),
    sourceNativeThreadId: z.string().min(1),
    sourceMachineId: z.string().min(1),
    sourceStoreId: z.string().min(1).optional(),
    childSessionId: z.string().min(1),
    sourceRevision: z.number().int().positive(),
    fingerprint: z.string().min(1),
    messageLocalId: z.string().min(1).optional(),
    nativeBoundary: NativeForkBoundarySchema.optional()
}).strict().refine(data => data.messageLocalId === undefined || data.nativeBoundary === undefined, {
    message: 'messageLocalId and nativeBoundary are mutually exclusive', path: ['nativeBoundary']
}).refine(data => data.duplicateRiskOf === undefined || data.duplicateRiskOf !== data.operationId, {
    message: 'A duplicate-risk operation requires a different original operation', path: ['duplicateRiskOf']
})
export type ForkOperationRpcRequest = z.infer<typeof ForkOperationRpcRequestSchema>
export const ForkOperationResponseSchema = z.object({
    operation: ForkOperationReceiptSchema,
    sessionId: z.string().min(1).optional()
})
export type ForkOperationResponse = z.infer<typeof ForkOperationResponseSchema>
export type ForkOperationRpcResponse = ForkOperationResponse

/** A terminal known creation never becomes unknown/rejected from a stale reply. */
export function mergeForkOperationReceipt(current: ForkOperationReceipt, next: ForkOperationReceipt): ForkOperationReceipt {
    if (current.operationId !== next.operationId || current.sourceSessionId !== next.sourceSessionId
        || current.childSessionId !== next.childSessionId || current.sourceRevision !== next.sourceRevision
        || current.duplicateRiskOf !== next.duplicateRiskOf) {
        throw new Error('Fork operation identity mismatch')
    }
    if (current.status === 'created') {
        if (next.status !== 'created') return current
        if (current.nativeThreadId !== next.nativeThreadId) throw new Error('Fork child identity mismatch')
        if (current.binding === 'ready' && next.binding !== 'ready') return current
        if (next.updatedAt < current.updatedAt && next.binding !== 'ready') return current
    }
    if (current.status === 'rejected') return current
    if (current.status === 'indeterminate' && next.status === 'running') return current
    // Hub and CLI clocks are independent. Receipt evidence advances the state even
    // when the executor's wall clock is behind the hub's admission timestamp.
    // Time may only suppress stale, same-state explanatory updates, never proof.
    if (next.status === current.status && next.updatedAt < current.updatedAt && next.status !== 'created') return current
    return next
}

export function isForkOperationUnresolved(operation: ForkOperationReceipt): boolean {
    return operation.status === 'running' || operation.status === 'indeterminate'
        || operation.status === 'created' && operation.binding !== 'ready'
}
