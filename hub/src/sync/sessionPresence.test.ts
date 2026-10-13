import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import type { EventPublisher } from './eventPublisher'
import type { SyncEvent } from '@hapi/protocol/types'
import type { NativeRuntimeState } from '@hapi/protocol/schemas'

function fixture() {
    const store = new Store(':memory:'); const events: SyncEvent[] = []
    const cache = new SessionCache(store, { emit: (event: SyncEvent) => events.push(structuredClone(event)) } as unknown as EventPublisher)
    const session = cache.getOrCreateSession('test', { host: 'test', path: '/work', flavor: 'codex', machineId: 'linux' }, null, 'default')
    const execution = (sequence: number, status: NativeRuntimeState['status'] = 'active'): NativeRuntimeState => ({
        owner: 'engine-A', generation: 'connection-A', sequence, status, waitingOn: [], turnId: 'turn-A',
        startedAt: 1791700000000, completedAt: null
    })
    return { store, cache, session, events, execution }
}

describe('ordered session presence', () => {
    it('rejects stale native reports, including old sockets after a takeover', () => {
        const f = fixture(); const time = Date.now()
        f.cache.handleSessionAlive({ sid: f.session.id, time, thinking: false, execution: f.execution(2, 'idle'), sourceConnection: 1 })
        f.cache.handleSessionAlive({ sid: f.session.id, time: time + 1, thinking: true, execution: f.execution(1), sourceConnection: 1 })
        expect(f.session.thinking).toBe(false)
        f.cache.handleSessionAlive({ sid: f.session.id, time: time + 1, thinking: true, sourceConnection: 1 })
        expect(f.session.thinking).toBe(false)
        f.cache.handleSessionAlive({ sid: f.session.id, time: time + 2, thinking: false, execution: { ...f.execution(1, 'idle'), generation: 'new' }, sourceConnection: 2 })
        f.cache.handleSessionAlive({ sid: f.session.id, time: time + 3, thinking: true, execution: f.execution(100), sourceConnection: 1 })
        expect(f.session.execution?.generation).toBe('new')
        expect(f.session.thinking).toBe(false)
        f.store.close()
    })
    it('uses actual native start time, while a queued message does not claim native execution', () => {
        const f = fixture(); const time = Date.now()
        f.cache.handleSessionAlive({ sid: f.session.id, time, thinking: false, execution: f.execution(1, 'idle') })
        f.cache.markMessageQueued(f.session.id)
        expect(f.session.thinking).toBe(false)
        expect(f.session.activeTurnStartedAt).toBeNull()
        f.cache.handleSessionAlive({ sid: f.session.id, time: time + 1, thinking: true, execution: f.execution(2) })
        expect(f.session.activeTurnStartedAt).toBe(1791700000000)
        f.store.close()
    })
    it('publishes the complete inactive transition and advances revisions across cache reloads', () => {
        const f = fixture(); const time = Date.now()
        f.cache.handleSessionAlive({ sid: f.session.id, time, thinking: true, execution: f.execution(1) })
        const version = f.session.executionVersion!
        expect(f.cache.expireInactive(time + 31000)).toEqual([f.session.id])
        const event = f.events.at(-1) as Extract<SyncEvent, { type: 'session-updated' }>
        expect(event.data).toMatchObject({ active: false, thinking: false, activeTurnStartedAt: null,
            backgroundTaskCount: 0, execution: { status: 'disconnected' } })
        expect((event.data as { executionVersion: number }).executionVersion).toBeGreaterThan(version)
        const cache2 = new SessionCache(f.store, { emit() {} } as unknown as EventPublisher)
        cache2.reloadAll()
        expect(cache2.getSession(f.session.id)!.executionVersion).toBeGreaterThan(f.session.executionVersion!)
        f.store.close()
    })
    it('does not merge identical Codex thread ids on different machines or native stores', async () => {
        const f = fixture()
        const create = (tag: string, machineId: string, codexStoreId: string) => f.cache.getOrCreateSession(tag,
            { host: 'test', path: '/work', flavor: 'codex', machineId, codexStoreId, codexSessionId: 'same-thread' }, null, 'default')
        const a = create('a', 'linux', '/store-a'), b = create('b', 'windows', '/store-a'), c = create('c', 'linux', '/store-b')
        f.store.messages.addMessage(a.id, { text: 'A' }); f.store.messages.addMessage(b.id, { text: 'B' })
        await f.cache.deduplicateByAgentSessionId(a.id)
        expect([a,b,c].every(s => f.cache.getSession(s.id))).toBe(true)
        expect(f.store.messages.getMessages(a.id, 10)).toHaveLength(1)
        expect(f.store.messages.getMessages(b.id, 10)).toHaveLength(1)
        f.store.close()
    })
})

describe('user read cursors', () => {
    it('synchronizes a user across clients without mixing users or namespaces', () => {
        const f = fixture()
        expect(f.store.presence.updateReadState('default', 1, f.session.id,
            { expectedVersion: 0, seenAt: 1000, manualUnreadAt: null }).applied).toBe(true)
        expect(f.store.presence.readStates('default', 1)[f.session.id]).toMatchObject({ seenAt: 1000, version: 1 })
        expect(f.store.presence.readStates('default', 2)).toEqual({})
        expect(f.store.presence.readStates('other', 1)).toEqual({})
        f.store.presence.updateReadState('default', 1, f.session.id, { expectedVersion: 1, seenAt: 1000, manualUnreadAt: 1000 })
        const stale = f.store.presence.updateReadState('default', 1, f.session.id, { expectedVersion: 1, seenAt: 2000, manualUnreadAt: null })
        expect(stale.applied).toBe(false)
        expect(stale.state.manualUnreadAt).toBe(1000)
        f.store.close()
    })
})

it('keeps an old socket end from disconnecting a replacement and measures liveness on the Hub clock', () => {
    const f = fixture()
    f.cache.handleSessionAlive({ sid: f.session.id, time: Date.now() - 86400000, thinking: true,
        execution: f.execution(1), sourceConnection: 2 })
    expect(f.session.activeAt).toBeGreaterThan(Date.now() - 1000)
    f.cache.handleSessionEnd({ sid: f.session.id, time: Date.now(), sourceConnection: 1 })
    expect(f.session.thinking).toBe(true)
    f.cache.handleSessionEnd({ sid: f.session.id, time: Date.now(), sourceConnection: 2 })
    expect(f.session.thinking).toBe(false)
    expect(f.session.execution?.status).toBe('disconnected')
    f.store.close()
})

it('broadcasts capacity state and cancellation immediately, rejecting stale countdown resurrection', () => {
    const f = fixture(); const time = Date.now();
    const send = (sequence: number, capacityRecovery: NativeRuntimeState['capacityRecovery']) =>
        f.cache.handleSessionAlive({ sid: f.session.id, time, thinking: false,
            execution: { ...f.execution(sequence, 'systemError'), capacityRecovery }, sourceConnection: 1 });
    send(1, null); const count = f.events.length;
    send(2, { turnId: 'turn-A', phase: 'waiting', retryAt: time + 30_000, attempt: 1, maxAttempts: 5 });
    expect(f.events.length).toBe(count + 1);
    expect(f.events.at(-1)).toMatchObject({ type: 'session-updated', data: { execution: { capacityRecovery: { phase: 'waiting' } } } });
    send(3, null); expect(f.events.at(-1)).toMatchObject({ type: 'session-updated', data: { execution: { capacityRecovery: null } } });
    const canceled = f.events.length;
    send(2, { turnId: 'turn-A', phase: 'waiting', retryAt: time + 30_000 });
    expect(f.events.length).toBe(canceled); expect(f.session.execution?.capacityRecovery).toBeNull();
    f.store.close();
});
