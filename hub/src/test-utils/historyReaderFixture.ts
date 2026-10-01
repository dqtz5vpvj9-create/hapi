import { SignJWT } from 'jose'
import { Hono } from 'hono'
import { Store } from '../store'
import { MessageService } from '../sync/messageService'
import { MessageDependencyBackfill } from '../sync/messageDependencyBackfill'
import type { SyncEngine } from '../sync/syncEngine'
import type { WebAppEnv } from '../web/middleware/auth'
import { createAuthMiddleware } from '../web/middleware/auth'
import { createMessagesRoutes } from '../web/routes/messages'

export async function createHistoryReaderFixture(count = 1_201, backgroundBackfill = false) {
    const store = new Store(':memory:')
    const session = store.sessions.getOrCreateSession('history-reader', null, null, 'reader')
    const rows = Array.from({ length: count }, (_, i) => store.messages.addImportedMessage(
        session.id, { role: 'user', content: { type: 'text', text: `paragraph ${i}` } }, `local-${i}`, 1_000 + Math.floor(i / 3)
    ).message)
    const forbidden = new Proxy({}, { get() { throw new Error('Reading invoked an agent or event action') } })
    const service = new MessageService(store, forbidden as never, forbidden as never)
    const backfill = new MessageDependencyBackfill(store)
    const engine = {
        resolveSessionAccess(id: string, namespace: string) {
            const target = store.sessions.getSession(id)
            return target && target.namespace === namespace
                ? { ok: true, sessionId: id, session: { ...target, active: false } }
                : { ok: false, reason: 'access-denied' }
        },
        getMessagesPage: service.getMessagesPage.bind(service),
        getMessageContext: service.getMessageContext.bind(service),
        getMessageDependencies(id: string, seeds: string[], epoch: number) {
            const result = service.getMessageDependencies(id, seeds, epoch)
            if (backgroundBackfill && result && !result.reset && !result.indexScanned) backfill.request(id)
            return result
        },
    } as unknown as SyncEngine
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const tokenForNamespace = (namespace: string) => new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).sign(secret)
    const token = await tokenForNamespace('reader')
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(secret))
    app.route('/api', createMessagesRoutes(() => engine))
    const requests: Array<{ method: string; query: string }> = []
    let nextGate: { entered: () => void; released: Promise<void> } | null = null
    let releaseActive: (() => void) | null = null
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        requests.push({ method: request.method, query: new URL(request.url).search })
        const gate = nextGate
        nextGate = null
        const response = await app.fetch(request)
        if (gate) { gate.entered(); await gate.released }
        return response
    } })
    const cleanup = () => { releaseActive?.(); backfill.stop(); server.stop(true); store.close() }
    const delayNextResponse = () => {
        let entered!: () => void
        let release!: () => void
        const received = new Promise<void>(resolve => { entered = resolve })
        const released = new Promise<void>(resolve => { release = resolve })
        releaseActive = release
        nextGate = { entered, released }
        return { received, release }
    }
    return { store, sessionId: session.id, rows, token, tokenForNamespace, baseUrl: `http://127.0.0.1:${server.port}`, cleanup, requests, delayNextResponse }
}
