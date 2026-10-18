import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
    FileManagementInspectRequestSchema,
    FileManagementRequestSchema,
    FileManagementUploadRequestSchema,
    MAX_FILE_TRANSFER_BYTES,
    type FileManagementResponse,
} from '@hapi/protocol/fileManagement'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

async function runFileOperation(operation: () => Promise<FileManagementResponse>): Promise<FileManagementResponse> {
    try { return await operation() }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
}

export function createFileManagementRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    function requireFileSession(c: Context<WebAppEnv>) {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const session = requireSessionFromParam(c, engine, { requireActive: true })
        if (session instanceof Response) return session
        if (!session.session.metadata?.path) return c.json({ success: false, error: 'Session path not available' }, 409)
        return { engine, sessionId: session.sessionId }
    }

    app.get('/sessions/:id/filesystem/entry', async c => {
        const session = requireFileSession(c)
        if (session instanceof Response) return session
        const parsed = FileManagementInspectRequestSchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ success: false, code: 'invalid', error: 'Invalid file path' }, 400)
        return c.json(await runFileOperation(() => session.engine.inspectSessionPath(session.sessionId, parsed.data.path)))
    })

    app.post('/sessions/:id/filesystem', bodyLimit({ maxSize: 32 * 1024 }), async c => {
        const session = requireFileSession(c)
        if (session instanceof Response) return session
        const parsed = FileManagementRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ success: false, code: 'invalid', error: 'Invalid file operation' }, 400)
        return c.json(await runFileOperation(() => session.engine.manageSessionFiles(session.sessionId, parsed.data)))
    })

    app.post('/sessions/:id/filesystem/upload', bodyLimit({ maxSize: Math.ceil(MAX_FILE_TRANSFER_BYTES / 3) * 4 + 16_384 }), async c => {
        const session = requireFileSession(c)
        if (session instanceof Response) return session
        const parsed = FileManagementUploadRequestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) return c.json({ success: false, code: 'invalid', error: 'Invalid file upload' }, 400)
        return c.json(await runFileOperation(() => session.engine.uploadSessionFile(session.sessionId, parsed.data)))
    })

    app.get('/sessions/:id/filesystem/download', async c => {
        const session = requireFileSession(c)
        if (session instanceof Response) return session
        const parsed = FileManagementInspectRequestSchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ success: false, code: 'invalid', error: 'Invalid file path' }, 400)
        const inspected = await runFileOperation(() => session.engine.inspectSessionPath(session.sessionId, parsed.data.path))
        if (!inspected.success || !inspected.entry) return c.json(inspected, inspected.code === 'denied' ? 403 : 404)
        if (inspected.entry.type !== 'file') return c.json({ success: false, code: 'unsupported', error: 'Only regular files can be downloaded' }, 400)
        if (inspected.entry.size > MAX_FILE_TRANSFER_BYTES) return c.json({ success: false, code: 'too-large', error: 'Files larger than 64 MiB cannot be downloaded' }, 413)
        try {
            const result = await session.engine.readSessionFile(session.sessionId, parsed.data.path)
            if (!result.success || result.content === undefined) return c.json(result, 404)
            const encodedName = encodeURIComponent(inspected.entry.name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
            return c.body(new Uint8Array(Buffer.from(result.content, 'base64')), 200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'private, no-store',
            })
        } catch (error) {
            return c.json({ success: false, error: error instanceof Error ? error.message : String(error) }, 503)
        }
    })

    return app
}
