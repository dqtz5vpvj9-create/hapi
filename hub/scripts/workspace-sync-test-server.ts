// Isolated browser-test Hub: real JWT middleware, SQLite workspace store, routes and SSE.
// Chat rendering uses workspace-fixture.tsx; no production credentials, agents or terminals.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { SignJWT } from 'jose'
import type { SyncEvent } from '@hapi/protocol'
import { Store } from '../src/store'
import { createAuthMiddleware, type WebAppEnv } from '../src/web/middleware/auth'
import { createWorkspacesRoutes } from '../src/web/routes/workspaces'

const store = new Store(':memory:')
for (let i = 1; i <= 4; i++) store.sessions.getOrCreateSession(`fixture-${i}`, {}, null, 'fixture', undefined, undefined, undefined, `chat-${i}`)
const secret = crypto.getRandomValues(new Uint8Array(32))
const token = await new SignJWT({ uid: 1, ns: 'fixture' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)
const subscribers = new Set<(event: SyncEvent) => void>()
const app = new Hono<WebAppEnv>()
app.use('*', cors({ origin: ['http://127.0.0.1:5188', 'http://localhost:5188'] }))
app.use('/api/*', createAuthMiddleware(secret))
app.get('/api/events', c => streamSSE(c, async stream => {
    let finish!: () => void
    const closed = new Promise<void>(resolve => { finish = resolve })
    const send = (event: SyncEvent) => { void stream.writeSSE({ data: JSON.stringify(event) }).catch(finish) }
    subscribers.add(send)
    stream.onAbort(finish)
    await stream.writeSSE({ data: JSON.stringify({ type: 'workspaces-updated', namespace: 'fixture', revision: store.workspaces.get('fixture').revision }) })
    await closed
    subscribers.delete(send)
}))
app.route('/api', createWorkspacesRoutes(store, event => { for (const send of subscribers) send(event) }))
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: app.fetch })
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}`, token }))
process.on('SIGTERM', () => { server.stop(true); store.close(); process.exit(0) })
