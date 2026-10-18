import { logger } from '@/ui/logger'
import { lstat, readdir } from 'fs/promises'
import { basename, join } from 'path'
import type { DirectoryEntry, ListDirectoryResponse, StatFilesResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { resolveManagedPath } from '../managedPaths'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ListDirectoryRequest {
    path: string
}

interface GetDirectoryTreeRequest {
    path: string
    maxDepth: number
}

interface StatFilesRequest {
    paths: string[]
}

interface TreeNode {
    name: string
    path: string
    type: 'file' | 'directory'
    size?: number
    modified?: number
    children?: TreeNode[]
}

interface GetDirectoryTreeResponse {
    success: boolean
    tree?: TreeNode
    error?: string
}

export function registerDirectoryHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>(RPC_METHODS.ListDirectory, async (data) => {
        logger.debug('List directory request:', data.path)

        const targetPath = data.path || '.'

        const validation = validatePath(targetPath, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid directory path')
        }

        try {
            const resolvedPath = await resolveManagedPath(targetPath, workingDirectory)
            const entries = await readdir(resolvedPath, { withFileTypes: true })

            const directoryEntries: DirectoryEntry[] = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = join(resolvedPath, entry.name)
                    let type: 'file' | 'directory' | 'other' = 'other'
                    let size: number | undefined
                    let modified: number | undefined

                    if (entry.isDirectory()) {
                        type = 'directory'
                    } else if (entry.isFile()) {
                        type = 'file'
                    } else if (entry.isSymbolicLink()) {
                        type = 'other'
                    }

                    if (!entry.isSymbolicLink()) {
                        try {
                            const stats = await lstat(fullPath)
                            if (stats.isSymbolicLink()) return { name: entry.name, type: 'other' as const, isSymbolicLink: true }
                            size = stats.size
                            modified = stats.mtime.getTime()
                        } catch (error) {
                            logger.debug(`Failed to stat ${fullPath}:`, error)
                        }
                    }

                    return {
                        name: entry.name,
                        type,
                        ...(entry.isSymbolicLink() ? { isSymbolicLink: true } : {}),
                        size,
                        modified
                    }
                })
            )

            directoryEntries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1
                if (a.type !== 'directory' && b.type === 'directory') return 1
                return a.name.localeCompare(b.name)
            })

            return { success: true, entries: directoryEntries }
        } catch (error) {
            logger.debug('Failed to list directory:', error)
            return rpcError(getErrorMessage(error, 'Failed to list directory'))
        }
    })

    rpcHandlerManager.registerHandler<StatFilesRequest, StatFilesResponse>(RPC_METHODS.StatFiles, async (data) => {
        if (!Array.isArray(data.paths) || data.paths.length > 500) {
            return rpcError('Invalid file paths')
        }

        for (const path of data.paths) {
            const validation = validatePath(path, workingDirectory)
            if (!validation.valid) {
                return rpcError(validation.error ?? 'Invalid file path')
            }
        }

        const entries = await Promise.all(data.paths.map(async (path) => {
            try {
                const stats = await lstat(await resolveManagedPath(path, workingDirectory))
                return {
                    path,
                    size: stats.size,
                    modified: stats.mtime.getTime()
                }
            } catch (error) {
                logger.debug(`Failed to stat ${path}:`, error)
                return { path }
            }
        }))

        return { success: true, entries }
    })

    rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>(RPC_METHODS.GetDirectoryTree, async (data) => {
        logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth)

        const targetPath = data.path || '.'

        const validation = validatePath(targetPath, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid directory path')
        }

        async function buildTree(path: string, name: string, currentDepth: number): Promise<TreeNode | null> {
            try {
                const stats = await lstat(await resolveManagedPath(path, workingDirectory))

                const node: TreeNode = {
                    name,
                    path,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.getTime()
                }

                if (stats.isDirectory() && currentDepth < data.maxDepth) {
                    const entries = await readdir(path, { withFileTypes: true })
                    const children: TreeNode[] = []

                    await Promise.all(
                        entries.map(async (entry) => {
                            if (entry.isSymbolicLink()) {
                                logger.debug(`Skipping symlink: ${join(path, entry.name)}`)
                                return
                            }

                            const childPath = join(path, entry.name)
                            const childNode = await buildTree(childPath, entry.name, currentDepth + 1)
                            if (childNode) {
                                children.push(childNode)
                            }
                        })
                    )

                    children.sort((a, b) => {
                        if (a.type === 'directory' && b.type !== 'directory') return -1
                        if (a.type !== 'directory' && b.type === 'directory') return 1
                        return a.name.localeCompare(b.name)
                    })

                    node.children = children
                }

                return node
            } catch (error) {
                logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error))
                return null
            }
        }

        try {
            if (data.maxDepth < 0) {
                return rpcError('maxDepth must be non-negative')
            }

            const resolvedRoot = await resolveManagedPath(targetPath, workingDirectory)
            const baseName = resolvedRoot === '/' ? '/' : basename(resolvedRoot) || resolvedRoot
            const tree = await buildTree(resolvedRoot, baseName, 0)

            if (!tree) {
                return rpcError('Failed to access the specified path')
            }

            return { success: true, tree }
        } catch (error) {
            logger.debug('Failed to get directory tree:', error)
            return rpcError(getErrorMessage(error, 'Failed to get directory tree'))
        }
    })
}
