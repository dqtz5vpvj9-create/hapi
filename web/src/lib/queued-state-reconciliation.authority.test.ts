import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { appendOptimisticMessage, clearMessageWindow, getMessageWindowState, invalidateMessageWindow, releaseMessageWindow,
    seedMessageWindowFromSession, removeOptimisticMessage, markMessagesConsumed, markMessagesDispatching,
    markMessagesIndeterminate, markMessagesRequeued } from './message-window-store'
import { getHistoryPageRepository } from './history-page-repository'
import { reconcileQueuedStateAfterConnect } from './queued-state-reconciliation'

const row: DecryptedMessage = { id: 'local', localId: 'local', seq: null, createdAt: 1000, invokedAt: null,
    status: 'queued', scheduledAt: null, content: { role: 'user', content: { type: 'text', text: 'Keep this' } } }
const empty: MessagesResponse = { messages: [], page: { direction: 'latest', limit: 20, epoch: 1, reset: false, hasMore: false,
    nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null, snapshotHeadAt: null, snapshotHeadSeq: null } }
const queued = { queuedLocalIds: ['local'], invokedLocalMessages: [] }
const consumed = { queuedLocalIds: [], invokedLocalMessages: [{ localId: 'local', invokedAt: 1200 }] }
const ids = new Set<string>(), apis = new Set<ApiClient>()
const requests: Array<{ signal?: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
async function flush() { for (let index = 0; index < 80; index++) await Promise.resolve() }
function fixture(id: string, initial = row, options?: ConstructorParameters<typeof ApiClient>[1]) {
    ids.add(id); appendOptimisticMessage(id, initial)
    const api = new ApiClient('old-token', options); apis.add(api); return api
}
function track(pending: Promise<void>) {
    const result: { settled: boolean; error?: unknown } = { settled: false }
    void pending.then(() => { result.settled = true }, error => { result.settled = true; result.error = error })
    return result
}
beforeEach(() => {
    vi.useFakeTimers(); requests.length = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        if (!url.endsWith('/queued-state')) return Promise.resolve(json(empty))
        // Ignore abort deliberately, covering transports/auth waits that settle late.
        return new Promise<Response>((resolve, reject) => requests.push({ signal: init?.signal ?? undefined, resolve, reject }))
    }))
})
afterEach(async () => {
    ids.forEach(clearMessageWindow); ids.clear()
    apis.forEach(api => { getHistoryPageRepository(api).invalidate() }); apis.clear()
    await flush(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear()
})

describe('real reconnect row authority', () => {
    for (const state of ['queued', 'dispatching', 'indeterminate'] as const) {
        for (const noop of [false, true]) {
            it(`protects a newer ${noop ? 'no-op' : 'changed'} ${state} SSE event`, async () => {
                const id = `${state}-${noop}`
                const initial = state === 'queued' ? (noop ? row : { ...row, deliveryState: 'indeterminate' as const })
                    : noop ? { ...row, deliveryState: state } : row
                const api = fixture(id, initial)
                const pending = reconcileQueuedStateAfterConnect(api, id); await flush()
                const before = getMessageWindowState(id)
                if (state === 'queued') markMessagesRequeued(id, ['local'])
                else if (state === 'dispatching') markMessagesDispatching(id, ['local'])
                else markMessagesIndeterminate(id, ['local'])
                const live = getMessageWindowState(id)
                if (noop) expect(live).toBe(before)
                requests[0].resolve(json({ queuedLocalIds: [], invokedLocalMessages: [] })); await pending
                expect(getMessageWindowState(id).messages).toEqual(live.messages)
            })
        }
    }
    it('preserves the newer consumed timestamp and steering flag', async () => {
        const api = fixture('consumed'), pending = reconcileQueuedStateAfterConnect(api, 'consumed'); await flush()
        markMessagesConsumed('consumed', ['local'], 1100, true)
        requests[0].resolve(json(consumed)); await pending
        expect(getMessageWindowState('consumed').messages[0]).toMatchObject({ invokedAt: 1100, steered: true })
    })
    for (const operation of ['remove', 'append', 'clear'] as const) {
        it(`rejects stale authority when ${operation} reuses the identical row`, async () => {
            const id = `reuse-${operation}`, api = fixture(id)
            const pending = reconcileQueuedStateAfterConnect(api, id); await flush()
            if (operation === 'remove') removeOptimisticMessage(id, 'local')
            if (operation === 'clear') clearMessageWindow(id)
            appendOptimisticMessage(id, row)
            requests[0].resolve(json(consumed)); await pending
            expect(getMessageWindowState(id).messages).toEqual([row])
        })
    }
    it('isolates authority across sessions sharing a row object', async () => {
        const api = fixture('source'); ids.add('target'); seedMessageWindowFromSession('source', 'target')
        const pending = reconcileQueuedStateAfterConnect(api, 'target'); await flush()
        markMessagesRequeued('source', ['local'])
        requests[0].resolve(json(consumed)); await pending
        expect(getMessageWindowState('target').messages[0].invokedAt).toBe(1200)
        expect(getMessageWindowState('source').messages[0]).toBe(row)
    })
    it('applies unchanged peers despite another candidate receiving a no-op event', async () => {
        const api = fixture('peer'); const peer = { ...row, id: 'peer', localId: 'peer' }
        appendOptimisticMessage('peer', peer)
        const pending = reconcileQueuedStateAfterConnect(api, 'peer'); await flush()
        const before = getMessageWindowState('peer'); markMessagesRequeued('peer', ['peer'])
        expect(getMessageWindowState('peer')).toBe(before)
        requests[0].resolve(json(consumed)); await pending
        expect(getMessageWindowState('peer').messages.find(item => item.localId === 'local')?.invokedAt).toBe(1200)
        expect(getMessageWindowState('peer').messages.find(item => item.localId === 'peer')).toBe(peer)
    })
})

