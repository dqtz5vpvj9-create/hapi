import { resolve, basename } from 'node:path'
import { stat, realpath } from 'node:fs/promises'
import { artifactMimeFromFilename, MAX_ARTIFACT_BYTES, type ArtifactReadResponse } from '@hapi/protocol/artifacts'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { readBoundedRegularFile, detectDisplayMediaMimeType } from '../generatedImages'
import { validatePath } from '../pathSecurity'
import { isAuthorizedUploadFile } from './uploads'

export type FileArtifactRequest = { path: string; sessionId: string; mimeType?: string }

export async function readFileArtifact(data: FileArtifactRequest, workingDirectory: string): Promise<ArtifactReadResponse> {
    const path = resolve(workingDirectory, data.path)
    try {
        const info = await stat(path)
        if ((!validatePath(path, workingDirectory).valid || !validatePath(await realpath(path), await realpath(workingDirectory)).valid) && !isAuthorizedUploadFile(path, data.sessionId, info)) {
            return { success: false, code: 'denied', error: 'This file is outside the session working directory' }
        }
        const bytes = await readBoundedRegularFile(path, MAX_ARTIFACT_BYTES)
        const mediaType = detectDisplayMediaMimeType(bytes)
        return { success: true, content: bytes.toString('base64'), mimeType: mediaType === 'application/octet-stream' ? data.mimeType ?? artifactMimeFromFilename(path) : mediaType, fileName: basename(path) }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, code: message.includes('too large') ? 'too-large' : 'missing', error: message.includes('too large') ? 'Resource exceeds the 25 MiB preview limit' : 'The original file is no longer available' }
    }
}

export function registerArtifactHandlers(manager: RpcHandlerManager, workingDirectory: string): void {
    manager.registerHandler<FileArtifactRequest, ArtifactReadResponse>(RPC_METHODS.ReadArtifact, data => readFileArtifact(data, workingDirectory))
}
