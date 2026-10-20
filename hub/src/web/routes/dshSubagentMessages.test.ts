import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createMessagesRoutes } from './messages'

const rootDshSessionId = 'dsh-root-session'
const subagentSessionId = 'dsh-child-session'
const parentMetadata = {
    machineId: 'machine',
    flavor: 'dsh',
    dshSessionId: rootDshSessionId,
    dshSubagents: [{ sessionId: subagentSessionId, mode: 'continuable', activity: 'running', createdAt: 1 }]
}

function fixture(options: {
    access?: boolean
    metadata?: Record<string, unknown>
    machineExists?: boolean
    machineNamespace?: string
    machineActive?: boolean
    sessionActive?: boolean
    error?: string
} = {}) {
    const reads: unknown[][] = [], prompts: unknown[][] = [], interrupts: unknown[][] = [], accesses: unknown[][] = []
    const engine = {
        resolveSessionAccess: (...args: unknown[]) => {
            accesses.push(args)
            if (options.access === false) return { ok: false, reason: 'access-denied' }
            return {
                ok: true,
                sessionId: 'canonical-parent',
                session: { active: options.sessionActive !== false, metadata: options.metadata ?? parentMetadata }
            }
        },
        getMachine: () => options.machineExists === false ? undefined : {
            id: 'machine',
            namespace: options.machineNamespace ?? 'owner',
            active: options.machineActive !== false
        },
        readDshSubagentMessages: async (...args: unknown[]) => {
            reads.push(args)
            if (options.error) throw new Error(options.error)
            return {
                sessionId: subagentSessionId,
                messages: [{ id: `${subagentSessionId}:12`, role: 'assistant', kind: 'message', text: 'hello', createdAt: 12 }],
                before: 12, hasMore: false, after: 12, epoch: 'child-epoch', hasLater: false, reset: false
            }
        },
        promptDshSubagent: async (...args: unknown[]) => {
            prompts.push(args)
            if (options.error) throw new Error(options.error)
            return { messageId: 'child-message-1' }
        },
        interruptDshSubagent: async (...args: unknown[]) => {
            interrupts.push(args)
            if (options.error) throw new Error(options.error)
            return { accepted: true }
        }
    } as unknown as SyncEngine

    const app = new Hono<WebAppEnv>()
    app.use('*', async (context, next) => { context.set('namespace', 'owner'); await next() })
    app.route('/api', createMessagesRoutes(() => engine))
    const base = `/api/sessions/alias/dsh-subagents/${subagentSessionId}`
    return {
        reads, prompts, interrupts, accesses,
        read: (query = '') => app.request(`${base}/messages${query}`),
        prompt: (body?: unknown) => app.request(`${base}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        }),
        interrupt: () => app.request(`${base}/interrupt`, { method: 'POST' })
    }
}

describe('DSH child transcript HTTP boundary', () => {
    it('forwards validated pagination through the parent session channel and returns the page', async () => {
        const { read, reads, accesses } = fixture()
        const response = await read('?limit=80&after=120&epoch=child-epoch')
        expect(response.status).toBe(200)
        expect(response.headers.get('Cache-Control')).toBe('private, no-store')
        expect(await response.json()).toMatchObject({ sessionId: subagentSessionId, after: 12, epoch: 'child-epoch' })
        expect(accesses[0]?.slice(0, 2)).toEqual(['alias', 'owner'])
        expect(reads).toEqual([['canonical-parent', { limit: 80, after: 120, epoch: 'child-epoch', sessionId: subagentSessionId }]])
    })

    it('rejects mixed and unbounded cursors before invoking the reader', async () => {
        const { read, reads } = fixture()
        for (const query of ['?after=1', '?before=1&after=2&epoch=e', '?limit=1000', '?after=-1&epoch=e']) {
            expect((await read(query)).status).toBe(400)
        }
        expect(reads).toEqual([])
    })

    it('rejects foreign parents, unmirrored children and offline or foreign machines', async () => {
        const cases = [
            [{ access: false }, 403],
            [{ metadata: { ...parentMetadata, flavor: 'codex' } }, 404],
            [{ metadata: { ...parentMetadata, dshSessionId: undefined } }, 404],
            [{ metadata: { ...parentMetadata, dshSubagents: [{ sessionId: 'other-child', mode: 'one-shot', activity: 'inactive', createdAt: 1 }] } }, 404],
            [{ machineExists: false }, 404],
            [{ machineNamespace: 'other' }, 404],
            [{ machineActive: false }, 503]
        ] as const
        for (const [options, status] of cases) {
            const { read, reads } = fixture(options)
            expect((await read()).status).toBe(status)
            expect(reads).toEqual([])
        }
    })

    it('rejects reads when the parent session is inactive', async () => {
        const { read, reads } = fixture({ sessionActive: false })
        const response = await read()
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Session is inactive', code: 'session_inactive' })
        expect(reads).toEqual([])
    })

    it('keeps reader failures visible instead of reporting an empty successful page', async () => {
        const { read } = fixture({ error: 'Child transcript is unavailable' })
        const response = await read()
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Child transcript is unavailable' })
    })
})

describe('DSH child input HTTP boundary', () => {
    it('forwards a queued prompt to the continuable child', async () => {
        const { prompt, prompts } = fixture()
        const response = await prompt({ text: 'continue please', delivery: 'steer', requestId: 'req-1' })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ messageId: 'child-message-1' })
        expect(prompts).toEqual([['canonical-parent', {
            sessionId: subagentSessionId, text: 'continue please', delivery: 'steer', requestId: 'req-1'
        }]])
    })

    it('coalesces a retry with the same request id instead of accepting it twice', async () => {
        const { prompt, prompts } = fixture()
        const first = await prompt({ text: 'once only', requestId: 'retry-safe' })
        const second = await prompt({ text: 'once only', requestId: 'retry-safe' })
        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(await second.json()).toEqual({ messageId: 'child-message-1' })
        expect(prompts).toHaveLength(1)
    })

    it('rejects a reused request id with different content', async () => {
        const { prompt, prompts } = fixture()
        expect((await prompt({ text: 'first', requestId: 'retry-conflict' })).status).toBe(200)
        expect((await prompt({ text: 'second', requestId: 'retry-conflict' })).status).toBe(409)
        expect(prompts).toHaveLength(1)
    })

    it('defaults delivery to queue and lets the path own the child session id', async () => {
        const { prompt, prompts } = fixture()
        const response = await prompt({ text: 'more', requestId: 'req-2', sessionId: 'ignored-child' })
        expect(response.status).toBe(200)
        expect(prompts).toEqual([['canonical-parent', {
            sessionId: subagentSessionId, text: 'more', delivery: 'queue', requestId: 'req-2'
        }]])
    })

    it('rejects prompts when the parent session is inactive', async () => {
        const { prompt, prompts } = fixture({ sessionActive: false })
        const response = await prompt({ text: 'more', requestId: 'req-3' })
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'Session is inactive', code: 'session_inactive' })
        expect(prompts).toEqual([])
    })

    it('rejects offline machines and invalid prompt bodies before invoking the input channel', async () => {
        const offline = fixture({ machineActive: false })
        expect((await offline.prompt({ text: 'more', requestId: 'req-4' })).status).toBe(503)
        expect(offline.prompts).toEqual([])

        const { prompt, prompts } = fixture()
        for (const body of [{ requestId: 'req-5' }, { text: 'more' }, { text: '', requestId: 'req-6' },
            { text: 'more', delivery: 'later', requestId: 'req-7' }, null]) {
            expect((await prompt(body)).status).toBe(400)
        }
        expect(prompts).toEqual([])
    })

    it('stops the child through the same authorized parent channel', async () => {
        const { interrupt, interrupts } = fixture()
        const response = await interrupt()
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ accepted: true })
        expect(interrupts).toEqual([['canonical-parent', { sessionId: subagentSessionId }]])
    })

    it('surfaces input channel failures as 409 instead of a hollow success', async () => {
        const { prompt, interrupt } = fixture({ error: 'Child is no longer running' })
        const promptResponse = await prompt({ text: 'more', requestId: 'req-8' })
        expect(promptResponse.status).toBe(409)
        expect(await promptResponse.json()).toEqual({ error: 'Child is no longer running' })
        const interruptResponse = await interrupt()
        expect(interruptResponse.status).toBe(409)
        expect(await interruptResponse.json()).toEqual({ error: 'Child is no longer running' })
    })
})
