import { describe, expect, it, mock } from 'bun:test'
import { SyncEngine } from './syncEngine'

function reader(machineNamespace = 'owner') {
    const session = { namespace: 'owner', metadata: { path: '/home/user/project', machineId: 'machine' } }
    const rpcGateway = {
        readMachineFile: mock(async () => ({ success: true, content: 'document' })),
        statMachineFiles: mock(async () => ({ success: true, entries: [] })),
        readSessionFile: mock(async () => ({ success: true, content: 'session-document' })),
        statFiles: mock(async () => ({ success: true, entries: [] })),
    }
    const getMachineByNamespace = mock((_id: string, ns: string) => ns === machineNamespace ? { active: true } : undefined)
    const engine = Object.assign(Object.create(SyncEngine.prototype), { getSession: () => session, getMachineByNamespace, rpcGateway }) as SyncEngine
    return { engine, rpcGateway, getMachineByNamespace }
}

describe('session file reader routing', () => {
    it('uses the owning machine and session cwd to read and stat files without resuming an agent', async () => {
        const { engine, rpcGateway } = reader()
        await engine.readSessionFile('session', '/mnt/repository/package.json')
        await engine.statFiles('session', ['/mnt/repository/package.json'])
        expect(rpcGateway.readMachineFile).toHaveBeenCalledWith('machine', '/home/user/project', '/mnt/repository/package.json')
        expect(rpcGateway.statMachineFiles).toHaveBeenCalledWith('machine', '/home/user/project', ['/mnt/repository/package.json'])
        expect(rpcGateway.readSessionFile).not.toHaveBeenCalled()
    })
    it('does not route a file request to a machine in another namespace', async () => {
        const { engine, rpcGateway, getMachineByNamespace } = reader('someone-else')
        await engine.readSessionFile('session', '/mnt/repository/package.json')
        await engine.statFiles('session', ['notes.md'])
        expect(getMachineByNamespace).toHaveBeenCalledWith('machine', 'owner')
        expect(rpcGateway.readMachineFile).not.toHaveBeenCalled()
        expect(rpcGateway.statMachineFiles).not.toHaveBeenCalled()
        expect(rpcGateway.readSessionFile).toHaveBeenCalledWith('session', '/mnt/repository/package.json')
    })
})
