import { afterEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import type { Server } from 'socket.io'
import type { MessageContextResponse, MessagesResponse } from '@hapi/protocol'
import { Store } from '../../store'
import { MessageService } from '../../sync/messageService'
import type { EventPublisher } from '../../sync/eventPublisher'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createAuthMiddleware } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture(authSecret?: Uint8Array) {
    const store = new Store(':memory:')
    stores.push(store)
    const session = store.sessions.getOrCreateSession('history', null, null, 'reader')
    // Reading must work without an agent, socket or event publisher.
    const unavailable = new Proxy({}, { get() { throw new Error('History read invoked an agent/event path') } })
    const service = new MessageService(store, unavailable as Server, unavailable as EventPublisher)
    let lookups = 0
    const engine = {
        resolveSessionAccess(id: string, namespace: string) {
            const target = store.sessions.getSession(id)
            if (!target) return { ok: false, reason: 'not-found' }
            if (target.namespace !== namespace) return { ok: false, reason: 'access-denied' }
            return { ok: true, sessionId: id, session: { ...target, active: false } }
        },
        getMessageContext(...args: Parameters<MessageService['getMessageContext']>) {
            lookups++
            return service.getMessageContext(...args)
        },
        getMessagesPage: service.getMessagesPage.bind(service),
    } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    if (authSecret) {
        app.use('*', createAuthMiddleware(authSecret))
    } else {
        app.use('*', async (c, next) => {
            c.set('namespace', c.req.header('x-test-namespace') ?? 'reader')
            await next()
        })
    }
    app.route('/', createMessagesRoutes(() => engine))
    const add = (i: number, content: unknown = { role: 'user', content: { type: 'text', text: `paragraph ${i}` } }) =>
        store.messages.addMessage(session.id, content, `local-${i}`, null, 1_000 + Math.floor(i / 3))
    const contextUrl = (id: string, query = 'radius=50') => `/sessions/${session.id}/messages/${id}/context?${query}`
    return { store, session, app, add, contextUrl, lookups: () => lookups }
}

describe('saved history position through the message routes and real SQLite', () => {
    it('locates a far message in a 10,000-row history and continues reading both sides without replaying an agent', async () => {
        const f = fixture()
        const rows = Array.from({ length: 10_000 }, (_, i) => f.add(i))
        const response = await f.app.request(f.contextUrl(rows[4_321].id))
        expect(response.status).toBe(200)
        const result = await response.json() as MessageContextResponse
        expect(result.anchor.messageId).toBe(rows[4_321].id)
        expect(result.messages.map(m => m.id)).toEqual(rows.slice(4_271, 4_372).map(m => m.id))
        expect(result.page.hasMoreBefore).toBe(true)
        expect(result.page.hasMoreAfter).toBe(true)
        const before = result.page.beforeCursor
        const after = result.page.afterCursor
        const olderResponse = await f.app.request(`/sessions/${f.session.id}/messages?beforeAt=${before.at}&beforeSeq=${before.seq}&limit=50`)
        const newerResponse = await f.app.request(`/sessions/${f.session.id}/messages?afterAt=${after.at}&afterSeq=${after.seq}&epoch=${result.page.epoch}&limit=50&untilAt=${result.page.snapshotHead.at}&untilSeq=${result.page.snapshotHead.seq}`)
        const older = await olderResponse.json() as MessagesResponse
        const newer = await newerResponse.json() as MessagesResponse
        expect(older.messages.map(m => m.id)).toEqual(rows.slice(4_221, 4_271).map(m => m.id))
        expect(newer.messages.map(m => m.id)).toEqual(rows.slice(4_372, 4_422).map(m => m.id))
        expect(new Set([...older.messages, ...result.messages, ...newer.messages].map(m => m.id)).size).toBe(201)
        expect(f.lookups()).toBe(1)
    })

    it('bounds work across invisible events and keeps raw cursors so the reader can explicitly continue', async () => {
        const f = fixture()
        const oldest = f.add(0)
        const hidden = Array.from({ length: 300 }, (_, i) => f.add(i + 1, {
            role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Goal active · 8016 tokens' } },
        }))
        const anchor = f.add(301)
        const result = await (await f.app.request(f.contextUrl(anchor.id, 'radius=99'))).json() as MessageContextResponse
        expect(result.messages.map(m => m.id)).toEqual([anchor.id])
        expect(result.messages.some(m => m.id === oldest.id)).toBe(false)
        expect(result.page.beforeCursor.seq).toBe(hidden[201].seq)
        expect(result.page.hasMoreBefore).toBe(true)
        expect(result.page.hasMoreAfter).toBe(false)
    })

    it('handles the first/last positions and rejects oversized or malformed requests', async () => {
        const f = fixture()
        const rows = [f.add(0), f.add(1), f.add(2)]
        const first = await (await f.app.request(f.contextUrl(rows[0].id, 'radius=1'))).json() as MessageContextResponse
        const last = await (await f.app.request(f.contextUrl(rows[2].id, 'radius=1'))).json() as MessageContextResponse
        expect(first.page.hasMoreBefore).toBe(false)
        expect(first.page.hasMoreAfter).toBe(true)
        expect(last.page.hasMoreBefore).toBe(true)
        expect(last.page.hasMoreAfter).toBe(false)
        expect(last.messages.map(m => m.id)).toEqual(rows.slice(1).map(m => m.id))
        const calls = f.lookups()
        for (const query of ['radius=100', 'radius=0', 'radius=1.5', 'epoch=-1']) {
            expect((await f.app.request(f.contextUrl(rows[0].id, query))).status).toBe(400)
        }
        expect(f.lookups()).toBe(calls)
    })

    it('invalidates old bookmarks after rewind without resurrecting removed messages', async () => {
        const f = fixture()
        const rows = Array.from({ length: 20 }, (_, i) => f.add(i))
        const original = await (await f.app.request(f.contextUrl(rows[4].id))).json() as MessageContextResponse
        f.store.messages.truncateMessagesFromLocalId(f.session.id, 'local-10', [])
        const restored = await (await f.app.request(f.contextUrl(rows[4].id, `epoch=${original.page.epoch}`))).json() as MessageContextResponse
        expect(restored.page.reset).toBe(true)
        expect(restored.page.epoch).toBeGreaterThan(original.page.epoch)
        expect(restored.messages.map(m => m.id)).toEqual(rows.slice(0, 10).map(m => m.id))
        expect((await f.app.request(f.contextUrl(rows[15].id))).status).toBe(404)
        for (const direction of ['before', 'after']) {
            const cursor = direction === 'before' ? original.page.beforeCursor : original.page.afterCursor
            const response = await f.app.request(`/sessions/${f.session.id}/messages?${direction}At=${cursor.at}&${direction}Seq=${cursor.seq}&epoch=${original.page.epoch}&limit=20&bounded=true`)
            expect(response.status).toBe(200)
            const page = await response.json() as MessagesResponse
            expect(page.page.reset).toBe(true)
            expect(page.page.epoch).toBe(restored.page.epoch)
            expect(page.messages.map(m => m.id)).toEqual(rows.slice(0, 10).map(m => m.id))
        }
    })

    it('lets a reader pause at an invisible region and explicitly continue in bounded pages', async () => {
        const f = fixture()
        const oldest = f.add(0)
        for (let i = 1; i <= 300; i++) f.add(i, {
            role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Goal active · 8016 tokens' } },
        })
        const anchor = f.add(301)
        const context = await (await f.app.request(f.contextUrl(anchor.id, 'radius=99'))).json() as MessageContextResponse
        const original = f.store.messages.getMessagesByPosition.bind(f.store.messages)
        let queryCalls = 0
        f.store.messages.getMessagesByPosition = (...args: Parameters<typeof original>) => { queryCalls++; return original(...args) }
        let cursor = context.page.beforeCursor
        const seen = []
        for (let attempt = 0; attempt < 6; attempt++) {
            const beforeCalls = queryCalls
            const response = await f.app.request(`/sessions/${f.session.id}/messages?beforeAt=${cursor.at}&beforeSeq=${cursor.seq}&epoch=${context.page.epoch}&limit=50&bounded=true`)
            const result = await response.json() as MessagesResponse
            // A page and one existence probe, irrespective of hidden-region length.
            expect(queryCalls - beforeCalls).toBeLessThanOrEqual(2)
            seen.push(...result.messages)
            if (attempt === 1) expect(seen).toHaveLength(0)
            if (!result.page.hasMore) break
            expect(result.page.nextBeforeSeq).toBeLessThan(cursor.seq)
            cursor = { at: result.page.nextBeforeAt!, seq: result.page.nextBeforeSeq! }
        }
        expect(seen.map(m => m.id)).toEqual([oldest.id])
    })

    it('checks namespace before lookup and never treats a foreign raw ID as part of an authorized session', async () => {
        const f = fixture()
        const row = f.add(0)
        expect((await f.app.request(f.contextUrl(row.id), { headers: { 'x-test-namespace': 'other' } })).status).toBe(403)
        expect(f.lookups()).toBe(0)
        const other = f.store.sessions.getOrCreateSession('other', null, null, 'reader')
        const foreign = f.store.messages.addMessage(other.id, { role: 'user', content: { type: 'text', text: 'private' } })
        expect((await f.app.request(f.contextUrl(foreign.id))).status).toBe(404)
        expect((await f.app.request(f.contextUrl('deleted'))).status).toBe(404)
    })

    it('uses the established JWT middleware for missing credentials, another namespace and an authorized saved position', async () => {
        const secret = crypto.getRandomValues(new Uint8Array(32))
        const f = fixture(secret)
        const row = f.add(0)
        const token = (namespace: string) => new SignJWT({ uid: 1, ns: namespace })
            .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(secret)
        expect((await f.app.request(f.contextUrl(row.id))).status).toBe(401)
        expect((await f.app.request(f.contextUrl(row.id), { headers: { authorization: 'Bearer invalid' } })).status).toBe(401)
        expect((await f.app.request(f.contextUrl(row.id), { headers: { authorization: `Bearer ${await token('other')}` } })).status).toBe(403)
        expect(f.lookups()).toBe(0)
        const response = await f.app.request(f.contextUrl(row.id), { headers: { authorization: `Bearer ${await token('reader')}` } })
        expect(response.status).toBe(200)
        const result = await response.json() as MessageContextResponse
        expect(result.anchor.messageId).toBe(row.id)
        expect(result.messages).toHaveLength(1)
    })
})
