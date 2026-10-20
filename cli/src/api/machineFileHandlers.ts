import { dirname, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from './rpc/RpcHandlerManager'
import type { MachinePathPolicy } from './machinePathPolicy'
import { readDocumentFile } from '../modules/common/handlers/documentFiles'
import { validatePath } from '../modules/common/pathSecurity'

// The Hub supplies the owning session's cwd. It resolves relative references;
// the runner's configured roots, not cwd, authorize reading a document.
const readRequest = z.object({ path: z.string().min(1), cwd: z.string().min(1) })
const statRequest = z.object({ paths: z.array(z.string().min(1)).max(500), cwd: z.string().min(1) })

export function registerMachineFileHandlers(manager: RpcHandlerManager, policy: MachinePathPolicy): void {
    const target = async (path: string, cwd: string) => {
        const canonical = await policy.resolveForCheck(resolve(cwd, path))
        if (!policy.isWithinBrowseRoots(canonical)) throw new Error('Path is outside workspace roots')
        return canonical
    }
    manager.registerHandler(RPC_METHODS.ReadFile, async (request: unknown) => {
        try {
            const data = readRequest.parse(request)
            const path = await target(data.path, data.cwd)
            const result = await readDocumentFile(path, dirname(path))
            // Saving still uses the session write handler and its authorization.
            const cwd = await policy.resolveForCheck(data.cwd)
            return { ...result, writable: Boolean(result.writable && validatePath(path, cwd).valid) }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' }
        }
    })
    manager.registerHandler(RPC_METHODS.StatFiles, async (request: unknown) => {
        try {
            const data = statRequest.parse(request)
            const paths = await Promise.all(data.paths.map(path => target(path, data.cwd)))
            const entries = await Promise.all(paths.map(async (path, index) => {
                const info = await stat(path).catch(() => null)
                return { path: data.paths[index]!, ...(info ? { size: info.size, modified: info.mtime.getTime() } : {}) }
            }))
            return { success: true, entries }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : 'Failed to stat files' }
        }
    })
}
