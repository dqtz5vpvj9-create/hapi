import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from './index'
import type { ForkOperationReceipt, ForkOperationRpcRequest } from '@hapi/protocol/forkOperations'

const identity = { machineId: 'machine', storeId: '/native/store', nativeSourceId: 'native-source' }
function input(options: { namespace?: string; operationId?: string; source?: string; revision?: number; fingerprint?: string } = {}) {
    const request: ForkOperationRpcRequest = { action: 'start', operationId: options.operationId ?? randomUUID(),
        sourceSessionId: options.source ?? 'source', sourceMachineId: identity.machineId, sourceNativeThreadId: identity.nativeSourceId,
        sourceStoreId: identity.storeId, childSessionId: randomUUID(), sourceRevision: (options.revision ?? 0) + 1,
        fingerprint: options.fingerprint ?? 'same-request' }
    const operation: ForkOperationReceipt = { operationId: request.operationId, sourceSessionId: request.sourceSessionId,
        childSessionId: request.childSessionId, sourceRevision: request.sourceRevision, status: 'running', message: 'Accepted', updatedAt: 1 }
    return { namespace: options.namespace ?? 'default', identity, request, operation, expectedRevision: options.revision ?? 0 }
}

describe('durable fork admission', () => {
    it('atomically reserves revision, replays before CAS, detects changed payload and fences aliases', () => {
        const store = new Store(':memory:')
        try {
            const original = input()
            expect(store.forkOperations.admit(original).type).toBe('admitted')
            expect(store.forkOperations.admit(original)).toMatchObject({ type: 'replay', record: { operation: original.operation } })
            expect(store.forkOperations.admit({ ...original, request: { ...original.request, fingerprint: 'changed' } }))
                .toMatchObject({ type: 'conflict', code: 'operation_payload_conflict' })
            expect(store.forkOperations.admit(input({ source: 'alias', revision: 1 })))
                .toMatchObject({ type: 'conflict', code: 'operation_in_progress', operation: { operationId: original.request.operationId } })
            expect(store.forkOperations.markDispatched('default', original.request.operationId)).toBe(true)
            expect(store.forkOperations.markDispatched('default', original.request.operationId)).toBe(false)
            store.forkOperations.merge('default', original.request.operationId, { ...original.operation,
                status: 'created', nativeThreadId: 'native-child', binding: 'ready', updatedAt: 2 })
            expect(store.forkOperations.admit(input())).toMatchObject({ type: 'conflict', code: 'fork_revision_conflict', revision: 1 })
            expect(store.forkOperations.admit(input({ revision: 1 })).type).toBe('admitted')
        } finally { store.close() }
    })

    it('redacts receipts across namespaces while fencing the physical source globally', () => {
        const store = new Store(':memory:')
        try {
            const original = input()
            store.forkOperations.admit(original)
            const foreign = store.forkOperations.admit(input({ namespace: 'other' }))
            expect(foreign).toMatchObject({ type: 'conflict', code: 'operation_in_progress', revision: 0 })
            expect('operation' in foreign).toBe(false)
            expect(store.forkOperations.get('other', original.request.operationId)).toBeUndefined()
            expect(store.forkOperations.sourceState('other', identity)).toEqual({ revision: 0 })
        } finally { store.close() }
    })

    it('conservatively fences a managed missing-store alias against a canonical store alias', () => {
        const store = new Store(':memory:')
        try {
            const original = input()
            store.forkOperations.admit({ ...original, request: { ...original.request, sourceStoreId: undefined },
                identity: { ...identity, storeId: 'managed:machine' } })
            expect(store.forkOperations.admit(input())).toMatchObject({ type: 'conflict', code: 'operation_in_progress' })
            expect(store.forkOperations.sourceState('default', identity)).toMatchObject({ revision: 1 })
            store.forkOperations.merge('default', original.request.operationId, { ...original.operation, status: 'rejected',
                rejectionProof: 'not_dispatched', message: 'Preflight rejected', updatedAt: 2 })
            expect(store.forkOperations.admit(input())).toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
        } finally { store.close() }
    })

    it('never regresses a known child on stale/late unknown results and keeps the binding fence', () => {
        const store = new Store(':memory:')
        try {
            const original = input(); store.forkOperations.admit(original)
            const created: ForkOperationReceipt = { ...original.operation, status: 'created', nativeThreadId: 'known', binding: 'blocked', updatedAt: 3 }
            store.forkOperations.merge('default', original.request.operationId, created)
            expect(store.forkOperations.merge('default', original.request.operationId, { ...original.operation, status: 'indeterminate', updatedAt: 9 })).toEqual(created)
            expect(store.forkOperations.admit(input({ revision: 1 }))).toMatchObject({ type: 'conflict', code: 'operation_in_progress' })
            expect(() => store.forkOperations.merge('default', original.request.operationId, { ...created, nativeThreadId: 'wrong' })).toThrow('identity')
        } finally { store.close() }
    })

    it('upgrades v30 and reopens accepted/dispatched receipts unknown without deleting source fences', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-fork-store-')); const path = join(dir, 'hub.db')
        let store = new Store(path)
        try {
            store.close()
            const old = new Database(path)
            old.exec('DROP TABLE fork_operations; DROP TABLE fork_sources; PRAGMA user_version = 30'); old.close()
            store = new Store(path)
            const original = input(); store.forkOperations.admit(original)
            store.forkOperations.markDispatched('default', original.request.operationId)
            store.close(); store = new Store(path)
            expect(store.forkOperations.get('default', original.request.operationId)).toMatchObject({ dispatched: true, operation: { status: 'indeterminate', code: 'hub_restarted' } })
            expect(store.forkOperations.admit(original).type).toBe('replay')
            expect(store.forkOperations.admit(input({ revision: 1 })).type).toBe('conflict')
        } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
    })
})

function riskInput(target: ReturnType<typeof input>, revision: number) {
    const next = input({ source: target.request.sourceSessionId, revision, fingerprint: `risk:${target.request.operationId}:${revision}` })
    next.request = { ...next.request, duplicateRiskOf: target.request.operationId,
        sourceMachineId: target.request.sourceMachineId, sourceNativeThreadId: target.request.sourceNativeThreadId,
        sourceStoreId: target.request.sourceStoreId, messageLocalId: target.request.messageLocalId, nativeBoundary: target.request.nativeBoundary }
    next.operation = { ...next.operation, duplicateRiskOf: target.request.operationId }
    return next
}
function admitUnknown(store: Store, entry: ReturnType<typeof input>) {
    expect(store.forkOperations.admit(entry).type).toBe('admitted')
    store.forkOperations.markDispatched(entry.namespace, entry.request.operationId)
    store.forkOperations.merge(entry.namespace, entry.request.operationId, { ...entry.operation, status: 'indeterminate', updatedAt: 2 })
}
const reject = (entry: ReturnType<typeof input>): ForkOperationReceipt => ({ ...entry.operation,
    status: 'rejected', rejectionProof: 'not_dispatched', updatedAt: 10 })

describe('explicit duplicate-risk Hub transaction', () => {
    it('atomically transfers only the current unknown blocker and exact same-ID replay never transfers twice', () => {
        const store = new Store(':memory:')
        try {
            const a = input(); admitUnknown(store, a)
            expect(store.forkOperations.admit(riskInput(a, 0))).toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
            const b = riskInput(a, 1)
            expect(store.forkOperations.admit(b).type).toBe('admitted')
            expect(store.forkOperations.admit(b).type).toBe('replay')
            expect(store.forkOperations.get('default', a.request.operationId)).toMatchObject({ activeBlocker: false, operation: { status: 'indeterminate' } })
            expect(store.forkOperations.get('default', b.request.operationId)).toMatchObject({ activeBlocker: true, operation: { duplicateRiskOf: a.request.operationId } })
            expect(store.forkOperations.admit(riskInput(a, 2))).toMatchObject({ type: 'conflict', code: 'risk_target_changed' })
            expect(store.forkOperations.sourceState('default', identity)).toMatchObject({ revision: 2, operation: { operationId: b.request.operationId } })
        } finally { store.close() }
    })

    it('rejects foreign namespace, aliases, physical-store changes and altered inherited history before changing the head', () => {
        const store = new Store(':memory:')
        try {
            const a = input(); a.request.nativeBoundary = { threadId: 'native-source', turnId: 'turn', itemId: 'item' }; admitUnknown(store, a)
            const b = riskInput(a, 1)
            for (const bad of [
                { ...b, namespace: 'foreign' },
                { ...b, request: { ...b.request, sourceSessionId: 'alias' } },
                { ...b, identity: { ...identity, storeId: '/other/store' } }
            ]) expect(store.forkOperations.admit(bad)).toMatchObject({ type: 'conflict', code: 'risk_target_invalid' })
            expect(store.forkOperations.admit({ ...b, request: { ...b.request, nativeBoundary: undefined } }))
                .toMatchObject({ type: 'conflict', code: 'risk_payload_conflict' })
            expect(store.forkOperations.get('default', a.request.operationId)?.activeBlocker).toBe(true)
            expect(store.forkOperations.sourceState('default', identity).revision).toBe(1)
        } finally { store.close() }
    })

    it('restores the predecessor CURRENT evidence on no-dispatch rejection and advances the head revision again', () => {
        const store = new Store(':memory:')
        try {
            const a = input(); admitUnknown(store, a); const b = riskInput(a, 1); store.forkOperations.admit(b)
            store.forkOperations.merge('default', a.request.operationId, { ...a.operation, status: 'created', binding: 'ready', nativeThreadId: 'exact-child', updatedAt: 3 })
            expect(store.forkOperations.sourceState('default', identity)).toMatchObject({ revision: 2, operation: { operationId: b.request.operationId } })
            store.forkOperations.merge('default', b.request.operationId, reject(b))
            expect(store.forkOperations.sourceState('default', identity)).toMatchObject({ revision: 3, operation: {
                operationId: a.request.operationId, sourceRevision: 1, status: 'created', binding: 'ready' } })
            expect(store.forkOperations.get('default', a.request.operationId)?.activeBlocker).toBe(false)
            expect(store.forkOperations.admit(input({ revision: 2 }))).toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
            expect(store.forkOperations.admit(input({ revision: 3 })).type).toBe('admitted')
        } finally { store.close() }
    })

    it('does not let old late results change a newer head and rolls a rejected risk chain back to its unresolved ancestor', () => {
        const store = new Store(':memory:')
        try {
            const a = input(); admitUnknown(store, a); const b = riskInput(a, 1); admitUnknown(store, b)
            const c = riskInput(b, 2); store.forkOperations.admit(c)
            store.forkOperations.merge('default', b.request.operationId, reject(b))
            expect(store.forkOperations.sourceState('default', identity)).toMatchObject({ revision: 3, operation: { operationId: c.request.operationId } })
            store.forkOperations.merge('default', c.request.operationId, reject(c))
            expect(store.forkOperations.sourceState('default', identity)).toMatchObject({ revision: 4, operation: { operationId: a.request.operationId, status: 'indeterminate' } })
            expect(store.forkOperations.get('default', a.request.operationId)?.activeBlocker).toBe(true)
            expect(store.forkOperations.get('default', b.request.operationId)?.activeBlocker).toBe(false)
            expect(store.forkOperations.get('default', c.request.operationId)?.activeBlocker).toBe(false)
        } finally { store.close() }
    })

    it('fails closed at the fixed predecessor recovery bound instead of dropping the source fence', () => {
        const store = new Store(':memory:')
        try {
            const chain = [input()]; admitUnknown(store, chain[0]!)
            for (let revision = 1; revision <= 129; revision++) {
                const next = riskInput(chain.at(-1)!, revision); admitUnknown(store, next); chain.push(next)
            }
            for (const entry of chain.slice(1, -1)) store.forkOperations.merge('default', entry.request.operationId, reject(entry))
            const head = chain.at(-1)!
            expect(() => store.forkOperations.merge('default', head.request.operationId, reject(head))).toThrow('safe recovery limit')
            expect(store.forkOperations.get('default', head.request.operationId)).toMatchObject({ activeBlocker: true, operation: { status: 'indeterminate' } })
            expect(store.forkOperations.sourceState('default', identity)).toMatchObject({ revision: 130, operation: { operationId: head.request.operationId } })
        } finally { store.close() }
    })
})

describe('fork-scoped SQLite FULL durability', () => {
    const database = (store: Store) => (store as unknown as { db: Database }).db
    const synchronous = (db: Database) => (db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous

    it('keeps FULL through admit/dispatch/merge commits and nested recovery savepoints, then restores NORMAL', () => {
        const store = new Store(':memory:'); const db = database(store)
        const committed: Array<{ synchronous: number; nested: boolean }> = []
        const transaction = db.transaction.bind(db)
        db.transaction = ((work: () => unknown) => {
            const call = transaction(work)
            return {
                immediate: () => {
                    const value = call.immediate()
                    // The actual COMMIT/RELEASE has returned, but the fork wrapper has
                    // not yet restored the shared connection's original mode.
                    committed.push({ synchronous: synchronous(db), nested: db.inTransaction })
                    return value
                }
            }
        }) as unknown as Database['transaction']
        try {
            expect(synchronous(db)).toBe(1)
            const a = input()
            store.forkOperations.admit(a); expect(synchronous(db)).toBe(1)
            store.forkOperations.markDispatched('default', a.request.operationId); expect(synchronous(db)).toBe(1)
            store.forkOperations.recoverInterrupted(); expect(synchronous(db)).toBe(1)
            expect(store.forkOperations.get('default', a.request.operationId)?.operation.status).toBe('indeterminate')
            store.forkOperations.merge('default', a.request.operationId, { ...a.operation, status: 'created', nativeThreadId: 'known', binding: 'pending', updatedAt: Date.now() })
            expect(synchronous(db)).toBe(1)
            expect(committed).toEqual([
                { synchronous: 2, nested: false }, { synchronous: 2, nested: false },
                { synchronous: 2, nested: true }, { synchronous: 2, nested: false },
                { synchronous: 2, nested: false }
            ])
        } finally { store.close() }
    })

    it('rolls back a failed admission atomically and restores NORMAL before another unrelated write', () => {
        const store = new Store(':memory:'); const db = database(store)
        try {
            db.exec("CREATE TRIGGER fail_fork_head BEFORE INSERT ON fork_sources BEGIN SELECT RAISE(ABORT, 'synthetic head write failure'); END")
            const a = input()
            expect(() => store.forkOperations.admit(a)).toThrow('synthetic head write failure')
            expect(store.forkOperations.get('default', a.request.operationId)).toBeUndefined()
            expect(store.forkOperations.sourceState('default', identity)).toEqual({ revision: 0 })
            expect(db.inTransaction).toBe(false); expect(synchronous(db)).toBe(1)
            db.exec('DROP TRIGGER fail_fork_head')
            expect(store.forkOperations.admit(a).type).toBe('admitted')
            expect(synchronous(db)).toBe(1)
        } finally { store.close() }
    })

    it('restores NORMAL after a nested recovery rollback and refuses caller-owned transactions without changing them', () => {
        const store = new Store(':memory:'); const db = database(store)
        try {
            const a = input(); store.forkOperations.admit(a)
            db.exec("CREATE TRIGGER fail_fork_recovery BEFORE UPDATE ON fork_operations BEGIN SELECT RAISE(ABORT, 'synthetic recovery failure'); END")
            expect(() => store.forkOperations.recoverInterrupted()).toThrow('synthetic recovery failure')
            expect(store.forkOperations.get('default', a.request.operationId)?.operation.status).toBe('running')
            expect(db.inTransaction).toBe(false); expect(synchronous(db)).toBe(1)
            db.exec('DROP TRIGGER fail_fork_recovery')
            db.transaction(() => {
                expect(() => store.forkOperations.markDispatched('default', a.request.operationId)).toThrow('independent FULL')
                expect(db.inTransaction).toBe(true); expect(synchronous(db)).toBe(1)
            }).immediate()
            expect(store.forkOperations.get('default', a.request.operationId)?.dispatched).toBe(false)
            store.forkOperations.recoverInterrupted()
            expect(synchronous(db)).toBe(1)
        } finally { store.close() }
    })

    it('preserves an already-stronger caller durability setting instead of downgrading it', () => {
        const store = new Store(':memory:'); const db = database(store)
        try {
            db.exec('PRAGMA synchronous = EXTRA')
            const a = input(); store.forkOperations.admit(a)
            store.forkOperations.recoverInterrupted()
            expect(synchronous(db)).toBe(3)
        } finally { store.close() }
    })
})
