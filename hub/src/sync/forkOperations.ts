import { createHash, randomUUID } from 'node:crypto'
import { ForkConversationRequestSchema, type ForkConversationRequest, type NativeForkBoundary } from '@hapi/protocol/apiTypes'
import {
    FORK_CLOSED_UNADMITTED_CODE, ForkOperationCloseRequestSchema, ForkOperationCloseResponseSchema,
    ForkOperationResponseSchema, isForkOperationUnresolved,
    type ForkOperationCloseRequest, type ForkOperationCloseResponse,
    type ForkOperationReceipt, type ForkOperationResponse, type ForkOperationRpcRequest, type ForkSourceState
} from '@hapi/protocol/forkOperations'
import type { Session } from '@hapi/protocol/types'
import type { Store } from '../store'
import type { ForkSourceIdentity, StoredForkOperation } from '../store/forkOperationStore'
import { RpcTargetMissingError, type RpcGateway } from './rpcGateway'

export class ForkOperationAccessError extends Error {
    constructor(readonly code: string, message: string, readonly status: 404 | 409 = 409) { super(message) }
}
export type StartForkOperationResult =
    | ({ type: 'operation' } & ForkOperationResponse)
    | { type: 'conflict'; code: string; message: string; revision: number; operation?: ForkOperationReceipt; blockingSourceSessionId?: string }
export type CloseForkOperationResult =
    | ({ type: 'operation' } & ForkOperationCloseResponse)
    | { type: 'conflict'; code: string; message: string; sourceState: ForkSourceState }

export function isSharedCodexForkSource(session: Session): boolean {
    return session.metadata?.flavor === 'codex' && session.metadata.capabilities?.concurrentClients === true
}

export function forkSourceIdentity(session: Session): ForkSourceIdentity {
    const metadata = session.metadata
    if (!metadata?.machineId || !metadata.codexSessionId) {
        throw new ForkOperationAccessError('source_identity_unavailable', 'The source is missing its machine or native thread identity. Reconnect it before forking.')
    }
    if (!metadata.codexStoreId && metadata.codexNativeSession) {
        throw new ForkOperationAccessError('source_identity_unavailable', 'The native source is missing its store identity. Reconnect with an updated CLI before forking.')
    }
    return { machineId: metadata.machineId, nativeSourceId: metadata.codexSessionId,
        // Older managed wrappers omitted store metadata. Deliberately overblock aliases on
        // the same machine rather than use a PID/path that could allow a duplicate dispatch.
        storeId: metadata.codexStoreId || `managed:${metadata.machineId}` }
}

function matchesIdentity(left: ForkSourceIdentity, right: ForkSourceIdentity): boolean {
    return left.machineId === right.machineId && left.storeId === right.storeId && left.nativeSourceId === right.nativeSourceId
}

export class ForkOperationService {
    private readonly observations = new Map<string, Promise<ForkOperationResponse>>()
    constructor(
        private readonly store: Store,
        private readonly rpc: RpcGateway,
        private readonly hooks: {
            source(id: string, namespace: string): Session | undefined
            preflight(session: Session, messageLocalId?: string, nativeBoundary?: NativeForkBoundary): void
            begin(sessionId: string): void
            end(sessionId: string): void
            validateChild(source: Session, operation: Extract<ForkOperationReceipt, { status: 'created' }>): Promise<boolean>
        }
    ) {}

    private source(id: string, namespace: string): Session {
        const session = this.hooks.source(id, namespace)
        if (!session || session.namespace !== namespace || session.id !== id) {
            throw new ForkOperationAccessError('operation_not_found', 'Fork source not found.', 404)
        }
        return session
    }

    sourceState(id: string, namespace: string): ForkSourceState {
        const state = this.store.forkOperations.sourceState(namespace, forkSourceIdentity(this.source(id, namespace)))
        if (!state.operation || state.operation.sourceSessionId === id) return state
        // Physical aliases share the revision/fence, not an operation's HTTP source identity.
        // Never offer an A receipt under B, where B/:operationId is correctly inaccessible.
        return isForkOperationUnresolved(state.operation)
            ? { revision: state.revision, blockingSourceSessionId: state.operation.sourceSessionId,
                message: 'A fork of this native source is unresolved in another session. Open that source session to check or recover its operation.' }
            : { revision: state.revision }
    }

    async start(id: string, namespace: string, input: ForkConversationRequest): Promise<StartForkOperationResult> {
        input = ForkConversationRequestSchema.parse(input)
        const source = this.source(id, namespace)
        const identity = forkSourceIdentity(source)
        const riskTarget = input.duplicateRiskOf ? this.store.forkOperations.get(namespace, input.duplicateRiskOf) : undefined
        const messageLocalId = input.duplicateRiskOf ? riskTarget?.request.messageLocalId : input.messageLocalId
        const nativeBoundary = input.duplicateRiskOf ? riskTarget?.request.nativeBoundary : input.nativeBoundary
        const operationId = input.operationId ?? randomUUID()
        const expectedRevision = input.expectedForkRevision ?? this.store.forkOperations.sourceState(namespace, identity).revision
        const fingerprint = createHash('sha256').update(JSON.stringify([
            id, expectedRevision, input.duplicateRiskOf ?? null, messageLocalId ?? null,
            nativeBoundary ? [nativeBoundary.threadId, nativeBoundary.turnId, nativeBoundary.itemId] : null
        ])).digest('hex')
        const childSessionId = randomUUID()
        const request: ForkOperationRpcRequest = { action: 'start', operationId, sourceSessionId: id, childSessionId,
            sourceMachineId: riskTarget?.request.sourceMachineId ?? identity.machineId,
            sourceNativeThreadId: riskTarget?.request.sourceNativeThreadId ?? identity.nativeSourceId,
            ...((riskTarget ? riskTarget.request.sourceStoreId : source.metadata?.codexStoreId)
                ? { sourceStoreId: riskTarget ? riskTarget.request.sourceStoreId : source.metadata!.codexStoreId } : {}),
            sourceRevision: expectedRevision + 1, fingerprint,
            ...(input.duplicateRiskOf ? { duplicateRiskOf: input.duplicateRiskOf } : {}),
            ...(messageLocalId ? { messageLocalId } : {}),
            ...(nativeBoundary ? { nativeBoundary } : {}) }
        const operation: ForkOperationReceipt = { operationId, sourceSessionId: id, childSessionId, sourceRevision: expectedRevision + 1,
            ...(input.duplicateRiskOf ? { duplicateRiskOf: input.duplicateRiskOf } : {}),
            status: 'running', message: input.duplicateRiskOf
                ? 'A new fork was explicitly requested despite the original unknown result. Both operations remain recorded.'
                : 'Fork accepted. Waiting for the native result.', updatedAt: Date.now() }
        const admission = this.store.forkOperations.admit({ namespace, identity, expectedRevision, request, operation })
        if (admission.type === 'conflict') {
            if (!admission.operation || admission.operation.sourceSessionId === id) return admission
            const { operation: otherOperation, ...conflict } = admission
            return isForkOperationUnresolved(otherOperation)
                ? { ...conflict, blockingSourceSessionId: otherOperation.sourceSessionId,
                    message: 'A fork of this native source is unresolved in another session. Open that source session to check or recover its operation.' }
                : conflict
        }
        if (!matchesIdentity(admission.record.identity, identity)) {
            throw new ForkOperationAccessError('source_identity_changed', 'The source native binding changed. The saved operation will not be sent again.')
        }
        if (admission.type === 'replay') return { type: 'operation', ...this.response(admission.record.operation) }
        try {
            if (!isSharedCodexForkSource(source)) throw new Error('Durable fork operations require a shared Codex source.')
            this.hooks.preflight(source, messageLocalId, nativeBoundary)
        } catch (error) {
            return { type: 'operation', ...this.response(this.store.forkOperations.merge(namespace, operationId, {
                ...operation, status: 'rejected', rejectionProof: 'not_dispatched', code: 'preflight_rejected',
                message: error instanceof Error ? error.message : String(error), updatedAt: Date.now()
            })) }
        }
        this.hooks.begin(id)
        try {
            if (!this.store.forkOperations.markDispatched(namespace, operationId)) {
                return { type: 'operation', ...this.response(this.store.forkOperations.get(namespace, operationId)!.operation) }
            }
            const response = await this.rpc.forkOperation(id, request)
            return { type: 'operation', ...await this.mergeResponse(admission.record, response) }
        } catch (error) {
            // The hub RPC could have crossed the CLI's own native dispatch boundary.
            // Only the typed CLI receipt can prove native non-dispatch after this point.
            const missing = error instanceof RpcTargetMissingError
            // RpcTargetMissingError is constructed only before emitWithAck. Unlike an
            // error envelope returned by a CLI, it proves the RPC was never sent.
            const next: ForkOperationReceipt = this.store.forkOperations.merge(namespace, operationId, missing
                ? { ...operation, status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_operation_unavailable',
                    message: 'The source CLI is unavailable or does not support durable fork operations. Reconnect or upgrade it before creating a new fork.', updatedAt: Date.now() }
                : { ...operation, status: 'indeterminate', code: 'fork_result_unknown',
                    message: `The fork result is unconfirmed: ${error instanceof Error ? error.message : String(error)}`, updatedAt: Date.now() })
            return { type: 'operation', ...this.response(next) }
        } finally { this.hooks.end(id) }
    }

    private record(id: string, namespace: string, operationId: string): StoredForkOperation {
        const source = this.source(id, namespace)
        const record = this.store.forkOperations.get(namespace, operationId)
        if (!record || record.operation.sourceSessionId !== id) throw new ForkOperationAccessError('operation_not_found', 'Fork operation not found.', 404)
        if (!matchesIdentity(record.identity, forkSourceIdentity(source))) {
            throw new ForkOperationAccessError('source_identity_changed', 'The source native binding changed. The saved fork operation cannot be reconciled through this binding.')
        }
        return record
    }

    async read(id: string, namespace: string, operationId: string, reconcile = false): Promise<ForkOperationResponse> {
        const record = this.record(id, namespace, operationId)
        const source = this.source(id, namespace)
        if (record.operation.status === 'rejected' || record.operation.status === 'created' && record.operation.binding === 'ready'
            || !source.active || !isSharedCodexForkSource(source)) return this.response(record.operation)
        const key = JSON.stringify([namespace, operationId])
        const pending = this.observations.get(key)
        if (pending) return pending
        const observation = (async () => {
            try {
                // Identity-unknown reconciliation is observation only. No read path resumes a source.
                const action = reconcile && record.operation.status === 'created' ? 'reconcile' : 'read'
                const response = await this.rpc.forkOperation(id, { ...record.request, action })
                return await this.mergeResponse(record, response)
            } catch {
                return this.response(this.store.forkOperations.get(namespace, operationId)!.operation)
            }
        })()
        this.observations.set(key, observation)
        try { return await observation } finally { this.observations.delete(key) }
    }

    async closeUnadmitted(id: string, namespace: string, operationId: string, input: ForkOperationCloseRequest): Promise<CloseForkOperationResult> {
        input = ForkOperationCloseRequestSchema.parse(input)
        const record = this.record(id, namespace, operationId)
        const source = this.source(id, namespace)
        const result = (operation: ForkOperationReceipt, closure: ForkOperationCloseResponse['closure'], message: string): CloseForkOperationResult => ({
            type: 'operation', ...ForkOperationCloseResponseSchema.parse({ operation, sourceState: this.sourceState(id, namespace), closure, message })
        })
        const classified = (operation: ForkOperationReceipt): CloseForkOperationResult => {
            if (operation.status === 'rejected') {
                return operation.code === FORK_CLOSED_UNADMITTED_CODE
                    ? result(operation, 'closed', 'This exact request was durably closed before CLI admission. Review the current source state before choosing another action.')
                    : result(operation, 'already_resolved', 'This request already has a confirmed no-dispatch result. No closure was needed.')
            }
            return result(operation, 'already_admitted', 'The CLI already admitted this request. It was not closed; check its result or recover its known child.')
        }
        // A lost HTTP reply must be replayable after proof restored an older head.
        // Known child evidence is also returned without any additional binding action.
        if (record.operation.status === 'rejected' || record.operation.status === 'created') return classified(record.operation)
        const state = this.sourceState(id, namespace)
        if (state.revision !== input.expectedForkRevision || state.operation?.operationId !== operationId) {
            return { type: 'conflict', code: 'fork_revision_conflict',
                message: 'The source has a different current fork operation. Review it before closing this exact request.', sourceState: state }
        }
        if (record.operation.status !== 'indeterminate') {
            return { type: 'conflict', code: 'fork_operation_not_indeterminate',
                message: 'This request is still running. Closing an unadmitted request is available only for an unknown result.', sourceState: state }
        }
        if (!record.request.sourceStoreId || record.request.sourceStoreId !== record.identity.storeId
            || record.request.sourceStoreId !== source.metadata?.codexStoreId) {
            return result(record.operation, 'unavailable', 'The original request has no exact canonical store identity. Its absence cannot be proved safely; the saved result remains unknown.')
        }
        if (!source.active || !isSharedCodexForkSource(source)) {
            return result(record.operation, 'unavailable', 'Reconnect this same shared Codex source to check whether the request can be closed. No result was changed.')
        }
        try {
            // This explicit action changes only an exact absent CLI receipt. Its CAS is
            // Hub-local; immutable sourceRevision and the original boundary stay intact.
            const response = await this.rpc.forkOperation(id, { ...record.request, action: 'close-unadmitted' })
            const merged = await this.mergeResponse(record, response)
            return classified(merged.operation)
        } catch {
            // Missing target, unsupported action, malformed proof, and lost ack all
            // preserve uncertainty. None proves the original start was not admitted.
            const current = this.store.forkOperations.get(namespace, operationId)!.operation
            return result(current, 'unavailable', 'The CLI could not confirm closure. This request remains recorded; reconnect or update the CLI and explicitly retry closing the same request.')
        }
    }

    private async mergeResponse(record: StoredForkOperation, response: unknown): Promise<ForkOperationResponse> {
        const parsed = ForkOperationResponseSchema.parse(response)
        const next = parsed.operation
        if (next.status !== 'created') {
            if (next.status === 'rejected' && record.request.duplicateRiskOf) await this.refreshRiskPredecessor(record)
            return this.response(this.store.forkOperations.merge(record.namespace, record.operation.operationId, next))
        }
        // Persist the exact native child before any metadata read, wait, or validation can fail.
        const recorded = this.store.forkOperations.merge(record.namespace, record.operation.operationId,
            next.binding === 'ready' ? { ...next, binding: 'pending' } : next)
        if (recorded.status !== 'created' || recorded.binding === 'ready' || next.binding !== 'ready') return this.response(recorded)
        const source = this.source(record.operation.sourceSessionId, record.namespace)
        let valid = false
        try {
            valid = matchesIdentity(record.identity, forkSourceIdentity(source))
                && next.nativeThreadId !== record.identity.nativeSourceId
                && await this.hooks.validateChild(source, next)
        } catch { /* A known creation remains created even if binding validation fails. */ }
        const merged = this.store.forkOperations.merge(record.namespace, record.operation.operationId, {
            ...next, binding: valid ? 'ready' : 'blocked', code: valid ? next.code : 'binding_validation_failed',
            message: valid ? next.message : 'The native child was created, but its HAPI binding could not be verified. Recover this child binding; do not create another fork.',
            updatedAt: Math.max(Date.now(), next.updatedAt)
        })
        return this.response(merged)
    }

    private async refreshRiskPredecessor(record: StoredForkOperation): Promise<void> {
        const predecessorId = record.request.duplicateRiskOf
        if (!predecessorId) return
        const predecessor = this.store.forkOperations.get(record.namespace, predecessorId)
        if (!predecessor) return
        try {
            const source = this.source(predecessor.operation.sourceSessionId, record.namespace)
            if (!source.active || !matchesIdentity(predecessor.identity, forkSourceIdentity(source))) return
            // Query the original receipt before restoring its blocker. The CLI may have
            // learned a child (or definitive no-dispatch) while the hub still saw unknown.
            const response = await this.rpc.forkOperation(source.id, { ...predecessor.request, action: 'read' })
            // Merge this one exact receipt without recursively walking a risk chain or
            // performing child binding. A reported ready child still goes through our guard.
            const parsed = ForkOperationResponseSchema.parse(response)
            if (parsed.operation.status === 'created') await this.mergeResponse(predecessor, parsed)
            else this.store.forkOperations.merge(record.namespace, predecessorId, parsed.operation)
        } catch { /* Restore saved unknown evidence conservatively if observation failed. */ }
    }

    private response(operation: ForkOperationReceipt): ForkOperationResponse {
        return { operation, ...(operation.status === 'created' && operation.binding === 'ready' ? { sessionId: operation.childSessionId } : {}) }
    }
}
