import { z } from 'zod'

// References contain routing information only; original bytes and local drafts never enter layout sync.
export const DocumentRefSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string().min(1).max(8192), machineId: z.string().min(1).optional() }).strict(),
    z.object({ kind: z.literal('artifact'), artifactId: z.string().min(1).max(8192), fileName: z.string().max(1024), mimeType: z.string().max(256) }).strict(),
])
export type DocumentRef = z.infer<typeof DocumentRefSchema>
export type DocumentResource = { kind: 'document'; sessionId: string; document: DocumentRef }
function normalizedFilePath(path: string): string {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path)
    const value = windows ? path.replaceAll('\\', '/').toLowerCase() : path
    const prefix = value.startsWith('//') && windows ? '//' : value.startsWith('/') ? '/' : ''
    const segments: string[] = []
    for (const part of value.slice(prefix.length).split('/')) {
        if (!part || part === '.') continue
        if (part === '..' && segments.length && segments.at(-1) !== '..') segments.pop()
        else if (part !== '..' || !prefix) segments.push(part)
    }
    return prefix + segments.join('/')
}
export function documentKey(resource: DocumentResource): string {
    const ref = resource.document
    return JSON.stringify(ref.kind === 'file'
        ? ['file', ref.machineId ?? resource.sessionId, normalizedFilePath(ref.path)]
        : ['artifact', resource.sessionId, ref.artifactId])
}
export function documentName(ref: DocumentRef): string {
    return (ref.kind === 'file' ? ref.path.split(/[\\/]/).at(-1) : ref.fileName) || 'Document'
}

// Complete text editing is intentionally bounded. Larger files retain their download path.
export const MAX_EDITABLE_FILE_BYTES = 4 * 1024 * 1024
export const MAX_DOCUMENT_FILE_BYTES = 64 * 1024 * 1024
export const FileWriteRequestSchema = z.object({
    path: z.string().min(1).max(8192), content: z.string().max(Math.ceil(MAX_EDITABLE_FILE_BYTES / 3) * 4),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict()
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>
export type FileWriteResponse = { success: boolean; hash?: string; modified?: number; error?: string; code?: 'conflict' | 'denied' | 'too-large' }

const HtmlDomPointSchema = z.object({ path: z.array(z.number().int().nonnegative()).max(256), offset: z.number().int().nonnegative() })
export const HtmlSelectionSchema = z.object({ kind: z.literal('html'), quote: z.string().max(12000), start: HtmlDomPointSchema, end: HtmlDomPointSchema })
export const HtmlViewStateSchema = z.object({
    x: z.number().finite(), y: z.number().finite(),
    details: z.array(z.object({ path: z.array(z.number().int().nonnegative()), open: z.boolean() })).max(10000),
    fields: z.array(z.object({ path: z.array(z.number().int().nonnegative()), value: z.string().max(12000), checked: z.boolean().optional() })).max(10000),
})
export type HtmlViewState = z.infer<typeof HtmlViewStateSchema>
// Preview-to-host messages remain local to the browser; they grant no RPC access.
export const HtmlPreviewMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('ready'), id: z.string() }),
    z.object({ type: z.literal('media'), id: z.string(), resource: z.number().int().nonnegative() }),
    z.object({ type: z.literal('link'), id: z.string(), href: z.string().max(8192) }),
    z.object({ type: z.literal('state'), id: z.string(), state: HtmlViewStateSchema }),
    z.object({ type: z.literal('selection'), id: z.string(), selection: HtmlSelectionSchema.optional() }),
])

export type DocumentSelection =
    | { kind: 'text'; from: number; to: number; lineStart: number; lineEnd: number; quote: string; precision?: 'block' }
    | z.infer<typeof HtmlSelectionSchema>
    | { kind: 'page'; page: number; rect?: { x: number; y: number; width: number; height: number }; quote?: string }
    | { kind: 'cells'; sheet: string; range: string; quote: string }
export type SelectionReference = { id: string; resource: DocumentResource; version: string; targetSessionId: string; selection: DocumentSelection }
