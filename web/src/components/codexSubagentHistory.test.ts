import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { CodexSubagentMessagesResponse } from '@hapi/protocol/apiTypes'
import { CodexSubagentHistory, type SubagentMessage } from './codexSubagentHistory'
import { projectSubagentTranscript } from './codexSubagentTranscript'

type Page = CodexSubagentMessagesResponse
const message = (offset: number, text = `message ${offset}`): SubagentMessage => ({ id: `child:${offset}`, createdAt: offset, role: 'assistant', kind: 'message', text })
const page = (messages: SubagentMessage[], overrides: Partial<Page> = {}): Page => ({ threadId: 'child', messages, before: null, hasMore: false, after: 100, epoch: 'epoch-1', hasLater: false, ...overrides })
function fixture() {
    let auth = 'auth'
    const request = vi.fn<(...args: Parameters<ApiClient['getCodexSubagentMessages']>) => Promise<Page>>()
    const api = { getCodexSubagentMessages: request, getAuthToken: () => auth } as unknown as ApiClient
    const history = new CodexSubagentHistory(api, 'parent', 'child', auth)
    history.setActive(true)
    return { history, request, changeAuth: () => { auth = 'another-account' } }
}
const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { resolve, promise }
}

describe('native child read window', () => {
    it('uses incremental byte cursors without replacing stable message objects on empty refreshes', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page([message(0)]))
        await history.refresh()
        const initial = history.get().page!.messages
        request.mockResolvedValueOnce(page([], { after: 120 }))
        await history.refresh()
        expect(request.mock.calls[1][2]).toMatchObject({ after: 100, epoch: 'epoch-1' })
        expect(history.get().page!.messages).toBe(initial)
        request.mockResolvedValueOnce(page([message(130)], { after: 200 }))
        await history.refresh()
        expect(history.get().page!.messages.map(row => row.text)).toEqual(['message 0', 'message 130'])
        expect(history.get().page!.messages[0]).toBe(initial[0])
    })
    it('pauses live updates while paging earlier and resumes from an authoritative latest window', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page([message(100), message(150)], { before: 100, hasMore: true, after: 200 }))
        await history.refresh()
        request.mockResolvedValueOnce(page([message(0), message(50)], { after: 100 }))
        await history.loadEarlier()
        expect(request.mock.calls[1][2]).toMatchObject({ before: 100, epoch: 'epoch-1' })
        expect(history.get().page!.messages.map(row => row.id)).toEqual(['child:0', 'child:50', 'child:100', 'child:150'])
        expect(history.get().following).toBe(false)
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(2)
        request.mockResolvedValueOnce(page([message(250)], { before: 250, hasMore: true, after: 300 }))
        await history.loadLatest()
        expect(request.mock.calls[2][2]).not.toHaveProperty('after')
        expect(request.mock.calls[2][2]).not.toHaveProperty('before')
        expect(history.get().page!.messages).toEqual([message(250)])
        expect(history.get().following).toBe(true)
    })
    it('advances through metadata-only earlier pages and stops at the actual beginning', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page([message(100)], { before: 100, hasMore: true }))
        await history.refresh()
        request.mockResolvedValueOnce(page([], { before: 50, hasMore: true }))
        await history.loadEarlier()
        expect(history.get().page).toMatchObject({ before: 50, hasMore: true })
        request.mockResolvedValueOnce(page([], { before: null, hasMore: false }))
        await history.loadEarlier()
        expect(request.mock.calls[2][2]).toMatchObject({ before: 50 })
        expect(history.get().page).toMatchObject({ before: null, hasMore: false })
        expect(history.get().page!.messages).toEqual([message(100)])
        await history.loadEarlier()
        expect(request).toHaveBeenCalledTimes(3)
    })
    it('does not invent an earlier page when a transcript begins with non-display records', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page([message(100)], { before: null, hasMore: false }))
        await history.refresh()
        expect(history.get().page).toMatchObject({ before: null, hasMore: false })
        await history.loadEarlier()
        expect(request).toHaveBeenCalledTimes(1)
    })
    it('retains the server cursor across non-display gaps when earlier paging trims the tail', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page(Array.from({ length: 80 }, (_, index) => message(1000 + index, 'x'.repeat(40_000))), { before: 1000, hasMore: true, after: 2000 }))
        await history.refresh()
        request.mockResolvedValueOnce(page(Array.from({ length: 80 }, (_, index) => message(100 + index, 'x'.repeat(40_000))), { before: 50, hasMore: true }))
        await history.loadEarlier()
        expect(history.get().page).toMatchObject({ before: 50, hasMore: true, after: 2000 })
        expect(history.get().page!.messages[0].id).toBe('child:100')
        expect(JSON.stringify(history.get().page!.messages).length).toBeLessThan(2 * 1024 * 1024)
    })
    it('aborts a hidden or closed reader, rejects late responses, and serializes foreground reads', async () => {
        const { history, request } = fixture()
        const waiting = deferred<Page>()
        request.mockReturnValueOnce(waiting.promise)
        const pending = history.refresh()
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(1)
        history.setActive(false)
        expect(request.mock.calls[0][2]!.signal!.aborted).toBe(true)
        waiting.resolve(page([message(10, 'late response')]))
        await pending
        expect(history.get().page).toBeNull()
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(1)
        history.setActive(true)
        request.mockResolvedValueOnce(page([message(20)]))
        await history.refresh()
        expect(history.get().page!.messages).toEqual([message(20)])
    })
    it('refuses wrong-child and superseded-account responses without showing their bytes', async () => {
        const { history, request, changeAuth } = fixture()
        request.mockResolvedValueOnce(page([message(10, 'wrong child')], { threadId: 'other' }))
        await history.refresh()
        expect(history.get().page).toBeNull()
        expect(history.get().error).toContain('another subagent')
        const waiting = deferred<Page>()
        request.mockReturnValueOnce(waiting.promise)
        const pending = history.refresh()
        changeAuth(); waiting.resolve(page([message(30, 'old account')]))
        await pending
        expect(history.get().page).toBeNull()
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(2)
    })
    it('replaces a changed transcript epoch and does not retain old call results', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page([message(10, 'old history')]))
        await history.refresh()
        request.mockResolvedValueOnce(page([message(10, 'new history')], { epoch: 'epoch-2', reset: true }))
        await history.refresh()
        expect(history.get().page!.messages).toEqual([message(10, 'new history')])
        expect(history.get().restarted).toBe(true)
    })
    it('bounds catch-up requests and retained messages while keeping an earlier cursor', async () => {
        const { history, request } = fixture()
        let batch = 0
        request.mockImplementation(async () => {
            const start = batch++ * 80
            return page(Array.from({ length: 80 }, (_, index) => message(start + index)), { after: start + 80, hasLater: true })
        })
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(4)
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(8)
        expect(history.get().page!.messages).toHaveLength(400)
        expect(history.get().page!.before).toBe(240)
        expect(history.get().page!.hasMore).toBe(true)
        expect(history.get().bounded).toBe(true)
    })
    it('also bounds body size for a small number of large tool outputs', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page(Array.from({ length: 80 }, (_, index) => message(index, 'x'.repeat(64_000)))))
        await history.refresh()
        expect(JSON.stringify(history.get().page!.messages).length).toBeLessThan(2 * 1024 * 1024)
        expect(history.get().bounded).toBe(true)
        expect(history.get().page!.hasMore).toBe(true)
    })
})

describe('native child structured transcript', () => {
    const call = (id: string, callId?: string): SubagentMessage => ({ id, callId, role: 'tool', kind: 'tool-call', toolName: 'exec_command', input: { cmd: 'bun test' }, text: 'exec_command', createdAt: 1000 })
    const result = (id: string, callId?: string): SubagentMessage => ({ id, callId, role: 'tool', kind: 'tool-result', output: { stdout: 'failed assertion', exit_code: 1 }, text: 'failed assertion', createdAt: 2200 })
    it('pairs only exact call IDs across pages and retains failed status and source timing', () => {
        const projected = projectSubagentTranscript([call('child:10', 'a'), call('child:20', 'b'), result('child:30', 'a')])
        expect(projected).toHaveLength(2)
        expect(projected[0]).toMatchObject({ incomplete: false, tool: { tool: { name: 'CodexBash', input: { cmd: 'bun test' }, result: { stdout: 'failed assertion' }, state: 'error', execStartedAt: 1000, execCompletedAt: 2200 } } })
        expect(projected[1]).toMatchObject({ incomplete: true })
        expect(projected[1].tool!.tool.result).toBeUndefined()
    })
    it('keeps orphan results and legacy records reachable without inventing identity matches', () => {
        const projected = projectSubagentTranscript([result('child:10', 'missing'), call('child:20'), result('child:30'), { ...message(40), kind: undefined }])
        expect(projected).toHaveLength(4)
        expect(projected[0].message.text).toBe('failed assertion')
        expect(projected[1].incomplete).toBe(true)
        expect(projected[2].tool).toBeUndefined()
        expect(projected[3].message.text).toBe('message 40')
    })
})
