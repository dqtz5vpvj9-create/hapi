import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Machine } from './types'
const lineage = vi.hoisted(() => vi.fn())
const readHistory = vi.hoisted(() => vi.fn())
vi.mock('../codex/utils/codexLineageLookup', () => ({ lookupCodexSessionLineage: lineage }))
vi.mock('../codex/utils/codexSubagentHistory', () => ({ readCodexSubagentMessages: readHistory }))
import { ApiMachineClient } from './apiMachine'
import type { RpcHandlerManager } from './rpc/RpcHandlerManager'

describe('machine subagent history authorization', () => {
    let directory: string
    let workspace: string
    let outside: string
    const rootThreadId = randomUUID()
    const threadId = randomUUID()
    beforeEach(() => {
        directory = mkdtempSync('/mnt/cache/data-cache/hapi-runtime/subagent-scope-')
        workspace = join(directory, 'workspace'); outside = join(directory, 'outside')
        mkdirSync(workspace); mkdirSync(outside)
        lineage.mockReset(); readHistory.mockReset()
        readHistory.mockReturnValue({ threadId, messages: [], before: null, hasMore: false })
    })
    afterEach(() => rmSync(directory, { recursive: true, force: true }))
    async function request(payload: unknown) {
        const machine = { id: 'scope-machine', namespace: 'default', seq: 0, createdAt: 0, updatedAt: 0,
            active: true, activeAt: 0, metadata: null, metadataVersion: 0, runnerState: null, runnerStateVersion: 0 } as Machine
        const client = new ApiMachineClient('test-token', machine, [workspace])
        const manager = (client as unknown as { rpcHandlerManager: RpcHandlerManager }).rpcHandlerManager
        return JSON.parse(await manager.handleRequest({ method: 'scope-machine:readCodexSubagentMessages', params: JSON.stringify(payload) }))
    }
    function allowed(rootCwd = workspace, childCwd = workspace) {
        lineage.mockReturnValue([{ id: rootThreadId, cwd: rootCwd, codexSubagents: [{ threadId, parentThreadId: rootThreadId, path: childCwd, status: 'unknown' }] }])
    }
    it('reads only a real descendant with both workspaces allowed and forwards paging', async () => {
        allowed()
        expect(await request({ rootThreadId, threadId, limit: 12, before: 180 })).toMatchObject({ threadId })
        expect(lineage).toHaveBeenCalledWith([rootThreadId])
        expect(readHistory).toHaveBeenCalledExactlyOnceWith(threadId, 12, 180)
    })
    it('rejects a different target and a missing root before reading any transcript', async () => {
        allowed()
        expect(await request({ rootThreadId, threadId: randomUUID() })).toHaveProperty('error')
        lineage.mockReturnValue([])
        expect(await request({ rootThreadId, threadId })).toHaveProperty('error')
        expect(readHistory).not.toHaveBeenCalled()
    })
    it.each(['root', 'child'])('rejects an out-of-policy %s workspace', async which => {
        allowed(which === 'root' ? outside : workspace, which === 'child' ? outside : workspace)
        expect(await request({ rootThreadId, threadId })).toHaveProperty('error')
        expect(readHistory).not.toHaveBeenCalled()
    })
    it('rejects invalid thread ids and unbounded page sizes', async () => {
        expect(await request({ rootThreadId, threadId: '../private' })).toHaveProperty('error')
        expect(await request({ rootThreadId, threadId, limit: 1000 })).toHaveProperty('error')
        expect(lineage).not.toHaveBeenCalled()
        expect(readHistory).not.toHaveBeenCalled()
    })
})
