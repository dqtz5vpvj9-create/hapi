import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

const rootThreadId = randomUUID(), threadId = randomUUID()
function fixture(options: { access?: boolean; machineNamespace?: string; active?: boolean; error?: boolean } = {}) {
    const reads: unknown[][] = [], accesses: unknown[][] = []
    const engine = { resolveSessionAccess: (...args: unknown[]) => {
        accesses.push(args)
        return options.access === false ? { ok: false, reason: 'access-denied' } : { ok: true, sessionId: 'canonical', session: { metadata: { machineId: 'machine', flavor: 'codex', codexSessionId: rootThreadId } } }
    }, getMachine: () => ({ id: 'machine', namespace: options.machineNamespace ?? 'owner', active: options.active !== false }),
    readCodexSubagentMessages: async (...args: unknown[]) => {
        reads.push(args)
        if (options.error) throw new Error('Native transcript is unavailable')
        return { threadId, messages: [], before: null, hasMore: false, after: 180, epoch: 'native-epoch', hasLater: false }
    } } as unknown as SyncEngine
    const app = new Hono<WebAppEnv>()
    app.use('*', async (context, next) => { context.set('namespace', 'owner'); await next() })
    app.route('/api', createMessagesRoutes(() => engine))
    const read = (query = '') => app.request(`/api/sessions/alias/codex-subagents/${threadId}/messages${query}`)
    return { read, reads, accesses }
}
describe('native child history HTTP boundary', () => {
    it('forwards validated incremental coordinates only through the authorized parent machine', async () => {
        const { read, reads, accesses } = fixture()
        const response = await read('?limit=80&after=120&epoch=native-epoch')
        expect(response.status).toBe(200)
        expect(response.headers.get('Cache-Control')).toBe('private, no-store')
        expect(await response.json()).toMatchObject({ after: 180, epoch: 'native-epoch' })
        expect(accesses[0]?.slice(0, 2)).toEqual(['alias', 'owner'])
        expect(reads).toEqual([['machine', { rootThreadId, threadId, limit: 80, after: 120, epoch: 'native-epoch' }]])
    })
    it('rejects foreign parents, foreign machines and offline machines before native reads', async () => {
        for (const [options, status] of [[{ access: false }, 403], [{ machineNamespace: 'other' }, 404], [{ active: false }, 503]] as const) {
            const { read, reads } = fixture(options)
            expect((await read()).status).toBe(status)
            expect(reads).toEqual([])
        }
    })
    it('rejects unbound, mixed and unbounded cursors before invoking the machine', async () => {
        const { read, reads } = fixture()
        for (const query of ['?after=1', '?before=1&after=2&epoch=e', '?limit=1000', '?after=-1&epoch=e']) expect((await read(query)).status).toBe(400)
        expect(reads).toEqual([])
    })
    it('keeps real reader failures visible without reporting an empty successful history', async () => {
        const { read } = fixture({ error: true })
        const response = await read()
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Native transcript is unavailable' })
    })
})
