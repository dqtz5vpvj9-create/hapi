import { DocumentRefSchema } from '@hapi/protocol/documents'
import { officePreview, readOfficePreview, registerOfficePreview } from '../../documents/officePreview'
import { bodyLimit } from 'hono/body-limit'
import { FileWriteRequestSchema, MAX_EDITABLE_FILE_BYTES } from '@hapi/protocol/documents'
import { Hono } from 'hono'
import { isWildcardSearch, matchesSearchQuery, toSearchGlob } from '@hapi/protocol'
import { z } from 'zod'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

const fileSearchSchema = z.object({
    query: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional()
})

const directorySchema = z.object({
    path: z.string().optional()
})

const filePathSchema = z.object({
    path: z.string().min(1)
})

const generatedImageSchema = z.object({
    imageId: z.string().min(1)
})

function normalizeFileSearchPath(path: string): string {
    return path.replaceAll('\\', '/')
}

function isWindowsSessionPath(path: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
    if (value === 'true') return true
    if (value === 'false') return false
    return undefined
}

async function runRpc<T>(fn: () => Promise<T>): Promise<T | { success: false; error: string }> {
    try {
        return await fn()
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
}

// Generated-image bytes for a given id never change, so they are cached for a year as immutable.
const GENERATED_IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable'

// Weak comparison of an If-None-Match header against our ETag (handles lists, `*`, and W/ prefixes).
function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
    if (!header) {
        return false
    }
    const normalized = etag.replace(/^W\//, '')
    return header.split(',').some((candidate) => {
        const trimmed = candidate.trim()
        return trimmed === '*' || trimmed.replace(/^W\//, '') === normalized
    })
}

export function createGitRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/git-status', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const result = await runRpc(() => engine.getGitStatus(sessionResult.sessionId, sessionPath))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-numstat', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffNumstat(sessionResult.sessionId, { cwd: sessionPath, staged }))
        return c.json(result)
    })

    app.get('/sessions/:id/git-diff-file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const staged = parseBooleanParam(c.req.query('staged'))
        const result = await runRpc(() => engine.getGitDiffFile(sessionResult.sessionId, {
            cwd: sessionPath,
            filePath: parsed.data.path,
            staged
        }))
        return c.json(result)
    })

    app.get('/sessions/:id/file', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid file path' }, 400)
        }

        const result = await runRpc(() => engine.readSessionFile(sessionResult.sessionId, parsed.data.path))
        return c.json(result)
    })

    app.get('/sessions/:id/file-info', async c => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const session = requireSessionFromParam(c, engine)
        if (session instanceof Response) return session
        const parsed = filePathSchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid file path' }, 400)
        return c.json(await runRpc(() => engine.statFiles(session.sessionId, [parsed.data.path])))
    })

    app.post('/sessions/:id/document-preview', bodyLimit({ maxSize: 16384 }), async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const session = requireSessionFromParam(c, engine)
        if (session instanceof Response) return session
        const parsed = z.object({ document: DocumentRefSchema, version: z.string().optional() }).strict().safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ error: 'Invalid document reference' }, 400)
        const ref = parsed.data.document
        try {
            const result = ref.kind === 'file' ? await engine.readSessionFile(session.sessionId, ref.path)
                : await engine.readArtifact(session.sessionId, ref.artifactId)
            if (!result.success || result.content === undefined) return c.json({ error: result.error ?? 'Original file unavailable' }, 404)
            const revision = 'hash' in result ? result.hash : undefined
            if (parsed.data.version && revision !== parsed.data.version) return c.json({ error: 'The original file changed. Reload it before previewing.' }, 409)
            // Artifact names come from the authorized reader, never the user-supplied label.
            const filename = ref.kind === 'file' ? ref.path : ('fileName' in result ? result.fileName : '')
            const extension = filename?.split('.').at(-1)?.toLowerCase() ?? ''
            const source = ref.kind === 'file' ? { kind: 'file', path: 'path' in result ? result.path : ref.path } : { kind: 'artifact', artifactId: ref.artifactId }
            const key = JSON.stringify([c.get('namespace'), session.sessionId, source, revision ?? crypto.randomUUID()])
            const pdf = await officePreview(key, Buffer.from(result.content, 'base64'), extension)
            if (c.req.query('mode') === 'range') {
                return c.json({ previewId: registerOfficePreview(key, c.get('namespace'), session.sessionId), length: pdf.length,
                    version: revision ?? '', ...('modified' in result ? { modified: result.modified, size: result.size } : {}) })
            }
            return c.body(new Uint8Array(pdf), 200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
                // The Web client may use a configured Hub on a different origin.
                // Fetch hides these source identity headers unless explicitly exposed.
                'Access-Control-Expose-Headers': 'X-Hapi-Document-Revision, X-Hapi-Source-Modified, X-Hapi-Source-Size',
                ...(revision ? { 'X-Hapi-Document-Revision': revision } : {}),
                ...('modified' in result && result.modified !== undefined ? { 'X-Hapi-Source-Modified': String(result.modified), 'X-Hapi-Source-Size': String(result.size) } : {}),
            })
        } catch (error) {
            console.warn('[document-preview]', error instanceof Error ? error.message : String(error))
            return c.json({ error: 'Office preview failed. The Hub needs LibreOffice and the document must be readable. Download the original or retry.' }, 503)
        }
    })

    app.get('/sessions/:id/document-preview/:previewId', c => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const session = requireSessionFromParam(c, engine)
        if (session instanceof Response) return session
        const bytes = readOfficePreview(c.req.param('previewId'), c.get('namespace'), session.sessionId)
        if (!bytes) return c.json({ error: 'This preview expired. Reload the document to prepare it again.' }, 410)
        c.header('Cache-Control', 'private, no-store')
        c.header('Content-Type', 'application/pdf')
        c.header('X-Content-Type-Options', 'nosniff')
        c.header('Accept-Ranges', 'bytes')
        c.header('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges')
        const range = c.req.header('Range')
        if (!range) return c.body(new Uint8Array(bytes))
        const match = /^bytes=(\d+)-(\d*)$/.exec(range)
        const start = match ? Number(match[1]) : NaN
        const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= bytes.length || start > end) {
            c.header('Content-Range', `bytes */${bytes.length}`)
            return c.body(null, 416)
        }
        c.header('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
        return c.body(new Uint8Array(bytes.subarray(start, end + 1)), 206)
    })

    app.put('/sessions/:id/file', bodyLimit({ maxSize: MAX_EDITABLE_FILE_BYTES * 1.4 + 16384 }), async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const session = requireSessionFromParam(c, engine)
        if (session instanceof Response) return session
        const parsed = FileWriteRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ success: false, error: 'Invalid file write' }, 400)
        if (!session.session.metadata?.path) return c.json({ success: false, error: 'Session path not available' }, 409)
        const result = await runRpc(() => engine.writeSessionFile(session.sessionId, parsed.data))
        return c.json(result)
    })

    app.get('/sessions/:id/artifacts/:artifactId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const session = requireSessionFromParam(c, engine)
        if (session instanceof Response) return session
        if (!session.session.active) return c.json({ success: false, code: 'offline', error: 'Agent is offline. Reopen the session to load the original resource.' }, 409)
        const result = await runRpc(() => engine.readArtifact(session.sessionId, c.req.param('artifactId')))
        if (!result.success || result.content === undefined) return c.json(result, 'code' in result && result.code === 'denied' ? 403 : 'code' in result && result.code === 'too-large' ? 413 : 404)
        const mimeType = result.mimeType ?? 'application/octet-stream'
        return c.body(Uint8Array.from(Buffer.from(result.content, 'base64')), 200, {
            'Content-Type': mimeType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(result.fileName ?? 'resource')}"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
        })
    })

    app.get('/sessions/:id/generated-images/:imageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const parsed = generatedImageSchema.safeParse(c.req.param())
        if (!parsed.success) {
            return c.json({ error: 'Invalid generated image id' }, 400)
        }

        // The id is an immutable content fingerprint, so it doubles as the ETag. If the client
        // already holds it, answer 304 *before* the RPC so revalidation skips the CLI round-trip
        // entirely (and still works even if the image was evicted from CLI memory). Issue #927.
        const etag = `"${parsed.data.imageId}"`
        if (ifNoneMatchMatches(c.req.header('if-none-match'), etag)) {
            return c.body(null, 304, {
                'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
                ETag: etag
            })
        }

        const result = await runRpc(() => engine.readGeneratedImage(sessionResult.sessionId, parsed.data.imageId))
        if (!result.success || !result.content) {
            return c.json({ success: false, error: result.error ?? 'Generated image not found' }, 404)
        }

        const bytes = Uint8Array.from(Buffer.from(result.content, 'base64'))
        const mimeType = result.mimeType ?? 'application/octet-stream'
        const disposition = !result.mimeType || mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')
            ? 'inline'
            : 'attachment'
        // Generated images are content-addressed by an immutable random id, so the bytes for a
        // given id never change. Cache aggressively so remounts/scroll/session reopen don't
        // re-run the full HTTP -> socket.io RPC -> base64 round-trip every time (issue #927).
        return c.body(bytes, 200, {
            'Content-Type': mimeType,
            'Content-Disposition': `${disposition}; filename="${encodeURIComponent(result.fileName ?? 'generated-media')}"`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': GENERATED_IMAGE_CACHE_CONTROL,
            ETag: etag
        })
    })

    app.get('/sessions/:id/files', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = fileSearchSchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const query = parsed.data.query?.trim() ?? ''
        // ripgrep's gitignore-style globs use '/' as the path separator even on Windows.
        // Accept the native separator users see in Windows paths before building the glob.
        const normalizedQuery = isWindowsSessionPath(sessionPath)
            ? normalizeFileSearchPath(query)
            : query
        const limit = parsed.data.limit ?? 200
        const args = ['--files']
        if (normalizedQuery && !isWildcardSearch(normalizedQuery)) {
            args.push('--iglob', toSearchGlob(normalizedQuery))
        }

        const result = await runRpc(() => engine.runRipgrep(
            sessionResult.sessionId,
            args,
            sessionPath,
            { query: normalizedQuery, limit }
        ))
        if (!result.success) {
            return c.json({ success: false, error: result.error ?? 'Failed to list files' })
        }

        const stdout = result.stdout ?? ''
        const normalizePath = isWindowsSessionPath(sessionPath)
            ? normalizeFileSearchPath
            : (path: string) => path
        const paths = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map(normalizePath)
            .filter((path) => !normalizedQuery || matchesSearchQuery(path, normalizedQuery))
            .slice(0, limit)

        const metadataResult = await runRpc(() => engine.statFiles(sessionResult.sessionId, paths))
        const metadataByPath = new Map(
            metadataResult.success
                ? (metadataResult.entries ?? []).map((entry) => [entry.path, entry] as const)
                : []
        )

        const files = paths.map((fullPath) => {
            const parts = fullPath.split('/')
            const fileName = parts[parts.length - 1] || fullPath
            const filePath = parts.slice(0, -1).join('/')
            const metadata = metadataByPath.get(fullPath)
            return {
                fileName,
                filePath,
                fullPath,
                fileType: 'file' as const,
                size: metadata?.size,
                modified: metadata?.modified
            }
        })

        return c.json({ success: true, files })
    })

    app.get('/sessions/:id/directory', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }

        const sessionPath = sessionResult.session.metadata?.path
        if (!sessionPath) {
            return c.json({ success: false, error: 'Session path not available' })
        }

        const parsed = directorySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query' }, 400)
        }

        const path = parsed.data.path ?? ''
        const result = await runRpc(() => engine.listDirectory(sessionResult.sessionId, path))
        return c.json(result)
    })

    return app
}
