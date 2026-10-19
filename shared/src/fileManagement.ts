import { z } from 'zod'
import { MAX_DOCUMENT_FILE_BYTES } from './documents'

export const MAX_FILE_TRANSFER_BYTES = MAX_DOCUMENT_FILE_BYTES
export const MAX_FILE_MANAGEMENT_ENTRIES = 20_000

const pathSchema = z.string().min(1).max(8192).refine(path => !path.includes('\0'), 'Invalid path')
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const FileManagementInspectRequestSchema = z.object({ path: pathSchema }).strict()

// A source revision comes from inspectSessionPath. Directory revisions include descendants.
// Destinations are always exclusive: there is deliberately no overwrite option.
export const FileManagementRequestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('create-file'), path: pathSchema }).strict(),
    z.object({ action: z.literal('create-directory'), path: pathSchema }).strict(),
    z.object({ action: z.literal('rename'), path: pathSchema, destination: pathSchema, expectedRevision: revisionSchema }).strict(),
    z.object({ action: z.literal('move'), path: pathSchema, destination: pathSchema, expectedRevision: revisionSchema }).strict(),
    z.object({ action: z.literal('copy'), path: pathSchema, destination: pathSchema, expectedRevision: revisionSchema }).strict(),
    z.object({ action: z.literal('delete'), path: pathSchema, expectedRevision: revisionSchema, recursive: z.boolean() }).strict(),
])
export type FileManagementRequest = z.infer<typeof FileManagementRequestSchema>

export const FileManagementUploadRequestSchema = z.object({
    path: pathSchema,
    content: z.string().max(Math.ceil(MAX_FILE_TRANSFER_BYTES / 3) * 4),
}).strict()
export type FileManagementUploadRequest = z.infer<typeof FileManagementUploadRequestSchema>

export type FileManagementEntry = {
    /** Canonical absolute path on the session machine. */
    path: string
    name: string
    type: 'file' | 'directory' | 'symlink'
    /** Total bytes of the entry and its descendants; symlink targets are never read. */
    size: number
    modified: number
    /** Opaque optimistic concurrency token. Do not construct it from listing metadata. */
    revision: string
    /** Includes the entry itself. */
    entryCount: number
}

export type FileManagementErrorCode = 'conflict' | 'denied' | 'not-found' | 'invalid' | 'too-large' | 'unsupported'
export type FileManagementResponse = {
    success: boolean
    entry?: FileManagementEntry
    code?: FileManagementErrorCode
    error?: string
    /** Verified deletions, including partial recursive deletion before a later conflict. */
    deletedPaths?: string[]
    /** Move committed successfully, even if refreshing its new metadata subsequently failed. */
    commit?: { action: 'rename' | 'move'; path: string; destination: string }
}
