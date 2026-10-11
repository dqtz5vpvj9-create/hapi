import { afterEach, describe, expect, it, mock } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'

const engines: SyncEngine[] = []
afterEach(() => { for (const engine of engines.splice(0)) engine.stop() })

function fixture(machineNamespace = 'default', online = true) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    engines.push(engine)
    const session = engine.getOrCreateSession('cold-native', {
        path: '/project', host: 'localhost', flavor: 'codex', codexNativeSession: true,
        machineId: 'machine', codexSessionId: 'native-thread'
    }, null, 'default')
    engine.getOrCreateMachine('machine', { host: 'localhost', platform: 'linux', happyCliVersion: '0.30.7' }, null, machineNamespace)
    if (online) engine.handleMachineAlive({ machineId: 'machine', time: Date.now() })
    const page = { messages: [], hasMore: false }
    let connected = false
    const read = mock(async (_sid: string, _query: Record<string, unknown>) => {
        if (!connected) throw new RpcTargetMissingError(`${session.id}:readCodexHistory`, 'handler-not-registered')
        return page
    })
    const connect = mock(async (_machine: string, _thread: string) => {
        connected = true
        return { sessionId: session.id, threadId: 'native-thread', connectionState: 'attached' }
    })
    const spawn = mock(async () => { throw new Error('must not spawn') })
    Object.assign((engine as any).rpcGateway, { readCodexHistory: read, connectCodexSessionForMachine: connect, spawnSession: spawn })
    return { engine, session, read, connect, spawn, page }
}

describe('opening a cold native Codex session', () => {
    it('reattaches the original thread and serves the original history query', async () => {
        const f = fixture()
        const query = { limit: 20, before: 123 }
        expect(await f.engine.readCodexHistory(f.session.id, query)).toEqual(f.page)
        expect(f.connect).toHaveBeenCalledWith('machine', 'native-thread')
        expect(f.read.mock.calls).toEqual([[f.session.id, query], [f.session.id, query]])
        expect(f.spawn).not.toHaveBeenCalled()
        await f.engine.readCodexHistory(f.session.id, query)
        expect(f.connect).toHaveBeenCalledTimes(1)
    })
    it('coalesces concurrent messages, outline and context requests', async () => {
        const f = fixture()
        await Promise.all([{}, { operation: 'outline' }, { operation: 'context', messageId: 'm1' }]
            .map(query => f.engine.readCodexHistory(f.session.id, query)))
        expect(f.connect).toHaveBeenCalledTimes(1)
        expect(f.read).toHaveBeenCalledTimes(6)
    })
    it('reopens through resume without spawning a replacement', async () => {
        const f = fixture()
        expect(await f.engine.resumeSession(f.session.id, 'default')).toEqual({ type: 'success', sessionId: f.session.id })
        expect(f.connect).toHaveBeenCalledTimes(1)
        expect(f.spawn).not.toHaveBeenCalled()
    })
    it.each(['other', 'offline'])('does not reconnect through an unavailable machine: %s', async mode => {
        const f = fixture(mode === 'other' ? 'other' : 'default', mode !== 'offline')
        await expect(f.engine.readCodexHistory(f.session.id, {})).rejects.toThrow('offline')
        expect(f.connect).not.toHaveBeenCalled()
    })
    it('does not treat an ordinary RPC failure as permission to reconnect', async () => {
        const f = fixture()
        f.read.mockRejectedValue(new Error('native history corrupt'))
        await expect(f.engine.readCodexHistory(f.session.id, {})).rejects.toThrow('native history corrupt')
        expect(f.connect).not.toHaveBeenCalled()
    })
    it('rejects a different binding and permits retry after failure', async () => {
        const f = fixture()
        f.connect.mockResolvedValueOnce({ sessionId: 'other', threadId: 'native-thread', connectionState: 'attached' })
        await expect(f.engine.readCodexHistory(f.session.id, {})).rejects.toThrow('original session')
        expect(await f.engine.readCodexHistory(f.session.id, {})).toEqual(f.page)
        expect(f.connect).toHaveBeenCalledTimes(2)
    })
})
