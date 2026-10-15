import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}
function setSpawn(engine: SyncEngine, spawn: (...args: unknown[]) => Promise<unknown>) {
    ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession = spawn
}

describe('durable fresh spawn request identity', () => {
    it('coalesces concurrent requests and replays a lost success response', async () => {
        const { store, engine } = setup()
        try {
            let calls = 0
            let release!: () => void
            const barrier = new Promise<void>(resolve => { release = resolve })
            setSpawn(engine, async (...args) => { calls++; await barrier; return { type: 'success', sessionId: args[17] } })
            const request = { requestId: randomUUID(), directory: '/project' }
            const first = engine.spawnSessionIdempotent('machine', 'default', request)
            const second = engine.spawnSessionIdempotent('machine', 'default', request)
            expect(calls).toBe(1)
            release()
            const result = await first
            expect(result.type).toBe('success')
            expect(await second).toEqual(result)
            expect(await engine.spawnSessionIdempotent('machine', 'default', request)).toEqual(result)
            expect(calls).toBe(1)
            const changed = await engine.spawnSessionIdempotent('machine', 'default', { ...request, directory: '/other' })
            expect(changed).toMatchObject({ type: 'error', code: 'spawn_request_conflict' })
            expect(calls).toBe(1)
        } finally { engine.stop(); store.close() }
    })

    it('isolates identical IDs by namespace', async () => {
        const { store, engine } = setup()
        try {
            let calls = 0
            setSpawn(engine, async (...args) => { calls++; return { type: 'success', sessionId: args[17] } })
            const request = { requestId: randomUUID(), directory: '/project' }
            const first = await engine.spawnSessionIdempotent('machine', 'one', request)
            const second = await engine.spawnSessionIdempotent('machine', 'two', request)
            expect(first.type).toBe('success')
            expect(second.type).toBe('success')
            expect(first).not.toEqual(second)
            expect(calls).toBe(2)
        } finally { engine.stop(); store.close() }
    })

    it('does not redispatch an ambiguous timeout, even in a new engine', async () => {
        const { store, engine } = setup()
        const restarted = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            let calls = 0
            setSpawn(engine, async () => { calls++; throw new Error('RPC timed out') })
            setSpawn(restarted, async () => { throw new Error('must not dispatch') })
            const request = { requestId: randomUUID(), directory: '/project' }
            const result = await engine.spawnSessionIdempotent('machine', 'default', request)
            expect(result).toMatchObject({ type: 'error', code: 'spawn_outcome_unknown' })
            const retry = await restarted.spawnSessionIdempotent('machine', 'default', request)
            expect(retry).toMatchObject({ type: 'error', code: 'spawn_outcome_unknown', sessionId: result.type === 'error' ? result.sessionId : '' })
            expect(calls).toBe(1)
        } finally { restarted.stop(); engine.stop(); store.close() }
    })

    it('resolves late CLI registration to the original session without dispatch', async () => {
        const { store, engine } = setup()
        try {
            let calls = 0
            setSpawn(engine, async () => { calls++; throw new Error('RPC timed out') })
            const request = { requestId: randomUUID(), directory: '/project' }
            const result = await engine.spawnSessionIdempotent('machine', 'default', request)
            if (result.type !== 'error' || !result.sessionId) throw new Error('Expected unknown session identity')
            const row = store.sessions.getSession(result.sessionId)!
            store.sessions.updateSessionMetadata(row.id, { ...(row.metadata as object), hostPid: 42 }, row.metadataVersion, 'default')
            expect(await engine.spawnSessionIdempotent('machine', 'default', request)).toEqual({ type: 'success', sessionId: row.id })
            expect(calls).toBe(1)
        } finally { engine.stop(); store.close() }
    })

    it('preserves a definitive no-child rejection and permits a new explicit request', async () => {
        const { store, engine } = setup()
        try {
            let calls = 0
            setSpawn(engine, async () => { calls++; return { type: 'error', message: 'Unavailable', childStarted: false } })
            const request = { requestId: randomUUID(), directory: '/project' }
            const result = await engine.spawnSessionIdempotent('machine', 'default', request)
            expect(result).toMatchObject({ type: 'error', childStarted: false })
            expect(await engine.spawnSessionIdempotent('machine', 'default', request)).toEqual(result)
            expect(calls).toBe(1)
            await engine.spawnSessionIdempotent('machine', 'default', { ...request, requestId: randomUUID() })
            expect(calls).toBe(2)
        } finally { engine.stop(); store.close() }
    })
})
