import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Metadata } from '@hapi/protocol/types'
import { FORK_CLOSED_UNADMITTED_CODE, ForkOperationCloseResponseSchema, type ForkOperationRpcRequest } from '@hapi/protocol/forkOperations'
import { Store } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SyncEngine } from '../../sync/syncEngine'
import type { RpcGateway } from '../../sync/rpcGateway'
import { createSessionsRoutes } from './sessions'
import type { WebAppEnv } from '../middleware/auth'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const metadata: Metadata = { host: 'test', path: '/project', flavor: 'codex', machineId: 'machine', hostPid: 42,
        codexSessionId: 'native-source', codexStoreId: '/native/store',
        capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    const source = engine.getOrCreateSession('source', metadata, { controlledByUser: false }, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now() })
    const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => { c.set('namespace', c.req.header('x-test-namespace') ?? 'default'); await next() })
    app.route('/api', createSessionsRoutes(() => engine))
    const request = (path: string, body?: unknown, namespace?: string) => app.request(`/api/sessions/${source.id}/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(namespace ? { 'x-test-namespace': namespace } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const ready = (req: ForkOperationRpcRequest) => {
        engine.getOrCreateSession(`child:${req.operationId}`, { ...metadata, codexSessionId: `native-child:${req.operationId}`, forkedFrom: source.id }, null,
            'default', undefined, undefined, undefined, req.childSessionId)
        return { operation: { operationId: req.operationId, childSessionId: req.childSessionId, sourceSessionId: source.id,
            sourceRevision: req.sourceRevision, status: 'created' as const, binding: 'ready' as const,
            nativeThreadId: `native-child:${req.operationId}`, message: 'Created', updatedAt: Date.now() } }
    }
    return { store, engine, source, rpc, request, ready, app, close: () => { engine.stop(); store.close() } }
}

describe('fork operation REST contract', () => {
    it('returns exact durable receipts and conflicts, remains queryable/replayable inactive, and isolates namespaces', async () => {
        const f = fixture()
        try {
            const input = { operationId: randomUUID(), expectedForkRevision: 0 }; let calls = 0
            f.rpc.forkOperation = async () => { calls++; throw new Error('Lost native result') }
            expect(await (await f.request('fork-operations')).json()).toEqual({ revision: 0 })
            expect((await f.request(`fork-operations/${input.operationId}`)).status).toBe(404)
            const first = await f.request('fork', input); expect(first.status).toBe(202)
            expect(await first.json()).toMatchObject({ operation: { status: 'indeterminate' } })
            const conflict = await f.request('fork', { operationId: randomUUID(), expectedForkRevision: 1 })
            expect(conflict.status).toBe(409)
            expect(await conflict.json()).toMatchObject({ code: 'operation_in_progress', revision: 1, operation: { operationId: input.operationId } })
            f.engine.getSession(f.source.id)!.active = false
            expect((await f.request('fork', input)).status).toBe(202)
            expect((await f.request(`fork-operations/${input.operationId}`)).status).toBe(202)
            expect((await f.request(`fork-operations/${input.operationId}/reconcile`, {})).status).toBe(202)
            expect((await f.request('fork-operations', undefined, 'foreign')).status).toBe(403)
            expect((await f.request(`fork-operations/${input.operationId}`, undefined, 'foreign')).status).toBe(403)
            expect((await f.request(`fork-operations/${randomUUID()}`)).status).toBe(404)
            expect(calls).toBe(1)
        } finally { f.close() }
    })

    it('returns an actionable same-namespace alias blocker and clears it after the original operation resolves', async () => {
        const f = fixture()
        try {
            const alias = f.engine.getOrCreateSession('alias', f.source.metadata, { controlledByUser: false }, 'default')
            f.engine.handleSessionAlive({ sid: alias.id, time: Date.now() })
            const input = { operationId: randomUUID(), expectedForkRevision: 0 }
            f.rpc.forkOperation = async () => { throw new Error('Unknown result') }
            await f.request('fork', input)
            const sourceStateUrl = `/api/sessions/${alias.id}/fork-operations`
            const state = await (await f.app.request(sourceStateUrl)).json()
            expect(state).toMatchObject({ revision: 1, blockingSourceSessionId: f.source.id })
            expect(state).not.toHaveProperty('operation')
            const conflict = await f.app.request(`/api/sessions/${alias.id}/fork`, { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationId: randomUUID(), expectedForkRevision: 1 }) })
            expect(conflict.status).toBe(409)
            const body = await conflict.json()
            expect(body).toMatchObject({ code: 'operation_in_progress', blockingSourceSessionId: f.source.id })
            expect(body).not.toHaveProperty('operation')
            f.rpc.forkOperation = async (_id, req) => f.ready(req)
            await f.request(`fork-operations/${input.operationId}`)
            expect(await (await f.app.request(sourceStateUrl)).json()).toEqual({ revision: 1 })
        } finally { f.close() }
    })

    it('preserves the old shared success response while using a reserved durable operation', async () => {
        const f = fixture()
        try {
            let calls = 0; let child = ''
            f.rpc.forkOperation = async (_id, req) => { calls++; child = req.childSessionId; return f.ready(req) }
            f.rpc.forkConversation = async () => { throw new Error('Unsafe fallback called') }
            const response = await f.request('fork', {})
            expect(response.status).toBe(200); expect(await response.json()).toEqual({ sessionId: child })
            expect(await (await f.request('fork-operations')).json()).toMatchObject({ revision: 1, operation: { status: 'created', binding: 'ready', childSessionId: child } })
            expect(calls).toBe(1)
        } finally { f.close() }
    })

    it('accepts only an explicit modern duplicate-risk intent and forbids client-supplied replacement boundaries', async () => {
        const f = fixture()
        try {
            const a = { operationId: randomUUID(), expectedForkRevision: 0 }
            const calls: ForkOperationRpcRequest[] = []
            f.rpc.forkOperation = async (_id, req) => { calls.push(req); throw new Error('Unknown result') }
            await f.request('fork', a)
            const b = { operationId: randomUUID(), expectedForkRevision: 1, duplicateRiskOf: a.operationId }
            for (const body of [{ duplicateRiskOf: a.operationId }, { ...b, operationId: a.operationId },
                { ...b, messageLocalId: 'changed' }, { ...b, nativeBoundary: { threadId: 'native-source', turnId: 'changed', itemId: 'changed' } }]) {
                expect((await f.request('fork', body)).status).toBe(400)
            }
            const result = await f.request('fork', b)
            expect(result.status).toBe(202)
            expect(await result.json()).toMatchObject({ operation: { operationId: b.operationId, duplicateRiskOf: a.operationId, status: 'indeterminate' } })
            expect(calls).toHaveLength(2)
            expect(calls[1]).toMatchObject({ duplicateRiskOf: a.operationId, operationId: b.operationId })
        } finally { f.close() }
    })

    it('returns modern preflight rejection as a typed known result and validates paired intent fields', async () => {
        const f = fixture()
        try {
            f.engine.getSession(f.source.id)!.thinking = true
            f.rpc.forkOperation = async () => { throw new Error('Must not dispatch') }
            const response = await f.request('fork', { operationId: randomUUID(), expectedForkRevision: 0 })
            expect(response.status).toBe(200)
            expect(await response.json()).toMatchObject({ operation: { status: 'rejected', rejectionProof: 'not_dispatched', message: 'Session is busy' } })
            expect((await f.request('fork', { operationId: randomUUID() })).status).toBe(400)
            expect((await f.request('fork', { expectedForkRevision: 1 })).status).toBe(400)
        } finally { f.close() }
    })
})

describe('close-unadmitted REST action', () => {
    it('returns own closure proof plus restored authoritative state and permits exact replay after lost response', async () => {
        const f = fixture()
        try {
            const a = { operationId: randomUUID(), expectedForkRevision: 0 }
            const b = { operationId: randomUUID(), expectedForkRevision: 1, duplicateRiskOf: a.operationId }
            f.rpc.forkOperation = async () => { throw new Error('Unknown') }
            await f.request('fork', a); await f.request('fork', b)
            const path = `fork-operations/${b.operationId}/close-unadmitted`; const actions: string[] = []
            f.rpc.forkOperation = async (_id, request) => {
                actions.push(request.action)
                if (request.action === 'read') throw new Error('Original remains unknown')
                return { operation: { ...request, status: 'rejected', rejectionProof: 'not_dispatched',
                    code: FORK_CLOSED_UNADMITTED_CODE, message: 'Absence tombstone committed', updatedAt: Date.now() } }
            }
            const conflict = await f.request(path, { expectedForkRevision: 1 })
            expect(conflict.status).toBe(409)
            expect(await conflict.json()).toMatchObject({ code: 'fork_revision_conflict', revision: 2,
                sourceState: { revision: 2, operation: { operationId: b.operationId } } })
            expect(actions).toEqual([])
            const response = await f.request(path, { expectedForkRevision: 2 })
            expect(response.status).toBe(200)
            const body = ForkOperationCloseResponseSchema.parse(await response.json())
            expect(body).toMatchObject({ closure: 'closed', operation: { operationId: b.operationId, status: 'rejected' },
                sourceState: { revision: 3, operation: { operationId: a.operationId, sourceRevision: 1, status: 'indeterminate' } } })
            expect(body).not.toHaveProperty('sessionId')
            f.engine.getSession(f.source.id)!.active = false
            const replay = await f.request(path, { expectedForkRevision: 2 })
            expect(replay.status).toBe(200)
            expect(await replay.json()).toMatchObject({ closure: 'closed', sourceState: { revision: 3, operation: { operationId: a.operationId } } })
            expect(actions).toEqual(['close-unadmitted', 'read'])
        } finally { f.close() }
    })

    it('rejects malformed body, aliases, foreign namespace and unknown IDs without any closure dispatch', async () => {
        const f = fixture()
        try {
            const b = { operationId: randomUUID(), expectedForkRevision: 0 }
            f.rpc.forkOperation = async () => { throw new Error('Unknown') }; await f.request('fork', b)
            let calls = 0; f.rpc.forkOperation = async () => { calls++; throw new Error('Must not dispatch') }
            const path = `fork-operations/${b.operationId}/close-unadmitted`
            for (const body of [{}, { expectedForkRevision: -1 }, { expectedForkRevision: 1, operationId: b.operationId },
                { expectedForkRevision: 1, messageLocalId: 'replacement' }, { expectedForkRevision: 1, sourceStoreId: '/other' }]) {
                expect((await f.request(path, body)).status).toBe(400)
            }
            expect((await f.request(path, { expectedForkRevision: 1 }, 'foreign')).status).toBe(403)
            expect((await f.request(`fork-operations/${randomUUID()}/close-unadmitted`, { expectedForkRevision: 1 })).status).toBe(404)
            expect((await f.request('fork-operations/not-uuid/close-unadmitted', { expectedForkRevision: 1 })).status).toBe(400)
            const alias = f.engine.getOrCreateSession('alias', f.source.metadata, null, 'default')
            const response = await f.app.request(`/api/sessions/${alias.id}/${path}`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedForkRevision: 1 }) })
            expect(response.status).toBe(404)
            expect(calls).toBe(0)
        } finally { f.close() }
    })

    it('reports unavailable instead of false closure and existing creation as already admitted without navigation', async () => {
        const f = fixture()
        try {
            const b = { operationId: randomUUID(), expectedForkRevision: 0 }
            f.rpc.forkOperation = async () => { throw new Error('Unknown') }; await f.request('fork', b)
            const path = `fork-operations/${b.operationId}/close-unadmitted`
            const unavailable = await f.request(path, { expectedForkRevision: 1 })
            expect(unavailable.status).toBe(202)
            expect(await unavailable.json()).toMatchObject({ closure: 'unavailable', operation: { status: 'indeterminate' } })
            f.rpc.forkOperation = async (_id, request) => {
                expect(request.action).toBe('close-unadmitted'); return f.ready(request)
            }
            const existing = await f.request(path, { expectedForkRevision: 1 })
            expect(existing.status).toBe(202)
            const body = ForkOperationCloseResponseSchema.parse(await existing.json())
            expect(body).toMatchObject({ closure: 'already_admitted', operation: { status: 'created', binding: 'ready' } })
            expect(body).not.toHaveProperty('sessionId')
        } finally { f.close() }
    })
})
