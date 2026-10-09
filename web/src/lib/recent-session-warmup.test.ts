import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse, SyncEvent } from '@/types/api'
import { RecentSessionWarmup } from './recent-session-warmup'
import { activateMessageWindow, appendOptimisticMessage, clearMessageWindow, fetchOlderMessages, getMessageReadingAnchor, getMessageWindowState,
    ingestIncomingMessages, markMessagesConsumed, releaseMessageWindow, saveMessageReadingAnchor, setMessageViewMode, subscribeMessageWindow, syncTailMessages } from './message-window-store'

const ids = ['warm-A', 'warm-B', 'warm-C', 'warm-D', 'warm-E', 'warm-F']
let warmup: RecentSessionWarmup
const row = (seq: number): DecryptedMessage => ({
    id: `m${seq}`, seq, localId: null, createdAt: seq, invokedAt: seq,
    content: { role: 'user', content: { type: 'text', text: `Message ${seq}` } }
})
function backend() {
    const rows = Array.from({ length: 1200 }, (_, i) => row(i + 1))
    const getMessages = vi.fn(async (_id: string, options: { limit: number; beforeSeq?: number; afterSeq?: number }): Promise<MessagesResponse> => {
        const direction = options.beforeSeq != null ? 'before' : options.afterSeq != null ? 'after' : 'latest'
        const messages = direction === 'before' ? rows.filter(r => r.seq! < options.beforeSeq!).slice(-options.limit)
            : direction === 'after' ? rows.filter(r => r.seq! > options.afterSeq!).slice(0, options.limit) : rows.slice(-options.limit)
        const first = messages[0]?.seq ?? null, last = messages.at(-1)?.seq ?? rows.length
        return { messages, page: { direction, epoch: 1, reset: false, limit: options.limit,
            nextBeforeAt: first, nextBeforeSeq: first, nextAfterAt: last, nextAfterSeq: last,
            snapshotHeadAt: rows.length, snapshotHeadSeq: rows.length,
            hasMore: direction === 'after' ? last < rows.length : first !== 1 } }
    })
    const getMessageContext = vi.fn(async (_id: string, messageId: string) => {
        const index = rows.findIndex(row => row.id === messageId)
        const messages = rows.slice(Math.max(0, index - 99), index + 100)
        const first = messages[0].seq!, last = messages.at(-1)!.seq!
        return { messages, page: { epoch: 1, reset: false,
            beforeCursor: { at: first, seq: first }, afterCursor: { at: last, seq: last },
            hasMoreBefore: first > 1, hasMoreAfter: last < rows.length,
            snapshotHead: { at: rows.length, seq: rows.length } } }
    })
    return { rows, getMessages, getMessageContext, api: { getMessages, getMessageContext } as unknown as ApiClient }
}
const changed = (sessionId: string): SyncEvent => ({ type: 'messages-invalidated', sessionId, reason: 'native-history' }) as SyncEvent

beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
    warmup?.dispose()
    for (const id of ids) clearMessageWindow(id)
    sessionStorage.clear()
    vi.useRealTimers(); vi.restoreAllMocks()
})

it('treats every visible pane as foreground without overwriting their history', async () => {
    const { api, getMessages } = backend()
    warmup = new RecentSessionWarmup(api)
    for (const id of ids.slice(0, 2)) {
        activateMessageWindow(id); await syncTailMessages(api, id)
        setMessageViewMode(id, 'history')
        saveMessageReadingAnchor(id, { id: 'hapi-message-user-text:m10', topOffset: 40 })
    }
    warmup.setVisible(ids.slice(0, 2))
    getMessages.mockClear()
    for (const id of ids.slice(0, 2)) warmup.event(changed(id))
    await vi.advanceTimersByTimeAsync(1000)
    expect(getMessages).not.toHaveBeenCalled()
    for (const id of ids.slice(0, 2)) {
        expect(getMessageWindowState(id).viewMode).toBe('history')
        expect(getMessageReadingAnchor(id)?.topOffset).toBe(40)
    }
})

it('loads A changes while B is selected, then returns to A latest without waiting for a request', async () => {
    const { api, rows, getMessages } = backend()
    warmup = new RecentSessionWarmup(api)
    warmup.visit(ids[0])
    activateMessageWindow(ids[0]); await syncTailMessages(api, ids[0])
    setMessageViewMode(ids[0], 'history')
    for (let i = 0; i < 6; i++) await fetchOlderMessages(api, ids[0])
    saveMessageReadingAnchor(ids[0], { id: 'hapi-message-user-text:m10', topOffset: 40 })
    const reader = getMessageWindowState(ids[0]).messages
    warmup.visit(ids[1])
    rows.push(row(1201))
    warmup.event({ type: 'message-updated', sessionId: ids[0], scheduled: false })
    await vi.advanceTimersByTimeAsync(100)
    // Background warming must not replace a historical window as a side effect.
    expect(getMessageWindowState(ids[0]).messages).toBe(reader)
    expect(getMessageReadingAnchor(ids[0])).toMatchObject({ topOffset: 40 })
    const requests = getMessages.mock.calls.length
    warmup.switchTo(ids[0])
    expect(getMessageWindowState(ids[0])).toMatchObject({ viewMode: 'tail', newestSeq: 1201, hasMoreAfter: false })
    expect(getMessageReadingAnchor(ids[0])).toBeNull()
    expect(getMessages).toHaveBeenCalledTimes(requests)
    expect(warmup.consumeSwitch(ids[0])).toBe(true)
    activateMessageWindow(ids[0], { preferLatest: false })
    await syncTailMessages(api, ids[0])
    expect(getMessages.mock.calls.at(-1)?.[1]).toMatchObject({ afterSeq: 1201 })
})

it('waits for a departing foreground reconciliation before warming its next tail', async () => {
    const { api, rows, getMessages } = backend()
    const original = getMessages.getMockImplementation()!
    const oldTail = await original(ids[0], { limit: 20 })
    let finish!: (response: MessagesResponse) => void
    getMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    activateMessageWindow(ids[0])
    const loading = syncTailMessages(api, ids[0])
    warmup = new RecentSessionWarmup(api)
    warmup.visit(ids[0]); warmup.visit(ids[1])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getMessages).toHaveBeenCalledTimes(1)
    rows.push(row(1201))
    finish(oldTail)
    await loading
    await vi.advanceTimersByTimeAsync(100)
    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(getMessageWindowState(ids[0]).newestSeq).toBe(1201)
})

it('coalesces bursts, pauses on constrained connections, and leaves the active reader alone', async () => {
    const { api, getMessages } = backend()
    let network = { saveData: true, effectiveType: '4g' }
    warmup = new RecentSessionWarmup(api, () => network)
    for (const id of ids) warmup.visit(id)
    for (let i = 0; i < 20; i++) warmup.event(changed(ids[1]))
    warmup.event(changed(ids[0])) // outside the five-session working set
    warmup.event(changed(ids[5])) // selected chat owns its own synchronization
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getMessages).not.toHaveBeenCalled()
    network = { saveData: false, effectiveType: '2g' }
    warmup.environmentChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(getMessages).not.toHaveBeenCalled()
    network = { saveData: false, effectiveType: '4g' }
    warmup.environmentChanged()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(getMessages.mock.calls.map(call => call[0]).sort()).toEqual(ids.slice(1, 5).sort())
    expect(getMessages.mock.calls.every(call => call[1].limit === 20)).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getMessages).toHaveBeenCalledTimes(4) // no idle polling
    setMessageViewMode(ids[0], 'history')
    saveMessageReadingAnchor(ids[0], { id: 'hapi-message-user-text:m1', topOffset: 40 })
    warmup.switchTo(ids[0])
    expect(getMessageReadingAnchor(ids[0])).toBeNull()
    expect(getMessageWindowState(ids[0]).viewMode).toBe('tail')
    expect(warmup.consumeSwitch(ids[0])).toBe(false) // cold latest refresh still required
})

it('keeps one background request in flight and cancels it on disposal', async () => {
    const { api, getMessages } = backend()
    let signal: AbortSignal | undefined
    getMessages.mockImplementationOnce((_id, _options, ...args: unknown[]) => {
        signal = args[0] as AbortSignal
        return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)))
    })
    warmup = new RecentSessionWarmup(api)
    warmup.visit(ids[0]); warmup.visit(ids[1]); warmup.visit(ids[2])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(getMessages).toHaveBeenCalledTimes(1)
    warmup.dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(signal?.aborted).toBe(true)
    expect(getMessages).toHaveBeenCalledTimes(1)
})

for (const storageFull of [false, true]) it(`releases old server bodies while preserving queued messages and the reader (storage full: ${storageFull})`, async () => {
    const { api, getMessageContext } = backend()
    warmup = new RecentSessionWarmup(api, () => ({ saveData: true }))
    warmup.visit(ids[0])
    activateMessageWindow(ids[0]); await syncTailMessages(api, ids[0])
    setMessageViewMode(ids[0], 'history')
    await fetchOlderMessages(api, ids[0])
    saveMessageReadingAnchor(ids[0], { id: 'hapi-message-user-text:m1000', topOffset: -12 })
    ingestIncomingMessages(ids[0], [{ ...row(1201), localId: 'accepted-queue', invokedAt: null, status: 'queued' }])
    appendOptimisticMessage(ids[0], { ...row(1202), id: 'pending', seq: null, localId: 'pending', invokedAt: null, status: 'sending' })
    if (storageFull) vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError') })
    for (const id of ids.slice(1)) {
        warmup.visit(id); activateMessageWindow(id); await syncTailMessages(api, id)
    }
    // The sixth distinct reader removes A's server window, not its local intent.
    expect(getMessageWindowState(ids[0]).messages.map(row => row.localId)).toEqual(['accepted-queue', 'pending'])
    expect(getMessageReadingAnchor(ids[0])).toMatchObject({ sourceMessageId: 'm1000', topOffset: -12 })
    expect(ids.filter(id => getMessageWindowState(id).epoch !== null)).toHaveLength(5)
    // A global queue-control event remains authoritative after body eviction.
    markMessagesConsumed(ids[0], ['accepted-queue'], 1203)
    expect(getMessageWindowState(ids[0]).messages.find(row => row.localId === 'accepted-queue')).toMatchObject({ invokedAt: 1203, status: 'sent' })
    warmup.visit(ids[0]); activateMessageWindow(ids[0]); await syncTailMessages(api, ids[0])
    expect(getMessageContext).toHaveBeenCalledWith(ids[0], 'm1000', expect.anything(), expect.anything())
    expect(getMessageWindowState(ids[0]).messages.some(row => row.id === 'm1000')).toBe(true)
    expect(getMessageWindowState(ids[0]).messages.find(row => row.localId === 'pending')).toMatchObject({ status: 'sending', invokedAt: null })
    expect(getMessageReadingAnchor(ids[0])).toMatchObject({ sourceMessageId: 'm1000', topOffset: -12 })
    expect(getMessageWindowState(ids[0]).viewMode).toBe('history')
})

it('leaves subscribed readers intact and rejects late loads after release', async () => {
    const { api, getMessages } = backend()
    activateMessageWindow(ids[0]); await syncTailMessages(api, ids[0])
    const unsubscribe = subscribeMessageWindow(ids[0], () => {})
    const visible = getMessageWindowState(ids[0])
    releaseMessageWindow(ids[0])
    expect(getMessageWindowState(ids[0])).toBe(visible)
    unsubscribe()
    const original = getMessages.getMockImplementation()!
    const late = await original(ids[0], { limit: 200 })
    let finish!: (response: MessagesResponse) => void
    getMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const loading = syncTailMessages(api, ids[0])
    releaseMessageWindow(ids[0])
    finish(late); await loading
    expect(getMessageWindowState(ids[0]).messages).toHaveLength(0)
    expect(getMessageWindowState(ids[0]).isSyncingTail).toBe(false)
    activateMessageWindow(ids[0]); await syncTailMessages(api, ids[0])
    expect(getMessageWindowState(ids[0]).newestSeq).toBe(1200)
})
