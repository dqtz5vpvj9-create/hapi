import { afterEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { activateMessageWindow, clearMessageWindow, fetchNewerHistory, fetchOlderMessages, getMessageWindowState, setMessageViewMode, syncTailMessages, openMessageContext } from './message-window-store'

const id = 'history-round-trip-locality'
afterEach(() => clearMessageWindow(id))

for (const entry of ['latest', 'context', 'incremental'] as const) it(`returns through every previously read page including the ${entry} window without HTTP`, async () => {
    const makeRow = (i: number): DecryptedMessage => ({
        id: `m${i + 1}`, seq: i + 1, localId: null, createdAt: i + 1, invokedAt: i + 1,
        content: { role: 'user', content: { type: 'text', text: `Message ${i + 1}` } }
    })
    const rows = Array.from({ length: 1200 }, (_, i) => makeRow(i))
    const getMessages = vi.fn(async (_id: string, options: { limit: number; beforeSeq?: number; afterSeq?: number; untilSeq?: number }): Promise<MessagesResponse> => {
        const direction = options.beforeSeq != null ? 'before' : options.afterSeq != null ? 'after' : 'latest'
        const messages = direction === 'before' ? rows.filter(row => row.seq! < options.beforeSeq!).slice(-options.limit)
            : direction === 'after' ? rows.filter(row => row.seq! > options.afterSeq! && row.seq! <= (options.untilSeq ?? rows.length)).slice(0, options.limit)
                : rows.slice(-options.limit)
        const first = messages[0]?.seq ?? null, last = messages.at(-1)?.seq ?? null
        return { messages, page: { direction, epoch: 1, reset: false, limit: options.limit,
            nextBeforeAt: first, nextBeforeSeq: first, nextAfterAt: last, nextAfterSeq: last,
            snapshotHeadAt: rows.length, snapshotHeadSeq: rows.length,
            hasMore: direction === 'after' ? last !== rows.length : first !== 1 } }
    })
    const getMessageContext = vi.fn(async () => ({
        anchor: { messageId: 'm1100', position: { at: 1100, seq: 1100 } }, messages: rows.slice(1000),
        page: { epoch: 1, reset: false, beforeCursor: { at: 1001, seq: 1001 }, afterCursor: { at: 1200, seq: 1200 },
            hasMoreBefore: true, hasMoreAfter: false, snapshotHead: { at: 1200, seq: 1200 } }
    }))
    const api = { getMessages, getMessageContext } as unknown as ApiClient
    activateMessageWindow(id)
    await syncTailMessages(api, id)
    if (entry === 'incremental') {
        rows.push(...Array.from({ length: 100 }, (_, i) => makeRow(i + 1200)))
        await syncTailMessages(api, id)
    }
    if (entry === 'context') {
        await openMessageContext(api, id, 'm1100', () => true)
        await openMessageContext(api, id, 'm1100', () => true)
        expect(getMessageContext).toHaveBeenCalledTimes(1)
    }
    setMessageViewMode(id, 'history')
    for (let i = 0; i < 6; i++) await fetchOlderMessages(api, id)
    expect(getMessageWindowState(id)).toMatchObject({ oldestSeq: 1, newestSeq: 800 })
    const requests = getMessages.mock.calls.length
    for (let i = 0; i < 4 && getMessageWindowState(id).hasMoreAfter; i++) await fetchNewerHistory(api, id)
    expect(getMessageWindowState(id)).toMatchObject({ newestSeq: rows.length, hasMoreAfter: false })
    expect(getMessageWindowState(id).messages.map(row => row.seq)).toEqual(Array.from({ length: 800 }, (_, i) => i + rows.length - 799))
    expect(getMessages).toHaveBeenCalledTimes(requests)
})
