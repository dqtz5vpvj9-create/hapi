import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { ACP_INDETERMINATE_SYMBOL } from '@/agent/backends/acp/AcpStdioTransport'
import type { DshMode } from './types'

const harness = vi.hoisted(() => ({
    backend: null as Record<string, ReturnType<typeof vi.fn>> | null,
    modern: false,
    official: false,
    initialize: null as (() => Promise<void>) | null,
    resumeError: null as Error | null,
    prompt: null as (() => Promise<void>) | null,
    wait: null as (() => Promise<void>) | null,
    close: null as (() => Promise<void>) | null,
    getTitle: vi.fn(async (_sessionId: string): Promise<string | null> => null),
    subagents: vi.fn(async (_sessionId: string): Promise<unknown[]> => []),
    transcript: vi.fn(async (_sessionId: string, _options: unknown) => ({
        sessionId: 'child-1', epoch: 'session-child:1', messages: [], before: null, hasMore: false,
        after: 0, hasLater: false, reset: false, truncated: false
    })),
    promptChild: vi.fn(async () => ({ messageId: 'child-message-1' })),
    interruptChild: vi.fn(async () => ({ accepted: true })),
    externalRecord: vi.fn(async (_root: string, childSessionId: string) => ({
        sessionId: childSessionId, epoch: 'external:root', messages: [
            { id: `${childSessionId}:0`, seq: 0, role: 'user', kind: 'message', text: 'delegated task', createdAt: 1 },
            { id: `${childSessionId}:1`, seq: 1, role: 'assistant', kind: 'message', text: 'delegated result', createdAt: 2 }
        ], before: null, hasMore: false, after: 2, hasLater: false, reset: false, truncated: false
    })),
    sessionInfoUpdateListener: null as ((update: { sessionId: string | null; title: string | null }) => void) | null,
    events: [] as string[]
}))

vi.mock('./utils/dshBackend', () => ({
    resolveDshAcpCommand: () => ({ command: 'custom-acp', args: [] }),
    isOfficialDshAcpCommand: () => harness.official,
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
            setSessionInfoUpdateListener: vi.fn((listener: ((update: { sessionId: string | null; title: string | null }) => void) | null) => {
                harness.sessionInfoUpdateListener = listener
            }),
            refreshSessionInfo: vi.fn(async () => {}),
            prompt: vi.fn(async (_sessionId: string, _content: unknown[], onUpdate: (message: unknown) => void) => {
                await harness.prompt?.()
                onUpdate({ type: 'text', text: 'answer' })
            }),
            waitForResponseComplete: vi.fn(async () => { await harness.wait?.() }),
            cancelPrompt: vi.fn(async () => { harness.events.push('cancel') }),
            followup: vi.fn(async () => {
                harness.events.push('followup')
                return { messageId: 'message-1' }
            }),
            onStderrError: vi.fn(),
            onPermissionRequest: vi.fn(),
            disconnect: vi.fn(async () => { harness.events.push('disconnect') })
        }
        harness.backend = backend
        return backend
    })
}))

vi.mock('./utils/dshControl', () => ({
    createDshControl: vi.fn(async () => ({
        patch: '/tmp/hapi-dsh-control.yaml',
        env: {},
            claimRoot: vi.fn(async () => {}),
        getTitle: harness.getTitle,
        setPermission: vi.fn(async () => {}),
        preflight: vi.fn(async () => {}),
        subagents: harness.subagents,
        transcript: harness.transcript,
        externalRecord: harness.externalRecord,
        prompt: harness.promptChild,
        interrupt: harness.interruptChild,
        dispose: vi.fn(async () => {})
    }))
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
    let metadata: Record<string, any> = {}
    const session = {
        path: '/tmp/dsh-test',
        logPath: '/tmp/dsh-test/hapi.log',
        client: {
            rpcHandlerManager: { registerHandler: vi.fn((name: string, handler: (request?: unknown) => Promise<unknown>) => { handlers.set(name, handler) }) },
            getMetadata: vi.fn(() => metadata),
            updateMetadata: vi.fn((handler: (current: Record<string, any>) => Record<string, any>) => {
                metadata = handler(metadata)
            }),
            setSteerDeliveryState: vi.fn(async () => true),
            emitSteerIndeterminate: vi.fn(),
            emitMessagesConsumedWithAck: vi.fn(async () => true)
        },
        queue,
        sessionId: null as string | null,
        getPermissionMode: () => 'default',
        getModel: () => undefined,
        publishSessionId: vi.fn((id: string, _resumable: boolean) => { session.sessionId = id }),
        publishConfigOptions: vi.fn(),
        thinking: false,
        onThinkingChange: vi.fn((value: boolean) => { session.thinking = value }),
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
        harness.official = false
        harness.initialize = null
        harness.resumeError = null
        harness.prompt = null
        harness.wait = null
        harness.close = null
        harness.getTitle.mockReset()
        harness.getTitle.mockResolvedValue(null)
        harness.subagents.mockReset()
        harness.subagents.mockResolvedValue([])
        harness.transcript.mockReset()
        harness.transcript.mockResolvedValue({
            sessionId: 'child-1', epoch: 'session-child:1', messages: [], before: null, hasMore: false,
            after: 0, hasLater: false, reset: false, truncated: false
        })
        harness.promptChild.mockReset()
        harness.promptChild.mockResolvedValue({ messageId: 'child-message-1' })
        harness.interruptChild.mockReset()
        harness.interruptChild.mockResolvedValue({ accepted: true })
        harness.externalRecord.mockReset()
        harness.sessionInfoUpdateListener = null
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

    it('publishes the DSH runtime title into metadata after activating a resumed session', async () => {
        harness.modern = true
        harness.official = true
        harness.getTitle.mockResolvedValue('调研JCST通知并准备材料')
        const session = createSession()
        session.sessionId = 'persisted-root'
        const launcher = new DshRemoteLauncher(session as never)
        await launcher.launch()
        expect(session.client.getMetadata()?.summary?.text).toBe('调研JCST通知并准备材料')
        expect(harness.getTitle).toHaveBeenCalledWith('persisted-root')
        // The official bridge never carries a title in session/list, so HAPI must
        // not sweep every stored session through the generic ACP path.
        expect(harness.backend?.setSessionInfoUpdateListener).not.toHaveBeenCalled()
        expect(harness.backend?.refreshSessionInfo).not.toHaveBeenCalled()
    })

    it('refreshes the title after a turn so a later provider-generated title wins', async () => {
        harness.modern = true
        harness.official = true
        let title = '调研JCST通知'
        harness.getTitle.mockImplementation(async () => title)
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(session.client.getMetadata()?.summary?.text).toBe('调研JCST通知'))
        // The title provider only refines the fallback after the turn settles,
        // which is what the delayed retries are for.
        setTimeout(() => { title = '调研JCST通知并准备材料' }, 500)
        current.resolve()
        await vi.waitFor(
            () => expect(session.client.getMetadata()?.summary?.text).toBe('调研JCST通知并准备材料'),
            { timeout: 3000 }
        )
        session.queue.close()
        await run
    })

    it('syncs the runtime title even when the turn fails', async () => {
        harness.modern = true
        harness.official = true
        // The title only appears once the human message lands, i.e. after
        // activation: this proves the failure path refreshes it rather than an
        // earlier activation probe.
        let title: string | null = null
        harness.getTitle.mockImplementation(async () => title)
        harness.prompt = async () => {
            title = 'Pixel 4a 全核心实验对比结果'
            throw new Error('provider route has no API key')
        }
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(session.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })))
        // Must land before the 1s activation retry would have probed anyway.
        await vi.waitFor(
            () => expect(session.client.getMetadata()?.summary?.text).toBe('Pixel 4a 全核心实验对比结果'),
            { timeout: 500, interval: 25 }
        )
        session.queue.close()
        await run
    })

    it('falls back to ACP session info updates for custom ACP servers', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        expect(harness.backend?.setSessionInfoUpdateListener).toHaveBeenCalledOnce()
        current.resolve()
        await vi.waitFor(() => expect(harness.backend?.refreshSessionInfo).toHaveBeenCalledWith('dsh-session-1', '/tmp/dsh-test'))
        harness.sessionInfoUpdateListener?.({ sessionId: 'dsh-session-1', title: 'Pixel 4a 全核心实验对比结果' })
        expect(session.client.getMetadata()?.summary?.text).toBe('Pixel 4a 全核心实验对比结果')
        expect(harness.getTitle).not.toHaveBeenCalled()
        session.queue.close()
        await run
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

    it('steers a queued message into the running turn through session/followup', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        session.queue.push('steer me', 'dsh', 'local-steer')

        const result = await session.handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'local-steer' })

        expect(result).toEqual({ steered: true })
        expect(harness.backend?.followup).toHaveBeenCalledWith('dsh-session-1', [{ type: 'text', text: 'steer me' }])
        expect(session.client.setSteerDeliveryState).toHaveBeenCalledWith(['local-steer'], 'dispatching')
        expect(session.client.emitMessagesConsumedWithAck).toHaveBeenCalledWith(['local-steer'], { steered: true })
        expect(session.queue.size()).toBe(0)
        current.resolve()
        session.queue.close()
        await run
    })

    it('restores the queued message when the agent rejects the steer', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        session.queue.push('steer me', 'dsh', 'local-steer')
        harness.backend!.followup = vi.fn(async () => { throw new Error('no prompt is in flight to steer') })

        const result = await session.handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'local-steer' })

        expect(result).toEqual({ steered: false, error: 'no prompt is in flight to steer' })
        expect(session.queue.size()).toBe(1)
        expect(session.client.setSteerDeliveryState).toHaveBeenLastCalledWith(['local-steer'], 'queued')
        current.resolve()
        session.queue.close()
        await run
    })

    it('holds an accepted but unacknowledged steer instead of leaving it dispatching', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        session.queue.push('steer me', 'dsh', 'local-steer')
        session.client.emitMessagesConsumedWithAck.mockResolvedValue(false)

        const result = await session.handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'local-steer' })

        expect(result).toEqual({ steered: false, error: 'Steer was accepted but could not be acknowledged' })
        expect(session.client.emitSteerIndeterminate).toHaveBeenCalledWith(['local-steer'])
        expect(session.queue.size()).toBe(0)
        current.resolve()
        session.queue.close()
        await run
    })

    it('holds an indeterminate steer instead of replaying it into the next turn', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        session.queue.push('steer me', 'dsh', 'local-steer')
        const timeout = new Error('session/followup timed out')
        Object.defineProperty(timeout, ACP_INDETERMINATE_SYMBOL, { value: true })
        harness.backend!.followup = vi.fn(async () => { throw timeout })

        const result = await session.handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'local-steer' })

        expect(result).toEqual({ steered: false, error: 'Steer outcome is indeterminate' })
        // The row is held for an explicit retry, not put back into the queue.
        expect(session.queue.size()).toBe(0)
        expect(session.client.emitSteerIndeterminate).toHaveBeenCalledWith(['local-steer'])
        expect(session.client.emitMessagesConsumedWithAck).not.toHaveBeenCalled()
        current.resolve()
        session.queue.close()
        await run
    })

    it('publishes the DSH child catalog onto session metadata', async () => {
        harness.official = true
        harness.subagents.mockResolvedValue([
            { sessionId: 'child-1', mode: 'continuable', label: 'review', name: 'Ada', provider: 'spawn',
                teamStatus: 'running', createdAt: 10, activity: 'running', settledMs: 1200, openSince: 5000 },
            { sessionId: 'child-2', mode: 'external', label: 'codex', createdAt: 20, activity: 'inactive' }
        ])
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)
        await launcher.launch()
        await vi.waitFor(() => expect(session.client.getMetadata()?.dshSubagents).toHaveLength(2))
        expect(session.client.getMetadata()?.dshCapabilities?.subagents).toBe(true)
        expect(session.client.getMetadata()?.dshSubagents?.[0]).toMatchObject({
            sessionId: 'child-1', mode: 'continuable', name: 'Ada', activity: 'running', openSince: 5000
        })
        await launcher.kill()
    })

    it('registers subagent RPCs, forwards transcripts, and refuses foreign or read-only children', async () => {
        harness.official = true
        harness.subagents.mockResolvedValue([
            { sessionId: 'child-1', mode: 'continuable', createdAt: 10, activity: 'inactive' },
            { sessionId: 'child-2', mode: 'one-shot', createdAt: 20, activity: 'inactive' },
            { sessionId: 'child-3', mode: 'external', createdAt: 30, activity: 'inactive' }
        ])
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(session.client.getMetadata()?.dshSubagents).toHaveLength(3))

        const read = session.handlers.get(RPC_METHODS.ReadDshSubagentMessages)!
        await expect(read({ sessionId: 'child-1', limit: 5, before: 3 })).resolves.toMatchObject({ sessionId: 'child-1' })
        expect(harness.transcript).toHaveBeenCalledWith('child-1', expect.objectContaining({ limit: 5, before: 3 }))
        await expect(read({ sessionId: 'intruder' })).rejects.toThrow('not a direct child')
        // External children never read a local session; their record comes from
        // the parent-side delegation call and settlement message.
        harness.externalRecord.mockResolvedValueOnce({
            sessionId: 'child-3', epoch: 'external:root', messages: [
                { id: 'child-3:0', seq: 0, role: 'user', kind: 'message', text: 'delegated task', createdAt: 1 }
            ], before: null, hasMore: false, after: 1, hasLater: false, reset: false, truncated: false
        })
        await expect(read({ sessionId: 'child-3' })).resolves.toMatchObject({ sessionId: 'child-3', messages: [{ text: 'delegated task' }] })
        expect(harness.externalRecord).toHaveBeenCalledWith('dsh-session-1', 'child-3')

        const prompt = session.handlers.get(RPC_METHODS.PromptDshSubagent)!
        await expect(prompt({ sessionId: 'child-2', text: 'hi', delivery: 'queue', requestId: 'r1' })).rejects.toThrow('read-only')
        await expect(prompt({ sessionId: 'child-1', text: 'hi', delivery: 'queue', requestId: 'r1' }))
            .resolves.toEqual({ messageId: 'child-message-1' })
        expect(harness.promptChild).toHaveBeenCalledWith('dsh-session-1', 'child-1', 'hi', { delivery: 'queue', requestId: 'r1' })

        const interrupt = session.handlers.get(RPC_METHODS.InterruptDshSubagent)!
        await expect(interrupt({ sessionId: 'child-1' })).resolves.toEqual({ accepted: true })
        expect(harness.interruptChild).toHaveBeenCalledWith('dsh-session-1', 'child-1')
        session.queue.close()
        await run
    })

    it('clears a finished catalog instead of leaving stale subagent rows', async () => {
        harness.official = true
        harness.subagents.mockResolvedValue([{ sessionId: 'child-1', mode: 'continuable', createdAt: 10, activity: 'inactive' }])
        const session = createSession(true)
        session.queue.push('first', 'dsh')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(session.client.getMetadata()?.dshSubagents).toHaveLength(1))
        harness.subagents.mockResolvedValue([])
        await session.handlers.get(RPC_METHODS.InterruptDshSubagent)!({ sessionId: 'child-1' })
        await vi.waitFor(() => expect(session.client.getMetadata()?.dshSubagents).toBeUndefined())
        session.queue.close()
        await run
    })

    it('does not advertise or register DSH subagent control for custom ACP servers', async () => {
        harness.official = false
        const session = createSession()
        const launcher = new DshRemoteLauncher(session as never)
        await launcher.launch()
        expect(session.client.getMetadata()?.dshCapabilities?.subagents).toBe(false)
        expect(session.handlers.has(RPC_METHODS.ReadDshSubagentMessages)).toBe(false)
        expect(session.handlers.has(RPC_METHODS.PromptDshSubagent)).toBe(false)
    })

    it('treats a steer for a row already drained into the turn as satisfied', async () => {
        harness.modern = true
        const current = deferred()
        harness.prompt = () => current.promise
        harness.wait = () => current.promise
        const session = createSession(true)
        session.queue.push('first', 'dsh', 'local-first')
        const launcher = new DshRemoteLauncher(session as never)
        const run = launcher.launch()
        await vi.waitFor(() => expect(harness.backend?.prompt).toHaveBeenCalledOnce())

        const result = await session.handlers.get(RPC_METHODS.SteerQueuedMessage)!({ localId: 'local-first' })

        expect(result).toEqual({ steered: true })
        expect(harness.backend?.followup).not.toHaveBeenCalled()
        current.resolve()
        session.queue.close()
        await run
    })
})
