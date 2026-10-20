import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MachinePathPolicy } from './machinePathPolicy'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerMachineFileHandlers } from './machineFileHandlers'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

describe('machine document reading', () => {
    let root: string
    let cwd: string
    let manager: RpcHandlerManager
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'hapi-machine-file-'))
        cwd = join(root, 'session')
        await mkdir(cwd)
        await writeFile(join(root, 'package.json'), '{"name":"outside-cwd"}')
        await writeFile(join(cwd, 'notes.md'), '# inside cwd')
        manager = new RpcHandlerManager({ scopePrefix: 'machine' })
        registerMachineFileHandlers(manager, new MachinePathPolicy({ workspaceRoots: [root] }))
    })
    afterEach(async () => { await rm(root, { recursive: true, force: true }) })
    const call = async (manager: RpcHandlerManager, method: string, data: object) => JSON.parse(await manager.handleRequest({ method: `machine:${method}`, params: JSON.stringify(data) }))

    it('reads absolute and parent-relative documents outside cwd but inside configured roots', async () => {
        for (const path of [join(root, 'package.json'), '../package.json']) {
            const result = await call(manager, RPC_METHODS.ReadFile, { cwd, path })
            expect(result.success).toBe(true)
            expect(Buffer.from(result.content, 'base64').toString()).toBe('{"name":"outside-cwd"}')
            expect(result.writable).toBe(false)
        }
        const info = await call(manager, RPC_METHODS.StatFiles, { cwd, paths: ['../package.json'] })
        expect(info).toMatchObject({ success: true, entries: [{ path: '../package.json', size: 22 }] })
    })
    it('retains editability for documents authorized by the session write handler', async () => {
        expect(await call(manager, RPC_METHODS.ReadFile, { cwd, path: 'notes.md' })).toMatchObject({ success: true, writable: true })
    })
    it('checks the real target of symlinks against configured roots', async () => {
        await symlink(root, join(cwd, 'project'), process.platform === 'win32' ? 'junction' : 'dir')
        expect(await call(manager, RPC_METHODS.ReadFile, { cwd, path: 'project/package.json' })).toMatchObject({ success: true })
        registerMachineFileHandlers(manager, new MachinePathPolicy({ workspaceRoots: [cwd] }))
        for (const path of [join(root, 'package.json'), '../package.json', 'project/package.json']) {
            expect(await call(manager, RPC_METHODS.ReadFile, { cwd, path })).toMatchObject({ success: false, error: 'Path is outside workspace roots' })
            expect(await call(manager, RPC_METHODS.StatFiles, { cwd, paths: [path] })).toMatchObject({ success: false })
        }
    })
})
