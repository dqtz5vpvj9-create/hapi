import { Hono } from 'hono'
import { CodexSubagentMessagesQuerySchema } from '@hapi/protocol/apiTypes'
import { MessageOutlineQuerySchema, MessageContextQuerySchema, MessageDependenciesQuerySchema, MessagesQuerySchema, QueuedStateRequestSchema, SendMessageRequestSchema } from '@hapi/protocol'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { requireSessionFromParam, requireSyncEngine } from './guards'

export function createMessagesRoutes(getSyncEngine: () => SyncEngine | null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/sessions/:id/codex-subagents/:threadId/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const parent = requireSessionFromParam(c, engine)
        if (parent instanceof Response) return parent
        const metadata = parent.session.metadata
        const machine = metadata?.machineId ? engine.getMachine(metadata.machineId) : undefined
        if (metadata?.flavor !== 'codex' || !metadata.codexSessionId || !machine || machine.namespace !== c.get('namespace')) {
            return c.json({ error: 'Subagent session is unavailable' }, 404)
        }
        if (!machine.active) return c.json({ error: 'Machine is offline' }, 503)
        const query = CodexSubagentMessagesQuerySchema.safeParse(c.req.query())
        if (!query.success || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.req.param('threadId'))) {
            return c.json({ error: 'Invalid query' }, 400)
        }
        try { return c.json(await engine.readCodexSubagentMessages(machine.id, { ...query.data,
            rootThreadId: metadata.codexSessionId, threadId: c.req.param('threadId') })) }
        catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Subagent history unavailable' }, 409) }
    })

    app.get('/sessions/:id/messages/outline', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult
        const parsed = MessageOutlineQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        if (sessionResult.session.metadata?.codexNativeSession) {
            try { return c.json(await engine.readCodexHistory(sessionResult.sessionId, { ...parsed.data, operation: 'outline' })) }
            catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Native Codex history unavailable' }, 503) }
        }
        return c.json(engine.getMessageOutline(sessionResult.sessionId, parsed.data))
    })

    app.get('/sessions/:id/messages/dependencies', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult
        const parsed = MessageDependenciesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        if (sessionResult.session.metadata?.codexNativeSession) {
            try { return c.json(await engine.readCodexHistory(sessionResult.sessionId, { ...parsed.data, seeds: parsed.data.seeds.join(','), operation: 'dependencies' })) }
            catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Native Codex history unavailable' }, 503) }
        }
        const context = engine.getMessageDependencies(sessionResult.sessionId, parsed.data.seeds, parsed.data.epoch)
        return context ? c.json(context) : c.json({ error: 'Message not found' }, 404)
    })

    app.get('/sessions/:id/messages/:messageId/context', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) return engine
        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) return sessionResult
        const parsed = MessageContextQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }
        if (sessionResult.session.metadata?.codexNativeSession) {
            try { return c.json(await engine.readCodexHistory(sessionResult.sessionId, { ...parsed.data, operation: 'context', messageId: c.req.param('messageId') })) }
            catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Native Codex history unavailable' }, 503) }
        }
        const context = engine.getMessageContext(sessionResult.sessionId, c.req.param('messageId'), parsed.data)
        return context ? c.json(context) : c.json({ error: 'Message not found' }, 404)
    })

    app.get('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const parsed = MessagesQuerySchema.safeParse(c.req.query())
        if (!parsed.success) {
            return c.json({ error: 'Invalid query', issues: parsed.error.flatten() }, 400)
        }

        const limit = parsed.data.limit ?? 50
        const before = parsed.data.beforeAt !== undefined && parsed.data.beforeSeq !== undefined
            ? { at: parsed.data.beforeAt, seq: parsed.data.beforeSeq }
            : null
        const after = parsed.data.afterAt !== undefined && parsed.data.afterSeq !== undefined
            ? { at: parsed.data.afterAt, seq: parsed.data.afterSeq }
            : null
        const until = parsed.data.untilAt !== undefined && parsed.data.untilSeq !== undefined
            ? { at: parsed.data.untilAt, seq: parsed.data.untilSeq }
            : null
        if (sessionResult.session.metadata?.codexNativeSession) {
            try { return c.json(await engine.readCodexHistory(sessionId, parsed.data)) }
            catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Native Codex history unavailable' }, 503) }
        }
        return c.json(engine.getMessagesPage(sessionId, {
            limit,
            before,
            after,
            until,
            epoch: parsed.data.epoch ?? null,
            bounded: parsed.data.bounded
        }))
    })

    app.delete('/sessions/:id/messages/:messageId', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.cancelQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/steer', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId
        const messageId = c.req.param('messageId')

        const result = await engine.steerQueuedMessage(sessionId, messageId)
        return c.json(result)
    })

    app.post('/sessions/:id/messages/:messageId/retry', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        return c.json(await engine.retryIndeterminateMessage(
            sessionResult.sessionId,
            c.req.param('messageId')
        ))
    })

    app.post('/sessions/:id/messages/queued-state', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine)
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        const body = await c.req.json().catch(() => null)
        const parsed = QueuedStateRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        const localIds = [...new Set(parsed.data.localIds)]
        if (localIds.length === 0) {
            return c.json({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] })
        }
        return c.json(engine.getQueuedState(sessionId, localIds))
    })

    app.post('/sessions/:id/messages', async (c) => {
        const engine = requireSyncEngine(c, getSyncEngine)
        if (engine instanceof Response) {
            return engine
        }

        const sessionResult = requireSessionFromParam(c, engine, { requireActive: true })
        if (sessionResult instanceof Response) {
            return sessionResult
        }
        const sessionId = sessionResult.sessionId

        if (sessionResult.session.metadata?.codexNativeConnection === 'history') return c.json({ error: 'This native Codex thread is open for history only', code: 'native_history_only' }, 409)
        const body = await c.req.json().catch(() => null)
        const parsed = SendMessageRequestSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'Invalid body', issues: parsed.error.flatten() }, 400)
        }

        // Require text or attachments
        if (!parsed.data.text && (!parsed.data.attachments || parsed.data.attachments.length === 0)) {
            return c.json({ error: 'Message requires text or attachments' }, 400)
        }

        await engine.sendMessage(sessionId, {
            text: parsed.data.text,
            localId: parsed.data.localId,
            attachments: parsed.data.attachments,
            sentFrom: 'webapp',
            scheduledAt: parsed.data.scheduledAt,
            deliveryMode: parsed.data.deliveryMode
        })
        return c.json({ ok: true })
    })

    return app
}
