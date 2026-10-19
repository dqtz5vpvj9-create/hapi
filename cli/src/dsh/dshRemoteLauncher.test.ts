import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { DshMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    modern: false,
    initialize: null as (() => Promise<void>) | null,
    resumeError: null as Error | null,
    prompt: null as (() => Promise<void>) | null,
    wait: null as (() => Promise<void>) | null,
    close: null as (() => Promise<void>) | null,
    events: [] as string[]
}))

vi.mock('./utils/dshBackend', () => ({
    createDshBackend: vi.fn(() => {
        const backend = {
            initialize: vi.fn(async () => { await harness.initialize?.() }),
            supportsResumeSession: vi.fn(() => harness.modern),
            supportsCloseSession: vi.fn(() => harness.modern),
            supportsHttpMcp: vi.fn(() => harness.modern),
            newSession: vi.fn(async () => 'dsh-session-1'),
            resumeSession: vi.fn(async (config: { sessionId: string }) => {
                if (harness.resumeError) throw harness.resumeError
                return config.sessionId
            }),
            closeSession: vi.fn(async () => { harness.events.push('close'); await harness.close?.() }),
            getSessionConfigOptions: vi.fn(() => []),
            getConfigOptionByCategory: vi.fn(() => undefined),
            setSessionConfigOptionsListener: vi.fn(),
            prompt: vi.fn(async (_sessionId: string, _content: unknown[], onUpdate: (message: unknown) => void) => {
                await harness.prompt?.()
                onUpdate({ type: 'text', text: 'answer' })
            }),
            waitForResponseComplete: vi.fn(async () => { await harness.wait?.() }),
            cancelPrompt: vi.fn(async () => { harness.events.push('cancel') }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => { harness.events.push('disconnect') })
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('@/codex/utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: vi.fn(async () => ({
        server: { url: 'http://127.0.0.1/hapi', stop: () => { harness.events.push('mcp-stop') } },
        mcpServers: {}
    }))
}))
vi.mock('@/modules/common/permission/AcpPermissionHandler', () => ({
    AcpPermissionHandler: class {
        async cancelAll(): Promise<void> {}
    }
}))
vi.mock('@/ui/ink/RemoteModeDisplay', () => ({ RemoteModeDisplay: () => null }))
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }))

import { DshRemoteLauncher } from './dshRemoteLauncher'

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
}

function createSession(open = false) {
    const queue = new MessageQueue2<DshMode>((mode) => JSON.stringify(mode))
    if (!open) {
        queue.push('first', 'dsh')
        queue.close()
    }
    const handlers = new Map<string, (request?: unknown) => Promise<unknown>>()
    const session = {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: { rpcHandlerManager: { registerHandler: vi.fn((name: string, handler: (request?: unknown) => Promise<unknown>) => { handlers.set(name, handler) }) } },
        queue,
        sessionId: null as string | null,
        publishSessionId: vi.fn((id: string, _resumable: boolean) => { session.sessionId = id }),
        publishConfigOptions: vi.fn(),
        onThinkingChange: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        handlers
    }
    return session
}

describe('DshRemoteLauncher', () => {
    afterEach(() => {
        harness.backend = null
        harness.modern = false
        harness.initialize = null
        harness.resumeError = null
        harness.prompt = null
        harness.wait = null
        harness.close = null
        harness.events = []
    })

    it('keeps older ACP servers usable without publishing a resume token or injecting MCP', async () => {
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)
        await launcher.launch()
        expect(harness.backend?.newSession).toHaveBeenCalledWith({ cwd: '/tmp/dsh-test', mcpServers: [] })
        expect(harness.backend?.prompt).toHaveBeenCalledWith('dsh-session-1', [{ type: 'text', text: 'first' }], expect.any(Function))
        expect(session.publishSessionId).toHaveBeenCalledWith('dsh-session-1', false)
        expect(session.sendAgentMessage).toHaveBeenCalledWith({ type: 'message', message: 'answer' })
        expect(session.sendSessionEvent).toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.events).toEqual(['cancel', 'disconnect'])
    })

    it('resumes an advertised persisted root, mounts HTTP MCP, and closes before stopping transport and bridge', async () => {
        harness.modern = true
        const session = createSession()
        session.sessionId = 'persisted-root'
        const launcher = new DshRemoteLauncher(session as never)
        await launcher.launch()
        await launcher.kill()
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(harness.backend?.resumeSession).toHaveBeenCalledWith({
            sessionId: 'persisted-root', cwd: '/tmp/dsh-test',
            mcpServers: [{ type: 'http', name: 'hapi', url: 'http://127.0.0.1/hapi', headers: [] }]
        })
        expect(session.publishSessionId).toHaveBeenCalledWith('persisted-root', true)
        expect(harness.events).toEqual(['close', 'disconnect', 'mcp-stop'])
    })

    it('does not silently replace a missing or unsupported persisted session', async () => {
        const session = createSession()
        session.sessionId = 'persisted-root'
        await expect(new DshRemoteLauncher(session as never).launch()).rejects.toThrow('does not advertise')
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        harness.modern = true
        harness.resumeError = new Error('Unknown persisted session')
        await expect(new DshRemoteLauncher(session as never).launch()).rejects.toThrow('Unknown persisted')
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(session.publishSessionId).not.toHaveBeenCalled()
        expect(harness.events.slice(-2)).toEqual(['disconnect', 'mcp-stop'])
    })

    it('waits for cancellation before reporting ready or admitting the next turn', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        const abort = session.handlers.get(RPC_METHODS.Abort)!()
        const duplicateAbort = session.handlers.get(RPC_METHODS.Abort)!()
        session.queue.push('second', 'dsh')
        await vi.waitFor(() => expect(harness.backend?.cancelPrompt).toHaveBeenCalledOnce())
        expect(session.onThinkingChange).not.toHaveBeenCalledWith(false)
        expect(session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' })
        expect(harness.backend?.prompt).toHaveBeenCalledOnce()
        current.resolve()
        await Promise.all([abort, duplicateAbort])
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledTimes(2))
        session.queue.close()
        await run
        expect(harness.backend?.prompt.mock.calls[1]?.[1]).toEqual([{ type: 'text', text: 'second' }])
        expect(harness.backend?.closeSession).toHaveBeenCalledOnce()
    })

    it('an idle abort wakes the old queue read without ending the session', async () => {
        const session = createSession(true)
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(session.handlers.has(RPC_METHODS.Abort)).toBe(true))
        await session.handlers.get(RPC_METHODS.Abort)!()
        session.queue.push('after abort', 'dsh')
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        session.queue.close()
        await run
        expect(harness.backend?.prompt.mock.calls[0]?.[1]).toEqual([{ type: 'text', text: 'after abort' }])
    })

    it('kill shares shutdown, waits for active prompt close, and wakes an idle queue', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.close = async () => { current.resolve() }
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        await Promise.all([launcher.kill(), launcher.kill(), run])
        expect(harness.events).toEqual(['close', 'disconnect', 'mcp-stop'])
        expect(session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' })
    })

    it('kill during activation waits for cleanup without starting a new session', async () => {
        const activation = deferred()
        harness.initialize = () => activation.promise
        const session = createSession(true)
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        const kill = launcher.kill()
        expect(harness.backend?.disconnect).not.toHaveBeenCalled()
        activation.resolve()
        await Promise.all([run, kill])
        expect(harness.backend?.newSession).not.toHaveBeenCalled()
        expect(harness.backend?.disconnect).toHaveBeenCalledOnce()
    })

    it('closes an unresponsive cancellation without accepting a second prompt', async () => {
        harness.modern = true
        const current = deferred()
        const never = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => never.promise
        harness.close = async () => { current.resolve() }
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch().catch(error => error)
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        vi.useFakeTimers()
        try {
            const abort = session.handlers.get(RPC_METHODS.Abort)!().catch(error => error)
            session.queue.push('second', 'dsh')
            await vi.advanceTimersByTimeAsync(10_001)
            expect(await abort).toBeInstanceOf(Error)
            await run
            expect(harness.backend?.prompt).toHaveBeenCalledOnce()
            expect(harness.events).toEqual(['cancel', 'close', 'disconnect', 'mcp-stop'])
            expect(session.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' })
        } finally { vi.useRealTimers() }
    })
})
