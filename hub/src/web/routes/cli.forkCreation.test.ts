import { beforeAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { createConfiguration } from '../../configuration'
import { Store } from '../../store'
import { RpcRegistry } from '../../socket/rpcRegistry'
import { SyncEngine } from '../../sync/syncEngine'
import { createCliRoutes } from './cli'

beforeAll(async () => {
    const configuration = await createConfiguration()
    configuration._setCliApiToken('test-token', 'env', false)
})

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    engine.stop()
    const app = new Hono()
    app.route('/cli', createCliRoutes(() => engine))
    const create = (body: Record<string, unknown>, namespace = 'default') => app.request('/cli/sessions', {
        method: 'POST', headers: { authorization: `Bearer test-token:${namespace}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
    })
    return { store, create }
}

describe('durable fork child creation through the real CLI route', () => {
    it('creates the exact operation ID while a missing preallocated stub still cannot be adopted', async () => {
        const { store, create } = fixture()
        try {
            const id = randomUUID()
            const body = { id, tag: randomUUID(), metadata: { path: '/tmp/project', host: 'test', flavor: 'codex', forkedFrom: 'source' },
                agentState: { controlledByUser: false } }
            expect((await create({ ...body, adopt: true })).status).toBe(404)
            expect(store.sessions.getSession(id)).toBeNull()
            const created = await create(body)
            expect(created.status).toBe(200)
            expect((await created.json() as { session: { id: string } }).session.id).toBe(id)
            expect(store.sessions.getSession(id)).toMatchObject({ id, tag: body.tag, namespace: 'default', metadata: body.metadata })
            expect((await create(body)).status).toBe(200)
            expect(store.sessions.getSessionsByNamespace('default')).toHaveLength(1)
        } finally { store.close() }
    })

    it('keeps an existing row untouched on another tag, namespace, or adopt attempt', async () => {
        const { store, create } = fixture()
        try {
            const id = randomUUID()
            const body = { id, tag: randomUUID(), metadata: { path: '/tmp/project', host: 'test', flavor: 'codex', forkedFrom: 'source' } }
            expect((await create(body)).status).toBe(200)
            const original = store.sessions.getSession(id)
            expect((await create({ ...body, tag: randomUUID(), metadata: { path: '/other' } })).status).toBe(409)
            expect((await create(body, 'other')).status).toBe(409)
            expect((await create({ ...body, tag: randomUUID(), adopt: true })).status).toBe(409)
            expect(store.sessions.getSession(id)).toEqual(original)
            expect(store.sessions.getSessionsByNamespace('other')).toHaveLength(0)
        } finally { store.close() }
    })
})
