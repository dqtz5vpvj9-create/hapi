import { afterEach, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { Server } from 'socket.io'
import type { MessageContextResponse, MessageOutlineResponse } from '@hapi/protocol'
import { Store } from '../../store'
import { MessageService } from '../../sync/messageService'
import { SyncEngine } from '../../sync/syncEngine'
import { MessageOutlineBackfill } from '../../sync/messageOutlineBackfill'
import type { EventPublisher } from '../../sync/eventPublisher'
import { createAuthMiddleware, type WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

const cleanups: Array<() => void> = []
afterEach(() => { for (const close of cleanups.splice(0)) close() })
async function fixture(count = 1501, corrupt = false) {
    const store = new Store(':memory:')
    const db = (store as unknown as { db: Database }).db
    const session = store.sessions.getOrCreateSession('sparse-history', null, null, 'reader')
    const insert = db.prepare('INSERT INTO messages(id,session_id,content,created_at,seq,invoked_at,local_id) VALUES (?,?,?,?,?,?,?)')
    db.transaction(() => {
        for (let seq = 1; seq <= count; seq++) insert.run(`row-${seq}`, session.id,
            corrupt ? new Uint8Array([1, 2, 3]) : JSON.stringify(seq === 1 || seq === 751
                ? { role: 'user', content: { type: 'text', text: `Question ${seq}` } }
                : { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'ANSWER_BODY_MUST_NOT_BE_RETURNED'.repeat(20) } } }),
            seq, seq, seq, `local-${seq}`)
    })()
    const unavailable = new Proxy({}, { get() { throw new Error('Outline read invoked an agent or event path') } })
    const service = new MessageService(store, unavailable as Server, unavailable as EventPublisher)
    const errors: unknown[] = []
    let batches = 0
    const backfill = store.messages.backfillOutline.bind(store.messages)
    store.messages.backfillOutline = id => { batches++; return backfill(id) }
    const worker = new MessageOutlineBackfill(store, (_id, error) => errors.push(error))
    cleanups.push(() => { worker.stop(); store.close() })
    // Execute the real engine read/scheduling method, without starting agents.
    const engine = {
        messageService: service, messageOutlineBackfill: worker,
        getMessageOutline: SyncEngine.prototype.getMessageOutline,
        getMessageContext: service.getMessageContext.bind(service),
        resolveSessionAccess(id: string, namespace: string) {
            const target = store.sessions.getSession(id)
            if (!target) return { ok: false, reason: 'not-found' }
            if (target.namespace !== namespace) return { ok: false, reason: 'access-denied' }
            return { ok: true, sessionId: id, session: { ...target, active: false } }
        }
    } as unknown as SyncEngine
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const token = (namespace: string) => new SignJWT({ uid: 1, ns: namespace })
        .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)
    const headers = { authorization: `Bearer ${await token('reader')}` }
    const app = new Hono<WebAppEnv>()
    app.use('*', createAuthMiddleware(secret))
    app.route('/', createMessagesRoutes(() => engine))
    const url = `/sessions/${session.id}/messages/outline`
    const read = async (query = '') => (await (await app.request(url + query, { headers })).json()) as MessageOutlineResponse
    return { store, session, app, token, headers, url, read, errors, batches: () => batches }
}
async function until(read: () => Promise<MessageOutlineResponse>, ready: (result: MessageOutlineResponse) => boolean) {
    const deadline = Date.now() + 4000
    let result = await read()
    while (!ready(result) && Date.now() < deadline) { await Bun.sleep(30); result = await read() }
    expect(ready(result)).toBe(true)
    return result
}

it('indexes a sparse history in background and locates a question through authenticated readonly routes', async () => {
    const f = await fixture()
    const first = await f.read('?limit=1')
    expect(first.entries).toEqual([])
    expect(first.page).toMatchObject({ complete: false, indexing: true, scannedThrough: 0 })
    expect(f.batches()).toBe(0)
    const ready = await until(() => f.read('?limit=1'), result => result.page.complete)
    expect(ready.entries.map(entry => entry.messageId)).toEqual(['row-751'])
    expect(JSON.stringify(ready)).not.toContain('ANSWER_BODY')
    expect(ready.page.hasMore).toBe(true)
    const cursor = ready.page.beforeCursor!
    const earlier = await f.read(`?limit=1&beforeAt=${cursor.at}&beforeSeq=${cursor.seq}&epoch=${ready.page.epoch}`)
    expect(earlier.entries.map(entry => entry.messageId)).toEqual(['row-1'])
    expect(earlier.page.hasMore).toBe(false)
    const response = await f.app.request(`/sessions/${f.session.id}/messages/row-751/context?radius=1`, { headers: f.headers })
    expect(response.status).toBe(200)
    expect(((await response.json()) as MessageContextResponse).anchor.messageId).toBe('row-751')
    expect(f.errors).toEqual([])
})

it('rejects unauthorized or malformed reads before scheduling and resets stale epoch cursors', async () => {
    const f = await fixture(3)
    expect((await f.app.request(f.url)).status).toBe(401)
    expect((await f.app.request(f.url, { headers: { authorization: `Bearer ${await f.token('other')}` } })).status).toBe(403)
    for (const query of ['?limit=101', '?limit=0', '?beforeAt=1', '?beforeSeq=1', '?beforeAt=1&beforeSeq=1', '?epoch=-1']) {
        expect((await f.app.request(f.url + query, { headers: f.headers })).status).toBe(400)
    }
    await Bun.sleep(60)
    expect(f.batches()).toBe(0)
    const original = await until(f.read, page => page.page.complete)
    f.store.messages.truncateMessagesFromLocalId(f.session.id, 'local-2', [])
    const stale = await f.read(`?beforeAt=2&beforeSeq=2&epoch=${original.page.epoch}`)
    expect(stale.page.reset).toBe(true)
    expect(stale.entries).toEqual([])
    expect(stale.page.beforeCursor).toBeNull()
})

it('reports unreadable coverage without endlessly rescheduling an exhausted scan', async () => {
    const f = await fixture(1, true)
    const result = await until(f.read, page => page.page.scannedThrough === page.page.headSeq)
    expect(result.page).toMatchObject({ complete: false, unreadable: true, indexing: false })
    const batches = f.batches()
    await Bun.sleep(80)
    await f.read()
    await Bun.sleep(80)
    expect(f.batches()).toBe(batches)
    expect(f.errors).toEqual([])
})
