import { describe, expect, it, vi } from 'vitest'
import type { SubagentMessage } from '@hapi/protocol/apiTypes'
import {
    SubagentHistory,
    codexMessageCursor,
    createSubagentHistory,
    cursorOfFor,
    dshMessageCursor,
    SUBAGENT_FOLLOW_INTERVAL_MS,
} from './history'
import type { NativeSubagentRef, SubagentCursorOf, SubagentPage, SubagentSource } from './types'

const message = (cursor: number, text = `message ${cursor}`): SubagentMessage => ({
    id: `child:${cursor}`, createdAt: cursor, role: 'assistant', kind: 'message', text,
})
const page = (messages: SubagentMessage[], overrides: Partial<SubagentPage> = {}): SubagentPage => ({
    sessionId: 'child', messages, before: null, hasMore: false, after: 100, epoch: 'epoch-1', hasLater: false, ...overrides,
})

const dshRef: NativeSubagentRef = {
    parentSessionId: 'parent', sessionId: 'child', flavor: 'dsh', label: 'child', mode: 'continuable', activity: 'running',
}

function fixture(options: { ref?: NativeSubagentRef; cursorOf?: SubagentCursorOf } = {}) {
    const ref = options.ref ?? dshRef
    let identityCurrent = true
    const request = vi.fn<(...args: Parameters<SubagentSource['read']>) => Promise<SubagentPage>>()
    const source: SubagentSource = {
        ref,
        read: request,
        isCurrent: () => identityCurrent,
    }
    const history = new SubagentHistory(source, options.cursorOf)
    history.setActive(true)
    return { history, request, source, changeIdentity: () => { identityCurrent = false } }
}

const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { resolve, promise }
}

describe('generic subagent read window', () => {
    it('keeps the follow cadence and flavor cursor helpers explicit', () => {
        expect(SUBAGENT_FOLLOW_INTERVAL_MS).toBe(2000)
        expect(codexMessageCursor(message(17))).toBe(17)
        expect(dshMessageCursor({ ...message(17), id: 'session-abc:42' })).toBe(42)
        expect(codexMessageCursor({ ...message(17), id: 'no-separator' })).toBeUndefined()
        expect(codexMessageCursor({ ...message(17), id: 'child:not-a-number' })).toBeUndefined()
        expect(cursorOfFor({ flavor: 'dsh' })).toBe(dshMessageCursor)
        expect(cursorOfFor({ flavor: 'codex' })).toBe(codexMessageCursor)
        expect(createSubagentHistory(fixture().source)).toBeInstanceOf(SubagentHistory)
    })

    it('reads newer pages incrementally from after+epoch without replacing stable message objects', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page([message(0)]))
        await history.refresh()
        const initial = history.get().page!.messages
        request.mockResolvedValueOnce(page([], { after: 120 }))
        await history.refresh()
        expect(request.mock.calls[1][0]).toMatchObject({ after: 100, epoch: 'epoch-1', limit: 80 })
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
        expect(request.mock.calls[1][0]).toMatchObject({ before: 100, epoch: 'epoch-1' })
        expect(history.get().page!.messages.map(row => row.id)).toEqual(['child:0', 'child:50', 'child:100', 'child:150'])
        expect(history.get().following).toBe(false)
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(2)
        request.mockResolvedValueOnce(page([message(250)], { before: 250, hasMore: true, after: 300 }))
        await history.loadLatest()
        expect(request.mock.calls[2][0]).not.toHaveProperty('after')
        expect(request.mock.calls[2][0]).not.toHaveProperty('before')
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
        expect(request.mock.calls[2][0]).toMatchObject({ before: 50 })
        expect(history.get().page).toMatchObject({ before: null, hasMore: false })
        expect(history.get().page!.messages).toEqual([message(100)])
        await history.loadEarlier()
        expect(request).toHaveBeenCalledTimes(3)
    })

    it('aborts a hidden or closed reader, rejects late responses, and serializes foreground reads', async () => {
        const { history, request } = fixture()
        const waiting = deferred<SubagentPage>()
        request.mockReturnValueOnce(waiting.promise)
        const pending = history.refresh()
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(1)
        history.setActive(false)
        expect(request.mock.calls[0][0]!.signal!.aborted).toBe(true)
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

    it('refuses responses for a superseded account without showing their bytes', async () => {
        const { history, request, changeIdentity } = fixture()
        const waiting = deferred<SubagentPage>()
        request.mockReturnValueOnce(waiting.promise)
        const pending = history.refresh()
        changeIdentity()
        waiting.resolve(page([message(30, 'old account')]))
        await pending
        expect(history.get().page).toBeNull()
        await history.refresh()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('surfaces a failed read without dropping the current window', async () => {
        const { history, request } = fixture()
        request.mockResolvedValueOnce(page([message(10)]))
        await history.refresh()
        const read = history.get().page
        request.mockRejectedValueOnce(new Error('The response belongs to another subagent'))
        await history.refresh()
        expect(history.get().page).toBe(read)
        expect(history.get().error).toContain('another subagent')
    })

    it('replaces a changed transcript epoch and flags the restart', async () => {
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

    it('uses the injected cursor implementation when the server cursor must be recomputed', async () => {
        const cursorOf: SubagentCursorOf = row => {
            const match = /^row-(\d+)$/.exec(row.id)
            return match ? Number(match[1]) : undefined
        }
        const { history, request } = fixture({ cursorOf })
        const rows: SubagentMessage[] = Array.from({ length: 500 }, (_, index) => ({
            ...message(index), id: `row-${index + 100}`,
        }))
        request.mockResolvedValueOnce(page(rows))
        await history.refresh()
        expect(history.get().page!.messages).toHaveLength(400)
        expect(history.get().page!.messages[0].id).toBe('row-200')
        expect(history.get().page!.before).toBe(200)
    })
})
