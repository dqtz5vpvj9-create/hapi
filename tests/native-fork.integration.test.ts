import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../hub/src/store'
import { SyncEngine } from '../hub/src/sync/syncEngine'
import { RpcRegistry } from '../hub/src/socket/rpcRegistry'
import { SharedCodexRoot } from '../cli/src/codex/shared/root'
import { RpcHandlerManager } from '../cli/src/api/rpc/RpcHandlerManager'
import { ForkJournal } from '../cli/src/codex/shared/forkJournal'
import { SharedForkOperations } from '../cli/src/codex/shared/forkOperations'
import type { ForkOperationRpcRequest } from '../shared/src/forkOperations'
import { NativeForkFixture } from '../cli/src/test/nativeForkFixture'
import { RPC_METHODS } from '../shared/src/rpcMethods'
import type { Metadata } from '../shared/src/types'

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'native-fork-contract-'))
    const native = new NativeForkFixture(home)
    const segment = native.addSegment({})
    const boundary = native.addTurn(segment, {})
    native.checkpoint(segment)
    const store = new Store(':memory:')
    const registry = new RpcRegistry()
    let manager: RpcHandlerManager
    const packets: Array<{ method: string; params: string }> = []
    let loseNextAck = false
    let holdNextDelivery = false
    let loseNextAckEarly = false
    const heldPackets: Array<{ method: string; params: string }> = []
    let pendingDelivery: Promise<string> | undefined
    let failBinding = false
    const children = new Map<string, any>()
    const socket = { id: 'cli-test', timeout: () => ({ emitWithAck: async (_event: string, packet: { method: string; params: string }) => {
        packets.push(packet)
        if (holdNextDelivery) { holdNextDelivery = false; heldPackets.push(packet); throw new Error('Synthetic Hub interruption before CLI delivery') }
        if (loseNextAckEarly) { loseNextAckEarly = false; pendingDelivery = manager.handleRequest(packet); throw new Error('Synthetic lost acknowledgement while CLI still works') }
        const response = await manager.handleRequest(packet)
        if (loseNextAck) { loseNextAck = false; throw new Error('Synthetic lost Hub acknowledgement after CLI completed') }
        return response
    } }) }
    const engine = new SyncEngine(store, { of: () => ({ sockets: new Map([[socket.id, socket]]) }) } as never, registry, { broadcast() {} } as never)
    const metadata: Metadata = { path: home, host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex', codexStoreId: home,
        codexSessionId: boundary.threadId, codexNativeSession: true, codexNativeConnection: 'attached',
        capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    let reservedChildId: string | undefined
    const create = (name: string, extra: Partial<Metadata> = {}, requestedId?: string) => {
        const session = engine.getOrCreateSession(name, { ...metadata, ...extra }, { controlledByUser: false }, 'default', undefined, undefined, undefined, requestedId)
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        engine.handleSessionReady({ sid: session.id, time: Date.now() })
        return session
    }
    const source = create('source')
    manager = new RpcHandlerManager({ scopePrefix: source.id, logger() {} })
    registry.register(socket as never, `${source.id}:${RPC_METHODS.ForkOperation}`)
    let service: Promise<SharedForkOperations> | undefined
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const creations: Array<{ method: string; params: Record<string, unknown> }> = []
    let beforeRead: (() => void | Promise<void>) | undefined
    const root = Object.assign(Object.create(SharedCodexRoot.prototype), {
        session: { sessionId: source.id, rpcHandlerManager: manager, getMetadata: () => engine.getSession(source.id)?.metadata, on() {} },
        threadId: boundary.threadId, controls: new Set(), execution: { running: false }, work: Promise.resolve(),
        turnRevision: 0, settingsRevision: 0, runtimeRevision: 0, settings: {},
        settingsNative: { sandbox: { type: 'readOnly' }, cwd: home }, bootstrap: { workingDirectory: home },
        projection: { turnFor: () => { throw new Error('Native fork must not use the empty root projection') } },
        client: { isInitialized: () => true, request: async (method: string, params: Record<string, unknown>) => {
            calls.push({ method, params })
            if (method === 'thread/read' && params.includeTurns === false) { await beforeRead?.(); return { thread: segment.thread } }
            if (method === 'thread/queue/list' && params.limit === 1) return { data: [], nextCursor: null }
            throw new Error(`Unbounded or unexpected native request: ${method}`)
        } },
        host: { external: true, codexHome: home, create: async (method: string, params: Record<string, unknown>) => {
            creations.push({ method, params })
            const child = create(`child-${creations.length}`, { codexSessionId: `native-child-${creations.length}`, forkedFrom: source.id }, reservedChildId)
            const result = { threadId: child.metadata!.codexSessionId, session: { sessionId: child.id }, initialSettings: async () => { if (failBinding) throw new Error('Synthetic child settings acknowledgement failed') } }
            children.set(child.id, result)
            return result
        } }
    })
    root.host.forkOperation = async (_parent: unknown, request: ForkOperationRpcRequest, preflight: () => Promise<any>) => {
        let child: any
        service ??= ForkJournal.open(home, { namespace: 'default', hub: 'fixture', authHash: 'fixture', owner: 'runtime-1' }).then(journal => new SharedForkOperations(journal))
        return (await service).handle(request, root.threadId, {
            preflight,
            prepare: async (_plan, childSessionId) => { reservedChildId = childSessionId },
            send: async (plan, hooks) => {
                await hooks.beforeSend({ requestId: 1, transportGeneration: 1 })
                child = await root.host.create('thread/fork', plan.params)
                return { thread: { id: child.threadId } }
            },
            nativeId: (result: any) => result.thread?.id,
            bind: async () => { await (child ?? children.get(request.childSessionId)).initialSettings({ collaborationMode: root.settings.collaborationMode }) },
        })
    }
    root.registerControls()
    const allMessages = spyOn(store.messages, 'getAllMessages').mockImplementation(() => { throw new Error('Native fork must not read Hub transcript') })
    cleanups.push(() => { allMessages.mockRestore(); engine.stop(); native.database.close(); rmSync(home, { recursive: true, force: true }) })
    return { engine, store, source, boundary, segment, native, root, calls, creations, packets, allMessages,
        beforeRead: (handler: () => void | Promise<void>) => { beforeRead = handler },
        holdDelivery: () => { holdNextDelivery = true },
        deliverHeld: async () => { const packet = heldPackets.shift(); if (!packet) throw new Error('No held packet'); return JSON.parse(await manager.handleRequest(packet)) },
        loseAckEarly: () => { loseNextAckEarly = true },
        finishDelivery: async () => pendingDelivery && JSON.parse(await pendingDelivery),
        loseAck: () => { loseNextAck = true },
        failBinding: (value: boolean) => { failBinding = value },
        restartCLI: () => { service = ForkJournal.open(home, { namespace: 'default', hub: 'fixture', authHash: 'fixture', owner: 'runtime-2' }).then(journal => new SharedForkOperations(journal)) },
        fork: (value = boundary, namespace = 'default') => engine.forkConversation(source.id, namespace, undefined, value) }
}

describe('native historical fork through real Hub RPC and bound CLI control', () => {
    it('forks native-only first user with no Hub transcript or root projection', async () => {
        const f = fixture()
        expect(await f.fork()).toMatchObject({ type: 'success' })
        expect(f.packets).toHaveLength(1)
        expect(JSON.parse(f.packets[0].params)).toMatchObject({ action: 'start', nativeBoundary: f.boundary, sourceSessionId: f.source.id })
        expect(f.creations).toHaveLength(1)
        expect(f.creations[0]).toMatchObject({ method: 'thread/fork', params: { threadId: f.boundary.threadId, beforeTurnId: f.boundary.turnId } })
        expect(f.creations[0].params).not.toHaveProperty('lastTurnId')
        expect(f.allMessages).not.toHaveBeenCalled()
        expect(f.calls.map(call => call.method)).toEqual(['thread/read', 'thread/queue/list'])
    })
    it('rejects forged namespace and descendant thread before RPC', async () => {
        const f = fixture()
        expect(await f.fork(f.boundary, 'foreign')).toMatchObject({ type: 'error', message: 'Access denied' })
        expect(await f.fork({ ...f.boundary, threadId: 'other-root' })).toMatchObject({ type: 'error', message: 'Native fork boundary does not belong to this session' })
        expect(f.packets).toHaveLength(0)
        expect(f.creations).toHaveLength(0)
    })
    it('preserves the CLI steered-item rejection through the real serialized error envelope', async () => {
        const f = fixture()
        expect(await f.fork({ ...f.boundary, itemId: 'steered-item' })).toEqual({ type: 'error', message: 'Cannot cut inside a steered native turn. Select its first message.' })
        expect(f.creations).toHaveLength(0)
        expect(f.allMessages).not.toHaveBeenCalled()
    })
    it('never treats a native localId-only request as a current fork', async () => {
        const f = fixture()
        expect(await f.engine.forkConversation(f.source.id, 'default', 'old-local-id')).toMatchObject({ type: 'error', message: 'Native historical fork requires a native message boundary; reload the message' })
        expect(f.packets).toHaveLength(0)
    })
    it('retains current fork independently of metadata resolution', async () => {
        const f = fixture()
        expect(await f.engine.forkConversation(f.source.id, 'default')).toMatchObject({ type: 'success' })
        expect(f.calls).toHaveLength(0)
        expect(f.creations[0].params).not.toHaveProperty('beforeTurnId')
    })
    it('rejects history-only sources without native mutation', async () => {
        const f = fixture()
        f.store.sessions.updateSessionMetadata(f.source.id, { ...f.source.metadata!, codexNativeConnection: 'history' }, f.source.metadataVersion, 'default')
        ;(f.engine as any).sessionCache.refreshSession(f.source.id)
        expect(await f.fork()).toMatchObject({ type: 'error', message: 'This native Codex thread is open for history only' })
        expect(f.packets).toHaveLength(0)
    })
    it('retains the Hub queued-message guard even with a native selector', async () => {
        const f = fixture()
        f.store.messages.addMessage(f.source.id, { role: 'user', content: { type: 'text', text: 'queued' } }, 'queued-local')
        expect(await f.fork()).toMatchObject({ type: 'error', message: 'Session has queued messages' })
        expect(f.packets).toHaveLength(0)
        expect(f.creations).toHaveLength(0)
    })
    it('fails explicitly when metadata is missing without falling back to a current fork', async () => {
        const f = fixture()
        f.native.database.exec('DELETE FROM thread_items')
        const result = await f.fork()
        expect(result.type).toBe('error')
        if (result.type === 'error') expect(result.message).toContain('Native fork boundary unavailable')
        expect(f.creations).toHaveLength(0)
    })
    it('rejects a settings change while resolving the selected boundary', async () => {
        const f = fixture()
        f.beforeRead(() => { f.root.settingsRevision++ })
        expect(await f.fork()).toMatchObject({ type: 'error', message: 'Native state changed during fork validation; retry the selected boundary' })
        expect(f.creations).toHaveLength(0)
    })
    it('rechecks busy state after the metadata-only header RPC', async () => {
        const f = fixture()
        f.beforeRead(() => { f.root.currentTurn = 'new-live-turn'; f.root.turnRevision++ })
        expect(await f.fork()).toMatchObject({ type: 'error', message: 'Session is busy' })
        expect(f.creations).toHaveLength(0)
    })
    it('does not accept a child against a changed source binding', async () => {
        const f = fixture()
        const create = f.root.host.create
        f.root.host.create = async (...args: unknown[]) => {
            const child = await create(...args)
            f.store.sessions.updateSessionMetadata(f.source.id,
                { ...f.source.metadata!, codexSessionId: 'replaced-native-source' }, f.source.metadataVersion, 'default')
            return child
        }
        expect(await f.fork()).toMatchObject({ type: 'error', message: 'The native child was created, but its HAPI binding could not be verified. Recover this child binding; do not create another fork.' })
        expect(f.creations).toHaveLength(1)
    })
    it('blocks duplicate create calls while the first fork is in progress', async () => {
        const f = fixture()
        const create = f.root.host.create
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        f.root.host.create = async (...args: unknown[]) => { await gate; return create(...args) }
        const pending = f.fork()
        expect(await f.fork()).toMatchObject({ type: 'error', message: 'A fork of this native source is still unresolved. Check the existing operation before creating another.' })
        release()
        expect(await pending).toMatchObject({ type: 'success' })
        expect(f.creations).toHaveLength(1)
    })
    it('keeps the native permission inheritance guard and returns its exact cause', async () => {
        const f = fixture()
        f.root.settingsNative.sandbox = { type: 'externalSandbox', networkAccess: 'enabled' }
        const result = await f.fork()
        expect(result.type).toBe('error')
        if (result.type === 'error') expect(result.message).toContain('sandbox')
        expect(f.creations).toHaveLength(0)
    })
})


describe('durable fork through actual Hub RPC serialization, root, lifecycle and journal', () => {
    it('returns the new risk request own rejection when its original child already exists, then restores the authoritative head', async () => {
        const f = fixture()
        const original = { operationId: randomUUID(), expectedForkRevision: 0, nativeBoundary: f.boundary }
        f.loseAck()
        expect(await f.engine.startForkOperation(f.source.id, 'default', original)).toMatchObject({ operation: { status: 'indeterminate' } })
        const risk = { operationId: randomUUID(), expectedForkRevision: 1, duplicateRiskOf: original.operationId }
        expect(await f.engine.startForkOperation(f.source.id, 'default', risk)).toMatchObject({ operation: {
            operationId: risk.operationId, duplicateRiskOf: original.operationId, status: 'rejected',
            rejectionProof: 'not_dispatched', code: 'risk_target_resolved'
        } })
        expect(f.engine.getForkSourceState(f.source.id, 'default')).toMatchObject({ revision: 3, operation: {
            operationId: original.operationId, sourceRevision: 1, status: 'created', binding: 'ready', nativeThreadId: 'native-child-1'
        } })
        expect(f.creations).toHaveLength(1)
        expect(f.packets.map(p => JSON.parse(p.params).action)).toEqual(['start', 'start', 'read'])
        expect(await f.engine.startForkOperation(f.source.id, 'default', { operationId: randomUUID(), expectedForkRevision: 3 }))
            .toMatchObject({ operation: { status: 'created', binding: 'ready', sourceRevision: 4 } })
        expect(f.creations).toHaveLength(2)
    })
    it('accepts a risk intent after a Hub-only rejected revision gap and preserves the original native history cut', async () => {
        const f = fixture()
        const create = f.root.host.create
        f.root.host.create = async (...args: unknown[]) => { await create(...args); throw new Error('Synthetic native error after creating original child') }
        const original = { operationId: randomUUID(), expectedForkRevision: 0, nativeBoundary: f.boundary }
        expect(await f.engine.startForkOperation(f.source.id, 'default', original)).toMatchObject({ operation: { status: 'indeterminate' } })
        f.store.messages.addMessage(f.source.id, { role: 'user', content: { type: 'text', text: 'queued fixture' } }, 'risk-queued-local')
        const refused = { operationId: randomUUID(), expectedForkRevision: 1, duplicateRiskOf: original.operationId }
        expect(await f.engine.startForkOperation(f.source.id, 'default', refused)).toMatchObject({ operation: {
            operationId: refused.operationId, status: 'rejected', rejectionProof: 'not_dispatched', code: 'preflight_rejected'
        } })
        expect(f.packets).toHaveLength(1)
        expect(f.engine.getForkSourceState(f.source.id, 'default')).toMatchObject({ revision: 3, operation: {
            operationId: original.operationId, sourceRevision: 1, status: 'indeterminate'
        } })
        f.store.messages.markMessagesInvoked(f.source.id, ['risk-queued-local'], Date.now())
        f.root.host.create = create
        const next = { operationId: randomUUID(), expectedForkRevision: 3, duplicateRiskOf: original.operationId }
        expect(await f.engine.startForkOperation(f.source.id, 'default', next)).toMatchObject({ operation: {
            operationId: next.operationId, sourceRevision: 4, duplicateRiskOf: original.operationId, status: 'created', binding: 'ready'
        } })
        expect(f.creations).toHaveLength(2)
        expect(f.creations[1].params).toMatchObject({ threadId: f.boundary.threadId, beforeTurnId: f.boundary.turnId })
        expect(JSON.parse(f.packets[1].params)).toMatchObject({ sourceRevision: 4, nativeBoundary: f.boundary, duplicateRiskOf: original.operationId })
        expect(await f.engine.getForkOperation(f.source.id, 'default', original.operationId)).toMatchObject({ operation: {
            operationId: original.operationId, status: 'indeterminate'
        } })
        expect(f.engine.getForkSourceState(f.source.id, 'default')).toMatchObject({ revision: 4, operation: { operationId: next.operationId } })
        expect(f.allMessages).not.toHaveBeenCalled()
    })
    it('reconciles a lost Hub acknowledgement with exact CLI receipt, without another creation', async () => {
        const f = fixture()
        const intent = { operationId: randomUUID(), expectedForkRevision: 0, nativeBoundary: f.boundary }
        f.loseAck()
        const first = await f.engine.startForkOperation(f.source.id, 'default', intent)
        expect(first).toMatchObject({ operation: { status: 'indeterminate' } })
        expect(f.creations).toHaveLength(1)
        expect(await f.engine.startForkOperation(f.source.id, 'default', intent)).toMatchObject({ operation: { status: 'indeterminate' } })
        const recovered = await f.engine.getForkOperation(f.source.id, 'default', intent.operationId)
        expect(recovered).toMatchObject({ operation: { status: 'created', binding: 'ready', nativeThreadId: 'native-child-1' } })
        expect(recovered.sessionId).toBe(recovered.operation.childSessionId)
        expect(f.creations).toHaveLength(1)
        expect(f.packets.map(p => JSON.parse(p.params).action)).toEqual(['start', 'read'])
    })
    it('does not infer child identity from a matching created row after an explicit native error', async () => {
        const f = fixture()
        const create = f.root.host.create
        f.root.host.create = async (...args: unknown[]) => { await create(...args); throw new Error('Native goal inheritance failed after creating child') }
        const intent = { operationId: randomUUID(), expectedForkRevision: 0 }
        const first = await f.engine.startForkOperation(f.source.id, 'default', intent)
        expect(first).toMatchObject({ operation: { status: 'indeterminate' } })
        expect(first.type === 'operation' && 'nativeThreadId' in first.operation).toBe(false)
        expect(await f.engine.startForkOperation(f.source.id, 'default', { operationId: randomUUID(), expectedForkRevision: 1 })).toMatchObject({ type: 'conflict', code: 'operation_in_progress' })
        expect(await f.engine.getForkOperation(f.source.id, 'default', intent.operationId, true)).toMatchObject({ operation: { status: 'indeterminate' } })
        expect(f.creations).toHaveLength(1)
        expect(f.packets.map(p => JSON.parse(p.params).action)).toEqual(['start', 'read'])
    })
    it('retains an exact created child across CLI journal restart and binding-only recovery', async () => {
        const f = fixture()
        const intent = { operationId: randomUUID(), expectedForkRevision: 0 }
        f.failBinding(true)
        const first = await f.engine.startForkOperation(f.source.id, 'default', intent)
        expect(first).toMatchObject({ operation: { status: 'created', binding: 'blocked', nativeThreadId: 'native-child-1' } })
        f.restartCLI(); f.failBinding(false)
        const recovered = await f.engine.getForkOperation(f.source.id, 'default', intent.operationId, true)
        expect(recovered).toMatchObject({ operation: { status: 'created', binding: 'ready', nativeThreadId: 'native-child-1' } })
        expect(f.creations).toHaveLength(1)
        expect(f.packets.map(p => JSON.parse(p.params).action)).toEqual(['start', 'reconcile'])
    })
})

describe('explicit unadmitted closure across the actual Hub RPC and CLI journal', () => {
    it('closes a never-delivered request and fences its delayed start without any native creation', async () => {
        const f = fixture()
        const intent = { operationId: randomUUID(), expectedForkRevision: 0, nativeBoundary: f.boundary }
        f.holdDelivery()
        expect(await f.engine.startForkOperation(f.source.id, 'default', intent)).toMatchObject({ operation: { status: 'indeterminate' } })
        expect(await f.engine.getForkOperation(f.source.id, 'default', intent.operationId)).toMatchObject({ operation: { status: 'indeterminate' } })
        expect(f.creations).toHaveLength(0)
        const closed = await f.engine.closeUnadmittedForkOperation(f.source.id, 'default', intent.operationId, { expectedForkRevision: 1 })
        expect(closed).toMatchObject({ type: 'operation', closure: 'closed', operation: {
            operationId: intent.operationId, status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_closed_unadmitted'
        } })
        expect(await f.deliverHeld()).toMatchObject({ operation: { operationId: intent.operationId, status: 'rejected', code: 'fork_closed_unadmitted' } })
        expect(f.creations).toHaveLength(0)
        expect(f.calls).toHaveLength(0)
        const beforeReplay = f.packets.length
        expect(await f.engine.closeUnadmittedForkOperation(f.source.id, 'default', intent.operationId, { expectedForkRevision: 1 }))
            .toMatchObject({ closure: 'closed' })
        expect(f.packets).toHaveLength(beforeReplay)
        const state = f.engine.getForkSourceState(f.source.id, 'default')
        expect(await f.engine.startForkOperation(f.source.id, 'default', { operationId: randomUUID(), expectedForkRevision: state.revision, nativeBoundary: f.boundary }))
            .toMatchObject({ operation: { status: 'created', binding: 'ready' } })
        expect(f.creations).toHaveLength(1)
        expect(f.allMessages).not.toHaveBeenCalled()
    })

    it('closes missing risk B, restores A at a new revision, and only an explicitly submitted C creates another historical child', async () => {
        const f = fixture()
        const create = f.root.host.create
        f.root.host.create = async (...args: unknown[]) => { await create(...args); throw new Error('Synthetic native error after A creation') }
        const original = { operationId: randomUUID(), expectedForkRevision: 0, nativeBoundary: f.boundary }
        expect(await f.engine.startForkOperation(f.source.id, 'default', original)).toMatchObject({ operation: { status: 'indeterminate' } })
        f.root.host.create = create
        const risk = { operationId: randomUUID(), expectedForkRevision: 1, duplicateRiskOf: original.operationId }
        f.holdDelivery()
        expect(await f.engine.startForkOperation(f.source.id, 'default', risk)).toMatchObject({ operation: { operationId: risk.operationId, status: 'indeterminate' } })
        expect(await f.engine.getForkOperation(f.source.id, 'default', risk.operationId)).toMatchObject({ operation: { status: 'indeterminate' } })
        expect(await f.engine.closeUnadmittedForkOperation(f.source.id, 'default', risk.operationId, { expectedForkRevision: 2 }))
            .toMatchObject({ closure: 'closed', operation: { operationId: risk.operationId, status: 'rejected' }, sourceState: {
                revision: 3, operation: { operationId: original.operationId, sourceRevision: 1, status: 'indeterminate' }
            } })
        expect(await f.deliverHeld()).toMatchObject({ operation: { operationId: risk.operationId, status: 'rejected', code: 'fork_closed_unadmitted' } })
        expect(f.creations).toHaveLength(1)
        const next = { operationId: randomUUID(), expectedForkRevision: 3, duplicateRiskOf: original.operationId }
        expect(await f.engine.startForkOperation(f.source.id, 'default', next)).toMatchObject({ operation: { operationId: next.operationId, sourceRevision: 4, status: 'created', binding: 'ready' } })
        expect(f.creations).toHaveLength(2)
        expect(f.creations[1].params).toMatchObject({ threadId: f.boundary.threadId, beforeTurnId: f.boundary.turnId })
        const beforeReplay = f.packets.length
        expect(await f.engine.closeUnadmittedForkOperation(f.source.id, 'default', risk.operationId, { expectedForkRevision: 2 }))
            .toMatchObject({ closure: 'closed', sourceState: { revision: 4, operation: { operationId: next.operationId } } })
        expect(f.packets).toHaveLength(beforeReplay)
        expect(f.allMessages).not.toHaveBeenCalled()
    })

    it('recovers a lost close acknowledgement by the same action after CLI restart, without replaying the native start', async () => {
        const f = fixture()
        const intent = { operationId: randomUUID(), expectedForkRevision: 0, nativeBoundary: f.boundary }
        f.holdDelivery()
        await f.engine.startForkOperation(f.source.id, 'default', intent)
        f.loseAck()
        expect(await f.engine.closeUnadmittedForkOperation(f.source.id, 'default', intent.operationId, { expectedForkRevision: 1 }))
            .toMatchObject({ closure: 'unavailable', operation: { status: 'indeterminate' } })
        f.restartCLI()
        expect(await f.engine.closeUnadmittedForkOperation(f.source.id, 'default', intent.operationId, { expectedForkRevision: 1 }))
            .toMatchObject({ closure: 'closed', operation: { operationId: intent.operationId, status: 'rejected', code: 'fork_closed_unadmitted' } })
        expect(await f.deliverHeld()).toMatchObject({ operation: { operationId: intent.operationId, status: 'rejected' } })
        expect(f.creations).toHaveLength(0)
        expect(f.packets.map(p => JSON.parse(p.params).action)).toEqual(['start', 'close-unadmitted', 'close-unadmitted'])
    })

    it('does not close an admitted request even while its native preflight is paused before dispatch', async () => {
        const f = fixture()
        let entered!: () => void, release!: () => void
        const admitted = new Promise<void>(resolve => { entered = resolve })
        const gate = new Promise<void>(resolve => { release = resolve })
        f.beforeRead(async () => { entered(); await gate })
        const intent = { operationId: randomUUID(), expectedForkRevision: 0, nativeBoundary: f.boundary }
        f.loseAckEarly()
        expect(await f.engine.startForkOperation(f.source.id, 'default', intent)).toMatchObject({ operation: { status: 'indeterminate' } })
        await admitted
        try {
            expect(f.creations).toHaveLength(0)
            expect(await f.engine.closeUnadmittedForkOperation(f.source.id, 'default', intent.operationId, { expectedForkRevision: 1 }))
                .toMatchObject({ closure: 'already_admitted', operation: { operationId: intent.operationId, status: 'indeterminate' } })
            expect(f.engine.getForkSourceState(f.source.id, 'default')).toMatchObject({ revision: 1, operation: { operationId: intent.operationId, status: 'indeterminate' } })
        } finally { release() }
        expect(await f.finishDelivery()).toMatchObject({ operation: { status: 'created', binding: 'ready' } })
        expect(await f.engine.getForkOperation(f.source.id, 'default', intent.operationId)).toMatchObject({ operation: { status: 'created', binding: 'ready' } })
        expect(f.creations).toHaveLength(1)
    })
})
