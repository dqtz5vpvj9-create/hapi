import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import type { MessageContextResponse } from '@hapi/protocol/apiTypes'
import {
    activateMessageWindow, appendOptimisticMessage, clearMessageWindow,
    getMessageReadingAnchor, getMessageWindowState, ingestIncomingMessages,
    openMessageContext, saveMessageReadingAnchor, setMessageViewMode, syncTailMessages
} from './message-window-store'

const sessions = new Set<string>()
afterEach(() => { for (const id of sessions) clearMessageWindow(id); sessions.clear() })
const row = (seq: number): DecryptedMessage => ({
    id: `m-${seq}`, seq, localId: null, createdAt: seq, invokedAt: seq, scheduledAt: null,
    content: { role: 'user', content: { type: 'text', text: `Fixture message ${seq}` } }
})
const latest = (reset = false, epoch = 1): MessagesResponse => ({
    messages: [row(1000)], page: { direction: 'latest', limit: 20, epoch, reset, hasMore: true,
        nextBeforeAt: 1000, nextBeforeSeq: 1000, nextAfterAt: null, nextAfterSeq: null,
        snapshotHeadAt: 1000, snapshotHeadSeq: 1000 }
})
const context = (seq: number, epoch = 1): MessageContextResponse => ({
    anchor: { messageId: `m-${seq}`, position: { at: seq, seq } },
    messages: Array.from({ length: 20 }, (_, i) => row(seq - 10 + i)),
    page: { epoch, reset: false, beforeCursor: { at: seq - 10, seq: seq - 10 },
        afterCursor: { at: seq + 9, seq: seq + 9 }, hasMoreBefore: true,
        hasMoreAfter: true, snapshotHead: { at: 1000, seq: 1000 } }
})
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}
function seed(name: string) {
    const id = `history-intent-${name}`
    sessions.add(id)
    sessionStorage.setItem(`hapi:message-window:v2:${id}`, JSON.stringify({
        messages: Array.from({ length: 30 }, (_, i) => row(i + 1)), hasMore: true,
        oldestPositionAt: 1, oldestPositionSeq: 1, newestPositionAt: 30, newestPositionSeq: 30,
        epoch: 1, viewMode: 'tail'
    }))
    activateMessageWindow(id)
    return id
}
function readAt(id: string, seq: number, topOffset = 12) {
    setMessageViewMode(id, 'history')
    saveMessageReadingAnchor(id, { id: `hapi-message-user-text:m-${seq}`, topOffset })
}

describe('latest responses respect the current reader', () => {
    it('recovers history entered during activation even when latest has reset=false, retaining concurrent content and local rows', async () => {
        const id = seed('activation')
        const held = deferred<MessagesResponse>()
        const recovery = deferred<MessageContextResponse>()
        const getMessageContext = vi.fn(() => recovery.promise)
        const api = { getMessages: vi.fn(() => held.promise), getMessageContext } as unknown as ApiClient
        const pending = syncTailMessages(api, id)
        readAt(id, 15)
        const local = { ...row(1), id: 'local', seq: null, invokedAt: null, status: 'sending' as const }
        appendOptimisticMessage(id, local)
        held.resolve(latest(false))
        await vi.waitFor(() => expect(getMessageContext).toHaveBeenCalled())
        const live = { ...row(15), content: { role: 'user', content: { type: 'text', text: 'Concurrent edited body' } } }
        ingestIncomingMessages(id, [live])
        recovery.resolve(context(15))
        await pending
        expect(getMessageContext).toHaveBeenCalledWith(id, 'm-15', { radius: 99, epoch: 1 }, expect.any(AbortSignal))
        expect(getMessageWindowState(id)).toMatchObject({ viewMode: 'history', epoch: 1, isSyncingTail: false, hasMoreAfter: true })
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-15', topOffset: 12 })
        expect(getMessageWindowState(id).messages).toContainEqual(local)
        expect(getMessageWindowState(id).messages.find(message => message.id === 'm-15')?.content).toEqual(live.content)
    })

    it('uses a newer bookmark covered by the held context instead of clearing the reader', async () => {
        const id = seed('covered-reader')
        const held = deferred<MessagesResponse>(), recovery = deferred<MessageContextResponse>()
        const api = { getMessages: vi.fn(() => held.promise), getMessageContext: vi.fn(() => recovery.promise) } as unknown as ApiClient
        const pending = syncTailMessages(api, id)
        readAt(id, 15)
        held.resolve(latest(true))
        await vi.waitFor(() => expect(api.getMessageContext).toHaveBeenCalled())
        readAt(id, 20, 40)
        recovery.resolve(context(15))
        await pending
        expect(getMessageWindowState(id)).toMatchObject({ viewMode: 'history', isSyncingTail: false })
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-20', topOffset: 40 })
        expect(getMessageWindowState(id).messages.some(message => message.id === 'm-20')).toBe(true)
    })

    it('discards a context outside the new reader and permits a subsequent recovery and explicit latest navigation', async () => {
        const id = seed('outside-reader')
        const recovery = deferred<MessageContextResponse>()
        const getMessageContext = vi.fn().mockReturnValueOnce(recovery.promise).mockResolvedValue(context(30))
        const api = { getMessages: vi.fn(async () => latest(true)), getMessageContext } as unknown as ApiClient
        readAt(id, 15)
        const pending = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessageContext).toHaveBeenCalled())
        readAt(id, 30)
        const currentRows = getMessageWindowState(id).messages
        recovery.resolve(context(15))
        await pending
        expect(getMessageWindowState(id).messages).toBe(currentRows)
        expect(getMessageWindowState(id).viewMode).toBe('history')
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-30' })
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id).messages.some(message => message.id === 'm-30')).toBe(true)
        setMessageViewMode(id, 'tail')
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id).viewMode).toBe('tail')
        expect(getMessageReadingAnchor(id)).toBeNull()
        expect(getMessageWindowState(id).newestSeq).toBe(1000)
    })

    it('does not certify an obsolete epoch when changed reading supersedes a reset recovery', async () => {
        const id = seed('rewind-new-reader')
        const recovery = deferred<MessageContextResponse>()
        const getMessageContext = vi.fn().mockReturnValueOnce(recovery.promise).mockResolvedValue(context(30, 2))
        const api = { getMessages: vi.fn(async () => latest(true, 2)), getMessageContext } as unknown as ApiClient
        readAt(id, 15)
        const pending = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessageContext).toHaveBeenCalled())
        readAt(id, 30)
        recovery.resolve(context(15, 2))
        await pending
        expect(getMessageWindowState(id)).toMatchObject({ viewMode: 'history', epoch: 1, requiresLatestReset: true })
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-30' })
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id)).toMatchObject({ viewMode: 'history', epoch: 2, requiresLatestReset: false })
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-30' })
    })

    it('retains the current character offset within the same block while recovery waits', async () => {
        const id = seed('same-block-reader')
        const recovery = deferred<MessageContextResponse>()
        const api = { getMessages: vi.fn(async () => latest(true)), getMessageContext: vi.fn(() => recovery.promise) } as unknown as ApiClient
        readAt(id, 15)
        const pending = syncTailMessages(api, id)
        await vi.waitFor(() => expect(api.getMessageContext).toHaveBeenCalled())
        readAt(id, 15, -35)
        recovery.resolve(context(15))
        await pending
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-15', topOffset: -35 })
    })

    it('honors explicit latest selected while recovery waits', async () => {
        const id = seed('explicit-latest')
        const recovery = deferred<MessageContextResponse>()
        const api = { getMessages: vi.fn(async () => latest(true)), getMessageContext: vi.fn(() => recovery.promise) } as unknown as ApiClient
        readAt(id, 15)
        const pending = syncTailMessages(api, id)
        await vi.waitFor(() => expect(api.getMessageContext).toHaveBeenCalled())
        setMessageViewMode(id, 'tail')
        recovery.resolve(context(15))
        await pending
        expect(getMessageWindowState(id)).toMatchObject({ viewMode: 'tail', newestSeq: 1000 })
        expect(getMessageReadingAnchor(id)).toBeNull()
    })

    it('leaves a newer context navigation to its existing generation transaction', async () => {
        const id = seed('new-context-navigation')
        const recovery = deferred<MessageContextResponse>()
        const getMessageContext = vi.fn().mockReturnValueOnce(recovery.promise).mockResolvedValueOnce(context(30))
        const api = { getMessages: vi.fn(async () => latest(true)), getMessageContext } as unknown as ApiClient
        readAt(id, 15)
        const pending = syncTailMessages(api, id)
        await vi.waitFor(() => expect(getMessageContext).toHaveBeenCalledOnce())
        await openMessageContext(api, id, 'm-30', () => true)
        readAt(id, 30)
        const currentRows = getMessageWindowState(id).messages
        recovery.resolve(context(15))
        await pending
        expect(getMessageWindowState(id).messages).toBe(currentRows)
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-30' })
    })

    it('still restores a surviving neighbor after a real epoch rewind removes the bookmarked identity', async () => {
        const id = seed('removed-reader')
        const api = {
            getMessages: vi.fn(async (_id: string, query: { afterSeq?: number }) => query.afterSeq === undefined
                ? latest(true, 2) : { ...latest(false, 2), messages: [row(16)], page: { ...latest(false, 2).page, direction: 'after' as const } }),
            getMessageContext: vi.fn(async () => { throw new ApiError('Message not found', 404) })
        } as unknown as ApiClient
        readAt(id, 15)
        await syncTailMessages(api, id)
        expect(getMessageWindowState(id)).toMatchObject({ viewMode: 'history', epoch: 2, readingNotice: 'neighbor-restored' })
        expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: 'm-16' })
        expect(getMessageWindowState(id).messages.map(message => message.id)).toEqual(['m-16'])
    })
})
