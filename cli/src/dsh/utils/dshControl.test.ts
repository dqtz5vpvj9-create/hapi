import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshControl } from './dshControl'
import { dshSandboxMode } from './dshBackend'

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const dispose of cleanup.reverse().splice(0)) await dispose(); vi.unstubAllEnvs() })

type Fixture = {
    withSessionTitle?: boolean
    title?: string | null
    children?: unknown[]
    teamMembers?: unknown[]
    timing?: unknown
    snapshot?: unknown
    parentAgent?: unknown
}

async function setup(options: Fixture = {}) {
    const root = await mkdtemp(join(tmpdir(), 'hapi-dsh-control-test-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const control = await createDshControl(root)
    cleanup.push(() => control.dispose())
    for (const [key, value] of Object.entries(control.env)) vi.stubEnv(key, value)
    vi.stubEnv('DSH_PERMISSION_MODE', 'workspace-write')
    const patch = JSON.parse(await readFile(control.patch, 'utf8'))
    const module = await import(/* @vite-ignore */ pathToFileURL(patch[1].insert[0].name).href)
    const handlers = new Map<string, (...args: any[]) => void>()
    let mode = 'read-only'
    const session = { append: vi.fn((_type, value) => { mode = value.mode }) }
    const credentials = { describe: vi.fn(async () => ({ configured: false })) }
    const sessionTitle = options.withSessionTitle === false
        ? undefined
        : { get: vi.fn(() => options.title === null ? undefined : { title: options.title ?? '调研JCST通知并准备材料' }) }
    const observations: Array<{ projections: { values: { subagentTiming: unknown } }; [Symbol.dispose]: () => void }> = []
    const subagents = {
        listChildren: vi.fn(async () => options.children ?? []),
        prompt: vi.fn(async () => ({ messageId: 'child-message-1' })),
        interruptByParent: vi.fn(() => ({ accepted: true }))
    }
    const sessionQuery = {
        observeSession: vi.fn(async () => {
            const observation = {
                projections: { values: { subagentTiming: options.timing } },
                [Symbol.dispose]: vi.fn()
            }
            observations.push(observation)
            return observation
        }),
        readSession: vi.fn(async () => options.snapshot ?? { session: {}, inheritedEventCount: 0, events: [] })
    }
    const agents = { get: vi.fn((id: string) => id === 'active' ? options.parentAgent : undefined) }
    const agentTeams = { listMembers: vi.fn(() => options.teamMembers ?? []) }
    const ctx = {
        on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
        get: (name: string) => (name === 'sessionTitle' ? sessionTitle
            : name === 'subagents' ? subagents
                : name === 'sessionQuery' ? sessionQuery
                    : name === 'agents' ? agents
                        : name === 'agentTeams' ? agentTeams : undefined),
        sessions: { get: (id: string) => id === 'active' ? session : undefined, flush: vi.fn(async () => {}) },
        sandboxPolicy: { resolve: () => ({ mode }) },
        llm: { listConfigurableProviders: () => [{ provider: 'custom-route', settingsNs: 'custom', settingsPath: ['routes', 0] }] },
        settings: { describe: () => [{ ns: 'custom', value: { routes: [{ apiKeyEnv: 'CUSTOM_DSH_KEY' }] } }] },
        credentials
    }
    module.apply(ctx)
    cleanup.push(() => handlers.get('dispose')?.())
    return { control, handlers, session, credentials, subagents, sessionQuery, observations, currentMode: () => mode }
}

function snapshotWithEvents(): unknown {
    return {
        session: { id: 'session-child', createdAt: 1_700_000_000_000 },
        inheritedEventCount: 0,
        events: [
            { type: 'user/message', seq: 0, time: 1000, data: { role: 'user', content: [{ type: 'text', text: 'review the diff' }], source: { kind: 'user' } } },
            {
                type: 'assistant/message', seq: 1, time: 2000,
                data: {
                    turn: 1, step: 1, message: {
                        role: 'assistant',
                        content: [
                            { type: 'reasoning', text: 'think first' },
                            { type: 'text', text: 'I will inspect it' },
                            { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"git diff"}' }
                        ]
                    }
                }
            },
            { type: 'tool/result', seq: 2, time: 3000, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'diff --git a/x' }] } } },
            { type: 'turn/end', seq: 3, time: 4000, data: { turn: 1, reason: 'completed' } },
            { type: 'assistant/message', seq: 4, time: 5000, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } }
        ]
    }
}

describe('HAPI DSH session adapter', () => {
    it('maps permissions explicitly', () => {
        expect(dshSandboxMode('yolo')).toBe('danger-full-access')
        expect(dshSandboxMode('default')).toBe('workspace-write')
        expect(dshSandboxMode('read-only')).toBe('read-only')
    })
    it('applies the startup mode only to the explicitly claimed root session', async () => {
        const { control, handlers, currentMode } = await setup()
        // No blanket session/created listener: DSH child sessions inherit their
        // parent's current mode instead of the process startup mode.
        expect(handlers.has('session/created')).toBe(false)
        expect(currentMode()).toBe('read-only')
        await control.claimRoot('active')
        expect(currentMode()).toBe('workspace-write')
        await expect(control.claimRoot('missing')).rejects.toThrow('not active')
    })
    it('replaces a persisted mode and acknowledges live changes only for the target session', async () => {
        const { control, currentMode } = await setup()
        await control.claimRoot('active')
        await control.setPermission('active', 'yolo')
        expect(currentMode()).toBe('danger-full-access')
        await control.setPermission('active', 'read-only')
        expect(currentMode()).toBe('read-only')
        await expect(control.setPermission('other', 'yolo')).rejects.toThrow('not active')
        expect(currentMode()).toBe('read-only')
    })
    it('checks the configured route reference through the credential service', async () => {
        const { control, credentials } = await setup()
        await expect(control.preflight('["custom-route","model"]')).rejects.toThrow('no API key for provider route "custom-route"')
        expect(credentials.describe).toHaveBeenCalledWith('CUSTOM_DSH_KEY')
        credentials.describe.mockResolvedValue({ configured: true })
        await expect(control.preflight('["custom-route","model"]')).resolves.toBeUndefined()
    })
    it('reads the durable runtime title for the active session', async () => {
        const { control } = await setup()
        await expect(control.getTitle('active')).resolves.toBe('调研JCST通知并准备材料')
    })
    it('reports no title when the profile does not mount the session-title service', async () => {
        const { control } = await setup({ withSessionTitle: false })
        await expect(control.getTitle('active')).resolves.toBeNull()
    })
    it('reports no title before the runtime has produced a snapshot', async () => {
        const { control } = await setup({ title: null })
        // A snapshot only exists after the first eligible human message; the
        // plugin must still answer with JSON instead of failing the request.
        await expect(control.getTitle('active')).resolves.toBeNull()
    })
    it('rejects a title request for an inactive session', async () => {
        const { control } = await setup()
        await expect(control.getTitle('missing')).rejects.toThrow('not active')
    })
    it('merges the durable catalog with live turn timing and team roster identity', async () => {
        const parentAgent = { id: 'active' }
        const { control, observations, subagents } = await setup({
            parentAgent,
            children: [{ id: 'child-1', mode: 'continuable', label: 'review', createdAt: 10 }],
            teamMembers: [{ id: 'child-1', name: 'Ada', provider: 'spawn', status: 'running' }],
            timing: { settledMs: 1200, active: { since: 5000 }, lastTurnCompleted: true }
        })
        await expect(control.subagents('active')).resolves.toEqual([{
            sessionId: 'child-1',
            mode: 'continuable',
            label: 'review',
            name: 'Ada',
            provider: 'spawn',
            teamStatus: 'running',
            createdAt: 10,
            activity: 'running',
            settledMs: 1200,
            openSince: 5000,
            lastTurnCompleted: true
        }])
        expect(subagents.listChildren).toHaveBeenCalledWith('active')
        // The observation lease is released even when the row is returned.
        expect(observations).toHaveLength(1)
    })
    it('keeps catalog rows readable when a child cannot be observed', async () => {
        const { control, sessionQuery } = await setup({
            children: [{ id: 'child-2', mode: 'external', label: 'codex', createdAt: 20 }]
        })
        sessionQuery.observeSession.mockRejectedValueOnce(new Error('gone'))
        await expect(control.subagents('active')).resolves.toMatchObject([{
            sessionId: 'child-2', mode: 'external', label: 'codex', createdAt: 20, activity: 'inactive'
        }])
    })
    it('maps the child log onto transcript rows and pages by stable message cursors', async () => {
        const { control } = await setup({ snapshot: snapshotWithEvents() })
        const tail = await control.transcript('session-child', { limit: 3 })
        expect(tail.messages.map(message => [message.role, message.kind, message.text])).toEqual([
            ['tool', 'tool-call', 'bash\n{"command":"git diff"}'],
            ['tool', 'tool-result', 'diff --git a/x'],
            ['assistant', 'message', 'done']
        ])
        expect(tail.messages[0]?.id).toBe('session-child:3')
        expect(tail.hasMore).toBe(true)
        expect(tail.before).toBe(3)

        const older = await control.transcript('session-child', { limit: 10, before: tail.before! })
        expect(older.messages.map(message => message.text)).toEqual(['review the diff', 'think first', 'I will inspect it'])
        expect(older.before).toBeNull()

        const forward = await control.transcript('session-child', { limit: 2, after: 0, epoch: tail.epoch })
        expect(forward.messages.map(message => message.text)).toEqual(['review the diff', 'think first'])
        expect(forward.after).toBe(2)
        expect(forward.hasLater).toBe(true)
        const next = await control.transcript('session-child', { limit: 2, after: forward.after, epoch: forward.epoch })
        expect(next.messages.map(message => message.text)).toEqual(['I will inspect it', 'bash\n{"command":"git diff"}'])
    })
    it('reports reset when the transcript epoch changes', async () => {
        const { control } = await setup({ snapshot: snapshotWithEvents() })
        const page = await control.transcript('session-child', { after: 1, epoch: 'another-log' })
        expect(page.reset).toBe(true)
        expect(page.messages[0]?.text).toBe('review the diff')
    })
    it('proxies continuable prompts and interrupts through the subagent service', async () => {
        const parentAgent = { id: 'active' }
        const { control, subagents } = await setup({ parentAgent })
        await expect(control.prompt('active', 'child-1', 'please continue', { delivery: 'steer', requestId: 'request-1' }))
            .resolves.toEqual({ messageId: 'child-message-1' })
        expect(subagents.prompt).toHaveBeenCalledWith({
            requestId: 'request-1',
            parentSessionId: 'active',
            childSessionId: 'child-1',
            mode: 'continuable',
            delivery: 'steer',
            content: [{ type: 'text', text: 'please continue' }]
        }, expect.any(AbortSignal))
        await expect(control.interrupt('active', 'child-1')).resolves.toEqual({ accepted: true })
        expect(subagents.interruptByParent).toHaveBeenCalledWith('child-1', 'active', 'continuable')
    })
    it('fails closed when the control plugin lacks the subagent services', async () => {
        const root = await mkdtemp(join(tmpdir(), 'hapi-dsh-control-test-'))
        cleanup.push(() => rm(root, { recursive: true, force: true }))
        const control = await createDshControl(root)
        cleanup.push(() => control.dispose())
        for (const [key, value] of Object.entries(control.env)) vi.stubEnv(key, value)
        const patch = JSON.parse(await readFile(control.patch, 'utf8'))
        const module = await import(/* @vite-ignore */ pathToFileURL(patch[1].insert[0].name).href)
        module.apply({ on: () => {}, get: () => undefined, sessions: { get: () => undefined, flush: async () => {} }, sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } })
        await expect(control.subagents('active')).rejects.toThrow('does not mount the subagent service')
    })
})
