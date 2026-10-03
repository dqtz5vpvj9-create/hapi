import { z } from 'zod'

export const ArtifactRefSchema = z.object({
    id: z.string().min(1),
    fileName: z.string(),
    mimeType: z.string(),
    size: z.number().nonnegative().optional(),
    label: z.string().optional(),
    externalUrl: z.string().url().regex(/^https?:\/\//i).optional(),
})

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>

export const ChatContentPartSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('artifact'), artifact: ArtifactRefSchema }),
    z.object({ type: z.literal('resource-link'), name: z.string(), uri: z.string() }),
    z.object({ type: z.literal('unsupported'), label: z.string() }),
])
export type ChatContentPart = z.infer<typeof ChatContentPartSchema>

export const CODEX_ARTIFACT_PREFIX = 'codex-artifact:'
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

export type ArtifactReadResponse = {
    success: boolean
    content?: string
    mimeType?: string
    fileName?: string
    error?: string
    code?: 'missing' | 'denied' | 'too-large' | 'unsupported'
}

export function userContentWithParts(text: string, parts?: ChatContentPart[]) {
    return { type: 'text' as const, text, ...(parts ? { parts, attachments: parts.flatMap(part => part.type === 'artifact' ? [{
        id: part.artifact.id, filename: part.artifact.fileName, mimeType: part.artifact.mimeType,
        size: part.artifact.size ?? 0, path: '', artifact: part.artifact
    }] : []) } : {}) }
}

export function artifactMimeFromFilename(path: string): string {
    const extension = path.split('.').at(-1)?.toLowerCase()
    return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
        pdf: 'application/pdf', html: 'text/html', htm: 'text/html', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}
