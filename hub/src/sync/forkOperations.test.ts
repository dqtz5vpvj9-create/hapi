import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FORK_CLOSED_UNADMITTED_CODE, type ForkOperationReceipt, type ForkOperationRpcRequest } from '@hapi/protocol/forkOperations'
import type { Metadata } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError, type RpcGateway } from './rpcGateway'

function fixture(path = ':memory:') {
    const store = new Store(path)
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const base: Metadata = { path: '/project', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
        codexStoreId: '/native/store', capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    const create = (name: string, metadata: Partial<Metadata> = {}, namespace = 'default', id?: string) => {
        const session = engine.getOrCreateSession(name, { ...base, codexSessionId: `native-${name}`, ...metadata }, { controlledByUser: false }, namespace,
            undefined, undefined, undefined, id)
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        engine.handleSessionReady({ sid: session.id, time: Date.now() })
        return session
    }
    const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    const ready = (request: ForkOperationRpcRequest, metadata: Partial<Metadata> = {}): { operation: ForkOperationReceipt } => {
        create(`child-${request.operationId}`, { codexSessionId: `native-child-${request.operationId}`, forkedFrom: request.sourceSessionId, ...metadata }, 'default', request.childSessionId)
        return { operation: { operationId: request.operationId, sourceSessionId: request.sourceSessionId, childSessionId: request.childSessionId,
            ...(request.duplicateRiskOf ? { duplicateRiskOf: request.duplicateRiskOf } : {}),
            sourceRevision: request.sourceRevision, status: 'created', nativeThreadId: `native-child-${request.operationId}`, binding: 'ready', message: 'Created', updatedAt: Date.now() } }
    }
    const close = () => { engine.stop(); store.close() }
    return { store, engine, create, rpc, ready, close }
}
const intent = (revision = 0) => ({ operationId: randomUUID(), expectedForkRevision: revision })

describe('Hub durable shared fork operations', () => {
    it('coalesces duplicate intent, blocks unknown second operation and commits dispatch before RPC', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const request = intent(); let calls = 0
            let release!: () => void
            const waiting = new Promise<void>(resolve => { release = resolve })
            f.rpc.forkOperation = async (_id, rpcRequest) => {
                calls++; expect(f.store.forkOperations.get('default', rpcRequest.operationId)?.dispatched).toBe(true)
                expect(rpcRequest).toMatchObject({ sourceMachineId: 'machine', sourceNativeThreadId: 'native-source', sourceStoreId: '/native/store' })
                await waiting; throw new Error('Native reply lost after creation')
            }
            // A read that beats both HTTP requests is observation only and creates no tombstone.
            await expect(f.engine.getForkOperation(source.id, 'default', request.operationId)).rejects.toThrow('not found')
            expect(f.engine.getForkSourceState(source.id, 'default')).toEqual({ revision: 0 })
            const first = f.engine.startForkOperation(source.id, 'default', request)
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ type: 'operation', operation: { status: 'running' } })
            expect(await f.engine.startForkOperation(source.id, 'default', intent(1))).toMatchObject({ type: 'conflict', code: 'operation_in_progress' })
            release(); expect(await first).toMatchObject({ operation: { status: 'indeterminate' } })
            // An explicitly resent, delayed original intent still replays the same receipt.
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ operation: {
                operationId: request.operationId, status: 'indeterminate' } })
            expect(await f.engine.startForkOperation(source.id, 'default', intent(1))).toMatchObject({ type: 'conflict', code: 'operation_in_progress' })
            expect(calls).toBe(1)
        } finally { f.close() }
    })

    it('rejects a stale tab immediately after success, permits a deliberate next action, and replays inactive sources', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const request = intent(); let calls = 0
            f.rpc.forkOperation = async (_id, req) => { calls++; return f.ready(req) }
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ operation: { status: 'created', binding: 'ready' } })
            expect(await f.engine.startForkOperation(source.id, 'default', intent())).toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
            expect(await f.engine.startForkOperation(source.id, 'default', intent(1))).toMatchObject({ operation: { status: 'created', binding: 'ready' } })
            f.engine.getSession(source.id)!.active = false
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ operation: { operationId: request.operationId, status: 'created' } })
            expect(calls).toBe(2)
        } finally { f.close() }
    })

    it('shares physical alias revisions without misrouting terminal receipts or blocking an explicit next fork', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const alias = f.create('alias', { codexSessionId: 'native-source' }); let calls = 0
            f.rpc.forkOperation = async (_id, req) => { calls++; return f.ready(req) }
            await f.engine.startForkOperation(source.id, 'default', intent())
            expect(f.engine.getForkSourceState(alias.id, 'default')).toEqual({ revision: 1 })
            const stale = await f.engine.startForkOperation(alias.id, 'default', intent())
            expect(stale).toMatchObject({ type: 'conflict', code: 'fork_revision_conflict', revision: 1 })
            expect('operation' in stale).toBe(false)
            expect(await f.engine.startForkOperation(alias.id, 'default', intent(1))).toMatchObject({ operation: {
                sourceSessionId: alias.id, status: 'created', binding: 'ready' } })
            expect(calls).toBe(2)
        } finally { f.close() }
    })

    it('points unresolved aliases to their original source and never exposes an operation under the wrong source', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const alias = f.create('alias', { codexSessionId: 'native-source' }); const request = intent(); let calls = 0
            f.rpc.forkOperation = async () => { calls++; throw new Error('Unknown native result') }
            await f.engine.startForkOperation(source.id, 'default', request)
            const state = f.engine.getForkSourceState(alias.id, 'default')
            expect(state).toMatchObject({ revision: 1, blockingSourceSessionId: source.id })
            expect(state.operation).toBeUndefined()
            const conflict = await f.engine.startForkOperation(alias.id, 'default', intent(1))
            expect(conflict).toMatchObject({ type: 'conflict', code: 'operation_in_progress', blockingSourceSessionId: source.id })
            expect('operation' in conflict).toBe(false)
            await expect(f.engine.getForkOperation(alias.id, 'default', request.operationId)).rejects.toThrow('not found')
            expect(calls).toBe(1)
        } finally { f.close() }
    })

    it('records proven preflight rejection with no dispatch and preserves actionable typed CLI rejection', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); f.engine.getSession(source.id)!.thinking = true
            let calls = 0
            f.rpc.forkOperation = async (_id, request) => { calls++; return { operation: { ...request, status: 'rejected', rejectionProof: 'not_dispatched', code: 'unsupported_inheritance', message: 'Restricted sandbox inheritance cannot be copied', updatedAt: Date.now() } } }
            const request = intent()
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ operation: { status: 'rejected', rejectionProof: 'not_dispatched', message: 'Session is busy' } })
            expect(f.store.forkOperations.get('default', request.operationId)?.dispatched).toBe(false)
            expect(calls).toBe(0); f.engine.getSession(source.id)!.thinking = false
            expect(await f.engine.startForkOperation(source.id, 'default', intent(1))).toMatchObject({ operation: { status: 'rejected', code: 'unsupported_inheritance', message: 'Restricted sandbox inheritance cannot be copied' } })
            expect(calls).toBe(1)
        } finally { f.close() }
    })

    it('rejects a definitely missing pre-send RPC target, but never treats a returned error envelope as no-create', async () => {
        const f = fixture()
        try {
            const source = f.create('source')
            f.rpc.forkOperation = async () => { throw new RpcTargetMissingError('source:fork-operation', 'handler-not-registered') }
            expect(await f.engine.startForkOperation(source.id, 'default', intent())).toMatchObject({ operation: {
                status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_operation_unavailable' } })
            f.rpc.forkOperation = async () => { throw new Error('handler unavailable after native dispatch') }
            expect(await f.engine.startForkOperation(source.id, 'default', intent(1))).toMatchObject({ operation: { status: 'indeterminate' } })
        } finally { f.close() }
    })

    it('does not mutate or dispatch a reused operation with a changed immutable boundary or changed source binding', async () => {
        const f = fixture()
        try {
            const source = f.create('source', { codexNativeSession: true }); const request = intent(); let calls = 0
            f.rpc.forkOperation = async () => { calls++; throw new Error('Unknown') }
            await f.engine.startForkOperation(source.id, 'default', request)
            expect(await f.engine.startForkOperation(source.id, 'default', { ...request,
                nativeBoundary: { threadId: 'native-source', turnId: 'turn', itemId: 'item' } })).toMatchObject({ type: 'conflict', code: 'operation_payload_conflict' })
            const row = f.store.sessions.getSession(source.id)!
            f.store.sessions.updateSessionMetadata(source.id, { ...(row.metadata as Metadata), codexStoreId: '/different/store' }, row.metadataVersion, 'default')
            await expect(f.engine.startForkOperation(source.id, 'default', request)).rejects.toThrow('binding changed')
            await expect(f.engine.getForkOperation(source.id, 'default', request.operationId, true)).rejects.toThrow('binding changed')
            expect(f.store.forkOperations.get('default', request.operationId)?.operation.status).toBe('indeterminate')
            expect(calls).toBe(1)
        } finally { f.close() }
    })

    it('uses exact authorized source keys and never reads history during status or unknown reconciliation', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const alias = f.create('alias', { codexSessionId: 'native-source' })
            const other = f.create('other', { codexSessionId: 'native-source' }, 'foreign')
            const request = intent(); let calls = 0
            f.rpc.forkOperation = async (_id, req) => { calls++; return { operation: { ...req, status: 'indeterminate', message: 'Unconfirmed', updatedAt: Date.now() } } }
            await f.engine.startForkOperation(source.id, 'default', request)
            expect(await f.engine.startForkOperation(alias.id, 'default', intent(1))).toMatchObject({ type: 'conflict', code: 'operation_in_progress' })
            const foreign = await f.engine.startForkOperation(other.id, 'foreign', intent())
            expect(foreign).toMatchObject({ type: 'conflict', code: 'operation_in_progress' }); expect('operation' in foreign).toBe(false)
            await expect(f.engine.getForkOperation(source.id, 'foreign', request.operationId)).rejects.toThrow('not found')
            await expect(f.engine.getForkOperation(alias.id, 'default', request.operationId)).rejects.toThrow('not found')
            for (const method of ['getAllMessages', 'getMessages', 'hasConversationContent'] as const) {
                f.store.messages[method] = (() => { throw new Error('History read during operation lookup') }) as never
            }
            f.rpc.forkOperation = async (_id, req) => {
                calls++; expect(req.action).toBe('read')
                return { operation: { ...req, status: 'indeterminate', message: 'Still unknown', updatedAt: Date.now() } }
            }
            expect(f.engine.getForkSourceState(source.id, 'default')).toMatchObject({ revision: 1 })
            expect(await f.engine.getForkOperation(source.id, 'default', request.operationId, true)).toMatchObject({ operation: { status: 'indeterminate' } })
            expect(calls).toBe(2)
        } finally { f.close() }
    })

    it('retains known creation after bind validation failure and recovers only the same child with current generation', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const request = intent(); let saved!: ForkOperationRpcRequest
            f.rpc.forkOperation = async (_id, req) => { saved = req; return f.ready(req, { forkedFrom: 'wrong-source' }) }
            const blocked = await f.engine.startForkOperation(source.id, 'default', request)
            expect(blocked).toMatchObject({ operation: { status: 'created', binding: 'blocked', nativeThreadId: `native-child-${request.operationId}` } })
            const change = (id: string, patch: Partial<Metadata>) => {
                const current = f.store.sessions.getSession(id)!
                f.store.sessions.updateSessionMetadata(id, { ...(current.metadata as Metadata), ...patch }, current.metadataVersion, 'default')
            }
            change(source.id, { hostPid: 99 }); change(saved.childSessionId, { hostPid: 99, forkedFrom: source.id })
            for (const method of ['getAllMessages', 'getMessages', 'hasConversationContent'] as const) {
                f.store.messages[method] = (() => { throw new Error('History read during known-child recovery') }) as never
            }
            f.rpc.forkOperation = async (_id, req) => {
                expect(req.action).toBe('reconcile'); expect(req.childSessionId).toBe(saved.childSessionId)
                return { operation: { operationId: req.operationId, sourceSessionId: req.sourceSessionId, childSessionId: req.childSessionId,
                    sourceRevision: req.sourceRevision, status: 'created', binding: 'ready', nativeThreadId: `native-child-${request.operationId}`, message: 'Binding recovered', updatedAt: Date.now() } }
            }
            expect(await f.engine.getForkOperation(source.id, 'default', request.operationId, true)).toMatchObject({ sessionId: saved.childSessionId, operation: { binding: 'ready' } })
        } finally { f.close() }
    })

    it('reconciles a late exact success after an RPC error and ignores stale unknown responses', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const request = intent(); let calls = 0
            f.rpc.forkOperation = async () => { calls++; throw new Error('outer acknowledgement lost') }
            await f.engine.startForkOperation(source.id, 'default', request)
            f.rpc.forkOperation = async (_id, req) => { calls++; expect(req.action).toBe('read'); return f.ready(req) }
            expect(await f.engine.getForkOperation(source.id, 'default', request.operationId)).toMatchObject({ operation: { status: 'created', binding: 'ready' } })
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ operation: { status: 'created' } })
            expect(calls).toBe(2)
        } finally { f.close() }
    })

    it('Hub disk reopen never redispatches admitted operations and remains queryable while inactive', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-fork-reopen-')); const path = join(dir, 'hub.db')
        let f = fixture(path)
        try {
            const source = f.create('source'); const request = intent()
            f.rpc.forkOperation = async () => { throw new Error('lost') }
            await f.engine.startForkOperation(source.id, 'default', request)
            f.close(); f = fixture(path)
            let calls = 0; f.rpc.forkOperation = async () => { calls++; throw new Error('must not dispatch') }
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ operation: { status: 'indeterminate' } })
            expect(await f.engine.getForkOperation(source.id, 'default', request.operationId)).toMatchObject({ operation: { status: 'indeterminate' } })
            expect(calls).toBe(0)
        } finally { f.close(); rmSync(dir, { recursive: true, force: true }) }
    })
})

describe('explicit duplicate-risk service', () => {
    it('requires modern explicit intent and inherits the original historical boundary rather than silently forking current', async () => {
        const f = fixture()
        try {
            const source = f.create('source', { codexNativeSession: true }); const a = intent()
            const nativeBoundary = { threadId: 'native-source', turnId: 'original-turn', itemId: 'original-item' }
            const requests: ForkOperationRpcRequest[] = []
            f.rpc.forkOperation = async (_id, req) => { requests.push(req); throw new Error('Unknown') }
            await f.engine.startForkOperation(source.id, 'default', { ...a, nativeBoundary })
            const b = { ...intent(1), duplicateRiskOf: a.operationId }
            await expect(f.engine.startForkOperation(source.id, 'default', { duplicateRiskOf: a.operationId })).rejects.toThrow()
            await expect(f.engine.startForkOperation(source.id, 'default', { ...b, nativeBoundary })).rejects.toThrow()
            const result = await f.engine.startForkOperation(source.id, 'default', b)
            expect(result).toMatchObject({ operation: { operationId: b.operationId, duplicateRiskOf: a.operationId, status: 'indeterminate' } })
            expect(requests).toHaveLength(2)
            expect(requests[1]).toMatchObject({ duplicateRiskOf: a.operationId, nativeBoundary,
                sourceMachineId: 'machine', sourceNativeThreadId: 'native-source', sourceStoreId: '/native/store' })
            expect(await f.engine.startForkOperation(source.id, 'default', b)).toMatchObject({ operation: { operationId: b.operationId, status: 'indeterminate' } })
            expect(requests).toHaveLength(2)
            expect(f.store.forkOperations.get('default', a.operationId)).toMatchObject({ activeBlocker: false, operation: { status: 'indeterminate' } })
        } finally { f.close() }
    })

    it('admits at most one concurrent risk replacement and allows a later explicit risk chain from its unknown result', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const a = intent(); let calls = 0
            f.rpc.forkOperation = async () => { calls++; throw new Error('Unknown original') }
            await f.engine.startForkOperation(source.id, 'default', a)
            let release!: () => void
            const wait = new Promise<void>(resolve => { release = resolve })
            f.rpc.forkOperation = async () => { calls++; await wait; throw new Error('Unknown replacement') }
            const b = { ...intent(1), duplicateRiskOf: a.operationId }
            const first = f.engine.startForkOperation(source.id, 'default', b)
            expect(await f.engine.startForkOperation(source.id, 'default', b)).toMatchObject({ operation: { status: 'running', operationId: b.operationId } })
            expect(await f.engine.startForkOperation(source.id, 'default', { ...intent(1), duplicateRiskOf: a.operationId }))
                .toMatchObject({ type: 'conflict', code: 'risk_target_changed' })
            release(); await first
            f.rpc.forkOperation = async () => { calls++; throw new Error('Unknown next replacement') }
            const c = { ...intent(2), duplicateRiskOf: b.operationId }
            expect(await f.engine.startForkOperation(source.id, 'default', c)).toMatchObject({ operation: { operationId: c.operationId, duplicateRiskOf: b.operationId, status: 'indeterminate' } })
            expect(calls).toBe(3)
            expect(f.engine.getForkSourceState(source.id, 'default')).toMatchObject({ revision: 3, operation: { operationId: c.operationId } })
        } finally { f.close() }
    })

    it('restores the original unknown after Hub preflight rejection and allows only a new deliberate risk intent with refreshed revision', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const a = intent(); let calls = 0
            f.rpc.forkOperation = async () => { calls++; throw new Error('Unknown') }
            await f.engine.startForkOperation(source.id, 'default', a)
            f.engine.getSession(source.id)!.thinking = true
            const b = { ...intent(1), duplicateRiskOf: a.operationId }
            expect(await f.engine.startForkOperation(source.id, 'default', b)).toMatchObject({ operation: { operationId: b.operationId, status: 'rejected', rejectionProof: 'not_dispatched' } })
            expect(f.engine.getForkSourceState(source.id, 'default')).toMatchObject({ revision: 3, operation: { operationId: a.operationId, sourceRevision: 1, status: 'indeterminate' } })
            expect(f.store.forkOperations.get('default', a.operationId)?.activeBlocker).toBe(true)
            f.engine.getSession(source.id)!.thinking = false
            expect(await f.engine.startForkOperation(source.id, 'default', { ...intent(2), duplicateRiskOf: a.operationId }))
                .toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
            expect(await f.engine.startForkOperation(source.id, 'default', { ...intent(3), duplicateRiskOf: a.operationId }))
                .toMatchObject({ operation: { status: 'indeterminate', sourceRevision: 4 } })
            expect(calls).toBe(2)
        } finally { f.close() }
    })

    it('observes CLI-authoritative original creation before rejecting replacement and restoring a ready head', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const a = intent(); let originalRequest!: ForkOperationRpcRequest
            f.rpc.forkOperation = async (_id, req) => { originalRequest = req; throw new Error('Original ack lost') }
            await f.engine.startForkOperation(source.id, 'default', a)
            const b = { ...intent(1), duplicateRiskOf: a.operationId }; const actions: string[] = []
            f.rpc.forkOperation = async (_id, req) => {
                actions.push(`${req.action}:${req.operationId}`)
                if (req.operationId === a.operationId) {
                    expect(req.action).toBe('read'); return f.ready(originalRequest)
                }
                return { operation: { ...req, status: 'rejected', rejectionProof: 'not_dispatched', code: 'risk_target_resolved',
                    message: 'Original is already created; replacement was not dispatched', updatedAt: Date.now() } }
            }
            expect(await f.engine.startForkOperation(source.id, 'default', b)).toMatchObject({ operation: { operationId: b.operationId, status: 'rejected', code: 'risk_target_resolved' } })
            expect(actions).toEqual([`start:${b.operationId}`, `read:${a.operationId}`])
            expect(f.engine.getForkSourceState(source.id, 'default')).toMatchObject({ revision: 3, operation: { operationId: a.operationId, status: 'created', binding: 'ready' } })
            expect(f.store.forkOperations.get('default', a.operationId)?.activeBlocker).toBe(false)
            expect(await f.engine.startForkOperation(source.id, 'default', intent(2))).toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
        } finally { f.close() }
    })

    it('refreshes an authoritative original rejection and otherwise restores an unobservable original conservatively', async () => {
        for (const observeOriginal of [true, false]) {
            const f = fixture()
            try {
                const source = f.create('source'); const a = intent()
                f.rpc.forkOperation = async () => { throw new Error('Unknown') }
                await f.engine.startForkOperation(source.id, 'default', a)
                f.rpc.forkOperation = async (_id, req) => {
                    if (req.operationId === a.operationId && !observeOriginal) throw new Error('Original unavailable')
                    return { operation: { ...req, status: 'rejected', rejectionProof: 'not_dispatched', code: 'risk_target_resolved', message: 'No dispatch', updatedAt: Date.now() } }
                }
                const b = { ...intent(1), duplicateRiskOf: a.operationId }
                expect(await f.engine.startForkOperation(source.id, 'default', b)).toMatchObject({ operation: { operationId: b.operationId, status: 'rejected' } })
                expect(f.engine.getForkSourceState(source.id, 'default')).toMatchObject({ revision: 3, operation: {
                    operationId: a.operationId, status: observeOriginal ? 'rejected' : 'indeterminate' } })
                expect(f.store.forkOperations.get('default', a.operationId)?.activeBlocker).toBe(!observeOriginal)
            } finally { f.close() }
        }
    })
})


describe('Hub and CLI fork receipt clock skew', () => {
    it('accepts an older CLI preflight rejection without retaining the newer Hub running fence', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const request = intent()
            f.rpc.forkOperation = async (_id, req) => {
                expect(f.store.forkOperations.get('default', req.operationId)!.operation.updatedAt).toBeGreaterThan(1)
                return { operation: { ...req, status: 'rejected', rejectionProof: 'not_dispatched', message: 'Native preflight refused', updatedAt: 1 } }
            }
            expect(await f.engine.startForkOperation(source.id, 'default', request)).toMatchObject({ operation: {
                status: 'rejected', rejectionProof: 'not_dispatched', updatedAt: 1 } })
            expect(f.store.forkOperations.get('default', request.operationId)?.activeBlocker).toBe(false)
        } finally { f.close() }
    })

    it('accepts an older CLI unknown receipt so a deliberate duplicate-risk request remains possible', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const a = intent(); let calls = 0
            f.rpc.forkOperation = async (_id, req) => { calls++; return { operation: { ...req,
                status: 'indeterminate', message: 'Native result unknown', updatedAt: 1 } } }
            expect(await f.engine.startForkOperation(source.id, 'default', a)).toMatchObject({ operation: { status: 'indeterminate', updatedAt: 1 } })
            const b = { ...intent(1), duplicateRiskOf: a.operationId }
            expect(await f.engine.startForkOperation(source.id, 'default', b)).toMatchObject({ operation: {
                operationId: b.operationId, duplicateRiskOf: a.operationId, status: 'indeterminate' } })
            expect(calls).toBe(2)
        } finally { f.close() }
    })

    it('accepts older definitive no-dispatch evidence during observation of a newer Hub unknown receipt', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const request = intent()
            f.rpc.forkOperation = async () => { throw new Error('Hub lost acknowledgement') }
            await f.engine.startForkOperation(source.id, 'default', request)
            f.rpc.forkOperation = async (_id, req) => ({ operation: { ...req, status: 'rejected', rejectionProof: 'not_dispatched', message: 'Never dispatched', updatedAt: 1 } })
            expect(await f.engine.getForkOperation(source.id, 'default', request.operationId)).toMatchObject({ operation: { status: 'rejected', updatedAt: 1 } })
            expect(f.store.forkOperations.get('default', request.operationId)?.activeBlocker).toBe(false)
        } finally { f.close() }
    })
})

function admitHubOnly(f: ReturnType<typeof fixture>, sourceId: string, revision: number, predecessor?: string) {
    const original = predecessor ? f.store.forkOperations.get('default', predecessor)!.request : undefined
    const request: ForkOperationRpcRequest = { action: 'start', operationId: randomUUID(), sourceSessionId: sourceId,
        childSessionId: randomUUID(), sourceRevision: revision + 1, sourceMachineId: 'machine', sourceStoreId: '/native/store',
        sourceNativeThreadId: 'native-source', fingerprint: randomUUID(),
        ...(predecessor ? { duplicateRiskOf: predecessor, nativeBoundary: original?.nativeBoundary, messageLocalId: original?.messageLocalId } : {}) }
    const operation: ForkOperationReceipt = { operationId: request.operationId, sourceSessionId: sourceId, childSessionId: request.childSessionId,
        sourceRevision: request.sourceRevision, ...(predecessor ? { duplicateRiskOf: predecessor } : {}),
        status: 'running', message: 'Hub admitted; RPC has not run', updatedAt: Date.now() }
    expect(f.store.forkOperations.admit({ namespace: 'default', identity: { machineId: 'machine', storeId: '/native/store', nativeSourceId: 'native-source' },
        expectedRevision: revision, request, operation }).type).toBe('admitted')
    return request
}
function closedReceipt(request: ForkOperationRpcRequest): ForkOperationReceipt {
    return { operationId: request.operationId, sourceSessionId: request.sourceSessionId, childSessionId: request.childSessionId,
        sourceRevision: request.sourceRevision, ...(request.duplicateRiskOf ? { duplicateRiskOf: request.duplicateRiskOf } : {}),
        status: 'rejected', rejectionProof: 'not_dispatched', code: FORK_CLOSED_UNADMITTED_CODE, message: 'Exact absence closed durably', updatedAt: Date.now() }
}

describe('explicit close of a CLI-unadmitted operation', () => {
    it('closes the Hub-admit-before-RPC crash window and replays after proof commit and lost HTTP reply', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-fork-close-')); const path = join(dir, 'hub.db')
        let f = fixture(path)
        try {
            const source = f.create('source', { codexNativeSession: true }); const a = intent()
            f.rpc.forkOperation = async () => { throw new Error('Original result unknown') }
            await f.engine.startForkOperation(source.id, 'default', { ...a,
                nativeBoundary: { threadId: 'native-source', turnId: 'original-turn', itemId: 'original-item' } })
            const b = admitHubOnly(f, source.id, 1, a.operationId)
            expect(f.store.forkOperations.get('default', b.operationId)?.dispatched).toBe(false)
            f.close(); f = fixture(path)
            f.engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const actions: ForkOperationRpcRequest[] = []
            f.rpc.forkOperation = async (_id, request) => {
                actions.push(request)
                if (request.action === 'read') throw new Error('No CLI receipt for B; reading must not close it')
                expect(request).toEqual({ ...b, action: 'close-unadmitted' })
                return { operation: closedReceipt(request) }
            }
            expect(await f.engine.getForkOperation(source.id, 'default', b.operationId)).toMatchObject({ operation: { status: 'indeterminate' } })
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 2 }))
                .toMatchObject({ closure: 'closed', operation: { operationId: b.operationId, status: 'rejected' }, sourceState: {
                    revision: 3, operation: { operationId: a.operationId, status: 'indeterminate', sourceRevision: 1 } } })
            expect(actions.map(request => request.action)).toEqual(['read', 'close-unadmitted', 'read'])
            expect(f.store.forkOperations.get('default', a.operationId)?.activeBlocker).toBe(true)
            // Simulate a crash after durable merge but before the HTTP reply was delivered.
            f.close(); f = fixture(path)
            f.rpc.forkOperation = async () => { throw new Error('Terminal close replay must not call the CLI') }
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 2 }))
                .toMatchObject({ closure: 'closed', sourceState: { revision: 3, operation: { operationId: a.operationId } } })
            expect(await f.engine.startForkOperation(source.id, 'default', { ...intent(2), duplicateRiskOf: a.operationId }))
                .toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
        } finally { f.close(); rmSync(dir, { recursive: true, force: true }) }
    })

    it('retries the same closure after CLI tombstone commit but lost acknowledgement, including Hub reopen', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-fork-close-ack-')); const path = join(dir, 'hub.db')
        let f = fixture(path)
        try {
            const source = f.create('source'); const b = admitHubOnly(f, source.id, 0)
            f.store.forkOperations.recoverInterrupted()
            const saved = closedReceipt(b); let closes = 0
            f.rpc.forkOperation = async (_id, request) => {
                expect(request.action).toBe('close-unadmitted'); closes++
                throw new Error('Tombstone committed; acknowledgement lost')
            }
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 1 }))
                .toMatchObject({ closure: 'unavailable', operation: { status: 'indeterminate' }, sourceState: { revision: 1 } })
            expect(f.store.forkOperations.get('default', b.operationId)?.activeBlocker).toBe(true)
            f.close(); f = fixture(path); f.engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            f.rpc.forkOperation = async (_id, request) => { expect(request.action).toBe('close-unadmitted'); closes++; return { operation: saved } }
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 1 }))
                .toMatchObject({ closure: 'closed', operation: { operationId: b.operationId, status: 'rejected' } })
            expect(f.store.forkOperations.get('default', b.operationId)?.activeBlocker).toBe(false)
            expect(closes).toBe(2)
        } finally { f.close(); rmSync(dir, { recursive: true, force: true }) }
    })

    it('never cancels an admitted operation or calls binding reconciliation from closure', async () => {
        for (const status of ['running', 'indeterminate', 'rejected', 'pending', 'blocked', 'ready'] as const) {
            const f = fixture()
            try {
                const source = f.create('source'); const b = admitHubOnly(f, source.id, 0); f.store.forkOperations.recoverInterrupted()
                let calls = 0
                f.rpc.forkOperation = async (_id, request) => {
                    calls++; expect(request.action).toBe('close-unadmitted')
                    if (status === 'ready') return f.ready(request)
                    const base = closedReceipt(request)
                    const operation: ForkOperationReceipt = status === 'pending' || status === 'blocked'
                        ? { ...base, status: 'created', nativeThreadId: 'exact-existing-child', binding: status }
                        : status === 'rejected' ? { ...base, code: 'original_preflight_rejected' }
                        : { ...base, status }
                    return { operation }
                }
                const result = await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 1 })
                expect(result).toMatchObject({ closure: status === 'rejected' ? 'already_resolved' : 'already_admitted', operation: { operationId: b.operationId } })
                expect(calls).toBe(1)
                expect(f.store.forkOperations.get('default', b.operationId)?.activeBlocker).toBe(status !== 'rejected' && status !== 'ready')
            } finally { f.close() }
        }
    })

    it('merges late closure proof only into B and cannot displace a newer current C', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const a = admitHubOnly(f, source.id, 0); f.store.forkOperations.recoverInterrupted()
            const b = admitHubOnly(f, source.id, 1, a.operationId); f.store.forkOperations.recoverInterrupted()
            let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve })
            const actions: string[] = []
            f.rpc.forkOperation = async (_id, request) => {
                actions.push(request.action)
                if (request.action === 'close-unadmitted') { await pending; return { operation: closedReceipt(request) } }
                throw new Error('A remains unknown')
            }
            const closure = f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 2 })
            const c = admitHubOnly(f, source.id, 2, b.operationId); f.store.forkOperations.recoverInterrupted()
            release()
            expect(await closure).toMatchObject({ closure: 'closed', operation: { operationId: b.operationId }, sourceState: {
                revision: 3, operation: { operationId: c.operationId, status: 'indeterminate' } } })
            expect(f.store.forkOperations.get('default', b.operationId)?.activeBlocker).toBe(false)
            expect(f.store.forkOperations.get('default', c.operationId)?.activeBlocker).toBe(true)
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 2 }))
                .toMatchObject({ closure: 'closed', sourceState: { operation: { operationId: c.operationId } } })
            expect(actions).toEqual(['close-unadmitted', 'read'])
        } finally { f.close() }
    })

    it('checks captured CAS, exact source ownership and frozen binding before any closure RPC', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const alias = f.create('alias', { codexSessionId: 'native-source' })
            const a = admitHubOnly(f, source.id, 0); f.store.forkOperations.recoverInterrupted()
            const b = admitHubOnly(f, source.id, 1, a.operationId); f.store.forkOperations.recoverInterrupted()
            let calls = 0; f.rpc.forkOperation = async () => { calls++; throw new Error('Must not dispatch') }
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 1 }))
                .toMatchObject({ type: 'conflict', code: 'fork_revision_conflict', sourceState: { revision: 2 } })
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', a.operationId, { expectedForkRevision: 2 }))
                .toMatchObject({ type: 'conflict', code: 'fork_revision_conflict' })
            await expect(f.engine.closeUnadmittedForkOperation(alias.id, 'default', b.operationId, { expectedForkRevision: 2 })).rejects.toThrow('not found')
            await expect(f.engine.closeUnadmittedForkOperation(source.id, 'foreign', b.operationId, { expectedForkRevision: 2 })).rejects.toThrow('not found')
            const row = f.store.sessions.getSession(source.id)!
            f.store.sessions.updateSessionMetadata(source.id, { ...(row.metadata as Metadata), codexStoreId: '/different/store' }, row.metadataVersion, 'default')
            await expect(f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 2 })).rejects.toThrow('binding changed')
            expect(calls).toBe(0)
        } finally { f.close() }
    })

    it('keeps missing canonical store, offline, still-running and malformed-proof results fenced', async () => {
        for (const failure of ['missing-store', 'offline', 'running', 'malformed', 'missing-handler'] as const) {
            const f = fixture()
            try {
                const source = f.create('source', failure === 'missing-store' ? { codexStoreId: undefined } : {})
                const b: { operationId: string; expectedForkRevision: number } = intent()
                f.rpc.forkOperation = async () => { throw new Error('Original unknown') }
                if (failure === 'running') {
                    const pending = admitHubOnly(f, source.id, 0); b.operationId = pending.operationId
                } else await f.engine.startForkOperation(source.id, 'default', b)
                if (failure === 'offline') f.engine.getSession(source.id)!.active = false
                let calls = 0
                f.rpc.forkOperation = async (_id, request) => {
                    calls++
                    if (failure === 'missing-handler') throw new RpcTargetMissingError('fork-operation', 'handler-not-registered')
                    return { operation: { ...closedReceipt(request), operationId: randomUUID() } }
                }
                const result = await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 1 })
                expect(result).toMatchObject(failure === 'running'
                    ? { type: 'conflict', code: 'fork_operation_not_indeterminate' }
                    : { closure: 'unavailable', operation: { status: 'indeterminate' } })
                expect(f.store.forkOperations.get('default', b.operationId)?.activeBlocker).toBe(true)
                expect(calls).toBe(failure === 'malformed' || failure === 'missing-handler' ? 1 : 0)
            } finally { f.close() }
        }
    })

    it('refreshes exact predecessor creation before closure restores its current ready state', async () => {
        const f = fixture()
        try {
            const source = f.create('source'); const a = admitHubOnly(f, source.id, 0); f.store.forkOperations.recoverInterrupted()
            const b = admitHubOnly(f, source.id, 1, a.operationId); f.store.forkOperations.recoverInterrupted()
            const actions: string[] = []
            f.rpc.forkOperation = async (_id, request) => {
                actions.push(request.action)
                return request.action === 'close-unadmitted' ? { operation: closedReceipt(request) } : f.ready(request)
            }
            expect(await f.engine.closeUnadmittedForkOperation(source.id, 'default', b.operationId, { expectedForkRevision: 2 }))
                .toMatchObject({ closure: 'closed', operation: { operationId: b.operationId }, sourceState: {
                    revision: 3, operation: { operationId: a.operationId, status: 'created', binding: 'ready' } } })
            expect(f.store.forkOperations.get('default', a.operationId)?.activeBlocker).toBe(false)
            expect(actions).toEqual(['close-unadmitted', 'read'])
        } finally { f.close() }
    })
})
