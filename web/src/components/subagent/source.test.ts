import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { CodexSubagentMessagesResponse, DshSubagentMessagesResponse, SubagentMessage } from '@hapi/protocol/apiTypes'
import { createSubagentSource } from './source'
import type { NativeSubagentRef } from './types'

const message = (id: string): SubagentMessage => ({ id, role: 'assistant', kind: 'message', text: id, createdAt: 1 })

const codexPage = (overrides: Partial<CodexSubagentMessagesResponse> = {}): CodexSubagentMessagesResponse => ({
    threadId: 'thread-child', messages: [message('thread-child:10')], before: null, hasMore: false, after: 10, epoch: 'epoch-1', ...overrides,
})
const dshPage = (overrides: Partial<DshSubagentMessagesResponse> = {}): DshSubagentMessagesResponse => ({
    sessionId: 'session-child', messages: [message('session-child:3')], before: null, hasMore: false, after: 3, epoch: 'epoch-1', ...overrides,
})

const codexRef: NativeSubagentRef = {
    parentSessionId: 'parent', sessionId: 'thread-child', flavor: 'codex', label: 'Codex child',
}
function dshRef(mode: NativeSubagentRef['mode']): NativeSubagentRef {
    return { parentSessionId: 'parent', sessionId: 'session-child', flavor: 'dsh', label: 'Teammate', mode, activity: 'running' }
}

function makeApi() {
    const getCodexSubagentMessages = vi.fn<(...args: Parameters<ApiClient['getCodexSubagentMessages']>) => Promise<CodexSubagentMessagesResponse>>()
    const getDshSubagentMessages = vi.fn<(...args: Parameters<ApiClient['getDshSubagentMessages']>) => Promise<DshSubagentMessagesResponse>>()
    const promptDshSubagent = vi.fn<(...args: Parameters<ApiClient['promptDshSubagent']>) => Promise<unknown>>()
    const interruptDshSubagent = vi.fn<(...args: Parameters<ApiClient['interruptDshSubagent']>) => Promise<unknown>>()
    let auth: string | null = 'auth'
    const api = {
        getCodexSubagentMessages,
        getDshSubagentMessages,
        promptDshSubagent,
        interruptDshSubagent,
        getAuthToken: () => auth,
    } as unknown as ApiClient
    return {
        api,
        getCodexSubagentMessages,
        getDshSubagentMessages,
        promptDshSubagent,
        interruptDshSubagent,
        changeAuth: () => { auth = 'another-account' },
    }
}

describe('native subagent source', () => {
    it('reads a Codex child through its message endpoint and unifies threadId into sessionId', async () => {
        const { api, getCodexSubagentMessages } = makeApi()
        getCodexSubagentMessages.mockResolvedValue(codexPage())
        const source = createSubagentSource(api, codexRef, 'auth')
        const page = await source.read({ limit: 80, before: 20, epoch: 'epoch-1' })
        expect(getCodexSubagentMessages).toHaveBeenCalledWith('parent', 'thread-child', { limit: 80, before: 20, epoch: 'epoch-1' })
        expect(page).toMatchObject({ sessionId: 'thread-child', before: null, hasMore: false, after: 10, epoch: 'epoch-1' })
        expect(source.prompt).toBeUndefined()
        expect(source.interrupt).toBeUndefined()
    })

    it('rejects a Codex response that belongs to another child', async () => {
        const { api, getCodexSubagentMessages } = makeApi()
        getCodexSubagentMessages.mockResolvedValue(codexPage({ threadId: 'other-thread' }))
        const source = createSubagentSource(api, codexRef, 'auth')
        await expect(source.read()).rejects.toThrow('another subagent')
    })

    it('reads a DSH child through its message endpoint and keeps the DSH session id', async () => {
        const { api, getDshSubagentMessages } = makeApi()
        getDshSubagentMessages.mockResolvedValue(dshPage())
        const source = createSubagentSource(api, dshRef('one-shot'), 'auth')
        const page = await source.read({ limit: 40, after: 2, epoch: 'epoch-1' })
        expect(getDshSubagentMessages).toHaveBeenCalledWith('parent', 'session-child', { limit: 40, after: 2, epoch: 'epoch-1' })
        expect(page).toMatchObject({ sessionId: 'session-child', after: 3, epoch: 'epoch-1' })
    })

    it('rejects a DSH response that belongs to another child', async () => {
        const { api, getDshSubagentMessages } = makeApi()
        getDshSubagentMessages.mockResolvedValue(dshPage({ sessionId: 'other-session' }))
        const source = createSubagentSource(api, dshRef('one-shot'), 'auth')
        await expect(source.read()).rejects.toThrow('another subagent')
    })

    it('only exposes prompt and interrupt for continuable DSH children', async () => {
        const { api } = makeApi()
        for (const mode of ['one-shot', 'external', 'unknown'] as const) {
            const source = createSubagentSource(api, dshRef(mode), 'auth')
            expect(source.prompt).toBeUndefined()
            expect(source.interrupt).toBeUndefined()
        }
        const continuable = createSubagentSource(api, dshRef('continuable'), 'auth')
        expect(continuable.prompt).toBeTypeOf('function')
        expect(continuable.interrupt).toBeTypeOf('function')
    })

    it('forwards prompts with a minted request id and interrupts through the parent channel', async () => {
        const { api, promptDshSubagent, interruptDshSubagent } = makeApi()
        promptDshSubagent.mockResolvedValue({ messageId: 'session-child:9' })
        interruptDshSubagent.mockResolvedValue({ accepted: true })
        const source = createSubagentSource(api, dshRef('continuable'), 'auth')
        await source.prompt!('hello teammate', 'steer')
        expect(promptDshSubagent).toHaveBeenCalledWith('parent', 'session-child', {
            text: 'hello teammate', delivery: 'steer', requestId: expect.any(String),
        })
        const request = promptDshSubagent.mock.calls[0][2]
        expect(request.requestId.length).toBeGreaterThan(8)
        await source.interrupt!()
        expect(interruptDshSubagent).toHaveBeenCalledWith('parent', 'session-child')
    })

    it('reports when the creating API identity is no longer current', () => {
        const { api, changeAuth } = makeApi()
        const source = createSubagentSource(api, codexRef, 'auth')
        expect(source.isCurrent!()).toBe(true)
        changeAuth()
        expect(source.isCurrent!()).toBe(false)
    })
})
