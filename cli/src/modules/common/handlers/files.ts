import { logger } from '@/ui/logger'
import { readDocumentFile, writeDocumentFile } from './documentFiles'
import type { FileReadResponse, GeneratedImageResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getGeneratedImage } from '../generatedImages'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ReadFileRequest {
    path: string
}

type ReadFileResponse = FileReadResponse

interface ReadGeneratedImageRequest {
    id: string
}

type ReadGeneratedImageResponse = GeneratedImageResponse

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

interface WriteFileResponse {
    success: boolean
    hash?: string
    error?: string
}

export function registerFileHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.ReadFile, async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            return await readDocumentFile(data.path, workingDirectory)
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedImageRequest, ReadGeneratedImageResponse>(RPC_METHODS.ReadGeneratedImage, async (data) => {
        logger.debug('Read generated image request:', data.id)

        const image = getGeneratedImage(data.id)
        if (!image) {
            return rpcError('Generated image not found')
        }

        try {
            return {
                success: true,
                content: image.content.toString('base64'),
                mimeType: image.mimeType,
                fileName: image.fileName
            }
        } catch (error) {
            logger.debug('Failed to read generated image:', error)
            return rpcError(getErrorMessage(error, 'Failed to read generated image'))
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>(RPC_METHODS.WriteFile, async (data) => {
        logger.debug('Write file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        if (!validation.valid) {
            return rpcError(validation.error ?? 'Invalid file path')
        }

        try {
            return await writeDocumentFile(data, workingDirectory)
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
