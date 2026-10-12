import type { Database } from 'bun:sqlite'
import {
    ForkOperationReceiptSchema, ForkOperationRpcRequestSchema, isForkOperationUnresolved, mergeForkOperationReceipt,
    type ForkOperationReceipt, type ForkSourceState, type ForkOperationRpcRequest
} from '@hapi/protocol/forkOperations'

/** Physical identity, deliberately independent of a wrapper PID or HAPI alias. */
export type ForkSourceIdentity = { machineId: string; storeId: string; nativeSourceId: string }
export type StoredForkOperation = {
    namespace: string
    identity: ForkSourceIdentity
    fingerprint: string
    request: ForkOperationRpcRequest
    operation: ForkOperationReceipt
    dispatched: boolean
    activeBlocker: boolean
}
type Row = {
    namespace: string; machine_id: string; store_id: string; native_source_id: string
    fingerprint: string; request_json: string; receipt_json: string; dispatched: number; active_blocker: number
}
export type ForkAdmission =
    | { type: 'admitted' | 'replay'; record: StoredForkOperation }
    | { type: 'conflict'; code: string; message: string; revision: number; operation?: ForkOperationReceipt }

export function createForkOperationSchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS fork_operations (
            namespace TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            store_id TEXT NOT NULL,
            native_source_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            request_json TEXT NOT NULL,
            receipt_json TEXT NOT NULL,
            dispatched INTEGER NOT NULL DEFAULT 0,
            unresolved INTEGER NOT NULL,
            active_blocker INTEGER NOT NULL,
            PRIMARY KEY(namespace, operation_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fork_operations_active_source
            ON fork_operations(machine_id, native_source_id, store_id) WHERE active_blocker = 1;
        CREATE INDEX IF NOT EXISTS idx_fork_operations_running
            ON fork_operations(namespace, operation_id) WHERE json_extract(receipt_json, '$.status') = 'running';
        CREATE TABLE IF NOT EXISTS fork_sources (
            namespace TEXT NOT NULL,
            machine_id TEXT NOT NULL,
            store_id TEXT NOT NULL,
            native_source_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            operation_id TEXT NOT NULL,
            PRIMARY KEY(namespace, machine_id, store_id, native_source_id)
        );
        CREATE INDEX IF NOT EXISTS idx_fork_sources_native_revision
            ON fork_sources(namespace, machine_id, native_source_id, revision DESC);
    `)
}

function decode(row: Row): StoredForkOperation {
    return {
        namespace: row.namespace,
        identity: { machineId: row.machine_id, storeId: row.store_id, nativeSourceId: row.native_source_id },
        fingerprint: row.fingerprint,
        request: ForkOperationRpcRequestSchema.parse(JSON.parse(row.request_json)),
        operation: ForkOperationReceiptSchema.parse(JSON.parse(row.receipt_json)),
        dispatched: row.dispatched === 1,
        activeBlocker: row.active_blocker === 1
    }
}

export class ForkOperationStore {
    private durableDepth = 0
    constructor(private readonly db: Database) {}

    /** Only fork writes pay FULL durability; the shared connection returns to its
     * previous setting before any caller can await or run an unrelated write. */
    private durableTransaction<T>(work: () => T): T {
        const synchronous = () => (this.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous
        if (this.durableDepth > 0) {
            if (!this.db.inTransaction || synchronous() < 2) throw new Error('Nested fork transaction lost FULL durability')
            return this.db.transaction(work).immediate()
        }
        if (this.db.inTransaction) throw new Error('Fork writes require an independent FULL durability transaction')
        const prior = synchronous()
        if (!Number.isInteger(prior) || prior < 0 || prior > 3) throw new Error('Cannot verify SQLite durability setting')
        let changed = false
        try {
            if (prior < 2) {
                this.db.exec('PRAGMA synchronous = FULL')
                changed = true
            }
            if (synchronous() < 2) throw new Error('SQLite FULL durability could not be established for fork operation')
            this.durableDepth = 1
            try { return this.db.transaction(work).immediate() }
            finally { this.durableDepth = 0 }
        } finally {
            if (changed) this.db.exec(`PRAGMA synchronous = ${prior}`)
        }
    }

    get(namespace: string, operationId: string): StoredForkOperation | undefined {
        const row = this.db.prepare('SELECT * FROM fork_operations WHERE namespace = ? AND operation_id = ?')
            .get(namespace, operationId) as Row | undefined
        return row ? decode(row) : undefined
    }

    sourceState(namespace: string, identity: ForkSourceIdentity): ForkSourceState {
        const source = this.db.prepare(`SELECT revision, operation_id FROM fork_sources
            WHERE namespace = ? AND machine_id = ? AND native_source_id = ?
                AND (store_id = ? OR store_id = ? OR ? = ?) ORDER BY revision DESC LIMIT 1`)
            .get(namespace, identity.machineId, identity.nativeSourceId, identity.storeId, `managed:${identity.machineId}`,
                identity.storeId, `managed:${identity.machineId}`) as { revision: number; operation_id: string } | undefined
        if (!source) return { revision: 0 }
        return { revision: source.revision, operation: this.get(namespace, source.operation_id)?.operation }
    }

    admit(input: {
        namespace: string; identity: ForkSourceIdentity; expectedRevision: number
        request: ForkOperationRpcRequest; operation: ForkOperationReceipt
    }): ForkAdmission {
        return this.durableTransaction((): ForkAdmission => {
            const { namespace, identity, request } = input
            // Replay precedes freshness and liveness checks. A prior result is never a new intent.
            const existing = this.get(namespace, request.operationId)
            if (existing) {
                if (existing.fingerprint === request.fingerprint
                    && existing.operation.sourceSessionId === request.sourceSessionId) return { type: 'replay', record: existing }
                return { type: 'conflict', code: 'operation_payload_conflict', message: 'This operation ID belongs to a different fork request.',
                    revision: this.sourceState(namespace, identity).revision }
            }
            const state = this.sourceState(namespace, identity)
            const unresolved = this.db.prepare(`SELECT * FROM fork_operations
                WHERE machine_id = ? AND native_source_id = ? AND active_blocker = 1
                    AND (store_id = ? OR store_id = ? OR ? = ?) LIMIT 1`)
                .get(identity.machineId, identity.nativeSourceId, identity.storeId, `managed:${identity.machineId}`,
                    identity.storeId, `managed:${identity.machineId}`) as Row | undefined
            let riskTarget: StoredForkOperation | undefined
            if (request.duplicateRiskOf) {
                riskTarget = this.get(namespace, request.duplicateRiskOf)
                if (!riskTarget || riskTarget.operation.sourceSessionId !== request.sourceSessionId
                    || riskTarget.identity.machineId !== identity.machineId || riskTarget.identity.storeId !== identity.storeId
                    || riskTarget.identity.nativeSourceId !== identity.nativeSourceId) {
                    return { type: 'conflict', code: 'risk_target_invalid', message: 'The original operation does not belong to this exact source binding.', revision: state.revision }
                }
                if (state.operation?.operationId !== request.duplicateRiskOf || !riskTarget.activeBlocker
                    || riskTarget.operation.status !== 'indeterminate') {
                    return { type: 'conflict', code: 'risk_target_changed', message: 'The original operation is no longer the current unknown result. Check its latest state before deciding.',
                        revision: state.revision, operation: state.operation }
                }
                if (request.duplicateRiskOf === request.operationId
                    || request.sourceMachineId !== riskTarget.request.sourceMachineId
                    || request.sourceNativeThreadId !== riskTarget.request.sourceNativeThreadId
                    || request.sourceStoreId !== riskTarget.request.sourceStoreId
                    || request.messageLocalId !== riskTarget.request.messageLocalId
                    || JSON.stringify(request.nativeBoundary ?? null) !== JSON.stringify(riskTarget.request.nativeBoundary ?? null)) {
                    return { type: 'conflict', code: 'risk_payload_conflict', message: 'A duplicate-risk fork must preserve the original source and historical boundary.', revision: state.revision }
                }
            }
            if (unresolved && (!riskTarget || unresolved.namespace !== namespace
                || decode(unresolved).operation.operationId !== riskTarget.operation.operationId)) {
                return { type: 'conflict', code: 'operation_in_progress', message: 'A fork of this native source is still unresolved. Check the existing operation before creating another.',
                    revision: state.revision,
                    ...(unresolved.namespace === namespace ? { operation: decode(unresolved).operation } : {}) }
            }
            if (state.revision !== input.expectedRevision) {
                return { type: 'conflict', code: 'fork_revision_conflict', message: 'This source has a newer fork operation. Review it before deliberately creating another.',
                    revision: state.revision, operation: state.operation }
            }
            const operation = ForkOperationReceiptSchema.parse(input.operation)
            const validatedRequest = ForkOperationRpcRequestSchema.parse(request)
            if (operation.sourceRevision !== state.revision + 1 || validatedRequest.sourceRevision !== operation.sourceRevision
                || validatedRequest.operationId !== operation.operationId || validatedRequest.sourceSessionId !== operation.sourceSessionId
                || validatedRequest.childSessionId !== operation.childSessionId
                || validatedRequest.duplicateRiskOf !== operation.duplicateRiskOf
                || validatedRequest.sourceMachineId !== identity.machineId || validatedRequest.sourceNativeThreadId !== identity.nativeSourceId
                || (validatedRequest.sourceStoreId ?? `managed:${identity.machineId}`) !== identity.storeId
                || operation.status !== 'running') {
                throw new Error('Invalid fork admission identity or revision')
            }
            if (riskTarget) {
                this.db.prepare('UPDATE fork_operations SET active_blocker = 0 WHERE namespace = ? AND operation_id = ?')
                    .run(namespace, riskTarget.operation.operationId)
            }
            this.db.prepare(`INSERT INTO fork_operations(namespace, operation_id, source_session_id, machine_id, store_id,
                native_source_id, fingerprint, request_json, receipt_json, unresolved, active_blocker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`)
                .run(namespace, request.operationId, request.sourceSessionId, identity.machineId, identity.storeId,
                    identity.nativeSourceId, request.fingerprint, JSON.stringify(validatedRequest), JSON.stringify(operation))
            this.db.prepare(`INSERT INTO fork_sources(namespace, machine_id, store_id, native_source_id, revision, operation_id)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, machine_id, store_id, native_source_id)
                DO UPDATE SET revision = excluded.revision, operation_id = excluded.operation_id`)
                .run(namespace, identity.machineId, identity.storeId, identity.nativeSourceId, input.operation.sourceRevision, request.operationId)
            return { type: 'admitted', record: this.get(namespace, request.operationId)! }
        })
    }

    /** One-way intent commits before entering the RPC await. Never used on recovery. */
    markDispatched(namespace: string, operationId: string): boolean {
        return this.durableTransaction(() => this.db.prepare(`UPDATE fork_operations SET dispatched = 1
            WHERE namespace = ? AND operation_id = ? AND dispatched = 0 AND active_blocker = 1
                AND json_extract(receipt_json, '$.status') = 'running'`)
            .run(namespace, operationId).changes === 1)
    }

    merge(namespace: string, operationId: string, next: ForkOperationReceipt): ForkOperationReceipt {
        return this.durableTransaction(() => {
            const current = this.get(namespace, operationId)
            if (!current) throw new Error('Fork operation not found')
            const merged = mergeForkOperationReceipt(current.operation, ForkOperationReceiptSchema.parse(next))
            const ownsHead = this.sourceState(namespace, current.identity).operation?.operationId === operationId
            this.db.prepare('UPDATE fork_operations SET receipt_json = ?, unresolved = ?, active_blocker = ? WHERE namespace = ? AND operation_id = ?')
                .run(JSON.stringify(merged), isForkOperationUnresolved(merged) ? 1 : 0,
                    ownsHead && isForkOperationUnresolved(merged) ? 1 : 0, namespace, operationId)
            if (ownsHead && merged.status === 'rejected' && merged.duplicateRiskOf) {
                // A refused replacement did not consume the user's explicit risk decision.
                // Restore the current evidence, never a stale copy from admission time.
                const seen = new Set([operationId])
                let restoreId = merged.duplicateRiskOf
                let restore: StoredForkOperation
                while (true) {
                    if (seen.size > 128) throw new Error('Fork risk predecessor chain exceeds the safe recovery limit; source remains blocked')
                    if (seen.has(restoreId)) throw new Error('Fork risk predecessor cycle')
                    seen.add(restoreId)
                    const predecessor = this.get(namespace, restoreId)
                    if (!predecessor || predecessor.operation.sourceSessionId !== current.operation.sourceSessionId
                        || predecessor.identity.machineId !== current.identity.machineId
                        || predecessor.identity.storeId !== current.identity.storeId
                        || predecessor.identity.nativeSourceId !== current.identity.nativeSourceId) {
                        throw new Error('Fork risk predecessor identity is unavailable')
                    }
                    restore = predecessor
                    if (predecessor.operation.status !== 'rejected' || !predecessor.operation.duplicateRiskOf) break
                    restoreId = predecessor.operation.duplicateRiskOf
                }
                const restored = this.db.prepare(`UPDATE fork_sources SET operation_id = ?, revision = revision + 1
                    WHERE namespace = ? AND machine_id = ? AND store_id = ? AND native_source_id = ? AND operation_id = ?`)
                    .run(restore.operation.operationId, namespace, current.identity.machineId, current.identity.storeId,
                        current.identity.nativeSourceId, operationId)
                if (restored.changes !== 1) throw new Error('Fork source head changed during predecessor restoration')
                this.db.prepare('UPDATE fork_operations SET active_blocker = ? WHERE namespace = ? AND operation_id = ?')
                    .run(isForkOperationUnresolved(restore.operation) ? 1 : 0, namespace, restore.operation.operationId)
            }
            return merged
        })
    }

    /** Startup is conservative even for the crash window before dispatch was recorded. */
    recoverInterrupted(): void {
        this.durableTransaction(() => {
            const rows = this.db.prepare(`SELECT * FROM fork_operations WHERE unresolved = 1
                AND json_extract(receipt_json, '$.status') = 'running'`).all() as Row[]
            for (const row of rows) {
                const record = decode(row)
                if (record.operation.status !== 'running') continue
                this.merge(record.namespace, record.operation.operationId, { ...record.operation, status: 'indeterminate',
                    code: 'hub_restarted', message: 'The hub restarted before the fork result was confirmed. Check this operation; it will not be sent again.', updatedAt: Date.now() })
            }
        })
    }
}
