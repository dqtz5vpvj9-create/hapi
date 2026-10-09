import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SSEManager } from '../../sse/sseManager'
import { VisibilityTracker } from '../../visibility/visibilityTracker'
import type { WebAppEnv } from '../middleware/auth'
import { createEventsRoutes } from './events'
import type { SyncEngine } from '../../sync/syncEngine'

type Frame = { id: string | null; data: Record<string, unknown> }

/**
 * Reads SSE frames from a live stream until `count` frames arrived, then
 * disconnects. In-memory `app.request` streams need a specific teardown to
 * reach hono's `stream.onAbort` (the route's release path): an
 * AbortController signal does not propagate to `c.req.raw.signal`, and a
 * bare `reader.cancel()` with no read in flight does not propagate either -
 * cancellation only reaches the stream source while a read is parked. So:
 * park a read, then cancel.
 */
async function collectFrames(response: Response, count: number): Promise<Frame[]> {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const frames: Frame[] = []
    let buffer = ''
    try {
        while (frames.length < count) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            buffer += decoder.decode(value, { stream: true })
            let boundary = buffer.indexOf('\n\n')
            while (boundary >= 0) {
                const raw = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                boundary = buffer.indexOf('\n\n')
                let id: string | null = null
                let data = ''
                for (const line of raw.split('\n')) {
                    if (line.startsWith('id:')) {
                        id = line.slice(3).trim()
                    } else if (line.startsWith('data:')) {
                        data += line.slice(5).trim()
                    }
                }
                if (data) {
                    frames.push({ id, data: JSON.parse(data) as Record<string, unknown> })
                }
            }
        }
    } finally {
        // The parked read engages the stream's pull on the next macrotask;
        // cancelling before that happens is silently ignored.
        const parked = reader.read().catch(() => null)
        await new Promise((resolve) => setTimeout(resolve, 0))
        await reader.cancel().catch(() => {})
        await parked
    }
    return frames
}

function buildApp(manager: SSEManager, engine: SyncEngine | null = null): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'ns-test')
        c.set('userId', 1)
        await next()
    })
    app.route('/api', createEventsRoutes(() => manager, () => engine, () => null))
    return app
}

async function openStream(app: Hono<WebAppEnv>, query: string): Promise<Response> {
    return await app.request(`/api/events?all=true${query}`)
}

describe('GET /api/events workspace subscriptions', () => {
    const engine = {
        resolveSessionAccess(id: string) {
            if (id === 'foreign') return { ok: false, reason: 'access-denied' }
            if (id === 'deleted') return { ok: false, reason: 'not-found' }
            return { ok: true, sessionId: id === 'old-a' ? 'a' : id }
        }
    } as unknown as SyncEngine

    it('binds all visible canonical sessions and keeps valid panes when another was deleted', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const app = buildApp(manager, engine)
        const response = await app.request(`/api/events?sessionIds=${encodeURIComponent(JSON.stringify(['old-a', 'b', 'deleted']))}`)
        expect(response.status).toBe(200)
        await new Promise(resolve => setTimeout(resolve, 20))
        for (const sessionId of ['hidden', 'a', 'b']) manager.broadcast({ type: 'session-updated', sessionId, namespace: 'ns-test' })
        const frames = await collectFrames(response, 3)
        expect(frames.slice(1).map(f => f.data.sessionId)).toEqual(['a', 'b'])
        manager.stop()
    })

    it('rejects foreign sessions and malformed selector values before opening a stream', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const app = buildApp(manager, engine)
        expect((await app.request('/api/events?sessionIds=%5B%22a%22,%22foreign%22%5D')).status).toBe(403)
        for (const query of ['sessionIds=not-json', 'sessionIds=%7B%7D', 'sessionIds=%5B1%5D', 'messageMode=unknown']) {
            expect((await app.request(`/api/events?${query}`)).status).toBe(400)
        }
        manager.stop()
    })

    it('sends body-free global notifications on the HTTP stream', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const response = await openStream(buildApp(manager), '&messageMode=notify')
        await new Promise(resolve => setTimeout(resolve, 20))
        manager.broadcast({ type: 'message-received', sessionId: 'a', namespace: 'ns-test',
            message: { id: 'm1', seq: 1, localId: 'queue-1', createdAt: 1, invokedAt: null, scheduledAt: 10,
                content: { role: 'user', content: { type: 'text', text: 'No body on the global stream' } } } })
        manager.broadcast({ type: 'messages-consumed', sessionId: 'a', namespace: 'ns-test', localIds: ['queue-1'], invokedAt: 20 })
        const frames = await collectFrames(response, 3)
        expect(frames[1].data).toEqual({ type: 'message-updated', sessionId: 'a', namespace: 'ns-test', scheduled: true })
        expect(frames[2].data).toMatchObject({ type: 'messages-consumed', localIds: ['queue-1'], invokedAt: 20 })
        manager.stop()
    })
})

describe('GET /api/events replay', () => {
    it('first connect gets a gap verdict and id-tagged live events', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const app = buildApp(manager)

        const res = await openStream(app, '')

        // Give the route a beat to subscribe before broadcasting
        await new Promise((r) => setTimeout(r, 20))
        manager.broadcast({ type: 'session-updated', sessionId: 's1', namespace: 'ns-test' })
        manager.broadcast({ type: 'session-updated', sessionId: 's2', namespace: 'ns-test' })

        const frames = await collectFrames(res, 3)

        expect(frames[0]?.data.type).toBe('connection-changed')
        expect((frames[0]?.data.data as { resume?: string }).resume).toBe('gap')
        expect(frames[0]?.id).toBeNull()

        expect(frames[1]?.data.sessionId).toBe('s1')
        expect(frames[1]?.id).toMatch(/^[0-9a-f-]{8}:\d+:[0-9a-f]{8}$/)
        expect(frames[2]?.data.sessionId).toBe('s2')
    })

    it('reconnect with lastEventId replays the missed events before live traffic', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const app = buildApp(manager)

        // First connection observes event 1, then drops.
        const firstRes = await openStream(app, '')
        await new Promise((r) => setTimeout(r, 20))
        manager.broadcast({ type: 'session-updated', sessionId: 'seen', namespace: 'ns-test' })
        const firstFrames = await collectFrames(firstRes, 2)
        const cursor = firstFrames[1]?.id
        expect(cursor).toBeTruthy()

        // Missed while disconnected.
        manager.broadcast({ type: 'session-updated', sessionId: 'missed-1', namespace: 'ns-test' })
        manager.broadcast({ type: 'session-updated', sessionId: 'missed-2', namespace: 'ns-test' })

        // Reconnect with the cursor.
        const secondRes = await openStream(app, `&lastEventId=${encodeURIComponent(cursor!)}`)
        await new Promise((r) => setTimeout(r, 20))
        manager.broadcast({ type: 'session-updated', sessionId: 'live-after', namespace: 'ns-test' })

        const frames = await collectFrames(secondRes, 4)

        expect(frames[0]?.data.type).toBe('connection-changed')
        expect((frames[0]?.data.data as { resume?: string }).resume).toBe('ok')
        expect(frames.slice(1).map((f) => f.data.sessionId)).toEqual(['missed-1', 'missed-2', 'live-after'])
        // Replayed frames keep their original ids so the cursor keeps advancing
        expect(frames[1]?.id?.split(':')[1]).toBe('2')
        expect(frames[2]?.id?.split(':')[1]).toBe('3')
    })

    it('reconnect with a stale cursor from another process gets a gap', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const app = buildApp(manager)

        const res = await openStream(app, '&lastEventId=00000000%3A42%3A00000000')
        const frames = await collectFrames(res, 1)

        expect(frames[0]?.data.type).toBe('connection-changed')
        expect((frames[0]?.data.data as { resume?: string }).resume).toBe('gap')
    })

    it('prefers the standard Last-Event-ID header over the query parameter', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const app = buildApp(manager)

        const firstRes = await openStream(app, '')
        await new Promise((r) => setTimeout(r, 20))
        manager.broadcast({ type: 'session-updated', sessionId: 'e1', namespace: 'ns-test' })
        manager.broadcast({ type: 'session-updated', sessionId: 'e2', namespace: 'ns-test' })
        const firstFrames = await collectFrames(firstRes, 3)
        const oldCursor = firstFrames[1]?.id
        const freshCursor = firstFrames[2]?.id
        expect(oldCursor && freshCursor).toBeTruthy()

        manager.broadcast({ type: 'session-updated', sessionId: 'e3', namespace: 'ns-test' })

        // Native auto-reconnects keep the stale URL cursor but send the fresh
        // one in the header - the header must win, replaying only e3.
        const res = await app.request(
            `/api/events?all=true&lastEventId=${encodeURIComponent(oldCursor!)}`,
            { headers: { 'Last-Event-ID': freshCursor! } }
        )
        const frames = await collectFrames(res, 2)

        expect((frames[0]?.data.data as { resume?: string }).resume).toBe('ok')
        expect(frames[1]?.data.sessionId).toBe('e3')
    })

    it('releases the subscription when the client disconnects', async () => {
        const manager = new SSEManager(0, new VisibilityTracker())
        const app = buildApp(manager)

        const res = await openStream(app, '')
        const frames = await collectFrames(res, 1)
        expect(frames[0]?.data.type).toBe('connection-changed')

        // After abort the connection must be unsubscribed: broadcasting to a
        // dead stream would otherwise throw / leak.
        await new Promise((r) => setTimeout(r, 50))
        const subscriptionId = (frames[0]?.data.data as { subscriptionId?: string }).subscriptionId
        expect(subscriptionId).toBeTruthy()
        expect(manager.hasSubscription(subscriptionId!)).toBe(false)
    })
})
