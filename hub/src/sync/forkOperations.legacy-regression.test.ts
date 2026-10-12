import { expect, it } from 'bun:test'
import { resolve } from 'node:path'

// The same behavioral regression can run against the accepted historical-fork
// baseline without importing a new module or editing that baseline.
const root = process.env.HAPI_FORK_BASELINE ?? resolve(import.meta.dir, '../../..')
const { Store } = await import(`${root}/hub/src/store/index.ts`)
const { RpcRegistry } = await import(`${root}/hub/src/socket/rpcRegistry.ts`)
const { SyncEngine } = await import(`${root}/hub/src/sync/syncEngine.ts`)

it('legacy shared entrance cannot create a second child after the first result becomes unknown', async () => {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    let creates = 0
    try {
        const metadata = { path: '/project', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
            codexSessionId: 'native-source', codexStoreId: '/native/store',
            capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true } } }
        const source = engine.getOrCreateSession('source', metadata, { controlledByUser: false }, 'default')
        engine.handleSessionAlive({ sid: source.id, time: Date.now() })
        const effectThenLostReply = async (_id: string, request?: { childSessionId?: string }) => {
            creates++
            engine.getOrCreateSession(`created-${creates}`, { ...metadata, codexSessionId: `native-child-${creates}`, forkedFrom: source.id },
                { controlledByUser: false }, 'default', undefined, undefined, undefined, request?.childSessionId)
            throw new Error('Native child exists, but reply was lost')
        }
        engine.rpcGateway.forkConversation = effectThenLostReply
        engine.rpcGateway.forkOperation = effectThenLostReply
        expect(await engine.forkConversation(source.id, 'default')).toMatchObject({ type: 'error' })
        expect(await engine.forkConversation(source.id, 'default')).toMatchObject({ type: 'error' })
        expect(creates).toBe(1)
        expect(store.sessions.getSessions()).toHaveLength(2)
    } finally { engine.stop(); store.close() }
})
