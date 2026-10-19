import { describe, expect, it, vi } from 'vitest'
import { AcpSdkBackend } from './AcpSdkBackend'

function fixture(capabilities: Record<string, unknown> = {}) {
    const backend = new AcpSdkBackend({ command: 'dsh-acp-demo', flavor: 'dsh', retrySessionActivation: false })
    const transport = {
        sendRequest: vi.fn(async (_method: string, _params: unknown, _options?: unknown): Promise<unknown> => ({})),
        close: vi.fn(async () => {})
    }
    const internal = backend as unknown as {
        transport: typeof transport
        initializeResult: unknown
        activeSessionId: string | null
        handleSessionUpdate(params: unknown): void
    }
    internal.transport = transport
    internal.initializeResult = { protocolVersion: 1, agentCapabilities: capabilities }
    return { backend, internal, transport }
}

const configOptions = [{
    id: 'model', name: 'Model', category: 'model', currentValue: '["deepseek","v4"]',
    options: [{ group: 'deepseek', name: 'DeepSeek', options: [{ value: '["deepseek","v4"]', name: 'V4' }] }]
}, {
    id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', currentValue: '',
    options: [{ value: '', name: 'Provider default' }, { value: 'high', name: 'High' }]
}]

describe('DSH ACP capabilities and configuration', () => {
    it('keeps resume/close/http separate from legacy load capabilities', () => {
        const { backend } = fixture({ sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true } })
        expect(backend.supportsResumeSession()).toBe(true)
        expect(backend.supportsCloseSession()).toBe(true)
        expect(backend.supportsHttpMcp()).toBe(true)
        expect(backend.supportsLoadSession()).toBe(false)
        const old = fixture({ loadSession: true }).backend
        expect(old.supportsResumeSession()).toBe(false)
        expect(old.supportsCloseSession()).toBe(false)
        expect(old.supportsHttpMcp()).toBe(false)
        expect(old.supportsLoadSession()).toBe(true)
    })

    it('resumes the exact persisted root using session/resume and captures grouped options', async () => {
        const { backend, transport } = fixture({ sessionCapabilities: { resume: {} } })
        transport.sendRequest.mockResolvedValue({ configOptions })
        const listener = vi.fn()
        backend.setSessionConfigOptionsListener(listener)
        const mcpServers = [{ type: 'http' as const, name: 'hapi', url: 'http://127.0.0.1/mcp', headers: [] }]
        await expect(backend.resumeSession({ sessionId: 'persisted-root', cwd: '/work', mcpServers })).resolves.toBe('persisted-root')
        expect(transport.sendRequest).toHaveBeenCalledExactlyOnceWith('session/resume', { sessionId: 'persisted-root', cwd: '/work', mcpServers })
        expect(backend.getConfigOptionByCategory('persisted-root', 'model')?.options).toEqual([{ value: '["deepseek","v4"]', name: 'DeepSeek / V4' }])
        expect(backend.getThoughtLevelConfigOption('persisted-root')?.options[0]).toEqual({ value: '', name: 'Provider default' })
        expect(backend.getSessionModelsMetadata('persisted-root')?.availableModels).toEqual([{ modelId: '["deepseek","v4"]', name: 'DeepSeek / V4' }])
        expect(listener).toHaveBeenCalledOnce()
    })

    it('does not retry indeterminate new or resume activation and never creates a replacement', async () => {
        const { backend, transport } = fixture({ sessionCapabilities: { resume: {} } })
        transport.sendRequest.mockRejectedValue(new Error('Request timed out'))
        await expect(backend.newSession({ cwd: '/work', mcpServers: [] })).rejects.toThrow('timed out')
        expect(transport.sendRequest).toHaveBeenCalledOnce()
        transport.sendRequest.mockClear()
        await expect(backend.resumeSession({ sessionId: 'persisted-root', cwd: '/work', mcpServers: [] })).rejects.toThrow('timed out')
        expect(transport.sendRequest).toHaveBeenCalledOnce()
        expect(transport.sendRequest.mock.calls[0]?.[0]).toBe('session/resume')
    })

    it('rejects unadvertised resume without an RPC', async () => {
        const { backend, transport } = fixture()
        await expect(backend.resumeSession({ sessionId: 'root', cwd: '/work', mcpServers: [] })).rejects.toThrow('does not advertise')
        expect(transport.sendRequest).not.toHaveBeenCalled()
    })

    it('applies asynchronous config updates only to the active session and clears removed options', async () => {
        const { backend, transport, internal } = fixture()
        transport.sendRequest.mockResolvedValue({ sessionId: 'active', configOptions })
        await backend.newSession({ cwd: '/work', mcpServers: [] })
        internal.handleSessionUpdate({ sessionId: 'foreign', update: { sessionUpdate: 'config_option_update', configOptions: [] } })
        expect(backend.getSessionConfigOptions('active')).toHaveLength(2)
        internal.handleSessionUpdate({ sessionId: 'active', update: { sessionUpdate: 'config_option_update', configOptions: [] } })
        expect(backend.getSessionConfigOptions('active')).toEqual([])
        expect(backend.getSessionConfigOptions('foreign')).toBeUndefined()
    })

    it('does not wait for a pinned DSH prompt when changing next-turn configuration', async () => {
        const { backend, transport } = fixture()
        const wait = vi.spyOn(backend, 'waitForResponseComplete').mockResolvedValue()
        await backend.setConfigOption('root', 'reasoning_effort', '', { waitForResponse: false })
        expect(wait).not.toHaveBeenCalled()
        expect(transport.sendRequest).toHaveBeenCalledWith('session/set_config_option', { sessionId: 'root', configId: 'reasoning_effort', value: '' })
        await backend.setConfigOption('root', 'reasoning_effort', 'high')
        expect(wait).toHaveBeenCalledOnce()
    })

    it('shares close completion, drains before disconnect, and clears stale configuration', async () => {
        const { backend, transport } = fixture({ sessionCapabilities: { close: {} } })
        transport.sendRequest.mockResolvedValue({ sessionId: 'root', configOptions })
        await backend.newSession({ cwd: '/work', mcpServers: [] })
        transport.sendRequest.mockClear()
        let finish!: () => void
        transport.sendRequest.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({}) }))
        const close = backend.closeSession('root')
        expect(backend.closeSession('root')).toBe(close)
        expect(transport.close).not.toHaveBeenCalled()
        expect(transport.sendRequest).toHaveBeenCalledExactlyOnceWith('session/close', { sessionId: 'root' }, { timeoutMs: 15_000 })
        finish()
        await close
        expect(backend.getSessionConfigOptions('root')).toBeUndefined()
        await backend.disconnect()
        expect(transport.close).toHaveBeenCalledOnce()
        expect(backend.supportsCloseSession()).toBe(false)
    })
})
